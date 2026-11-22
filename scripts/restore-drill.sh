#!/bin/sh
# Restore drill (B3): restore the project's backups into a fresh, throwaway container,
# optionally to a point in time, run a check query, and print how long it took (RTO).
# The live db is not touched: the repo is mounted read-only and the copy never archives.
#   sh common/scripts/restore-drill.sh                              # latest archived WAL
#   sh common/scripts/restore-drill.sh "2026-11-21 18:30:00+00"     # point in time
#   CHECK_SQL="SELECT count(*) FROM orders" sh common/scripts/restore-drill.sh
# ponytail: CHECK_SQL stands in for the project's smoke test; point an api at the copy if you need more.
set -eu
target=${1:-}
db=$(docker compose ps -q "${DB_SERVICE:-db}")
[ -n "$db" ] || { echo "start the stack first" >&2; exit 1; }
image=$(docker inspect -f '{{.Image}}' "$db")
repo=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/pgbackrest"}}{{.Name}}{{end}}{{end}}' "$db")
[ -n "$repo" ] || { echo "db has no pgbackrest volume (see common/backup/compose.yaml)" >&2; exit 1; }
envof() { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$db" | sed -n "s/^$1=//p"; }
user=$(envof POSTGRES_USER)
dbname=$(envof POSTGRES_DB)
uid=$(docker run --rm --entrypoint id "$image" -u postgres)
name=restore-drill-$$
trap 'docker rm -fv "$name" >/dev/null 2>&1' EXIT

set -- # the target goes to pgbackrest as separate args, so a timestamp with spaces stays one arg
[ -n "$target" ] && set -- --type=time "--target=$target" --target-action=promote

start=$(date +%s)
# tmpfs for PGDATA. Images that declare a VOLUME below it (pg17 and older) still get an
# anonymous volume, hence `rm -v` in the trap. It never removes named volumes like the repo.
docker run -d --name "$name" -u postgres --tmpfs "/var/lib/postgresql:uid=$uid,gid=$uid" \
  -v "$repo:/var/lib/pgbackrest:ro" -e PGBACKREST_LOCK_PATH=/tmp/pgbackrest \
  --entrypoint sh "$image" -c '
    mkdir -p "$PGDATA" && chmod 700 "$PGDATA" &&
    pgbackrest "$@" restore &&
    exec postgres -c archive_mode=off' drill "$@" >/dev/null

until [ "$(docker exec "$name" psql -U "$user" -d postgres -tAc 'SELECT NOT pg_is_in_recovery()' 2>/dev/null)" = t ]; do
  [ "$(docker inspect -f '{{.State.Running}}' "$name")" = true ] || { docker logs "$name"; echo "FAIL: restore crashed" >&2; exit 1; }
  sleep 0.5
done
echo "restored ${target:-to latest} in $(($(date +%s) - start)) s (RTO)"
docker exec "$name" psql -U "$user" -d "${dbname:-$user}" -v ON_ERROR_STOP=1 -tAc "${CHECK_SQL:-SELECT 1}"
