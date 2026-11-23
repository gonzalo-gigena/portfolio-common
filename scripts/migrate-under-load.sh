#!/bin/sh
# B2 drill: apply pending migrations and roll the api replicas onto new code while k6 runs.
# Fails if a single request fails. Run from a project root with the stack already up.
#   sh common/scripts/migrate-under-load.sh            # DURATION=60s SERVICE=api
# Rolling: start N new replicas next to the N old ones, let Caddy see them, then stop the old
# ones one by one (SIGTERM, they drain). Caddy retries refused connections on another replica.
set -eu
service=${SERVICE:-api}
log=$(mktemp)
old=$(docker compose ps -q "$service")
n=$(echo "$old" | wc -l | tr -d ' ')
[ -n "$old" ] || { echo "start the stack first: docker compose up -d --scale $service=2" >&2; exit 1; }

docker compose --profile loadtest run --rm -e DURATION="${DURATION:-60s}" k6 run /scripts/main.js >"$log" 2>&1 &
k6=$!
sleep 5

echo "=== migrate"
docker compose run --rm migrate

echo "=== roll $n $service replicas"
docker compose build "$service"
docker compose up -d --wait --no-deps --no-recreate --scale "$service=$((n * 2))" "$service"
sleep 6 # Caddy refreshes its upstream list every 5 s
for c in $old; do
  docker stop "$c" >/dev/null && docker rm "$c" >/dev/null
  sleep 6
done

wait "$k6" || true # thresholds are the project's; this script only cares about failures
summary=$(grep 'http_req_failed' "$log" || true)
grep -E 'http_req_(failed|duration)|http_reqs' "$log" || cat "$log"
rm -f "$log"
failed=$(echo "$summary" | grep -oE '[0-9]+ out of' | grep -oE '[0-9]+' || echo unknown)
[ "$failed" = 0 ] && { echo "OK: 0 failed requests during migration + rolling restart"; exit 0; }
echo "FAIL: $failed failed requests" >&2
exit 1
