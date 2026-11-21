# 00 — Shared baseline (applies to every project)

Every project repo follows this. The parts several projects share (fakes, scripts,
Caddy load-balancing snippet, Prometheus) live in the `portfolio-common` repo, mounted
in each project as the `common/` git submodule. Each project's PLAN.md lists only
what is different.

## Goal

`git clone … && cp .env.example .env && docker compose up` works on macOS
(Apple Silicon and Intel), Linux and Windows (WSL2), with nothing else installed
except Docker Desktop / Docker Engine with Compose v2.

## Repo layout

```
common/       # git submodule: portfolio-common (fakes, scripts, Caddy snippet, Prometheus)
apps/
  api/        # HTTP/WebSocket server (stateless)
  web/        # frontend
  worker/     # background jobs (only if the project needs one)
infra/
  caddy/Caddyfile
  db/migrations/
  loadtest/   # k6 scripts
PLAN.md               # this project's step plan
compose.yaml          # base: every service, prod-like
compose.override.yaml # dev only: bind mounts, hot reload, debug ports (auto-loaded)
compose.prod.yaml     # prod: built images from GHCR, resource limits, no source mounts
.env.example
README.md
```

## Steps

1. **Dockerfiles**
   - Multi-stage: `deps` → `build` → `runtime`. Runtime stage contains only the
     built output, runs as a non-root user, has no compilers.
   - Pin base images to an exact minor of the current LTS/stable release when you
     start (check endoflife.date), never `latest`. A project that needs a Postgres
     extension uses that extension's image (e.g. `pgvector/pgvector:pg17`).
   - Use only images published for both `linux/amd64` and `linux/arm64`, or
     the project will not run on half of all laptops. Check with
     `docker buildx imagetools inspect <image>`.
   - A `.dockerignore` that excludes `node_modules`, `.git`, `.env`, build output.
   - A `.gitattributes` with `* text=auto eol=lf`. CRLF line endings from a Windows
     checkout break shell entrypoints inside Linux containers.
   - Handle `SIGTERM`: stop accepting work, finish in-flight requests/jobs,
     exit within `stop_grace_period`. Use `init: true` in compose (or `tini`)
     so signals reach the process.

2. **Compose**
   - Every long-running service has a `healthcheck`.
   - `depends_on: { db: { condition: service_healthy } }` so nothing starts
     before its dependencies are ready.
   - Migrations run as a one-shot `migrate` service
     (`restart: "no"`); app services depend on it with
     `condition: service_completed_successfully`.
   - Named volumes for data (`pgdata`, etc.). `docker compose down -v` is the
     documented "reset everything" command.
   - A `seed` one-shot service, run with `docker compose run --rm seed`, loads demo data.
   - Optional stacks behind `profiles:` (`observability`, `loadtest`) so the
     default `up` stays light.
   - Services you will scale (`api`, `worker`, …) must **not** set
     `container_name` or publish host ports. Only the reverse proxy publishes
     ports.
   - Hot reload uses Compose Watch (`develop.watch` + `docker compose up --watch`). The
     Compose CLI watches files on the host and syncs them into the container (or
     rebuilds), so it works the same on macOS, Linux and WSL2, with no bind mounts or
     polling. Windows users still clone into the WSL filesystem, not `/mnt/c`.
   - The README states the minimum Docker resources (about 4 GB RAM for most projects, 8 GB
     for 04 and 06). Every service sets `mem_limit` so one service can't starve the others.

3. **Reverse proxy (Caddy)**
   - One entry point on `localhost:8080`. Routes `/api/*` and `/ws/*` to the
     api, everything else to web.
   - Use **dynamic upstreams** so Caddy looks up every replica through Docker
     DNS and balances across them. A plain `reverse_proxy api:8080` is a single
     upstream to Caddy and does not reliably spread load:
     ```
     reverse_proxy {
       dynamic a {
         name api
         port 8080
         refresh 5s
       }
       lb_policy round_robin
       fail_duration 10s
       lb_try_duration 5s
     }
     ```
     After that, `docker compose up --scale api=3` needs no config change.
   - Each replica returns its hostname in an `X-Replica` response header, so a
     test can prove requests actually reach different replicas.
   - WebSockets and SSE work through Caddy with no extra config. A long-lived
     connection stays on the replica it first reached. Balancing applies to
     new connections.
   - Never route `/metrics` through Caddy. Prometheus scrapes it on the
     internal network.

4. **Config and secrets**
   - All config comes from environment variables, validated at startup
     (zod / envconfig). The process crashes with a clear message if one is missing.
   - `.env.example` holds safe local defaults. Real secrets never go into images
     or git. In production they come from the host or the platform's secret store.
   - Payment, email and LLM providers each have a **local mock/fake** that is
     the default, so the project runs with zero external accounts.

5. **Stateless services (the core of "scalable")**
   - No in-memory sessions, caches, rate-limit counters or WebSocket rooms
     that other replicas need to see. Shared state goes to Postgres or Redis.
   - Uploaded files go to S3-compatible storage (MinIO locally), never the
     container filesystem.
   - Long work goes to a queue, not the request handler.
   - Once more than ~2 api replicas run, put **PgBouncer** (transaction mode)
     between the apps and Postgres, so connections scale with replicas without
     exhausting `max_connections`. In transaction mode anything session-scoped
     breaks: `LISTEN`, session advisory locks (`pg_try_advisory_lock`), session
     `SET`s, and prepared statements unless `max_prepared_statements` is enabled.
     Migrations, `LISTEN` and leader-election locks use a **direct** connection
     to Postgres, not the pooler. Configure SCRAM auth between PgBouncer and Postgres.

6. **Health and observability**
   - `/healthz` (process alive) and `/readyz` (dependencies reachable).
   - Structured JSON logs to stdout with a request ID that is passed between services.
   - `/metrics` in Prometheus format: request rate, latency histogram, error
     count, queue depth.
   - The `observability` profile adds Prometheus + Grafana, with a dashboard
     JSON committed to the repo.

7. **Testing**
   - Unit tests run on the host or in a container.
   - Integration tests run against real Postgres/Redis using a
     `compose.test.yaml` (or Testcontainers). No mocking the database.
   - Each project has **one headline test** that proves its hard property
     (listed in its plan). That test runs in CI.
   - `infra/loadtest/*.js` uses k6 via `docker compose --profile loadtest run k6`.
   - `--scale` takes one `service=N` per flag (`--scale api=3 --scale worker=2`),
     so replica benchmarks are a loop (`common/scripts/scale.sh`):
     `for n in 1 2 4; do docker compose up -d --wait --scale api=$n; docker compose --profile loadtest run --rm k6 run /scripts/main.js; done`
   - Keep load targets laptop-sized. k6 in Docker tops out at a few thousand
     virtual users on one machine. Rate limiters need a test-only bypass,
     because all the load comes from one IP.

8. **CI (GitHub Actions)**
   - On PR: lint, typecheck, unit tests, `docker compose -f compose.yaml up -d --wait`
     (pass `-f` so the dev override isn't loaded automatically), integration
     and headline tests, then `docker compose down -v`.
   - On main: build `linux/amd64` and `linux/arm64` images and push to GHCR,
     tagged with the git SHA. Build each architecture on a native runner
     (GitHub has arm64 runners) and merge the manifests. QEMU emulation works
     but is many times slower.
   - Add Dependabot for npm/go modules, Docker base images and Actions.

9. **Deploy**
   - Simplest: one VM (Hetzner/DigitalOcean) running
     `docker compose -f compose.yaml -f compose.prod.yaml up -d` with Caddy
     terminating TLS automatically. Alternatives: Fly.io or Railway.
   - Back up Postgres daily (`pg_dump` cron container to S3) and document
     how to restore.
   - Kubernetes is a stretch goal, not a requirement. The stateless design
     above is what makes the move possible later.

10. **README (the part reviewers actually read)**
    - One-paragraph pitch, GIF/video under 60 s, live demo link.
    - Architecture diagram (Mermaid in the README renders on GitHub).
    - "How to run" with the three commands only.
    - **Decisions & tradeoffs**: what you chose, what you rejected, and why.
    - **Scaling**: what you measured (k6 numbers, replicas vs throughput) and
      where it breaks next.

11. **Schema changes with zero downtime (expand/contract)**
    During a rolling deploy, old and new code run against the same schema at the
    same time. A migration must work with both. Renaming `users.name` to
    `users.full_name` takes six deploys, never one:

    | # | Migration / code change | Old code still works because… |
    |---|---|---|
    | 1 | **Expand:** `ADD COLUMN full_name text` (nullable, no default) | it ignores the new column |
    | 2 | Code writes **both** columns, still reads `name` | — |
    | 3 | **Backfill** in batches: `UPDATE … WHERE id BETWEEN $1 AND $2 AND full_name IS NULL`, a few thousand rows per transaction, a short sleep between | short transactions, short row locks |
    | 4 | Code **reads** `full_name` (falls back to `name` if null), still writes both | — |
    | 5 | Code stops writing `name` | step 4 code no longer reads it |
    | 6 | **Contract:** `DROP COLUMN name` | nothing running references it |

    Lock safety, in every migration:
    - Start with `SET lock_timeout = '3s';`. Most `ALTER TABLE`s take an
      `ACCESS EXCLUSIVE` lock. Waiting behind a long query, it blocks every query
      queued after it. Better to fail fast and retry the deploy.
    - `CREATE INDEX CONCURRENTLY` (and `DROP INDEX CONCURRENTLY`) can't run in a
      transaction. golang-migrate sends a file as one multi-statement query, which
      Postgres runs as one implicit transaction, so the statement goes **alone in its
      own file**. Use `IF NOT EXISTS`: a failed concurrent build leaves an `INVALID`
      index to drop before retrying.
    - `NOT NULL` on a big table: `ADD CONSTRAINT … CHECK (col IS NOT NULL) NOT VALID`
      (instant), then in a later migration `VALIDATE CONSTRAINT` (scans without
      blocking writes). On 12+, `SET NOT NULL` then sees the valid check and skips its scan.
    - Same trick for foreign keys: `ADD CONSTRAINT … FOREIGN KEY … NOT VALID`, then
      `VALIDATE CONSTRAINT`.
    - Adding a column with a constant default is instant (11+). A volatile default
      (`now()`, `gen_random_uuid()`) rewrites the table; add it nullable and backfill.

    `common/scripts/check-migrations.sh` checks the first two rules in CI.
    `common/scripts/migrate-under-load.sh` applies pending migrations and rolls the
    api replicas onto new code while k6 runs. It fails if a single request fails.

## Done when

- A fresh clone on a machine that has never seen the project is running in
  under 5 minutes with `docker compose up`.
- `docker compose up --scale api=3` works with no config change, and the
  `X-Replica` test sees all 3 replicas.
- CI is green and images exist for both architectures.
