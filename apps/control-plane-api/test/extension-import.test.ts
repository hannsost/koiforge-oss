import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { FileDatasetRegistry } from '@koiforge/data-registry';
import { FileSecurityRegistry } from '@koiforge/security-core';
import type { AppRegistries } from '../src/registries.js';
import { createPluginStore } from '../src/import-capability/plugin-store.js';

const execFile = promisify(execFileCallback);

const GOOD_PARSER = String.raw`
const lines = content.replace(/\r\n?/g, '\n').trimEnd().split('\n');
if (lines.length < 3 || lines[0] !== 'SUPPLY/1') throw new Error('Unsupported SUPPLY document.');
const columns = lines[1].split('|');
if (columns.length !== 2 || columns.some((column) => !/^[A-Za-z][A-Za-z0-9_-]*$/.test(column))) throw new Error('Invalid SUPPLY columns.');
const rows = [];
for (const line of lines.slice(2)) {
  const cells = line.split('|');
  if (cells.length !== 2 || cells.some((cell) => cell.length === 0)) throw new Error('Invalid SUPPLY row.');
  rows.push({ [columns[0]]: cells[0], [columns[1]]: cells[1] });
}
if (rows.length === 0) throw new Error('SUPPLY document has no rows.');
result = rows;
`.trim();

const BAD_PARSER = `result = [{ candidate: 'wrong' }];`;

const FORMAT_DESCRIPTION = 'SUPPLY/1, followed by a two-column pipe-delimited header and pipe-delimited rows.';

type FixtureMode = 'good' | 'bad';

let root: string;
let provider: Server;
let providerUrl: string;
let providerCalls = 0;
let fixtureMode: FixtureMode = 'good';
let registerImportSessionRoutes: typeof import('../src/routes/import-sessions.js')['registerImportSessionRoutes'];
let previousDataRoot: string | undefined;
let previousGenerationDisabled: string | undefined;

function fixtureRows(input: string, rows: Array<Record<string, string>>): { input: string; rows: Array<Record<string, string>> } {
  return { input, rows };
}

function validationFixtures(): string {
  return JSON.stringify([
    fixtureRows('SUPPLY/1\nfield|other\nalpha|one\n', [{ field: 'alpha', other: 'one' }]),
    fixtureRows('SUPPLY/1\nleft|right\nbeta|two\n', [{ left: 'beta', right: 'two' }]),
    { input: 'NOPE\nfield|other\nalpha|one\n', reject: true },
  ]);
}

function providerPlan() {
  return {
    planType: 'generate_adapter',
    executionMode: 'tabular_parser',
    strategy: 'javascript',
    params: { code: fixtureMode === 'good' ? GOOD_PARSER : BAD_PARSER },
    reasoning: 'The fixture format is a bounded text grammar and needs a reusable parser.',
    expectedOutcome: 'The source becomes previewable and importable through a reusable generated parser.',
  };
}

async function startProvider(): Promise<{ server: Server; url: string }> {
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.statusCode = 404;
      response.end('not found');
      return;
    }

    for await (const _chunk of request) {
      // Consume the request body so the fixture behaves like a real provider.
    }
    providerCalls += 1;
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: JSON.stringify(providerPlan()) } }],
      model: 'fixture-parser',
    }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  return { server, url: `http://127.0.0.1:${address.port}/v1` };
}

async function createApp(): Promise<{ app: FastifyInstance; registry: FileDatasetRegistry }> {
  const registry = new FileDatasetRegistry({ filePath: join(root, 'datasets.json') });
  const security = new FileSecurityRegistry({ filePath: join(root, 'security.json') });
  const aipConfig = {
    provider: 'custom' as const,
    model: 'fixture-parser',
    baseUrl: providerUrl,
  };
  const app = Fastify();
  app.addHook('onRequest', async request => { request.koiforgeSession = await security.getSession(); });
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
  await registerImportSessionRoutes(app, {
    dataset: registry,
    security,
    aip: { async getConfig() { return aipConfig; } },
  } as unknown as AppRegistries);
  await app.ready();
  return { app, registry };
}

async function upload(app: FastifyInstance, name: string, contents: string) {
  const boundary = `koi-ke1-${name.replace(/[^a-z0-9]/gi, '')}`;
  const response = await app.inject({
    method: 'POST',
    url: '/api/import/sessions',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      Buffer.from(contents),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().session as any;
}

function sourceNode(session: any): any {
  const node = Object.values(session.nodes).find((entry: any) => entry.sourcePath?.endsWith('.supply')) as any;
  assert(node, 'SUPPLY source node was not discovered.');
  return node;
}

async function configure(app: FastifyInstance, sessionId: string, nodeId: string, values: Record<string, unknown>) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/import/sessions/${sessionId}/nodes/${nodeId}/configure`,
    payload: { values },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

async function repair(app: FastifyInstance, sessionId: string, nodeId: string) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/import/sessions/${sessionId}/repair`,
    payload: { nodeIds: [nodeId] },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

async function run(app: FastifyInstance, sessionId: string) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/import/sessions/${sessionId}/run`,
    payload: {},
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

before(async () => {
  previousDataRoot = process.env.KOIFORGE_IMPORT_DATA_ROOT;
  previousGenerationDisabled = process.env.KOIFORGE_GENERATION_DISABLED;
  root = await mkdtemp(join(tmpdir(), 'koiforge-extension-import-'));
  process.env.KOIFORGE_IMPORT_DATA_ROOT = root;
  process.env.KOIFORGE_EXTENSION_BACKEND = 'api';
  delete process.env.KOIFORGE_GENERATION_DISABLED;

  const fixture = await startProvider();
  provider = fixture.server;
  providerUrl = fixture.url;
  ({ registerImportSessionRoutes } = await import(`../src/routes/import-sessions.js?ke1-extension-${Date.now()}`));
});

after(async () => {
  await provider?.close();
  await rm(root, { recursive: true, force: true });
  if (previousDataRoot === undefined) delete process.env.KOIFORGE_IMPORT_DATA_ROOT;
  else process.env.KOIFORGE_IMPORT_DATA_ROOT = previousDataRoot;
  if (previousGenerationDisabled === undefined) delete process.env.KOIFORGE_GENERATION_DISABLED;
  else process.env.KOIFORGE_GENERATION_DISABLED = previousGenerationDisabled;
});

test('generates, activates, reloads, survives process restart, and bounds a failed replacement', async () => {
  fixtureMode = 'good';
  const first = await createApp();
  const firstSession = await upload(first.app, 'first.supply', 'SUPPLY/1\norder_id|status\norder-017|delayed\n');
  const firstNode = sourceNode(firstSession);
  assert.equal(firstNode.status, 'gap');
  assert.equal(firstNode.capabilityId, undefined);

  await configure(first.app, firstSession.id, firstNode.id, {
    formatDescription: FORMAT_DESCRIPTION,
    validationFixtures: validationFixtures(),
    expectedRows: 1,
    requiredColumns: 'order_id,status',
  });
  const firstRepair = await repair(first.app, firstSession.id, firstNode.id);
  assert.deepEqual(firstRepair.repairedNodeIds, [firstNode.id]);
  const repairedNode = firstRepair.session.nodes[firstNode.id];
  assert.equal(repairedNode.metadata.pluginHash.length, 64);
  assert.equal(repairedNode.metadata.executionReceipt.rows, 1);
  assert.equal(firstRepair.session.generation.attempts, 1);
  assert.equal(firstRepair.session.generation.calls, 1);
  assert.equal(firstRepair.session.generation.denied, 0);
  assert.equal(providerCalls, 1);

  const firstResult = await run(first.app, firstSession.id);
  const firstResultNode = firstResult.session.nodes[firstNode.id];
  assert.equal(firstResult.importedDatasets.length, 1);
  assert.deepEqual(
    (await first.registry.previewRows(firstResult.importedDatasets[0].id)).rows,
    [{ order_id: 'order-017', status: 'delayed' }],
  );
  assert.notEqual(firstResultNode.metadata.reloadReceipt.executionId, firstResultNode.metadata.executionReceipt.executionId);
  assert.equal(firstResultNode.metadata.reloadReceipt.moduleHash, repairedNode.metadata.pluginHash);

  const store = createPluginStore<{ id: string }>(join(root, 'import-plugins', 'versioned'));
  const active = await store.listActive();
  assert.equal(active.length, 1);
  const activeHash = active[0]!.hash;
  assert.equal(activeHash, repairedNode.metadata.pluginHash);
  const artifactNamesBeforeReuse = await readdir(join(root, 'import-plugins', 'versioned', 'artifacts'));
  await first.app.close();

  // This starts a fresh Node runtime and a fresh Fastify instance while using
  // the same generated-plugin and dataset storage. The provider is disabled;
  // reuse must come entirely from the activated artifact.
  process.env.KOIFORGE_GENERATION_DISABLED = '1';
  const helperPath = fileURLToPath(new URL('./fixtures/reuse-session.mjs', import.meta.url));
  const child = await execFile(process.execPath, ['--import', 'tsx', helperPath], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, KOIFORGE_IMPORT_DATA_ROOT: root, KOIFORGE_GENERATION_DISABLED: '1' },
    maxBuffer: 8 * 1024 * 1024,
  });
  const restarted = JSON.parse(child.stdout) as any;
  assert.equal(restarted.uploadGeneration.attempts, 0);
  assert.equal(restarted.uploadGeneration.calls, 0);
  assert.equal(restarted.uploadGeneration.denied, 0);
  assert.equal(restarted.resultGeneration.attempts, 0);
  assert.equal(restarted.resultGeneration.calls, 0);
  assert.equal(restarted.resultGeneration.denied, 0);
  assert.equal(restarted.resultNode.metadata.pluginHash, activeHash);
  assert.equal(restarted.resultNode.metadata.reloadReceipt.moduleHash, activeHash);
  assert.equal(restarted.resultStatus, 'completed');
  assert.equal(providerCalls, 1, 'the disabled restart session must not call the fixture provider');

  const persistedRegistry = new FileDatasetRegistry({ filePath: join(root, 'datasets.json') });
  const secondDataset = restarted.importedDatasets[0];
  assert.deepEqual((await persistedRegistry.previewRows(secondDataset.id)).rows, [
    { measurement_id: 'm-001', measurement_value: '10' },
    { measurement_id: 'm-002', measurement_value: '20' },
    { measurement_id: 'm-003', measurement_value: '30' },
  ]);
  assert.deepEqual(await readdir(join(root, 'import-plugins', 'versioned', 'artifacts')), artifactNamesBeforeReuse);

  // Exercise an explicit denied generation attempt. The counters must be
  // persisted as a denial rather than looking like an untouched session.
  const deniedBefore = providerCalls;
  const denied = await createApp();
  const deniedSession = await upload(denied.app, 'denied.supply', 'SUPPLY/9\norder_id|status\norder-018|blocked\n');
  const deniedNode = sourceNode(deniedSession);
  await configure(denied.app, deniedSession.id, deniedNode.id, {
    formatDescription: 'Unsupported SUPPLY/9 document.',
  });
  const deniedRepair = await repair(denied.app, deniedSession.id, deniedNode.id);
  assert.deepEqual(deniedRepair.session.generation, { attempts: 1, calls: 0, denied: 1 });
  const deniedPersisted = await denied.app.inject({ method: 'GET', url: `/api/import/sessions/${deniedSession.id}` });
  assert.equal(deniedPersisted.statusCode, 200, deniedPersisted.body);
  assert.deepEqual(deniedPersisted.json().session.generation, { attempts: 1, calls: 0, denied: 1 });
  assert.equal(providerCalls, deniedBefore, 'disabled generation must not call the fixture provider');
  await denied.app.close();

  // A same-suffix source with an incompatible grammar cannot be repaired by
  // the active parser. The fixture provider then returns a failing candidate;
  // fixture validation must reject it before any artifact is staged.
  delete process.env.KOIFORGE_GENERATION_DISABLED;
  fixtureMode = 'bad';
  const failed = await createApp();
  const failedSession = await upload(failed.app, 'incompatible.supply', 'SUPPLY/2\norder_id|status\norder-019|bad\n');
  const failedNode = sourceNode(failedSession);
  assert.equal(failedNode.status, 'gap');
  await configure(failed.app, failedSession.id, failedNode.id, {
    formatDescription: FORMAT_DESCRIPTION,
    validationFixtures: validationFixtures(),
    expectedRows: 1,
    requiredColumns: 'order_id,status',
  });
  const artifactsBeforeFailedRepair = await readdir(join(root, 'import-plugins', 'versioned', 'artifacts'));
  const failedRepair = await repair(failed.app, failedSession.id, failedNode.id);
  assert.equal(failedRepair.session.generation.attempts, 2);
  assert.equal(failedRepair.session.generation.calls, 2);
  assert.equal(failedRepair.session.generation.denied, 0);
  assert.equal(providerCalls, 3);
  assert.deepEqual(await readdir(join(root, 'import-plugins', 'versioned', 'artifacts')), artifactsBeforeFailedRepair);
  assert.equal((await store.listActive())[0]!.hash, activeHash);

  const failedResult = await run(failed.app, failedSession.id);
  assert.equal(failedResult.importedDatasets.length, 0);
  assert.notEqual(failedResult.session.status, 'completed');
  assert.notEqual(failedResult.session.nodes[failedNode.id].status, 'imported');
  await failed.app.close();
});
