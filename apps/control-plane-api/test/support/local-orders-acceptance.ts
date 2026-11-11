import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsvRowsStrict } from '@koiforge/data-registry';
import { AuthStore } from '../../src/auth-store.js';
import { getConfig } from '../../src/config.js';
import { createRegistries } from '../../src/registries.js';
import { buildServer } from '../../src/server.js';
import type { Mission } from '../../src/missions/contracts.js';
import type { OrderReviewBinding, OrderReviewRule } from '../../src/domain/orders/review.js';
import type { ObjectSet, Relationship } from '../../src/semantic-model/contracts.js';

interface Reference {
  fixtureVersion: string;
  synthetic: true;
  customerAcceptance: false;
  capabilityId: string;
  capabilityVersion: string;
  binding: OrderReviewBinding;
  orderRule: OrderReviewRule;
  objectSets: {
    from: { name: string; file: string; keyField: string };
    to: { name: string; file: string; keyField: string; labelField: string };
    relationship: { fromField: string; cardinality: string };
  };
  counts: { sourceRows: number; targetRows: number; overdue: number; open: number; closed: number;
    unassessable: number; clarificationRows: number; openRowsWithoutAssessableDate: number };
  relationshipCounts: Relationship['counts'];
  prioritySourceRows: number[];
  rows: Array<{ sourceRow: number; classification: 'overdue' | 'open' | 'closed' | 'unassessable';
    dateAssessment: string; clarification: string[] }>;
}

// Synthetic acceptance using the real authenticated CLI, storage and HTTP routes.
// Expected business findings are authored independently in the reference fixture.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const evidenceRoot = resolve(process.argv[2] ?? join(repository, '.koiforge/verification'));
const curatedRoot = resolve(process.argv[3] ?? join(repository, 'docs/verification/order-review-2026-09-23'));
await mkdir(evidenceRoot, { recursive: true });
await mkdir(curatedRoot, { recursive: true });
const root = await mkdtemp(join(evidenceRoot, 'orders-local-'));
const fixtureRoot = join(repository, 'examples/order-review');
const expectedText = await readFile(join(fixtureRoot, 'expected.json'), 'utf8');
const expected: Reference = JSON.parse(expectedText);
assert.equal(expected.synthetic, true);
assert.equal(expected.customerAcceptance, false);
const sourceText = await readFile(join(fixtureRoot, expected.objectSets.from.file), 'utf8');
const targetText = await readFile(join(fixtureRoot, expected.objectSets.to.file), 'utf8');
const sourceRows = parseCsvRowsStrict(sourceText, ',');
const targetRows = parseCsvRowsStrict(targetText, ',');
assert.equal(sourceRows.length, expected.counts.sourceRows);
assert.equal(targetRows.length, expected.counts.targetRows);

process.env.KOIFORGE_STATE_ROOT = root;
process.env.KOIFORGE_IMPORT_DATA_ROOT = root;
process.env.KOIFORGE_EXTENSION_BACKEND = 'codex';
process.env.KOIFORGE_CODEX_BIN = 'codex';
delete process.env.KOIFORGE_GENERATION_DISABLED;
const login = await new AuthStore(join(root, 'auth.json')).setup({ email: 'orders-acceptance@example.test',
  password: `synthetic-${randomUUID()}`, displayName: 'Synthetic orders acceptance', workspaceName: 'Order review acceptance' });
const headers = { cookie: `koiforge_session=${login.token}`, 'x-koiforge-request': '1' };
const registries = createRegistries(getConfig());
assert.equal(await registries.aip.getConfig(), null);
const source = await registries.dataset.registerInlineDataset({ namespace: 'orders-acceptance',
  name: 'Synthetische Bestellungen', rows: sourceRows });
const target = await registries.dataset.registerInlineDataset({ namespace: 'orders-acceptance',
  name: 'Synthetische Lieferanten', rows: targetRows });
let app = await buildServer();
async function post(url: string, payload: Record<string, unknown>) {
  const response = await app.inject({ method: 'POST', url, headers, payload });
  assert(response.statusCode >= 200 && response.statusCode < 300, `${response.statusCode}: ${response.body}`);
  return response.json();
}
async function get(url: string) {
  const response = await app.inject({ method: 'GET', url, headers });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}
async function until(id: string, desired: Mission['status']): Promise<Mission> {
  const deadline = Date.now() + 9 * 60_000;
  let previous = '';
  while (Date.now() < deadline) {
    const mission = (await get(`/api/missions/${id}`)).mission as Mission;
    if (mission.status !== previous) {
      console.log(JSON.stringify({ stage: 'mission', id, status: mission.status, at: new Date().toISOString() }));
      previous = mission.status;
    }
    if (mission.status === desired) return mission;
    if (mission.status === 'blocked' || mission.status === 'interrupted') throw new Error(mission.error ?? mission.plan?.unsupportedReason ?? mission.status);
    await new Promise(done => setTimeout(done, 1000));
  }
  throw new Error('Real local order review acceptance timed out.');
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
console.log(JSON.stringify({ stage: 'started', evidenceRoot: root, sourceRows: sourceRows.length, targetRows: targetRows.length,
  model: 'gpt-6-astra', reasoningEffort: 'xhigh', realLocalCli: true, separateModelApiConfigured: false }));
try {
  const sourceInput = { name: expected.objectSets.from.name, datasetId: source.id, keyField: expected.objectSets.from.keyField,
    confirmed: true, requestId: randomUUID() };
  const targetInput = { name: expected.objectSets.to.name, datasetId: target.id, keyField: expected.objectSets.to.keyField,
    labelField: expected.objectSets.to.labelField, confirmed: true, requestId: randomUUID() };
  const from = (await post('/api/model/object-sets', sourceInput)).objectSet as ObjectSet;
  const to = (await post('/api/model/object-sets', targetInput)).objectSet as ObjectSet;
  assert.equal(from.source.rowCount, expected.counts.sourceRows);
  assert.equal(to.source.rowCount, expected.counts.targetRows);
  assert.equal((await post('/api/model/object-sets', sourceInput)).objectSet.id, from.id);
  const relationInput = { name: 'Bestellung gehört zu Lieferant', fromSetId: from.id, toSetId: to.id,
    fromField: expected.objectSets.relationship.fromField, confirmed: true, requestId: randomUUID() };
  const relationship = (await post('/api/model/relationships', relationInput)).relationship as Relationship;
  assert.deepEqual(relationship.counts, expected.relationshipCounts);
  const question = { question: 'Welche Bestellungen sind offen oder überfällig, und welche Lieferantenzuordnungen müssen geklärt werden?',
    datasetId: source.id, relationshipId: relationship.id, requestId: randomUUID() };
  const start = Date.now();
  const created = (await post('/api/missions', question)).mission as Mission;
  const acceptedMs = Date.now() - start;
  assert.equal((await post('/api/missions', question)).mission.id, created.id);
  const planned = await until(created.id, 'awaiting_confirmation');
  assert.equal(planned.plan?.capabilityId, expected.capabilityId);
  assert.equal(planned.plan?.capabilityVersion, expected.capabilityVersion);
  assert.deepEqual(planned.plan?.generation, { backend: 'codex', model: 'gpt-6-astra', reasoningEffort: 'xhigh' });
  assert.equal(planned.plan?.relationship?.fromSnapshotHash, from.snapshotHash);
  assert.equal(planned.plan?.relationship?.toSnapshotHash, to.snapshotHash);
  assert.equal(planned.plan?.relationship?.sourceHash, from.source.hash);
  assert.equal(planned.plan?.relationship?.targetHash, to.source.hash);
  const statusUrl = `/api/missions/${created.id}/order-statuses?field=${encodeURIComponent(expected.binding.statusField)}`;
  const profileBefore = await get(statusUrl);
  assert.equal(profileBefore.totalRows, expected.counts.sourceRows);
  assert.equal(profileBefore.missingRows, 2);
  assert.equal(profileBefore.nonTextRows, 0);
  assert.equal(profileBefore.truncated, false);
  for (const value of [...expected.orderRule.openStatuses, ...expected.orderRule.closedStatuses]) {
    assert.equal(profileBefore.values.find((entry: { value: string }) => entry.value === value)?.count,
      sourceRows.filter(row => row[expected.binding.statusField] === value).length);
  }

  // Both live imports disappear before confirmation. The restarted application
  // must profile and execute against the two previously confirmed snapshots.
  await registries.dataset.deleteDataset(source.id);
  await registries.dataset.deleteDataset(target.id);
  assert.equal(await registries.dataset.getDataset(source.id), null);
  assert.equal(await registries.dataset.getDataset(target.id), null);
  await app.close();
  app = await buildServer();
  assert.deepEqual(await get(statusUrl), profileBefore);
  assert.deepEqual((await get(`/api/model/relationships/${relationship.id}`)).relationship.counts, expected.relationshipCounts);
  assert.equal((await post('/api/model/relationships', relationInput)).relationship.id, relationship.id);
  console.log(JSON.stringify({ stage: 'frozen-sources-verified', bothLiveSourcesDeleted: true, restarted: true,
    statusProfileUnchanged: true, at: new Date().toISOString() }));
  const runInput = { revision: planned.revision, requestId: randomUUID(), confirmed: true,
    binding: expected.binding, orderRule: expected.orderRule };
  await post(`/api/missions/${created.id}/run`, runInput);
  const completed = await until(created.id, 'completed');
  const result = completed.result!;
  const expectedCounts = { sourceRows: expected.counts.sourceRows, overdueRows: expected.counts.overdue,
    openRows: expected.counts.open, closedRows: expected.counts.closed, unassessableRows: expected.counts.unassessable,
    clarificationRows: expected.counts.clarificationRows, deadlineUnassessableRows: expected.counts.openRowsWithoutAssessableDate };
  assert.deepEqual(result.counts, expectedCounts);
  assert.equal(result.totalRows, expected.counts.sourceRows);
  assert.equal(result.rows.length, expected.counts.sourceRows);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.rows.map(row => row.Quellzeile), expected.prioritySourceRows);
  const labels = { overdue: 'Überfällig', open: 'Offen', closed: 'Abgeschlossen', unassessable: 'Nicht beurteilbar' };
  for (const reference of expected.rows) {
    const actual = result.rows.find(row => row.Quellzeile === reference.sourceRow)!;
    assert.equal(actual.Befund, labels[reference.classification], `Befund der Quellzeile ${reference.sourceRow}`);
    assert.equal(Boolean(actual.Klärungsgrund), reference.clarification.length > 0, `Klärung der Quellzeile ${reference.sourceRow}`);
    assert.equal(actual.Originalstatus, sourceRows[reference.sourceRow - 1]![expected.binding.statusField]);
    if (['missing', 'invalid'].includes(reference.dateAssessment)) assert.equal(actual.Terminbeurteilung, 'Nicht beurteilbar');
    if (reference.dateAssessment === 'not_assessed') assert.match(String(actual.Terminbeurteilung), /^Nicht geprüft:/);
    for (const value of Object.values(actual)) if (typeof value === 'number') assert.ok(Number.isFinite(value));
  }
  const expectedRuleHash = hash(JSON.stringify({
    binding: { statusField: expected.binding.statusField, dueDateField: expected.binding.dueDateField },
    orderRule: { openStatuses: [...expected.orderRule.openStatuses].sort(), closedStatuses: [...expected.orderRule.closedStatuses].sort(),
      asOf: expected.orderRule.asOf, dueDateMeaning: expected.orderRule.dueDateMeaning },
  }));
  assert.equal(result.evidence.orderRuleHash, expectedRuleHash);
  assert.equal(result.evidence.sourceHash, from.source.hash);
  assert.equal(result.evidence.targetSourceHash, to.source.hash);
  assert.equal(result.evidence.fromSnapshotHash, from.snapshotHash);
  assert.equal(result.evidence.toSnapshotHash, to.snapshotHash);
  assert.equal(result.evidence.fromSetId, from.id);
  assert.equal(result.evidence.toSetId, to.id);
  assert.equal(result.evidence.relationshipId, relationship.id);
  assert.equal(result.evidence.capabilityVersion, expected.capabilityVersion);
  await app.close();
  app = await buildServer();
  assert.deepEqual((await get(`/api/missions/${created.id}`)).mission.result, result);
  assert.equal((await post(`/api/missions/${created.id}/run`, runInput)).mission.id, created.id);
  assert.equal((await post('/api/missions', question)).mission.id, created.id);
  assert.deepEqual((await get(`/api/missions/${created.id}`)).mission.result, result);
  const report = {
    completedAt: new Date().toISOString(), synthetic: true, customerAcceptance: false,
    realLocalCli: true, separateModelApiConfigured: false, acceptedMs, generation: completed.plan?.generation,
    fixture: { version: expected.fixtureVersion, path: 'examples/order-review', expectedSha256: hash(expectedText),
      sourceCsvSha256: hash(sourceText), targetCsvSha256: hash(targetText), expectedCounts,
      expectedPrioritySourceRows: expected.prioritySourceRows },
    from, to, relationship, statusProfile: profileBefore, mission: completed,
    checks: { exactUiQuestion: true, independentExpectedCounts: true, everySourceRowFinding: true,
      independentPrioritySourceRows: true, bothLiveSourcesRemovedBeforeConfirmation: true,
      frozenStatusProfileAfterRestart: true, ruleReceipt: true, bothSourceReceipts: true, bothModelReceipts: true,
      persistedResultAfterRestart: true, idempotentCreate: true, idempotentRunAfterRestart: true },
  };
  const serialized = JSON.stringify(report, null, 2) + '\n';
  await writeFile(join(root, 'acceptance-report.json'), serialized, { mode: 0o600 });
  await writeFile(join(curatedRoot, 'acceptance-report.json'), serialized);
  console.log(JSON.stringify({ stage: 'passed', acceptanceReport: join(root, 'acceptance-report.json'),
    curatedReport: join(curatedRoot, 'acceptance-report.json'), status: completed.status,
    acceptedMs, counts: result.counts, generation: completed.plan?.generation, checks: report.checks }));
} catch (error) {
  await writeFile(join(root, 'acceptance-failure.json'), JSON.stringify({ at: new Date().toISOString(),
    error: error instanceof Error ? error.stack : String(error) }, null, 2), { mode: 0o600 });
  throw error;
} finally { await app.close(); }
