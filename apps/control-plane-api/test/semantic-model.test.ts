import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import type { DatasetRecord } from '@koiforge/data-registry';
import type { SessionContext } from '@koiforge/security-core';
import type { AppRegistries } from '../src/registries.js';
import { rowsHash, type ImportRow } from '../src/import-capability/isolated-executor.js';
import { createSemanticModelService, SemanticModelError } from '../src/semantic-model/service.js';
import { FileSemanticModelStore, SEMANTIC_LIMITS } from '../src/semantic-model/store.js';
import { registerSemanticModelRoutes } from '../src/routes/semantic-model.js';

const sessionFor = (ownerId = 'owner-a', tenantId = 'tenant-a', permissions = ['datasets.read', 'datasets.manage']): SessionContext => ({
  user: { id: ownerId, displayName: ownerId }, tenant: { id: tenantId, name: tenantId, slug: tenantId, status: 'active' }, roleIds: ['owner'], permissions,
});
const code = (statusCode: number) => (error: unknown) => error instanceof SemanticModelError && error.statusCode === statusCode;
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'koi-semantic-model-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const datasets = new Map<string, DatasetRecord>();
  const identities = new Map<string, SessionContext>();
  const session = sessionFor();
  const identityKey = (userId: string, tenantId: string) => `${tenantId}:${userId}`;
  const allow = (value: SessionContext) => identities.set(identityKey(value.user.id, value.tenant.id), value);
  allow(session);
  const control = { reads: 0, resolves: 0, denyAtResolve: Infinity, beforeDataset: undefined as undefined | (() => Promise<void>) };
  const registries = { dataset: {
    async getDataset(id: string) { control.reads++; await control.beforeDataset?.(); const value = datasets.get(id); return value ? structuredClone(value) : undefined; },
    async previewRows() { throw new Error('Semantic snapshots must never call a second preview read.'); },
  } } as unknown as AppRegistries;
  const options = { root, registries,
    async resolvePrincipal(reference: { userId: string; tenantId: string }) {
      control.resolves++;
      if (control.resolves >= control.denyAtResolve) return null;
      return identities.get(identityKey(reference.userId, reference.tenantId)) ?? null;
    },
    assertPermissions(current: SessionContext, required: string[]) {
      if (required.some(permission => !current.permissions.includes(permission))) throw new Error('Denied.');
    },
  };
  const service = createSemanticModelService(options);
  function dataset(id: string, rows: ImportRow[]): DatasetRecord {
    const names = [...new Set(rows.flatMap(row => Object.keys(row)))];
    const record = { id, name: id, namespace: 'test', connectorId: 'inline', connectorCategory: 'file', mode: 'materialized', status: 'ready',
      source: { previewRows: rows }, schema: names.map(name => ({ name, type: 'string' })), sqlAccess: {}, snapshots: [], tags: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as unknown as DatasetRecord;
    datasets.set(id, record); return record;
  }
  const objectInput = (datasetId: string, extra: Record<string, unknown> = {}) => ({ name: `Model ${datasetId}`, datasetId, keyField: 'id', confirmed: true, requestId: randomUUID(), ...extra });
  const relationshipInput = (fromSetId: string, toSetId: string, extra: Record<string, unknown> = {}) => ({
    name: 'Confirmed relationship', fromSetId, toSetId, fromField: 'ref', confirmed: true, requestId: randomUUID(), ...extra,
  });
  return { root, store: new FileSemanticModelStore(root), service, options, session, control, identities, allow, identityKey,
    dataset, datasets, objectInput, relationshipInput };
}

test('whole-source object identities are type exact; missing and duplicate IDs remain visible', async t => {
  const f = await fixture(t);
  const source = f.dataset('objects', [
    { id: 1 }, { id: '1' }, { id: 0 }, { id: false }, { id: 'D' }, { id: 'D' }, { id: null }, {}, { id: ' \t ' }, { id: 'toString' },
  ]);
  const set = await f.service.createObjectSet(f.session, f.objectInput(source.id));
  assert.equal(f.control.reads, 1);
  assert.deepEqual(set.keyQuality, { totalRows: 10, identifiedRows: 5, missingKeys: 3, duplicateRows: 2, duplicateGroups: 1 });
  assert.equal(set.source.hash, rowsHash(source.source.previewRows as ImportRow[]));
  assert.match(set.snapshotHash, /^[a-f0-9]{64}$/);
  assert.equal(set.confirmedBy, f.session.user.id);
  const detail = await f.service.getObjectSet(f.session, set.id);
  assert.deepEqual(detail.rows.slice(0, 4).map(row => row.key), [1, '1', 0, false]);
  assert.deepEqual(detail.rows.slice(0, 4).map(row => row.identity), Array(4).fill('unique'));
  assert.deepEqual(detail.rows.slice(4, 6).map(row => row.identity), ['duplicate', 'duplicate']);
  assert.deepEqual(detail.rows.slice(6, 9).map(row => row.identity), ['missing', 'missing', 'missing']);
  assert.equal((await stat(f.store.path)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(f.store.path))).mode & 0o777, 0o700);
  assert.equal((await f.store.read()).objectSets[set.id]!.confirmed, true);
});

test('prototype-named fields never turn absent IDs or references into inherited values', async t => {
  const f = await fixture(t);
  f.dataset('prototype-targets', [{ toString: 'known' }, {}, {}]);
  f.dataset('prototype-sources', [{ id: 'a', valueOf: 'known' }, { id: 'b' }]);
  const to = await f.service.createObjectSet(f.session, f.objectInput('prototype-targets', { keyField: 'toString' }));
  const from = await f.service.createObjectSet(f.session, f.objectInput('prototype-sources'));
  assert.equal(to.keyQuality.missingKeys, 2); assert.equal(to.keyQuality.duplicateGroups, 0);
  const relation = await f.service.createRelationship(f.session, f.relationshipInput(from.id, to.id, { fromField: 'valueOf' }));
  assert.equal(relation.counts.linkedRows, 1); assert.equal(relation.counts.missingReferences, 1);
});

test('relationship counts form a disjoint partition and ambiguous targets never pick an arbitrary row', async t => {
  const f = await fixture(t);
  f.dataset('targets', [{ id: 1 }, { id: '1' }, { id: 0 }, { id: false }, { id: 'D' }, { id: 'D' }, { id: null }, { id: '' }]);
  f.dataset('sources', [
    { id: 's1', ref: 1 }, { id: 's2', ref: '1' }, { id: 's3', ref: 0 }, { id: 's4', ref: false },
    { id: 's5', ref: 'D' }, { id: 's6', ref: 'absent' }, { id: 's7', ref: null }, { id: 's8' },
    { id: null, ref: 1 }, { id: 'duplicate', ref: null }, { id: 'duplicate', ref: 'D' }, { id: 's9', ref: ' \t ' },
  ]);
  const to = await f.service.createObjectSet(f.session, f.objectInput('targets'));
  const from = await f.service.createObjectSet(f.session, f.objectInput('sources'));
  const relation = await f.service.createRelationship(f.session, f.relationshipInput(from.id, to.id));
  assert.deepEqual(relation.counts, { sourceRows: 12, linkedRows: 4, missingReferences: 3,
    unmatchedReferences: 1, ambiguousReferences: 1, invalidSourceRows: 3 });
  const detail = await f.service.getRelationship(f.session, relation.id);
  assert.deepEqual(detail.rows.slice(0, 3).map(row => row.sourceRow), [9, 10, 11]);
  assert.deepEqual(detail.rows.slice(0, 3).map(row => row.targetRows), [[], [], []]);
  assert.deepEqual(detail.rows.filter(row => row.status === 'linked').map(row => row.targetRows), [[1], [2], [3], [4]]);
  const ambiguous = detail.rows.find(row => row.status === 'ambiguous_reference')!;
  assert.deepEqual(ambiguous.targetRows, [5, 6]); assert.equal(ambiguous.targetLabel, undefined);
  assert.equal(ambiguous.targetRowCount, 2); assert.equal(detail.rows.length, 12);
  assert.deepEqual(relation.evidence, { sourceHash: from.source.hash, targetHash: to.source.hash, fromRevision: 1, toRevision: 1 });
});

test('pagination and ambiguous-target evidence stay bounded without losing source positions or full counts', async t => {
  const f = await fixture(t);
  f.dataset('targets', Array.from({ length: 500 }, () => ({ id: 'D' })));
  f.dataset('sources', Array.from({ length: 205 }, (_, i) => ({ id: `s${i}`, ref: 'D' })));
  const to = await f.service.createObjectSet(f.session, f.objectInput('targets'));
  const from = await f.service.createObjectSet(f.session, f.objectInput('sources'));
  const relation = await f.service.createRelationship(f.session, f.relationshipInput(from.id, to.id));
  const detail = await f.service.getRelationship(f.session, relation.id, { offset: 100, limit: 50 });
  assert.equal(detail.relationship.counts.ambiguousReferences, 205); assert.equal(detail.totalRows, 205);
  assert.equal(detail.rows.length, 50); assert.equal(detail.offset, 100); assert.equal(detail.truncated, true);
  assert.equal(detail.rows[0]!.sourceRow, 101); assert.equal(detail.rows[49]!.sourceRow, 150);
  assert.equal(detail.rows[0]!.targetRows.length, 20); assert.equal(detail.rows[0]!.targetRowCount, 500);
  assert.equal(detail.rows[0]!.targetRowsTruncated, true);
  assert.equal((await f.service.relationshipForMission({ ownerId: f.session.user.id, tenantId: f.session.tenant.id }, relation.id)).rows.length, 100);
  const objectPage = await f.service.getObjectSet(f.session, from.id, { offset: 200, limit: 100 });
  assert.equal(objectPage.rows.length, 5); assert.equal(objectPage.rows[0]!.sourceRow, 201);
  await assert.rejects(f.service.getObjectSet(f.session, from.id, { limit: 101 }), code(400));
  await assert.rejects(f.service.getRelationship(f.session, relation.id, { offset: -1 }), code(400));
});

test('new revisions are immutable, latest-CAS rejects stale parents and pinned relationships retain old sources', async t => {
  const f = await fixture(t);
  f.dataset('target', [{ id: 'T', label: 'old label' }]); f.dataset('source', [{ id: 'S', ref: 'T' }]);
  const first = await f.service.createObjectSet(f.session, f.objectInput('target', { labelField: 'label' }));
  const source = await f.service.createObjectSet(f.session, f.objectInput('source'));
  const relation = await f.service.createRelationship(f.session, f.relationshipInput(source.id, first.id));
  f.dataset('target', [{ id: 'U', label: 'new label' }]);
  const nextInput = f.objectInput('target', { previousId: first.id, labelField: 'label' });
  const outcomes = await Promise.allSettled([
    f.service.createObjectSet(f.session, nextInput),
    f.service.createObjectSet(f.session, { ...nextInput, requestId: randomUUID() }),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  const denied = outcomes.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert(code(409)(denied.reason));
  const next = (outcomes.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<typeof first>).value;
  assert.equal(next.familyId, first.familyId); assert.equal(next.revision, 2); assert.equal(next.previousId, first.id);
  assert.notEqual(next.id, first.id);
  assert.equal((await f.service.getObjectSet(f.session, first.id)).rows[0]!.label, 'old label');
  assert.equal((await f.service.getObjectSet(f.session, next.id)).rows[0]!.label, 'new label');
  const pinned = await f.service.getRelationship(f.session, relation.id);
  assert.equal(pinned.rows[0]!.status, 'linked'); assert.equal(pinned.rows[0]!.targetLabel, 'old label');
  assert.equal(pinned.to.id, first.id); assert.equal(pinned.relationship.evidence.toRevision, 1);
});

test('owner-operation-scoped idempotency survives restart and normalizes names without rereading sources', async t => {
  const f = await fixture(t); f.dataset('objects', [{ id: 0 }]);
  const input = f.objectInput('objects', { name: '  Model  ' });
  const first = await f.service.createObjectSet(f.session, input);
  const restarted = createSemanticModelService(f.options);
  f.datasets.delete('objects');
  const replay = await restarted.createObjectSet(f.session, { ...input, name: 'Model' });
  assert.deepEqual(replay, first); assert.equal(f.control.reads, 1);
  await assert.rejects(restarted.createObjectSet(f.session, { ...input, name: 'Changed' }), code(409));
  f.dataset('objects', [{ id: 0, ref: 0 }]);
  const other = sessionFor('owner-b'); f.allow(other);
  const independentlyCreated = await restarted.createObjectSet(other, input);
  assert.notEqual(independentlyCreated.id, first.id);
  const relationInput = f.relationshipInput(first.id, first.id, { fromField: 'id', requestId: input.requestId });
  const relation = await restarted.createRelationship(f.session, relationInput);
  assert.notEqual(relation.id, first.id);
  assert.deepEqual(await createSemanticModelService(f.options).createRelationship(f.session, relationInput), relation);
  await assert.rejects(restarted.createRelationship(f.session, { ...relationInput, name: 'Changed' }), code(409));
});

test('schema and confirmed bindings contribute to snapshotHash while source.hash remains rowsHash', async t => {
  const f = await fixture(t); const dataset = f.dataset('objects', [{ id: 'A', other: 'B' }]);
  const one = await f.service.createObjectSet(f.session, f.objectInput(dataset.id));
  dataset.schema[0]!.type = 'number';
  const two = await f.service.createObjectSet(f.session, f.objectInput(dataset.id));
  const three = await f.service.createObjectSet(f.session, f.objectInput(dataset.id, { keyField: 'other' }));
  assert.equal(one.source.hash, two.source.hash); assert.equal(two.source.hash, three.source.hash);
  assert.notEqual(one.snapshotHash, two.snapshotHash); assert.notEqual(two.snapshotHash, three.snapshotHash);
});

test('ownership and current permissions isolate all reads, revisions, relations and mission access', async t => {
  const f = await fixture(t); f.dataset('objects', [{ id: 'A', ref: 'A' }]);
  const object = await f.service.createObjectSet(f.session, f.objectInput('objects'));
  const relation = await f.service.createRelationship(f.session, f.relationshipInput(object.id, object.id));
  for (const other of [sessionFor('owner-b'), sessionFor('owner-a', 'tenant-b')]) {
    f.allow(other);
    assert.deepEqual(await f.service.listObjectSets(other), []); assert.deepEqual(await f.service.listRelationships(other), []);
    await assert.rejects(f.service.getObjectSet(other, object.id), code(404));
    await assert.rejects(f.service.getRelationship(other, relation.id), code(404));
    await assert.rejects(f.service.createObjectSet(other, f.objectInput('objects', { previousId: object.id })), code(404));
    await assert.rejects(f.service.createRelationship(other, f.relationshipInput(object.id, object.id)), code(404));
    await assert.rejects(f.service.relationshipForMission({ ownerId: other.user.id, tenantId: other.tenant.id }, relation.id), code(404));
  }
  const readOnly = sessionFor('owner-a', 'tenant-a', ['datasets.read']); f.allow(readOnly);
  assert.equal((await f.service.listObjectSets(readOnly)).length, 1);
  await assert.rejects(f.service.createObjectSet(f.session, f.objectInput('objects')), code(403));
  await assert.rejects(f.service.relationshipForMission({ ownerId: 'owner-a', tenantId: 'tenant-a' }, relation.id), code(403));
});

test('revocation during source capture or directly before relation commit leaves no records or receipts', async t => {
  const f = await fixture(t); f.dataset('objects', [{ id: 'A', ref: 'A' }]);
  let resume!: () => void; let entered!: () => void;
  const blocked = new Promise<void>(resolve => { resume = resolve; });
  const reading = new Promise<void>(resolve => { entered = resolve; });
  f.control.beforeDataset = async () => { entered(); await blocked; };
  const input = f.objectInput('objects'); const work = f.service.createObjectSet(f.session, input);
  await reading; f.identities.clear(); resume();
  await assert.rejects(work, code(403));
  assert.deepEqual(await f.store.read(), { objectSets: {}, relationships: {}, requests: {} });
  f.allow(f.session); f.control.beforeDataset = undefined;
  const set = await f.service.createObjectSet(f.session, input);
  const before = await readFile(f.store.path, 'utf8');
  f.control.denyAtResolve = f.control.resolves + 2;
  await assert.rejects(f.service.createRelationship(f.session, f.relationshipInput(set.id, set.id)), code(403));
  assert.equal(await readFile(f.store.path, 'utf8'), before);
});

test('strict input rejects unconfirmed, unknown, unsafe and unsupported source contracts', async t => {
  const f = await fixture(t); const dataset = f.dataset('objects', [{ id: 'A' }]);
  const valid = f.objectInput('objects');
  for (const input of [null, [], { ...valid, confirmed: false }, { ...valid, extra: 'ignored?' }, { ...valid, requestId: 'bad' },
    { ...valid, previousId: '../escape' }, { ...valid, keyField: '__proto__' }, { ...valid, labelField: '' },
    JSON.parse(JSON.stringify(valid).replace(/}$/, ',"__proto__":{"polluted":true}}'))]) {
    await assert.rejects(f.service.createObjectSet(f.session, input), code(400));
  }
  dataset.connectorId = 'postgres';
  await assert.rejects(f.service.createObjectSet(f.session, valid), code(400));
  dataset.connectorId = 'inline'; dataset.source.coverage = 'partial';
  await assert.rejects(f.service.createObjectSet(f.session, valid), code(400));
  dataset.source.coverage = 'complete'; dataset.schema = [{ name: 'wrong', type: 'string' }];
  await assert.rejects(f.service.createObjectSet(f.session, valid), code(400));
  assert.deepEqual(await f.store.read(), { objectSets: {}, relationships: {}, requests: {} });
});

test('corruption of rows, schema, bindings, counts or JSON fails closed and preserves original bytes', async t => {
  const f = await fixture(t); f.dataset('objects', [{ id: 'A', ref: 'A' }]);
  const set = await f.service.createObjectSet(f.session, f.objectInput('objects'));
  const original = await readFile(f.store.path, 'utf8');
  const corruptions: Array<(value: any) => void> = [
    value => { value.state.objectSets[set.id].rows[0].id = 'changed'; },
    value => { value.state.objectSets[set.id].schema[0].type = 'number'; },
    value => { value.state.objectSets[set.id].objectSet.keyField = 'ref'; },
    value => { value.state.objectSets[set.id].objectSet.keyQuality.identifiedRows = 0; },
  ];
  for (const change of corruptions) {
    const state = JSON.parse(original); change(state); const damaged = JSON.stringify(state);
    await writeFile(f.store.path, damaged);
    await assert.rejects(f.service.getObjectSet(f.session, set.id), /beschädigt/);
    await assert.rejects(f.service.createObjectSet(f.session, f.objectInput('objects')), /beschädigt/);
    assert.equal(await readFile(f.store.path, 'utf8'), damaged);
  }
  await writeFile(f.store.path, '{broken');
  await assert.rejects(f.service.listObjectSets(f.session)); assert.equal(await readFile(f.store.path, 'utf8'), '{broken');
  await writeFile(f.store.path, original); await truncate(f.store.path, SEMANTIC_LIMITS.maxStateBytes + 1);
  await assert.rejects(f.service.listObjectSets(f.session), /beschädigt/);
  assert.equal((await stat(f.store.path)).size, SEMANTIC_LIMITS.maxStateBytes + 1);
});

test('HTTP routes enforce sessions and strict bodies, expose summaries and bound detail pages', async t => {
  const f = await fixture(t); f.dataset('objects', [{ id: 'A', ref: 'A' }]);
  const app = Fastify(); t.after(() => app.close());
  app.addHook('onRequest', async request => { if (request.headers['x-test-session'] === 'owner') request.koiforgeSession = f.session; });
  registerSemanticModelRoutes(app, f.service);
  assert.equal((await app.inject('/api/model/object-sets')).statusCode, 401);
  const headers = { 'x-test-session': 'owner' };
  const created = await app.inject({ method: 'POST', url: '/api/model/object-sets', headers, payload: f.objectInput('objects') });
  assert.equal(created.statusCode, 200, created.body); const id = created.json().objectSet.id;
  const list = await app.inject({ url: '/api/model/object-sets', headers });
  assert.equal(list.json().items.length, 1); assert.equal(list.json().items[0].rows, undefined);
  const detail = await app.inject({ url: `/api/model/object-sets/${id}?offset=0&limit=1`, headers });
  assert.equal(detail.statusCode, 200, detail.body); assert.equal(detail.json().rows[0].sourceRow, 1);
  for (const query of ['limit=101', 'limit=0', 'offset=-1', 'limit=one', 'offset=0&extra=1']) {
    assert.equal((await app.inject({ url: `/api/model/object-sets/${id}?${query}`, headers })).statusCode, 400);
  }
  assert.equal((await app.inject({ url: '/api/model/object-sets/not-a-uuid', headers })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/model/object-sets', headers: { ...headers, 'content-type': 'application/json' }, payload: 'null' })).statusCode, 400);
  const related = await app.inject({ method: 'POST', url: '/api/model/relationships', headers, payload: f.relationshipInput(id, id) });
  assert.equal(related.statusCode, 200, related.body);
  const relationDetail = await app.inject({ url: `/api/model/relationships/${related.json().relationship.id}?limit=1`, headers });
  assert.equal(relationDetail.statusCode, 200, relationDetail.body); assert.equal(relationDetail.json().relationship.counts.linkedRows, 1);
});
