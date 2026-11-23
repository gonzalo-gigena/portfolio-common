#!/bin/sh
# Lint migrations for the zero-downtime rules (docs/baseline.md, step 11).
#   - every *.up.sql starts its DDL with `SET lock_timeout`
#   - CONCURRENTLY is alone in its file (golang-migrate runs a file as one implicit transaction)
# Usage: sh common/scripts/check-migrations.sh [dir]   (default infra/db/migrations)
set -eu
dir=${1:-infra/db/migrations}
bad=0
for f in "$dir"/*.up.sql; do
  [ -e "$f" ] || continue
  body=$(sed 's/--.*//' "$f") # ignore comments
  statements=$(printf '%s' "$body" | tr -cd ';' | wc -c | tr -d ' ')
  if printf '%s' "$body" | grep -qi 'concurrently'; then
    [ "$statements" -le 1 ] || { echo "$f: CONCURRENTLY must be the only statement in its file" >&2; bad=1; }
    continue
  fi
  case "$(basename "$f")" in 000001_*) continue ;; esac # ponytail: the first migration creates empty tables nobody queries yet
  printf '%s' "$body" | grep -qiE '\b(alter|create|drop)\b' || continue
  printf '%s' "$body" | grep -qi 'set lock_timeout' || { echo "$f: DDL without SET lock_timeout" >&2; bad=1; }
done
[ "$bad" = 0 ] && echo "OK: migrations in $dir follow the lock rules"
exit "$bad"
