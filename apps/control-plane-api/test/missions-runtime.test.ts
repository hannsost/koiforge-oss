import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import type { SessionContext } from '@koiforge/security-core';
import type { Mission, MissionEngine, MissionPlan, MissionResult, MissionSource } from '../src/missions/contracts.js';
import { createMissionService, MissionServiceError } from '../src/missions/service.js';
import { FileMissionStore } from '../src/missions/store.js';
import { registerMissionRoutes } from '../src/routes/missions.js';
import { AuthStore } from '../src/auth-store.js';

const owner: SessionContext = { user: { id: 'real-owner', displayName: 'Owner' },
  tenant: { id: 'firm-a', name: 'Firma A', slug: 'firm-a', status: 'active' }, roleIds: ['owner'],
  permissions: ['datasets.read', 'datasets.manage'] };
const sourceHash = 'a'.repeat(64);
const assertPermissions = (s: SessionContext, ps: string[]) => {
  if (!ps.every(p => s.permissions.includes(p))) throw new Error('Denied');
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const plan: MissionPlan = { capabilityId: 'data_quality', capabilityVersion: 'data-quality-v1', summary: 'Fehlende Werte prüfen.',
  steps: ['Prüfen'], limitations: [], suggestedBinding: {}, generation: { backend: 'codex', model: 'fixture', reasoningEffort: 'xhigh' } };
function source(m: Mission): MissionSource {
  return { datasetId: m.datasetId, name: 'Input', columns: ['id'], rowCount: 2, hash: sourceHash,
    capturedAt: '2026-09-23T10:00:00Z', coverage: 'complete' };
}
function result(): MissionResult {
  return { capabilityId: 'data_quality', summary: 'Geprüft', counts: { missing: 1 }, columns: ['column', 'missing'],
    rows: [{ column: 'id', missing: 1 }], totalRows: 1, truncated: false,
    evidence: { sourceHash, capabilityVersion: 'data-quality-v1', executedAt: '2026-09-23T10:00:01Z' } };
}
function engine(overrides: Partial<MissionEngine> = {}): MissionEngine {
  return { capabilities: [{ id: 'data_quality', version: 'data-quality-v1', title: 'Datenqualität', description: 'Prüfen', limitations: [] }],
    async plan(m) { return { source: source(m), plan: structuredClone(plan) }; },
    validateRun(_m, input) { const value = input as any; if (value?.confirmed !== true || !value.binding) throw new Error('Confirm required'); return structuredClone(value); },
    async execute() { return result(); }, ...overrides };
}
async function fixture(t: TestContext, testEngine = engine(), maxPending?: number) {
  const root = await mkdtemp(join(tmpdir(), 'koi-missions-'));
  const authority = { current: structuredClone(owner) as SessionContext | null };
  const service = await createMissionService({ root, engine: testEngine, maxPending, assertPermissions,
    resolvePrincipal: async ref => authority.current?.user.id === ref.userId && authority.current.tenant.id === ref.tenantId ? authority.current : null });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  return { root, service, authority };
}
function errorCode(code: number) { return (e: unknown) => e instanceof MissionServiceError && e.statusCode === code; }
const createBody = (requestId = randomUUID()) => ({ question: 'Welche Werte fehlen?', datasetId: 'source', requestId });

test('durable acceptance and concurrent idempotency persist one mission; changed payload conflicts', async t => {
  let calls = 0;
  const f = await fixture(t, engine({ async plan(m) { calls++; return { source: source(m), plan }; } }));
  const request = createBody();
  const [first, second] = await Promise.all([f.service.create(owner, request), f.service.create(owner, request)]);
  assert.equal(first.id, second.id);
  const saved = JSON.parse(await readFile(join(f.root, 'missions/state.json'), 'utf8'));
  assert(saved.missions[first.id]); assert.equal(Object.keys(saved.requests).length, 1);
  await assert.rejects(f.service.create(owner, { ...request, question: 'Andere Frage' }), errorCode(409));
  await f.service.whenIdle(); assert.equal(calls, 1);
  assert.equal((await f.service.get(owner, first.id)).status, 'awaiting_confirmation');
});

test('confirmed run uses CAS and idempotency, then preserves a truthful result', async t => {
  let calls = 0;
  const f = await fixture(t, engine({ async execute() { calls++; return result(); } }));
  const created = await f.service.create(owner, createBody()); await f.service.whenIdle();
  const planned = await f.service.get(owner, created.id);
  const body = { revision: planned.revision, requestId: randomUUID(), confirmed: true, binding: {} };
  const run = await f.service.run(owner, created.id, body);
  const duplicate = await f.service.run(owner, created.id, body);
  assert.equal(run.id, duplicate.id);
  await assert.rejects(f.service.run(owner, created.id, { ...body, requestId: randomUUID() }), errorCode(409));
  await f.service.whenIdle();
  const finished = await f.service.get(owner, created.id);
  assert.equal(finished.status, 'completed'); assert.deepEqual(finished.result, result()); assert.equal(calls, 1);
  await assert.rejects(f.service.retry(owner, created.id, { revision: finished.revision, requestId: randomUUID() }), errorCode(409));
});

test('tenant and owner checks protect list, details, execution and retry', async t => {
  const { service } = await fixture(t);
  const created = await service.create(owner, createBody()); await service.whenIdle();
  const planned = await service.get(owner, created.id);
  for (const stranger of [{ ...owner, user: { id: 'different-owner', displayName: 'Other' } },
    { ...owner, tenant: { ...owner.tenant, id: 'different-company' } }]) {
    assert.deepEqual(await service.list(stranger), []);
    await assert.rejects(service.get(stranger, created.id), errorCode(404));
    await assert.rejects(service.run(stranger, created.id, { revision: planned.revision, requestId: randomUUID(), confirmed: true, binding: {} }), errorCode(404));
    await assert.rejects(service.retry(stranger, created.id, { revision: planned.revision, requestId: randomUUID() }), errorCode(404));
  }
  await assert.rejects(service.create({ ...owner, permissions: ['datasets.read'] }, createBody()), errorCode(403));
  await assert.rejects(service.create(owner, { ...createBody(), tenantId: 'other' }), errorCode(400));
});

test('worker rechecks current authorization before queued work and publication', async t => {
  const entered = deferred<void>(); const release = deferred<void>(); let calls = 0;
  const f = await fixture(t, engine({ async plan(m) { calls++; entered.resolve(); await release.promise; return { source: source(m), plan }; } }));
  const first = await f.service.create(owner, createBody()); await entered.promise;
  const second = await f.service.create(owner, createBody());
  f.authority.current = null; release.resolve(); await f.service.whenIdle();
  assert.equal(calls, 1, 'revoked second job must not reach the engine');
  assert.equal((await f.service.get(owner, first.id)).status, 'blocked');
  assert.equal((await f.service.get(owner, second.id)).status, 'blocked');
  assert.equal((await f.service.get(owner, first.id)).result, undefined);
});

test('bounded queue rejects excess work but still accepts an idempotent duplicate', async t => {
  const release = deferred<void>(); const entered = deferred<void>();
  const f = await fixture(t, engine({ async plan(m) { entered.resolve(); await release.promise; return { source: source(m), plan }; } }), 1);
  const request = createBody(); const created = await f.service.create(owner, request); await entered.promise;
  await assert.rejects(f.service.create(owner, createBody()), errorCode(429));
  assert.equal((await f.service.create(owner, request)).id, created.id);
  release.resolve(); await f.service.whenIdle();
});

test('an acceptance during worker drain wakes the queue instead of stranding the new job', async t => {
  const f = await fixture(t); await f.service.whenIdle();
  const drained = deferred<void>(); const release = deferred<void>();
  const original = FileMissionStore.prototype.update;
  const ownPath = new FileMissionStore(f.root).path;
  let armed = true;
  FileMissionStore.prototype.update = async function<T>(change: Parameters<FileMissionStore['update']>[0]): Promise<T> {
    let idleRead = false;
    const value = await original.call(this, async state => {
      const before = JSON.stringify(state);
      const output = await change(state);
      idleRead = this.path === ownPath && armed && Object.values(state.missions).length > 0
        && output === undefined && before === JSON.stringify(state)
        && Object.values(state.missions).every(m => !['queued', 'planning', 'running'].includes(m.status));
      return output;
    });
    if (idleRead) { armed = false; drained.resolve(); await release.promise; }
    return value as T;
  };
  t.after(() => { FileMissionStore.prototype.update = original; release.resolve(); });
  await f.service.create(owner, createBody()); await drained.promise;
  // The durable queue was observed empty, but its worker promise has not settled.
  const raced = await f.service.create(owner, createBody());
  release.resolve(); await f.service.whenIdle();
  assert.equal((await f.service.get(owner, raced.id)).status, 'awaiting_confirmation');
  FileMissionStore.prototype.update = original;
});

test('unsupported question is blocked without retry, transient planning failure can retry', async t => {
  const { service } = await fixture(t, engine({ async plan(m) { return { source: source(m), plan: { ...plan, capabilityId: null, capabilityVersion: null, unsupportedReason: 'Prognosen fehlen.' } }; } }));
  const created = await service.create(owner, createBody()); await service.whenIdle();
  const blocked = await service.get(owner, created.id);
  assert.equal(blocked.status, 'blocked'); assert.match(blocked.error!, /Prognosen/);
  await assert.rejects(service.retry(owner, blocked.id, { revision: blocked.revision, requestId: randomUUID() }), errorCode(409));
  let attempts = 0;
  const transient = await fixture(t, engine({ async plan(m) { if (++attempts === 1) throw new Error('Modell vorübergehend nicht verfügbar.'); return { source: source(m), plan }; } }));
  const other = await transient.service.create(owner, createBody()); await transient.service.whenIdle();
  const failed = await transient.service.get(owner, other.id);
  await transient.service.retry(owner, failed.id, { revision: failed.revision, requestId: randomUUID() });
  await transient.service.whenIdle(); assert.equal((await transient.service.get(owner, other.id)).status, 'awaiting_confirmation');
});

test('mismatched source hash, capability version or preview cannot become completed', async t => {
  for (const damage of [
    (r: MissionResult) => { r.evidence.sourceHash = 'b'.repeat(64); },
    (r: MissionResult) => { r.evidence.capabilityVersion = 'unverified-v2'; },
    (r: MissionResult) => { r.truncated = true; },
  ]) {
    const { service } = await fixture(t, engine({ async execute() { const r = result(); damage(r); return r; } }));
    const created = await service.create(owner, createBody()); await service.whenIdle();
    const planned = await service.get(owner, created.id);
    await service.run(owner, planned.id, { revision: planned.revision, requestId: randomUUID(), confirmed: true, binding: {} });
    await service.whenIdle(); const blocked = await service.get(owner, planned.id);
    assert.equal(blocked.status, 'blocked'); assert.equal(blocked.result, undefined);
  }
});

test('restart resumes queued work but marks formerly planning/running work interrupted', async t => {
  const root = await mkdtemp(join(tmpdir(), 'koi-mission-restart-'));
  const store = new FileMissionStore(root);
  function mission(status: Mission['status'], phase: Mission['phase']): Mission {
    const now = new Date().toISOString();
    const m: Mission = { id: randomUUID(), tenantId: owner.tenant.id, ownerId: owner.user.id, question: 'Prüfen', datasetId: 'source',
      status, phase, revision: 2, createdAt: now, updatedAt: now, events: [{ at: now, status, message: 'fixture' }] };
    if (phase === 'execute') { m.plan = plan; m.source = source(m); m.input = { confirmed: true, binding: {} }; }
    return m;
  }
  const queued = mission('queued', 'plan'); const planning = mission('planning', 'plan'); const running = mission('running', 'execute');
  await store.update(state => { for (const m of [queued, planning, running]) state.missions[m.id] = m; });
  let executions = 0;
  const service = await createMissionService({ root, engine: engine({ async execute() { executions++; return result(); } }),
    resolvePrincipal: async () => owner, assertPermissions });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  await service.whenIdle();
  assert.equal((await service.get(owner, queued.id)).status, 'awaiting_confirmation');
  assert.equal((await service.get(owner, planning.id)).status, 'interrupted');
  const interrupted = await service.get(owner, running.id);
  assert.equal(interrupted.status, 'interrupted'); assert.equal(executions, 0);
  await service.retry(owner, running.id, { revision: interrupted.revision, requestId: randomUUID() });
  await service.whenIdle(); assert.equal(executions, 1); assert.equal((await service.get(owner, running.id)).status, 'completed');
});

test('close returns while engine is pending and fences its late result', { timeout: 5000 }, async t => {
  const release = deferred<void>(); const entered = deferred<void>();
  const { service } = await fixture(t, engine({ async execute() { entered.resolve(); await release.promise; return result(); } }));
  const created = await service.create(owner, createBody()); await service.whenIdle();
  const planned = await service.get(owner, created.id);
  await service.run(owner, planned.id, { revision: planned.revision, requestId: randomUUID(), confirmed: true, binding: {} });
  await entered.promise; await service.close();
  assert.equal((await service.get(owner, planned.id)).status, 'interrupted');
  release.resolve(); await service.whenIdle();
  const after = await service.get(owner, planned.id);
  assert.equal(after.status, 'interrupted'); assert.equal(after.result, undefined);
  await assert.rejects(service.create(owner, createBody()), errorCode(503));
});

test('failed execution accepts revised confirmed inputs; retry retains previous inputs', async t => {
  const inputs: unknown[] = [];
  const { service } = await fixture(t, engine({ async execute(_m, input) { inputs.push(input); if (input.binding.keyField !== 'id') throw new Error('Falsche Zuordnung'); return result(); } }));
  const created = await service.create(owner, createBody()); await service.whenIdle();
  let current = await service.get(owner, created.id);
  await service.run(owner, current.id, { revision: current.revision, requestId: randomUUID(), confirmed: true, binding: { keyField: 'bad' } });
  await service.whenIdle(); current = await service.get(owner, current.id);
  await service.retry(owner, current.id, { revision: current.revision, requestId: randomUUID() });
  await service.whenIdle(); current = await service.get(owner, current.id);
  assert.deepEqual(inputs[0], inputs[1]);
  await service.run(owner, current.id, { revision: current.revision, requestId: randomUUID(), confirmed: true, binding: { keyField: 'id' } });
  await service.whenIdle(); assert.equal((await service.get(owner, current.id)).status, 'completed');
});

test('store corruption is preserved and startup fails closed', async t => {
  const { service, root } = await fixture(t);
  await service.whenIdle(); await service.close();
  const path = join(root, 'missions/state.json'); const corrupt = '{broken: important evidence';
  await writeFile(path, corrupt);
  await assert.rejects(createMissionService({ root, engine: engine(), resolvePrincipal: async () => owner, assertPermissions }));
  assert.equal(await readFile(path, 'utf8'), corrupt);
});

test('a rejected final publication check leaves the previously committed mission unchanged', async t => {
  const f = await fixture(t);
  const created = await f.service.create(owner, createBody()); await f.service.whenIdle();
  const path = join(f.root, 'missions/state.json'); const before = await readFile(path, 'utf8');
  const store = new FileMissionStore(f.root);
  await assert.rejects(store.update(state => {
    state.missions[created.id]!.question = 'This change must not become visible';
  }, () => { throw new Error('Permission revoked before publish'); }), /Permission revoked/);
  assert.equal(await readFile(path, 'utf8'), before);
});

test('HTTP routes enforce auth and return persisted accepted jobs with validation conflicts', async t => {
  const { service, root } = await fixture(t);
  const app = Fastify(); let session: SessionContext | undefined = owner;
  app.addHook('onRequest', async request => { if (session) request.koiforgeSession = session; });
  registerMissionRoutes(app, service); t.after(async () => { await app.close(); });
  const payload = createBody();
  const accepted = await app.inject({ method: 'POST', url: '/api/missions', payload });
  assert.equal(accepted.statusCode, 202, accepted.body);
  const saved = JSON.parse(await readFile(join(root, 'missions/state.json'), 'utf8'));
  assert(saved.missions[accepted.json().mission.id]);
  assert.equal((await app.inject({ method: 'POST', url: '/api/missions', payload: { ...payload, datasetId: 'other' } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: '/api/missions', payload: { ...payload, question: 'x'.repeat(1001) } })).statusCode, 400);
  assert.equal((await app.inject({ url: '/api/missions/capabilities' })).json().items[0].id, 'data_quality');
  session = undefined;
  assert.equal((await app.inject({ url: '/api/missions' })).statusCode, 401);
  await service.whenIdle();
});

test('AuthStore resolves only its current actual owner and tenant without issuing a session', async t => {
  const root = await mkdtemp(join(tmpdir(), 'koi-job-owner-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'auth.json'); const auth = new AuthStore(path);
  const actualOwnerId = randomUUID();
  const state = { version: 1, account: { id: actualOwnerId, displayName: 'Owner', email: 'o@example.com', digest: 'a'.repeat(128), salt: 'b'.repeat(32) },
    workspace: { id: 'firm', name: 'Firm' }, sessions: [] };
  await writeFile(path, JSON.stringify(state));
  assert.equal((await auth.resolvePrincipal({ userId: actualOwnerId, tenantId: 'firm' }))?.user.id, actualOwnerId);
  assert.equal(await auth.resolvePrincipal({ userId: 'admin', tenantId: 'firm' }), null);
  assert.equal(await auth.resolvePrincipal({ userId: actualOwnerId, tenantId: 'other' }), null);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).sessions, []);
  await writeFile(path, JSON.stringify({ ...state, account: { ...state.account, id: randomUUID() } }));
  assert.equal(await auth.resolvePrincipal({ userId: actualOwnerId, tenantId: 'firm' }), null);
});
