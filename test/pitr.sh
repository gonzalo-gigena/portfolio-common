#!/bin/sh
# B3 end to end: seed, back up, write more, restore to a point in between, and check that
# exactly the data before that point is there. Then measure RPO: kill the server without
# warning and count the rows the latest restore lost.
set -eu
cd "$(dirname "$0")/pitr"
export COMPOSE_FILE=compose.yaml
trap 'docker compose down -v >/dev/null 2>&1' EXIT
docker compose up -d --wait --build
sql() { docker compose exec -T db psql -U app -d app -v ON_ERROR_STOP=1 -tAc "$1"; }
s=../../scripts

sql "CREATE TABLE t (id serial PRIMARY KEY, phase text, at timestamptz DEFAULT clock_timestamp())"
sql "INSERT INTO t (phase) SELECT 'seed' FROM generate_series(1, 1000)"
sh $s/backup.sh full >/dev/null
sql "INSERT INTO t (phase) SELECT 'before' FROM generate_series(1, 500)"
sleep 1; target=$(sql "SELECT now()"); sleep 1
sql "INSERT INTO t (phase) SELECT 'after' FROM generate_series(1, 500)"
sql "SELECT pg_switch_wal()" >/dev/null # push the WAL holding 'after' into the archive

got=$(CHECK_SQL="SELECT string_agg(phase || '=' || n, ' ' ORDER BY phase) FROM (SELECT phase, count(*) n FROM t GROUP BY phase) x" \
  sh $s/restore-drill.sh "$target" | tail -1)
[ "$got" = "before=500 seed=1000" ] || { echo "FAIL: PITR to $target gave '$got'" >&2; exit 1; }
echo "OK: PITR restored exactly the rows before $target"

# RPO: write steadily, kill -9 the server, restore latest, compare.
sql "CREATE TABLE w (id bigserial PRIMARY KEY)"
for _ in $(seq 1 70); do sql "INSERT INTO w DEFAULT VALUES" >/dev/null; sleep 1; done
written=$(sql "SELECT count(*) FROM w")
docker compose kill -s KILL db >/dev/null
docker compose start db >/dev/null # crash recovery replays local WAL; the drill reads only the archive
docker compose up -d --wait >/dev/null
restored=$(CHECK_SQL="SELECT count(*) FROM w" sh $s/restore-drill.sh | tail -2)
echo "$restored" | head -1
echo "RPO: lost $((written - $(echo "$restored" | tail -1))) of $written rows written once a second (archive_timeout=60)"
