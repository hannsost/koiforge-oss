import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { FileDatasetRegistry } from '@koiforge/data-registry';
import type { SessionContext } from '@koiforge/security-core';
import { ORDER_REVIEW_VERSION, reviewOrders } from '../src/domain/orders/review.js';
import type { ImportRow } from '../src/import-capability/isolated-executor.js';
import type { Mission, MissionRelationship } from '../src/missions/contracts.js';
import type { RoutineDefinition, RoutineSnapshot } from '../src/routines/contracts.js';
import { buildRoutineTemplate, computePreviewHash, prepareRoutine, validateRoutineDefinition } from '../src/routines/prepare.js';
import type { ObjectSet } from '../src/semantic-model/contracts.js';
import { createSemanticModelService } from '../src/semantic-model/service.js';

const owner: SessionContext = {
  user: { id: 'routines-reference-owner', displayName: 'Synthetic routine owner' },
  tenant: { id: 'routines-reference-firm', name: 'Synthetic reference firm', slug: 'routines-reference-firm', status: 'active' },
  roleIds: ['owner'], permissions: ['datasets.read', 'datasets.manage'],
};
const principal = { ownerId: owner.user.id, tenantId: owner.tenant.id };
const binding = { statusField: 'status', dueDateField: 'due' };
const orderRule = { openStatuses: ['offen'], closedStatuses: ['erledigt'], asOf: '2026-09-23',
  dueDateMeaning: 'promised_delivery_day' as const };
const originalRows: ImportRow[] = [
  { id: 'one', supplier: 'S', status: 'offen', due: '2026-09-20' },
  { id: 'two', supplier: 'S', status: 'offen', due: '2026-09-23' },
  { id: 'three', supplier: 'S', status: 'erledigt', due: 'invalid' },
  { id: 'four', supplier: 'S', status: 'offen', due: null },
];
// These literal expectations describe the business examples; they are not
// computed by a second implementation of the production classification rules.
const originalCounts = { sourceRows: 4, overdueRows: 1, openRows: 2, closedRows: 1,
  unassessableRows: 0, clarificationRows: 1, deadlineUnassessableRows: 1 };
const changedRows: ImportRow[] = [
  { id: 'one', supplier: 'S', status: 'offen', due: '2026-09-26' },
  { id: 'two', supplier: 'S', status: 'offen', due: '2026-09-23' },
  { id: 'three', supplier: 'S', status: 'erledigt', due: 'invalid' },
  { id: 'four', supplier: 'S', status: 'offen', due: null },
  { id: 'five', supplier: 'S', status: 'Wartet auf Freigabe', due: '2026-09-01' },
  { id: 'six', supplier: 'S', status: null, due: '2026-09-01' },
  { id: 'seven', supplier: 'S', status: 'offen', due: '2026-02-29' },
];

function missionRelationship(snapshot: RoutineSnapshot): MissionRelationship {
  const { relationship, from, to } = snapshot.detail;
  return { id: relationship.id, name: relationship.name, fromSetId: from.id, toSetId: to.id,
    fromName: from.name, toName: to.name, fromField: relationship.fromField, toField: to.keyField,
    fromRevision: from.revision, toRevision: to.revision, sourceHash: from.source.hash,
    targetHash: to.source.hash, fromSnapshotHash: from.snapshotHash, toSnapshotHash: to.snapshotHash,
    targetRows: to.source.rowCount };
}

function completedMission(snapshot: RoutineSnapshot): Mission {
  const relationship = missionRelationship(snapshot);
  const reviewed = reviewOrders(snapshot.detail, snapshot.fromRows, binding, orderRule);
  assert.deepEqual(reviewed.counts, originalCounts, 'origin business expectations are independent literals');
  const { ruleHash, ...result } = reviewed;
  const at = '2026-09-23T10:00:00.000Z';
  return {
    id: randomUUID(), ...principal, question: 'Welche offenen Bestellungen müssen wir klären?',
    datasetId: snapshot.detail.from.source.datasetId, relationshipId: relationship.id,
    status: 'completed', phase: 'execute', revision: 5, createdAt: at, updatedAt: at,
    source: structuredClone(snapshot.detail.from.source),
    plan: { capabilityId: 'order_review', capabilityVersion: ORDER_REVIEW_VERSION,
      summary: 'Bestätigte Statuswerte und zugesagte Liefertage prüfen.',
      steps: ['Bestätigte Bestellungen prüfen.'], limitations: ['Keine Lieferprognose.'],
      suggestedBinding: { ...binding }, orderKeyField: snapshot.detail.from.keyField,
      generation: { backend: 'codex', model: 'reference-origin', reasoningEffort: 'xhigh' }, relationship },
    input: { confirmed: true, binding: { ...binding }, orderRule: structuredClone(orderRule) },
    result: { ...result, capabilityId: 'order_review', evidence: {
      sourceHash: relationship.sourceHash, targetSourceHash: relationship.targetHash,
      fromSnapshotHash: relationship.fromSnapshotHash, toSnapshotHash: relationship.toSnapshotHash,
      capabilityVersion: ORDER_REVIEW_VERSION, executedAt: at, relationshipId: relationship.id,
      fromSetId: relationship.fromSetId, toSetId: relationship.toSetId, orderRuleHash: ruleHash,
    } },
    events: [{ at, status: 'completed', message: 'Synthetic completed reference.' }],
  };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'koi-routines-reference-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataset = new FileDatasetRegistry({ filePath: join(root, 'datasets.json') });
  const options = {
    root, registries: { dataset },
    async resolvePrincipal(reference: { userId: string; tenantId: string }) {
      return reference.userId === owner.user.id && reference.tenantId === owner.tenant.id ? structuredClone(owner) : null;
    },
    assertPermissions(session: SessionContext, permissions: string[]) {
      assert(permissions.every(permission => session.permissions.includes(permission)));
    },
  };
  const semantic = createSemanticModelService(options);
  let importedCount = 0;
  async function objectSet(name: string, rows: ImportRow[], keyField: string, previous?: ObjectSet) {
    const source = await dataset.registerInlineDataset({ name: `${name} source ${++importedCount}`,
      namespace: 'routines-reference', rows });
    return semantic.createObjectSet(owner, { name, datasetId: source.id, keyField,
      ...(previous ? { previousId: previous.id } : {}), confirmed: true, requestId: randomUUID() });
  }
  async function relationship(from: ObjectSet, to: ObjectSet, fromField = 'supplier') {
    const relation = await semantic.createRelationship(owner, {
      name: 'Lieferant der Bestellung', fromSetId: from.id, toSetId: to.id, fromField,
      confirmed: true, requestId: randomUUID(),
    });
    return semantic.relationshipSnapshotForMission(principal, relation.id);
  }
  const from = await objectSet('Bestellungen', originalRows, 'id');
  const to = await objectSet('Lieferanten', [{ id: 'S' }], 'id');
  const origin = await relationship(from, to);
  const mission = completedMission(origin);
  const routine: RoutineDefinition = { ...buildRoutineTemplate(mission, origin), id: randomUUID(),
    name: 'Offene Bestellungen prüfen', createdAt: '2026-09-23T10:01:00.000Z' };
  return { root, dataset, options, semantic, objectSet, relationship, from, to, origin, mission, routine };
}

test('independent new snapshot keeps confirmed rules and reports new unknown statuses, dates and complete count deltas', async t => {
  const f = await fixture(t);
  const untouched = structuredClone({ mission: f.mission, routine: f.routine, origin: f.origin });
  const from = await f.objectSet('Bestellungen', changedRows, 'id', f.from);
  const to = await f.objectSet('Lieferanten', [{ id: 'S' }, { id: 'T' }], 'id', f.to);
  const snapshot = await f.relationship(from, to);
  const preview = prepareRoutine(f.routine, snapshot, '2026-09-25');
  assert.equal(preview.ready, true, preview.blockingReasons.join('; '));
  assert.deepEqual(preview.previousCounts, originalCounts);
  assert.deepEqual(preview.newCounts, { sourceRows: 7, overdueRows: 1, openRows: 3, closedRows: 1,
    unassessableRows: 2, clarificationRows: 4, deadlineUnassessableRows: 2 });
  assert.deepEqual(preview.deltas, { sourceRows: 3, overdueRows: 0, openRows: 1, closedRows: 0,
    unassessableRows: 2, clarificationRows: 3, deadlineUnassessableRows: 1 });
  assert.equal(preview.statusProfile.totalRows, 7);
  assert.equal(preview.statusProfile.knownOpenRows, 4);
  assert.equal(preview.statusProfile.knownClosedRows, 1);
  assert.equal(preview.statusProfile.missingRows, 1);
  assert.deepEqual(preview.statusProfile.unknownValues, [{ value: 'Wartet auf Freigabe', count: 1 }]);
  assert.deepEqual(preview.binding, binding);
  assert.deepEqual(preview.orderRule, { ...orderRule, asOf: '2026-09-25' });
  assert.deepEqual(preview.changes.asOf, { previous: '2026-09-23', current: '2026-09-25', changed: true });
  assert.equal(preview.changes.from.previousRows, 4);
  assert.equal(preview.changes.from.rows, 7);
  assert.equal(preview.changes.to.rows, 2);
  assert.match(preview.previewHash!, /^[a-f0-9]{64}$/);
  assert.notEqual(preview.orderRuleHash, f.routine.baseline.orderRuleHash);
  assert.deepEqual({ mission: f.mission, routine: f.routine, origin: f.origin }, untouched);
});

test('each missing required column blocks reuse while individual missing values remain findings', async t => {
  for (const missing of ['status', 'due']) {
    const f = await fixture(t);
    const rows = originalRows.map(row => Object.fromEntries(Object.entries(row).filter(([field]) => field !== missing)));
    const from = await f.objectSet('Bestellungen', rows, 'id', f.from);
    const preview = prepareRoutine(f.routine, await f.relationship(from, f.to), '2026-09-25');
    assert.equal(preview.ready, false, `missing ${missing} must block`);
    assert(preview.blockingReasons.some(reason => reason.includes(missing)), `block identifies missing ${missing}`);
    assert.equal(preview.previewHash, undefined);
    assert.equal(preview.newCounts, undefined);
  }
});

test('same names cannot substitute unrelated order or supplier families', async t => {
  const f = await fixture(t);
  const foreignFrom = await f.objectSet(f.from.name, originalRows, 'id');
  const foreignTo = await f.objectSet(f.to.name, [{ id: 'S' }], 'id');
  assert.notEqual(foreignFrom.familyId, f.from.familyId);
  assert.notEqual(foreignTo.familyId, f.to.familyId);
  for (const [from, to] of [[foreignFrom, f.to], [f.from, foreignTo], [foreignFrom, foreignTo]]) {
    const preview = prepareRoutine(f.routine, await f.relationship(from!, to!), '2026-09-25');
    assert.equal(preview.ready, false);
    assert.match(preview.blockingReasons.join(' '), /Familie/i);
    assert.equal(preview.previewHash, undefined);
  }
});

test('same families do not authorize changing the order key, supplier key or reference field', async t => {
  for (const changed of ['orderKey', 'targetKey', 'referenceField']) {
    const f = await fixture(t);
    const rows = originalRows.map(row => ({ ...row, orderNumber: row.id!, vendor: row.supplier! }));
    const from = await f.objectSet('Bestellungen', rows, changed === 'orderKey' ? 'orderNumber' : 'id', f.from);
    const to = await f.objectSet('Lieferanten', [{ id: 'S', supplierNumber: 'S' }], changed === 'targetKey' ? 'supplierNumber' : 'id', f.to);
    const snapshot = await f.relationship(from, to, changed === 'referenceField' ? 'vendor' : 'supplier');
    const preview = prepareRoutine(f.routine, snapshot, '2026-09-25');
    assert.equal(from.familyId, f.from.familyId);
    assert.equal(to.familyId, f.to.familyId);
    assert.equal(preview.ready, false, `${changed} must block`);
    assert.equal(preview.changes[changed as 'orderKey' | 'targetKey' | 'referenceField'].changed, true);
    assert(preview.blockingReasons.length > 0);
    assert.equal(preview.previewHash, undefined);
  }
});

test('count changes compare different scopes and cannot assert a business cause', async t => {
  const f = await fixture(t);
  const later = prepareRoutine(f.routine, f.origin, '2026-09-25');
  const alternateRows = originalRows.map(row => row.id === 'two' ? { ...row, due: '2026-09-22' } : { ...row });
  const from = await f.objectSet('Bestellungen', alternateRows, 'id', f.from);
  const changedData = prepareRoutine(f.routine, await f.relationship(from, f.to), '2026-09-23');
  // Identical deltas arise either solely from time passing or solely from a
  // source value changing; neither delta establishes an operational cause.
  const expected = { sourceRows: 0, overdueRows: 1, openRows: -1, closedRows: 0,
    unassessableRows: 0, clarificationRows: 0, deadlineUnassessableRows: 0 };
  assert.deepEqual(later.deltas, expected);
  assert.deepEqual(changedData.deltas, expected);
  assert.equal(later.changes.asOf.changed, true);
  assert.equal(changedData.changes.asOf.changed, false);
  for (const preview of [later, changedData]) {
    assert.match(preview.warnings.join(' '), /Ursach|kausal/i);
    assert.notEqual(preview.previewHash, undefined);
  }
  assert.notEqual(later.previewHash, changedData.previewHash);
});

test('complete frozen source beyond 200 rows controls status profile and result counts', async t => {
  const f = await fixture(t);
  const rows: ImportRow[] = Array.from({ length: 225 }, (_, index) => ({
    id: `order-${index + 1}`, supplier: 'S', status: index === 224 ? 'Neuer Status nur in Zeile 225' : 'erledigt', due: '2026-09-01',
  }));
  const from = await f.objectSet('Bestellungen', rows, 'id', f.from);
  const snapshot = await f.relationship(from, f.to);
  const ordinary = await f.semantic.getRelationship(owner, snapshot.detail.relationship.id);
  assert.equal(ordinary.rows.length, 100);
  assert.equal(snapshot.detail.rows.length, 225);
  const preview = prepareRoutine(f.routine, snapshot, '2026-09-25');
  assert.equal(preview.ready, true);
  assert.deepEqual(preview.newCounts, { sourceRows: 225, overdueRows: 0, openRows: 0, closedRows: 224,
    unassessableRows: 1, clarificationRows: 1, deadlineUnassessableRows: 0 });
  assert.equal(preview.statusProfile.totalRows, 225);
  assert.equal(preview.statusProfile.knownClosedRows, 224);
  assert.deepEqual(preview.statusProfile.unknownValues, [{ value: 'Neuer Status nur in Zeile 225', count: 1 }]);
  const incomplete = prepareRoutine(f.routine, { ...snapshot, detail: ordinary }, '2026-09-25');
  assert.equal(incomplete.ready, false);
  assert.equal(incomplete.previewHash, undefined);
  assert.match(incomplete.blockingReasons.join(' '), /vollständig|unverändert|Stand|Beleg/i);
});

test('exact unknown status vocabulary stays separate from missing and non-text values', async t => {
  const f = await fixture(t);
  const statuses = ['offen', ' offen ', 'Offen', 'x'.repeat(201), null, ' ', false, 1];
  const from = await f.objectSet('Bestellungen', statuses.map((status, index) => ({
    id: `status-${index}`, supplier: 'S', status, due: '2026-09-25',
  })), 'id', f.from);
  const preview = prepareRoutine(f.routine, await f.relationship(from, f.to), '2026-09-25');
  assert.equal(preview.ready, true);
  assert.deepEqual(preview.newCounts, { sourceRows: 8, overdueRows: 0, openRows: 1, closedRows: 0,
    unassessableRows: 7, clarificationRows: 7, deadlineUnassessableRows: 0 });
  assert.equal(preview.statusProfile.knownOpenRows, 1);
  assert.equal(preview.statusProfile.missingRows, 2);
  assert.equal(preview.statusProfile.nonTextRows, 2);
  assert.equal(preview.statusProfile.unknownUniqueTotal, 3);
  assert(preview.statusProfile.unknownValues.some(entry => entry.value === ' offen '));
  assert(preview.statusProfile.unknownValues.some(entry => entry.value === 'Offen'));
  assert.deepEqual(preview.orderRule.openStatuses, ['offen']);
});

test('frozen routine preview survives live source deletion, replacement under the same ID and semantic restart', async t => {
  const f = await fixture(t);
  const originUnchanged = structuredClone(f.mission.result);
  const from = await f.objectSet('Bestellungen', changedRows, 'id', f.from);
  const snapshot = await f.relationship(from, f.to);
  const preview = prepareRoutine(f.routine, snapshot, '2026-09-25');
  await f.dataset.deleteDataset(from.source.datasetId);
  await f.dataset.deleteDataset(f.to.source.datasetId);
  const replacement = await f.dataset.registerInlineDataset({ name: from.source.name,
    namespace: 'routines-reference', rows: [{ id: 'replacement', status: 'erledigt' }] });
  assert.equal(replacement.id, from.source.datasetId);
  const restarted = createSemanticModelService(f.options);
  const frozen = await restarted.relationshipSnapshotForMission(principal, snapshot.detail.relationship.id);
  assert.deepEqual(frozen, snapshot);
  assert.deepEqual(prepareRoutine(f.routine, frozen, '2026-09-25'), preview);
  assert.deepEqual(f.mission.result, originUnchanged);
});

test('origin evidence tampering cannot silently become a reusable routine', async t => {
  const f = await fixture(t);
  for (const alter of [
    (mission: Mission) => { mission.result!.counts.overdueRows = 999; },
    (mission: Mission) => { mission.result!.evidence.orderRuleHash = '0'.repeat(64); },
    (mission: Mission) => { mission.result!.evidence.targetSourceHash = '0'.repeat(64); },
    (mission: Mission) => { mission.plan!.relationship!.fromSnapshotHash = '0'.repeat(64); },
    (mission: Mission) => { mission.ownerId = 'different-owner'; },
  ]) {
    const changed = structuredClone(f.mission);
    alter(changed);
    assert.throws(() => buildRoutineTemplate(changed, f.origin));
  }
  const tampered = structuredClone(f.routine);
  tampered.orderRule.closedStatuses = ['offen'];
  assert.throws(() => validateRoutineDefinition(tampered));
  assert.deepEqual(f.mission.result!.counts, originalCounts);
});

test('approval hash distinguishes routine provenance, relationship identities, target evidence and date', async t => {
  const f = await fixture(t);
  const base = prepareRoutine(f.routine, f.origin, '2026-09-25');
  assert.equal(base.ready, true);
  // A second explicitly confirmed relationship may point to identical immutable
  // sets. Its confirmation identity must still be part of this approval.
  const otherRelationship = await f.relationship(f.from, f.to);
  assert.equal(otherRelationship.detail.from.source.hash, f.origin.detail.from.source.hash);
  assert.notEqual(prepareRoutine(f.routine, otherRelationship, '2026-09-25').previewHash, base.previewHash);
  const to = await f.objectSet('Lieferanten', [{ id: 'S', note: 'new supplier evidence' }], 'id', f.to);
  const targetChange = prepareRoutine(f.routine, await f.relationship(f.from, to), '2026-09-25');
  assert.deepEqual(targetChange.newCounts, base.newCounts, 'unchanged findings still require the new target evidence');
  assert.notEqual(targetChange.previewHash, base.previewHash);
  assert.notEqual(prepareRoutine(f.routine, f.origin, '2026-09-26').previewHash, base.previewHash);
  assert.notEqual(prepareRoutine({ ...f.routine, id: randomUUID() }, f.origin, '2026-09-25').previewHash, base.previewHash);
  assert.notEqual(prepareRoutine({ ...f.routine, sourceMissionId: randomUUID() }, f.origin, '2026-09-25').previewHash, base.previewHash);
  const { previewHash, ...content } = base;
  const reordered = Object.fromEntries(Object.entries(content).reverse()) as typeof content;
  assert.equal(computePreviewHash(f.routine, reordered), previewHash, 'object property insertion order does not change the approval');
});
