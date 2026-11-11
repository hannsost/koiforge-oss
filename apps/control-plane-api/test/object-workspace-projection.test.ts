import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ImportRow } from '../src/import-capability/isolated-executor.js';
import type { ObjectSet, Relationship, SemanticPrincipal } from '../src/semantic-model/contracts.js';
import type { SemanticState, StoredObjectSet } from '../src/semantic-model/store.js';
import { ObjectWorkspaceError } from '../src/object-workspace/contracts.js';
import { getObject, getObjectLinks, listFamilies, listObjects, objectReference } from '../src/object-workspace/projection.js';

const principal: SemanticPrincipal = { tenantId: 'tenant-a', ownerId: 'owner-a' };
let sequence = 0;
function id(prefix: string): string { sequence += 1; return `${prefix}-${sequence}`; }
function stored(rows: ImportRow[], options: { id?: string; familyId?: string; revision?: number; keyField?: string; name?: string } = {}): StoredObjectSet {
  const setId = options.id ?? id('set'); const familyId = options.familyId ?? setId;
  const keyField = options.keyField ?? 'id'; const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
  if (!columns.includes(keyField)) columns.push(keyField);
  const objectSet = {
    id: setId, familyId, revision: options.revision ?? 1, ...(options.revision && options.revision > 1 ? { previousId: 'previous' } : {}),
    ...principal, name: options.name ?? familyId, keyField,
    source: { datasetId: `dataset-${setId}`, name: `source-${setId}`, columns, rowCount: rows.length, hash: `hash-${setId}`, capturedAt: new Date().toISOString(), coverage: 'complete' },
    snapshotHash: `snapshot-${setId}`, createdAt: new Date(Date.now() + (options.revision ?? 1)).toISOString(), confirmedBy: principal.ownerId,
    keyQuality: { totalRows: rows.length, identifiedRows: rows.length, missingKeys: 0, duplicateRows: 0, duplicateGroups: 0 },
  } as unknown as ObjectSet;
  return { objectSet, rows, schema: columns.map(name => ({ name, type: 'string' })), confirmed: true };
}
function relation(from: StoredObjectSet, to: StoredObjectSet, fromField: string, name = 'rel'): Relationship {
  return { id: id('rel'), ...principal, name, fromSetId: from.objectSet.id, toSetId: to.objectSet.id, fromField,
    createdAt: new Date().toISOString(), confirmedBy: principal.ownerId, cardinality: 'many-to-one', contractVersion: 'relationship-v1',
    counts: { sourceRows: from.rows.length, linkedRows: 0, missingReferences: 0, unmatchedReferences: 0, ambiguousReferences: 0, invalidSourceRows: 0 },
    evidence: { sourceHash: from.objectSet.source.hash, targetHash: to.objectSet.source.hash, fromRevision: from.objectSet.revision, toRevision: to.objectSet.revision } };
}
function state(sets: StoredObjectSet[], relationships: Relationship[] = []): SemanticState {
  return { objectSets: Object.fromEntries(sets.map(set => [set.objectSet.id, set])), relationships: Object.fromEntries(relationships.map(value => [value.id, { relationship: value, confirmed: true }])), requests: {} };
}
function code(status: number) { return (value: unknown) => value instanceof ObjectWorkspaceError && value.statusCode === status; }

test('typed identity keeps 1, "1", 0, false, duplicates, and missing keys distinct', () => {
  const set = stored([{ id: 1 }, { id: '1' }, { id: 0 }, { id: false }, { id: 'D' }, { id: 'D' }, { id: null }, {}]);
  const page = listObjects(state([set]), principal, set.objectSet.familyId, { offset: 0, limit: 100, sortDir: 'asc' });
  assert.deepEqual(page.items.slice(0, 4).map(row => [row.key, row.identity]), [[1, 'unique'], ['1', 'unique'], [0, 'unique'], [false, 'unique']]);
  assert.equal(page.items[4]!.objectId, page.items[5]!.objectId);
  assert.equal(page.items[6]!.objectId, null); assert.equal(page.items[7]!.objectId, null);
  assert.notEqual(page.items[0]!.objectId, page.items[1]!.objectId);
});

test('families select the newest revision and object history is bounded while duplicate candidates remain ambiguous', () => {
  const familyId = id('family');
  const first = stored([{ id: 'A', label: 'old' }], { familyId, name: 'Accounts' });
  const second = stored([{ id: 'A', label: 'new-1' }, { id: 'A', label: 'new-2' }], { familyId, revision: 2, name: 'Accounts' });
  second.objectSet.previousId = first.objectSet.id;
  const model = state([first, second]);
  assert.deepEqual(listFamilies(model, principal)[0]!.revisions.map(set => set.revision), [2, 1]);
  const objectId = objectReference(first.objectSet, 'A');
  const latest = getObject(model, principal, familyId, objectId);
  assert.equal(latest.state, 'ambiguous'); assert.equal(latest.object, null); assert.equal(latest.candidateCount, 2);
  assert.deepEqual(latest.history.map(entry => [entry.revision, entry.state, entry.totalMatches]), [[2, 'ambiguous', 2], [1, 'present', 1]]);
  assert.equal(getObject(model, principal, familyId, objectId, first.objectSet.id).state, 'present');
});

test('changing the confirmed key field gives key_changed instead of rebinding an old object', () => {
  const familyId = id('family'); const first = stored([{ id: 'A', code: 'legacy' }], { familyId });
  const second = stored([{ code: 'A', id: 'different' }], { familyId, revision: 2, keyField: 'code' }); second.objectSet.previousId = first.objectSet.id;
  const model = state([first, second]); const detail = getObject(model, principal, familyId, objectReference(first.objectSet, 'A'));
  assert.equal(detail.state, 'key_changed'); assert.equal(detail.candidateCount, 0); assert.equal(detail.history[0]!.state, 'key_changed');
});

test('search scans the full source and typed filter and sort happen before pagination', () => {
  const rows = Array.from({ length: 130 }, (_, index) => ({ id: `row-${index}`, flag: index % 2 === 0, score: 130 - index, note: index === 129 ? 'needle at the end' : `row ${index}` }));
  const set = stored(rows); const model = state([set]);
  const found = listObjects(model, principal, set.objectSet.familyId, { q: 'NEEDLE', offset: 0, limit: 100, sortDir: 'asc' });
  assert.deepEqual(found.items.map(row => row.sourceRow), [130]);
  const filtered = listObjects(model, principal, set.objectSet.familyId, { filterField: 'flag', filterValue: false, sortBy: 'score', sortDir: 'desc', offset: 0, limit: 3 });
  assert.deepEqual(filtered.items.map(row => row.sourceRow), [2, 4, 6]); assert.equal(filtered.totalRows, 65);
});

test('sorting uses typed ordering and rejects fields outside the frozen source schema', () => {
  const set = stored([{ id: 'a', value: null }, { id: 'b', value: false }, { id: 'c', value: 2 }, { id: 'd', value: '10' }, {}]);
  const model = state([set]); const page = listObjects(model, principal, set.objectSet.familyId, { sortBy: 'value', sortDir: 'asc', offset: 0, limit: 100 });
  assert.deepEqual(page.items.map(row => row.sourceRow), [1, 5, 2, 3, 4]);
  assert.throws(() => listObjects(model, principal, set.objectSet.familyId, { sortBy: 'unknown', sortDir: 'asc', offset: 0, limit: 10 }), code(400));
  assert.throws(() => listObjects(model, principal, set.objectSet.familyId, { filterField: 'unknown', sortDir: 'asc', offset: 0, limit: 10 }), code(400));
});

test('outgoing links stay pinned to the exact target revision and expand all ambiguous targets while paginating', () => {
  const source = stored([{ id: 'S', ref: 'T' }]); const familyId = id('target-family');
  const target = stored(Array.from({ length: 25 }, () => ({ id: 'T', label: 'candidate' })), { familyId });
  const newer = stored([{ id: 'T', label: 'new revision' }], { familyId, revision: 2 }); newer.objectSet.previousId = target.objectSet.id;
  const rel = relation(source, target, 'ref'); const model = state([source, target, newer], [rel]); const objectId = objectReference(source.objectSet, 'S');
  const page = getObjectLinks(model, principal, source.objectSet.familyId, objectId, rel.id, { offset: 20, limit: 5 });
  assert.equal(page.direction, 'outgoing'); assert.equal(page.otherSet.id, target.objectSet.id); assert.equal(page.totalRows, 25);
  assert.equal(page.items.length, 5); assert.deepEqual(page.items.map(item => item.object?.sourceRow), [21, 22, 23, 24, 25]);
});

test('outgoing invalid, missing, and unmatched references remain null evidence', () => {
  const source = stored([{ id: 'S', ref: 'T' }, { id: 'M' }, { id: 'U', ref: 'missing' }]);
  const target = stored([{ id: 'T' }]); const rel = relation(source, target, 'ref'); const model = state([source, target], [rel]);
  const missing = getObjectLinks(model, principal, source.objectSet.familyId, objectReference(source.objectSet, 'M'), rel.id, { offset: 0, limit: 10 });
  assert.deepEqual(missing.items.map(item => [item.status, item.object]), [['missing_reference', null]]);
  const unmatched = getObjectLinks(model, principal, source.objectSet.familyId, objectReference(source.objectSet, 'U'), rel.id, { offset: 0, limit: 10 });
  assert.deepEqual(unmatched.items.map(item => [item.status, item.object]), [['unmatched_reference', null]]);
});

test('incoming links match exact typed references and preserve invalid source evidence', () => {
  const source = stored([{ id: 's1', ref: 1 }, { id: 's2', ref: '1' }, { id: 'dup', ref: 1 }, { id: 'dup', ref: 1 }]);
  const target = stored([{ id: 1 }]); const rel = relation(source, target, 'ref'); const model = state([source, target], [rel]);
  const page = getObjectLinks(model, principal, target.objectSet.familyId, objectReference(target.objectSet, 1), rel.id, { offset: 0, limit: 10 });
  assert.equal(page.direction, 'incoming'); assert.deepEqual(page.items.map(item => [item.status, item.sourceRow]), [['invalid_source_key', 3], ['invalid_source_key', 4], ['linked', 1]]);
  assert.equal(page.items[0]!.object?.identity, 'duplicate'); assert.equal(page.items[2]!.object?.objectId, objectReference(source.objectSet, 's1'));
});

test('all resource reads enforce tenant and owner boundaries, and returned values are isolated', () => {
  const set = stored([{ id: 'A', label: 'original' }]); const model = state([set]);
  const page = listObjects(model, principal, set.objectSet.familyId, { offset: 0, limit: 10, sortDir: 'asc' });
  page.items[0]!.attributes.label = 'changed'; page.objectSet.name = 'changed';
  const again = listObjects(model, principal, set.objectSet.familyId, { offset: 0, limit: 10, sortDir: 'asc' });
  assert.equal(again.items[0]!.attributes.label, 'original'); assert.notEqual(again.objectSet.name, 'changed');
  assert.deepEqual(listFamilies(model, { tenantId: 'tenant-b', ownerId: 'owner-a' }), []); // no leakage: the family is absent
  assert.throws(() => listObjects(model, { tenantId: 'tenant-b', ownerId: 'owner-a' }, set.objectSet.familyId, { offset: 0, limit: 10, sortDir: 'asc' }), code(404));
});

test('object details expose deterministic relationship summaries', () => {
  const source = stored([{ id: 'S', ref: 'T' }]); const target = stored([{ id: 'T' }]);
  const first = relation(source, target, 'ref', 'Z relation'); const second = relation(source, target, 'ref', 'A relation');
  const model = state([source, target], [first, second]); const detail = getObject(model, principal, source.objectSet.familyId, objectReference(source.objectSet, 'S'));
  assert.deepEqual(detail.relationships.map(summary => summary.relationship.name), ['A relation', 'Z relation']);
  assert.deepEqual(detail.relationships.map(summary => summary.direction), ['outgoing', 'outgoing']);
});

test('a self relationship separates incoming children from the outgoing parent with object-specific counts', () => {
  const nodes = stored([{ id: 'A', parent: null }, { id: 'B', parent: 'A' }, { id: 'C', parent: 'B' }, { id: 'D', parent: 'A' }]);
  const rel = relation(nodes, nodes, 'parent'); const model = state([nodes], [rel]);
  const address = objectReference(nodes.objectSet, 'B');
  const detail = getObject(model, principal, nodes.objectSet.familyId, address);
  assert.deepEqual(detail.relationships.map(r => [r.direction, r.totalRows, r.linkedRows]), [['incoming', 1, 1], ['outgoing', 1, 1]]);
  const links = (direction: 'incoming' | 'outgoing') => getObjectLinks(model, principal, nodes.objectSet.familyId, address, rel.id, { direction, offset: 0, limit: 25 });
  assert.equal(links('incoming').items[0]!.object!.key, 'C');
  assert.equal(links('outgoing').items[0]!.object!.key, 'A');
  const before = JSON.stringify(model);
  detail.relationships[0]!.otherSet.name = 'mutated'; links('incoming').items[0]!.object!.attributes.id = 'mutated';
  assert.equal(JSON.stringify(model), before);
});

test('absence has no current links and a foreign counterpart never leaks through a caller-owned relationship', () => {
  const old = stored([{ id: 'A' }]);
  const newer = stored([{ id: 'B', ref: 'B' }], { familyId: old.objectSet.familyId, revision: 2 });
  const rel = relation(newer, newer, 'ref'); const model = state([old, newer], [rel]);
  const detail = getObject(model, principal, old.objectSet.familyId, objectReference(old.objectSet, 'A'));
  assert.equal(detail.state, 'absent'); assert.deepEqual(detail.relationships, []);
  assert.equal(getObjectLinks(model, principal, old.objectSet.familyId, detail.objectId, rel.id, { offset: 0, limit: 25 }).totalRows, 0);
  const foreign = stored([{ id: 'B' }]); foreign.objectSet.ownerId = 'other-owner';
  const unsafe = relation(newer, foreign, 'ref'); const mixed = state([newer, foreign], [unsafe]);
  assert.throws(() => getObject(mixed, principal, newer.objectSet.familyId, objectReference(newer.objectSet, 'B')), code(404));
  assert.throws(() => getObjectLinks(mixed, principal, newer.objectSet.familyId, objectReference(newer.objectSet, 'B'), unsafe.id, { offset: 0, limit: 25 }), code(404));
});

test('relationship pages avoid materializing unrelated rows and repeated definitions reuse indexes within one read', () => {
  let referenceReads = 0;
  const rows = Array.from({ length: 10_000 }, (_, index) => {
    const row: ImportRow = { id: `S${index}` };
    Object.defineProperty(row, 'ref', { enumerable: true, get() { referenceReads++; return 'T'; } });
    return row;
  });
  const source = stored(rows); const target = stored(Array.from({ length: 30 }, () => ({ id: 'T' })));
  const relations = Array.from({ length: 300 }, (_, i) => relation(source, target, 'ref', `Relation ${i}`));
  const model = state([source, target], relations);
  referenceReads = 0;
  const page = getObjectLinks(model, principal, source.objectSet.familyId, objectReference(source.objectSet, 'S9999'), relations[0]!.id,
    { offset: 25, limit: 5 });
  assert.equal(page.totalRows, 30); assert.deepEqual(page.items.map(item => item.object!.sourceRow), [26, 27, 28, 29, 30]);
  assert(referenceReads < 10, `one outgoing object read ${referenceReads} unrelated references`);
  referenceReads = 0;
  const detail = getObject(model, principal, target.objectSet.familyId, objectReference(target.objectSet, 'T'));
  assert.equal(detail.relationships.length, 300);
  assert(detail.relationships.every(item => item.totalRows === 10_000 && item.linkedRows === 0));
  assert(referenceReads <= 20_000, `repeated definitions amplified scans to ${referenceReads} references`);
});
