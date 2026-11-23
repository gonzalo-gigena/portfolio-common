# Postgres + pgBackRest for continuous WAL archiving and point-in-time recovery (B3).
# Projects on another Postgres image pass it: build: { args: { PG_IMAGE: pgvector/pgvector:0.8.7-pg17 } }
ARG PG_IMAGE=postgres:18.6-alpine
FROM ${PG_IMAGE}
RUN if command -v apk >/dev/null; then apk add --no-cache pgbackrest; \
    else apt-get update && apt-get install -y --no-install-recommends pgbackrest && rm -rf /var/lib/apt/lists/*; fi \
 && mkdir -p /var/lib/pgbackrest /var/log/pgbackrest /var/spool/pgbackrest \
 && chown postgres:postgres /var/lib/pgbackrest /var/log/pgbackrest /var/spool/pgbackrest
# pgBackRest reads PGBACKREST_* env vars, so no config file is needed.
ENV PGBACKREST_STANZA=main \
    PGBACKREST_PG1_PATH=${PGDATA} \
    PGBACKREST_REPO1_PATH=/var/lib/pgbackrest \
    PGBACKREST_REPO1_RETENTION_FULL=2 \
    PGBACKREST_START_FAST=y \
    PGBACKREST_LOG_LEVEL_CONSOLE=warn
