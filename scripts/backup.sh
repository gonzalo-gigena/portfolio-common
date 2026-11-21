#!/bin/sh
# Full backup of the project's `db` into its pgBackRest repo (creates the stanza the first time).
# Run daily from cron or a scheduler; WAL archiving covers everything in between.
# Usage: sh common/scripts/backup.sh [full|diff|incr]
set -eu
# The images make POSTGRES_USER the superuser (there is no `postgres` role), so connect as it.
pgb() {
  docker compose exec -T -u postgres "${DB_SERVICE:-db}" sh -c \
    'PGBACKREST_PG1_USER=$POSTGRES_USER PGBACKREST_PG1_DATABASE=${POSTGRES_DB:-$POSTGRES_USER} pgbackrest "$@"' pgb "$@"
}
pgb stanza-create >/dev/null 2>&1 || pgb stanza-upgrade >/dev/null # idempotent; upgrade after a major bump
pgb check
pgb --type="${1:-full}" backup
pgb info
