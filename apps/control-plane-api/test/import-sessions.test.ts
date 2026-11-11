import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { before, after, test } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { FileDatasetRegistry } from '@koiforge/data-registry';
import { FileSecurityRegistry } from '@koiforge/security-core';
import type { AppRegistries } from '../src/registries.js';
import { createPluginStore } from '../src/import-capability/plugin-store.js';

let root: string;
let app: FastifyInstance;
let registry: FileDatasetRegistry;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'koiforge-import-api-'));
  process.env.KOIFORGE_IMPORT_DATA_ROOT = root;
  process.env.KOIFORGE_EXTENSION_BACKEND = 'api';
  const { registerImportSessionRoutes } = await import('../src/routes/import-sessions.js');
  registry = new FileDatasetRegistry({ filePath: join(root, 'datasets.json') });
  const security = new FileSecurityRegistry({ filePath: join(root, 'security.json') });
  app = Fastify();
  app.addHook('onRequest', async request => { request.koiforgeSession = await security.getSession(); });
  app.get('/health', async () => ({ ok: true }));
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
  await registerImportSessionRoutes(app, { dataset: registry, security,
    aip: { async getConfig() { return null; } },
  } as unknown as AppRegistries);
  await app.ready();
});

after(async () => {
  await app?.close();
  delete process.env.KOIFORGE_IMPORT_DATA_ROOT;
  await rm(root, { recursive: true, force: true });
});

async function upload(name: string, contents: string | Buffer) {
  const boundary = 'koi-ke0-fixture-boundary';
  const result = await app.inject({
    method: 'POST', url: '/api/import/sessions',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      Buffer.isBuffer(contents) ? contents : Buffer.from(contents),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
  assert.equal(result.statusCode, 200, result.body);
  return result.json().session;
}

async function run(sessionId: string) {
  const result = await app.inject({ method: 'POST', url: `/api/import/sessions/${sessionId}/run`, payload: {} });
  assert.equal(result.statusCode, 200, result.body);
  return result.json();
}

test('full CSV import keeps 10,001 rows, freezes source and is idempotent', async () => {
  const text = 'id,value\n' + Array.from({ length: 10_001 }, (_, i) => `${String(i).padStart(6, '0')},${i}`).join('\n');
  const session = await upload('large.csv', text);
  const result = await run(session.id);
  assert.equal(result.importedDatasets.length, 1);
  const imported = result.importedDatasets[0];
  const preview = await registry.previewRows(imported.id, 20_000);
  assert.equal(preview.rows.length, 10_001);
  assert.equal(preview.truncated, false);
  assert.equal(preview.rows[0]?.id, '000000');
  const node = Object.values(result.session.nodes)[0] as any;
  assert.equal(node.metadata.importVerification.coverage, 'complete');
  await writeFile(node.sourcePath, 'id,value\nchanged,999');
  assert.equal((await registry.previewRows(imported.id, 20_000)).rowCount, 10_001);
  assert.equal((await run(session.id)).importedDatasets.length, 0);
});

test('session CSV discovery and import preserve a semicolon file with quoted newlines and identifiers', async () => {
  const session = await upload('multiline-semicolon.csv', '\uFEFFid;amount;note\r\n00123;9007199254740993.50;"first\r\nsecond ""quoted"""\r\n');
  const node = Object.values(session.nodes).find((entry: any) => entry.capabilityId === 'csv-file') as any;
  assert.equal(node.config.delimiter, ';');
  const expected = [{ id: '00123', amount: '9007199254740993.50', note: 'first\r\nsecond "quoted"' }];
  assert.deepEqual(node.preview.rows, expected);
  const result = await run(session.id);
  assert.equal(result.importedDatasets.length, 1);
  assert.deepEqual((await registry.previewRows(result.importedDatasets[0].id)).rows, expected);
});

test('session CSV rejects malformed records and invalid UTF8 instead of changing their interpretation', async () => {
  const before = await registry.listDatasets();
  const { readdir } = await import('node:fs/promises');
  const sessionDirectory = join(root, 'import-sessions');
  const previousSessions = await readdir(sessionDirectory);
  const fixtures = [Buffer.from('id;value\n00123;value;extra\n'), Buffer.from([0x69, 0x64, 0x0a, 0xff])];
  for (const content of fixtures) {
    const boundary = 'koi-invalid-csv';
    const response = await app.inject({ method: 'POST', url: '/api/import/sessions',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="invalid.csv"\r\nContent-Type: text/csv\r\n\r\n`),
        content, Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.deepEqual(await registry.listDatasets(), before);
    assert.deepEqual(await readdir(sessionDirectory), previousSessions);
  }
});

test('a repair preview leaves gap unresolved until real dataset readback', async () => {
  const session = await upload('fixture.sql', "INSERT INTO sample (id, name) VALUES (1, 'one'), (2, 'two');");
  const repair = await app.inject({ method: 'POST', url: `/api/import/sessions/${session.id}/repair`, payload: {} });
  assert.equal(repair.statusCode, 200, repair.body);
  const prepared = repair.json().session;
  assert(prepared.gaps.length > 0);
  assert(prepared.gaps.every((gap: any) => gap.status !== 'resolved'));
  const result = await run(session.id);
  assert.equal(result.importedDatasets.length, 1);
  assert(result.session.gaps.every((gap: any) => gap.status === 'resolved'));
  const store = createPluginStore<{ id: string }>(join(root, 'import-plugins', 'versioned'));
  assert((await store.listActive()).some((entry) => entry.plugin.id === 'generated_sql_insert_dump'));
});

test('mismatched expected content rejects nonempty output and removes its dataset', async () => {
  const session = await upload('wrong.csv', 'id,value\n1,bad');
  const node = Object.values(session.nodes)[0] as any;
  const configure = await app.inject({ method: 'POST', url: `/api/import/sessions/${session.id}/nodes/${node.id}/configure`,
    payload: { values: { expectedRowsHash: '0'.repeat(64) } } });
  assert.equal(configure.statusCode, 200);
  const result = await run(session.id);
  assert.equal(result.importedDatasets.length, 0);
  assert.equal(result.session.nodes[node.id].status, 'failed');
  assert.equal(await registry.getDataset('imports-wrong'), null);
});

test('altered generated row artifacts are rejected rather than marked resolved', async () => {
  const session = await upload('tampered.sql', "INSERT INTO tamper (id) VALUES (1), (2);");
  const repair = await app.inject({ method: 'POST', url: `/api/import/sessions/${session.id}/repair`, payload: {} });
  assert.equal(repair.statusCode, 200);
  const prepared = repair.json().session;
  const node = Object.values(prepared.nodes).find((item: any) => item.metadata?.artifactPath) as any;
  assert(node);
  await writeFile(node.metadata.artifactPath, JSON.stringify([{ id: 999 }]));
  const result = await run(session.id);
  assert.equal(result.importedDatasets.length, 0);
  assert.equal(result.session.nodes[node.id].status, 'failed');
  assert(result.session.nodes[node.id].diagnostics.some((entry: string) => entry.includes('integrity')));
});

test('valid empty CSV imports as empty and its proof is persisted', async () => {
  const session = await upload('empty.csv', 'id,value\n');
  const result = await run(session.id);
  assert.equal(result.importedDatasets.length, 1);
  assert.equal((await registry.previewRows(result.importedDatasets[0].id)).rowCount, 0);
  const saved = JSON.parse(await readFile(join(root, 'import-sessions', session.id, 'session.json'), 'utf8'));
  const node = Object.values(saved.nodes)[0] as any;
  assert.equal(node.metadata.importVerification.rows, 0);
  assert.equal(node.metadata.importVerification.coverage, 'complete');
});

test('concurrent retries import once and completed inputs cannot be reconfigured', async () => {
  const session = await upload('concurrent.csv', 'id,value\n001,original');
  const replies = await Promise.all([run(session.id), run(session.id)]);
  assert.equal(replies.reduce((sum, result) => sum + result.importedDatasets.length, 0), 1);
  const node = Object.values(replies[1].session.nodes)[0] as any;
  const configured = await app.inject({ method: 'POST', url: `/api/import/sessions/${session.id}/nodes/${node.id}/configure`,
    payload: { values: { datasetName: 'changed' } } });
  assert.equal(configured.statusCode, 409);
});

test('failed candidate activation keeps the previous plugin and retry retains the registered dataset', async () => {
  const session = await upload('activation.sql', 'INSERT INTO activation (id) VALUES (1);');
  const repair = await app.inject({ method: 'POST', url: `/api/import/sessions/${session.id}/repair`, payload: {} });
  assert.equal(repair.statusCode, 200);
  const prepared = repair.json().session;
  const node = Object.values(prepared.nodes).find((item: any) => item.metadata?.artifactPath) as any;
  assert(node);
  const originalHash = node.metadata.pluginHash;
  const store = createPluginStore<{ id: string }>(join(root, 'import-plugins', 'versioned'));
  const before = await store.listActive();
  node.metadata.pluginHash = '0'.repeat(64);
  prepared.gaps = []; // Initial plugin reuse may have no repair gap at all.
  const path = join(root, 'import-sessions', session.id, 'session.json');
  await writeFile(path, JSON.stringify(prepared));
  const failed = await run(session.id);
  assert.equal(failed.importedDatasets.length, 1, 'Data is verified; only activation failed.');
  assert.equal(failed.session.nodes[node.id].metadata.pluginActivationError, true);
  assert.equal(failed.session.status, 'needs_review');
  assert(failed.session.gaps.length > 0);
  assert.deepEqual(await store.listActive(), before);
  assert(failed.session.gaps.every((gap: any) => gap.status !== 'resolved'));
  const persisted = JSON.parse(await readFile(path, 'utf8'));
  persisted.nodes[node.id].metadata.pluginHash = originalHash;
  await writeFile(path, JSON.stringify(persisted));
  const retried = await run(session.id);
  assert.equal(retried.importedDatasets.length, 0);
  assert.equal(retried.session.nodes[node.id].metadata.pluginActivationError, undefined);
});

test('a failing generated parser cannot stall the API or register a dataset', async () => {
  const store = createPluginStore<any>(join(root, 'import-plugins', 'versioned'));
  const staged = await store.stage({ id: 'fixture_hang', label: 'Isolation test fixture',
    match: { extensions: ['.hang'] }, strategy: { type: 'javascript', code: 'while (true) {}' } });
  await store.activate('fixture_hang', staged.hash);
  const pending = upload('blocked.hang', 'synthetic test input');
  const started = performance.now();
  const health = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(health.statusCode, 200);
  assert(performance.now() - started < 1000, 'API must remain responsive during generated execution.');
  const session = await pending;
  const nodes = Object.values(session.nodes) as any[];
  assert(nodes.some((node) => node.status === 'gap'));
  assert(nodes.every((node) => !node.importedDatasetId));
});

test('database imports retain a complete immutable snapshot rather than a live query', async () => {
  const require = createRequire(new URL('../../../packages/data-registry/package.json', import.meta.url));
  const Database = require('better-sqlite3');
  const path = join(root, 'source.sqlite');
  const source = new Database(path);
  source.exec("CREATE TABLE records (id TEXT PRIMARY KEY, value TEXT); INSERT INTO records VALUES ('001', 'before');");
  source.close();
  const session = await upload('source.sqlite', await readFile(path));
  const result = await run(session.id);
  assert.equal(result.importedDatasets.length, 1);
  const datasetId = result.importedDatasets[0].id;
  const node = Object.values(result.session.nodes).find((item: any) => item.importedDatasetId === datasetId) as any;
  const changed = new Database(node.sourcePath);
  changed.exec("UPDATE records SET value = 'after';");
  changed.close();
  assert.deepEqual((await registry.previewRows(datasetId)).rows, [{ id: '001', value: 'before' }]);
  assert.equal(result.importedDatasets[0].connectorId, 'inline');
});
