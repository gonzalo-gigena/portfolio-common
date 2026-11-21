// Fake payment provider: hosted checkout page, signed webhooks with retries, idempotency keys.
// Same flow as Stripe/Mercado Pago checkout, so projects can swap in the real provider by env var.
import http from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 8090);
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
const SECRET = process.env.WEBHOOK_SECRET || 'whsec_local_dev';
const DEFAULT_WEBHOOK_URL = process.env.WEBHOOK_URL ?? '';
const MAX_ATTEMPTS = 5;

// ponytail: all state is in memory, so a restart forgets every checkout. Fine for a local fake.
const checkouts = new Map(); // id -> checkout
const idempotency = new Map(); // Idempotency-Key -> checkout id
const events = new Map(); // event id -> { event, url }

// What each action does, per mode: from-status -> [to-status, event type]
const TRANSITIONS = {
  payment: {
    pay: { pending: ['paid', 'payment.succeeded'] },
    decline: { pending: ['declined', 'payment.failed'] },
    refund: { paid: ['refunded', 'payment.refunded'] },
  },
  subscription: {
    pay: { pending: ['active', 'subscription.activated'] },
    decline: { pending: ['declined', 'subscription.declined'] },
    fail: { active: ['past_due', 'subscription.payment_failed'] },
    cancel: { active: ['cancelled', 'subscription.cancelled'], past_due: ['cancelled', 'subscription.cancelled'] },
  },
};

const log = (msg, extra = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), svc: 'payments-mock', msg, ...extra }));

export function sign(body, secret = SECRET, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

const view = (c) => {
  const { events: _events, webhook_url: _url, ...rest } = c;
  return { ...rest, url: `${PUBLIC_URL}/checkout/${c.id}` };
};

async function deliver(eventId, attempt = 1) {
  const { event, url } = events.get(eventId);
  if (!url) return log('no webhook url, event not sent', { event: event.id });
  const body = JSON.stringify(event);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature': sign(body) },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    log('webhook delivered', { event: event.id, type: event.type, attempt });
  } catch (err) {
    log('webhook failed', { event: event.id, attempt, error: err.message });
    if (attempt < MAX_ATTEMPTS) setTimeout(() => deliver(eventId, attempt + 1), 500 * 2 ** attempt);
  }
}

function transition(c, action) {
  const to = TRANSITIONS[c.mode][action]?.[c.status];
  if (!to) return null;
  [c.status] = to;
  const event = { id: `evt_${randomUUID()}`, type: to[1], created: new Date().toISOString(), data: view(c) };
  events.set(event.id, { event, url: c.webhook_url || DEFAULT_WEBHOOK_URL });
  c.events.push(event.id);
  deliver(event.id);
  return event;
}

function validate(b) {
  if (!Number.isInteger(b.amount_cents) || b.amount_cents <= 0) return 'amount_cents must be a positive integer';
  if (typeof b.currency !== 'string' || !/^[a-zA-Z]{3}$/.test(b.currency)) return 'currency must be a 3-letter code';
  if (b.mode !== undefined && !(b.mode in TRANSITIONS)) return 'mode must be "payment" or "subscription"';
  for (const k of ['success_url', 'cancel_url', 'webhook_url']) {
    if (b[k] !== undefined && !/^https?:\/\//.test(b[k])) return `${k} must be an http(s) URL`;
  }
  return null;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const page = (c) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fake checkout</title><style>:root{color-scheme:light dark;font-family:system-ui}body{max-width:28rem;margin:4rem auto;padding:0 1rem}button{font-size:1rem;padding:.6rem 1.2rem;margin-right:.5rem}</style>
<p><strong>FAKE PAYMENT PROVIDER</strong>: no real money moves.</p>
<h1>${esc((c.amount_cents / 100).toFixed(2))} ${esc(c.currency.toUpperCase())}</h1>
<p>${esc(c.mode)}${c.plan ? `, plan ${esc(c.plan)}` : ''}<br>Reference: <code>${esc(c.reference)}</code><br>Status: <strong>${esc(c.status)}</strong></p>
${c.status === 'pending' ? `<form method="post" action="/checkout/${c.id}/pay" style="display:inline"><button>Pay</button></form>
<form method="post" action="/checkout/${c.id}/decline" style="display:inline"><button>Decline</button></form>` : ''}`;

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw Object.assign(new Error('body too large'), { status: 413 });
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400 });
  }
}

const json = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_URL);
  const parts = url.pathname.split('/').filter(Boolean); // e.g. ['v1','checkouts',id,'refund']
  try {
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true });

    if (req.method === 'POST' && url.pathname === '/v1/checkouts') {
      const key = req.headers['idempotency-key'];
      if (key && idempotency.has(key)) return json(res, 200, view(checkouts.get(idempotency.get(key))));
      const b = await readJson(req);
      const error = validate(b);
      if (error) return json(res, 400, { error });
      const c = {
        id: `chk_${randomUUID()}`, object: 'checkout', mode: b.mode ?? 'payment', status: 'pending',
        amount_cents: b.amount_cents, currency: b.currency.toLowerCase(), reference: b.reference ?? null,
        plan: b.plan ?? null, metadata: b.metadata ?? {}, success_url: b.success_url ?? null,
        cancel_url: b.cancel_url ?? null, webhook_url: b.webhook_url ?? null, created: new Date().toISOString(), events: [],
      };
      checkouts.set(c.id, c);
      if (key) idempotency.set(key, c.id);
      log('checkout created', { id: c.id, mode: c.mode });
      return json(res, 201, view(c));
    }

    const c = checkouts.get(parts[0] === 'v1' && parts[1] === 'checkouts' ? parts[2] : parts[0] === 'checkout' ? parts[1] : undefined);

    if (req.method === 'GET' && parts[0] === 'v1' && parts.length === 3 && c) return json(res, 200, { ...view(c), events: c.events });

    // API actions: POST /v1/checkouts/:id/(refund|fail|cancel|pay|decline)
    if (req.method === 'POST' && parts[0] === 'v1' && parts[1] === 'checkouts' && parts.length === 4) {
      if (!c) return json(res, 404, { error: 'no such checkout' });
      const event = transition(c, parts[3]);
      return event ? json(res, 200, view(c)) : json(res, 409, { error: `cannot ${parts[3]} a ${c.mode} that is ${c.status}` });
    }

    // Resend an event with the same id, to test that consumers process each event once.
    if (req.method === 'POST' && parts[0] === 'v1' && parts[1] === 'events' && parts[3] === 'resend') {
      if (!events.has(parts[2])) return json(res, 404, { error: 'no such event' });
      deliver(parts[2]);
      return json(res, 202, { resent: parts[2] });
    }

    // Hosted checkout page (what the buyer's browser sees)
    if (parts[0] === 'checkout' && c) {
      if (req.method === 'GET' && parts.length === 2) return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page(c));
      if (req.method === 'POST' && ['pay', 'decline'].includes(parts[2])) {
        if (!transition(c, parts[2])) return json(res, 409, { error: `checkout is already ${c.status}` });
        const back = (parts[2] === 'pay' ? c.success_url : c.cancel_url) ?? `/checkout/${c.id}`;
        return res.writeHead(303, { location: back }).end();
      }
    }

    return json(res, 404, { error: 'not found' });
  } catch (err) {
    log('error', { error: err.message });
    return json(res, err.status ?? 500, { error: err.status ? err.message : 'internal error' });
  }
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
server.listen(PORT, () => log(`listening on :${PORT}`, { public_url: PUBLIC_URL }));
