import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { DatasetRecord } from '@koiforge/data-registry';
import type { SessionContext } from '@koiforge/security-core';
import type { AppRegistries } from '../src/registries.js';
import type { ImportRow } from '../src/import-capability/isolated-executor.js';
import { createSemanticModelService, SemanticModelError, type DataflowPublication } from '../src/semantic-model/service.js';
import { FileSemanticModelStore } from '../src/semantic-model/store.js';

const sessionFor = (ownerId = 'owner-a', tenantId = 'tenant-a', permissions = ['datasets.read', 'datasets.manage']): SessionContext => ({
  user: { id: ownerId, displayName: ownerId },
  tenant: { id: tenantId, name: tenantId, slug: tenantId, status: 'active' },
  roleIds: ['owner'], permissions,
});
const status = (code: number) => (error: unknown) => error instanceof SemanticModelError && error.statusCode === code;

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'koi-dataflow-publication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const datasets = new Map<string, DatasetRecord>();
  const identities = new Map<string, SessionContext>();
  const session = sessionFor();
  const identityKey = (value: SessionContext) => `${value.tenant.id}:${value.user.id}`;
  const allow = (value: SessionContext) => identities.set(identityKey(value), value);
  allow(session);
  const control = { resolves: 0, denyAt: Infinity, beforeResolve: undefined as undefined | (() => Promise<void>) };
  const registries = { dataset: {
    async getDataset(id: string) { const value = datasets.get(id); return value ? structuredClone(value) : undefined; },
    async previewRows() { throw new Error('Unexpected preview read.'); },
  } } as unknown as AppRegistries;
  const options = { root, registries,
    async resolvePrincipal(reference: { userId: string; tenantId: string }) {
      control.resolves++; await control.beforeResolve?.();
      if (control.resolves >= control.denyAt) return null;
      return identities.get(`${reference.tenantId}:${reference.userId}`) ?? null;
    },
    assertPermissions(current: SessionContext, required: string[]) {
      if (required.some(permission => !current.permissions.includes(permission))) throw new Error('Denied.');
    },
  };
  const service = createSemanticModelService(options);
  function dataset(id: string, rows: ImportRow[]): DatasetRecord {
    const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
    const value = { id, name: id, namespace: 'test', connectorId: 'inline', connectorCategory: 'file', mode: 'materialized', status: 'ready',
      source: { previewRows: rows, coverage: 'complete' }, schema: columns.map(name => ({ name, type: 'string' })),
      sqlAccess: {}, snapshots: [], tags: [], createdAt: '2026-09-24T10:00:00.000Z', updatedAt: '2026-09-24T10:00:00.000Z' } as unknown as DatasetRecord;
    datasets.set(id, value); return value;
  }
  async function source(id = randomUUID(), rows: ImportRow[] = [{ id: 'source-1', label: 'Source' }]) {
    dataset(id, rows);
    return service.createObjectSet(session, { name: 'Source', datasetId: id, keyField: 'id', labelField: 'label', confirmed: true, requestId: randomUUID() });
  }
  function publication(set: Awaited<ReturnType<typeof source>>, extra: Partial<DataflowPublication> = {}): DataflowPublication {
    return { flowId: randomUUID(), definitionId: randomUUID(), runId: randomUUID(), name: 'Published flow', keyField: 'id', labelField: 'label',
      rows: [{ id: 'result-1', label: 'Result' }], schema: [{ name: 'id', type: 'string' }, { name: 'label', type: 'string' }],
      createdAt: '2026-09-24T12:00:00.000Z', sources: [{ setId: set.id, snapshotHash: set.snapshotHash }], ...extra };
  }
  return { root, store: new FileSemanticModelStore(root), service, options, session, identities, allow, control, dataset, source, publication };
}

test('publishes a stable flow family and exact revisions without registering a raw dataset', async t => {
  const f = await fixture(t); const source = await f.source(); const beforeDatasets = f.options.registries.dataset;
  const input = f.publication(source); const first = await f.service.publishDataflow(f.session, input);
  assert.equal(first.id, input.flowId); assert.equal(first.familyId, input.flowId); assert.equal(first.revision, 1);
  assert.equal(first.previousId, undefined); assert.equal(first.createdAt, input.createdAt);
  assert.deepEqual(first.source, { datasetId: `dataflow:${input.flowId}:${input.runId}`, name: input.name,
    columns: ['id', 'label'], rowCount: 1, hash: first.source.hash, capturedAt: input.createdAt, coverage: 'complete' });
  assert.deepEqual(first.keyQuality, { totalRows: 1, identifiedRows: 1, missingKeys: 0, duplicateRows: 0, duplicateGroups: 0 });
  assert.deepEqual(await f.service.publishDataflow(f.session, structuredClone(input)), first);
  await assert.rejects(f.service.publishDataflow(f.session, { ...input, name: 'Changed payload' }), status(409));
  const secondInput = f.publication(source, { flowId: input.flowId, expectedPreviousId: first.id, createdAt: '2026-09-24T12:01:00.000Z' });
  const second = await f.service.publishDataflow(f.session, secondInput);
  assert.notEqual(second.id, first.id); assert.equal(second.familyId, first.id); assert.equal(second.revision, 2);
  assert.equal(second.previousId, first.id); assert.equal(f.options.registries.dataset, beforeDatasets);
  assert.equal((await f.service.getObjectSet(f.session, first.id)).rows[0]!.attributes.label, 'Result');
});

test('derived output families cannot be replaced through the ordinary source confirmation path', async t => {
  const f = await fixture(t); const source = await f.source();
  const firstInput = f.publication(source); const first = await f.service.publishDataflow(f.session, firstInput);
  const datasetId = randomUUID(); f.dataset(datasetId, [{ id: 'manual', label: 'Manual replacement' }]);
  const before = await readFile(f.store.path);
  await assert.rejects(f.service.createObjectSet(f.session, { name: 'Manual replacement', datasetId,
    keyField: 'id', labelField: 'label', previousId: first.id, confirmed: true, requestId: randomUUID() }), status(409));
  assert.deepEqual(await readFile(f.store.path), before);
  const second = await f.service.publishDataflow(f.session, f.publication(source, { flowId: first.familyId, expectedPreviousId: first.id }));
  assert.equal(second.revision, 2);
});

test('source freshness blocks new runs while an old receipt remains replayable', async t => {
  const f = await fixture(t); const datasetId = randomUUID(); const firstSource = await f.source(datasetId);
  const firstInput = f.publication(firstSource); const published = await f.service.publishDataflow(f.session, firstInput);
  f.dataset(datasetId, [{ id: 'source-2', label: 'New source' }]);
  const nextSource = await f.service.createObjectSet(f.session, { name: 'Source', datasetId, keyField: 'id', labelField: 'label',
    confirmed: true, requestId: randomUUID(), previousId: firstSource.id });
  await assert.rejects(f.service.publishDataflow(f.session, f.publication(firstSource)), status(409));
  assert.deepEqual(await f.service.publishDataflow(f.session, firstInput), published);
  const next = await f.service.publishDataflow(f.session, f.publication(nextSource, { flowId: firstInput.flowId, expectedPreviousId: published.id }));
  assert.equal(next.revision, 2);
  await assert.rejects(f.service.publishDataflow(f.session,
    f.publication(nextSource, { flowId: firstInput.flowId, expectedPreviousId: published.id })), status(409));
});

test('publication guards see queued semantic state without being able to mutate it', async t => {
  const f = await fixture(t); const source = await f.source();
  const firstInput = f.publication(source); const secondInput = f.publication(source);
  let entered!: () => void; let resume!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { resume = resolve; });
  const blockAt = f.control.resolves + 2;
  f.control.beforeResolve = async () => {
    if (f.control.resolves === blockAt) { entered(); await blocked; }
  };
  const firstWork = f.service.publishDataflow(f.session, firstInput);
  await waiting;
  f.control.beforeResolve = undefined;
  let guarded = false;
  const secondWork = f.service.publishDataflow(f.session, secondInput, state => {
    guarded = true;
    assert.equal(state.objectSets[firstInput.flowId]?.objectSet.source.datasetId,
      `dataflow:${firstInput.flowId}:${firstInput.runId}`);
    delete state.objectSets[firstInput.flowId];
  });
  resume();
  const [first, second] = await Promise.all([firstWork, secondWork]);
  assert(guarded);
  assert.equal((await f.service.getObjectSet(f.session, first.id)).objectSet.id, first.id);
  assert.equal((await f.service.getObjectSet(f.session, second.id)).objectSet.id, second.id);
});

test('publication guard rejection preserves semantic bytes and creates no receipt', async t => {
  const f = await fixture(t); const source = await f.source(); const input = f.publication(source);
  const beforeBytes = await readFile(f.store.path, 'utf8');
  const beforeState = await f.store.read();
  await assert.rejects(f.service.publishDataflow(f.session, input, state => {
    assert.equal(state.objectSets[source.id]?.objectSet.snapshotHash, source.snapshotHash);
    throw new SemanticModelError('Upstream publication is stale.', 409);
  }), status(409));
  assert.equal(await readFile(f.store.path, 'utf8'), beforeBytes);
  assert.deepEqual(await f.store.read(), beforeState);
});

test('successful publication receipt replay skips a newly failing guard', async t => {
  const f = await fixture(t); const source = await f.source(); const input = f.publication(source);
  const published = await f.service.publishDataflow(f.session, input);
  let calls = 0;
  const replayed = await f.service.publishDataflow(f.session, structuredClone(input), () => {
    calls++;
    throw new SemanticModelError('Guard must not run for a receipt replay.', 409);
  });
  assert.equal(calls, 0);
  assert.deepEqual(replayed, published);
});

test('simultaneous initial publications create one family and stale parents cannot branch it', async t => {
  const f = await fixture(t); const source = await f.source(); const flowId = randomUUID();
  const results = await Promise.allSettled([
    f.service.publishDataflow(f.session, f.publication(source, { flowId })),
    f.service.publishDataflow(f.session, f.publication(source, { flowId })),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejection = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert(status(409)(rejection.reason));
  const first = (results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<any>).value;
  const second = await f.service.publishDataflow(f.session, f.publication(source, { flowId, expectedPreviousId: first.id }));
  await assert.rejects(f.service.publishDataflow(f.session, f.publication(source, { flowId, expectedPreviousId: first.id })), status(409));
  assert.equal(second.revision, 2);
  assert.equal((await f.service.listObjectSets(f.session)).filter(set => set.familyId === flowId).length, 2);
});

test('source and parent ownership, tenant boundaries, and current manage permission are enforced', async t => {
  const f = await fixture(t); const source = await f.source();
  for (const outsider of [sessionFor('owner-b'), sessionFor('owner-a', 'tenant-b')]) {
    f.allow(outsider);
    await assert.rejects(f.service.publishDataflow(outsider, f.publication(source)), status(404));
  }
  const reader = sessionFor('owner-a', 'tenant-a', ['datasets.read']); f.allow(reader);
  await assert.rejects(f.service.publishDataflow(reader, f.publication(source)), status(403));
  f.allow(f.session);
  const firstInput = f.publication(source); const first = await f.service.publishDataflow(f.session, firstInput);
  const other = sessionFor('owner-b');
  await assert.rejects(f.service.publishDataflow(other,
    f.publication(source, { flowId: first.familyId, expectedPreviousId: first.id })), status(404));
});

test('publication snapshots caller input before awaiting and revocation before commit writes nothing', async t => {
  const f = await fixture(t); const source = await f.source(); const input = f.publication(source);
  let entered!: () => void; let resume!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { resume = resolve; });
  f.control.beforeResolve = async () => { entered(); await blocked; };
  const work = f.service.publishDataflow(f.session, input);
  await waiting; input.rows[0]!.label = 'Mutated'; input.schema[1]!.name = 'mutated'; f.control.beforeResolve = undefined; resume();
  const published = await work;
  assert.equal((await f.service.getObjectSet(f.session, published.id)).rows[0]!.attributes.label, 'Result');
  assert.deepEqual(published.source.columns, ['id', 'label']);

  const before = await readFile(f.store.path, 'utf8'); f.control.denyAt = f.control.resolves + 2;
  let guarded = false;
  await assert.rejects(f.service.publishDataflow(f.session, f.publication(source), () => { guarded = true; }), status(403));
  assert(guarded);
  assert.equal(await readFile(f.store.path, 'utf8'), before);
});

test('invalid schema, rows, keys, bindings and timestamps fail without overwriting semantic state', async t => {
  const f = await fixture(t); const source = await f.source(); const valid = f.publication(source);
  const before = await readFile(f.store.path, 'utf8');
  const invalid: unknown[] = [
    { ...valid, createdAt: '2026-09-24' },
    { ...valid, schema: [{ name: 'id', type: 'unsupported' }] },
    { ...valid, schema: [{ name: '__proto__', type: 'string' }], keyField: '__proto__' },
    { ...valid, rows: [{ id: null, label: 'Missing' }] },
    { ...valid, rows: [{ id: 'same' }, { id: 'same' }] },
    { ...valid, rows: [{ id: 'one', outside: 'schema' }] },
    { ...valid, keyField: 'absent' },
    { ...valid, sources: [] },
    { ...valid, sources: [valid.sources[0], valid.sources[0]] },
    { ...valid, sources: [{ setId: source.id, snapshotHash: 'bad' }] },
    { ...valid, extra: true },
  ];
  for (const input of invalid) await assert.rejects(f.service.publishDataflow(f.session, input as DataflowPublication), status(400));
  assert.equal(await readFile(f.store.path, 'utf8'), before);
});

test('corrupt semantic state fails closed and preserves its bytes', async t => {
  const f = await fixture(t); const source = await f.source(); const envelope = JSON.parse(await readFile(f.store.path, 'utf8'));
  envelope.state.objectSets[source.id].rows[0].id = 'tampered';
  const corrupt = JSON.stringify(envelope); await writeFile(f.store.path, corrupt);
  await assert.rejects(f.service.publishDataflow(f.session, f.publication(source)), /beschädigt/);
  assert.equal(await readFile(f.store.path, 'utf8'), corrupt);
});
