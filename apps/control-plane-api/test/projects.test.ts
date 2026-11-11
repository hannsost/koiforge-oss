import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import Fastify from 'fastify';
import type { SessionContext } from '@koiforge/security-core';
import { FileDatasetRegistry } from '@koiforge/data-registry';
import { createSemanticModelService } from '../src/semantic-model/service.js';
import { semanticHash } from '../src/semantic-model/store.js';
import { createProjectService } from '../src/projects/service.js';
import { FileProjectStore } from '../src/projects/store.js';
import { ProjectError } from '../src/projects/contracts.js';
import { createObjectWorkspaceService } from '../src/object-workspace/service.js';
import { ObjectWorkspaceError } from '../src/object-workspace/contracts.js';
import { registerProjectRoutes } from '../src/routes/projects.js';
import { registerObjectWorkspaceRoutes } from '../src/routes/object-workspace.js';

const owner: SessionContext = { user: { id: randomUUID(), displayName: 'Owner' }, tenant: { id: 'firm', slug: 'firm', name: 'Firma', status: 'active' },
  roleIds: ['owner'], permissions: ['projects.read', 'projects.manage', 'objects.read', 'datasets.read', 'datasets.manage'] };
const reader: SessionContext = { ...owner, user: { id: randomUUID(), displayName: 'Reader' }, roleIds: ['project_reader'], permissions: ['projects.read', 'objects.read'] };
const stranger = { ...reader, user: { id: randomUUID(), displayName: 'Stranger' } };
const foreign = { ...reader, tenant: { ...reader.tenant, id: 'other-firm' } };
const code = (expected: number) => (e: unknown) => (e instanceof ProjectError || e instanceof ObjectWorkspaceError) && e.statusCode === expected;
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'koi-projects-')); t.after(() => rm(root, { recursive: true, force: true }));
  const control = { disabled: new Set<string>(), resolves: 0, denyAt: Infinity };
  const authority = {
    async resolvePrincipal(ref: { userId: string; tenantId: string }): Promise<SessionContext | null> {
      control.resolves++;
      return control.resolves >= control.denyAt || control.disabled.has(ref.userId) ? null
        : [owner, reader, stranger, foreign].find(s => s.user.id === ref.userId && s.tenant.id === ref.tenantId) ?? null;
    },
    assertPermissions(s: SessionContext, permissions: string[]) { assert(permissions.every(p => s.permissions.includes(p))); },
  };
  const members = [{ id: reader.user.id, status: 'active' as 'active' | 'disabled' | 'invited' }, { id: stranger.user.id, status: 'invited' as const }];
  const dataset = new FileDatasetRegistry({ filePath: join(root, 'datasets.json') });
  const model = createSemanticModelService({ root, registries: { dataset }, ...authority });
  const a = await dataset.registerInlineDataset({ name: 'Projekte', namespace: 'project-test', rows: [{ id: 'P1', customer: 'C1', amount: 0 }] });
  const b = await dataset.registerInlineDataset({ name: 'Kunden', namespace: 'project-test', rows: [{ id: 'C1', name: 'Ada' }] });
  const from = await model.createObjectSet(owner, { name: 'Projekte', datasetId: a.id, keyField: 'id', confirmed: true, requestId: randomUUID() });
  const to = await model.createObjectSet(owner, { name: 'Kunden', datasetId: b.id, keyField: 'id', confirmed: true, requestId: randomUUID() });
  const relationship = await model.createRelationship(owner, { name: 'Kunde', fromSetId: from.id, toSetId: to.id, fromField: 'customer', confirmed: true, requestId: randomUUID() });
  const options = { root, ...authority, listTeam: async () => members };
  const service = createProjectService(options); const store = new FileProjectStore(root);
  const objects = createObjectWorkspaceService({ root, ...authority, projects: service });
  const payload = (overrides = {}) => ({ name: 'Pilot', description: 'Projektfreigabe', familyIds: [from.familyId], memberIds: [reader.user.id], confirmed: true, requestId: randomUUID(), ...overrides });
  const app = Fastify(); let session: SessionContext | undefined = owner;
  app.addHook('preHandler', async r => { r.koiforgeSession = session as SessionContext; });
  registerProjectRoutes(app, service); registerObjectWorkspaceRoutes(app, objects); await app.ready(); t.after(() => app.close());
  return { root, control, options, members, dataset, model, from, to, relationship, service, store, objects, payload, app, session(s?: SessionContext) { session = s; } };
}

test('project grants persist, retry once, and retain a complete revision audit across restart', async t => {
  const f = await fixture(t); const input = f.payload();
  const [first, retry] = await Promise.all([f.service.create(owner, input), createProjectService(f.options).create(owner, input)]);
  assert.deepEqual(first, retry); assert.equal(first.revision, 1); assert.equal((await f.service.list(owner)).length, 1);
  const before = await readFile(f.store.path, 'utf8'); await f.service.create(owner, input); assert.equal(await readFile(f.store.path, 'utf8'), before);
  const update = f.payload({ name: 'Gemeinsam', revision: 1, familyIds: [f.to.id, f.from.id], memberIds: [reader.user.id, stranger.user.id] });
  const saved = await f.service.update(owner, first.id, update);
  assert.equal(saved.revision, 2); assert.deepEqual(saved.events?.[1]?.addedFamilies, [f.to.id]); assert.deepEqual(saved.events?.[1]?.addedMembers, [stranger.user.id]);
  assert.deepEqual(await createProjectService(f.options).get(owner, first.id), saved);
  await assert.rejects(f.service.create(owner, input), code(409));
  await assert.rejects(f.service.update(owner, first.id, { ...update, name: 'Stale request' }), code(409));
  assert.equal((await stat(f.store.path)).mode & 0o777, 0o600);
});

test('optimistic updates serialize across service instances and never overwrite a concurrent grant', async t => {
  const f = await fixture(t); const p = await f.service.create(owner, f.payload());
  const results = await Promise.allSettled([f.service.update(owner, p.id, f.payload({ name: 'A', revision: 1 })),
    createProjectService(f.options).update(owner, p.id, f.payload({ name: 'B', revision: 1 }))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.statusCode, 409);
  assert.equal((await f.service.get(owner, p.id)).revision, 2);
});

test('reader sees assigned projects, never membership events or another principal’s project', async t => {
  const f = await fixture(t); const p = await f.service.create(owner, f.payload());
  const shared = await f.service.get(reader, p.id); assert.equal(shared.canManage, false);
  assert.equal(Object.hasOwn(shared, 'memberIds'), false); assert.equal(Object.hasOwn(shared, 'events'), false);
  for (const other of [stranger, foreign]) {
    assert.deepEqual(await f.service.list(other), []); await assert.rejects(f.service.get(other, p.id), code(404));
    await assert.rejects(f.service.resolveAccess(other, p.id), code(404));
  }
  await assert.rejects(f.service.create(reader, f.payload()), code(403));
  await assert.rejects(f.service.update(reader, p.id, f.payload({ revision: 1 })), code(403));
  const forged = { ...reader, roleIds: ['owner'], permissions: owner.permissions };
  await assert.rejects(f.service.update(forged, p.id, f.payload({ revision: 1 })), code(403));
  f.control.disabled.add(reader.user.id); await assert.rejects(f.service.get(reader, p.id), code(403));
});

test('grant input rejects unknown fields, foreign families, unlisted or newly disabled members, and missing confirmation', async t => {
  const f = await fixture(t);
  for (const patch of [{ familyIds: [randomUUID()] }, { familyIds: [f.from.id, f.from.id] }, { memberIds: [owner.user.id] },
    { memberIds: [randomUUID()] }, { name: '' }, { confirmed: false }, { requestId: 'invalid' }, { extra: true }]) {
    await assert.rejects(f.service.create(owner, f.payload(patch)), code(400));
  }
  f.members[0]!.status = 'disabled'; await assert.rejects(f.service.create(owner, f.payload()), code(400));
  f.members[0]!.status = 'active'; const p = await f.service.create(owner, f.payload());
  f.members[0]!.status = 'disabled';
  assert.equal((await f.service.update(owner, p.id, f.payload({ revision: 1 }))).revision, 2, 'existing disabled member may be retained without re-grant');
});

test('authority revoked at publication leaves prior grants and receipts unchanged, with no temporary file', async t => {
  const f = await fixture(t); const p = await f.service.create(owner, f.payload()); const before = await readFile(f.store.path, 'utf8');
  f.control.denyAt = f.control.resolves + 2;
  await assert.rejects(f.service.update(owner, p.id, f.payload({ revision: 1, memberIds: [] })), code(403));
  assert.equal(await readFile(f.store.path, 'utf8'), before);
  assert.deepEqual(await readdir(dirname(f.store.path)), ['state.json']);
});

test('shared objects keep stable owner IDs and all revisions, while relationships require both families', async t => {
  const f = await fixture(t); const p = await f.service.create(owner, f.payload()); const query = { projectId: p.id };
  const owned = (await f.objects.listObjects(owner, f.from.id)).items[0]!;
  assert.deepEqual((await f.objects.listFamilies(reader, query)).map(f => f.id), [f.from.id]);
  assert.equal((await f.objects.listObjects(reader, f.from.id, query)).items[0]!.objectId, owned.objectId);
  assert.equal((await f.objects.getObject(reader, f.from.id, owned.objectId!, query)).relationships.length, 0);
  await assert.rejects(f.objects.getObjectLinks(reader, f.from.id, owned.objectId!, f.relationship.id, query), code(404));
  await assert.rejects(f.objects.listObjects(reader, f.to.id, query), code(404));
  await f.service.update(owner, p.id, f.payload({ revision: 1, familyIds: [f.from.id, f.to.id] }));
  assert.equal((await f.objects.getObjectLinks(reader, f.from.id, owned.objectId!, f.relationship.id, query)).items[0]?.object?.key, 'C1');
  const revisedData = await f.dataset.registerInlineDataset({ name: 'Neu', namespace: 'project-test', rows: [{ id: 'P1', customer: 'C1', amount: 100 }] });
  await f.model.createObjectSet(owner, { name: 'Projekte', datasetId: revisedData.id, keyField: 'id', previousId: f.from.id, confirmed: true, requestId: randomUUID() });
  const current = await f.objects.getObject(reader, f.from.id, owned.objectId!, query);
  assert.equal(current.object?.attributes.amount, 100); assert.equal(current.history.length, 2);
  const pinned = await f.objects.getObject(reader, f.from.id, owned.objectId!, { ...query, setId: f.from.id });
  assert.equal(pinned.object?.attributes.amount, 0); assert.equal(pinned.relationships.length, 1);
});

test('every scoped object route denies missing/foreign/revoked grants and malicious query shapes', async t => {
  const f = await fixture(t); const p = await f.service.create(owner, f.payload());
  const object = (await f.objects.listObjects(owner, f.from.id)).items[0]!; const base = '/api/object-workspace/families';
  f.session(reader);
  for (const path of ['', `/${f.from.id}/objects`, `/${f.from.id}/objects/${object.objectId}`, `/${f.from.id}/objects/${object.objectId}/links/${f.relationship.id}`]) {
    assert.equal((await f.app.inject(base + path)).statusCode, 403);
    assert.equal((await f.app.inject(`${base}${path}?projectId=${randomUUID()}`)).statusCode, 404);
    assert.equal((await f.app.inject(`${base}${path}?projectId=${p.id}&projectId=${p.id}`)).statusCode, 400);
  }
  await f.service.update(owner, p.id, f.payload({ revision: 1, memberIds: [] }));
  assert.equal((await f.app.inject(`${base}?projectId=${p.id}`)).statusCode, 404);
  assert.equal((await f.app.inject(`/api/projects/${p.id}`)).statusCode, 404);
  f.session(); assert.equal((await f.app.inject('/api/projects')).statusCode, 401);
});

test('in-flight object reads do not publish data after membership or family changes', async t => {
  const f = await fixture(t); const p = await f.service.create(owner, f.payload()); let revision = 1;
  const reads = [
    (s: ReturnType<typeof createObjectWorkspaceService>) => s.listFamilies(reader, { projectId: p.id }),
    (s: ReturnType<typeof createObjectWorkspaceService>) => s.listObjects(reader, f.from.id, { projectId: p.id }),
  ];
  for (const read of reads) {
    const service = createObjectWorkspaceService({ root: f.root, ...f.options, projects: {
      resolveAccess: f.service.resolveAccess,
      async assertAccess(session, id, version) {
        await f.service.update(owner, id, f.payload({ revision: revision++, familyIds: [] }));
        return f.service.assertAccess(session, id, version);
      },
    } });
    if (revision > 1) await f.service.update(owner, p.id, f.payload({ revision: revision++ }));
    await assert.rejects(read(service), code(409));
  }
  const service = createObjectWorkspaceService({ root: f.root, ...f.options, projects: {
    resolveAccess: f.service.resolveAccess,
    async assertAccess(session, id, version) { await f.service.update(owner, id, f.payload({ revision, memberIds: [] })); return f.service.assertAccess(session, id, version); },
  } });
  await assert.rejects(service.listFamilies(reader, { projectId: p.id }), code(404));
});

test('corruption including a forged checksum with inconsistent grant audit fails closed without overwriting', async t => {
  const f = await fixture(t); const p = await f.service.create(owner, f.payload()); const original = await readFile(f.store.path, 'utf8');
  const envelope = JSON.parse(original); envelope.state.projects[p.id].memberIds = [];
  envelope.integrityHash = semanticHash(envelope.state);
  for (const bytes of ['{broken', JSON.stringify(envelope)]) {
    await writeFile(f.store.path, bytes);
    assert.equal((await f.app.inject('/api/projects')).statusCode, 503);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/projects', payload: f.payload() })).statusCode, 503);
    await assert.rejects(f.objects.listFamilies(reader, { projectId: p.id }));
    assert.equal(await readFile(f.store.path, 'utf8'), bytes);
  }
});

test('a membership change during the final identity lookup cannot leak a stale project catalog', async t => {
  const f = await fixture(t); const p = await f.service.create(owner, f.payload()); let reads = 0;
  const service = createProjectService({ ...f.options, async resolvePrincipal(ref) {
    if (ref.userId === reader.user.id && ++reads === 2) await f.service.update(owner, p.id, f.payload({ revision: 1, memberIds: [] }));
    return f.options.resolvePrincipal(ref);
  } });
  assert.deepEqual(await service.list(reader), []);
});
