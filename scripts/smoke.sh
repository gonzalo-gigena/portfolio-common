#!/bin/sh
# Headline check for the template: traffic through Caddy really reaches N distinct api replicas.
# Usage: infra/smoke.sh 3
set -eu
want=${1:-1}
url=${URL:-http://localhost:8080/api/hello}

for attempt in 1 2 3 4 5; do
  seen=$(for _ in $(seq 1 20); do
    curl -fsS -D - -o /dev/null "$url" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-replica" {print $2}'
  done | sort -u | wc -l | tr -d ' ')
  if [ "$seen" -ge "$want" ]; then
    echo "OK: $seen distinct replicas served $url"
    exit 0
  fi
  sleep 2 # Caddy refreshes its upstream list every 5 s
done
echo "FAIL: only $seen distinct replicas served $url, wanted $want" >&2
exit 1
