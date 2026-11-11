import { cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { FileDatasetRegistry } from '@koiforge/data-registry';

import { readCsvTable, writeCsvTable } from './csv.js';
import { baseOrderRows, baseShipmentRows } from './default-data.js';
import { evaluateInvariants } from './invariants.js';
import { applyMutations } from './mutators.js';
import { collectSnapshot } from './probe.js';
import { loadScenario } from './scenario-loader.js';
import { buildAiHandoff, buildAiHandoffMarkdown, buildTriageSummary } from './triage.js';
import type { RegressionCommandResult, ResilienceLogEntry, ResilienceRunSummary } from './types.js';

const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function workspaceRoot(): string {
  return process.env.INIT_CWD ?? process.cwd();
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeRunId(scenarioId: string): string {
  return `${scenarioId}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

function baseArtifactDir(runId: string): string {
  return resolve(workspaceRoot(), '.koiforge', 'resilience-runs', runId);
}

function logEntry(
  runId: string,
  scenarioId: string,
  component: string,
  stage: string,
  eventType: string,
  payload: Record<string, unknown>,
  level: ResilienceLogEntry['level'] = 'info',
): ResilienceLogEntry {
  return { timestamp: nowIso(), runId, scenarioId, level, component, stage, eventType, payload };
}

function tableFromRows(rows: Array<Record<string, string>>): { headers: string[]; rows: Array<Record<string, string>> } {
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return { headers, rows };
}

function stringifyRows(rows: Array<Record<string, unknown>>): Array<Record<string, string>> {
  return rows.map((row) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value == null ? '' : String(value)])),
  );
}

function runRegressionSuite(rootDir: string): RegressionCommandResult[] {
  const commands: string[][] = [
    ['--filter', '@koiforge/module-manifest', 'run', 'test'],
    ['--filter', '@koiforge/module-system', 'run', 'test'],
    ['--filter', '@koiforge/data-registry', 'run', 'test'],
    ['--filter', '@koiforge/ontology-core', 'run', 'test'],
    ['--filter', '@koiforge/security-core', 'run', 'test'],
    ['--filter', '@koiforge/config-core', 'run', 'test'],
    ['--filter', '@koiforge/saved-view-core', 'run', 'test'],
    ['--filter', '@koiforge/asset-lineage-core', 'run', 'test'],
    ['--filter', '@koiforge/control-plane-api', 'run', 'typecheck'],
    ['--filter', '@koiforge/console-web', 'run', 'typecheck'],
  ];

  return commands.map((command) => {
    const started = Date.now();
    const executable = process.platform === 'win32' ? 'cmd.exe' : pnpmCommand;
    const args = process.platform === 'win32' ? ['/c', pnpmCommand, ...command] : command;
    const result = spawnSync(executable, args, { cwd: rootDir, stdio: 'pipe', encoding: 'utf8' });
    return {
      command: [executable, ...args],
      exitCode: result.status ?? 1,
      ok: (result.status ?? 1) === 0,
      durationMs: Date.now() - started,
    };
  });
}

function runSingleCommand(rootDir: string, command: string[]): RegressionCommandResult {
  const started = Date.now();
  const executable = process.platform === 'win32' ? 'cmd.exe' : pnpmCommand;
  const args = process.platform === 'win32' ? ['/c', pnpmCommand, ...command] : command;
  const result = spawnSync(executable, args, { cwd: rootDir, stdio: 'pipe', encoding: 'utf8' });
  return {
    command: [executable, ...args],
    exitCode: result.status ?? 1,
    ok: (result.status ?? 1) === 0,
    durationMs: Date.now() - started,
  };
}

async function copyIfExists(sourcePath: string, targetPath: string): Promise<void> {
  if (!existsSync(sourcePath)) {
    return;
  }

  await cp(sourcePath, targetPath, { recursive: true, force: true });
}

export async function runResilienceScenario(options: { scenarioId: string; withRegression?: boolean }): Promise<ResilienceRunSummary> {
  const scenario = await loadScenario(options.scenarioId);
  const rootDir = workspaceRoot();
  const runId = safeRunId(scenario.id);
  const artifactDir = baseArtifactDir(runId);
  const inputsDir = resolve(artifactDir, 'inputs');
  const stateDir = resolve(artifactDir, 'state');
  const logs: ResilienceLogEntry[] = [];

  await mkdir(inputsDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  logs.push(logEntry(runId, scenario.id, 'runner', 'load', 'scenario.loaded', { scenarioId: scenario.id, title: scenario.title }));

  const supplierBasePath = resolve(rootDir, 'examples', 'data', 'supplier-master.csv');
  const supplierBaseTable = await readCsvTable(supplierBasePath);
  const supplierMutations = scenario.datasets.find((entry) => entry.datasetId === 'suppliers')?.mutations ?? [];
  const mutatedSuppliers = applyMutations(supplierBaseTable, supplierMutations);
  const supplierScenarioPath = resolve(inputsDir, 'supplier-master.csv');
  await writeCsvTable(supplierScenarioPath, mutatedSuppliers);
  logs.push(logEntry(runId, scenario.id, 'mutator', 'suppliers', 'dataset.mutated', { rows: mutatedSuppliers.rows.length, headers: mutatedSuppliers.headers }));

  const orderBaseTable = tableFromRows(stringifyRows(baseOrderRows() as Array<Record<string, unknown>>));
  const orderMutations = scenario.datasets.find((entry) => entry.datasetId === 'orders')?.mutations ?? [];
  const mutatedOrders = applyMutations(orderBaseTable, orderMutations);
  logs.push(logEntry(runId, scenario.id, 'mutator', 'orders', 'dataset.mutated', { rows: mutatedOrders.rows.length, headers: mutatedOrders.headers }));

  const shipmentBaseTable = tableFromRows(stringifyRows(baseShipmentRows() as Array<Record<string, unknown>>));
  const shipmentMutations = scenario.datasets.find((entry) => entry.datasetId === 'shipments')?.mutations ?? [];
  const mutatedShipments = applyMutations(shipmentBaseTable, shipmentMutations);
  logs.push(logEntry(runId, scenario.id, 'mutator', 'shipments', 'dataset.mutated', { rows: mutatedShipments.rows.length, headers: mutatedShipments.headers }));

  const datasetRegistry = new FileDatasetRegistry({ filePath: resolve(stateDir, 'datasets.json') });
  await datasetRegistry.registerDataset({
    name: 'Supplier Master',
    namespace: 'procurement',
    description: `Scenario ${scenario.id}`,
    connectorId: 'csv',
    mode: 'materialized',
    tags: ['resilience', scenario.id],
    source: {
      path: supplierScenarioPath,
      delimiter: ',',
      columns: mutatedSuppliers.headers.map((header) => ({ name: header, type: header === 'riskScore' ? 'number' : 'string' })),
    },
  });

  await datasetRegistry.registerDataset({
    name: 'Purchase Orders',
    namespace: 'procurement',
    description: `Scenario ${scenario.id}`,
    connectorId: 'postgres',
    mode: 'virtual',
    tags: ['resilience', scenario.id],
    source: {
      database: 'operations',
      schema: 'public',
      table: 'purchase_orders',
      previewRows: mutatedOrders.rows,
      columns: [
        { name: 'poNumber', type: 'string', nullable: false },
        { name: 'supplierId', type: 'string' },
        { name: 'supplierName', type: 'string' },
        { name: 'status', type: 'string' },
        { name: 'value', type: 'number' },
        { name: 'createdAt', type: 'datetime' },
      ],
    },
  });

  await datasetRegistry.registerDataset({
    name: 'Shipment Events',
    namespace: 'procurement',
    description: `Scenario ${scenario.id}`,
    connectorId: 'kafka',
    mode: 'virtual',
    tags: ['resilience', scenario.id],
    source: {
      topic: 'shipment-events',
      groupId: 'resilience-lab',
      previewRows: mutatedShipments.rows,
      columns: [
        { name: 'shipmentId', type: 'string', nullable: false },
        { name: 'eventType', type: 'string' },
        { name: 'message_timestamp', type: 'datetime', nullable: false },
        { name: 'payload', type: 'json' },
      ],
    },
  });

  logs.push(logEntry(runId, scenario.id, 'registry', 'datasets', 'datasets.registered', { count: 3 }));

  const baselineRegistry = new FileDatasetRegistry({ filePath: resolve(stateDir, 'baseline-datasets.json') });
  await baselineRegistry.registerDataset({
    name: 'Supplier Master',
    namespace: 'procurement',
    description: 'Baseline',
    connectorId: 'csv',
    mode: 'materialized',
    tags: ['baseline'],
    source: {
      path: supplierBasePath,
      delimiter: ',',
      columns: supplierBaseTable.headers.map((header) => ({ name: header, type: header === 'riskScore' ? 'number' : 'string' })),
    },
  });
  await baselineRegistry.registerDataset({
    name: 'Purchase Orders',
    namespace: 'procurement',
    description: 'Baseline',
    connectorId: 'postgres',
    mode: 'virtual',
    tags: ['baseline'],
    source: { database: 'operations', schema: 'public', table: 'purchase_orders', previewRows: baseOrderRows(), columns: [{ name: 'poNumber', type: 'string', nullable: false }, { name: 'supplierId', type: 'string' }, { name: 'supplierName', type: 'string' }, { name: 'status', type: 'string' }, { name: 'value', type: 'number' }, { name: 'createdAt', type: 'datetime' }] },
  });
  await baselineRegistry.registerDataset({
    name: 'Shipment Events',
    namespace: 'procurement',
    description: 'Baseline',
    connectorId: 'kafka',
    mode: 'virtual',
    tags: ['baseline'],
    source: { topic: 'shipment-events', groupId: 'baseline', previewRows: baseShipmentRows(), columns: [{ name: 'shipmentId', type: 'string', nullable: false }, { name: 'eventType', type: 'string' }, { name: 'message_timestamp', type: 'datetime', nullable: false }, { name: 'payload', type: 'json' }] },
  });

  const beforeSnapshot = await collectSnapshot(baselineRegistry);
  const afterSnapshot = await collectSnapshot(datasetRegistry);
  logs.push(logEntry(runId, scenario.id, 'probe', 'snapshot', 'snapshot.collected', { beforeMetrics: beforeSnapshot.metrics, afterMetrics: afterSnapshot.metrics }));

  const invariants = evaluateInvariants(afterSnapshot, scenario.invariants);
  for (const invariant of invariants) {
    logs.push(logEntry(runId, scenario.id, 'invariant', 'evaluate', 'invariant.result', invariant as unknown as Record<string, unknown>, invariant.passed ? 'info' : 'warn'));
  }

  const regressionSummary = options.withRegression ? runRegressionSuite(rootDir) : [];
  for (const result of regressionSummary) {
    logs.push(logEntry(runId, scenario.id, 'regression', 'suite', 'regression.command', result as unknown as Record<string, unknown>, result.ok ? 'info' : 'error'));
  }

  const domRegression = options.withRegression ? runSingleCommand(rootDir, ['e2e']) : null;
  if (domRegression) {
    logs.push(logEntry(runId, scenario.id, 'regression', 'dom', 'regression.e2e', domRegression as unknown as Record<string, unknown>, domRegression.ok ? 'info' : 'error'));
  }

  const failedInvariantIds = invariants.filter((entry) => !entry.passed && entry.kind !== 'diagnostic').map((entry) => entry.id);
  const regressionFailed = regressionSummary.some((entry) => !entry.ok);
  const domRegressionFailed = domRegression ? !domRegression.ok : false;
  const status = failedInvariantIds.length === 0 && !regressionFailed && !domRegressionFailed ? 'passed' : 'failed';

  await writeFile(resolve(artifactDir, 'scenario.json'), `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');
  await writeFile(resolve(artifactDir, 'before_snapshot.json'), `${JSON.stringify(beforeSnapshot, null, 2)}\n`, 'utf8');
  await writeFile(resolve(artifactDir, 'after_snapshot.json'), `${JSON.stringify(afterSnapshot, null, 2)}\n`, 'utf8');
  await writeFile(resolve(artifactDir, 'invariants.json'), `${JSON.stringify(invariants, null, 2)}\n`, 'utf8');
  await writeFile(resolve(artifactDir, 'regression_summary.json'), `${JSON.stringify(regressionSummary, null, 2)}\n`, 'utf8');
  await writeFile(resolve(artifactDir, 'dom_regression.json'), `${JSON.stringify(domRegression, null, 2)}\n`, 'utf8');
  await writeFile(resolve(artifactDir, 'logs.jsonl'), `${logs.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');

  await copyIfExists(resolve(rootDir, 'packages', 'e2e-tests', 'playwright-report'), resolve(artifactDir, 'playwright-report'));
  await copyIfExists(resolve(rootDir, 'packages', 'e2e-tests', 'test-results'), resolve(artifactDir, 'playwright-test-results'));

  const summary: ResilienceRunSummary = {
    runId,
    scenarioId: scenario.id,
    bundlePath: artifactDir,
    status,
    failedInvariantIds,
    regressionFailed,
    domRegressionFailed,
  };
  await writeFile(resolve(artifactDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  const triage = buildTriageSummary({
    summary,
    invariants,
    before: beforeSnapshot,
    after: afterSnapshot,
    regression: regressionSummary,
    domRegression,
  });
  const aiHandoff = buildAiHandoff(triage, artifactDir);
  await writeFile(resolve(artifactDir, 'triage.json'), `${JSON.stringify(triage, null, 2)}\n`, 'utf8');
  await writeFile(resolve(artifactDir, 'ai_handoff.json'), `${JSON.stringify(aiHandoff, null, 2)}\n`, 'utf8');
  await writeFile(resolve(artifactDir, 'ai_handoff.md'), buildAiHandoffMarkdown(aiHandoff), 'utf8');

  await mkdir(dirname(resolve(process.cwd(), '.koiforge', 'resilience-runs', 'latest-run.txt')), { recursive: true });
  await writeFile(resolve(rootDir, '.koiforge', 'resilience-runs', 'latest-run.txt'), `${artifactDir}\n`, 'utf8');

  return summary;
}
