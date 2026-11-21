# Audit log

Reviewer: Claude Sonnet 5.5, run as a separate agent with no context from the
author (Claude Opus 5.5). It read only these files. Fable 5.2 was tried first but
needs usage credits on this account. No non-Claude model was reachable: the only
local CLI was `openai` with no API key set.

31 findings: 3 critical, 24 important, 4 minor. All but one were applied. Items
marked *unverified* by the reviewer were turned into "check this" notes rather
than stated as fact.

| # | Sev | File | Finding | Resolution |
|---|---|---|---|---|
| 1 | crit | 04 | ClickHouse dedup on plain MergeTree is off unless `non_replicated_deduplication_window` is set. A random batch-ID token doesn't survive non-identical redelivery | Setting added. Deterministic batches or ReplacingMergeTree |
| 2 | crit | 00 | Static `reverse_proxy api:8080` doesn't reliably balance across `--scale` replicas | Caddy `dynamic a` upstreams + `X-Replica` test |
| 3 | crit | all | `--scale worker=1,2,4,8` is invalid syntax | `scale.sh` loop, one flag per service |
| 4 | imp | 04 | JetStream defaults to `discard: old` (silent loss), not a 503 | `discard: new` + `max_bytes` + sync publish ack |
| 5 | imp | 04 | Cursor uses `id`, but the table had no `id` | `id` = stream sequence |
| 6 | imp | 04 | Throughput targets unrealistic on a laptop. ClickHouse resources/password. Needs a Slack account | Laptop targets, 8 GB note, password, `webhook-sink` |
| 7 | imp | 04 | Scope too big | Scope note: core vs stretch |
| 8 | imp | 01 | `bigserial` + compaction race can delete an update | Per-document advisory lock |
| 9 | imp | 01 | Re-applying an old Yjs state is a no-op | Restore replaces content in one `transact` |
| 10 | imp | 01 | Revoking access only works on the local replica | Redis `revocations` channel |
| 11 | imp | 01 | 1 MB frame cap breaks initial sync. Byte-identical check is wrong. How to reach a specific replica | Doc-size cap, compare JSON, test inside the network |
| 12 | imp | 02 | Fan-in race under READ COMMITTED | Lock the `workflow_runs` row |
| 13 | imp | 02 | Counting running jobs doesn't enforce the concurrency limit | `queue_limits` row lock / xact advisory lock |
| 14 | imp | 02 | Session advisory lock through PgBouncer. Partitioning breaks the unique key | Direct connections. Only the archive is partitioned |
| 15 | imp | 03 | `UPDATE … ANY()` can deadlock. A plain unique key blocks resale after refund | `ORDER BY … FOR UPDATE`. Partial unique index on `paid` |
| 16 | imp | 03 | No accounts phase, but plan relies on users and admins | Added to phase 1 |
| 17 | imp | 03 | Waiting room lost on Redis restart. Reusable tokens. 20k VUs on a laptop | AOF, one-time user-bound tokens, laptop-sized spike |
| 18 | imp | 05 | `current_setting()::uuid` errors when unset. No path for pre-tenant lookups | `NULLIF(…, true)`, non-RLS/`SECURITY DEFINER` lookups |
| 19 | imp | 05 | `*.localhost` cookies/containers/Safari | Dashboard on `app.localhost` with path tenants; tests set `Host` |
| 20 | imp | 05 | Wildcard and custom-domain TLS not covered | Noted in scope (DNS plugin, on-demand TLS `ask`) |
| 21 | imp | 05 | pg-boss via PgBouncer. Jobs skip tenant context | Direct connection; jobs set `app.tenant_id` |
| 22 | imp | 05 | Scope too big | Scope note: phases 0–5 first |
| 23 | imp | 06 | HNSW post-filtering starves small workspaces. Plain `postgres` image has no pgvector | Iterative scans; `pgvector/pgvector:pg17` |
| 24 | imp | 06 | TEI arm64 unclear; model download on first run | `fastembed` service with the model baked in |
| 25 | imp | 06 | 500-token chunks exceed bge-small's 512 limit | ≤ ~400 tokens, model's tokenizer |
| 26 | imp | 06 | Prompt caching claim empty for a short prefix. Citation constraints | Rewritten as "measure first"; constraints noted |
| 27 | imp | 06 | Phase 2 depends on phase 5 evals and phase 4 workspaces | Mini eval in phase 2; workspaces table in phase 1 |
| 28 | min | 00 | CRLF, WSL file watching, RAM minimums | `.gitattributes`, polling, resource note |
| 29 | min | 00 | PgBouncer details, QEMU slowness, `/metrics` exposure, override auto-loaded in CI, stale versions | All addressed |
| 30 | min | 02 | Reaper loops forever; zombie workers; thundering herd | `max_attempts` in reaper, `worker_id` fencing, jitter |
| 31 | min | 03/05 | Missing Done-when; audit-table delete role; SSRF via DNS rebinding | Added |

Not changed: the reviewer flagged the model ID `claude-opus-5-5` as unverified. It is
the current Opus ID, and it was already configurable by env var.
