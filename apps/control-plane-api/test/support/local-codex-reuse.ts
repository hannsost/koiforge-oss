import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { FileDatasetRegistry } from '@koiforge/data-registry';
import { FileSecurityRegistry } from '@koiforge/security-core';
import type { AppRegistries } from '../../src/registries.js';
import { createFreshnessService } from '../../src/analysis/freshness-service.js';

const execFile = promisify(execFileCallback);
const codexBinThatMustNotRun = '/does-not-exist';

type JsonObject = Record<string, any>;

function failUnless(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function readJsonObject(value: string, description: string): JsonObject {
  try {
    const parsed = JSON.parse(value) as unknown;
    failUnless(parsed && typeof parsed === 'object' && !Array.isArray(parsed), `${description} is not a JSON object.`);
    return parsed as JsonObject;
  } catch (error) {
    throw new Error(`${description} could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readReport(root: string): Promise<JsonObject> {
  const path = join(root, 'acceptance-report.json');
  const report = readJsonObject(await readFile(path, 'utf8'), path);
  assert.equal(report.status, 'passed', `Initial acceptance report is not passed: ${String(report.error ?? 'unknown error')}`);
  return report;
}

async function runAnalysisReuse(root: string, expectedHash: string): Promise<JsonObject> {
  const dataset = new FileDatasetRegistry({ filePath: join(root, 'datasets.json') });
  const security = new FileSecurityRegistry({ filePath: join(root, 'security.json') });
  const session = await security.getSession();
  const tenantId = session.tenant.id;
  const registries = {
    dataset,
    security,
    // A reused capability must not even inspect API configuration.
    aip: { async getConfig() { throw new Error('AIP configuration was accessed during disabled reuse.'); } },
  } as unknown as AppRegistries;
  const source = await dataset.registerInlineDataset({
    namespace: 'local-codex-restart',
    name: 'synthetic-restart-dataset',
    rows: [
      { other_id: 'restart-current', other_datetime: '2026-09-23T11:45:00Z' },
      { other_id: 'restart-stale', other_datetime: '2026-09-22T10:00:00Z' },
      { other_id: 'restart-missing', other_datetime: null },
    ],
  });
  const service = createFreshnessService(root, registries);
  const startedAt = Date.now();
  const result = await service.run(tenantId, {
    question: 'Welche Restart-Quellen benötigen Aktualisierung?',
    datasetId: source.id,
    mapping: { sourceId: 'other_id', sourceUpdatedAt: 'other_datetime' },
    rule: {
      asOf: '2026-09-23T12:00:00Z',
      maxAgeSeconds: 3600,
      timestampMeaning: 'source_updated_at',
      timezone: 'explicit-offset',
    },
  }) as JsonObject;
  const durationMs = Date.now() - startedAt;
  assert.equal(result.status, 'completed_with_gaps', result.error);
  assert.equal(result.moduleHash, expectedHash, 'Restart analysis selected a different capability hash.');
  assert.deepEqual(result.generation, { attempts: 0, calls: 0, denied: 0 });
  assert.deepEqual(result.results.map((row: JsonObject) => row.status), ['current', 'stale', 'unassessable']);
  assert.equal(result.reloadReceipt.moduleHash, expectedHash);
  assert.notEqual(result.executionReceipt.executionId, result.reloadReceipt.executionId);

  return {
    status: result.status,
    hash: result.moduleHash,
    calls: result.generation.calls,
    durationMs,
    receipt: {
      executionId: result.executionReceipt.executionId,
      reloadExecutionId: result.reloadReceipt.executionId,
      moduleHash: result.reloadReceipt.moduleHash,
    },
  };
}

async function runImportReuse(root: string, expectedHash: string): Promise<JsonObject> {
  const helperPath = fileURLToPath(new URL('../fixtures/reuse-session.mjs', import.meta.url));
  const testDirectory = fileURLToPath(new URL('..', import.meta.url));
  const startedAt = Date.now();
  let child: { stdout: string; stderr: string };
  try {
    child = await execFile(process.execPath, ['--import', 'tsx', helperPath], {
      cwd: testDirectory,
      env: {
        ...process.env,
        KOIFORGE_IMPORT_DATA_ROOT: root,
        KOIFORGE_EXTENSION_BACKEND: 'codex',
        KOIFORGE_GENERATION_DISABLED: '1',
        KOIFORGE_CODEX_BIN: codexBinThatMustNotRun,
      },
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Import reuse child failed: ${detail}`);
  }
  const childResult = readJsonObject(child.stdout.trim(), 'Import reuse child output');
  assert.deepEqual(childResult.uploadGeneration, { attempts: 0, calls: 0, denied: 0 });
  assert.deepEqual(childResult.resultGeneration, { attempts: 0, calls: 0, denied: 0 });
  assert.equal(childResult.resultStatus, 'completed');
  assert.equal(childResult.resultNode?.metadata?.pluginHash, expectedHash, 'Restart import selected a different plugin hash.');
  assert.equal(childResult.resultNode?.metadata?.reloadReceipt?.moduleHash, expectedHash);

  return {
    status: childResult.resultStatus,
    hash: childResult.resultNode.metadata.pluginHash,
    calls: childResult.resultGeneration.calls,
    durationMs: Date.now() - startedAt,
    receipt: {
      executionId: childResult.resultNode.metadata.executionReceipt.executionId,
      reloadExecutionId: childResult.resultNode.metadata.reloadReceipt.executionId,
      moduleHash: childResult.resultNode.metadata.reloadReceipt.moduleHash,
    },
  };
}

async function main(): Promise<void> {
  const root = process.argv[2];
  if (!root || root.startsWith('-')) throw new Error('Usage: node --import tsx test/support/local-codex-reuse.ts <acceptance-root>');

  process.env.KOIFORGE_IMPORT_DATA_ROOT = root;
  process.env.KOIFORGE_EXTENSION_BACKEND = 'codex';
  process.env.KOIFORGE_GENERATION_DISABLED = '1';
  process.env.KOIFORGE_CODEX_BIN = codexBinThatMustNotRun;

  const report = await readReport(root);
  const expectedAnalysisHash = report.analysis?.first?.hash;
  const expectedImportHash = report.import?.first?.hash;
  failUnless(typeof expectedAnalysisHash === 'string' && /^[a-f0-9]{64}$/.test(expectedAnalysisHash), 'Initial analysis hash is missing from acceptance-report.json.');
  failUnless(typeof expectedImportHash === 'string' && /^[a-f0-9]{64}$/.test(expectedImportHash), 'Initial import hash is missing from acceptance-report.json.');

  const startedAt = Date.now();
  const analysis = await runAnalysisReuse(root, expectedAnalysisHash);
  const importReuse = await runImportReuse(root, expectedImportHash);
  const restartReport = {
    status: 'passed',
    root,
    report: join(root, 'restart-report.json'),
    backend: 'codex',
    generationDisabled: true,
    codexBin: codexBinThatMustNotRun,
    durationMs: Date.now() - startedAt,
    analysis,
    import: importReuse,
  };
  await writeFile(restartReport.report, `${JSON.stringify(restartReport, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(restartReport)}\n`);
}

void main().catch(async error => {
  const message = error instanceof Error ? error.message : String(error);
  const root = process.argv[2];
  const restartReport = {
    status: 'failed',
    root,
    report: root ? join(root, 'restart-report.json') : undefined,
    generationDisabled: true,
    codexBin: codexBinThatMustNotRun,
    error: message,
  };
  if (root) {
    await writeFile(join(root, 'restart-report.json'), `${JSON.stringify(restartReport, null, 2)}\n`, { mode: 0o600 }).catch(() => undefined);
  }
  process.stderr.write(`${JSON.stringify(restartReport)}\n`);
  process.exitCode = 1;
});
