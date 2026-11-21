#!/bin/sh
# Failure drills (B1). Run from a project root with the stack up and the `chaos` profile on.
#
#   sh common/scripts/chaos.sh latency db 500      # +500 ms (±10%) on every Postgres response
#   sh common/scripts/chaos.sh hang redis          # connection stays open, no data flows (blackhole)
#   sh common/scripts/chaos.sh down nats           # cut: open connections drop, new ones refused
#   sh common/scripts/chaos.sh partition api 1     # replica #1 of api drops off the network (Caddy and DNS stop seeing it)
#   sh common/scripts/chaos.sh reset               # heal everything
#
#   sh common/scripts/chaos.sh drill down db       # the same fault while k6 runs, then heal and
#                                                  # report the k6 result and time to recover
# Drill timing: BEFORE=10 FOR=20 AFTER=20 (seconds). URL is what "recovered" polls.
set -eu
api=${TOXIPROXY_URL:-http://localhost:8474}
url=${URL:-http://localhost:8080/api/hello}
state=${TMPDIR:-/tmp}/chaos-partition.$(basename "$PWD")

tp() { curl -fsS -X POST -H 'Content-Type: application/json' "$api$1" -d "${2:-}" >/dev/null; }

inject() {
  case "$1" in
    latency) tp "/proxies/$2/toxics" "{\"type\":\"latency\",\"attributes\":{\"latency\":$3,\"jitter\":$(($3 / 10))}}" ;;
    hang)    tp "/proxies/$2/toxics" '{"type":"timeout","attributes":{"timeout":0}}' ;;
    down)    tp "/proxies/$2" '{"enabled":false}' ;;
    partition)
      c=$(docker compose ps -q "$2" | sed -n "${3:-1}p")
      [ -n "$c" ] || { echo "no replica #${3:-1} of $2" >&2; exit 1; }
      net=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$c" | cut -d' ' -f1)
      echo "$net $c $2" >>"$state"
      docker network disconnect "$net" "$c" ;;
    *) sed -n '2,15p' "$0" >&2; exit 2 ;;
  esac
  echo "injected: $*"
}

reset() {
  curl -fsS -X POST "$api/reset" >/dev/null 2>&1 || true # no toxiproxy: only partitions to heal
  if [ -f "$state" ]; then
    while read -r net c svc; do docker network connect --alias "$svc" "$net" "$c" || true; done <"$state"
    rm -f "$state"
  fi
  echo "healed"
}

drill() {
  before=${BEFORE:-10} hold=${FOR:-20} after=${AFTER:-20}
  docker compose --profile loadtest run --rm -e DURATION="$((before + hold + after))s" \
    k6 run --quiet /scripts/main.js &
  k6=$!
  sleep "$before"
  inject "$@"
  sleep "$hold"
  reset
  healed=$(date +%s)
  until curl -fsS -m 2 -o /dev/null "$url" 2>/dev/null; do
    if [ $(($(date +%s) - healed)) -ge "${RECOVER_TIMEOUT:-60}" ]; then
      echo "NOT RECOVERED ${RECOVER_TIMEOUT:-60} s after healing" >&2
      wait "$k6" || true
      exit 1
    fi
    sleep 0.2
  done
  echo "recovered: first success $(($(date +%s) - healed)) s after healing"
  wait "$k6" && echo "k6: thresholds passed" || echo "k6: thresholds FAILED (see summary above)"
}

case "${1:-}" in
  reset) reset ;;
  drill) shift; drill "$@" ;;
  *) inject "$@" ;;
esac
