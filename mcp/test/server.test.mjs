import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttp } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../src/server.mjs', import.meta.url));

async function mockApi() {
  const seen = [];
  const http = createHttp(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : undefined });
    const send = (code, data, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(data)); };
    if (req.url === '/health') return send(200, { status: 'ok', service: 'koiforge-control-plane-api' });
    if (req.url === '/api/auth/login') return req.headers['x-koiforge-request'] === '1'
      ? send(200, { user: { id: 'u1' } }, { 'set-cookie': 'koiforge_session=sess-123; Path=/; HttpOnly' }) : send(403, { error: 'csrf' });
    if (req.headers.cookie !== 'koiforge_session=sess-123') return send(401, { error: 'Bitte anmelden.' });
    if (req.url === '/api/datasets') return send(200, [{ id: 'orders' }]);
    if (req.url === '/api/datasets/orders/preview?limit=5&q=late') return send(200, { rows: [] });
    if (req.url === '/api/missions' && req.method === 'POST') return send(200, { mission: { id: 'm1', revision: 1 } });
    if (req.url === '/api/missions/m1/run') return send(200, { mission: { id: 'm1', status: 'completed' } });
    return send(404, { error: 'not found' });
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  return { http, seen, url: `http://127.0.0.1:${http.address().port}` };
}

function client(env) {
  const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = ''; const waiters = new Map(); let next = 1;
  child.stdout.on('data', (chunk) => {
    buffer += chunk; let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
      waiters.get(msg.id)?.(msg); waiters.delete(msg.id);
    }
  });
  const call = (method, params) => new Promise((resolve) => {
    const id = next++; waiters.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { call, close: () => child.kill() };
}
const text = (r) => JSON.parse(r.result.content[0].text);

test('login, read tools and confirmed writes', async () => {
  const api = await mockApi();
  const c = client({ KOIFORGE_BASE_URL: api.url, KOIFORGE_EMAIL: 'owner@example.org', KOIFORGE_PASSWORD: 'fixture' });
  try {
    const init = await c.call('initialize', { protocolVersion: '2025-03-26' });
    assert.equal(init.result.serverInfo.name, 'koiforge-mcp');
    const names = (await c.call('tools/list', {})).result.tools.map((t) => t.name);
    assert.ok(names.includes('koiforge_create_mission') && names.includes('koiforge_health'));
    assert.equal(text(await c.call('tools/call', { name: 'koiforge_health', arguments: {} })).status, 'ok');
    assert.deepEqual(text(await c.call('tools/call', { name: 'koiforge_list_datasets', arguments: {} })), [{ id: 'orders' }]);
    const preview = await c.call('tools/call', { name: 'koiforge_preview_dataset', arguments: { dataset_id: 'orders', limit: 5, q: 'late' } });
    assert.equal(preview.result.isError, false);
    const created = text(await c.call('tools/call', { name: 'koiforge_create_mission', arguments: { question: 'Which orders are late?', dataset_id: 'orders' } }));
    assert.equal(created.mission.id, 'm1');
    const post = api.seen.find((r) => r.url === '/api/missions' && r.method === 'POST');
    assert.equal(post.headers['x-koiforge-request'], '1');
    assert.match(post.body.requestId, /^[0-9a-f-]{36}$/);
    const refused = await c.call('tools/call', { name: 'koiforge_run_mission', arguments: { mission_id: 'm1', revision: 1, confirmed: false } });
    assert.equal(refused.result.isError, true);
    const ran = await c.call('tools/call', { name: 'koiforge_run_mission', arguments: { mission_id: 'm1', revision: 1, confirmed: true } });
    assert.equal(text(ran).mission.status, 'completed');
  } finally { c.close(); api.http.close(); }
});

test('read-only mode hides write tools; unauthenticated calls surface as tool errors', async () => {
  const api = await mockApi();
  const c = client({ KOIFORGE_BASE_URL: api.url, KOIFORGE_READ_ONLY: 'true' });
  try {
    await c.call('initialize', {});
    const names = (await c.call('tools/list', {})).result.tools.map((t) => t.name);
    assert.ok(!names.includes('koiforge_create_mission'));
    const denied = await c.call('tools/call', { name: 'koiforge_list_datasets', arguments: {} });
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /HTTP 401/);
  } finally { c.close(); api.http.close(); }
});
