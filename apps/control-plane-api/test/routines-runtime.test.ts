import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import Fastify from 'fastify';
import { FileDatasetRegistry } from '@koiforge/data-registry';
import type { SessionContext } from '@koiforge/security-core';
import type { ImportRow } from '../src/import-capability/isolated-executor.js';
import type { MissionEngine } from '../src/missions/contracts.js';
import { createMissionEngine } from '../src/missions/engine.js';
import { createMissionService, MissionServiceError, type MissionService } from '../src/missions/service.js';
import { FileMissionStore } from '../src/missions/store.js';
import { createSemanticModelService } from '../src/semantic-model/service.js';
import { registerRoutineRoutes } from '../src/routes/routines.js';
import type { AppRegistries } from '../src/registries.js';
import { createCaseService } from '../src/cases/service.js';
import { FileCaseStore } from '../src/cases/store.js';

const owner: SessionContext = { user: { id: 'routine-owner', displayName: 'Owner' }, tenant: { id: 'routine-firm', name: 'Firm', slug: 'routine-firm', status: 'active' },
  roleIds: ['owner'], permissions: ['datasets.read', 'datasets.manage', 'cases.read', 'cases.manage'] };
const other: SessionContext = { ...owner, user: { id: 'other-owner', displayName: 'Other' } };
const binding = { statusField: 'status', dueDateField: 'due' };
const orderRule = { openStatuses: ['offen'], closedStatuses: ['erledigt'], asOf: '2026-09-23', dueDateMeaning: 'promised_delivery_day' as const };
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'koi-routines-runtime-'));
  const services: MissionService[] = [];
  t.after(async () => { for (const s of services) { await s.close(); await s.whenIdle(); } await rm(root, { recursive: true, force: true }); });
  const auth = { allowed: true, modelEnabled: true, modelCalls: 0 };
  const authority = { async resolvePrincipal(ref: { userId: string; tenantId: string }) {
    return auth.allowed && ref.tenantId === owner.tenant.id
      ? structuredClone([owner, other].find(s => s.user.id === ref.userId) ?? null) : null;
  }, assertPermissions(session: SessionContext, permissions: string[]) { assert(permissions.every(p => session.permissions.includes(p))); } };
  const dataset = new FileDatasetRegistry({ filePath: join(root, 'datasets.json') });
  const semanticModel = createSemanticModelService({ root, registries: { dataset }, ...authority });
  async function object(name: string, rows: ImportRow[], previousId?: string) {
    const imported = await dataset.registerInlineDataset({ name: `${name}-${randomUUID()}`, namespace: 'routines', rows });
    const set = await semanticModel.createObjectSet(owner, { name, datasetId: imported.id, keyField: 'id',
      ...(name === 'Lieferanten' ? { labelField: 'name' } : {}), ...(previousId ? { previousId } : {}), confirmed: true, requestId: randomUUID() });
    return { imported, set };
  }
  const from = await object('Bestellungen', [{ id: 'O1', supplier: 'S', status: 'offen', due: '2026-09-21' },
    { id: 'O2', supplier: 'S', status: 'erledigt', due: null }, { id: 'O3', supplier: 'S', status: 'offen', due: '2026-09-26' }]);
  const to = await object('Lieferanten', [{ id: 'S', name: 'Supplier' }]);
  async function relation(fromId: string, toId: string) {
    return semanticModel.createRelationship(owner, { name: 'Bestellung gehört zu Lieferant', fromSetId: fromId,
      toSetId: toId, fromField: 'supplier', confirmed: true, requestId: randomUUID() });
  }
  const relationship = await relation(from.set.id, to.set.id);
  const generator = { backend: 'codex' as const, model: 'fixture', reasoningEffort: 'xhigh', async status() {
    if (!auth.modelEnabled) throw new Error('Model must not be consulted for a routine');
    return { backend: 'codex' as const, model: 'fixture', reasoningEffort: 'xhigh', available: true };
  }, async generate() {
    auth.modelCalls++; if (!auth.modelEnabled) throw new Error('Model must not be called for a routine');
    return JSON.stringify({ capabilityId: 'order_review', summary: 'Offene Bestellungen prüfen.', suggestedBinding: binding });
  } };
  const engine = createMissionEngine(root, { dataset } as AppRegistries, { generator, semanticModel });
  async function start(using: MissionEngine = engine, model = semanticModel) {
    const s = await createMissionService({ root, engine: using, semanticModel: model, ...authority }); services.push(s); return s;
  }
  const service = await start();
  const accepted = await service.create(owner, { question: 'Welche Bestellungen sind offen?', datasetId: from.imported.id,
    relationshipId: relationship.id, requestId: randomUUID() });
  await service.whenIdle(); const planned = await service.get(owner, accepted.id);
  assert.equal(planned.status, 'awaiting_confirmation', planned.error);
  await service.run(owner, accepted.id, { confirmed: true, binding, orderRule, revision: planned.revision, requestId: randomUUID() });
  await service.whenIdle(); const completed = await service.get(owner, accepted.id);
  assert.equal(completed.status, 'completed', completed.error);
  const create = { name: 'Wöchentliche Bestellungen', sourceMissionId: completed.id, confirmed: true, requestId: randomUUID() };
  async function next() {
    const nextFrom = await object('Bestellungen', [...Array.from({ length: 200 }, (_, i) => ({ id: `N${i}`, supplier: 'S', status: 'erledigt', due: null })),
      { id: 'LATE', supplier: 'S', status: 'offen', due: '2026-09-22' },
      { id: 'NEW', supplier: 'S', status: 'neu', due: '2026-01-01' },
      { id: 'MISSING', supplier: 'U', status: 'offen', due: null }], from.set.id);
    const nextTo = await object('Lieferanten', [{ id: 'S', name: 'Supplier revision two' }], to.set.id);
    return { from: nextFrom, to: nextTo, relation: await relation(nextFrom.set.id, nextTo.set.id) };
  }
  return { root, auth, authority, dataset, semanticModel, engine, start, service, completed, create, from, to, relationship, object, relation, next };
}
const status = (code: number) => (e: unknown) => e instanceof MissionServiceError && e.statusCode === code;

test('saving a routine requires a completed confirmed order and is immutable and idempotent after restart', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.createRoutine(owner, { ...f.create, confirmed: false }), status(400));
  const routine = await f.service.createRoutine(owner, f.create);
  assert.deepEqual(routine.binding, binding); assert.deepEqual(routine.orderRule, orderRule);
  assert.equal(routine.baseline.fromFamilyId, f.from.set.familyId); assert.equal(routine.baseline.toFamilyId, f.to.set.familyId);
  assert.deepEqual(routine.baseline.counts, f.completed.result!.counts);
  assert.equal((await f.service.createRoutine(owner, f.create)).id, routine.id);
  await assert.rejects(f.service.createRoutine(owner, { ...f.create, name: 'Andere Regeln' }), status(409));
  const pending = await f.service.create(owner, { question: 'Offene Bestellungen', datasetId: f.from.imported.id,
    relationshipId: f.relationship.id, requestId: randomUUID() }); await f.service.whenIdle();
  await assert.rejects(f.service.createRoutine(owner, { ...f.create, sourceMissionId: pending.id, requestId: randomUUID() }), status(409));
  await f.service.close(); const restarted = await f.start();
  assert.deepEqual(await restarted.getRoutine(owner, routine.id), routine);
  assert.equal((await restarted.createRoutine(owner, f.create)).id, routine.id);
  assert.equal((await restarted.listRoutines(owner)).length, 1);
});

test('new-source preview and confirmed run reuse the plan without a model, preserve full counts and both historical results', async t => {
  const f = await fixture(t); const routine = await f.service.createRoutine(owner, f.create); const next = await f.next();
  f.auth.modelEnabled = false;
  const previewInput = { relationshipId: next.relation.id, asOf: '2026-09-24' };
  const preview = await f.service.previewRoutine(owner, routine.id, previewInput);
  assert.equal(preview.ready, true); assert.match(preview.previewHash!, /^[a-f0-9]{64}$/);
  assert.equal(preview.changes.from.previousRows, 3); assert.equal(preview.changes.from.rows, 203);
  assert.deepEqual(preview.newCounts, { sourceRows: 203, overdueRows: 1, openRows: 1, closedRows: 200,
    unassessableRows: 1, clarificationRows: 2, deadlineUnassessableRows: 1 });
  assert.equal(preview.statusProfile.unknownRows, 1);
  assert(preview.statusProfile.unknownValues.some(v => v.value === 'neu' && v.count === 1));
  assert.equal((await f.service.list(owner)).length, 1, 'preview creates no mission');
  const run = { ...previewInput, confirmed: true, previewHash: preview.previewHash, requestId: randomUUID() };
  await assert.rejects(f.service.runRoutine(owner, routine.id, { ...run, confirmed: false }), status(400));
  await assert.rejects(f.service.runRoutine(owner, routine.id, { ...run, asOf: '2026-09-25' }), status(409));
  await assert.rejects(f.service.runRoutine(owner, routine.id, { ...run, previewHash: 'c'.repeat(64) }), status(409));
  // Neither live source remains available when this new job is accepted.
  await f.dataset.deleteDataset(next.from.imported.id); await f.dataset.deleteDataset(next.to.imported.id);
  await f.service.close(); const service = await f.start();
  assert.deepEqual(await service.previewRoutine(owner, routine.id, previewInput), preview);
  const [a, b] = await Promise.all([service.runRoutine(owner, routine.id, run), service.runRoutine(owner, routine.id, run)]);
  assert.equal(a.id, b.id); await service.whenIdle();
  const completed = await service.get(owner, a.id); assert.equal(completed.status, 'completed', completed.error);
  assert.deepEqual(completed.result!.counts, preview.newCounts);
  assert.equal(completed.result!.rows[0]!.Quellzeile, 201);
  assert.equal(completed.result!.rows.length, 100); assert.equal(completed.result!.totalRows, 203);
  assert.equal(completed.plan!.reusedFromMissionId, f.completed.id);
  assert.equal(completed.routine!.previewHash, preview.previewHash);
  assert.equal(completed.result!.evidence.orderRuleHash, preview.orderRuleHash);
  assert.equal(completed.result!.evidence.fromSnapshotHash, next.from.set.snapshotHash);
  assert.equal(completed.result!.evidence.toSnapshotHash, next.to.set.snapshotHash);
  assert.equal(f.auth.modelCalls, 1, 'only the original mission invokes the planner');
  assert.deepEqual(await service.get(owner, f.completed.id), f.completed);
  assert.deepEqual(await service.getRoutine(owner, routine.id), routine);
  await service.close(); const restarted = await f.start();
  assert.deepEqual((await restarted.get(owner, a.id)).result, completed.result);
  assert.equal((await restarted.runRoutine(owner, routine.id, run)).id, a.id);
  assert.equal((await restarted.list(owner)).length, 2);
  await assert.rejects(restarted.runRoutine(owner, routine.id, { ...run, asOf: '2026-09-26' }), status(409));
});

test('incompatible field schema yields a blocked preview and cannot be forced into a queued mission', async t => {
  const f = await fixture(t); const routine = await f.service.createRoutine(owner, f.create);
  const revised = await f.object('Bestellungen', [{ id: 'O1', supplier: 'S', status: 'offen' }], f.from.set.id);
  const relation = await f.relation(revised.set.id, f.to.set.id);
  const input = { relationshipId: relation.id, asOf: '2026-09-24' };
  const preview = await f.service.previewRoutine(owner, routine.id, input);
  assert.equal(preview.ready, false); assert.equal(preview.previewHash, undefined); assert.equal(preview.newCounts, undefined);
  assert(preview.blockingReasons.length > 0); assert(preview.changes.from.removedColumns.includes('due'));
  await assert.rejects(f.service.runRoutine(owner, routine.id, { ...input, previewHash: 'a'.repeat(64), confirmed: true, requestId: randomUUID() }), status(409));
  assert.equal((await f.service.list(owner)).length, 1);
  const invalidDate = await f.service.previewRoutine(owner, routine.id, { ...input, asOf: '2026-02-29' });
  assert.equal(invalidDate.ready, false); assert.equal(invalidDate.previewHash, undefined);
});

test('revocation immediately before atomic routine-run publication leaves state and receipt unchanged', async t => {
  const f = await fixture(t); const routine = await f.service.createRoutine(owner, f.create);
  const input = { relationshipId: f.relationship.id, asOf: '2026-09-24' };
  const preview = await f.service.previewRoutine(owner, routine.id, input);
  await f.service.close();
  const model = { ...f.semanticModel, async relationshipSnapshotForMission(...args: Parameters<typeof f.semanticModel.relationshipSnapshotForMission>) {
    const snapshot = await f.semanticModel.relationshipSnapshotForMission(...args); f.auth.allowed = false; return snapshot;
  } };
  const service = await f.start(f.engine, model);
  const store = new FileMissionStore(f.root); const before = await readFile(store.path, 'utf8');
  const run = { ...input, confirmed: true, previewHash: preview.previewHash, requestId: randomUUID() };
  await assert.rejects(service.runRoutine(owner, routine.id, run), status(403));
  assert.equal(await readFile(store.path, 'utf8'), before);
  f.auth.allowed = true;
  await service.close(); const restored = await f.start();
  const accepted = await restored.runRoutine(owner, routine.id, run); await restored.whenIdle();
  assert.equal((await restored.get(owner, accepted.id)).status, 'completed');
});

test('HTTP routine reads, previews and mutations enforce ownership, live rights and strict bodies', async t => {
  const f = await fixture(t); const app = Fastify(); let session: SessionContext | undefined = owner;
  app.addHook('onRequest', async request => { request.koiforgeSession = session as SessionContext; });
  registerRoutineRoutes(app, f.service); t.after(() => app.close());
  const saved = await app.inject({ method: 'POST', url: '/api/routines', payload: f.create });
  assert.equal(saved.statusCode, 200, saved.body); const routine = saved.json().routine;
  assert.equal((await app.inject(`/api/routines/${routine.id}`)).statusCode, 200);
  const previewInput = { relationshipId: f.relationship.id, asOf: '2026-09-24' };
  assert.equal((await app.inject({ method: 'POST', url: `/api/routines/${routine.id}/preview`, payload: { ...previewInput, binding: { statusField: 'supplier' } } })).statusCode, 400);
  session = other; assert.equal((await app.inject(`/api/routines/${routine.id}`)).statusCode, 404);
  assert.deepEqual((await app.inject('/api/routines')).json(), { items: [] });
  session = { ...owner, permissions: ['datasets.read'] };
  assert.equal((await app.inject(`/api/routines/${routine.id}`)).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/api/routines/${routine.id}/preview`, payload: previewInput })).statusCode, 403);
  session = undefined; assert.equal((await app.inject('/api/routines')).statusCode, 401);
  session = owner; f.auth.allowed = false;
  assert.equal((await app.inject(`/api/routines/${routine.id}`)).statusCode, 403);
});

test('corrupt routine definition fails closed without overwriting its file', async t => {
  const f = await fixture(t); const routine = await f.service.createRoutine(owner, f.create);
  const store = new FileMissionStore(f.root); const original = await readFile(store.path, 'utf8');
  const state = JSON.parse(original); state.routines[routine.id].definition.orderRule.openStatuses = ['erledigt'];
  const corrupted = JSON.stringify(state); await writeFile(store.path, corrupted);
  await assert.rejects(f.service.getRoutine(owner, routine.id));
  await assert.rejects(f.service.createRoutine(owner, { ...f.create, requestId: randomUUID() }));
  assert.equal(await readFile(store.path, 'utf8'), corrupted);
  await writeFile(store.path, original);
});

test('existing v1 mission files acquire empty routine storage without losing old missions', async t => {
  const f = await fixture(t); await f.service.close(); const store = new FileMissionStore(f.root);
  const state = JSON.parse(await readFile(store.path, 'utf8')); delete state.routines; delete state.routineRequests;
  await writeFile(store.path, JSON.stringify(state)); const restarted = await f.start();
  assert.deepEqual(await restarted.get(owner, f.completed.id), f.completed);
  assert.deepEqual(await restarted.listRoutines(owner), []);
  const routine = await restarted.createRoutine(owner, f.create);
  assert.equal(routine.sourceMissionId, f.completed.id);
});

test('unavailable capability versions leave stored routines readable but prevent preview and execution', async t => {
  const f = await fixture(t); const routine = await f.service.createRoutine(owner, f.create); await f.service.close();
  const engine = { ...f.engine, capabilities: f.engine.capabilities.filter(c => c.id !== 'order_review') };
  const service = await f.start(engine);
  assert.equal((await service.getRoutine(owner, routine.id)).id, routine.id);
  await assert.rejects(service.previewRoutine(owner, routine.id, { relationshipId: f.relationship.id, asOf: '2026-09-24' }), status(409));
});

test('routine retry retains confirmed inputs; generic corrections and altered preview tokens cannot bypass confirmation', async t => {
  const f = await fixture(t); const routine = await f.service.createRoutine(owner, f.create);
  const selection = { relationshipId: f.relationship.id, asOf: '2026-09-24' };
  const preview = await f.service.previewRoutine(owner, routine.id, selection);
  await f.service.close(); let failExecution = true;
  const engine: MissionEngine = { ...f.engine, async execute(...args) {
    if (failExecution) throw new Error('Temporarily unavailable');
    return f.engine.execute(...args);
  } };
  const service = await f.start(engine);
  const accepted = await service.runRoutine(owner, routine.id, { ...selection, previewHash: preview.previewHash, confirmed: true, requestId: randomUUID() });
  await service.whenIdle(); const blocked = await service.get(owner, accepted.id); assert.equal(blocked.status, 'blocked');
  await assert.rejects(service.run(owner, accepted.id, { confirmed: true, binding, orderRule: { ...orderRule, asOf: '2026-09-30' },
    revision: blocked.revision, requestId: randomUUID() }), status(409));
  assert.deepEqual((await service.get(owner, accepted.id)).input, blocked.input);
  failExecution = false;
  await service.retry(owner, accepted.id, { revision: blocked.revision, requestId: randomUUID() }); await service.whenIdle();
  const completed = await service.get(owner, accepted.id); assert.equal(completed.status, 'completed', completed.error);
  assert.deepEqual(completed.input, blocked.input); assert.equal(completed.routine!.confirmedRuleHash, preview.orderRuleHash);

  failExecution = true;
  const second = await service.runRoutine(owner, routine.id, { ...selection, previewHash: preview.previewHash, confirmed: true, requestId: randomUUID() });
  await service.whenIdle(); await service.close();
  const store = new FileMissionStore(f.root); const persisted = JSON.parse(await readFile(store.path, 'utf8'));
  persisted.missions[second.id].routine.previewHash = 'f'.repeat(64);
  await writeFile(store.path, JSON.stringify(persisted)); failExecution = false;
  const restarted = await f.start(engine); const altered = await restarted.get(owner, second.id);
  await restarted.retry(owner, second.id, { revision: altered.revision, requestId: randomUUID() }); await restarted.whenIdle();
  const rejected = await restarted.get(owner, second.id);
  assert.equal(rejected.status, 'blocked'); assert.match(rejected.error!, /Vorprüfung/); assert.equal(rejected.result, undefined);
});

test('stored routine input cannot drift from its confirmed rule hash', async t => {
  const f = await fixture(t); const routine = await f.service.createRoutine(owner, f.create);
  const selection = { relationshipId: f.relationship.id, asOf: '2026-09-24' };
  const preview = await f.service.previewRoutine(owner, routine.id, selection);
  const accepted = await f.service.runRoutine(owner, routine.id, { ...selection, previewHash: preview.previewHash, confirmed: true, requestId: randomUUID() });
  await f.service.whenIdle();
  const store = new FileMissionStore(f.root); const original = await readFile(store.path, 'utf8');
  const state = JSON.parse(original); state.missions[accepted.id].input.orderRule.asOf = '2026-09-30';
  const corrupted = JSON.stringify(state); await writeFile(store.path, corrupted);
  await assert.rejects(f.service.get(owner, accepted.id), /Routinenregeln/);
  assert.equal(await readFile(store.path, 'utf8'), corrupted); await writeFile(store.path, original);
});

async function completedRepeat(f: Awaited<ReturnType<typeof fixture>>, routineId: string, relationshipId: string) {
  const selection = { relationshipId, asOf: '2026-09-24' };
  const preview = await f.service.previewRoutine(owner, routineId, selection);
  const run = await f.service.runRoutine(owner, routineId, { ...selection, previewHash: preview.previewHash,
    confirmed: true, requestId: randomUUID() });
  await f.service.whenIdle();
  assert.equal((await f.service.get(owner, run.id)).status, 'completed');
  return run.id;
}

test('completed-run comparison pages all findings, preserves cases and snapshots, and survives source deletion and restart without a model', async t => {
  const f = await fixture(t); const routine = await f.service.createRoutine(owner, f.create);
  const cases = createCaseService({ root: f.root, semanticModel: f.semanticModel, ...f.authority });
  const location = { missionId: f.completed.id, sourceRow: 1 };
  const proposal = await cases.preview(owner, location);
  const item = await cases.create(owner, { ...location, previewHash: proposal.previewHash, confirmed: true, requestId: randomUUID() });
  const revised = await f.object('Bestellungen', [
    ...Array.from({ length: 150 }, (_, i) => ({ id: `NEW-${String(i).padStart(3, '0')}`, supplier: 'S', status: 'offen', due: '2026-09-20' })),
    { id: 'O1', supplier: 'S', status: 'erledigt', due: '2026-09-21' },
  ], f.from.set.id);
  const relation = await f.relation(revised.set.id, f.to.set.id);
  f.auth.modelEnabled = false;
  const missionId = await completedRepeat(f, routine.id, relation.id);
  await f.dataset.deleteDataset(f.from.imported.id); await f.dataset.deleteDataset(f.to.imported.id);
  await f.dataset.deleteDataset(revised.imported.id);
  await f.service.close(); const service = await f.start();
  const paths = [new FileMissionStore(f.root).path, new FileCaseStore(f.root).path, join(f.root, 'semantic-model', 'state.json')];
  const saved = await Promise.all(paths.map(path => readFile(path, 'utf8')));
  const first = await service.compareRoutineRun(owner, routine.id, { missionId });
  assert.equal(first.items.length, 25); assert.equal(first.totalRows, 151);
  assert.deepEqual(first.counts, { new: 150, persisting: 0, cleared: 1, missing: 0, uncomparable: 0 });
  assert.equal(first.before.asOf, '2026-09-23'); assert.equal(first.after.asOf, '2026-09-24');
  assert.equal(first.baselineMissionId, f.completed.id);
  const tail = await service.compareRoutineRun(owner, routine.id, { missionId, category: 'new', offset: '125', limit: '25' });
  assert.equal(tail.totalRows, 150); assert.equal(tail.items.length, 25);
  assert.equal(tail.items.at(-1)?.after?.sourceRow, 150, 'complete evidence beyond the 100-row stored result');
  assert.deepEqual(tail.counts, first.counts); assert.equal(tail.comparisonHash, first.comparisonHash);
  const cleared = await service.compareRoutineRun(owner, routine.id, { missionId, category: 'cleared' });
  assert.equal(cleared.totalRows, 1); assert.equal(cleared.items[0]?.before?.sourceRow, 1);
  assert.equal(cleared.items[0]?.after?.sourceRow, 151); assert.equal(cleared.items[0]?.key, 'O1');
  assert.deepEqual(await cases.get(owner, item.id), item, 'unauffällig does not resolve the original case');
  assert.equal((await service.compareRoutineRun(owner, routine.id, { missionId, offset: 999 })).items.length, 0);
  const runs = await service.listRoutineRuns(owner, routine.id);
  assert.equal(runs.length, 1); assert.equal(runs[0]?.id, missionId); assert.equal(runs[0]?.status, 'completed');
  assert.equal(Object.hasOwn(runs[0]!, 'result'), false);
  assert.deepEqual(await Promise.all(paths.map(path => readFile(path, 'utf8'))), saved, 'comparison and paging write no state');
  assert.equal(f.auth.modelCalls, 1);
  await service.close(); const restarted = await f.start();
  assert.deepEqual(await restarted.compareRoutineRun(owner, routine.id, { missionId }), first);
});

test('HTTP comparison enforces ownership, source rights, strict pagination and same-routine completed runs', async t => {
  const f = await fixture(t); const routine = await f.service.createRoutine(owner, f.create);
  const missionId = await completedRepeat(f, routine.id, f.relationship.id);
  const second = await f.service.createRoutine(owner, { ...f.create, name: 'Andere Routine', requestId: randomUUID() });
  const secondId = await completedRepeat(f, second.id, f.relationship.id);
  const app = Fastify(); let session: SessionContext | undefined = owner;
  app.addHook('onRequest', async request => { request.koiforgeSession = session; });
  registerRoutineRoutes(app, f.service); t.after(() => app.close());
  const url = `/api/routines/${routine.id}/compare?missionId=${missionId}`;
  assert.equal((await app.inject(url)).statusCode, 200);
  assert.equal((await app.inject(`/api/routines/${routine.id}/runs`)).json().items.length, 1);
  for (const suffix of ['&offset=-1', '&offset=1.1', '&offset=', '&limit=0', '&limit=101', '&limit=true', '&category=all', '&asOf=2027-01-01', '&offset=0&offset=1']) {
    assert.equal((await app.inject(url + suffix)).statusCode, 400, suffix);
  }
  assert.equal((await app.inject(`/api/routines/${routine.id}/compare?missionId=${secondId}`)).statusCode, 409);
  assert.equal((await app.inject(`/api/routines/${routine.id}/compare?missionId=${f.completed.id}`)).statusCode, 409);
  assert.equal((await app.inject(`/api/routines/${routine.id}/compare?missionId=${randomUUID()}`)).statusCode, 404);
  session = other;
  assert.equal((await app.inject(url)).statusCode, 404);
  assert.equal((await app.inject(`/api/routines/${routine.id}/runs`)).statusCode, 404);
  session = { ...owner, permissions: ['datasets.read'] };
  assert.equal((await app.inject(`/api/routines/${routine.id}/runs`)).statusCode, 200);
  assert.equal((await app.inject(url)).statusCode, 403);
  session = undefined; assert.equal((await app.inject(url)).statusCode, 401);
  session = owner; f.auth.allowed = false; assert.equal((await app.inject(url)).statusCode, 403);
});

test('a revoked principal after snapshot loading cannot receive comparison evidence', async t => {
  const f = await fixture(t); const routine = await f.service.createRoutine(owner, f.create);
  const missionId = await completedRepeat(f, routine.id, f.relationship.id);
  await f.service.close();
  const model = { ...f.semanticModel, async relationshipSnapshotForMission(...args: Parameters<typeof f.semanticModel.relationshipSnapshotForMission>) {
    const snapshot = await f.semanticModel.relationshipSnapshotForMission(...args); f.auth.allowed = false; return snapshot;
  } };
  const service = await f.start(f.engine, model);
  const path = new FileMissionStore(f.root).path; const original = await readFile(path, 'utf8');
  await assert.rejects(service.compareRoutineRun(owner, routine.id, { missionId }), status(403));
  assert.equal(await readFile(path, 'utf8'), original);
});

test('a changed stored result cannot become comparison evidence', async t => {
  const f = await fixture(t); const routine = await f.service.createRoutine(owner, f.create);
  const missionId = await completedRepeat(f, routine.id, f.relationship.id);
  const path = new FileMissionStore(f.root).path; const original = await readFile(path, 'utf8');
  const state = JSON.parse(original); state.missions[missionId].result.rows[0].Befund = 'Abgeschlossen';
  const corrupted = JSON.stringify(state); await writeFile(path, corrupted);
  await assert.rejects(f.service.compareRoutineRun(owner, routine.id, { missionId }), status(409));
  assert.equal(await readFile(path, 'utf8'), corrupted); await writeFile(path, original);
});
