import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import { FileDatasetRegistry } from '@koiforge/data-registry';
import { FileSecurityRegistry } from '@koiforge/security-core';
import type { AppRegistries } from '../src/registries.js';
import { registerFreshnessRoutes } from '../src/routes/freshness.js';
import { createPluginStore } from '../src/import-capability/plugin-store.js';

// Scripted model response exercises the real HTTP provider transport and app route.
// It is not evidence of real-model code synthesis quality or a live customer pilot.
import { validCode } from './support/freshness-provider-fixture.js';

let root: string;
let app: FastifyInstance;
let registry: FileDatasetRegistry;
let provider: Server;
let providerUrl: string;
let calls = 0;
let responseCode = 'result = [];';
let aipConfig: { provider: 'custom'; model: string; baseUrl: string } | null;
const prompts: string[] = [];
const rule = { asOf: '2026-09-22T12:00:00Z', maxAgeSeconds: 3600,
  timestampMeaning: 'source_updated_at', timezone: 'explicit-offset' };
let firstRun: any;
let tenantId: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'koi-freshness-api-'));
  process.env.KOIFORGE_IMPORT_DATA_ROOT = root;
  process.env.KOIFORGE_EXTENSION_BACKEND = 'api';
  provider = createServer(async (request, response) => {
    calls += 1;
    let text = '';
    for await (const chunk of request) text += chunk;
    prompts.push(text);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ code: responseCode }) } }] }));
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  providerUrl = `http://127.0.0.1:${(provider.address() as {port:number}).port}/v1`;
  aipConfig = { provider: 'custom', model: 'fixture-analysis', baseUrl: providerUrl };
  registry = new FileDatasetRegistry({ filePath: join(root, 'datasets.json') });
  const security = new FileSecurityRegistry({ filePath: join(root, 'security.json') });
  app = Fastify();
  app.addHook('onRequest', async request => { request.koiforgeSession = await security.getSession(); });
  registerFreshnessRoutes(app, { dataset: registry, security,
    aip: { async getConfig() { return aipConfig; } },
  } as unknown as AppRegistries);
});

after(async () => {
  await app?.close();
  await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
  delete process.env.KOIFORGE_IMPORT_DATA_ROOT;
  await rm(root, { recursive: true, force: true });
});

async function run(datasetId: string, mapping = { sourceId: 'id', sourceUpdatedAt: 'updated' }, overrides = {}) {
  const response = await app.inject({ method: 'POST', url: '/api/analysis/freshness',
    payload: { question: 'Welche Daten müssen aktualisiert werden?', datasetId, mapping, rule, ...overrides } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().run;
}

function assertPublicReadiness(body: Record<string, unknown>): void {
  assert.deepEqual(Object.keys(body).sort(), ['capability', 'checkedAt', 'generation', 'provider', 'ready', 'runtime']);
  assert.equal(typeof body.checkedAt, 'string');
  const serialized = JSON.stringify(body);
  assert(!serialized.includes(providerUrl));
  assert(!serialized.includes('apiKey'));
  assert(!serialized.includes('prompt'));
  assert(!serialized.includes('result ='));
}

test('bad generated analysis cannot pass independent fixtures or become active', async () => {
  const dataset = await registry.registerInlineDataset({ namespace: 'test', name: 'bad-first',
    rows: [{ id: 'private-source-id', updated: '2026-09-22T10:00:00Z' }] });
  const result = await run(dataset.id);
  tenantId = result.tenantId;
  assert.equal(result.status, 'blocked');
  assert.equal(result.generation.calls, 1);
  assert(!result.moduleHash);
  assert.match(result.error, /Freshness verification failed/);
  assert(!prompts[0]!.includes('private-source-id'), 'Source values must not be sent to the model.');
});

test('readiness reports missing capability and model state without calling the provider', async () => {
  const beforeCalls = calls;
  const configured = await app.inject({ method: 'GET', url: '/api/analysis/freshness/readiness' });
  assert.equal(configured.statusCode, 200, configured.body);
  const configuredBody = configured.json();
  assertPublicReadiness(configuredBody);
  assert.deepEqual(configuredBody, {
    ready: true,
    capability: 'missing',
    provider: 'configured',
    runtime: 'ready',
    checkedAt: configuredBody.checkedAt,
    generation: { backend: 'api', model: 'fixture-analysis', reasoningEffort: 'xhigh', available: true },
  });
  assert.equal(calls, beforeCalls);

  const previousConfig = aipConfig;
  aipConfig = null;
  try {
    const missing = await app.inject({ method: 'GET', url: '/api/analysis/freshness/readiness' });
    assert.equal(missing.statusCode, 200, missing.body);
    const missingBody = missing.json();
    assertPublicReadiness(missingBody);
    assert.deepEqual(missingBody, {
      ready: false,
      capability: 'missing',
      provider: 'missing',
      runtime: 'ready',
      checkedAt: missingBody.checkedAt,
      generation: { backend: 'api', model: '', reasoningEffort: 'xhigh', available: false, reason: 'Kein API-Modell eingerichtet.' },
    });
    assert.equal(calls, beforeCalls);
  } finally {
    aipConfig = previousConfig;
  }
});

test('failed first activation removes the candidate and persists a blocked run without a previous version', async () => {
  responseCode = validCode;
  const dataset = await registry.registerInlineDataset({ namespace: 'test', name: 'activation-fails',
    rows: [{ id: 'activation-source', updated: '2026-09-22T10:00:00Z' }] });
  const capabilityRoot = join(root, 'analysis', createHash('sha256').update(tenantId).digest('hex'), 'capabilities');
  await mkdir(capabilityRoot, { recursive: true });
  const usagePath = join(capabilityRoot, 'usage');
  await writeFile(usagePath, 'Fault fixture: usage directory is not writable as a directory.');
  try {
    const failed = await run(dataset.id);
    assert.equal(failed.status, 'blocked');
    assert.equal(failed.rollbackError, undefined);
    const store = createPluginStore<{id:string}>(capabilityRoot);
    assert.deepEqual(await store.listActive(), []);
    assert((await store.read(failed.moduleHash)).id);
    const saved = await app.inject({ method: 'GET', url: `/api/analysis/freshness/${failed.id}` });
    assert.equal(saved.json().run.status, 'blocked');
  } finally { await rm(usagePath); }
});

test('actual provider response is checked, persisted, activated and resumed in a fresh worker', async () => {
  responseCode = validCode;
  const dataset = await registry.registerInlineDataset({ namespace: 'test', name: 'suppliers', rows: [
    { id: 'supplier-new', updated: '2026-09-22T11:30:00Z' },
    { id: 'supplier-old', updated: '2026-09-22T10:00:00Z' },
    { id: 'supplier-unknown', updated: null },
  ] });
  firstRun = await run(dataset.id);
  assert.equal(firstRun.status, 'completed_with_gaps', firstRun.error);
  assert.equal(firstRun.generation.calls, 1);
  assert.match(firstRun.moduleHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(firstRun.results.map((row: any) => row.status), ['current', 'stale', 'unassessable']);
  assert.notEqual(firstRun.executionReceipt.executionId, firstRun.reloadReceipt.executionId);
  assert.equal(firstRun.reloadReceipt.moduleHash, firstRun.moduleHash);
  assert.equal(firstRun.reloadReceipt.operationId, firstRun.id);
  assert.equal(firstRun.validation.invalidRuleRejected, true);
});

test('readiness reuses the stored capability while generation is disabled and exposes no internals', async () => {
  const previousDisabled = process.env.KOIFORGE_GENERATION_DISABLED;
  const previousConfig = aipConfig;
  const beforeCalls = calls;
  process.env.KOIFORGE_GENERATION_DISABLED = '1';
  aipConfig = null;
  try {
    const response = await app.inject({ method: 'GET', url: '/api/analysis/freshness/readiness' });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assertPublicReadiness(body);
    assert.deepEqual(body, {
      ready: true,
      capability: 'available',
      provider: 'not_required',
      runtime: 'ready',
      checkedAt: body.checkedAt,
      generation: { backend: 'api', model: '', reasoningEffort: 'xhigh', available: false, reason: 'Das Erzeugen neuer Fähigkeiten ist vom Betreiber deaktiviert.' },
    });
    assert.equal(calls, beforeCalls, 'Readiness must not invoke the provider when the capability is reusable.');
  } finally {
    aipConfig = previousConfig;
    if (previousDisabled === undefined) delete process.env.KOIFORGE_GENERATION_DISABLED;
    else process.env.KOIFORGE_GENERATION_DISABLED = previousDisabled;
  }
});

test('new API process reuses the identical module for another domain and mapping without generation', async () => {
  const dataset = await registry.registerInlineDataset({ namespace: 'test', name: 'measurements', rows: [
    { sensor: 'sensor-a', measured_source_update: '2026-09-22T11:00:00Z' },
    { sensor: 'sensor-b', measured_source_update: '2026-09-22T12:05:00Z' },
    { sensor: 'sensor-c', measured_source_update: 'unknown' },
    { sensor: 'sensor-d', measured_source_update: '2026-09-22T09:00:00Z' },
  ] });
  const beforeCalls = calls;
  const request = { question: 'Welche Messquellen benötigen Klärung?', datasetId: dataset.id,
    mapping: { sourceId: 'sensor', sourceUpdatedAt: 'measured_source_update' }, rule };
  const result = await promisify(execFile)(process.execPath,
    ['--import', 'tsx', 'test/support/freshness-restart.ts', JSON.stringify(request)],
    { env: { ...process.env, KOIFORGE_GENERATION_DISABLED: '1' }, maxBuffer: 2 * 1024 * 1024 });
  const response = JSON.parse(result.stdout);
  assert.equal(response.statusCode, 200);
  const reused = response.body.run;
  assert.equal(reused.status, 'completed_with_gaps', reused.error);
  assert.equal(reused.moduleHash, firstRun.moduleHash);
  assert.notEqual(reused.id, firstRun.id);
  assert.equal(reused.snapshot.rows.length, 4);
  assert.deepEqual(reused.generation, { attempts: 0, calls: 0, denied: 0 });
  assert.equal(calls, beforeCalls);
  assert.equal(reused.results[1].reason, 'future_timestamp');
  assert.equal(reused.results[2].reason, 'invalid_timestamp');
  assert(reused.results.every((row: any) => !row.sourceId.startsWith('supplier')));
});

test('historical source evidence survives source deletion, and all 10,001 current input rows are assessed', async () => {
  await registry.deleteDataset(firstRun.datasetId);
  const history = await app.inject({ method: 'GET', url: `/api/analysis/freshness/${firstRun.id}` });
  assert.deepEqual(history.json().run, firstRun);
  const dataset = await registry.registerInlineDataset({ namespace: 'test', name: 'large',
    rows: Array.from({ length: 10_001 }, (_, i) => ({ id: `row-${i}`, updated: '2026-09-22T11:00:00Z' })) });
  const result = await run(dataset.id);
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.results.length, 10_001);
  assert.equal(result.snapshot.rows.length, 10_001);
  assert.equal(result.generation.attempts, 0);
  const empty = await registry.registerInlineDataset({ namespace: 'test', name: 'empty', rows: [] });
  const emptyRun = await run(empty.id);
  assert.equal(emptyRun.status, 'completed', emptyRun.error);
  assert.deepEqual(emptyRun.results, []);
});

test('wrong mapping, duplicate identifiers and unconfirmed interval cannot become successful runs', async () => {
  const source = await registry.registerInlineDataset({ namespace: 'test', name: 'duplicate', rows: [
    { id: 'same', updated: '2026-09-22T11:00:00Z' }, { id: 'same', updated: null },
  ] });
  assert.equal((await run(source.id)).status, 'blocked');
  assert.equal((await run(source.id, { sourceId: 'absent', sourceUpdatedAt: 'updated' })).status, 'blocked');
  const response = await app.inject({ method: 'POST', url: '/api/analysis/freshness',
    payload: { question: 'Q', datasetId: source.id, mapping: { sourceId: 'id', sourceUpdatedAt: 'updated' }, rule: { ...rule, maxAgeSeconds: 0 } } });
  assert.equal(response.statusCode, 400);
  const tenants = await readdir(join(root, 'analysis'));
  const journal = await readFile(join(root, 'analysis', tenants[0]!, 'generation-events.jsonl'), 'utf8');
  assert.equal(journal.trim().split('\n').length, 3, 'Bad candidate, failed first activation and successful generation are recorded; reuse adds none.');
});
