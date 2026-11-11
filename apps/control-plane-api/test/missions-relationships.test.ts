import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionContext } from '@koiforge/security-core';
import type { AppRegistries } from '../src/registries.js';
import type { Mission } from '../src/missions/contracts.js';
import type { ObjectSet, RelationshipDetail } from '../src/semantic-model/contracts.js';
import { createMissionEngine } from '../src/missions/engine.js';
import { createMissionService, MissionServiceError } from '../src/missions/service.js';

const owner: SessionContext = { user: { id: 'model-owner', displayName: 'Owner' },
  tenant: { id: 'firm-model', name: 'Firma', slug: 'firm-model', status: 'active' }, roleIds: ['owner'],
  permissions: ['datasets.read', 'datasets.manage'] };
const metadata = { backend: 'codex' as const, model: 'gpt-6-astra', reasoningEffort: 'xhigh' };
function objectSet(name: string, count: number, digest: string): ObjectSet {
  const id = randomUUID();
  return { id, familyId: id, revision: 1, tenantId: owner.tenant.id, ownerId: owner.user.id,
    name, keyField: 'id', createdAt: '2026-09-23T12:00:00Z', confirmedBy: owner.user.id,
    snapshotHash: digest.repeat(64),
    source: { datasetId: name, name, columns: ['id', 'supplier'], rowCount: count, hash: digest.repeat(64),
      capturedAt: '2026-09-23T12:00:00Z', coverage: 'complete' },
    keyQuality: { totalRows: count, identifiedRows: count, missingKeys: 0, duplicateRows: 0, duplicateGroups: 0 } };
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'koi-mission-relationship-'));
  const cleanups: Array<() => Promise<void>> = [];
  t.after(async () => {
    // Stop any restarted service before deleting files its worker may still use.
    for (const cleanup of cleanups) await cleanup();
    await rm(root, { recursive: true, force: true });
  });
  const from = objectSet('Bestellungen', 252, 'a'); const to = objectSet('Lieferanten', 3, 'b');
  const detail: RelationshipDetail = {
    from, to, relationship: { id: randomUUID(), tenantId: owner.tenant.id, ownerId: owner.user.id,
      name: 'Bestellung gehört zu Lieferant', fromSetId: from.id, toSetId: to.id, fromField: 'supplier',
      createdAt: '2026-09-23T12:00:00Z', confirmedBy: owner.user.id, cardinality: 'many-to-one', contractVersion: 'relationship-v1',
      counts: { sourceRows: 252, linkedRows: 248, missingReferences: 1, unmatchedReferences: 1, ambiguousReferences: 1, invalidSourceRows: 1 },
      evidence: { sourceHash: from.source.hash, targetHash: to.source.hash, fromRevision: 1, toRevision: 1 } },
    rows: Array.from({ length: 100 }, (_, i) => ({ sourceRow: i + 1, sourceKey: `PRIVATE-ORDER-${i}`,
      reference: 'PRIVATE-SUPPLIER', status: 'linked' as const, targetRows: [1], targetRowCount: 1,
      targetRowsTruncated: false, sourceLabel: `PRIVATE-LABEL-${i}`, targetLabel: 'PRIVATE-TARGET' })),
    totalRows: 252, truncated: true, offset: 0,
  };
  const proposed: Record<string, unknown> = { capabilityId: 'relationship_integrity',
    summary: 'Die bestätigte Beziehung auf fehlende und mehrdeutige Verweise prüfen.', suggestedBinding: {}, unsupportedReason: null };
  const prompts: string[] = []; const authority = { allowed: true };
  const generator = { ...metadata, async status() { return { ...metadata, available: true }; },
    async generate(_system: string, input: string) { prompts.push(input); return JSON.stringify(proposed); } };
  const semanticModel = { async relationshipForMission(principal: { tenantId: string; ownerId: string }, id: string) {
    assert.deepEqual(principal, { tenantId: owner.tenant.id, ownerId: owner.user.id });
    assert.equal(id, detail.relationship.id);
    if (!authority.allowed) throw new Error('Keine aktuelle Berechtigung.');
    return structuredClone(detail);
  } };
  // A relationship mission must never reinterpret or reread the current dataset.
  const registries = { dataset: { async getDataset() { throw new Error('Live dataset must not be read'); } } } as unknown as AppRegistries;
  const engine = createMissionEngine(root, registries, { generator, semanticModel });
  const mission: Mission = { id: randomUUID(), ownerId: owner.user.id, tenantId: owner.tenant.id,
    datasetId: from.source.datasetId, relationshipId: detail.relationship.id, question: 'Welche Zuordnungen fehlen?',
    revision: 1, status: 'planning', phase: 'plan', events: [], createdAt: '2026-09-23T12:00:00Z', updatedAt: '2026-09-23T12:00:00Z' };
  const plan = async () => { Object.assign(mission, await engine.plan(mission)); };
  return { root, detail, proposed, prompts, authority, engine, mission, plan,
    cleanup: (action: () => Promise<void>) => { cleanups.push(action); } };
}

test('relationship planning exposes confirmed semantics and schemas, never private source rows or findings', async t => {
  const f = await fixture(t); await f.plan();
  assert.doesNotMatch(f.prompts[0]!, /PRIVATE|linkedRows|missingReferences/);
  const prompt = JSON.parse(f.prompts[0]!);
  assert.deepEqual(prompt.capabilities.map((c: { id: string }) => c.id), ['relationship_integrity', 'order_review']);
  assert.equal(prompt.relationship.fromName, 'Bestellungen');
  assert.equal(prompt.relationship.toField, 'id');
  assert.equal(f.mission.plan!.relationship!.fromSnapshotHash, f.detail.from.snapshotHash);
  assert.equal(f.mission.plan!.relationship!.toSnapshotHash, f.detail.to.snapshotHash);
  assert.deepEqual(f.mission.plan!.generation, metadata);
});

test('relationship result preserves complete counts, bounded examples and both fixed semantic/source receipts', async t => {
  const f = await fixture(t); await f.plan();
  const result = await f.engine.execute(f.mission, { confirmed: true, binding: {} });
  assert.equal(result.counts.sourceRows, 252); assert.equal(result.counts.linkedRows, 248);
  assert.equal(result.counts.ambiguousReferences, 1); assert.equal(result.counts.invalidSourceRows, 1);
  assert.equal(result.rows.length, 100); assert.equal(result.totalRows, 252); assert.equal(result.truncated, true);
  assert.equal(result.rows[0]!.Befund, 'Eindeutig zugeordnet');
  assert.deepEqual(result.evidence, { sourceHash: f.detail.from.source.hash, targetSourceHash: f.detail.to.source.hash,
    fromSnapshotHash: f.detail.from.snapshotHash, toSnapshotHash: f.detail.to.snapshotHash,
    capabilityVersion: 'relationship-integrity-v1', executedAt: result.evidence.executedAt,
    relationshipId: f.detail.relationship.id, fromSetId: f.detail.from.id, toSetId: f.detail.to.id });
});

test('relationship confirmation cannot replace a field, rule or capability version', async t => {
  const f = await fixture(t); await f.plan();
  assert.throws(() => f.engine.validateRun(f.mission, { confirmed: false, binding: {} }), /ausdrücklich/);
  assert.throws(() => f.engine.validateRun(f.mission, { confirmed: true, binding: { keyField: 'id' } }), /unveränderten/);
  assert.throws(() => f.engine.validateRun(f.mission, { confirmed: true, binding: {}, rule: {} }), /unveränderten/);
  f.mission.plan!.capabilityVersion = 'relationship-integrity-v999';
  await assert.rejects(f.engine.execute(f.mission, { confirmed: true, binding: {} }), /Fähigkeitsversion/);
});

test('relationship-bound planner rejects a nearby capability and invented mappings; unsupported stays blocked', async t => {
  const f = await fixture(t);
  f.proposed.capabilityId = 'data_quality'; await assert.rejects(f.plan(), /nicht verfügbare/);
  f.proposed.capabilityId = 'relationship_integrity'; f.proposed.suggestedBinding = { keyField: 'id' };
  await assert.rejects(f.plan(), /bereits bestätigte/);
  Object.assign(f.proposed, { capabilityId: null, suggestedBinding: {}, unsupportedReason: 'Lieferprognosen sind nicht verfügbar.' });
  await f.plan(); assert.equal(f.mission.plan!.capabilityId, null);
  assert.throws(() => f.engine.validateRun(f.mission, { confirmed: true, binding: {} }), /Kein bestätigbarer/);
});

test('source metadata, semantic snapshot and target endpoint drift are rejected before a result is produced', async t => {
  const f = await fixture(t); await f.plan();
  const original = structuredClone(f.mission);
  f.mission.source!.rowCount = 999;
  await assert.rejects(f.engine.execute(f.mission, { confirmed: true, binding: {} }), /festgehaltenen Auftragsplan/);
  Object.assign(f.mission, structuredClone(original)); f.mission.source!.columns = ['tampered'];
  await assert.rejects(f.engine.execute(f.mission, { confirmed: true, binding: {} }), /festgehaltenen Auftragsplan/);
  Object.assign(f.mission, structuredClone(original)); f.detail.to.snapshotHash = 'c'.repeat(64);
  await assert.rejects(f.engine.execute(f.mission, { confirmed: true, binding: {} }), /festgehaltenen Auftragsplan/);
  f.detail.to.snapshotHash = original.plan!.relationship!.toSnapshotHash; f.detail.to.id = randomUUID();
  await assert.rejects(f.engine.execute(f.mission, { confirmed: true, binding: {} }), /Quellenbeleg/);
});

test('current model permissions and complete count accounting are rechecked at execution', async t => {
  const f = await fixture(t); await f.plan(); f.authority.allowed = false;
  await assert.rejects(f.engine.execute(f.mission, { confirmed: true, binding: {} }), /Berechtigung/);
  f.authority.allowed = true; f.detail.relationship.counts.linkedRows++;
  await assert.rejects(f.engine.execute(f.mission, { confirmed: true, binding: {} }), /nicht vollständig/);
});

test('relationship context survives durable acceptance, execution, restart and idempotent replay', async t => {
  const f = await fixture(t);
  const options = { root: f.root, engine: f.engine, resolvePrincipal: async () => structuredClone(owner),
    assertPermissions(session: SessionContext, permissions: string[]) { assert(permissions.every(p => session.permissions.includes(p))); } };
  let service = await createMissionService(options);
  f.cleanup(() => service.close());
  const input = { datasetId: f.mission.datasetId, question: f.mission.question,
    relationshipId: f.mission.relationshipId, requestId: randomUUID() };
  const created = await service.create(owner, input); await service.whenIdle();
  const planned = await service.get(owner, created.id);
  assert.equal(planned.status, 'awaiting_confirmation');
  await assert.rejects(service.create(owner, { ...input, relationshipId: randomUUID() }),
    e => e instanceof MissionServiceError && e.statusCode === 409);
  const run = { revision: planned.revision, requestId: randomUUID(), confirmed: true, binding: {} };
  await service.run(owner, created.id, run); await service.whenIdle();
  const completed = await service.get(owner, created.id); assert.equal(completed.status, 'completed');
  await service.close(); service = await createMissionService(options);
  assert.deepEqual((await service.get(owner, created.id)).result, completed.result);
  assert.equal((await service.create(owner, input)).id, created.id);
  assert.equal((await service.run(owner, created.id, run)).id, created.id);
  assert.equal(f.prompts.length, 1);
});

test('a wrong target receipt returned by a worker never becomes a completed mission', async t => {
  const f = await fixture(t);
  const engine = { ...f.engine, async execute(...args: Parameters<typeof f.engine.execute>) {
    const result = await f.engine.execute(...args); result.evidence.targetSourceHash = 'c'.repeat(64); return result;
  } };
  const service = await createMissionService({ root: f.root, engine, resolvePrincipal: async () => owner, assertPermissions() {} });
  f.cleanup(() => service.close());
  const created = await service.create(owner, { datasetId: f.mission.datasetId, question: f.mission.question,
    relationshipId: f.mission.relationshipId, requestId: randomUUID() });
  await service.whenIdle(); const planned = await service.get(owner, created.id);
  await service.run(owner, created.id, { revision: planned.revision, requestId: randomUUID(), confirmed: true, binding: {} });
  await service.whenIdle(); const result = await service.get(owner, created.id);
  assert.equal(result.status, 'blocked'); assert.equal(result.result, undefined);
  assert.match(result.error!, /bestätigten Objektmengen/);
});
