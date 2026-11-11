import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { AuthStore } from '../../src/auth-store.js';
import { getConfig } from '../../src/config.js';
import { createRegistries } from '../../src/registries.js';
import { buildServer } from '../../src/server.js';
import type { Mission } from '../../src/missions/contracts.js';

// Explicit, synthetic-data acceptance against the real local CLI. No model API.
const evidenceRoot = resolve(process.argv[2] ?? '../../.koiforge/verification');
await mkdir(evidenceRoot, { recursive: true });
const root = await mkdtemp(join(evidenceRoot, 'missions-local-'));
process.env.KOIFORGE_STATE_ROOT = root;
process.env.KOIFORGE_IMPORT_DATA_ROOT = root;
process.env.KOIFORGE_EXTENSION_BACKEND = 'codex';
delete process.env.KOIFORGE_GENERATION_DISABLED;
const auth = await new AuthStore(join(root, 'auth.json')).setup({ email: 'mission-acceptance@example.test',
  password: `synthetic-${randomUUID()}`, displayName: 'Synthetic mission acceptance', workspaceName: 'Mission acceptance' });
const headers = { cookie: `koiforge_session=${auth.token}`, 'x-koiforge-request': '1' };
const registries = createRegistries(getConfig());
const dataset = await registries.dataset.registerInlineDataset({ namespace: 'mission-acceptance', name: 'synthetic-quality', rows: [
  { id: 'A', email: 'synthetic-a@example.test', amount: 0 },
  { id: 'A', email: null, amount: 10 }, { id: 'B', email: ' ', amount: 20 },
] });
assert.equal(await registries.aip.getConfig(), null);
let app = await buildServer();
async function waitFor(id: string, statuses: Mission['status'][]): Promise<Mission> {
  const until = Date.now() + 9 * 60_000;
  while (Date.now() < until) {
    const response = await app.inject({ method: 'GET', url: `/api/missions/${id}`, headers });
    assert.equal(response.statusCode, 200, response.body);
    const mission = response.json().mission as Mission;
    if (statuses.includes(mission.status)) return mission;
    if (mission.status === 'blocked' || mission.status === 'interrupted') throw new Error(mission.error ?? mission.plan?.unsupportedReason ?? mission.status);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Local mission acceptance timed out.');
}
try {
  const request = { question: 'Welche Werte fehlen und welche IDs sind doppelt?', datasetId: dataset.id, requestId: randomUUID() };
  const start = Date.now();
  const created = await app.inject({ method: 'POST', url: '/api/missions', headers, payload: request });
  const acceptedMs = Date.now() - start;
  assert.equal(created.statusCode, 202, created.body);
  const id = created.json().mission.id as string;
  const replay = await app.inject({ method: 'POST', url: '/api/missions', headers, payload: request });
  assert.equal(replay.statusCode, 202, replay.body); assert.equal(replay.json().mission.id, id);
  const planned = await waitFor(id, ['awaiting_confirmation']);
  assert.equal(planned.plan?.capabilityId, 'data_quality');
  assert.deepEqual(planned.plan?.generation, { backend: 'codex', model: 'gpt-6-astra', reasoningEffort: 'xhigh' });
  const execution = { revision: planned.revision, requestId: randomUUID(), confirmed: true, binding: { keyField: 'id' } };
  const started = await app.inject({ method: 'POST', url: `/api/missions/${id}/run`, headers, payload: execution });
  assert.equal(started.statusCode, 202, started.body);
  const completed = await waitFor(id, ['completed']);
  assert.equal(completed.result?.counts.sourceRows, 3);
  assert.equal(completed.result?.counts.missingCells, 2);
  assert.equal(completed.result?.counts.duplicateGroups, 1);
  assert.equal(completed.result?.evidence.sourceHash, completed.source?.hash);
  await app.close();
  app = await buildServer();
  const reloaded = await waitFor(id, ['completed']);
  assert.deepEqual(reloaded.result, completed.result);
  const executionReplay = await app.inject({ method: 'POST', url: `/api/missions/${id}/run`, headers, payload: execution });
  assert.equal(executionReplay.statusCode, 202, executionReplay.body);
  assert.equal(executionReplay.json().mission.id, id);
  const unsupportedCreation = await app.inject({ method: 'POST', url: '/api/missions', headers,
    payload: { question: 'Welche Lieferungen werden morgen verspätet sein?', datasetId: dataset.id, requestId: randomUUID() } });
  assert.equal(unsupportedCreation.statusCode, 202, unsupportedCreation.body);
  const unsupported = await waitFor(unsupportedCreation.json().mission.id, ['blocked']);
  assert.equal(unsupported.plan?.capabilityId, null);
  assert.ok(unsupported.plan?.unsupportedReason); assert.equal(unsupported.result, undefined);
  const report = { completedAt: new Date().toISOString(), acceptedMs, realLocalCli: true, separateModelApiConfigured: false,
    generation: completed.plan!.generation, quality: completed, unsupported,
    idempotentCreate: true, idempotentExecutionAfterRestart: true, persistedResultAfterRestart: true };
  await writeFile(join(root, 'acceptance-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ acceptanceReport: join(root, 'acceptance-report.json'), acceptedMs, qualityStatus: completed.status,
    unsupportedStatus: unsupported.status, generation: completed.plan!.generation }));
} finally { await app.close(); }
