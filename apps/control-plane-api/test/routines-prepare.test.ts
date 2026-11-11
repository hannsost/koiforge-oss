import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { ORDER_REVIEW_VERSION, reviewOrders, type OrderReviewBinding, type OrderReviewRule } from '../src/domain/orders/review.js';
import { rowsHash, type ImportRow } from '../src/import-capability/isolated-executor.js';
import type { Mission, MissionRelationship } from '../src/missions/contracts.js';
import type { ObjectSet, RelationshipRow } from '../src/semantic-model/contracts.js';
import type { RoutineDefinition, RoutineSnapshot } from '../src/routines/contracts.js';
import { buildRoutineTemplate, computePreviewHash, prepareRoutine, validateRoutineDefinition } from '../src/routines/prepare.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-09-23T12:00:00.000Z';
const binding: OrderReviewBinding = { statusField: 'status', dueDateField: 'due' };
const rule: OrderReviewRule = { openStatuses: ['Offen'], closedStatuses: ['Erledigt'], asOf: '2026-09-23', dueDateMeaning: 'promised_delivery_day' };
const order = (index: number, extra: ImportRow = {}): ImportRow => ({ id: index, supplier: 'L1', status: 'Offen', due: '2026-09-23', ...extra });
const key = (value: ImportRow[string] | undefined) => value == null || (typeof value === 'string' && !value.trim()) ? null : value;

function snapshot(fromRows: ImportRow[] = [order(1)], revision = 1): RoutineSnapshot {
  const set = (family: number, rows: ImportRow[], columns: string[]): ObjectSet => ({
    id: id(family + revision * 10), familyId: id(family), revision, tenantId: 'tenant', ownerId: 'owner', name: family === 1 ? 'Bestellungen' : 'Lieferanten',
    keyField: 'id', source: { datasetId: `dataset-${family}`, name: `Quelle ${family}`, columns, rowCount: rows.length,
      hash: rowsHash(rows), capturedAt: at, coverage: 'complete' },
    snapshotHash: createHash('sha256').update(JSON.stringify([family, revision, rows, columns])).digest('hex'),
    createdAt: at, confirmedBy: 'owner', keyQuality: { totalRows: rows.length, identifiedRows: rows.length, missingKeys: 0, duplicateRows: 0, duplicateGroups: 0 },
  });
  const from = set(1, fromRows, [...new Set(['id', 'supplier', 'status', 'due', ...fromRows.flatMap(row => Object.keys(row))])]);
  const to = set(2, [{ id: 'L1' }], ['id']);
  const rows: RelationshipRow[] = fromRows.map((row, index) => {
    const invalid = key(row.id) === null || fromRows.filter(other => key(other.id) === key(row.id)).length !== 1;
    const status = invalid ? 'invalid_source_key' : key(row.supplier) === null ? 'missing_reference' : row.supplier === 'L1' ? 'linked' : 'unmatched_reference';
    return { sourceRow: index + 1, sourceKey: key(row.id), reference: key(row.supplier), status,
      targetRows: status === 'linked' ? [1] : [], targetRowCount: status === 'linked' ? 1 : 0,
      targetRowsTruncated: false, sourceLabel: `Bestellung ${index + 1}`, ...(status === 'linked' ? { targetLabel: 'L1' } : {}) };
  });
  return { fromRows, detail: { from, to, rows, totalRows: rows.length, truncated: false, offset: 0,
    relationship: { id: id(3 + revision * 10), tenantId: 'tenant', ownerId: 'owner', name: 'Bestellung hat Lieferant',
      fromSetId: from.id, toSetId: to.id, fromField: 'supplier', createdAt: at, confirmedBy: 'owner', cardinality: 'many-to-one',
      contractVersion: 'relationship-v1', evidence: { sourceHash: from.source.hash, targetHash: to.source.hash, fromRevision: revision, toRevision: revision },
      counts: { sourceRows: rows.length, linkedRows: rows.filter(row => row.status === 'linked').length,
        missingReferences: rows.filter(row => row.status === 'missing_reference').length,
        unmatchedReferences: rows.filter(row => row.status === 'unmatched_reference').length, ambiguousReferences: 0,
        invalidSourceRows: rows.filter(row => row.status === 'invalid_source_key').length } } } };
}
function fixture(snap = snapshot()): { mission: Mission; routine: RoutineDefinition; snapshot: RoutineSnapshot } {
  const { detail, fromRows } = snap; const { from, to } = detail;
  const relationship: MissionRelationship = { id: detail.relationship.id, name: detail.relationship.name, fromSetId: from.id, toSetId: to.id,
    fromName: from.name, toName: to.name, fromField: detail.relationship.fromField, toField: to.keyField,
    fromRevision: from.revision, toRevision: to.revision, sourceHash: from.source.hash, targetHash: to.source.hash,
    fromSnapshotHash: from.snapshotHash, toSnapshotHash: to.snapshotHash, targetRows: to.source.rowCount };
  const { ruleHash, ...result } = reviewOrders(detail, fromRows, binding, rule);
  const mission: Mission = { id: id(100), tenantId: 'tenant', ownerId: 'owner', question: 'Welche Bestellungen benötigen Klärung?',
    datasetId: from.source.datasetId, relationshipId: relationship.id, status: 'completed', phase: 'execute', revision: 5, createdAt: at, updatedAt: at,
    source: structuredClone(from.source), plan: { capabilityId: 'order_review', capabilityVersion: ORDER_REVIEW_VERSION,
      summary: 'Offene Bestellungen prüfen', steps: [], limitations: [], suggestedBinding: { ...binding }, relationship,
      orderKeyField: from.keyField, generation: { backend: 'codex', model: 'test', reasoningEffort: 'test' } },
    input: { confirmed: true, binding: { ...binding }, orderRule: structuredClone(rule) },
    result: { ...result, capabilityId: 'order_review', evidence: { sourceHash: from.source.hash, targetSourceHash: to.source.hash,
      capabilityVersion: ORDER_REVIEW_VERSION, executedAt: at, relationshipId: relationship.id, fromSetId: from.id, toSetId: to.id,
      fromSnapshotHash: from.snapshotHash, toSnapshotHash: to.snapshotHash, orderRuleHash: ruleHash } }, events: [] };
  const routine = { ...buildRoutineTemplate(mission, snap), id: id(101), name: 'Bestellungen klären', createdAt: at };
  return { mission, routine, snapshot: snap };
}

test('completed review becomes an independent immutable definition without raw rows', () => {
  const f = fixture(); const before = structuredClone(f);
  assert.deepEqual(validateRoutineDefinition(f.routine), f.routine);
  assert.equal(f.routine.sourceMissionId, f.mission.id);
  assert.equal(f.routine.baseline.fromFamilyId, f.snapshot.detail.from.familyId);
  assert.equal(f.routine.baseline.targetSource.hash, f.snapshot.detail.to.source.hash);
  assert.ok(!JSON.stringify(f.routine).includes('Bestellung 1'));
  f.routine.binding.statusField = 'changed'; f.routine.baseline.source.columns.push('changed'); f.routine.orderRule.openStatuses.push('changed');
  assert.deepEqual(f.mission, before.mission); assert.deepEqual(f.snapshot, before.snapshot);
});

test('unchanged preparation has deterministic canonical token, zero deltas and no mutations', () => {
  const f = fixture(); const before = structuredClone(f);
  const first = prepareRoutine(f.routine, f.snapshot, rule.asOf);
  const reordered = Object.fromEntries(Object.entries(f.routine).reverse()) as unknown as RoutineDefinition;
  const second = prepareRoutine(reordered, structuredClone(f.snapshot), rule.asOf);
  assert.equal(first.ready, true); assert.match(first.previewHash!, /^[a-f0-9]{64}$/);
  assert.deepEqual(second, first); assert.equal(computePreviewHash(f.routine, first), first.previewHash);
  assert.deepEqual(first.newCounts, f.routine.baseline.counts);
  assert.ok(Object.values(first.deltas!).every(value => value === 0));
  assert.deepEqual(f, before);
  first.source.columns.push('external-mutation'); assert.deepEqual(f, before);
});

test('both revisions, populations, unused columns and explicit changed calendar day are visible', () => {
  const f = fixture(snapshot([order(1, { obsolete: 'unused' })]));
  const current = snapshot([order(1, { status: 'Erledigt', added: 'unused' }), order(2, { due: '2026-09-24', added: 'unused' })], 2);
  const result = prepareRoutine(f.routine, current, '2026-09-25');
  assert.equal(result.ready, true);
  assert.deepEqual(result.changes.from, { previousRevision: 1, revision: 2, previousRows: 1, rows: 2,
    removedColumns: ['obsolete'], addedColumns: ['added'] });
  assert.deepEqual(result.changes.to, { previousRevision: 1, revision: 2, previousRows: 1, rows: 1, removedColumns: [], addedColumns: [] });
  assert.deepEqual(result.changes.asOf, { previous: '2026-09-23', current: '2026-09-25', changed: true });
  assert.deepEqual(result.newCounts, { sourceRows: 2, overdueRows: 1, openRows: 0, closedRows: 1, unassessableRows: 0, clarificationRows: 0, deadlineUnassessableRows: 0 });
  assert.deepEqual(result.deltas, { sourceRows: 1, overdueRows: 1, openRows: -1, closedRows: 1, unassessableRows: 0, clarificationRows: 0, deadlineUnassessableRows: 0 });
  assert.match(result.warnings.join(' '), /keine Einzeländerungen oder Ursachen/);
  assert.notEqual(result.previewHash, prepareRoutine(f.routine, current, '2026-09-24').previewHash);
  assert.equal(f.routine.orderRule.asOf, '2026-09-23');
});

test('missing required columns block; missing individual cell values remain deterministic findings', () => {
  const f = fixture();
  for (const field of ['id', 'supplier', 'status', 'due']) {
    const changed = snapshot([Object.fromEntries(Object.entries(order(1)).filter(([key]) => key !== field))], 2);
    changed.detail.from.source.columns = changed.detail.from.source.columns.filter(column => column !== field);
    const preview = prepareRoutine(f.routine, changed, rule.asOf);
    assert.equal(preview.ready, false); assert.match(preview.blockingReasons.join(' '), new RegExp(field));
    assert.equal(preview.previewHash, undefined); assert.equal(preview.newCounts, undefined); assert.equal(preview.deltas, undefined);
  }
  const cells = prepareRoutine(f.routine, snapshot([order(1, { status: null }), order(2, { due: null })], 2), rule.asOf);
  assert.equal(cells.ready, true); assert.equal(cells.newCounts!.unassessableRows, 1); assert.equal(cells.newCounts!.deadlineUnassessableRows, 1);
});

test('families, direction and all confirmed identity/reference fields cannot be rebound', () => {
  const f = fixture();
  const mutations: Array<(current: RoutineSnapshot) => void> = [
    current => { current.detail.from.familyId = id(801); }, current => { current.detail.to.familyId = id(802); },
    current => { [current.detail.from.familyId, current.detail.to.familyId] = [current.detail.to.familyId, current.detail.from.familyId]; },
    current => { current.detail.from.keyField = 'status'; }, current => { current.detail.to.keyField = 'different'; },
    current => { current.detail.relationship.fromField = 'id'; },
  ];
  for (const mutation of mutations) {
    const current = snapshot([order(1)], 2); mutation(current);
    const preview = prepareRoutine(f.routine, current, rule.asOf);
    assert.equal(preview.ready, false, String(mutation)); assert.ok(preview.blockingReasons.length > 0);
    assert.equal(preview.newCounts, undefined); assert.equal(preview.previewHash, undefined);
  }
});

test('unknown exact text statuses remain unassessable and profile examples are capped after full counting', () => {
  const f = fixture();
  const rows = [order(1), order(2, { status: 'Erledigt' }), order(3, { status: null }), order(4, { status: '  ' }),
    order(5, { status: false }), order(6, { status: 0 }), ...Array.from({ length: 235 }, (_, i) => order(i + 7, { status: `unknown-${i % 23}` }))];
  const current = snapshot(rows, 2); const result = prepareRoutine(f.routine, current, rule.asOf);
  assert.equal(result.ready, true); assert.equal(result.statusProfile.totalRows, 241);
  assert.equal(result.statusProfile.knownOpenRows, 1); assert.equal(result.statusProfile.knownClosedRows, 1);
  assert.equal(result.statusProfile.missingRows, 2); assert.equal(result.statusProfile.nonTextRows, 2); assert.equal(result.statusProfile.unknownRows, 235);
  assert.equal(result.statusProfile.unassignableRows, 0);
  assert.equal(result.statusProfile.unknownValues.length, 20); assert.equal(result.statusProfile.unknownUniqueTotal, 23); assert.equal(result.statusProfile.truncated, true);
  assert.deepEqual(result.statusProfile.unknownValues[0], { value: 'unknown-0', count: 11 });
  assert.deepEqual(result.newCounts, { sourceRows: 241, overdueRows: 0, openRows: 1, closedRows: 1, unassessableRows: 239, clarificationRows: 239, deadlineUnassessableRows: 0 });
  assert.match(result.warnings.join(' '), /235 Zeilen/); assert.deepEqual(f.routine.orderRule, rule);
});

test('status examples omit texts above the 200-character rule limit while preserving complete totals', () => {
  const f = fixture(); const longStatus = 'x'.repeat(201); const assignableStatus = 'x'.repeat(200);
  const current = snapshot([order(1), order(2, { status: longStatus }), order(3, { status: longStatus }),
    order(4, { status: assignableStatus }), order(5, { status: 'unknown' }), order(6, { status: ' '.repeat(201) })], 2);
  const result = prepareRoutine(f.routine, current, rule.asOf);
  assert.equal(result.ready, true);
  assert.equal(result.statusProfile.totalRows, 6); assert.equal(result.statusProfile.knownOpenRows, 1);
  assert.equal(result.statusProfile.unknownRows, 4); assert.equal(result.statusProfile.unknownUniqueTotal, 3);
  assert.equal(result.statusProfile.unassignableRows, 2); assert.equal(result.statusProfile.missingRows, 1);
  assert.deepEqual(result.statusProfile.unknownValues, [{ value: 'unknown', count: 1 }, { value: assignableStatus, count: 1 }]);
  assert.equal(result.statusProfile.truncated, true);
  assert.equal(result.newCounts!.sourceRows, 6); assert.equal(result.newCounts!.unassessableRows, 5);
  assert.ok(!JSON.stringify(result).includes(longStatus));
});

test('calendar days are explicit and valid only from year 1000 through 9999 with no normalization', () => {
  const f = fixture();
  for (const asOf of ['', 'today', '2026-02-29', '2026-02-30', '2026-13-01', '0000-01-01', '0999-12-31', '10000-01-01', '2026-09-23T00:00:00Z']) {
    const result = prepareRoutine(f.routine, f.snapshot, asOf);
    assert.equal(result.ready, false, asOf); assert.match(result.blockingReasons.join(' '), /Stichtag/); assert.equal(result.previewHash, undefined);
  }
  for (const asOf of ['1000-01-01', '2000-02-29', '9999-12-31']) assert.equal(prepareRoutine(f.routine, f.snapshot, asOf).ready, true, asOf);
});

test('origin status, confirmed input, capability, source and both execution receipts must reproduce', () => {
  const changes: Array<(mission: Mission) => void> = [
    mission => { mission.status = 'running'; }, mission => { mission.phase = 'plan'; }, mission => { mission.input!.confirmed = false as never; },
    mission => { mission.input!.orderRule!.openStatuses = ['Erledigt']; }, mission => { mission.plan!.capabilityVersion = 'future'; },
    mission => { mission.plan!.orderKeyField = 'status'; }, mission => { mission.source!.columns.reverse(); },
    mission => { mission.result!.evidence.targetSourceHash = '0'.repeat(64); }, mission => { mission.result!.evidence.toSnapshotHash = '0'.repeat(64); },
    mission => { mission.result!.evidence.fromSnapshotHash = '0'.repeat(64); }, mission => { mission.result!.evidence.orderRuleHash = '0'.repeat(64); },
    mission => { mission.result!.evidence.toSetId = id(900); }, mission => { mission.result!.counts.openRows = 999; },
    mission => { mission.result!.rows[0]!.Befund = 'fabricated'; },
  ];
  for (const change of changes) { const f = fixture(); change(f.mission); assert.throws(() => buildRoutineTemplate(f.mission, f.snapshot), String(change)); }
});

test('complete source and semantic evidence are required even if totals look plausible', () => {
  const mutations: Array<(current: RoutineSnapshot) => void> = [
    current => { current.fromRows[0]!.status = 'altered'; }, current => { current.detail.truncated = true; },
    current => { current.detail.offset = 1; }, current => { current.detail.from.source.rowCount++; },
    current => { current.detail.relationship.evidence.targetHash = '0'.repeat(64); }, current => { current.detail.to.source.coverage = 'partial' as never; },
    current => { current.detail.from.ownerId = 'someone-else'; }, current => { current.detail.to.confirmedBy = 'someone-else'; },
    current => { current.detail.relationship.confirmedBy = 'someone-else'; }, current => { current.detail.rows[0]!.sourceKey = '1'; },
    current => { current.detail.rows[0]!.status = 'invalid_source_key'; current.detail.rows[0]!.targetRows = []; current.detail.rows[0]!.targetRowCount = 0;
      current.detail.relationship.counts.linkedRows = 0; current.detail.relationship.counts.invalidSourceRows = 1; },
    current => { current.detail.rows[0]!.targetRows = [2]; },
  ];
  for (const change of mutations) {
    const f = fixture(); const current = structuredClone(f.snapshot); change(current);
    assert.throws(() => buildRoutineTemplate(f.mission, current), String(change));
    const preview = prepareRoutine(f.routine, current, rule.asOf);
    assert.equal(preview.ready, false, String(change)); assert.equal(preview.previewHash, undefined); assert.equal(preview.newCounts, undefined);
  }
});

test('definition validation rejects extra raw data, malformed baseline and altered rules', () => {
  const changes: Array<(routine: RoutineDefinition) => void> = [
    routine => { Object.assign(routine, { rawRows: [order(1)] }); }, routine => { routine.name = ''; }, routine => { routine.name = 'x'.repeat(121); },
    routine => { routine.id = 'unsafe-path'; }, routine => { routine.sourceMissionId = 'unsafe-path'; }, routine => { routine.capabilityVersion = 'future'; },
    routine => { routine.baseline.targetSource.hash = 'changed'; }, routine => { routine.baseline.targetSource.columns = ['other']; },
    routine => { routine.orderRule.openStatuses.push('silent-new-rule'); }, routine => { routine.baseline.orderRuleHash = '0'.repeat(64); },
    routine => { routine.baseline.counts.openRows = NaN; }, routine => { routine.baseline.counts.openRows++; },
    routine => { routine.baseline.relationship.toSnapshotHash = ''; }, routine => { routine.baseline.fromFamilyId = ''; },
  ];
  for (const change of changes) { const f = fixture(); change(f.routine); assert.throws(() => validateRoutineDefinition(f.routine), String(change)); }
});

test('preview token commits to both source metadata, semantic hashes, provenance, fields and all visible counts', () => {
  const f = fixture(); const preview = prepareRoutine(f.routine, f.snapshot, rule.asOf); const original = preview.previewHash;
  const changes: Array<(changed: typeof preview) => void> = [
    changed => { changed.source.hash = '0'.repeat(64); }, changed => { changed.targetSource.hash = '0'.repeat(64); },
    changed => { changed.targetSource.columns.push('new'); }, changed => { changed.relationship.toSnapshotHash = '0'.repeat(64); },
    changed => { changed.relationship.fromSnapshotHash = '0'.repeat(64); }, changed => { changed.relationship.toSetId = id(999); },
    changed => { changed.binding.statusField = 'other'; }, changed => { changed.orderRule.asOf = '2026-09-24'; },
    changed => { changed.newCounts!.openRows++; }, changed => { changed.statusProfile.unknownRows++; },
    changed => { changed.changes.from.revision++; },
  ];
  for (const change of changes) { const changed = structuredClone(preview); change(changed); assert.notEqual(computePreviewHash(f.routine, changed), original, String(change)); }
  for (const field of ['id', 'sourceMissionId', 'tenantId', 'ownerId', 'capabilityVersion'] as const) {
    const changed = structuredClone(f.routine); changed[field] = 'different'; assert.notEqual(computePreviewHash(changed, preview), original, field);
  }
});

test('no available promised day is reusable without a manufactured deadline field', () => {
  const f = fixture();
  f.mission.input!.binding = { statusField: 'status' };
  f.mission.input!.orderRule = { ...rule, dueDateMeaning: 'not_available' };
  const { ruleHash, ...result } = reviewOrders(f.snapshot.detail, f.snapshot.fromRows, f.mission.input!.binding as OrderReviewBinding, f.mission.input!.orderRule);
  f.mission.result = { ...f.mission.result!, ...result, evidence: { ...f.mission.result!.evidence, orderRuleHash: ruleHash } };
  const routine = { ...buildRoutineTemplate(f.mission, f.snapshot), id: id(101), name: 'Ohne Liefertag', createdAt: at };
  const current = snapshot([{ id: 1, supplier: 'L1', status: 'Offen' }], 2); current.detail.from.source.columns = ['id', 'supplier', 'status'];
  const preview = prepareRoutine(routine, current, rule.asOf);
  assert.equal(preview.ready, true); assert.equal(preview.newCounts!.deadlineUnassessableRows, 1); assert.equal(preview.newCounts!.overdueRows, 0);
});
