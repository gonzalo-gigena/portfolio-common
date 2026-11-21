#!/bin/sh
# Load-test at several replica counts. --scale takes one service=N per flag, hence the loop.
# Usage: infra/loadtest/scale.sh            (1, 2 and 4 replicas)
#        REPLICAS="1 8" SERVICE=worker infra/loadtest/scale.sh
set -eu
service=${SERVICE:-api}
for n in ${REPLICAS:-1 2 4}; do
  echo "=== $service x$n"
  docker compose up -d --wait --scale "$service=$n"
  sleep 6 # let Caddy's dynamic upstreams (refresh 5s) see the new replicas
  docker compose --profile loadtest run --rm k6 run --quiet /scripts/main.js
done
