import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { FastifyInstance, InjectOptions } from 'fastify';

const ORIGIN = 'http://localhost:5173';
const mutationHeaders = { origin: ORIGIN, 'x-koiforge-request': '1' };

function cookie(response: { headers: Record<string, string | string[] | undefined> }): string {
  const value = response.headers['set-cookie'];
  const first = Array.isArray(value) ? value[0] : value;
  assert.equal(typeof first, 'string');
  const match = /^koiforge_session=([^;]+);/.exec(first);
  assert(match, 'authentication response must set the session cookie');
  return `koiforge_session=${match[1]}`;
}

function authHeaders(sessionCookie: string, mutate = false): Record<string, string> {
  return { cookie: sessionCookie, origin: ORIGIN, ...(mutate ? { 'x-koiforge-request': '1' } : {}) };
}

async function expectStatus(app: FastifyInstance, expected: number, options: InjectOptions | string): Promise<void> {
  const response = await app.inject(options);
  assert.equal(response.statusCode, expected, `${typeof options === 'string' ? options : `${options.method ?? 'GET'} ${options.url}`}: ${response.body}`);
}

test('real server confines a project reader to granted projects and objects across restart', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'koi-project-server-'));
  const root = join(directory, 'state');
  await mkdir(root, { mode: 0o700 });
  const environmentKeys = [
    'NODE_ENV', 'KOIFORGE_STATE_ROOT', 'KOIFORGE_IMPORT_DATA_ROOT', 'KOIFORGE_PUBLIC_ORIGIN',
    'KOIFORGE_GENERATION_DISABLED', 'KOIFORGE_AI_BASE_URLS',
  ] as const;
  const previous = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  process.env.NODE_ENV = 'test';
  process.env.KOIFORGE_STATE_ROOT = root;
  process.env.KOIFORGE_IMPORT_DATA_ROOT = root;
  process.env.KOIFORGE_PUBLIC_ORIGIN = ORIGIN;
  process.env.KOIFORGE_GENERATION_DISABLED = '1';
  delete process.env.KOIFORGE_AI_BASE_URLS;

  let app: FastifyInstance | undefined;
  t.after(async () => {
    await app?.close();
    for (const key of environmentKeys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });

  const { FileDatasetRegistry } = await import('@koiforge/data-registry');
  const dataset = await new FileDatasetRegistry({ filePath: join(root, 'dataset-registry.json') }).registerInlineDataset({
    namespace: 'project-server-test',
    name: 'Freigegebene Aufträge',
    rows: [{ id: 'A-1', name: 'Sicherer Pilot', amount: 0 }],
  });
  const { buildServer } = await import('../src/server.js');
  app = await buildServer();
  await app.ready();

  const setup = await app.inject({
    method: 'POST', url: '/api/auth/setup', headers: mutationHeaders,
    payload: { email: 'owner@example.test', displayName: 'Owner', workspaceName: 'Testfirma', password: 'owner passphrase for project tests' },
  });
  assert.equal(setup.statusCode, 200, setup.body);
  const ownerCookie = cookie(setup);

  const objectSetResponse = await app.inject({
    method: 'POST', url: '/api/model/object-sets', headers: authHeaders(ownerCookie, true),
    payload: { name: 'Aufträge', datasetId: dataset.id, keyField: 'id', labelField: 'name', confirmed: true, requestId: randomUUID() },
  });
  assert.equal(objectSetResponse.statusCode, 200, objectSetResponse.body);
  const objectSet = objectSetResponse.json().objectSet as { id: string; familyId: string };

  const invitationResponse = await app.inject({
    method: 'POST', url: '/api/team/invites', headers: authHeaders(ownerCookie, true),
    payload: { email: 'reader@example.test', displayName: 'Projektleserin' },
  });
  assert.equal(invitationResponse.statusCode, 200, invitationResponse.body);
  const invitation = invitationResponse.json() as { member: { id: string }; token: string };
  const joined = await app.inject({
    method: 'POST', url: '/api/auth/join', headers: mutationHeaders,
    payload: { token: invitation.token, password: 'reader passphrase for project tests' },
  });
  assert.equal(joined.statusCode, 200, joined.body);
  const readerCookie = cookie(joined);

  const projectResponse = await app.inject({
    method: 'POST', url: '/api/projects', headers: authHeaders(ownerCookie, true),
    payload: {
      name: 'Lieferpilot', description: 'Gezielt freigegebene Aufträge', familyIds: [objectSet.familyId],
      memberIds: [invitation.member.id], confirmed: true, requestId: randomUUID(),
    },
  });
  assert.equal(projectResponse.statusCode, 200, projectResponse.body);
  const project = projectResponse.json().project as { id: string; revision: number };

  const projects = await app.inject({ url: '/api/projects', headers: authHeaders(readerCookie) });
  assert.equal(projects.statusCode, 200, projects.body);
  assert.deepEqual(projects.json().items.map((item: { id: string }) => item.id), [project.id]);
  const detail = await app.inject({ url: `/api/projects/${project.id}`, headers: authHeaders(readerCookie) });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(Object.hasOwn(detail.json().project, 'memberIds'), false);
  assert.equal(Object.hasOwn(detail.json().project, 'events'), false);
  await expectStatus(app, 200, { method: 'HEAD', url: '/api/projects', headers: authHeaders(readerCookie) });
  await expectStatus(app, 200, { url: '/ap%69/projects', headers: authHeaders(readerCookie) });

  const scoped = `?projectId=${encodeURIComponent(project.id)}`;
  const families = await app.inject({ url: `/api/object-workspace/families${scoped}`, headers: authHeaders(readerCookie) });
  assert.equal(families.statusCode, 200, families.body);
  assert.deepEqual(families.json().items.map((item: { id: string }) => item.id), [objectSet.familyId]);
  const objects = await app.inject({
    url: `/api/object-workspace/families/${objectSet.familyId}/objects${scoped}`,
    headers: authHeaders(readerCookie),
  });
  assert.equal(objects.statusCode, 200, objects.body);
  assert.equal(objects.json().items[0].key, 'A-1');
  await expectStatus(app, 403, { url: '/api/object-workspace/families', headers: authHeaders(readerCookie) });

  const deniedReads = [
    '/api/datasets', '/api/model/object-sets', '/api/views?type=board-viewer', '/api/missions',
    '/api/config/entries', '/api/aip/config', `/api/import/sessions/${randomUUID()}`,
    '/api/security/users', '/api/modules', '/api/actions', '/ap%69/datasets',
    '/api/dataflows', '/ap%69/dataflows', '/api/dataflows/dependencies', '/ap%69/dataflows/dependencies',
  ];
  for (const url of deniedReads) {
    await expectStatus(app, 403, { url, headers: authHeaders(readerCookie) });
  }
  await expectStatus(app, 403, { method: 'HEAD', url: '/api/datasets', headers: authHeaders(readerCookie) });
  const deniedMutations: InjectOptions[] = [
    { method: 'POST', url: '/api/projects', payload: {}, headers: authHeaders(readerCookie, true) },
    { method: 'POST', url: '/api/dataflows', payload: {}, headers: authHeaders(readerCookie, true) },
    { method: 'POST', url: '/api/missions', payload: {}, headers: authHeaders(readerCookie, true) },
    { method: 'POST', url: '/api/import/sessions', payload: {}, headers: authHeaders(readerCookie, true) },
    { method: 'POST', url: '/api/aip/chat', payload: { message: 'must not run' }, headers: authHeaders(readerCookie, true) },
    { method: 'POST', url: '/api/config/entries/upsert', payload: {}, headers: authHeaders(readerCookie, true) },
  ];
  for (const options of deniedMutations) await expectStatus(app, 403, options);

  const revoke = await app.inject({
    method: 'PATCH', url: `/api/projects/${project.id}`, headers: authHeaders(ownerCookie, true),
    payload: {
      name: 'Lieferpilot', description: 'Gezielt freigegebene Aufträge', familyIds: [objectSet.familyId], memberIds: [],
      confirmed: true, requestId: randomUUID(), revision: project.revision,
    },
  });
  assert.equal(revoke.statusCode, 200, revoke.body);
  await expectStatus(app, 404, { url: `/api/projects/${project.id}`, headers: authHeaders(readerCookie) });
  await expectStatus(app, 404, { url: `/api/object-workspace/families${scoped}`, headers: authHeaders(readerCookie) });

  const disable = await app.inject({
    method: 'PATCH', url: `/api/team/${invitation.member.id}`, headers: authHeaders(ownerCookie, true), payload: { status: 'disabled' },
  });
  assert.equal(disable.statusCode, 200, disable.body);
  await expectStatus(app, 401, { url: '/api/auth/session', headers: authHeaders(readerCookie) });

  await app.close();
  app = undefined;
  app = await buildServer();
  await app.ready();
  await expectStatus(app, 401, { url: '/api/auth/session', headers: authHeaders(readerCookie) });
  await expectStatus(app, 200, { url: '/api/auth/session', headers: authHeaders(ownerCookie) });
});
