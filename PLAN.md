# portfolio-common — Beyond the plan

Extensions that apply to every project, so they are built once here and used through
the `common/` submodule. Build them after a project's own phases. Each starts from a
problem real systems hit, and each should add a row to that project's README.

### B1 — Failure drills
**Why:** "what happens when Redis dies mid-sale?" is a standard interview question, and
the honest answer is a measurement.
1. A `toxiproxy` service under a `chaos` profile. With the profile on, a project sends
   its connections to Postgres, Redis or NATS through it.
2. `scripts/chaos.sh <scenario>`: add latency, cut a connection, or partition one
   replica while k6 runs.
3. Each project's README gets a "When X fails" table: what the user sees, what is lost,
   how it recovers, with numbers.
- **Done when:** every project's table has measured results for its database and its broker.

### B2 — Schema changes with zero downtime
**Why:** every live system eventually renames a column under traffic. Doing it in one
migration breaks the replicas still running the old code.
1. Document expand/contract in `docs/baseline.md`: add the new column, write both,
   backfill in batches, read the new one, stop writing the old one, drop it. Each step
   is its own deploy.
2. Lock safety: `SET lock_timeout` in every migration, `CREATE INDEX CONCURRENTLY` (alone
   in its migration file, since it can't run inside a transaction), and `NOT NULL` added
   through a `CHECK … NOT VALID` constraint that is validated later.
3. A script that runs a migration under k6 with rolling replica restarts.
- **Done when:** one project renames a column in a real table under k6 load with 0
  failed requests, and its README shows the steps.

### B3 — Backup and restore drill
**Why:** the baseline's daily `pg_dump` can lose up to 24 h of data, and a backup nobody
has restored is a guess.
1. Continuous WAL archiving to MinIO (pgBackRest or WAL-G) for point-in-time recovery.
2. `scripts/restore-drill.sh`: restore into a fresh container at a given timestamp, run
   the project's smoke test against it, and print how long it took.
3. A weekly CI job: seed, back up, write more, restore to a point in between, and check
   that exactly the data before that point is there.
- **Done when:** each README states measured RPO (data you can lose) and RTO (time to
  restore), and the drill passes in CI.
