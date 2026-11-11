import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppRegistries } from '../src/registries.js';
import type { Mission } from '../src/missions/contracts.js';
import { createMissionEngine } from '../src/missions/engine.js';
import { createFreshnessService } from '../src/analysis/freshness-service.js';
import { createPluginStore } from '../src/import-capability/plugin-store.js';
import { validCode } from './support/freshness-provider-fixture.js';

test('mission freshness executes its frozen source after removal from the live registry and retains real worker evidence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'koi-mission-freshness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let removed = false;
  const rows = [{ id: 'current', toString: '2026-09-22T11:30:00Z' }, { id: 'missing' }];
  const dataset = { id: 'snapshot-source', name: 'Frozen source', connectorId: 'inline', source: { coverage: 'complete', previewRows: rows },
    schema: [{ name: 'id', type: 'string' }, { name: 'toString', type: 'string' }] };
  const registries = { dataset: {
    async getDataset() { if (removed) throw new Error('Live source removed'); return dataset; },
    async previewRows() { if (removed) throw new Error('Live source removed'); return { datasetId: dataset.id,
      columns: ['id', 'toString'], rows, rowCount: 2, truncated: false }; },
  }, aip: { async getConfig() { throw new Error('Model API must not be read'); } } } as unknown as AppRegistries;
  const metadata = { backend: 'codex' as const, model: 'gpt-6-astra', reasoningEffort: 'xhigh' };
  const generator = { ...metadata, async status() { return { ...metadata, available: true }; }, async generate() {
    return JSON.stringify({ capabilityId: 'source_freshness', summary: 'Quellenalter prüfen.',
      suggestedBinding: { keyField: 'id', timestampField: 'toString' }, unsupportedReason: null });
  } };
  const mission: Mission = { id: randomUUID(), tenantId: 'tenant-frozen', ownerId: 'owner', datasetId: dataset.id,
    question: 'Wie alt sind die Quellen?', status: 'planning', phase: 'plan', revision: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events: [] };
  const store = createPluginStore<{ id: string; kind: string; abi: string; code: string; permissions: string }>(
    join(root, 'analysis', createHash('sha256').update(mission.tenantId).digest('hex'), 'capabilities'));
  const capability = { id: 'analysis_source_freshness_v1', kind: 'analysis', abi: 'freshness-v1', code: validCode, permissions: 'no-files-no-network' };
  const { hash } = await store.stage(capability); await store.activate(capability.id, hash);
  const freshness = createFreshnessService(root, registries);
  const engine = createMissionEngine(root, registries, { generator, freshness });
  Object.assign(mission, await engine.plan(mission));
  removed = true;
  const result = await engine.execute(mission, { confirmed: true, binding: { keyField: 'id', timestampField: 'toString' },
    rule: { asOf: '2026-09-22T12:00:00Z', maxAgeSeconds: 3600, timestampMeaning: 'source_updated_at', timezone: 'explicit-offset' } });
  assert.deepEqual(result.counts, { sourceRows: 2, current: 1, stale: 0, unassessable: 1 });
  assert.equal(result.evidence.sourceHash, mission.source!.hash);
  assert.equal(result.evidence.moduleHash, hash);
  const analysis = await freshness.get(mission.tenantId, result.evidence.analysisRunId!);
  assert.equal(analysis.results[1].reason, 'missing_timestamp');
  assert.notEqual(analysis.executionReceipt.executionId, analysis.reloadReceipt.executionId);
  assert.equal(analysis.generation.calls, 0);
  assert.deepEqual(analysis.snapshot.rows, rows);
});
