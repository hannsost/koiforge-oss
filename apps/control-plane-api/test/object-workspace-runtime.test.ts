import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import Fastify from 'fastify';
import { FileDatasetRegistry } from '@koiforge/data-registry';
import type { SessionContext } from '@koiforge/security-core';
import { createSemanticModelService } from '../src/semantic-model/service.js';
import { FileSemanticModelStore } from '../src/semantic-model/store.js';
import { createObjectWorkspaceService } from '../src/object-workspace/service.js';
import { ObjectWorkspaceError } from '../src/object-workspace/contracts.js';
import { registerObjectWorkspaceRoutes } from '../src/routes/object-workspace.js';

const owner: SessionContext = { user: { id: 'object-owner', displayName: 'Owner' },
  tenant: { id: 'object-firm', slug: 'object-firm', name: 'Firma', status: 'active' },
  roleIds: ['owner'], permissions: ['datasets.read', 'datasets.manage'] };
const other = { ...owner, user: { id: 'other-owner', displayName: 'Other' } };
const foreign = { ...owner, tenant: { ...owner.tenant, id: 'foreign-firm' } };
const status = (code: number) => (error: unknown) => error instanceof ObjectWorkspaceError && error.statusCode === code;
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'koi-object-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const control = { resolves: 0, denyAt: Infinity, permissions: [...owner.permissions], active: true };
  const authority = { async resolvePrincipal(ref: { userId: string; tenantId: string }) {
    const found = [owner, other, foreign].find(item => item.user.id === ref.userId && item.tenant.id === ref.tenantId);
    control.resolves++;
    if (control.resolves >= control.denyAt || !found) return null;
    return { ...structuredClone(found), tenant: { ...found.tenant, status: control.active ? 'active' as const : 'suspended' as const }, permissions: [...control.permissions] };
  }, assertPermissions(session: SessionContext, permissions: string[]) { assert(permissions.every(p => session.permissions.includes(p))); } };
  const dataset = new FileDatasetRegistry({ filePath: join(root, 'datasets.json') });
  const model = createSemanticModelService({ root, registries: { dataset }, ...authority });
  const source = await dataset.registerInlineDataset({ name: 'Projekte', namespace: 'objects', rows: [
    ...Array.from({ length: 211 }, (_, i) => ({ id: `P${i + 1}`, customer: 'C1', amount: i, active: i === 210 })),
  ] });
  const target = await dataset.registerInlineDataset({ name: 'Kunden', namespace: 'objects', rows: [{ id: 'C1', name: 'Ada' }] });
  const from = await model.createObjectSet(owner, { name: 'Projekte', datasetId: source.id, keyField: 'id', confirmed: true, requestId: randomUUID() });
  const to = await model.createObjectSet(owner, { name: 'Kunden', datasetId: target.id, keyField: 'id', labelField: 'name', confirmed: true, requestId: randomUUID() });
  const relationship = await model.createRelationship(owner, { name: 'Kunde des Projekts', fromSetId: from.id, toSetId: to.id,
    fromField: 'customer', confirmed: true, requestId: randomUUID() });
  const options = { root, ...authority };
  const start = () => createObjectWorkspaceService(options);
  const service = start();
  const project = (await service.listObjects(owner, from.familyId, { q: 'P211' })).items[0]!;
  const customer = (await service.listObjects(owner, to.familyId)).items[0]!;
  const store = new FileSemanticModelStore(root);
  let requestSession: SessionContext | undefined = owner;
  const app = Fastify();
  app.addHook('preHandler', async request => { request.koiforgeSession = requestSession as SessionContext; });
  registerObjectWorkspaceRoutes(app, service);
  await app.ready(); t.after(() => app.close());
  const base = '/api/object-workspace/families';
  return { root, control, dataset, model, source, target, from, to, relationship, start, service, store, project, customer,
    app, base, session(value: SessionContext | undefined) { requestSession = value; } };
}

test('generic reads cover the entire confirmed source and pinned relations without changing storage', async t => {
  const f = await fixture(t);
  const before = await readFile(f.store.path, 'utf8');
  assert.equal((await f.service.listFamilies(owner)).length, 2);
  const page = await f.service.listObjects(owner, f.from.familyId, { filterField: 'active', filterValue: 'true', sortBy: 'amount', sortDir: 'desc' });
  assert.equal(page.totalSourceRows, 211); assert.equal(page.totalRows, 1); assert.equal(page.items[0]!.sourceRow, 211);
  assert.equal((await f.service.listObjects(owner, f.from.familyId, { filterField: 'active', filterValue: '"true"' })).totalRows, 0);
  const detail = await f.service.getObject(owner, f.from.familyId, f.project.objectId!);
  assert.equal(detail.state, 'present'); assert.equal(detail.relationships[0]!.direction, 'outgoing');
  const outgoing = await f.service.getObjectLinks(owner, f.from.familyId, f.project.objectId!, f.relationship.id);
  assert.equal(outgoing.items[0]!.object!.objectId, f.customer.objectId);
  const incoming = await f.service.getObjectLinks(owner, f.to.familyId, f.customer.objectId!, f.relationship.id, { offset: '200', limit: '25' });
  assert.equal(incoming.direction, 'incoming'); assert.equal(incoming.totalRows, 211); assert.equal(incoming.items.length, 11);
  assert.equal(incoming.items.at(-1)!.object!.objectId, f.project.objectId);
  assert.equal(await readFile(f.store.path, 'utf8'), before);
});

test('stable logical links survive row moves and restart; evidence links keep their revision after source deletion', async t => {
  const f = await fixture(t);
  const source = await f.dataset.registerInlineDataset({ name: 'Projekte neu', namespace: 'objects', rows: [{ id: 'P211', customer: 'C1', amount: 999, active: false }] });
  const revised = await f.model.createObjectSet(owner, { name: 'Projekte', datasetId: source.id, keyField: 'id', previousId: f.from.id, confirmed: true, requestId: randomUUID() });
  for (const id of [f.source.id, f.target.id, source.id]) await f.dataset.deleteDataset(id);
  const before = await readFile(f.store.path, 'utf8'); const restarted = f.start();
  const live = await restarted.getObject(owner, f.from.familyId, f.project.objectId!);
  assert.equal(live.objectSet.id, revised.id); assert.equal(live.object!.sourceRow, 1); assert.equal(live.object!.attributes.amount, 999);
  assert.equal(live.relationships.length, 0, 'old relationships cannot silently apply to a new source revision');
  const pinned = await restarted.getObject(owner, f.from.familyId, f.project.objectId!, { setId: f.from.id });
  assert.equal(pinned.object!.sourceRow, 211); assert.equal(pinned.object!.attributes.amount, 210); assert.equal(pinned.relationships.length, 1);
  assert.deepEqual(live.history.map(row => row.revision), [2, 1]);
  assert.equal((await restarted.getObjectLinks(owner, f.from.familyId, f.project.objectId!, f.relationship.id, { setId: f.from.id })).items[0]!.object!.label, 'Ada');
  assert.equal(await readFile(f.store.path, 'utf8'), before);
});

test('every route isolates tenant and owner, including alternate set, object, and relationship identifiers', async t => {
  const f = await fixture(t);
  for (const principal of [other, foreign]) {
    f.session(principal);
    assert.deepEqual((await f.app.inject({ url: f.base })).json(), { items: [] });
    for (const path of [`/${f.from.id}/objects`, `/${f.from.id}/objects/${f.project.objectId}`,
      `/${f.from.id}/objects/${f.project.objectId}/links/${f.relationship.id}`]) {
      assert.equal((await f.app.inject({ url: f.base + path })).statusCode, 404);
    }
  }
  f.session(owner);
  assert.equal((await f.app.inject({ url: `${f.base}/${f.from.id}/objects?setId=${f.to.id}` })).statusCode, 404);
  assert.equal((await f.app.inject({ url: `${f.base}/${f.from.id}/objects/${f.customer.objectId}` })).statusCode, 404);
  assert.equal((await f.app.inject({ url: `${f.base}/${f.from.id}/objects/${f.project.objectId}/links/${randomUUID()}` })).statusCode, 404);
  f.session(undefined);
  assert.equal((await f.app.inject({ url: f.base })).statusCode, 401);
});

test('read permission is sufficient and live revocation is checked again after snapshot projection', async t => {
  const f = await fixture(t);
  f.control.permissions = ['datasets.read'];
  const readOnly = { ...owner, permissions: ['datasets.read'] };
  assert.equal((await f.service.getObject(readOnly, f.from.id, f.project.objectId!)).state, 'present');
  const before = await readFile(f.store.path, 'utf8');
  const reads = [() => f.service.listFamilies(owner), () => f.service.listObjects(owner, f.from.id),
    () => f.service.getObject(owner, f.from.id, f.project.objectId!),
    () => f.service.getObjectLinks(owner, f.from.id, f.project.objectId!, f.relationship.id)];
  for (const read of reads) { f.control.denyAt = f.control.resolves + 2; await assert.rejects(read(), status(403)); f.control.denyAt = Infinity; }
  f.control.permissions = []; await assert.rejects(reads[1]!(), status(403));
  f.control.permissions = [...owner.permissions]; f.control.active = false; await assert.rejects(reads[0]!(), status(403));
  assert.equal(await readFile(f.store.path, 'utf8'), before);
});

test('HTTP query validation rejects repeated parameters, coercion, nonfinite values, and unknown attributes', async t => {
  const f = await fixture(t); const base = `${f.base}/${f.from.id}/objects`;
  for (const query of ['limit=101', 'limit=0', 'limit=-1', 'offset=', 'offset=1.5', 'offset=9007199254740992', 'limit=1&limit=2',
    'q=a&q=b', 'identity=guess', 'sortDir=random', 'setId=bad', 'filterField=id', 'filterValue=null', 'filterField=id&filterValue=%7B%7D',
    'filterField=id&filterValue=1e999', 'filterField=id&filterValue=undefined', 'filterField=unknown&filterValue=null', 'sortBy=unknown', 'anything=1']) {
    const response = await f.app.inject({ url: `${base}?${query}` }); assert.equal(response.statusCode, 400, query + ': ' + response.body);
  }
  assert.equal((await f.app.inject({ url: `${f.base}?limit=1` })).statusCode, 400);
  assert.equal((await f.app.inject({ url: `${base}/${f.project.objectId}?q=unrelated` })).statusCode, 400);
  assert.equal((await f.app.inject({ url: `${base}/${f.project.objectId}/links/${f.relationship.id}?limit=200` })).statusCode, 400);
  assert.equal((await f.app.inject({ url: `${base}/${f.project.objectId}/links/${f.relationship.id}?direction=sideways` })).statusCode, 400);
  assert.equal((await f.app.inject({ url: `${base}/${f.project.objectId}/links/${f.relationship.id}?direction=incoming` })).statusCode, 404);
  assert.equal((await f.app.inject({ url: `${base}?filterField=amount&filterValue=0` })).json().items[0].attributes.amount, 0);
});

test('damaged persisted evidence fails closed on every route and is never replaced with an empty catalog', async t => {
  const f = await fixture(t); const broken = '{"version":1,"state":"damaged"}';
  await writeFile(f.store.path, broken);
  for (const path of ['', `/${f.from.id}/objects`, `/${f.from.id}/objects/${f.project.objectId}`,
    `/${f.from.id}/objects/${f.project.objectId}/links/${f.relationship.id}`]) {
    const response = await f.app.inject({ url: f.base + path }); assert.equal(response.statusCode, 503);
    assert.match(response.json().error, /Bestehende Daten bleiben erhalten/);
    assert.equal(await readFile(f.store.path, 'utf8'), broken);
  }
});
