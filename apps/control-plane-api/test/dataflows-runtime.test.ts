import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import Fastify from 'fastify';
import type { SessionContext } from '@koiforge/security-core';
import { FileDatasetRegistry } from '@koiforge/data-registry';
import { createSemanticModelService, SemanticModelError } from '../src/semantic-model/service.js';
import { FileSemanticModelStore } from '../src/semantic-model/store.js';
import { createObjectWorkspaceService } from '../src/object-workspace/service.js';
import { createProjectService } from '../src/projects/service.js';
import { createDataflowService } from '../src/dataflows/service.js';
import { FileDataflowStore } from '../src/dataflows/store.js';
import { DataflowError, type FlowSpec } from '../src/dataflows/contracts.js';
import { registerDataflowRoutes } from '../src/routes/dataflows.js';

const owner: SessionContext = { user: { id: randomUUID(), displayName: 'Owner' }, tenant: { id: 'firm', slug: 'firm', name: 'Firm', status: 'active' },
  roleIds: ['owner'], permissions: ['datasets.read', 'datasets.manage', 'projects.read', 'projects.manage', 'objects.read'] };
const other = { ...owner, user: { id: randomUUID(), displayName: 'Other' } };
const foreign = { ...owner, tenant: { ...owner.tenant, id: 'foreign' } };
const reader = { ...owner, user: { id: randomUUID(), displayName: 'Reader' }, roleIds: ['project_reader'], permissions: ['projects.read', 'objects.read'] };
const code = (expected: number) => (error: unknown) => (error instanceof DataflowError || error instanceof SemanticModelError) && error.statusCode === expected;
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'koi-dataflows-')); t.after(() => rm(root, { recursive: true, force: true }));
  const control = { calls: 0, denyAt: Infinity, disabled: false };
  const authority = { async resolvePrincipal(ref: { userId: string; tenantId: string }) {
    control.calls++; if (control.disabled || control.calls >= control.denyAt) return null;
    return [owner, other, foreign, reader].find(s => s.user.id === ref.userId && s.tenant.id === ref.tenantId) ?? null;
  }, assertPermissions(s: SessionContext, permissions: string[]) { assert(permissions.every(p => s.permissions.includes(p))); } };
  const dataset = new FileDatasetRegistry({ filePath: join(root, 'datasets.json') });
  const model = createSemanticModelService({ root, registries: { dataset }, ...authority });
  async function source(name: string, rows: Array<Record<string, string | number | boolean | null>>, previousId?: string) {
    const d = await dataset.registerInlineDataset({ name, namespace: `flows_${randomUUID()}`, rows });
    return model.createObjectSet(owner, { name, datasetId: d.id, keyField: 'id', confirmed: true, requestId: randomUUID(), ...(previousId ? { previousId } : {}) });
  }
  const customers = await source('Kunden', [{ id: 'C1', name: 'Ada' }]);
  const projects = await source('Projekte', [{ id: 'P1', customer: 'C1', stage: 'open' }]);
  const tickets = await source('Tickets', Array.from({ length: 225 }, (_, i) => ({ id: `T${i}`, project: 'P1', urgent: i >= 200 })));
  const spec: FlowSpec = { name: 'Kritische Kundentickets', description: 'Drei vollständige Quellen', inputFamilyId: tickets.familyId,
    keyField: 'id', labelField: 'customerName', joins: [
      { familyId: projects.familyId, leftField: 'project', rightField: 'id', fields: [{ source: 'customer', target: 'customerId' }, { source: 'stage', target: 'stage' }], required: true },
      { familyId: customers.familyId, leftField: 'customerId', rightField: 'id', fields: [{ source: 'name', target: 'customerName' }], required: true },
    ], filters: [{ field: 'urgent', operator: 'eq', value: true }], minRows: 1 };
  const options = { root, semanticModel: model, ...authority }; const service = createDataflowService(options);
  const store = new FileDataflowStore(root); const models = new FileSemanticModelStore(root);
  const define = () => service.save(owner, { spec, confirmed: true, requestId: randomUUID() });
  let session: SessionContext | undefined = owner; const app = Fastify();
  app.addHook('preHandler', async r => { r.koiforgeSession = session as SessionContext; }); registerDataflowRoutes(app, service); await app.ready(); t.after(() => app.close());
  return { root, control, authority, dataset, model, source, customers, projects, tickets, spec, options, service, store, models, define, app, session(s?: SessionContext) { session = s; } };
}

test('three complete sources produce reproducible frozen output, typed filters and a shareable object family', async t => {
  const f = await fixture(t); const d = await f.define(); const modelsBefore = await readFile(f.models.path, 'utf8');
  const input = { definitionId: d.id, requestId: randomUUID(), confirmed: true };
  const run = await f.service.run(owner, d.flowId, input);
  assert.equal(run.status, 'ready', run.issues.join('; ')); assert.equal(run.rowCount, 25); assert.equal(run.sources.length, 3);
  assert.equal(run.sources.find(s => s.familyId === f.tickets.id)?.rowCount, 225);
  assert.equal(await readFile(f.models.path, 'utf8'), modelsBefore, 'run never publishes implicitly');
  const last = await f.service.getRun(owner, d.flowId, run.id, { offset: '24', limit: '1' });
  assert.deepEqual(last.rows[0], { id: 'T224', project: 'P1', urgent: true, customerId: 'C1', stage: 'open', customerName: 'Ada' });
  assert.deepEqual(await f.service.run(owner, d.flowId, input), run);
  const output = await f.service.publish(owner, d.flowId, run.id, { confirmed: true });
  assert.equal(output.familyId, d.flowId); assert.equal(output.source.rowCount, 25); assert.equal(output.keyQuality.identifiedRows, 25);
  const projects = createProjectService({ root: f.root, ...f.authority, listTeam: async () => [{ id: reader.user.id, status: 'active' }] });
  const shared = await projects.create(owner, { name: 'Nur Ergebnis', description: '', familyIds: [output.familyId], memberIds: [reader.user.id], confirmed: true, requestId: randomUUID() });
  const explorer = createObjectWorkspaceService({ root: f.root, ...f.authority, projects });
  assert.deepEqual((await explorer.listFamilies(reader, { projectId: shared.id })).map(s => s.id), [output.familyId]);
  assert.equal((await explorer.listObjects(reader, output.familyId, { projectId: shared.id })).items[24]?.attributes.customerName, 'Ada');
  assert.deepEqual((await createDataflowService(f.options).get(owner, d.flowId)).published, output);
});

test('new valid source revisions preserve logical object IDs and earlier evidence through publication retries', async t => {
  const f = await fixture(t); const d = await f.define();
  const run1 = await f.service.run(owner, d.flowId, { definitionId: d.id, requestId: randomUUID(), confirmed: true });
  const output1 = await f.service.publish(owner, d.flowId, run1.id, { confirmed: true });
  const explorer = createObjectWorkspaceService({ root: f.root, ...f.authority });
  const object1 = (await explorer.listObjects(owner, d.flowId, { q: 'T224' })).items[0]!;
  const next = await f.source('Kunden', [{ id: 'C1', name: 'Bea' }], f.customers.id);
  assert.equal((await f.service.getRun(owner, d.flowId, run1.id)).run.sourcesChanged, true);
  const run2 = await f.service.run(owner, d.flowId, { definitionId: d.id, requestId: randomUUID(), confirmed: true });
  assert.equal(run2.sources.find(s => s.familyId === f.customers.id)?.setId, next.id);
  const [output2, retry] = await Promise.all([f.service.publish(owner, d.flowId, run2.id, { confirmed: true }), f.service.publish(owner, d.flowId, run2.id, { confirmed: true })]);
  assert.deepEqual(output2, retry); assert.equal(output2.revision, 2); assert.equal(output2.previousId, output1.id);
  const object2 = (await explorer.listObjects(owner, d.flowId, { q: 'T224' })).items[0]!; assert.equal(object2.objectId, object1.objectId);
  assert.equal(object2.attributes.customerName, 'Bea');
  assert.equal((await explorer.getObject(owner, d.flowId, object1.objectId!, { setId: output1.id })).object?.attributes.customerName, 'Ada');
  assert.deepEqual(await f.service.publish(owner, d.flowId, run1.id, { confirmed: true }), output1, 'retry cannot roll back current output');
  assert.equal((await f.service.get(owner, d.flowId)).published?.id, output2.id);
});

test('quality failures and changed schemas remain blocked while the previous published output stays usable', async t => {
  const f = await fixture(t); const d = await f.define();
  const good = await f.service.run(owner, d.flowId, { definitionId: d.id, requestId: randomUUID(), confirmed: true });
  const output = await f.service.publish(owner, d.flowId, good.id, { confirmed: true });
  const badSource = await f.source('Projekte', [{ id: 'P1', customer: 'MISSING', stage: 'open' }], f.projects.id);
  const blocked = await f.service.run(owner, d.flowId, { definitionId: d.id, requestId: randomUUID(), confirmed: true });
  assert.equal(blocked.status, 'blocked'); assert(blocked.issues.length); assert.equal(blocked.rowCount, 0);
  await assert.rejects(f.service.publish(owner, d.flowId, blocked.id, { confirmed: true }), code(409));
  const fixed = await f.source('Projekte', [{ id: 'P1', customer: 'C1', stage: 'open', newField: 'schema-change' }], badSource.id);
  const changed = await f.service.run(owner, d.flowId, { definitionId: d.id, requestId: randomUUID(), confirmed: true });
  assert.equal(changed.status, 'blocked'); assert.match(changed.issues.join(' '), /Schema/); assert.equal(changed.sources.find(s => s.familyId === f.projects.id)?.setId, fixed.id);
  assert.equal((await f.service.get(owner, d.flowId)).published?.id, output.id);
  const revised = await f.service.save(owner, { spec: f.spec, previousId: d.id, confirmed: true, requestId: randomUUID() });
  assert.equal(revised.revision, 2); assert.notEqual(revised.definitionHash, d.definitionHash);
  const ready = await f.service.run(owner, d.flowId, { definitionId: revised.id, requestId: randomUUID(), confirmed: true });
  assert.equal(ready.status, 'ready'); assert.equal((await f.service.publish(owner, d.flowId, ready.id, { confirmed: true })).revision, 2);
});

test('concurrent definition edits, repeated requests and stale source publication cannot overwrite a newer state', async t => {
  const f = await fixture(t); const requestId = randomUUID(); const input = { spec: f.spec, confirmed: true, requestId };
  const [d, retry] = await Promise.all([f.service.save(owner, input), createDataflowService(f.options).save(owner, input)]); assert.deepEqual(d, retry);
  await assert.rejects(f.service.save(owner, { ...input, spec: { ...f.spec, name: 'Different' } }), code(409));
  const run = await f.service.run(owner, d.flowId, { definitionId: d.id, requestId: randomUUID(), confirmed: true });
  await f.source('Kunden', [{ id: 'C1', name: 'New' }], f.customers.id);
  await assert.rejects(f.service.publish(owner, d.flowId, run.id, { confirmed: true }), code(409));
  const edits = await Promise.allSettled([f.service.save(owner, { spec: f.spec, previousId: d.id, confirmed: true, requestId: randomUUID() }),
    createDataflowService(f.options).save(owner, { spec: { ...f.spec, minRows: 2 }, previousId: d.id, confirmed: true, requestId: randomUUID() })]);
  assert.equal(edits.filter(e => e.status === 'fulfilled').length, 1); assert.equal((edits.find(e => e.status === 'rejected') as PromiseRejectedResult).reason.statusCode, 409);
  await assert.rejects(f.service.run(owner, d.flowId, { definitionId: d.id, requestId: randomUUID(), confirmed: true }), code(409));
});

test('saved dependencies reject direct and transitive feedback into their own output', async t => {
  const f = await fixture(t); const a = await f.define();
  const r = await f.service.run(owner, a.flowId, { definitionId: a.id, requestId: randomUUID(), confirmed: true }); await f.service.publish(owner, a.flowId, r.id, { confirmed: true });
  const b = await f.service.save(owner, { spec: { ...f.spec, name: 'Downstream', inputFamilyId: a.flowId, joins: [], filters: [] }, confirmed: true, requestId: randomUUID() });
  const rb = await f.service.run(owner, b.flowId, { definitionId: b.id, requestId: randomUUID(), confirmed: true }); await f.service.publish(owner, b.flowId, rb.id, { confirmed: true });
  for (const familyId of [a.flowId, b.flowId]) await assert.rejects(f.service.save(owner, { spec: { ...f.spec, inputFamilyId: familyId, joins: [], filters: [] }, previousId: a.id, confirmed: true, requestId: randomUUID() }), code(400));
});

test('owner, tenant, reader, live authority and route validation protect every flow operation', async t => {
  const f = await fixture(t); const d = await f.define(); const run = await f.service.run(owner, d.flowId, { definitionId: d.id, requestId: randomUUID(), confirmed: true });
  for (const session of [other, foreign]) {
    assert.deepEqual(await f.service.list(session), []); await assert.rejects(f.service.get(session, d.flowId), code(404));
    await assert.rejects(f.service.publish(session, d.flowId, run.id, { confirmed: true }), code(404));
  }
  const forged = { ...reader, roleIds: ['owner'], permissions: owner.permissions };
  for (const session of [reader, forged]) { await assert.rejects(f.service.list(session), code(403)); await assert.rejects(f.service.save(session, { spec: f.spec, confirmed: true, requestId: randomUUID() }), code(403)); }
  const before = await readFile(f.store.path, 'utf8'); f.control.denyAt = f.control.calls + 2;
  await assert.rejects(f.service.save(owner, { spec: f.spec, previousId: d.id, confirmed: true, requestId: randomUUID() }), code(403));
  assert.equal(await readFile(f.store.path, 'utf8'), before); f.control.denyAt = Infinity;
  for (const query of ['limit=101', 'offset=-1', 'limit=1&limit=2', 'anything=x']) assert.equal((await f.app.inject(`/api/dataflows/${d.flowId}/runs/${run.id}?${query}`)).statusCode, 400);
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/dataflows/${d.flowId}/runs/${run.id}/publish`, payload: { confirmed: true, rows: [] } })).statusCode, 400);
  f.session(); assert.equal((await f.app.inject('/api/dataflows')).statusCode, 401);
});

test('oversized joined schemas persist a bounded blocked run that remains readable after restart', async t => {
  const f = await fixture(t);
  const wide = await f.source('Breite Quelle', [Object.fromEntries([
    ['id', 'C1'], ...Array.from({ length: 511 }, (_, i) => [`field_${i}`, 'value']),
  ])]);
  const d = await f.service.save(owner, { confirmed: true, requestId: randomUUID(), spec: {
    name: 'Breite Ausgabe', description: '', inputFamilyId: wide.familyId, keyField: 'id', minRows: 1, filters: [],
    joins: [{ familyId: f.customers.familyId, leftField: 'id', rightField: 'id', required: true, fields: [{ source: 'name', target: 'customerName' }] }],
  } });
  const run = await f.service.run(owner, d.flowId, { definitionId: d.id, requestId: randomUUID(), confirmed: true });
  assert.equal(run.status, 'blocked'); assert(run.issues.some(issue => issue.includes('512')));
  assert.deepEqual(run.schema, []); assert.equal(run.rowCount, 0);
  assert.deepEqual((await createDataflowService(f.options).getRun(owner, d.flowId, run.id)).run, run);
  await assert.rejects(f.service.publish(owner, d.flowId, run.id, { confirmed: true }), code(409));
});

test('corrupt dataflow state fails closed and never resets confirmed definitions or last good results', async t => {
  const f = await fixture(t); await f.define(); const corrupt = '{"version":1,"state":{}}'; await writeFile(f.store.path, corrupt);
  assert.equal((await f.app.inject('/api/dataflows')).statusCode, 503);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/dataflows', payload: { spec: f.spec, confirmed: true, requestId: randomUUID() } })).statusCode, 503);
  assert.equal(await readFile(f.store.path, 'utf8'), corrupt);
});

test('transitive dependencies guide durable source-first refresh and hold downstream runs until upstream publication', async t => {
  const f = await fixture(t);
  const a = await f.define();
  const refresh = async (definition: { id: string; flowId: string }) => {
    const run = await f.service.run(owner, definition.flowId, { definitionId: definition.id, confirmed: true, requestId: randomUUID() });
    assert.equal(run.status, 'ready', run.issues.join('; '));
    return { run, output: await f.service.publish(owner, definition.flowId, run.id, { confirmed: true }) };
  };
  await refresh(a);
  const b = await f.service.save(owner, { spec: { ...f.spec, name: 'Arbeitsbestand', inputFamilyId: a.flowId, joins: [], filters: [] }, confirmed: true, requestId: randomUUID() });
  await refresh(b);
  const c = await f.service.save(owner, { spec: { ...f.spec, name: 'Bericht', inputFamilyId: b.flowId, joins: [], filters: [] }, confirmed: true, requestId: randomUUID() });
  const initialC = await refresh(c);
  const bytesBeforeGraph = await Promise.all([readFile(f.store.path, 'utf8'), readFile(f.models.path, 'utf8')]);
  const initialGraph = await f.service.dependencies(owner);
  assert.deepEqual(await Promise.all([readFile(f.store.path, 'utf8'), readFile(f.models.path, 'utf8')]), bytesBeforeGraph);
  assert(initialGraph.nodes.every(node => node.status === 'current'));
  assert.deepEqual(initialGraph.updateOrder, []);
  await f.source('Kunden', [{ id: 'C1', name: 'Neu' }], f.customers.id);
  const changed = await f.service.dependencies(owner);
  assert.deepEqual(changed.updateOrder, [a.flowId, b.flowId, c.flowId]);
  assert.equal(changed.nextFlowId, a.flowId);
  assert.equal(changed.nodes.find(node => node.flowId === a.flowId)?.status, 'needs_run');
  assert.equal(changed.nodes.find(node => node.flowId === c.flowId)?.status, 'waiting');
  assert.deepEqual(new Set(changed.nodes.find(node => node.flowId === a.flowId)?.affectedFlowIds), new Set([b.flowId, c.flowId]));
  assert.deepEqual(await createDataflowService(f.options).dependencies(owner), changed);
  const blocked = await f.service.run(owner, c.flowId, { definitionId: c.id, confirmed: true, requestId: randomUUID() });
  assert.equal(blocked.status, 'blocked'); assert(blocked.issues.some(issue => issue.includes('Arbeitsbestand')));
  assert.equal((await f.service.get(owner, c.flowId)).published?.id, initialC.output.id);
  assert.deepEqual(await f.service.publish(owner, c.flowId, initialC.run.id, { confirmed: true }), initialC.output);
  await refresh(a);
  assert.equal((await f.service.dependencies(owner)).nextFlowId, b.flowId);
  await refresh(b);
  assert.equal((await f.service.dependencies(owner)).nextFlowId, c.flowId);
  const final = await refresh(c);
  const current = await f.service.dependencies(owner);
  assert(current.nodes.every(node => node.status === 'current'));
  assert.notEqual(current.graphHash, initialGraph.graphHash);
  assert.equal(final.output.revision, 2);
  assert.equal((await f.service.getRun(owner, c.flowId, final.run.id)).rows[0]?.customerName, 'Neu');
  assert.deepEqual(await createDataflowService(f.options).dependencies(owner), current);
  assert.equal((await f.app.inject('/api/dataflows/dependencies')).statusCode, 200);
  assert.deepEqual((await f.service.dependencies(other)).nodes, []);
  assert.deepEqual((await f.service.dependencies(foreign)).nodes, []);
  f.session(reader); assert.equal((await f.app.inject('/api/dataflows/dependencies')).statusCode, 403);
  f.session(); assert.equal((await f.app.inject('/api/dataflows/dependencies')).statusCode, 401);
});

test('publication checks transitive source changes inside the semantic write and preserves the prior output', async t => {
  const f = await fixture(t); const a = await f.define();
  const ra = await f.service.run(owner, a.flowId, { definitionId: a.id, confirmed: true, requestId: randomUUID() });
  await f.service.publish(owner, a.flowId, ra.id, { confirmed: true });
  const b = await f.service.save(owner, { spec: { ...f.spec, name: 'Abgeleiteter Bericht', inputFamilyId: a.flowId, joins: [], filters: [] }, confirmed: true, requestId: randomUUID() });
  const first = await f.service.run(owner, b.flowId, { definitionId: b.id, confirmed: true, requestId: randomUUID() });
  const output = await f.service.publish(owner, b.flowId, first.id, { confirmed: true });
  const next = await f.service.run(owner, b.flowId, { definitionId: b.id, confirmed: true, requestId: randomUUID() });
  let afterSourceChange = '';
  const raced = createDataflowService({ ...f.options, semanticModel: { async publishDataflow(session, input, guard) {
    await f.source('Kunden', [{ id: 'C1', name: 'Changed during publication' }], f.customers.id);
    afterSourceChange = await readFile(f.models.path, 'utf8');
    return f.model.publishDataflow(session, input, guard);
  } } });
  await assert.rejects(raced.publish(owner, b.flowId, next.id, { confirmed: true }), code(409));
  assert.equal(await readFile(f.models.path, 'utf8'), afterSourceChange);
  assert.equal((await f.service.get(owner, b.flowId)).published?.id, output.id);
  assert.deepEqual(await f.service.publish(owner, b.flowId, first.id, { confirmed: true }), output);
});

test('changed producer definitions prevent downstream publication even with unchanged immediate source snapshots', async t => {
  const f = await fixture(t); const a = await f.define();
  const ra = await f.service.run(owner, a.flowId, { definitionId: a.id, confirmed: true, requestId: randomUUID() });
  await f.service.publish(owner, a.flowId, ra.id, { confirmed: true });
  const b = await f.service.save(owner, { spec: { ...f.spec, name: 'Nachgelagert', inputFamilyId: a.flowId, joins: [], filters: [] }, confirmed: true, requestId: randomUUID() });
  const ready = await f.service.run(owner, b.flowId, { definitionId: b.id, confirmed: true, requestId: randomUUID() });
  await f.service.save(owner, { spec: { ...f.spec, minRows: 2 }, previousId: a.id, confirmed: true, requestId: randomUUID() });
  assert.equal((await f.service.getRun(owner, b.flowId, ready.id)).run.sourcesChanged, false);
  await assert.rejects(f.service.publish(owner, b.flowId, ready.id, { confirmed: true }), code(409));
  const next = await f.service.run(owner, b.flowId, { definitionId: b.id, confirmed: true, requestId: randomUUID() });
  assert.equal(next.status, 'blocked');
  assert.equal((await f.service.dependencies(owner)).nodes.find(node => node.flowId === b.flowId)?.status, 'waiting');
});
