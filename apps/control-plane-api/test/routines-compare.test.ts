import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ORDER_REVIEW_VERSION, reviewOrders, type OrderReviewRule } from '../src/domain/orders/review.js';
import { rowsHash, type ImportRow } from '../src/import-capability/isolated-executor.js';
import type { Mission, MissionRelationship } from '../src/missions/contracts.js';
import type { ObjectSet, RelationshipDetail, RelationshipRow, SemanticPrimitive } from '../src/semantic-model/contracts.js';
import { buildRoutineTemplate, prepareRoutine } from '../src/routines/prepare.js';
import type { RoutineDefinition, RoutineSnapshot } from '../src/routines/contracts.js';
import { compareRoutineRuns } from '../src/routines/compare.js';

const at = '2026-09-23T12:00:00.000Z';
const binding = { statusField: 'status', dueDateField: 'due' };
const rule: OrderReviewRule = { openStatuses: ['Offen', 'In Bearbeitung'], closedStatuses: ['Erledigt', 'Abgeschlossen'], asOf: '2026-09-23', dueDateMeaning: 'promised_delivery_day' };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const primitive = (value: unknown): SemanticPrimitive | null => value === null || value === undefined
  || (typeof value === 'string' && value.trim() === '') ? null : value as SemanticPrimitive;
const row = (key: SemanticPrimitive | null, status: string, due = '2026-09-22'): ImportRow =>
  ({ id: key, supplier: 'L1', status, due });

function snapshot(rows: ImportRow[], revision: number): RoutineSnapshot {
  const columns = ['id', 'supplier', 'status', 'due'];
  const from: ObjectSet = {
    id: id(100 + revision), familyId: id(1), revision, tenantId: 'tenant', ownerId: 'owner', name: 'Bestellungen', keyField: 'id',
    source: { datasetId: `orders-${revision}`, name: 'Bestellungen', columns, rowCount: rows.length, hash: rowsHash(rows), capturedAt: at, coverage: 'complete' },
    snapshotHash: createHash('sha256').update(JSON.stringify({ revision, rows })).digest('hex'), createdAt: at, confirmedBy: 'owner',
    keyQuality: { totalRows: rows.length, identifiedRows: rows.filter(item => primitive(item.id) !== null).length, missingKeys: 0, duplicateRows: 0, duplicateGroups: 0 },
  };
  const toRows = [{ id: 'L1' }];
  const to: ObjectSet = {
    id: id(200 + revision), familyId: id(2), revision, tenantId: 'tenant', ownerId: 'owner', name: 'Lieferanten', keyField: 'id',
    source: { datasetId: `suppliers-${revision}`, name: 'Lieferanten', columns: ['id'], rowCount: 1, hash: rowsHash(toRows), capturedAt: at, coverage: 'complete' },
    snapshotHash: createHash('sha256').update(JSON.stringify({ revision, toRows })).digest('hex'), createdAt: at, confirmedBy: 'owner',
    keyQuality: { totalRows: 1, identifiedRows: 1, missingKeys: 0, duplicateRows: 0, duplicateGroups: 0 },
  };
  const keyCounts = new Map<string, number>();
  for (const item of rows) { const key = primitive(item.id); if (key !== null) keyCounts.set(JSON.stringify(key), (keyCounts.get(JSON.stringify(key)) ?? 0) + 1); }
  const relationships: RelationshipRow[] = rows.map((item, index) => {
    const key = primitive(item.id); const invalid = key === null || (keyCounts.get(JSON.stringify(key)) ?? 0) !== 1;
    const label = key === null ? 'Bestellung ohne ID' : `Bestellung ${JSON.stringify(key)}`;
    return { sourceRow: index + 1, sourceKey: key, reference: 'L1', status: invalid ? 'invalid_source_key' : 'linked',
      targetRows: invalid ? [] : [1], targetRowCount: invalid ? 0 : 1, targetRowsTruncated: false, sourceLabel: label, ...(invalid ? {} : { targetLabel: 'L1' }) };
  });
  const linkedRows = relationships.filter(item => item.status === 'linked').length;
  const relationship = { id: id(300 + revision), tenantId: 'tenant', ownerId: 'owner', name: 'Bestellung hat Lieferant', fromSetId: from.id, toSetId: to.id,
    fromField: 'supplier', createdAt: at, confirmedBy: 'owner', cardinality: 'many-to-one' as const, contractVersion: 'relationship-v1' as const,
    evidence: { sourceHash: from.source.hash, targetHash: to.source.hash, fromRevision: revision, toRevision: revision },
    counts: { sourceRows: rows.length, linkedRows, missingReferences: 0, unmatchedReferences: 0, ambiguousReferences: 0, invalidSourceRows: rows.length - linkedRows } };
  return { fromRows: rows, detail: { from, to, rows: relationships, totalRows: rows.length, truncated: false, offset: 0, relationship } };
}

function context(detail: RelationshipDetail): MissionRelationship {
  const { from, to, relationship } = detail;
  return { id: relationship.id, name: relationship.name, fromSetId: from.id, toSetId: to.id, fromName: from.name, toName: to.name,
    fromField: relationship.fromField, toField: to.keyField, fromRevision: from.revision, toRevision: to.revision, sourceHash: from.source.hash,
    targetHash: to.source.hash, fromSnapshotHash: from.snapshotHash, toSnapshotHash: to.snapshotHash, targetRows: to.source.rowCount };
}

function mission(snapshotValue: RoutineSnapshot, missionId: string, asOf = rule.asOf): Mission {
  const { detail, fromRows } = snapshotValue; const relationship = context(detail);
  const input = { confirmed: true as const, binding: { ...binding }, orderRule: { ...rule, asOf } };
  const { ruleHash, ...review } = reviewOrders(detail, fromRows, input.binding, input.orderRule);
  return { id: missionId, tenantId: 'tenant', ownerId: 'owner', question: 'Welche Bestellungen brauchen Klärung?', datasetId: detail.from.source.datasetId,
    relationshipId: relationship.id, status: 'completed', phase: 'execute', revision: 1, createdAt: at, updatedAt: at, source: structuredClone(detail.from.source),
    plan: { capabilityId: 'order_review', capabilityVersion: ORDER_REVIEW_VERSION, summary: 'Bestellungen prüfen', steps: [], limitations: [], suggestedBinding: { ...binding },
      relationship, orderKeyField: detail.from.keyField, generation: { backend: 'codex', model: 'test', reasoningEffort: 'test' } }, input,
    result: { ...review, capabilityId: 'order_review', evidence: { sourceHash: relationship.sourceHash, targetSourceHash: relationship.targetHash,
      fromSnapshotHash: relationship.fromSnapshotHash, toSnapshotHash: relationship.toSnapshotHash, capabilityVersion: ORDER_REVIEW_VERSION, executedAt: at,
      relationshipId: relationship.id, fromSetId: relationship.fromSetId, toSetId: relationship.toSetId, orderRuleHash: ruleHash } }, events: [] };
}

function fixture(beforeRows: ImportRow[], afterRows = beforeRows, afterAsOf = rule.asOf): { routine: RoutineDefinition; before: Mission; beforeSnapshot: RoutineSnapshot; after: Mission; afterSnapshot: RoutineSnapshot } {
  const beforeSnapshot = snapshot(beforeRows, 1); const before = mission(beforeSnapshot, id(400));
  const template = buildRoutineTemplate(before, beforeSnapshot);
  const routine: RoutineDefinition = { ...template, id: id(401), name: 'Routine', createdAt: at };
  const afterSnapshot = snapshot(afterRows, 2); const after = mission(afterSnapshot, id(402), afterAsOf);
  const preview = prepareRoutine(routine, afterSnapshot, afterAsOf);
  if (!preview.previewHash) throw new Error('Test fixture preview is unexpectedly blocked.');
  after.routine = { id: routine.id, name: routine.name, sourceMissionId: routine.sourceMissionId, previewHash: preview.previewHash,
    baselineRuleHash: routine.baseline.orderRuleHash, confirmedRuleHash: preview.orderRuleHash };
  after.plan!.reusedFromMissionId = routine.sourceMissionId;
  return { routine, before, beforeSnapshot, after, afterSnapshot };
}

test('uses exact typed IDs and classifies new, persisting, cleared and missing findings', () => {
  const f = fixture([row(1, 'Offen'), row('1', 'Erledigt'), row(false, 'Erledigt', '2026-09-22'), row(0, 'Offen'), row(9, 'Offen')],
    [row(1, 'Offen'), row('1', 'Offen'), row(false, 'Erledigt', '2026-09-23'), row(0, 'Erledigt'), row(8, 'Offen')]);
  const result = compareRoutineRuns(f.routine, f.before, f.beforeSnapshot, f.after, f.afterSnapshot);
  assert.deepEqual(result.items.map(item => [item.category, item.key]), [
    ['new', '1'], ['new', 8], ['persisting', 1], ['missing', 9], ['cleared', 0],
  ]);
  assert.equal(result.counts.new, 2); assert.equal(result.counts.persisting, 1); assert.equal(result.counts.missing, 1); assert.equal(result.counts.cleared, 1);
  assert.equal(result.items.find(item => item.key === false), undefined);
  assert.deepEqual(result.items.find(item => item.key === 1)?.changedFields, []);
});

test('emits one uncomparable item per actionable row for missing and duplicated object IDs', () => {
  const f = fixture([row(1, 'Offen'), row(1, 'Offen'), row(null, 'Offen'), row(2, 'Erledigt')],
    [row(1, 'Erledigt'), row(null, 'Offen'), row(3, 'Offen')]);
  const result = compareRoutineRuns(f.routine, f.before, f.beforeSnapshot, f.after, f.afterSnapshot);
  const invalid = result.items.filter(item => item.category === 'uncomparable');
  assert.equal(invalid.length, 4);
  assert.deepEqual(invalid.map(item => [item.key, item.before?.sourceRow ?? null, item.after?.sourceRow ?? null]), [
    [1, 1, null], [1, 2, null], [null, null, 2], [null, 3, null],
  ]);
  assert.ok(invalid.every(item => item.reason?.includes('mehrfach vorhanden') || item.reason?.includes('fehlt')));
  assert.equal(result.items.find(item => item.key === 3)?.category, 'new');
  assert.equal(result.items.filter(item => item.key === null).length, 2);
});

test('compares complete findings after the 100-row execution preview', () => {
  const beforeRows = Array.from({ length: 101 }, (_, index) => row(index + 1, 'Offen'));
  const afterRows = beforeRows.map((item, index) => index === 100 ? row(101, 'Erledigt') : item);
  const f = fixture(beforeRows, afterRows);
  const result = compareRoutineRuns(f.routine, f.before, f.beforeSnapshot, f.after, f.afterSnapshot);
  const changed = result.items.find(item => item.key === 101);
  assert.equal(changed?.category, 'cleared');
  assert.equal(changed?.before?.sourceRow, 101); assert.equal(changed?.after?.sourceRow, 101);
});

test('reports a changed finding when only the current as-of day changes', () => {
  const f = fixture([row(1, 'Offen', '2026-09-23')], [row(1, 'Offen', '2026-09-23')], '2026-09-24');
  const result = compareRoutineRuns(f.routine, f.before, f.beforeSnapshot, f.after, f.afterSnapshot);
  assert.equal(result.items.length, 1); assert.equal(result.items[0]!.category, 'new'); assert.equal(result.items[0]!.key, 1);
  assert.deepEqual(result.items[0]!.changedFields, ['Befund', 'Terminbeurteilung', 'Tage überfällig']);
  assert.equal(result.before.asOf, '2026-09-23'); assert.equal(result.after.asOf, '2026-09-24');
  assert.equal(result.items[0]!.reason, null);
});

test('is deterministic for unchanged inputs and protects all provenance checks', () => {
  const f = fixture([row(1, 'Offen')]);
  const first = compareRoutineRuns(f.routine, f.before, f.beforeSnapshot, f.after, f.afterSnapshot);
  const second = compareRoutineRuns(structuredClone(f.routine), structuredClone(f.before), structuredClone(f.beforeSnapshot), structuredClone(f.after), structuredClone(f.afterSnapshot));
  assert.deepEqual(second, first);
  const mutations: Array<(value: ReturnType<typeof fixture>) => void> = [
    value => { value.afterSnapshot.detail.from.familyId = id(999); },
    value => { value.after.result!.evidence.orderRuleHash = '0'.repeat(64); },
    value => { value.after.routine!.previewHash = '0'.repeat(64); },
    value => { value.after.tenantId = 'other-tenant'; },
  ];
  for (const mutate of mutations) {
    const changed = { ...f, routine: structuredClone(f.routine), before: structuredClone(f.before), beforeSnapshot: structuredClone(f.beforeSnapshot),
      after: structuredClone(f.after), afterSnapshot: structuredClone(f.afterSnapshot) };
    mutate(changed); assert.throws(() => compareRoutineRuns(changed.routine, changed.before, changed.beforeSnapshot, changed.after, changed.afterSnapshot));
  }
});

test('does not pair an old finding with duplicate, missing or blank new IDs, while false remains a real typed match', () => {
  const f = fixture(
    [row(1, 'Offen'), row(false, 'Offen'), row(null, 'Offen')],
    [row(1, 'Erledigt'), row(1, 'Erledigt'), row(false, 'Offen'), row(null, 'Offen'), row(' ', 'Offen')],
  );
  const result = compareRoutineRuns(f.routine, f.before, f.beforeSnapshot, f.after, f.afterSnapshot);
  assert.equal(result.counts.new, 0); assert.equal(result.counts.cleared, 0);
  assert.equal(result.items.find(item => item.key === false)?.category, 'persisting');
  assert.equal(result.items.find(item => item.key === false)?.before !== null, true);
  assert.equal(result.items.find(item => item.key === false)?.after !== null, true);
  const duplicate = result.items.filter(item => item.key === 1);
  assert.equal(duplicate.length, 3); assert.ok(duplicate.every(item => item.category === 'uncomparable'));
  assert.ok(duplicate.every(item => (item.before === null) !== (item.after === null)));
  const missing = result.items.filter(item => item.key === null);
  assert.equal(missing.length, 3); assert.ok(missing.every(item => item.category === 'uncomparable'));
  assert.ok(missing.every(item => (item.before === null) !== (item.after === null)));
});

test('keeps unknown statuses actionable, ignores row-position changes, and leaves every input untouched', () => {
  const shifted = fixture([row(1, 'Offen'), row(2, 'Offen'), row(3, 'Erledigt')],
    [row(3, 'Erledigt'), row(1, 'Offen'), row(2, 'Offen')]);
  const shiftedBefore = structuredClone(shifted);
  const shiftedResult = compareRoutineRuns(shifted.routine, shifted.before, shifted.beforeSnapshot, shifted.after, shifted.afterSnapshot);
  assert.deepEqual(shiftedResult.items.map(item => [item.key, item.category, item.changedFields]), [
    [1, 'persisting', []], [2, 'persisting', []],
  ]);
  assert.deepEqual(shifted, shiftedBefore);

  const unknown = fixture([row(10, 'Offen')], [row(10, 'Unbekannter Status')]);
  const unknownBefore = structuredClone(unknown);
  const unknownResult = compareRoutineRuns(unknown.routine, unknown.before, unknown.beforeSnapshot, unknown.after, unknown.afterSnapshot);
  const item = unknownResult.items[0]!;
  assert.equal(item.category, 'persisting'); assert.ok(item.changedFields.includes('Klärungsgrund'));
  assert.equal(item.after!.finding.Originalstatus, 'Unbekannter Status');
  assert.deepEqual(unknown, unknownBefore);
});

test('rejects fixed-rule and provenance mutations while accepting status-set permutations', () => {
  const permutation = fixture([row(1, 'Offen')]);
  permutation.after.input!.orderRule!.openStatuses.reverse(); permutation.after.input!.orderRule!.closedStatuses.reverse();
  assert.doesNotThrow(() => compareRoutineRuns(permutation.routine, permutation.before, permutation.beforeSnapshot,
    permutation.after, permutation.afterSnapshot));

  const mutations: Array<(value: ReturnType<typeof fixture>) => void> = [
    value => { value.after.input!.orderRule!.openStatuses = ['Fremd']; },
    value => { value.after.input!.binding.statusField = 'due'; },
    value => { value.after.routine!.sourceMissionId = id(999); },
    value => { value.after.ownerId = 'other-owner'; },
    value => { value.before.id = id(999); },
  ];
  for (const mutate of mutations) {
    const changed = { routine: structuredClone(permutation.routine), before: structuredClone(permutation.before), beforeSnapshot: structuredClone(permutation.beforeSnapshot),
      after: structuredClone(permutation.after), afterSnapshot: structuredClone(permutation.afterSnapshot) };
    mutate(changed); assert.throws(() => compareRoutineRuns(changed.routine, changed.before, changed.beforeSnapshot, changed.after, changed.afterSnapshot));
  }
});
