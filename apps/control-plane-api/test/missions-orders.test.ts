import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import Fastify from 'fastify';
import { FileDatasetRegistry } from '@koiforge/data-registry';
import type { SessionContext } from '@koiforge/security-core';
import type { ImportRow } from '../src/import-capability/isolated-executor.js';
import type { Mission, MissionEngine } from '../src/missions/contracts.js';
import { createMissionEngine } from '../src/missions/engine.js';
import { createMissionService, MissionServiceError, type MissionService } from '../src/missions/service.js';
import { registerMissionRoutes } from '../src/routes/missions.js';
import { createSemanticModelService } from '../src/semantic-model/service.js';
import type { AppRegistries } from '../src/registries.js';

const owner: SessionContext = { user: { id: 'orders-owner', displayName: 'Owner' },
  tenant: { id: 'orders-firm', name: 'Firma', slug: 'orders-firm', status: 'active' }, roleIds: ['owner'],
  permissions: ['datasets.read', 'datasets.manage'] };
const binding = { statusField: 'status', dueDateField: 'due' };
const orderRule = { openStatuses: ['offen', 'teilgeliefert'], closedStatuses: ['erledigt'],
  asOf: '2026-09-23', dueDateMeaning: 'promised_delivery_day' as const };
async function fixture(t: TestContext, supplied?: ImportRow[]) {
  const root = await mkdtemp(join(tmpdir(), 'koi-orders-missions-'));
  const services: MissionService[] = [];
  t.after(async () => { for (const s of services) { await s.close(); await s.whenIdle(); } await rm(root, { recursive: true, force: true }); });
  const dataset = new FileDatasetRegistry({ filePath: join(root, 'datasets.json') });
  const auth = { allowed: true };
  const authority = { async resolvePrincipal(ref: { userId: string; tenantId: string }) {
    return auth.allowed && ref.userId === owner.user.id && ref.tenantId === owner.tenant.id ? structuredClone(owner) : null;
  }, assertPermissions(session: SessionContext, permissions: string[]) { assert(permissions.every(p => session.permissions.includes(p))); } };
  const options = { root, registries: { dataset }, ...authority };
  const semanticModel = createSemanticModelService(options);
  const sourceRows = supplied ?? [
    ...Array.from({ length: 202 }, (_, i) => ({ id: `PRIVATE-${i}`, supplier: 'S', status: 'erledigt', due: 'bad' })),
    { id: 'late', supplier: 'S', status: 'teilgeliefert', due: '2026-09-21' },
    { id: 'today', supplier: 'S', status: 'offen', due: '2026-09-23' },
    { id: 'no-date', supplier: 'U', status: 'offen', due: null },
    { id: 'unknown', supplier: 'S', status: 'PRIVATE-UNKNOWN', due: '2026-01-01' },
  ];
  const source = await dataset.registerInlineDataset({ name: 'orders', namespace: 'orders-test', rows: sourceRows });
  const target = await dataset.registerInlineDataset({ name: 'suppliers', namespace: 'orders-test', rows: [{ id: 'S', name: 'PRIVATE SUPPLIER' }] });
  const from = await semanticModel.createObjectSet(owner, { name: 'Bestellungen', datasetId: source.id, keyField: 'id', confirmed: true, requestId: randomUUID() });
  const to = await semanticModel.createObjectSet(owner, { name: 'Lieferanten', datasetId: target.id, keyField: 'id', labelField: 'name', confirmed: true, requestId: randomUUID() });
  const relationship = await semanticModel.createRelationship(owner, { name: 'Bestellung gehört zu Lieferant', fromSetId: from.id,
    toSetId: to.id, fromField: 'supplier', confirmed: true, requestId: randomUUID() });
  const proposed: Record<string, unknown> = { capabilityId: 'order_review', summary: 'Offene Bestellungen anhand bestätigter Status und Lieferkalendertage klären.', suggestedBinding: binding };
  const prompts: string[] = [];
  const generator = { backend: 'codex' as const, model: 'fixture', reasoningEffort: 'xhigh', async status() { return { available: true, backend: 'codex' as const, model: 'fixture', reasoningEffort: 'xhigh' }; },
    async generate(_system: string, prompt: string) { prompts.push(prompt); return JSON.stringify(proposed); } };
  const registries = { dataset } as AppRegistries;
  const engine = createMissionEngine(root, registries, { generator, semanticModel });
  const createInput = { question: 'Welche offenen Bestellungen müssen wir klären?', datasetId: source.id,
    relationshipId: relationship.id, requestId: randomUUID() };
  const mission: Mission = { ...createInput, id: randomUUID(), ownerId: owner.user.id, tenantId: owner.tenant.id,
    status: 'planning', phase: 'plan', revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events: [] };
  async function service(using = engine) { const s = await createMissionService({ root, engine: using, ...authority }); services.push(s); return s; }
  async function planned() { Object.assign(mission, await engine.plan(mission)); return mission; }
  return { root, dataset, auth, authority, options, semanticModel, source, target, from, to, relationship, sourceRows,
    proposed, prompts, generator, engine, createInput, mission, service, planned };
}

test('order planning exposes schemas and confirmed identities but no statuses, rows or findings', async t => {
  const f = await fixture(t); await f.planned();
  assert.equal(f.mission.plan!.capabilityId, 'order_review');
  assert.equal(f.mission.plan!.orderKeyField, 'id');
  assert.deepEqual(f.mission.plan!.suggestedBinding, binding);
  assert.doesNotMatch(f.prompts[0]!, /PRIVATE|teilgeliefert|erledigt|linkedRows|missingReferences/);
  f.proposed.suggestedBinding = { statusField: 'invented' };
  await assert.rejects(f.planned(), /nicht vorhandene/);
  f.proposed.suggestedBinding = { keyField: 'id' };
  await assert.rejects(f.planned(), /ausgewählten Fähigkeit/);
  delete f.mission.relationshipId;
  delete f.mission.source; delete f.mission.plan; f.mission.id = randomUUID();
  await assert.rejects(f.planned(), /nicht verfügbare Fähigkeit/);
});

test('confirmed order rules execute over every frozen source row after deletion, replacement and restart', async t => {
  const f = await fixture(t); let service = await f.service();
  const created = await service.create(owner, f.createInput); await service.whenIdle();
  const planned = await service.get(owner, created.id);
  const profile = await service.orderStatuses(owner, created.id, 'status');
  assert.equal(profile.totalRows, 206); assert.equal(profile.values.find(v => v.value === 'erledigt')!.count, 202);
  const run = { confirmed: true, binding, orderRule, revision: planned.revision, requestId: randomUUID() };
  await service.close();
  await f.dataset.deleteDataset(f.source.id); await f.dataset.deleteDataset(f.target.id);
  const replacement = await f.dataset.registerInlineDataset({ name: 'orders', namespace: 'orders-test', rows: [{ id: 'changed', status: 'CHANGED' }] });
  assert.equal(replacement.id, f.source.id);
  const engine = createMissionEngine(f.root, { dataset: f.dataset } as AppRegistries, { generator: f.generator, semanticModel: createSemanticModelService(f.options) });
  service = await f.service(engine);
  assert.deepEqual(await service.orderStatuses(owner, created.id, 'status'), profile);
  await service.run(owner, created.id, run); await service.whenIdle();
  const completed = await service.get(owner, created.id);
  assert.equal(completed.status, 'completed', completed.error);
  assert.deepEqual(completed.result!.counts, { sourceRows: 206, overdueRows: 1, openRows: 2, closedRows: 202,
    unassessableRows: 1, clarificationRows: 2, deadlineUnassessableRows: 1 });
  assert.equal(completed.result!.rows[0]!.Quellzeile, 203, 'priority must consider source rows beyond the prior 100/200 row previews');
  assert.equal(completed.result!.rows[0]!.Befund, 'Überfällig');
  assert.equal(completed.result!.rows[1]!.Quellzeile, 206);
  assert.equal(completed.result!.rows.length, 100); assert.equal(completed.result!.totalRows, 206); assert.equal(completed.result!.truncated, true);
  assert.equal(completed.result!.evidence.fromSnapshotHash, f.from.snapshotHash);
  assert.equal(completed.result!.evidence.toSnapshotHash, f.to.snapshotHash);
  assert.equal(completed.result!.evidence.targetSourceHash, f.to.source.hash);
  assert.match(completed.result!.evidence.orderRuleHash!, /^[a-f0-9]{64}$/);
  await service.close(); service = await f.service(engine);
  assert.deepEqual((await service.get(owner, created.id)).result, completed.result);
  assert.equal((await service.run(owner, created.id, run)).id, created.id);
  assert.equal((await service.create(owner, f.createInput)).id, created.id);
  assert.equal(f.prompts.length, 1);
  await assert.rejects(service.run(owner, created.id, { ...run, orderRule: { ...orderRule, asOf: '2026-09-24' } }),
    e => e instanceof MissionServiceError && e.statusCode === 409);
});

test('order confirmation rejects missing meaning, conflicting status mappings, unrelated rules and capability drift', async t => {
  const f = await fixture(t); await f.planned();
  const valid = { confirmed: true, binding, orderRule };
  assert.deepEqual(f.engine.validateRun(f.mission, valid).orderRule, orderRule);
  for (const invalid of [{ ...valid, confirmed: false }, { ...valid, orderRule: undefined }, { ...valid, rule: {} },
    { ...valid, binding: { ...binding, keyField: 'id' } },
    { ...valid, orderRule: { ...orderRule, closedStatuses: ['offen'] } },
    { ...valid, orderRule: { ...orderRule, dueDateMeaning: 'invoice_day' } },
    { ...valid, orderRule: { ...orderRule, asOf: '2026-02-29' } }]) {
    assert.throws(() => f.engine.validateRun(f.mission, invalid));
  }
  f.mission.plan!.capabilityVersion = 'order-review-v999';
  await assert.rejects(f.engine.execute(f.mission, valid), /Fähigkeitsversion/);
});

test('status profiles preserve exact values, bound strings/counts and require current ownership/permissions over HTTP', async t => {
  const rows: ImportRow[] = [...Array.from({ length: 120 }, (_, i) => ({ id: i, supplier: 'S', status: `s${i}` })),
    { id: 120, supplier: 'S', status: ' offen ' }, { id: 121, supplier: 'S', status: 'offen' },
    { id: 122, supplier: 'S', status: 'offen' }, { id: 123, supplier: 'S', status: 1 },
    { id: 124, supplier: 'S', status: ' ' }, { id: 125, supplier: 'S', status: null },
    { id: 126, supplier: 'S', status: 'x'.repeat(201) }];
  const f = await fixture(t, rows); f.proposed.suggestedBinding = { statusField: 'status' };
  const service = await f.service(); const created = await service.create(owner, f.createInput); await service.whenIdle();
  const app = Fastify(); t.after(() => app.close());
  let session: SessionContext | undefined = owner;
  app.addHook('onRequest', async request => { request.koiforgeSession = session as SessionContext; });
  registerMissionRoutes(app, service);
  const url = `/api/missions/${created.id}/order-statuses?field=status`;
  const response = await app.inject(url); assert.equal(response.statusCode, 200, response.body);
  const profile = response.json();
  assert.equal(profile.totalRows, 127); assert.equal(profile.missingRows, 2); assert.equal(profile.nonTextRows, 1);
  assert.equal(profile.unassignableRows, 1); assert.equal(profile.uniqueTotal, 123);
  assert.equal(profile.values.length, 100); assert.equal(profile.truncated, true);
  assert.deepEqual(profile.values[0], { value: 'offen', count: 2 });
  assert(profile.values.some((v: { value: string }) => v.value === ' offen '));
  assert(profile.values.every((v: { value: string }) => v.value.length <= 200));
  assert.equal((await app.inject(url + '&extra=1')).statusCode, 400);
  assert.equal((await app.inject(url.replace('status', 'invented'))).statusCode, 404);
  assert.equal((await app.inject(`/api/missions/${created.id}/order-statuses?field=missing`)).statusCode, 400);
  session = { ...owner, user: { id: 'other-owner', displayName: 'Other' } };
  assert.equal((await app.inject(url)).statusCode, 404);
  session = { ...owner, permissions: ['datasets.read'] }; assert.equal((await app.inject(url)).statusCode, 403);
  session = undefined; assert.equal((await app.inject(url)).statusCode, 401);
  session = owner; f.auth.allowed = false; assert.equal((await app.inject(url)).statusCode, 403);
});

test('changed frozen semantics are rejected by execution and status lookup', async t => {
  const f = await fixture(t); await f.planned();
  const original = structuredClone(f.mission);
  for (const mutate of [(m: Mission) => { m.plan!.orderKeyField = 'supplier'; },
    (m: Mission) => { m.plan!.relationship!.toSnapshotHash = 'c'.repeat(64); },
    (m: Mission) => { m.source!.columns = ['id', 'supplier', 'status', 'due', 'invented']; }]) {
    const m = structuredClone(original); mutate(m);
    await assert.rejects(f.engine.execute(m, { confirmed: true, binding, orderRule }), /festgehaltenen Auftragsplan/);
    await assert.rejects(f.engine.orderStatuses!(m, 'status'), /festgehaltenen Auftragsplan/);
  }
  f.auth.allowed = false;
  await assert.rejects(f.engine.execute(original, { confirmed: true, binding, orderRule }), /berechtigung/);
});

test('a worker cannot publish a result with a different order rule or target receipt', async t => {
  for (const wrong of ['orderRuleHash', 'targetSourceHash'] as const) {
    const f = await fixture(t);
    const engine: MissionEngine = { ...f.engine, async execute(m, input) {
      const result = await f.engine.execute(m, input); result.evidence[wrong] = 'c'.repeat(64); return result;
    } };
    const service = await f.service(engine); const created = await service.create(owner, f.createInput); await service.whenIdle();
    const m = await service.get(owner, created.id);
    await service.run(owner, created.id, { confirmed: true, binding, orderRule, revision: m.revision, requestId: randomUUID() });
    await service.whenIdle(); const blocked = await service.get(owner, created.id);
    assert.equal(blocked.status, 'blocked'); assert.equal(blocked.result, undefined);
    assert.match(blocked.error!, wrong === 'orderRuleHash' ? /Status- und Terminregel/ : /bestätigten Objektmengen/);
  }
});
