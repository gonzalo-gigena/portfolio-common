#!/bin/sh
# What CI runs, and what you can run locally from a project root:
# start the stack prod-like (no dev override) with N api replicas, smoke test it, tear it down.
# Usage: sh common/scripts/ci-stack.sh 3
set -eu
n=${1:-3}
here=$(dirname "$0")
compose="docker compose -f compose.yaml"

trap '$compose down -v --remove-orphans >/dev/null 2>&1' EXIT
$compose up -d --wait --build --scale api="$n" || { $compose logs; exit 1; }
sh "$here/smoke.sh" "$n" || { $compose logs api; exit 1; }
