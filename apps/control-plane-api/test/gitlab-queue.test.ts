import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { createGitLabQueueService } from '../src/monitoring/gitlab-queue.js';
import { registerGitLabQueueRoutes } from '../src/routes/gitlab-queue.js';
import type { AppRegistries } from '../src/registries.js';
import type { SessionContext } from '@koiforge/security-core';

const json = (data: unknown, next = '') => new Response(JSON.stringify(data), {
  headers: { 'Content-Type': 'application/json', 'X-Next-Page': next },
});
const job = (id: number, status: string, extra: Record<string, unknown> = {}) => ({
  id, status, pipeline: { id }, tag_list: [], created_at: '2026-09-28T12:00:00Z', ...extra,
});

test('counts actual jobs across pages; separates Duo, active successors, manual gates and cancellations', async () => {
  const seen: string[] = [];
  const service = createGitLabQueueService({ token: 'test-secret', projects: 'team/app', fetchImpl: async (input, init) => {
    const url = new URL(String(input));
    seen.push(url.href);
    assert.equal(url.origin, 'https://gitlab.com');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as Record<string, string>)['PRIVATE-TOKEN'], 'test-secret');
    assert(init?.signal);
    if (url.pathname.endsWith('/pipelines/8')) return json({ status: 'manual' });
    if (url.pathname.endsWith('/pipelines/9')) return json({ status: 'running' });
    if (url.pathname.endsWith('/pipelines/10')) return json({ status: 'success' });
    if (url.searchParams.get('page') === '2') return json([
      job(1, 'running'), // pagination overlap must not double count
      job(8, 'created'), job(9, 'created'), job(10, 'created'), job(11, 'canceling'),
    ]);
    return json([job(1, 'running'), job(2, 'preparing'), job(3, 'pending', { queued_duration: 123 }),
      job(4, 'pending', { tag_list: ['gitlab--duo'], queued_duration: 9999 }),
      job(5, 'running', { pipeline: { id: 5, source: 'duo_workflow' } }),
      job(6, 'waiting_for_resource'), job(7, 'scheduled')], '2');
  } });
  const result = await service.snapshot();
  assert.equal(result.source, 'ready');
  assert.deepEqual(result.counts, { running: 2, pending: 1, duoRunning: 1, duoPending: 1,
    upcoming: 1, resourceWaiting: 1, scheduled: 1, canceling: 1 });
  assert.equal(result.oldestPendingSeconds, 123);
  assert.equal(result.projects[0]?.url, 'https://gitlab.com/team/app/-/pipelines');
  assert.equal(seen.length, 5);
  assert(!JSON.stringify(result).includes('test-secret'));
});

test('partial upstream failure never fabricates global zero or forwards error data', async () => {
  const service = createGitLabQueueService({ token: 'secret', projects: 'team/ok,team/denied', fetchImpl: async input => {
    if (String(input).includes('denied')) return new Response('sensitive upstream failure secret', { status: 403 });
    return json([]);
  } });
  const result = await service.snapshot();
  assert.equal(result.source, 'degraded');
  assert.equal(result.counts, null);
  assert.equal(result.projects[0]?.counts?.pending, 0);
  assert.equal(result.projects[1]?.counts, null);
  assert(!JSON.stringify(result).includes('secret'));
});

test('request coalescing and cache expire; failed refresh does not show old counts as current', async () => {
  let time = 1_000_000;
  let calls = 0;
  const service = createGitLabQueueService({ token: 'secret', projects: 'team/app', now: () => time,
    fetchImpl: async () => { calls++; if (calls > 1) throw new Error('offline'); return json([job(1, 'pending')]); } });
  const [a, b] = await Promise.all([service.snapshot(), service.snapshot()]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
  assert.equal(a.oldestPendingSeconds, null); // job creation time is not queue entry time
  time += 59_000;
  await service.snapshot();
  assert.equal(calls, 1);
  time += 2_000;
  const result = await service.snapshot();
  assert.equal(calls, 2);
  assert.equal(result.counts, null);
  assert.notEqual(a.observedAt, result.observedAt);
});

test('repeated pagination and oversized response become unknown rather than incomplete totals', async () => {
  for (const fetchImpl of [
    async () => json([job(1, 'pending')], '1'),
    async () => json('x'.repeat(2 * 1024 * 1024)),
  ]) {
    const service = createGitLabQueueService({ token: 'secret', projects: 'team/app', fetchImpl });
    assert.equal((await service.snapshot()).counts, null);
  }
});

test('a missing pending duration prevents an understated oldest wait', async () => {
  const service = createGitLabQueueService({ token: 'secret', projects: 'team/app',
    fetchImpl: async () => json([job(1, 'pending', { queued_duration: 12 }), job(2, 'pending')]) });
  const snapshot = await service.snapshot();
  assert.equal(snapshot.counts?.pending, 2);
  assert.equal(snapshot.oldestPendingSeconds, null);
});

test('only explicit project paths can be configured; absent credential makes source unavailable', async () => {
  assert.throws(() => createGitLabQueueService({ token: 'secret', projects: 'https://evil.test/team/app' }));
  assert.throws(() => createGitLabQueueService({ token: 'secret', projects: 'team/../../api' }));
  const service = createGitLabQueueService({ projects: 'team/app', fetchImpl: async () => { throw new Error('must not fetch'); } });
  assert.equal(service.configured, false);
  await assert.rejects(service.snapshot());
});

test('queue route enforces session and administrative permission, suppresses upstream errors', async t => {
  const app = Fastify();
  t.after(() => app.close());
  app.addHook('onRequest', async request => {
    if (request.headers.authorization) request.koiforgeSession = {
      user: { id: 'owner' }, permissions: request.headers.authorization === 'owner' ? ['views.read', 'security.read'] : ['views.read'],
    } as SessionContext;
  });
  const security = { assertPermissions(session: SessionContext, permissions: string[]) {
    if (permissions.some(p => !session.permissions.includes(p))) throw new Error('denied');
  } };
  registerGitLabQueueRoutes(app, { security } as unknown as AppRegistries, {
    configured: true, async snapshot() { throw new Error('secret from upstream'); },
  });
  assert.equal((await app.inject('/api/monitoring/gitlab-queue')).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/monitoring/gitlab-queue', headers: { authorization: 'reader' } })).statusCode, 403);
  const response = await app.inject({ url: '/api/monitoring/gitlab-queue', headers: { authorization: 'owner' } });
  assert.equal(response.statusCode, 502);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert(!response.body.includes('secret'));
});
