import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { FileDatasetRegistry } from '@koiforge/data-registry';
import { FileSecurityRegistry } from '@koiforge/security-core';
import type { AppRegistries } from '../../src/registries.js';
import { createFreshnessService } from '../../src/analysis/freshness-service.js';
import { CODEX_GENERATION } from '../../src/import-capability/codex-generator.js';
import { createPluginStore } from '../../src/import-capability/plugin-store.js';

type JsonObject = Record<string, unknown>;

const FORMAT_DESCRIPTION = 'SUPPLY/1, followed by a two-column pipe-delimited header and pipe-delimited rows.';

/*
 * These are intentionally independent from the uploaded source. They are sent
 * to the product only as post-generation validation input; the repair prompt
 * contains neither these expected rows nor this fixture JSON.
 */
const IMPORT_VALIDATION_FIXTURES = JSON.stringify([
  {
    input: 'SUPPLY/1\nitem|value\nalpha|one\n',
    rows: [{ item: 'alpha', value: 'one' }],
  },
  {
    input: 'SUPPLY/1\nitem|value\nbeta|two\n',
    rows: [{ item: 'beta', value: 'two' }],
  },
  {
    input: 'NOT-SUPPLY\nitem|value\nalpha|one\n',
    reject: true,
  },
]);

function assertion(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function tenantDirectory(root: string, tenantId: string): string {
  return join(root, 'analysis', createHash('sha256').update(tenantId).digest('hex'));
}

function receiptSummary(receipt: JsonObject | undefined): JsonObject | undefined {
  if (!receipt) return undefined;
  return {
    executionId: receipt.executionId,
    operationId: receipt.operationId,
    moduleHash: receipt.moduleHash,
    codeHash: receipt.codeHash,
    inputHash: receipt.inputHash,
    outputHash: receipt.outputHash,
    rows: receipt.rows,
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
  };
}

function configuredRegistries(
  dataset: FileDatasetRegistry,
  security: FileSecurityRegistry,
): AppRegistries {
  // The codex backend does not consult AIP configuration. Keeping this null
  // proves the acceptance uses the local ChatGPT-login transport exclusively.
  return {
    dataset,
    security,
    aip: { async getConfig() { return null; } },
  } as unknown as AppRegistries;
}

async function upload(app: FastifyInstance, name: string, contents: string): Promise<any> {
  const boundary = `koi-local-codex-${name.replace(/[^a-z0-9]/gi, '')}`;
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
  const body = response.json() as { session?: any };
  assertion(body.session, 'Upload returned no import session.');
  return body.session;
}

function sourceNode(session: any): any {
  const node = Object.values(session.nodes).find((entry: any) => entry.sourcePath?.endsWith('.supply')) as any;
  assertion(node, 'SUPPLY source node was not discovered.');
  return node;
}

async function configure(
  app: FastifyInstance,
  sessionId: string,
  nodeId: string,
  values: Record<string, string | number | boolean>,
): Promise<any> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/import/sessions/${sessionId}/nodes/${nodeId}/configure`,
    payload: { values },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

async function repair(app: FastifyInstance, sessionId: string, nodeId: string): Promise<any> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/import/sessions/${sessionId}/repair`,
    payload: { nodeIds: [nodeId] },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

async function runImport(app: FastifyInstance, sessionId: string): Promise<any> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/import/sessions/${sessionId}/run`,
    payload: {},
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

async function createImportApp(
  registries: AppRegistries,
  security: FileSecurityRegistry,
): Promise<FastifyInstance> {
  const { registerImportSessionRoutes } = await import('../../src/routes/import-sessions.js');
  const app = Fastify();
  app.addHook('onRequest', async request => {
    request.koiforgeSession = await security.getSession();
  });
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
  await registerImportSessionRoutes(app, registries);
  await app.ready();
  return app;
}

async function runAnalysisAcceptance(
  root: string,
  registries: AppRegistries,
  tenantId: string,
): Promise<JsonObject> {
  const rule = {
    asOf: '2026-09-23T12:00:00Z',
    maxAgeSeconds: 3600,
    timestampMeaning: 'source_updated_at' as const,
    timezone: 'explicit-offset' as const,
  };
  const dataset = await registries.dataset.registerInlineDataset({
    namespace: 'local-codex-acceptance',
    name: 'synthetic-freshness',
    rows: [
      { source_id: 'synthetic-current', source_updated_at: '2026-09-23T11:45:00Z' },
      { source_id: 'synthetic-stale', source_updated_at: '2026-09-22T10:00:00Z' },
      { source_id: 'synthetic-missing', source_updated_at: null },
    ],
  });
  const request = {
    question: 'Welche synthetischen Quellen benötigen Aktualisierung?',
    datasetId: dataset.id,
    mapping: { sourceId: 'source_id', sourceUpdatedAt: 'source_updated_at' },
    rule,
  };

  const firstStarted = Date.now();
  const firstService = createFreshnessService(root, registries);
  const first = await firstService.run(tenantId, request) as any;
  const firstDurationMs = Date.now() - firstStarted;
  assert.equal(first.status, 'completed_with_gaps', first.error);
  assert.deepEqual(first.results.map((row: any) => row.status), ['current', 'stale', 'unassessable']);
  assert.deepEqual(first.results.map((row: any) => row.reason), [
    'within_interval', 'interval_exceeded', 'missing_timestamp',
  ]);
  assert.deepEqual(first.generation, { attempts: 1, calls: 1, denied: 0 });
  assertion(typeof first.moduleHash === 'string' && /^[a-f0-9]{64}$/.test(first.moduleHash), 'Analysis did not publish a capability hash.');
  assert.equal(first.validation?.suite, 'freshness-independent-v1');
  assert.equal(first.validation?.invalidRuleRejected, true);
  assert.equal(first.validation?.executions?.length, 2);
  assertion(first.executionReceipt && first.reloadReceipt, 'Analysis did not produce execution and reload receipts.');
  assert.notEqual(first.executionReceipt.executionId, first.reloadReceipt.executionId);
  assert.equal(first.reloadReceipt.moduleHash, first.moduleHash);

  const analysisStore = createPluginStore<{ id: string }>(join(
    tenantDirectory(root, tenantId), 'capabilities',
  ));
  const active = await analysisStore.listActive();
  const activeCapability = active.find(entry => entry.plugin.id === 'analysis_source_freshness_v1');
  assertion(activeCapability, 'Verified freshness capability is not active.');
  assert.equal(activeCapability.hash, first.moduleHash);

  process.env.KOIFORGE_GENERATION_DISABLED = '1';
  const reuseStarted = Date.now();
  const reuseService = createFreshnessService(root, registries);
  const secondDataset = await registries.dataset.registerInlineDataset({
    namespace: 'local-codex-acceptance',
    name: 'synthetic-freshness-reuse',
    rows: [
      { sensor_id: 'synthetic-sensor-current', observed_at: '2026-09-23T11:59:00Z' },
      { sensor_id: 'synthetic-sensor-stale', observed_at: '2026-09-20T12:00:00Z' },
      { sensor_id: 'synthetic-sensor-missing', observed_at: null },
    ],
  });
  const reused = await reuseService.run(tenantId, {
    ...request,
    question: 'Welche synthetischen Sensoren benötigen Aktualisierung?',
    datasetId: secondDataset.id,
    mapping: { sourceId: 'sensor_id', sourceUpdatedAt: 'observed_at' },
  }) as any;
  const reuseDurationMs = Date.now() - reuseStarted;
  assert.equal(reused.status, 'completed_with_gaps', reused.error);
  assert.equal(reused.moduleHash, first.moduleHash);
  assert.deepEqual(reused.generation, { attempts: 0, calls: 0, denied: 0 });
  assert.deepEqual(reused.results.map((row: any) => row.status), ['current', 'stale', 'unassessable']);
  assert.notEqual(reused.executionReceipt.executionId, reused.reloadReceipt.executionId);
  assert.equal(reused.reloadReceipt.moduleHash, first.moduleHash);

  return {
    model: CODEX_GENERATION.model,
    reasoningEffort: CODEX_GENERATION.reasoningEffort,
    first: {
      status: first.status,
      calls: first.generation.calls,
      durationMs: firstDurationMs,
      hash: first.moduleHash,
      independentValidation: {
        suite: first.validation.suite,
        invalidRuleRejected: first.validation.invalidRuleRejected,
        executions: first.validation.executions.length,
      },
      receipt: receiptSummary(first.executionReceipt),
      reloadReceipt: receiptSummary(first.reloadReceipt),
    },
    reuse: {
      status: reused.status,
      calls: reused.generation.calls,
      durationMs: reuseDurationMs,
      hash: reused.moduleHash,
      receipt: receiptSummary(reused.executionReceipt),
      reloadReceipt: receiptSummary(reused.reloadReceipt),
    },
  };
}

async function runImportAcceptance(
  root: string,
  registries: AppRegistries,
  security: FileSecurityRegistry,
): Promise<JsonObject> {
  delete process.env.KOIFORGE_GENERATION_DISABLED;
  const firstApp = await createImportApp(registries, security);
  let firstSession: any;
  let firstResult: any;
  let firstDurationMs = 0;
  let firstPluginHash = '';
  try {
    const firstStarted = Date.now();
    firstSession = await upload(firstApp, 'first.supply', 'SUPPLY/1\norder_id|status\norder-017|delayed\n');
    const firstNode = sourceNode(firstSession);
    assert.equal(firstNode.status, 'gap');
    await configure(firstApp, firstSession.id, firstNode.id, {
      formatDescription: FORMAT_DESCRIPTION,
      validationFixtures: IMPORT_VALIDATION_FIXTURES,
      expectedRows: 1,
      requiredColumns: 'order_id,status',
      datasetName: 'local-codex-first-supply',
      namespace: 'local-codex-acceptance',
    });
    const repaired = await repair(firstApp, firstSession.id, firstNode.id);
    const repairedNode = repaired.session.nodes[firstNode.id];
    assert.deepEqual(repaired.repairedNodeIds, [firstNode.id]);
    assertion(typeof repairedNode.metadata?.pluginHash === 'string', 'Import repair did not publish a plugin hash.');
    firstPluginHash = repairedNode.metadata.pluginHash;
    assert.match(firstPluginHash, /^[a-f0-9]{64}$/);
    assert.equal(repairedNode.metadata.executionReceipt.rows, 1);
    assert.equal(repaired.session.generation.attempts, 1);
    assert.equal(repaired.session.generation.calls, 1);
    assert.equal(repaired.session.generation.denied, 0);

    firstResult = await runImport(firstApp, firstSession.id);
    firstDurationMs = Date.now() - firstStarted;
    assert.equal(firstResult.importedDatasets.length, 1);
    const firstResultNode = firstResult.session.nodes[firstNode.id];
    assert.equal(firstResult.session.generation.calls, 1);
    assert.equal(firstResultNode.metadata.pluginHash, firstPluginHash);
    assert.notEqual(
      firstResultNode.metadata.executionReceipt.executionId,
      firstResultNode.metadata.reloadReceipt.executionId,
    );
    assert.equal(firstResultNode.metadata.reloadReceipt.moduleHash, firstPluginHash);
    const preview = await registries.dataset.previewRows(firstResult.importedDatasets[0].id);
    assert.deepEqual(preview.rows, [{ order_id: 'order-017', status: 'delayed' }]);

    const importStore = createPluginStore<{ id: string }>(join(root, 'import-plugins', 'versioned'));
    const active = await importStore.listActive();
    assertion(active.some(entry => entry.hash === firstPluginHash), 'Verified import plugin is not active.');
  } finally {
    await firstApp.close();
  }

  process.env.KOIFORGE_GENERATION_DISABLED = '1';
  const reuseApp = await createImportApp(registries, security);
  try {
    const reuseStarted = Date.now();
    const reuseSession = await upload(
      reuseApp,
      'second.supply',
      'SUPPLY/1\nmeasurement_id|measurement_value\nm-001|10\nm-002|20\nm-003|30\n',
    );
    const reuseNode = sourceNode(reuseSession);
    await configure(reuseApp, reuseSession.id, reuseNode.id, {
      datasetName: 'local-codex-second-supply',
      namespace: 'local-codex-acceptance',
      expectedRows: 3,
      requiredColumns: 'measurement_id,measurement_value',
    });
    const reusedResult = await runImport(reuseApp, reuseSession.id);
    const reuseDurationMs = Date.now() - reuseStarted;
    assert.equal(reusedResult.session.generation.attempts, 0);
    assert.equal(reusedResult.session.generation.calls, 0);
    assert.equal(reusedResult.session.generation.denied, 0);
    assert.equal(reusedResult.session.status, 'completed');
    const reusedNode = reusedResult.session.nodes[reuseNode.id];
    assert.equal(reusedNode.metadata.pluginHash, firstPluginHash);
    assert.equal(reusedNode.metadata.reloadReceipt.moduleHash, firstPluginHash);
    const reusedDataset = reusedResult.importedDatasets[0];
    assertion(reusedDataset, 'Disabled reuse did not import a dataset.');
    const preview = await registries.dataset.previewRows(reusedDataset.id);
    assert.deepEqual(preview.rows, [
      { measurement_id: 'm-001', measurement_value: '10' },
      { measurement_id: 'm-002', measurement_value: '20' },
      { measurement_id: 'm-003', measurement_value: '30' },
    ]);

    return {
      model: CODEX_GENERATION.model,
      reasoningEffort: CODEX_GENERATION.reasoningEffort,
      first: {
        status: firstResult.session.status,
        calls: firstResult.session.generation.calls,
        durationMs: firstDurationMs,
        hash: firstPluginHash,
        receipt: receiptSummary(firstResult.session.nodes[Object.keys(firstResult.session.nodes).find((id) => firstResult.session.nodes[id].metadata?.pluginHash === firstPluginHash)]?.metadata?.executionReceipt),
        reloadReceipt: receiptSummary(firstResult.session.nodes[Object.keys(firstResult.session.nodes).find((id) => firstResult.session.nodes[id].metadata?.pluginHash === firstPluginHash)]?.metadata?.reloadReceipt),
      },
      reuse: {
        status: reusedResult.session.status,
        calls: reusedResult.session.generation.calls,
        durationMs: reuseDurationMs,
        hash: firstPluginHash,
        receipt: receiptSummary(reusedNode.metadata?.executionReceipt),
        reloadReceipt: receiptSummary(reusedNode.metadata?.reloadReceipt),
      },
    };
  } finally {
    await reuseApp.close();
  }
}

async function main(): Promise<void> {
  const requestedRoot = process.env.KOIFORGE_ACCEPTANCE_ROOT?.trim();
  const parent = requestedRoot ? resolve(requestedRoot) : tmpdir();
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'koiforge-local-codex-'));
  process.env.KOIFORGE_ACCEPTANCE_ROOT = root;
  process.env.KOIFORGE_IMPORT_DATA_ROOT = root;
  process.env.KOIFORGE_EXTENSION_BACKEND = 'codex';
  delete process.env.KOIFORGE_GENERATION_DISABLED;

  const dataset = new FileDatasetRegistry({ filePath: join(root, 'datasets.json') });
  const security = new FileSecurityRegistry({ filePath: join(root, 'security.json') });
  const registries = configuredRegistries(dataset, security);
  const tenantId = (await security.getSession()).tenant.id;
  const startedAt = Date.now();
  process.stderr.write(JSON.stringify({ stage: 'analysis:start', root }) + '\n');
  const analysis = await runAnalysisAcceptance(root, registries, tenantId);
  process.stderr.write(JSON.stringify({ stage: 'analysis:passed', root }) + '\n');
  process.stderr.write(JSON.stringify({ stage: 'import:start', root }) + '\n');
  const imports = await runImportAcceptance(root, registries, security);
  const report = {
    status: 'passed',
    root,
    report: join(root, 'acceptance-report.json'),
    backend: 'codex',
    model: CODEX_GENERATION.model,
    reasoningEffort: CODEX_GENERATION.reasoningEffort,
    durationMs: Date.now() - startedAt,
    analysis,
    import: imports,
  };
  await writeFile(join(root, 'acceptance-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

void main().catch(async error => {
  const message = error instanceof Error ? error.message : String(error);
  const root = process.env.KOIFORGE_ACCEPTANCE_ROOT;
  const report = {
    status: 'failed',
    root,
    report: root ? join(root, 'acceptance-report.json') : undefined,
    backend: 'codex',
    model: CODEX_GENERATION.model,
    reasoningEffort: CODEX_GENERATION.reasoningEffort,
    error: message,
  };
  if (root) {
    await writeFile(join(root, 'acceptance-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }).catch(() => undefined);
  }
  process.stderr.write(`${JSON.stringify(report)}\n`);
  process.exitCode = 1;
});
