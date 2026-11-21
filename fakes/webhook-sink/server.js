// Records every request it receives so tests (and you) can see exactly what was sent.
// POST /hooks/:name[?status=500]  record it, answer with that status (default 200)
// GET  /hooks/:name               JSON list of what arrived, oldest first
// DELETE /hooks/:name             clear
// GET  /                          HTML view of everything
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 8091);
const KEEP = 100; // ponytail: last 100 per hook, in memory
const hooks = new Map();

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const json = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body, null, 2));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://sink');
  const [, prefix, name] = url.pathname.split('/');

  if (url.pathname === '/healthz') return json(res, 200, { ok: true });

  if (url.pathname === '/') {
    const sections = [...hooks].map(([n, list]) => `<h2>${esc(n)} (${list.length})</h2>` +
      list.slice(-20).reverse().map((e) => `<pre>${esc(e.received_at)}\n${esc(JSON.stringify(e.body, null, 2))}</pre>`).join(''));
    return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
      `<!doctype html><meta charset="utf-8"><title>Webhook sink</title><style>:root{color-scheme:light dark;font-family:system-ui}pre{overflow:auto;padding:.5rem;border:1px solid #8884}</style>
<h1>Webhook sink</h1>${sections || '<p>Nothing received yet. POST to /hooks/&lt;name&gt;.</p>'}`);
  }

  if (prefix !== 'hooks' || !name) return json(res, 404, { error: 'use /hooks/<name>' });

  if (req.method === 'GET') return json(res, 200, hooks.get(name) ?? []);
  if (req.method === 'DELETE') return hooks.delete(name), json(res, 200, { cleared: name });

  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) return json(res, 413, { error: 'body too large' });
  }
  let body = raw;
  try { body = JSON.parse(raw); } catch { /* keep as text */ }

  const list = hooks.get(name) ?? [];
  list.push({ received_at: new Date().toISOString(), method: req.method, headers: req.headers, body });
  hooks.set(name, list.slice(-KEEP));
  console.log(JSON.stringify({ ts: new Date().toISOString(), svc: 'webhook-sink', hook: name, bytes: raw.length }));

  const status = Number(url.searchParams.get('status') ?? 200);
  return json(res, status >= 200 && status < 600 ? status : 200, { received: true });
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
server.listen(PORT, () => console.log(`webhook-sink listening on :${PORT}`));
