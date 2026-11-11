import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import Fastify from 'fastify';
import { FileDatasetRegistry } from '@koiforge/data-registry';
import type { SessionContext } from '@koiforge/security-core';
import { createCaseService, CaseServiceError } from '../src/cases/service.js';
import { FileCaseStore } from '../src/cases/store.js';
import { createMissionEngine } from '../src/missions/engine.js';
import { createMissionService } from '../src/missions/service.js';
import { FileMissionStore } from '../src/missions/store.js';
import { createSemanticModelService } from '../src/semantic-model/service.js';
import { registerCaseRoutes } from '../src/routes/cases.js';
import type { AppRegistries } from '../src/registries.js';

const owner: SessionContext = { user: { id: 'case-owner', displayName: 'Fallbearbeiterin' },
  tenant: { id: 'case-firm', slug: 'case-firm', name: 'Firma', status: 'active' }, roleIds: ['owner'],
  permissions: ['datasets.read', 'datasets.manage', 'cases.read', 'cases.manage'] };
const other = { ...owner, user: { id: 'other-owner', displayName: 'Other' } };
const foreign = { ...owner, tenant: { ...owner.tenant, id: 'foreign-firm' } };
const binding = { statusField: 'status', dueDateField: 'due' };
const orderRule = { openStatuses: ['offen'], closedStatuses: ['erledigt'], asOf: '2026-09-23', dueDateMeaning: 'promised_delivery_day' as const };
const status = (code: number) => (error: unknown) => error instanceof CaseServiceError && error.statusCode === code;
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'koi-cases-runtime-'));
  const control = { allowed: true, permissions: [...owner.permissions], modelEnabled: true, modelCalls: 0 };
  const authority = { async resolvePrincipal(ref: { userId: string; tenantId: string }) {
    const user = [owner, other, foreign].find(item => item.user.id === ref.userId && item.tenant.id === ref.tenantId);
    return control.allowed && user ? { ...structuredClone(user), permissions: [...control.permissions] } : null;
  }, assertPermissions(session: SessionContext, permissions: string[]) { assert(permissions.every(p => session.permissions.includes(p))); } };
  const dataset = new FileDatasetRegistry({ filePath: join(root, 'datasets.json') });
  const semanticModel = createSemanticModelService({ root, registries: { dataset }, ...authority });
  const source = await dataset.registerInlineDataset({ name: 'Bestellungen', namespace: 'cases', rows: [
    ...Array.from({ length: 105 }, (_, i) => ({ id: `O${i}`, supplier: 'S', status: 'offen', due: '2026-09-21' })),
    { id: 'CLOSED-UNKNOWN-SUPPLIER', supplier: 'U', status: 'erledigt', due: null },
    { id: 'CLEAN-OPEN', supplier: 'S', status: 'offen', due: '2026-09-26' },
    { id: 'CLEAN-CLOSED', supplier: 'S', status: 'erledigt', due: null },
  ] });
  const target = await dataset.registerInlineDataset({ name: 'Lieferanten', namespace: 'cases', rows: [{ id: 'S', name: 'S' }] });
  const from = await semanticModel.createObjectSet(owner, { name: 'Bestellungen', datasetId: source.id, keyField: 'id', confirmed: true, requestId: randomUUID() });
  const to = await semanticModel.createObjectSet(owner, { name: 'Lieferanten', datasetId: target.id, keyField: 'id', labelField: 'name', confirmed: true, requestId: randomUUID() });
  const relation = await semanticModel.createRelationship(owner, { name: 'Lieferant der Bestellung', fromSetId: from.id, toSetId: to.id, fromField: 'supplier', confirmed: true, requestId: randomUUID() });
  const generator = { backend: 'codex' as const, model: 'fixture', reasoningEffort: 'xhigh', async status() {
    assert(control.modelEnabled, 'cases must not ask for a model status');
    return { backend: 'codex' as const, model: 'fixture', reasoningEffort: 'xhigh', available: true };
  }, async generate() { assert(control.modelEnabled, 'cases must not invoke a model'); control.modelCalls++;
    return JSON.stringify({ capabilityId: 'order_review', summary: 'Bestellungen klären', suggestedBinding: binding }); } };
  const engine = createMissionEngine(root, { dataset } as AppRegistries, { generator, semanticModel });
  const missions = await createMissionService({ root, engine, semanticModel, ...authority });
  t.after(async () => { await missions.close(); await missions.whenIdle(); await rm(root, { recursive: true, force: true }); });
  const accepted = await missions.create(owner, { question: 'Welche Bestellungen sind offen?', datasetId: source.id, relationshipId: relation.id, requestId: randomUUID() });
  await missions.whenIdle(); const planned = await missions.get(owner, accepted.id); assert.equal(planned.status, 'awaiting_confirmation', planned.error);
  await missions.run(owner, accepted.id, { revision: planned.revision, requestId: randomUUID(), confirmed: true, binding, orderRule });
  await missions.whenIdle(); const completed = await missions.get(owner, accepted.id); assert.equal(completed.status, 'completed', completed.error);
  control.modelEnabled = false;
  const start = (model = semanticModel) => createCaseService({ root, semanticModel: model, ...authority });
  const service = start(); const store = new FileCaseStore(root);
  const selection = { missionId: accepted.id, sourceRow: 106 };
  async function create(sourceRow = 106) {
    const preview = await service.preview(owner, { ...selection, sourceRow });
    const input = { ...selection, sourceRow, previewHash: preview.previewHash, confirmed: true, requestId: randomUUID() };
    return { preview, input, item: await service.create(owner, input) };
  }
  return { root, control, authority, dataset, semanticModel, source, target, missions, completed, service, store, start, selection, create };
}

test('case preview reproduces the complete source and offers relevant rows beyond the saved result without mutation or model access', async t => {
  const f = await fixture(t);
  const before = await readFile(new FileMissionStore(f.root).path, 'utf8');
  assert.equal(f.completed.result!.rows.length, 100);
  const page = await f.service.findings(owner, { missionId: f.completed.id, offset: '100', limit: '10' });
  assert.equal(page.totalRows, 106); assert.equal(page.items.length, 6); assert.equal(page.items.at(-1)!.Quellzeile, 106);
  const preview = await f.service.preview(owner, f.selection);
  assert.equal(preview.evidence.finding.Befund, 'Abgeschlossen');
  assert.match(String(preview.evidence.finding.Klärungsgrund), /Lieferantenreferenz/);
  assert.equal(preview.existingCaseId, null); assert.match(preview.previewHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(await f.service.list(owner), []);
  assert.equal(await readFile(new FileMissionStore(f.root).path, 'utf8'), before);
  assert.equal(f.control.modelCalls, 1);
  for (const sourceRow of [107, 108, 109]) await assert.rejects(f.service.preview(owner, { ...f.selection, sourceRow }), status(409));
  for (const sourceRow of [0, -1, 1.5, '106']) await assert.rejects(f.service.preview(owner, { ...f.selection, sourceRow }), status(400));
});

test('creation requires the exact confirmed preview and cannot accept client-invented evidence or actors', async t => {
  const f = await fixture(t); const preview = await f.service.preview(owner, f.selection);
  const input = { ...f.selection, previewHash: preview.previewHash, confirmed: true, requestId: randomUUID() };
  await assert.rejects(f.service.create(owner, { ...input, confirmed: false }), status(400));
  await assert.rejects(f.service.create(owner, { ...input, evidence: preview.evidence }), status(400));
  await assert.rejects(f.service.create(owner, { ...input, ownerId: other.user.id }), status(400));
  await assert.rejects(f.service.create(owner, { ...input, sourceRow: 1 }), status(409));
  await assert.rejects(f.service.create(owner, { ...input, previewHash: 'f'.repeat(64) }), status(409));
  assert.equal((await f.service.list(owner)).length, 0);
  const item = await f.service.create(owner, input);
  assert.equal(item.status, 'open'); assert.equal(item.assignee, null); assert.equal(item.resolution, null);
  assert.deepEqual(item.events, [{ at: item.createdAt, actorId: owner.user.id, actorName: owner.user.displayName, kind: 'created', note: null }]);
});

test('business-key uniqueness and idempotency survive concurrent requests, source deletion and restart', async t => {
  const f = await fixture(t); const preview = await f.service.preview(owner, f.selection);
  const input = { ...f.selection, previewHash: preview.previewHash, confirmed: true, requestId: randomUUID() };
  await f.dataset.deleteDataset(f.source.id); await f.dataset.deleteDataset(f.target.id);
  const [first, repeat, otherRequest] = await Promise.all([f.service.create(owner, input), f.service.create(owner, input),
    f.service.create(owner, { ...input, requestId: randomUUID() })]);
  assert.equal(first.id, repeat.id); assert.equal(first.id, otherRequest.id);
  assert.equal((await f.service.list(owner)).length, 1); assert.equal(first.events.length, 1);
  const restarted = f.start(); assert.deepEqual(await restarted.get(owner, first.id), first);
  assert.equal((await restarted.create(owner, input)).id, first.id);
  assert.equal((await restarted.preview(owner, f.selection)).existingCaseId, first.id);
  await assert.rejects(restarted.create(owner, { ...input, sourceRow: 1 }), status(409));
});

test('claim, documented resolution and reopening retain immutable evidence and a complete actor history', async t => {
  const f = await fixture(t); const { item } = await f.create();
  const origin = await readFile(new FileMissionStore(f.root).path, 'utf8');
  const request = { revision: item.revision, requestId: randomUUID(), action: 'claim', confirmed: true };
  const claimed = await f.service.transition(owner, item.id, request);
  assert.equal(claimed.status, 'in_progress'); assert.deepEqual(claimed.assignee, { id: owner.user.id, displayName: owner.user.displayName });
  assert.deepEqual(await f.service.transition(owner, item.id, request), claimed);
  const closeInput = { revision: claimed.revision, requestId: randomUUID(), action: 'resolve', note: '  Lieferant mit Einkauf geklärt; Quellsystem separat aktualisieren.  ', confirmed: true };
  const resolved = await f.service.transition(owner, item.id, closeInput);
  assert.equal(resolved.status, 'resolved'); assert.equal(resolved.resolution, closeInput.note.trim());
  const reopened = await f.service.transition(owner, item.id, { revision: resolved.revision, requestId: randomUUID(), action: 'reopen', note: 'Neue Rückfrage eingegangen.', confirmed: true });
  assert.equal(reopened.status, 'open'); assert.equal(reopened.assignee, null); assert.equal(reopened.resolution, null);
  assert.equal(reopened.revision, 4); assert.deepEqual(reopened.events.map(event => event.kind), ['created', 'claimed', 'resolved', 'reopened']);
  assert.equal(reopened.events[2]!.note, closeInput.note.trim()); assert.deepEqual(reopened.evidence, item.evidence);
  assert.equal(reopened.evidenceHash, item.evidenceHash);
  assert.equal(await readFile(new FileMissionStore(f.root).path, 'utf8'), origin);
  assert.deepEqual(await f.start().get(owner, item.id), reopened);
  assert.deepEqual(await f.start().transition(owner, item.id, closeInput), reopened, 'receipt replays the current case without applying the earlier action again');
});

test('stale revisions, illegal transitions, missing notes and unconfirmed actions leave the case untouched', async t => {
  const f = await fixture(t); const { item } = await f.create();
  const action = { revision: item.revision, requestId: randomUUID(), action: 'resolve', confirmed: true, note: 'Bearbeitet' };
  await assert.rejects(f.service.transition(owner, item.id, action), status(409));
  const claimed = await f.service.transition(owner, item.id, { ...action, action: 'claim', note: undefined });
  const bytes = await readFile(f.store.path, 'utf8');
  for (const note of ['', '  ', 'x'.repeat(2001), 17, null]) {
    await assert.rejects(f.service.transition(owner, item.id, { ...action, revision: claimed.revision, note, requestId: randomUUID() }), status(400));
  }
  await assert.rejects(f.service.transition(owner, item.id, { ...action, requestId: randomUUID() }), status(409));
  await assert.rejects(f.service.transition(owner, item.id, { ...action, revision: claimed.revision, confirmed: false, requestId: randomUUID() }), status(400));
  await assert.rejects(f.service.transition(owner, item.id, { ...action, revision: claimed.revision, assignee: other.user, requestId: randomUUID() }), status(400));
  assert.equal(await readFile(f.store.path, 'utf8'), bytes);
});

test('own case scope and current case permissions are enforced independently of dataset permissions', async t => {
  const f = await fixture(t); const { item, input } = await f.create();
  for (const stranger of [other, foreign]) {
    assert.deepEqual(await f.service.list(stranger), []);
    await assert.rejects(f.service.get(stranger, item.id), status(404));
    await assert.rejects(f.service.preview(stranger, f.selection), status(404));
    await assert.rejects(f.service.transition(stranger, item.id, { revision: 1, requestId: randomUUID(), action: 'claim', confirmed: true }), status(404));
  }
  f.control.permissions = ['datasets.read', 'datasets.manage', 'cases.read'];
  assert.equal((await f.service.get(owner, item.id)).id, item.id);
  await assert.rejects(f.service.create(owner, input), status(403));
  await assert.rejects(f.service.transition(owner, item.id, { revision: 1, requestId: randomUUID(), action: 'claim', confirmed: true }), status(403));
  f.control.permissions = ['datasets.read', 'datasets.manage'];
  await assert.rejects(f.service.get(owner, item.id), status(403));
  f.control.allowed = false; await assert.rejects(f.service.list(owner), status(403));
});

test('revocation between evidence read and create commit preserves exact bytes and does not consume the request', async t => {
  const f = await fixture(t); await f.create();
  const selection = { ...f.selection, sourceRow: 1 }; const preview = await f.service.preview(owner, selection);
  const input = { ...selection, previewHash: preview.previewHash, confirmed: true, requestId: randomUUID() };
  const model = { ...f.semanticModel, async relationshipSnapshotForMission(...args: Parameters<typeof f.semanticModel.relationshipSnapshotForMission>) {
    const snapshot = await f.semanticModel.relationshipSnapshotForMission(...args); f.control.allowed = false; return snapshot;
  } };
  const service = f.start(model); const bytes = await readFile(f.store.path, 'utf8');
  await assert.rejects(service.create(owner, input), status(403)); assert.equal(await readFile(f.store.path, 'utf8'), bytes);
  f.control.allowed = true; const saved = await f.start().create(owner, input); assert.equal(saved.evidence.sourceRow, 1);
});

test('corrupt evidence, state-machine history, status and uniqueness index fail closed without rewriting storage', async t => {
  const f = await fixture(t); const { item } = await f.create(); const original = await readFile(f.store.path, 'utf8');
  const changes = [
    (state: any) => { state.cases[item.id].evidence.finding.Bestellung = 'Erfunden'; },
    (state: any) => { state.cases[item.id].status = 'resolved'; },
    (state: any) => { state.cases[item.id].events[0].actorId = other.user.id; },
    (state: any) => { state.findings = {}; },
    (state: any) => { state.cases[item.id].revision = 2; },
  ];
  for (const change of changes) {
    const value = JSON.parse(original); change(value); const corrupt = JSON.stringify(value); await writeFile(f.store.path, corrupt);
    await assert.rejects(f.service.get(owner, item.id));
    await assert.rejects(f.service.transition(owner, item.id, { revision: 1, requestId: randomUUID(), action: 'claim', confirmed: true }));
    assert.equal(await readFile(f.store.path, 'utf8'), corrupt);
  }
  await writeFile(f.store.path, original);
});

test('revocation immediately before a transition commit leaves event history and request receipt unchanged', async t => {
  const f = await fixture(t); const { item } = await f.create(); let resolutions = 0;
  const service = createCaseService({ root: f.root, semanticModel: f.semanticModel, ...f.authority,
    async resolvePrincipal(ref) { resolutions++; return resolutions === 1 ? f.authority.resolvePrincipal(ref) : null; } });
  const input = { revision: item.revision, requestId: randomUUID(), confirmed: true, action: 'claim' };
  const bytes = await readFile(f.store.path, 'utf8');
  await assert.rejects(service.transition(owner, item.id, input), status(403));
  assert.equal(await readFile(f.store.path, 'utf8'), bytes);
  const claimed = await f.service.transition(owner, item.id, input);
  assert.equal(claimed.status, 'in_progress'); assert.equal(claimed.events.length, 2);
});

test('HTTP cases expose explicit creation, action receipts, permission failures and protected listing', async t => {
  const f = await fixture(t); let session: SessionContext | undefined = owner; const app = Fastify();
  app.addHook('onRequest', async request => { request.koiforgeSession = session as SessionContext; });
  registerCaseRoutes(app, f.service); t.after(() => app.close());
  const preview = await app.inject({ method: 'POST', url: '/api/cases/preview', payload: f.selection });
  assert.equal(preview.statusCode, 200, preview.body);
  const response = await app.inject({ method: 'POST', url: '/api/cases', payload: { ...f.selection, previewHash: preview.json().previewHash, confirmed: true, requestId: randomUUID() } });
  assert.equal(response.statusCode, 201, response.body); const item = response.json().case;
  const transitioned = await app.inject({ method: 'POST', url: `/api/cases/${item.id}/transition`, payload: { revision: item.revision, requestId: randomUUID(), confirmed: true, action: 'claim' } });
  assert.equal(transitioned.statusCode, 200, transitioned.body); assert.equal(transitioned.json().case.status, 'in_progress');
  const page = await app.inject(`/api/cases/findings?missionId=${f.completed.id}&offset=100&limit=25`);
  assert.equal(page.statusCode, 200, page.body); assert.equal(page.json().items.length, 6);
  session = other; assert.equal((await app.inject(`/api/cases/${item.id}`)).statusCode, 404);
  session = { ...owner, permissions: ['datasets.read', 'cases.read'] };
  assert.equal((await app.inject(`/api/cases/${item.id}`)).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/cases/preview', payload: f.selection })).statusCode, 403);
  session = undefined; assert.equal((await app.inject('/api/cases')).statusCode, 401);
});
