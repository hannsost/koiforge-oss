import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rowsHash } from '../src/import-capability/isolated-executor.js';
import { semanticHash, type SemanticState, type StoredObjectSet } from '../src/semantic-model/store.js';
import { DataflowError, type FlowDefinition, type FlowRun, type FlowSpec } from '../src/dataflows/contracts.js';
import { projectDependencies } from '../src/dataflows/dependencies.js';
import type { FlowState } from '../src/dataflows/store.js';

const owner = { ownerId: 'owner-a', tenantId: 'tenant-a' };
const foreign = { ownerId: 'owner-b', tenantId: 'tenant-a' };
const schema = [{ name: 'id', type: 'string' }] as const;
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666',
  '77777777-7777-4777-8777-777777777777', '88888888-8888-4888-8888-888888888888',
  '99999999-9999-4999-8999-999999999999', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'];

function spec(name: string, inputFamilyId: string, joins: string[] = []): FlowSpec {
  return { name, description: '', inputFamilyId, keyField: 'id', minRows: 0, filters: [],
    joins: joins.map(familyId => ({ familyId, leftField: 'id', rightField: 'id', required: true, fields: [] })) };
}

function definition(id: string, flowId: string, inputFamilyId: string, joins: string[] = [], revision = 1, bindings = [inputFamilyId, ...joins]) {
  const value: FlowDefinition = { id, flowId, revision, tenantId: owner.tenantId, ownerId: owner.ownerId,
    createdAt: '2026-09-24T00:00:00.000Z', spec: spec(`Flow ${flowId}`, inputFamilyId, joins),
    bindings: bindings.map(familyId => ({ familyId, schemaHash: semanticHash(schema) })), definitionHash: 'definition-hash' };
  return value;
}

function sourceSet(id: string, familyId = id, details: { ownerId?: string; tenantId?: string; schema?: readonly { name: string; type: string }[]; datasetId?: string } = {}): StoredObjectSet {
  const fields = [...(details.schema ?? schema)];
  const rows = [{ id: `${familyId.slice(0, 4)}` }];
  const hash = rowsHash(rows);
  const objectSet = {
    id, familyId, revision: 1, ownerId: details.ownerId ?? owner.ownerId, tenantId: details.tenantId ?? owner.tenantId,
    name: `Quelle ${familyId}`, keyField: 'id', source: { datasetId: details.datasetId ?? `dataset:${familyId}`, name: 'Quelle',
      columns: fields.map(field => field.name), rowCount: rows.length, hash, capturedAt: '2026-09-24T00:00:00.000Z', coverage: 'complete' as const },
    snapshotHash: 'snapshot', createdAt: '2026-09-24T00:00:00.000Z', confirmedBy: details.ownerId ?? owner.ownerId,
    keyQuality: { totalRows: 1, identifiedRows: 1, missingKeys: 0, duplicateRows: 0, duplicateGroups: 0 },
  };
  return { objectSet, rows, schema: fields, confirmed: true } as StoredObjectSet;
}

function outputSet(flowId: string, runId: string, revision = 1): StoredObjectSet {
  const rows: Array<Record<string, string>> = [];
  const hash = rowsHash(rows);
  const objectSet = { id: revision === 1 ? flowId : ids[11]!, familyId: flowId, revision,
    ...(revision > 1 ? { previousId: flowId } : {}), ...owner, name: `Ausgabe ${flowId}`, keyField: 'id',
    source: { datasetId: `dataflow:${flowId}:${runId}`, name: 'Ausgabe', columns: ['id'], rowCount: 0, hash,
      capturedAt: '2026-09-24T00:00:00.000Z', coverage: 'complete' as const }, snapshotHash: 'snapshot',
    createdAt: '2026-09-24T00:00:00.000Z', confirmedBy: owner.ownerId,
    keyQuality: { totalRows: 0, identifiedRows: 0, missingKeys: 0, duplicateRows: 0, duplicateGroups: 0 } };
  return { objectSet, rows, schema: [...schema], confirmed: true } as StoredObjectSet;
}

function run(id: string, flowId: string, definitionId: string, sources: FlowRun['sources'], status: FlowRun['status'] = 'ready'): FlowRun {
  const rows: Array<Record<string, string>> = [];
  return { id, flowId, definitionId, ...owner, createdAt: '2026-09-24T00:00:00.000Z', engineVersion: 'typed-enrichment-v1',
    sources, status, issues: status === 'ready' ? [] : ['blocked'], rows, schema: [...schema], rowCount: 0,
    outputHash: rowsHash(rows), steps: [], runHash: 'run-hash' } as FlowRun;
}

function state(definitions: FlowDefinition[], runs: FlowRun[]): FlowState {
  return { definitions: Object.fromEntries(definitions.map(value => [value.id, value])),
    runs: Object.fromEntries(runs.map(value => [value.id, value])), requests: {} };
}

function models(entries: StoredObjectSet[]): SemanticState {
  return { objectSets: Object.fromEntries(entries.map(value => [value.objectSet.id, value])), relationships: {}, requests: {} };
}

function sourceRef(set: StoredObjectSet, familyId = set.objectSet.familyId): FlowRun['sources'][number] {
  const value = set.objectSet;
  return { familyId, setId: value.id, revision: value.revision, name: value.name, snapshotHash: value.snapshotHash,
    sourceHash: value.source.hash, rowCount: value.source.rowCount };
}

test('projects source to flow dependencies with deterministic edges, order and transitive impact', () => {
  const source = sourceSet(ids[0]!);
  const a = definition(ids[1]!, ids[1]!, source.objectSet.familyId);
  const b = definition(ids[2]!, ids[2]!, a.flowId);
  const c = definition(ids[3]!, ids[3]!, b.flowId);
  const d = definition(ids[4]!, ids[4]!, a.flowId);
  const e = definition(ids[9]!, ids[9]!, c.flowId, [d.flowId]);
  const ra = run(ids[5]!, a.flowId, a.id, [sourceRef(source)]);
  const rb = run(ids[6]!, b.flowId, b.id, [sourceRef(outputSet(a.flowId, ra.id))]);
  const rc = run(ids[7]!, c.flowId, c.id, [sourceRef(outputSet(b.flowId, rb.id))]);
  const rd = run(ids[8]!, d.flowId, d.id, [sourceRef(outputSet(a.flowId, ra.id))]);
  const re = run(ids[10]!, e.flowId, e.id, [sourceRef(outputSet(c.flowId, rc.id)), sourceRef(outputSet(d.flowId, rd.id))]);
  // Deliberately reverse insertion order: freshness propagation must follow
  // graph topology rather than object/map insertion order.
  const graph = projectDependencies(state([e, d, c, b, a], [re, rd, rc, rb, ra]), models([source, outputSet(a.flowId, ra.id), outputSet(b.flowId, rb.id), outputSet(c.flowId, rc.id), outputSet(d.flowId, rd.id), outputSet(e.flowId, re.id)]), owner);
  assert.deepEqual(graph.edges, [{ fromFlowId: a.flowId, toFlowId: b.flowId }, { fromFlowId: a.flowId, toFlowId: d.flowId },
    { fromFlowId: b.flowId, toFlowId: c.flowId }, { fromFlowId: c.flowId, toFlowId: e.flowId }, { fromFlowId: d.flowId, toFlowId: e.flowId }]);
  assert.deepEqual(graph.updateOrder, []);
  assert.deepEqual(graph.nodes.find(node => node.flowId === a.flowId)?.affectedFlowIds, [b.flowId, c.flowId, d.flowId, e.flowId].sort());
  assert.equal(graph.nodes.every(node => node.status === 'current'), true);
  assert.equal(graph.nextFlowId, undefined);

  const updatedSource = sourceSet(ids[11]!, source.objectSet.familyId);
  updatedSource.objectSet.revision = 2;
  updatedSource.objectSet.previousId = source.objectSet.id;
  const stale = projectDependencies(state([e, d, c, b, a], [re, rd, rc, rb, ra]),
    models([source, updatedSource, outputSet(a.flowId, ra.id), outputSet(b.flowId, rb.id),
      outputSet(c.flowId, rc.id), outputSet(d.flowId, rd.id), outputSet(e.flowId, re.id)]), owner);
  assert.equal(stale.nodes.find(node => node.flowId === a.flowId)?.status, 'needs_run');
  for (const dependent of [b, c, d, e]) {
    assert.equal(stale.nodes.find(node => node.flowId === dependent.flowId)?.status, 'waiting');
  }
  assert.deepEqual(stale.updateOrder, [a.flowId, b.flowId, c.flowId, d.flowId, e.flowId]);
  assert.equal(stale.nextFlowId, a.flowId);
});

test('uses latest publication provenance, classifies source and definition changes, and waits downstream', () => {
  const source = sourceSet(ids[0]!);
  const a1 = definition(ids[1]!, ids[1]!, source.objectSet.familyId);
  const a2 = definition(ids[2]!, a1.flowId, source.objectSet.familyId, [], 2);
  const b = definition(ids[3]!, ids[3]!, a1.flowId);
  const ready = run(ids[5]!, a1.flowId, a1.id, [sourceRef(source)]);
  const blocked = run(ids[6]!, a1.flowId, a2.id, [sourceRef(source)], 'blocked');
  const downstream = run(ids[7]!, b.flowId, b.id, [sourceRef(outputSet(a1.flowId, ready.id))]);
  const graph = projectDependencies(state([a1, a2, b], [ready, blocked, downstream]), models([source, outputSet(a1.flowId, ready.id), outputSet(b.flowId, downstream.id)]), owner);
  assert.equal(graph.nodes.find(node => node.flowId === a1.flowId)?.status, 'needs_run');
  assert.equal(graph.nodes.find(node => node.flowId === b.flowId)?.status, 'waiting');
  assert.equal(graph.nextFlowId, a1.flowId);
  assert.equal(graph.nodes.find(node => node.flowId === a1.flowId)?.published?.source.datasetId, `dataflow:${a1.flowId}:${ready.id}`);

  const changed = sourceSet(ids[10]!, source.objectSet.familyId, { schema: [{ name: 'id', type: 'string' }, { name: 'new', type: 'string' }] });
  changed.objectSet.revision = 2;
  changed.objectSet.previousId = source.objectSet.id;
  const drift = projectDependencies(state([a1], [ready]), models([source, changed, outputSet(a1.flowId, ready.id)]), owner);
  assert.equal(drift.nodes[0]!.status, 'needs_definition');

  const replacement = sourceSet(ids[9]!);
  const changedInput = definition(ids[10]!, a1.flowId, replacement.objectSet.familyId, [], 2);
  const changedPlan = projectDependencies(state([a1, changedInput], [ready]), models([source, replacement, outputSet(a1.flowId, ready.id)]), owner);
  assert.equal(changedPlan.nodes[0]!.status, 'needs_run');
});

test('keeps unpublished and orphaned derived sources explicit, isolates owners, and is deterministic', () => {
  const source = sourceSet(ids[0]!);
  const unpublished = definition(ids[1]!, ids[1]!, source.objectSet.familyId);
  const orphanFamily = ids[2]!;
  const orphan = sourceSet(orphanFamily, orphanFamily, { datasetId: `dataflow:${ids[9]}:${ids[10]}` });
  const orphanConsumer = definition(ids[3]!, ids[3]!, orphanFamily);
  const foreignDefinition = definition(ids[4]!, ids[4]!, ids[8]!);
  foreignDefinition.ownerId = foreign.ownerId;
  const foreignSource = sourceSet(ids[8]!, ids[8]!, foreign);
  const flowState = state([unpublished, orphanConsumer, foreignDefinition], []);
  const modelState = models([source, orphan, foreignSource]);
  const first = projectDependencies(flowState, modelState, owner);
  const second = projectDependencies({ definitions: { [orphanConsumer.id]: orphanConsumer, [unpublished.id]: unpublished, [foreignDefinition.id]: foreignDefinition }, runs: {}, requests: {} },
    { objectSets: { [foreignSource.objectSet.id]: foreignSource, [orphan.objectSet.id]: orphan, [source.objectSet.id]: source }, relationships: {}, requests: {} }, owner);
  assert.deepEqual(first, second);
  assert.equal(first.nodes.length, 2);
  assert.equal(first.nodes.find(node => node.flowId === unpublished.flowId)?.status, 'unpublished');
  assert.equal(first.nodes.find(node => node.flowId === orphanConsumer.flowId)?.status, 'unavailable');
  assert.match(first.nodes.find(node => node.flowId === orphanConsumer.flowId)!.issues.join(' '), /Produzenten|Herkunft/);
});

test('fails closed on cyclic latest definitions', () => {
  const a = definition(ids[1]!, ids[1]!, ids[2]!);
  const b = definition(ids[2]!, ids[2]!, ids[1]!);
  assert.throws(() => projectDependencies(state([a, b], []), models([]), owner), (error: unknown) => error instanceof DataflowError && error.statusCode === 503);
});
