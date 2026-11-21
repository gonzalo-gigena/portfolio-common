// End-to-end: payments-mock sends signed webhooks to webhook-sink.
// Run: docker compose -f test/compose.yaml run --rm --build test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, timingSafeEqual } from 'node:crypto';

const PAY = process.env.PAYMENTS_URL;
const SINK = process.env.SINK_URL;
const SECRET = process.env.WEBHOOK_SECRET;
const SINK_INTERNAL = 'http://webhook-sink:8091';

// The same check a real consumer must do (copy this into your project).
function verify(body, header, secret, toleranceSec = 300) {
  const { t, v1 } = Object.fromEntries(header.split(',').map((kv) => kv.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return v1.length === expected.length && timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}

const post = (url, body, headers = {}) =>
  fetch(url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });

async function received(hook, count, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const list = await (await fetch(`${SINK}/hooks/${hook}`)).json();
    if (list.length >= count) return list;
    if (Date.now() > deadline) assert.fail(`${hook}: got ${list.length} webhooks, wanted ${count}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const checkout = async (hook, extra = {}, headers = {}) =>
  (await post(`${PAY}/v1/checkouts`, { amount_cents: 1500, currency: 'USD', reference: 'order-1', webhook_url: `${SINK_INTERNAL}/hooks/${hook}`, ...extra }, headers)).json();

test('idempotency key returns the same checkout', async () => {
  const a = await checkout('idem', {}, { 'idempotency-key': 'hold-42' });
  const b = await checkout('idem', {}, { 'idempotency-key': 'hold-42' });
  assert.equal(a.id, b.id);
});

test('pay → signed payment.succeeded webhook, then refund; paying twice is a 409', async () => {
  const c = await checkout('pay', { success_url: 'http://localhost:8080/thanks' });
  const res = await post(`${PAY}/checkout/${c.id}/pay`);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), 'http://localhost:8080/thanks');
  assert.equal((await post(`${PAY}/checkout/${c.id}/pay`)).status, 409);

  const [hook] = await received('pay', 1);
  assert.equal(hook.body.type, 'payment.succeeded');
  assert.equal(hook.body.data.status, 'paid');
  assert.ok(verify(JSON.stringify(hook.body), hook.headers['x-signature'], SECRET), 'signature verifies');
  assert.ok(!verify(JSON.stringify(hook.body), hook.headers['x-signature'], 'wrong-secret'), 'wrong secret fails');

  assert.equal((await post(`${PAY}/v1/checkouts/${c.id}/refund`)).status, 200);
  const list = await received('pay', 2);
  assert.equal(list[1].body.type, 'payment.refunded');
});

test('resend delivers the same event id again', async () => {
  const c = await checkout('resend');
  await post(`${PAY}/checkout/${c.id}/pay`);
  const [first] = await received('resend', 1);
  assert.equal((await post(`${PAY}/v1/events/${first.body.id}/resend`)).status, 202);
  const list = await received('resend', 2);
  assert.equal(list[1].body.id, first.body.id);
});

test('failed deliveries are retried', async () => {
  const c = await checkout('flaky?status=500');
  await post(`${PAY}/checkout/${c.id}/pay`);
  const list = await received('flaky', 2); // sink stores the request even when it answers 500
  assert.equal(list[0].body.id, list[1].body.id);
});

test('subscription lifecycle', async () => {
  const c = await checkout('sub', { mode: 'subscription', plan: 'pro' });
  await post(`${PAY}/checkout/${c.id}/pay`);
  assert.equal((await post(`${PAY}/v1/checkouts/${c.id}/fail`)).status, 200);
  assert.equal((await post(`${PAY}/v1/checkouts/${c.id}/cancel`)).status, 200);
  assert.equal((await post(`${PAY}/v1/checkouts/${c.id}/refund`)).status, 409); // not a payment-mode action
  // Like real providers, delivery order is not guaranteed, so compare as a set.
  const types = (await received('sub', 3)).map((h) => h.body.type).sort();
  assert.deepEqual(types, ['subscription.activated', 'subscription.cancelled', 'subscription.payment_failed']);
  const final = await (await fetch(`${PAY}/v1/checkouts/${c.id}`)).json();
  assert.equal(final.status, 'cancelled'); // GET is the source of truth when events race
});

test('bad input is rejected', async () => {
  assert.equal((await post(`${PAY}/v1/checkouts`, { amount_cents: -5, currency: 'USD' })).status, 400);
  assert.equal((await post(`${PAY}/v1/checkouts`, { amount_cents: 100, currency: 'dollars' })).status, 400);
  const bad = await fetch(`${PAY}/v1/checkouts`, { method: 'POST', body: '{nope' });
  assert.equal(bad.status, 400);
});

test('checkout page escapes HTML', async () => {
  const c = await checkout('xss', { reference: '<script>alert(1)</script>' });
  const html = await (await fetch(`${PAY}/checkout/${c.id}`)).text();
  assert.ok(!html.includes('<script>alert(1)'));
  assert.ok(html.includes('&#60;script&#62;'));
});
