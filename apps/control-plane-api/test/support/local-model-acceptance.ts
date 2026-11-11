import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AuthStore } from '../../src/auth-store.js';
import { getConfig } from '../../src/config.js';
import { createRegistries } from '../../src/registries.js';
import { buildServer } from '../../src/server.js';
import type { Mission } from '../../src/missions/contracts.js';

// Explicit synthetic acceptance of both real model storage and real local CLI.
const evidenceRoot = resolve(process.argv[2] ?? '../../.koiforge/verification');
await mkdir(evidenceRoot, { recursive: true });
const root = await mkdtemp(join(evidenceRoot, 'semantic-model-local-'));
process.env.KOIFORGE_STATE_ROOT = root;
process.env.KOIFORGE_IMPORT_DATA_ROOT = root;
process.env.KOIFORGE_EXTENSION_BACKEND = 'codex';
delete process.env.KOIFORGE_GENERATION_DISABLED;
const login = await new AuthStore(join(root, 'auth.json')).setup({ email: 'model-acceptance@example.test',
  password: `synthetic-${randomUUID()}`, displayName: 'Synthetic model acceptance', workspaceName: 'Model acceptance' });
const headers = { cookie: `koiforge_session=${login.token}`, 'x-koiforge-request': '1' };
const registries = createRegistries(getConfig());
assert.equal(await registries.aip.getConfig(), null);
const target = await registries.dataset.registerInlineDataset({ namespace: 'model-acceptance', name: 'suppliers', rows: [
  { id: 'S1', name: 'Synthetic supplier one' }, { id: 'D', name: 'Duplicate A' }, { id: 'D', name: 'Duplicate B' },
  { id: 7, name: 'Numeric identifier' }, { id: '7', name: 'Text identifier' },
] });
const source = await registries.dataset.registerInlineDataset({ namespace: 'model-acceptance', name: 'orders', rows: [
  ...Array.from({ length: 250 }, (_, i) => ({ id: `P${i + 1}`, supplier: 'S1' })),
  { id: 'missing', supplier: null }, { id: 'unknown', supplier: 'U' }, { id: 'ambiguous', supplier: 'D' },
  { id: 'numeric', supplier: 7 }, { id: 'text', supplier: '7' },
  { id: 'duplicate', supplier: 'S1' }, { id: 'duplicate', supplier: 'S1' }, { id: null, supplier: 'S1' },
] });
let app = await buildServer();
async function post(url: string, payload: Record<string, unknown>) {
  const response = await app.inject({ method: 'POST', url, headers, payload });
  assert(response.statusCode >= 200 && response.statusCode < 300, `${response.statusCode}: ${response.body}`);
  return response.json();
}
async function get(url: string) {
  const response = await app.inject({ method: 'GET', url, headers });
  assert.equal(response.statusCode, 200, response.body); return response.json();
}
async function until(id: string, status: string) {
  const deadline = Date.now() + 9 * 60_000;
  while (Date.now() < deadline) {
    const mission = (await get(`/api/missions/${id}`)).mission as Mission;
    if (mission.status === status) return mission;
    if (mission.status === 'blocked' || mission.status === 'interrupted') throw new Error(mission.error ?? mission.status);
    await new Promise(done => setTimeout(done, 200));
  }
  throw new Error('Local semantic model acceptance timed out.');
}
try {
  const sourceInput = { name: 'Bestellungen', datasetId: source.id, keyField: 'id', confirmed: true, requestId: randomUUID() };
  const from = (await post('/api/model/object-sets', sourceInput)).objectSet;
  const to = (await post('/api/model/object-sets', { name: 'Lieferanten', datasetId: target.id,
    keyField: 'id', labelField: 'name', confirmed: true, requestId: randomUUID() })).objectSet;
  assert.equal(from.source.rowCount, 258); assert.equal(from.keyQuality.identifiedRows, 255);
  assert.equal(to.keyQuality.identifiedRows, 3); assert.equal(to.keyQuality.duplicateRows, 2);
  assert.equal((await post('/api/model/object-sets', sourceInput)).objectSet.id, from.id);
  const relationInput = { name: 'Bestellung gehört zu Lieferant', fromSetId: from.id, toSetId: to.id,
    fromField: 'supplier', confirmed: true, requestId: randomUUID() };
  const relationship = (await post('/api/model/relationships', relationInput)).relationship;
  const expectedCounts = { sourceRows: 258, linkedRows: 252, missingReferences: 1, unmatchedReferences: 1,
    ambiguousReferences: 1, invalidSourceRows: 3 };
  assert.deepEqual(relationship.counts, expectedCounts);
  const question = { question: 'Welche Bestellungen haben keinen eindeutig zugeordneten Lieferanten? Bitte fehlende, unbekannte und mehrdeutige Verweise prüfen.',
    datasetId: source.id, relationshipId: relationship.id, requestId: randomUUID() };
  const acceptedAt = Date.now();
  const created = (await post('/api/missions', question)).mission as Mission;
  const acceptedMs = Date.now() - acceptedAt;
  const planned = await until(created.id, 'awaiting_confirmation');
  assert.equal(planned.plan?.capabilityId, 'relationship_integrity');
  assert.deepEqual(planned.plan?.generation, { backend: 'codex', model: 'gpt-6-astra', reasoningEffort: 'xhigh' });
  assert.equal(planned.plan?.relationship?.fromSnapshotHash, from.snapshotHash);
  assert.equal(planned.plan?.relationship?.toSnapshotHash, to.snapshotHash);

  // New target revision and removal of the live source cannot rewrite this plan.
  await registries.dataset.deleteDataset(target.id);
  const targetAgain = await registries.dataset.registerInlineDataset({ namespace: 'model-acceptance', name: 'suppliers', rows: [{ id: 'NEW', name: 'New source revision' }] });
  assert.equal(targetAgain.id, target.id);
  const next = (await post('/api/model/object-sets', { name: 'Lieferanten', datasetId: targetAgain.id,
    keyField: 'id', labelField: 'name', previousId: to.id, confirmed: true, requestId: randomUUID() })).objectSet;
  assert.equal(next.revision, 2); assert.equal(next.familyId, to.familyId); assert.notEqual(next.snapshotHash, to.snapshotHash);
  await registries.dataset.deleteDataset(source.id); await registries.dataset.deleteDataset(targetAgain.id);
  await app.close(); app = await buildServer();
  assert.deepEqual((await get(`/api/model/relationships/${relationship.id}`)).relationship.counts, expectedCounts);
  assert.equal((await post('/api/model/relationships', relationInput)).relationship.id, relationship.id);
  const runInput = { revision: planned.revision, requestId: randomUUID(), confirmed: true, binding: {} };
  await post(`/api/missions/${created.id}/run`, runInput);
  const completed = await until(created.id, 'completed');
  assert.deepEqual(completed.result?.counts, { ...expectedCounts, targetRows: 5 });
  assert.equal(completed.result?.totalRows, 258); assert.equal(completed.result?.rows.length, 100);
  assert.equal(completed.result?.evidence.fromSetId, from.id); assert.equal(completed.result?.evidence.toSetId, to.id);
  assert.equal(completed.result?.evidence.targetSourceHash, to.source.hash);
  assert.equal(completed.result?.evidence.toSnapshotHash, to.snapshotHash);
  assert(completed.result?.rows.some(row => row.Befund === 'Mehrdeutiges Ziel'));
  await app.close(); app = await buildServer();
  assert.deepEqual((await get(`/api/missions/${created.id}`)).mission.result, completed.result);
  assert.equal((await post(`/api/missions/${created.id}/run`, runInput)).mission.id, created.id);
  const report = { completedAt: new Date().toISOString(), realLocalCli: true, separateModelApiConfigured: false,
    acceptedMs, generation: completed.plan?.generation, from, to, nextRevision: next, relationship,
    mission: completed, liveSourcesRemovedBeforeExecution: true, revisionPinned: true,
    persistedAfterRestart: true, idempotentReplay: true };
  await writeFile(join(root, 'acceptance-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ acceptanceReport: join(root, 'acceptance-report.json'), status: completed.status,
    acceptedMs, counts: completed.result?.counts, generation: completed.plan?.generation }));
} finally { await app.close(); }
