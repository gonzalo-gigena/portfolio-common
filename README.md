# portfolio-common

Shared pieces for the portfolio projects. Each project repo mounts this repo as a git
submodule at `common/` and pulls in only what it needs with Compose `include:`.

**Rule:** something lives here only if two or more projects use it. Everything else
stays in its project.

| Path | What | Used by |
|---|---|---|
| `fakes/payments/` | Fake payment provider: hosted checkout, signed webhooks, retries, refunds, subscriptions | ticket-booking, multitenant-saas |
| `fakes/webhook-sink/` | Records any webhook sent to it (alerts, outgoing webhooks) | observability, multitenant-saas |
| `fakes/mail/` | Mailpit: catches all email | ticket-booking, observability, multitenant-saas |
| `observability/` | Prometheus that discovers every `api` replica by DNS | all |
| `caddy/snippets.caddy` | `import lb <service> <port>`: load balancing across `--scale` replicas | all |
| `scripts/smoke.sh` | Fails unless traffic reaches N distinct replicas | all (CI) |
| `scripts/ci-stack.sh` | Start the stack with N replicas, smoke test it, tear it down | all (CI) |
| `scripts/scale.sh` | k6 load test at 1, 2, 4… replicas | all |
| `docs/` | The shared baseline plan and the plan audit | — |

## Using it from a project

Clone projects with their submodule:

```bash
git clone --recurse-submodules https://github.com/gonzalo-gigena/ticket-booking.git
```

Already cloned without it? Run `git submodule update --init`. To make every future
`git pull` update submodules as well, run `git config --global submodule.recurse true`.

In the project's `compose.yaml`:

```yaml
include:
  - path: common/fakes/payments/compose.yaml
    env_file: .env   # so the project's .env sets the fake's variables
```

The fakes run only under the `fakes` profile. The project's `.env.example` sets
`COMPOSE_PROFILES=fakes`, so they start in dev and CI. A production `.env` leaves
the profile out, so they never run there.

To pick up a newer version of common in a project:

```bash
git submodule update --remote common && git add common && git commit -m "Update common"
```

Dependabot (`gitsubmodule` ecosystem) opens that PR for you every week.

The submodule URL is relative (`../portfolio-common`). Keep this repo under the
same GitHub owner as the projects, and make it public, or project CI can't clone it.

## payments-mock

Runs at `http://payments-mock:8090` inside the project network. The checkout page is
at `http://localhost:8090` in your browser.

| Request | What it does |
|---|---|
| `POST /v1/checkouts` | Create a checkout. Body: `amount_cents`, `currency`, `reference`, optional `mode` (`payment` or `subscription`), `plan`, `metadata`, `success_url`, `cancel_url`, `webhook_url`. With an `Idempotency-Key` header, repeating the request returns the same checkout. |
| `GET /v1/checkouts/:id` | Current state plus its event IDs. **Source of truth** when events race. |
| `GET /checkout/:id` | Hosted page with Pay / Decline (what the buyer sees). |
| `POST /checkout/:id/pay` or `/decline` | What the buttons do. Tests can call them directly. |
| `POST /v1/checkouts/:id/refund` | `paid` → `refunded` (payment mode) |
| `POST /v1/checkouts/:id/fail` | `active` → `past_due` (subscription mode, simulates a failed renewal) |
| `POST /v1/checkouts/:id/cancel` | `active`/`past_due` → `cancelled` (subscription mode) |
| `POST /v1/events/:id/resend` | Deliver the same event again, to prove your handler deduplicates. |

Events: `payment.succeeded`, `payment.failed`, `payment.refunded`,
`subscription.activated`, `subscription.declined`, `subscription.payment_failed`,
`subscription.cancelled`. Each is sent to the checkout's `webhook_url` (or
`PAYMENTS_WEBHOOK_URL`). Failed deliveries are retried up to 5 times, with the
delay doubling each time.

**Like real providers, delivery order is not guaranteed**, and the same event can
arrive more than once. Store the event `id` with a unique constraint, and when order
matters, read the current state from `GET /v1/checkouts/:id`.

Every webhook carries `X-Signature: t=<unix time>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`,
keyed with `PAYMENTS_WEBHOOK_SECRET`. Verify it against the **raw** body before parsing:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(rawBody, header, secret, toleranceSec = 300) {
  const { t, v1 } = Object.fromEntries(header.split(',').map((kv) => kv.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false; // replay protection
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return v1.length === expected.length && timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}
```

State is in memory: restarting the container forgets every checkout.

## webhook-sink

`POST http://webhook-sink:8091/hooks/<name>` stores the request. Add `?status=500` to
make it answer with an error, to test retries. `GET /hooks/<name>` returns what
arrived (for tests), `DELETE` clears it, and http://localhost:8091 shows it all in a browser.

## mailpit

Send to `smtp://mailpit:1025` (any username and password work). Read the mail at http://localhost:8025.

## Tests

```bash
docker compose -f test/compose.yaml --profile fakes run --rm --build test
```

This runs the payments flow end to end into webhook-sink: idempotency, signatures,
retries, resends, subscriptions, input validation and HTML escaping. CI runs it on every push.
