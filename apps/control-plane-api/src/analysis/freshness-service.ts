import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, open, link, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatasetRecord, DatasetPreviewResult } from '@koiforge/data-registry';
import { generationProvider, type GenerationStatus } from '../import-capability/generation-provider.js';
import type { AppRegistries } from '../registries.js';
import { auditGeneration, emptyGenerationAudit } from '../import-capability/generation-audit.js';
import { createPluginStore } from '../import-capability/plugin-store.js';
import { EXECUTION_PROFILE, executeImportParser, rowsHash, validateRows, type ImportRow } from '../import-capability/isolated-executor.js';
import { expectedFreshnessRows, validateFreshnessRule, verifyFreshnessRows, type FreshnessRule } from './freshness-contract.js';

interface AnalysisCapability {
  id: string;
  kind: 'analysis';
  abi: 'freshness-v1';
  code: string;
  permissions: 'no-files-no-network';
}

const capabilityId = 'analysis_source_freshness_v1';

export interface FreshnessReadiness {
  ready: boolean;
  capability: 'available' | 'missing';
  provider: 'configured' | 'missing' | 'disabled' | 'not_required';
  runtime: 'ready' | 'unavailable';
  checkedAt: string;
  generation?: GenerationStatus;
}
const contract = `Implement the missing freshness-v1 capability, not a fixed dataset.
Return JSON {"code":"JavaScript assigning result = [...]"}, no markdown.
The content string is JSON {rows,rule}. No imports, files, network or dependencies.
Rows contain {sourceId:string,sourceUpdatedAt:string|null}. Rule contains asOf,
maxAgeSeconds, timestampMeaning:'source_updated_at', timezone:'explicit-offset'.
Validate rule: positive safe integer maxAgeSeconds <=315360000; asOf strict valid
ISO timestamp YYYY-MM-DDTHH:mm:ss[.fraction](Z|+HH:mm|-HH:mm). Fraction may contain
one or more digits; retain milliseconds by truncating beyond three digits.
Offset required. Reject
impossible calendar dates, hours/minutes/seconds and invalid offsets, never normalize
Feb 30. Invalid rule or duplicate/empty source IDs must throw. Empty rows are valid.
For each row preserve order and return exactly {sourceId,sourceUpdatedAt,status,
ageSeconds,reason}. Missing/null/empty timestamp: unassessable,null,missing_timestamp.
Invalid timestamp: unassessable,null,invalid_timestamp. Future: unassessable,null,
future_timestamp. Otherwise ageSeconds=(asOf-timestamp)/1000, status current when
age <= maxAgeSeconds (reason within_interval), else stale (interval_exceeded).
No inferred interval, fallback timestamp or dropped records.`;

// Independent acceptance inputs are never sent to the generating provider.
export const freshnessAcceptance = {
  rule: { asOf: '2026-09-22T12:00:00Z', maxAgeSeconds: 3600,
    timestampMeaning: 'source_updated_at', timezone: 'explicit-offset' } as FreshnessRule,
  rows: [
    { sourceId: 'boundary', sourceUpdatedAt: '2026-09-22T13:00:00+02:00' },
    { sourceId: 'old', sourceUpdatedAt: '2026-09-22T10:59:59Z' },
    { sourceId: 'fresh', sourceUpdatedAt: '2026-09-22T11:59:59.500Z' },
    { sourceId: 'unknown', sourceUpdatedAt: null },
    { sourceId: 'empty', sourceUpdatedAt: '' },
    { sourceId: 'invalid', sourceUpdatedAt: '2026-02-30T10:00:00Z' },
    { sourceId: 'naive', sourceUpdatedAt: '2026-09-22T10:00:00' },
    { sourceId: 'future', sourceUpdatedAt: '2026-09-22T12:00:01Z' },
  ],
};

async function execute(capability: AnalysisCapability, rows: ImportRow[], rule: FreshnessRule) {
  if (capability.abi !== 'freshness-v1' || capability.kind !== 'analysis'
    || capability.permissions !== 'no-files-no-network' || typeof capability.code !== 'string') {
    throw new Error('Analysis capability contract mismatch.');
  }
  const execution = await executeImportParser(capability.code, JSON.stringify({ rows, rule }));
  verifyFreshnessRows(rows, rule, execution.rows);
  return execution;
}

async function verifyCandidate(capability: AnalysisCapability) {
  const first = await execute(capability, freshnessAcceptance.rows, freshnessAcceptance.rule);
  const second = await execute(capability, [
    { sourceId: 'leap', sourceUpdatedAt: '2024-02-29T23:59:00-01:00' },
  ], { ...freshnessAcceptance.rule, asOf: '2024-03-01T01:00:00Z', maxAgeSeconds: 60 });
  await execute(capability, [], freshnessAcceptance.rule);
  let rejected = false;
  try {
    await executeImportParser(capability.code, JSON.stringify({ rows: freshnessAcceptance.rows,
      rule: { ...freshnessAcceptance.rule, maxAgeSeconds: -1 } }));
  } catch { rejected = true; }
  if (!rejected) throw new Error('Analysis accepted an invalid interval fixture.');
  return { suite: 'freshness-independent-v1', executions: [first.receipt, second.receipt], invalidRuleRejected: true };
}

function tenantDirectory(root: string, tenantId: string) {
  return join(root, 'analysis', createHash('sha256').update(tenantId).digest('hex'));
}

function runId(id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) throw new Error('Invalid analysis run ID.');
  return id;
}

async function publishRun(directory: string, id: string, run: Record<string, unknown>) {
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${id}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(run, null, 2)); await handle.sync(); }
    finally { await handle.close(); }
    // Link publishes complete bytes atomically without replacing an existing run.
    await link(temporary, join(directory, `${id}.json`));
  } finally { await rm(temporary, { force: true }); }
}

export function createFreshnessService(root: string, registries: AppRegistries) {
  // Single-process serialization avoids overlapping activation/rollback transactions.
  let tail: Promise<unknown> = Promise.resolve();
  let runtimeCheck: Promise<{ runtime: FreshnessReadiness['runtime']; checkedAt: string }> | undefined;
  let runtimeCheckExpires = 0;

  async function readiness(tenantId: string): Promise<FreshnessReadiness> {
    const store = createPluginStore<AnalysisCapability>(join(tenantDirectory(root, tenantId), 'capabilities'));
    const current = (await store.listActive()).find(entry => entry.plugin.id === capabilityId);
    if (current && (current.plugin.kind !== 'analysis' || current.plugin.abi !== 'freshness-v1'
      || current.plugin.permissions !== 'no-files-no-network' || typeof current.plugin.code !== 'string')) {
      throw new Error('Stored analysis capability has an invalid contract.');
    }
    const capability = current ? 'available' : 'missing';
    let provider: FreshnessReadiness['provider'] = 'not_required';
    const generator = await generationProvider(registries);
    const generation = process.env.KOIFORGE_GENERATION_DISABLED === '1'
      ? { backend: generator.backend, model: generator.model, reasoningEffort: generator.reasoningEffort,
          available: false, reason: 'Das Erzeugen neuer Fähigkeiten ist vom Betreiber deaktiviert.' }
      : await generator.status();
    if (!current) {
      provider = process.env.KOIFORGE_GENERATION_DISABLED === '1' ? 'disabled'
        : generation.available ? 'configured' : 'missing';
    }
    // Exercise the actual isolated worker, without a model call or source data.
    // Share in-flight probes and cache briefly to bound repeated page visits.
    if (!runtimeCheck || Date.now() >= runtimeCheckExpires) {
      runtimeCheckExpires = Date.now() + 30_000;
      runtimeCheck = executeImportParser('result = [{ ready: true }];', '')
        .then(() => ({ runtime: 'ready' as const, checkedAt: new Date().toISOString() }))
        .catch(() => {
          runtimeCheckExpires = 0;
          return { runtime: 'unavailable' as const, checkedAt: new Date().toISOString() };
        });
    }
    const runtime = await runtimeCheck;
    return { ...runtime, capability, provider, generation,
      ready: runtime.runtime === 'ready' && (capability === 'available' || provider === 'configured') };
  }
  async function run(tenantId: string, body: unknown, frozen?: { dataset: DatasetRecord; preview: DatasetPreviewResult }) {
    const directory = tenantDirectory(root, tenantId);
    const runs = join(directory, 'runs');
    const store = createPluginStore<AnalysisCapability>(join(directory, 'capabilities'));
    const request = body as { datasetId?: unknown; question?: unknown; mapping?: { sourceId?: unknown; sourceUpdatedAt?: unknown }; rule?: unknown };
    const rule = validateFreshnessRule(request?.rule);
    if (typeof request?.datasetId !== 'string' || typeof request.question !== 'string'
      || !request.question.trim() || request.question.length > 1000
      || typeof request.mapping?.sourceId !== 'string' || !request.mapping.sourceId
      || typeof request.mapping.sourceUpdatedAt !== 'string' || !request.mapping.sourceUpdatedAt
      || request.mapping.sourceId === request.mapping.sourceUpdatedAt) {
      throw new Error('Question, dataset and two distinct confirmed source fields are required.');
    }
    const id = randomUUID();
    const generation = emptyGenerationAudit();
    const base = { id, tenantId, question: request.question.trim(), createdAt: new Date().toISOString(),
      datasetId: request.datasetId, mapping: { ...request.mapping }, rule, generation };
    let snapshot: { hash: string; coverage: 'complete'; rows: ImportRow[] } | undefined;
    let moduleHash: string | undefined;
    let switched = false;
    let previousHash: string | undefined;
    let finished: Record<string, unknown>;
    try {
      const dataset = frozen?.dataset ?? await registries.dataset.getDataset(request.datasetId);
      if (dataset?.id !== request.datasetId) throw new Error('Snapshot dataset does not match the requested source.');
      if (!dataset || dataset.connectorId !== 'inline') throw new Error('A complete imported snapshot is required. Import and verify the source first.');
      if (dataset.source.coverage !== undefined && dataset.source.coverage !== 'complete') throw new Error('Source coverage is not complete.');
      const preview = frozen?.preview ?? await registries.dataset.previewRows(dataset.id, EXECUTION_PROFILE.maxRows + 1);
      if (preview.datasetId !== dataset.id) throw new Error('Snapshot preview does not match the requested source.');
      if (preview.truncated || preview.rowCount !== preview.rows.length) throw new Error('Partial or unknown source coverage blocks this analysis.');
      const rows = validateRows(preview.rows);
      if (rows.length > 0 && (!preview.columns.includes(request.mapping.sourceId)
        || !preview.columns.includes(request.mapping.sourceUpdatedAt))) throw new Error('Confirmed mapping does not match the source schema.');
      snapshot = { rows, hash: rowsHash(rows), coverage: 'complete' };
      const normalized = rows.map((row) => {
        const idField = request.mapping!.sourceId as string;
        const timestampField = request.mapping!.sourceUpdatedAt as string;
        const sourceId = Object.hasOwn(row, idField) ? row[idField] : undefined;
        const timestamp = Object.hasOwn(row, timestampField) ? row[timestampField] : undefined;
        if (typeof sourceId !== 'string' || !sourceId.trim()) throw new Error('Mapped source IDs must be nonempty strings.');
        if (timestamp !== undefined && timestamp !== null && typeof timestamp !== 'string') throw new Error('Mapped timestamps must be strings or null.');
        return { sourceId, sourceUpdatedAt: timestamp ?? null };
      });
      // Validate IDs and input semantics before invoking a provider.
      expectedFreshnessRows(normalized, rule);
      const current = (await store.listActive()).find((entry) => entry.plugin.id === capabilityId);
      previousHash = current?.hash;
      let capability: AnalysisCapability;
      let validation: Awaited<ReturnType<typeof verifyCandidate>> | undefined;
      if (current) {
        capability = current.plugin;
        moduleHash = current.hash;
      } else {
        // Only the generic contract goes to the model, never source rows or IDs.
        const generator = await generationProvider(registries);
        const availability = await generator.status();
        await auditGeneration(join(directory, 'generation-events.jsonl'), id, generation, availability.available, generator);
        if (!availability.available) throw new Error(availability.reason ?? 'Erweiterung ist nicht verfügbar.');
        const response = await generator.generate('Return one JSON code artifact only.', contract, 4000);
        const parsed = JSON.parse(response);
        if (typeof parsed.code !== 'string') throw new Error('Provider returned no executable code artifact.');
        capability = { id: capabilityId, kind: 'analysis', abi: 'freshness-v1', code: parsed.code,
          permissions: 'no-files-no-network' };
        validation = await verifyCandidate(capability);
        moduleHash = (await store.stage(capability)).hash;
      }
      const execution = await execute(capability, normalized, rule);
      await store.activate(capabilityId, moduleHash);
      switched = current?.hash !== moduleHash;
      // Read pinned immutable content and use a genuinely new OS worker after activation.
      const reloaded = await execute(await store.read(moduleHash), normalized, rule);
      if (rowsHash(execution.rows) !== rowsHash(reloaded.rows)) throw new Error('Reload changed the verified analysis result.');
      await store.recordUse(capabilityId, moduleHash);
      finished = { ...base, snapshot, moduleHash, validation, results: execution.rows,
        status: execution.rows.some((row) => row.status === 'unassessable') ? 'completed_with_gaps' : 'completed',
        executionReceipt: execution.receipt, reloadReceipt: { ...reloaded.receipt, operationId: id, moduleHash } };
    } catch (error) {
      let rollbackError: string | undefined;
      if (switched) {
        try {
          if (previousHash) await store.rollback(capabilityId);
          else await store.deactivate(capabilityId, moduleHash!);
        } catch { rollbackError = 'Could not restore the previous activation state; inspect capability storage before retrying.'; }
      }
      finished = { ...base, snapshot, moduleHash, status: 'blocked',
        error: error instanceof Error ? error.message : 'Analysis failed.', rollbackError };
    }
    await publishRun(runs, id, finished);
    return finished;
  }
  return {
    readiness,
    // Internal, trusted snapshot adapter. HTTP callers cannot supply rows here.
    runSnapshot(tenantId: string, body: unknown, frozen: { dataset: DatasetRecord; preview: DatasetPreviewResult }) {
      const result = tail.then(() => run(tenantId, body, frozen));
      tail = result.catch(() => undefined);
      return result;
    },
    run(tenantId: string, body: unknown) {
      const result = tail.then(() => run(tenantId, body));
      tail = result.catch(() => undefined);
      return result;
    },
    async get(tenantId: string, id: string) {
      return JSON.parse(await readFile(join(tenantDirectory(root, tenantId), 'runs', `${runId(id)}.json`), 'utf8'));
    },
    async list(tenantId: string) {
      const directory = join(tenantDirectory(root, tenantId), 'runs');
      let names: string[];
      try { names = await readdir(directory); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
      const result = [];
      for (const name of names.filter((name) => name.endsWith('.json'))) {
        const { id, question, status, createdAt, datasetId, moduleHash, error } = JSON.parse(await readFile(join(directory, name), 'utf8'));
        result.push({ id, question, status, createdAt, datasetId, moduleHash, error });
      }
      return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
  };
}
