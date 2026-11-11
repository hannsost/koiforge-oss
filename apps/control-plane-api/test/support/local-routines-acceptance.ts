import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileDatasetRegistry, parseCsvRowsStrict } from '@koiforge/data-registry';
import type { SessionContext } from '@koiforge/security-core';
import type { GenerationProvider } from '../../src/import-capability/generation-provider.js';
import type { ImportRow } from '../../src/import-capability/isolated-executor.js';
import type { Mission } from '../../src/missions/contracts.js';
import { createMissionEngine } from '../../src/missions/engine.js';
import { createMissionService, MissionServiceError, type MissionService } from '../../src/missions/service.js';
import type { AppRegistries } from '../../src/registries.js';
import { createSemanticModelService } from '../../src/semantic-model/service.js';

// Reuse the preserved output of the real local Astra/xhigh acceptance. The new
// routine run must never call any model, including its availability endpoint.
// This runner exercises real storage, semantic service, queue and order engine
// directly; HTTP authentication and browser behavior have separate acceptance.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const priorRoot = resolve(process.argv[2] ?? join(repository, '.koiforge/verification/orders-local-zLV1G7'));
const evidenceRoot = resolve(process.argv[3] ?? join(repository, '.koiforge/verification'));
const curatedRoot = resolve(process.argv[4] ?? join(repository, 'docs/verification/routines-2026-09-23'));
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const priorReportText = await readFile(join(priorRoot, 'acceptance-report.json'), 'utf8');
const prior = JSON.parse(priorReportText) as {
  synthetic: boolean; customerAcceptance: boolean; realLocalCli: boolean; separateModelApiConfigured: boolean;
  generation: { backend: string; model: string; reasoningEffort: string };
  fixture: { version: string; expectedSha256: string; sourceCsvSha256: string; targetCsvSha256: string };
  mission: Mission; checks: Record<string, boolean>;
};
assert.equal(prior.synthetic, true, 'only the documented synthetic source may be reused');
assert.equal(prior.customerAcceptance, false);
assert.equal(prior.realLocalCli, true);
assert.equal(prior.separateModelApiConfigured, false);
assert.deepEqual(prior.generation, { backend: 'codex', model: 'gpt-6-astra', reasoningEffort: 'xhigh' });
assert(Object.values(prior.checks).every(Boolean));
assert.equal(prior.mission.status, 'completed');
assert.equal(prior.mission.plan?.capabilityId, 'order_review');
assert.deepEqual(prior.mission.plan?.generation, prior.generation);
const fixtureRoot = join(repository, 'examples/order-review');
const expectedText = await readFile(join(fixtureRoot, 'expected.json'), 'utf8');
const sourceCsv = await readFile(join(fixtureRoot, 'bestellungen.csv'), 'utf8');
const targetCsv = await readFile(join(fixtureRoot, 'lieferanten.csv'), 'utf8');
assert.equal(sha256(expectedText), prior.fixture.expectedSha256);
assert.equal(sha256(sourceCsv), prior.fixture.sourceCsvSha256);
assert.equal(sha256(targetCsv), prior.fixture.targetCsvSha256);
const baselineCounts = { sourceRows: 40, overdueRows: 8, openRows: 16, closedRows: 4,
  unassessableRows: 12, clarificationRows: 26, deadlineUnassessableRows: 8 };
assert.deepEqual(prior.mission.result?.counts, baselineCounts);

const copiedFiles = ['missions/state.json', 'semantic-model/state.json', 'dataset-registry.json'];
const preserved = new Map<string, Buffer>();
for (const file of copiedFiles) preserved.set(file, await readFile(join(priorRoot, file)));
const priorState = JSON.parse(preserved.get('missions/state.json')!.toString('utf8')) as { missions: Record<string, Mission> };
assert.equal(Object.keys(priorState.missions).length, 1);
assert.deepEqual(priorState.missions[prior.mission.id], prior.mission);
assert.equal(priorRoot === evidenceRoot, false);
await mkdir(evidenceRoot, { recursive: true });
await mkdir(curatedRoot, { recursive: true });
const root = await mkdtemp(join(evidenceRoot, 'routines-local-'));
for (const [file, bytes] of preserved) {
  await mkdir(dirname(join(root, file)), { recursive: true, mode: 0o700 });
  await writeFile(join(root, file), bytes, { mode: 0o600 });
}
// No auth.json, login credentials or live user workspace are copied.
const owner: SessionContext = {
  user: { id: prior.mission.ownerId, displayName: 'Synthetic routine acceptance owner' },
  tenant: { id: prior.mission.tenantId, name: 'Synthetic routine acceptance', slug: 'synthetic-routine-acceptance', status: 'active' },
  roleIds: ['owner'], permissions: ['datasets.read', 'datasets.manage'],
};
const principal = { ownerId: owner.user.id, tenantId: owner.tenant.id };
const authority = {
  async resolvePrincipal(reference: { userId: string; tenantId: string }) {
    return reference.userId === owner.user.id && reference.tenantId === owner.tenant.id ? structuredClone(owner) : null;
  },
  assertPermissions(session: SessionContext, permissions: string[]) {
    assert(permissions.every(permission => session.permissions.includes(permission)));
  },
};
const modelCalls = { status: 0, generate: 0 };
const generator: GenerationProvider = {
  backend: 'codex', model: 'gpt-6-astra', reasoningEffort: 'xhigh',
  async status() { modelCalls.status++; throw new Error('No model availability request is allowed for this routine.'); },
  async generate() { modelCalls.generate++; throw new Error('No model generation is allowed for this routine.'); },
};
const dataset = new FileDatasetRegistry({ filePath: join(root, 'dataset-registry.json') });
const semanticOptions = { root, registries: { dataset }, ...authority };
let semantic = createSemanticModelService(semanticOptions);
let service: MissionService | undefined;
async function openService() {
  const engine = createMissionEngine(root, { dataset } as AppRegistries, { generator, semanticModel: semantic });
  return createMissionService({ root, engine, semanticModel: semantic, ...authority });
}
async function restart() {
  await service!.close();
  await service!.whenIdle();
  semantic = createSemanticModelService(semanticOptions);
  service = await openService();
}
const stage = (stage: string, details: Record<string, unknown> = {}) => console.log(JSON.stringify({ stage, at: new Date().toISOString(), ...details }));
stage('started', { evidenceRoot: root, priorRoot, sourceMissionId: prior.mission.id,
  originRealLocalCli: true, newModelInvocationAllowed: false });

try {
  service = await openService();
  const origin = await service.get(owner, prior.mission.id);
  assert.deepEqual(origin, prior.mission);
  const originSnapshot = await semantic.relationshipSnapshotForMission(principal, origin.relationshipId!);
  assert.deepEqual(originSnapshot.fromRows, parseCsvRowsStrict(sourceCsv, ','));
  assert.equal(originSnapshot.detail.to.source.rowCount, parseCsvRowsStrict(targetCsv, ',').length);
  assert.equal(originSnapshot.detail.from.snapshotHash, origin.result!.evidence.fromSnapshotHash);
  assert.equal(originSnapshot.detail.to.snapshotHash, origin.result!.evidence.toSnapshotHash);
  assert.equal(originSnapshot.detail.from.source.hash, origin.result!.evidence.sourceHash);
  assert.equal(originSnapshot.detail.to.source.hash, origin.result!.evidence.targetSourceHash);
  const createInput = { sourceMissionId: origin.id, name: 'Bestellungen mit bestätigten Regeln erneut klären',
    confirmed: true, requestId: randomUUID() };
  const routine = await service.createRoutine(owner, createInput);
  assert.equal((await service.createRoutine(owner, createInput)).id, routine.id);
  assert.deepEqual(routine.binding, origin.input!.binding);
  assert.deepEqual(routine.orderRule, origin.input!.orderRule);
  assert.deepEqual(routine.baseline.counts, baselineCounts);

  // 210 closed orders followed by fifteen deliberately varied examples. These
  // expected counts and priority positions are authored by hand, independently
  // of reviewOrders/prepareRoutine and never derived from their actual output.
  const rows: ImportRow[] = Array.from({ length: 210 }, (_, i) => ({
    bestell_id: `CLOSED-${i + 1}`, lieferant_id: 'S', status: 'Erledigt', zugesagter_liefertag: 'invalid',
  }));
  const extra: ImportRow[] = [
    { bestell_id: 'LATE-1', lieferant_id: 'S', status: 'Offen', zugesagter_liefertag: '2026-09-24' },
    { bestell_id: 'LATE-2', lieferant_id: 'S', status: 'Teilgeliefert', zugesagter_liefertag: '2026-09-20' },
    { bestell_id: 'TODAY', lieferant_id: 'S', status: 'Offen', zugesagter_liefertag: '2026-09-25' },
    { bestell_id: 'FUTURE', lieferant_id: 'S', status: 'Offen', zugesagter_liefertag: '2026-09-26' },
    { bestell_id: 'NO-DATE', lieferant_id: 'S', status: 'Offen', zugesagter_liefertag: null },
    { bestell_id: 'INVALID-DATE', lieferant_id: 'S', status: 'Offen', zugesagter_liefertag: '2026-02-29' },
    { bestell_id: 'UNKNOWN-STATUS', lieferant_id: 'S', status: 'Freigabe fehlt', zugesagter_liefertag: '2026-09-01' },
    { bestell_id: 'MISSING-STATUS', lieferant_id: 'S', status: null, zugesagter_liefertag: '2026-09-01' },
    { bestell_id: 'NON-TEXT-STATUS', lieferant_id: 'S', status: false, zugesagter_liefertag: '2026-09-01' },
    { bestell_id: 'UNKNOWN-SUPPLIER', lieferant_id: 'MISSING', status: 'Offen', zugesagter_liefertag: '2026-09-24' },
    { bestell_id: 'NO-SUPPLIER', lieferant_id: '', status: 'Offen', zugesagter_liefertag: '2026-09-25' },
    { bestell_id: 'AMBIGUOUS-SUPPLIER', lieferant_id: 'DUP', status: 'Offen', zugesagter_liefertag: '2026-09-25' },
    { bestell_id: '', lieferant_id: 'S', status: 'Offen', zugesagter_liefertag: '2026-09-25' },
    { bestell_id: 'DUP-ORDER', lieferant_id: 'S', status: 'Offen', zugesagter_liefertag: '2026-09-25' },
    { bestell_id: 'DUP-ORDER', lieferant_id: 'S', status: 'Offen', zugesagter_liefertag: '2026-09-25' },
  ];
  rows.push(...extra);
  const supplierRows: ImportRow[] = [{ lieferant_id: 'S', lieferant_name: 'Synthetic supplier' },
    { lieferant_id: 'DUP', lieferant_name: 'Synthetic candidate A' },
    { lieferant_id: 'DUP', lieferant_name: 'Synthetic candidate B' }];
  const expectedCounts = { sourceRows: 225, overdueRows: 3, openRows: 6, closedRows: 210,
    unassessableRows: 6, clarificationRows: 11, deadlineUnassessableRows: 2 };
  const expectedDeltas = { sourceRows: 185, overdueRows: -5, openRows: -10, closedRows: 206,
    unassessableRows: -6, clarificationRows: -15, deadlineUnassessableRows: -6 };
  const expectedRelationshipCounts = { sourceRows: 225, linkedRows: 219, missingReferences: 1,
    unmatchedReferences: 1, ambiguousReferences: 1, invalidSourceRows: 3 };
  const expectedPriority = [212, 211, 220, 217, 218, 219, 223, 224, 225, 215, 216, 221, 222, 213, 214,
    ...Array.from({ length: 85 }, (_, i) => i + 1)];
  const source = await dataset.registerInlineDataset({ namespace: 'routines-acceptance', name: 'Synthetic new orders', rows });
  const target = await dataset.registerInlineDataset({ namespace: 'routines-acceptance', name: 'Synthetic new suppliers', rows: supplierRows });
  const from = await semantic.createObjectSet(owner, { name: originSnapshot.detail.from.name, datasetId: source.id,
    keyField: 'bestell_id', previousId: originSnapshot.detail.from.id, confirmed: true, requestId: randomUUID() });
  const to = await semantic.createObjectSet(owner, { name: originSnapshot.detail.to.name, datasetId: target.id,
    keyField: 'lieferant_id', labelField: 'lieferant_name', previousId: originSnapshot.detail.to.id,
    confirmed: true, requestId: randomUUID() });
  assert.equal(from.familyId, routine.baseline.fromFamilyId);
  assert.equal(to.familyId, routine.baseline.toFamilyId);
  assert.equal(from.revision, 2);
  assert.equal(to.revision, 2);
  const relationship = await semantic.createRelationship(owner, { name: 'Bestellungen zu Lieferanten – neuer bestätigter Stand',
    fromSetId: from.id, toSetId: to.id, fromField: 'lieferant_id', confirmed: true, requestId: randomUUID() });
  assert.deepEqual(relationship.counts, expectedRelationshipCounts);
  const previewInput = { relationshipId: relationship.id, asOf: '2026-09-25' };
  const stateBeforePreview = await readFile(join(root, 'missions/state.json'), 'utf8');
  const preview = await service.previewRoutine(owner, routine.id, previewInput);
  assert.equal(await readFile(join(root, 'missions/state.json'), 'utf8'), stateBeforePreview, 'preview does not write the mission store');
  assert.equal(preview.ready, true, preview.blockingReasons.join('; '));
  assert.deepEqual(preview.newCounts, expectedCounts);
  assert.deepEqual(preview.deltas, expectedDeltas);
  assert.deepEqual(preview.statusProfile, { field: 'status', totalRows: 225, knownOpenRows: 12, knownClosedRows: 210,
    unknownRows: 1, missingRows: 1, nonTextRows: 1, unassignableRows: 0, unknownValues: [{ value: 'Freigabe fehlt', count: 1 }],
    unknownUniqueTotal: 1, truncated: false });
  assert.match(preview.warnings.join(' '), /keine .*Ursachen/);
  assert.equal(preview.source.rowCount, 225);
  assert.equal(preview.targetSource.rowCount, 3);
  assert.match(preview.previewHash!, /^[a-f0-9]{64}$/);
  assert.notEqual(preview.orderRuleHash, routine.baseline.orderRuleHash);
  stage('preview-verified', { routineId: routine.id, counts: preview.newCounts, deltas: preview.deltas,
    sourceRows: 225, targetRows: 3, modelCalls });

  await dataset.deleteDataset(source.id);
  await dataset.deleteDataset(target.id);
  assert.equal(await dataset.getDataset(source.id), null);
  assert.equal(await dataset.getDataset(target.id), null);
  await restart();
  assert.deepEqual(await service.previewRoutine(owner, routine.id, previewInput), preview);
  assert.equal((await service.createRoutine(owner, createInput)).id, routine.id);
  assert.deepEqual(await service.get(owner, origin.id), origin);
  const runInput = { ...previewInput, confirmed: true, previewHash: preview.previewHash!, requestId: randomUUID() };
  const beforeRejectedRuns = (await service.list(owner)).length;
  for (const changed of [{ ...runInput, previewHash: '0'.repeat(64), requestId: randomUUID() },
    { ...runInput, asOf: '2026-09-26', requestId: randomUUID() }]) {
    await assert.rejects(service.runRoutine(owner, routine.id, changed),
      error => error instanceof MissionServiceError && error.statusCode === 409);
  }
  assert.equal((await service.list(owner)).length, beforeRejectedRuns);
  const accepted = await service.runRoutine(owner, routine.id, runInput);
  assert.equal(accepted.status, 'queued');
  assert.equal(accepted.phase, 'execute');
  assert.equal(accepted.plan?.reusedFromMissionId, origin.id);
  assert.equal((await service.runRoutine(owner, routine.id, runInput)).id, accepted.id);
  await service.whenIdle();
  const completed = await service.get(owner, accepted.id);
  assert.equal(completed.status, 'completed', completed.error);
  assert.deepEqual(completed.result!.counts, expectedCounts);
  assert.equal(completed.result!.totalRows, 225);
  assert.equal(completed.result!.rows.length, 100);
  assert.equal(completed.result!.truncated, true);
  assert.deepEqual(completed.result!.rows.map(row => row.Quellzeile), expectedPriority);
  assert.deepEqual(completed.plan!.generation, origin.plan!.generation, 'preserve the real origin generation provenance');
  assert.equal(completed.plan!.reusedFromMissionId, origin.id, 'identify this plan as reused');
  assert.equal(completed.routine!.previewHash, preview.previewHash);
  assert.equal(completed.routine!.confirmedRuleHash, preview.orderRuleHash);
  assert.equal(completed.result!.evidence.orderRuleHash, preview.orderRuleHash);
  assert.equal(completed.result!.evidence.sourceHash, from.source.hash);
  assert.equal(completed.result!.evidence.targetSourceHash, to.source.hash);
  assert.equal(completed.result!.evidence.fromSnapshotHash, from.snapshotHash);
  assert.equal(completed.result!.evidence.toSnapshotHash, to.snapshotHash);
  assert.equal(completed.result!.evidence.relationshipId, relationship.id);
  const labels: Record<number, string> = { 211: 'Überfällig', 212: 'Überfällig', 213: 'Offen', 214: 'Offen',
    215: 'Offen', 216: 'Offen', 217: 'Nicht beurteilbar', 218: 'Nicht beurteilbar', 219: 'Nicht beurteilbar',
    220: 'Überfällig', 221: 'Offen', 222: 'Offen', 223: 'Nicht beurteilbar', 224: 'Nicht beurteilbar', 225: 'Nicht beurteilbar' };
  for (const [position, label] of Object.entries(labels)) {
    const row = completed.result!.rows.find(row => row.Quellzeile === Number(position));
    assert.equal(row?.Befund, label, `independent finding at source row ${position}`);
  }
  assert.deepEqual(await service.get(owner, origin.id), origin);
  assert.deepEqual(await service.getRoutine(owner, routine.id), routine);
  stage('executed-without-model', { missionId: completed.id, counts: completed.result!.counts, modelCalls });

  await restart();
  assert.deepEqual(await service.get(owner, completed.id), completed);
  assert.equal((await service.runRoutine(owner, routine.id, runInput)).id, completed.id);
  assert.equal((await service.createRoutine(owner, createInput)).id, routine.id);
  await assert.rejects(service.runRoutine(owner, routine.id, { ...runInput, asOf: '2026-09-26' }),
    error => error instanceof MissionServiceError && error.statusCode === 409);
  assert.equal((await service.list(owner)).length, 2);
  assert.deepEqual(await service.get(owner, origin.id), origin);
  assert.deepEqual(await service.previewRoutine(owner, routine.id, previewInput), preview);
  const replacement = await dataset.registerInlineDataset({ namespace: 'routines-acceptance', name: 'Synthetic new orders',
    rows: [{ bestell_id: 'REPLACEMENT', lieferant_id: 'S', status: 'Storniert', zugesagter_liefertag: '2099-01-01' }] });
  assert.equal(replacement.id, source.id);
  assert.deepEqual(await service.previewRoutine(owner, routine.id, previewInput), preview);
  assert.deepEqual(await service.get(owner, completed.id), completed);
  assert.deepEqual(modelCalls, { status: 0, generate: 0 });
  for (const [file, bytes] of preserved) assert.equal(sha256(await readFile(join(priorRoot, file))), sha256(bytes), `original ${file} stays untouched`);
  assert.equal(await readFile(join(priorRoot, 'acceptance-report.json'), 'utf8'), priorReportText);

  const report = {
    completedAt: new Date().toISOString(), synthetic: true, customerAcceptance: false,
    scope: 'Real persisted Astra/xhigh origin; real routine services, storage, queue and order execution; no fresh model generation.',
    interface: 'Direct service acceptance; HTTP authentication and browser behavior are verified separately.',
    root: relative(repository, root),
    origin: { root: relative(repository, priorRoot), acceptanceReportSha256: sha256(priorReportText),
      realLocalCli: true, newLocalCliInvocation: false, generation: prior.generation, sourceMissionId: origin.id,
      fixture: prior.fixture, counts: baselineCounts,
      copiedStateSha256: Object.fromEntries([...preserved].map(([file, bytes]) => [file, sha256(bytes)])),
      originalFilesUnchanged: true, copiedAuthOrCredentials: false },
    modelCalls, separateModelApiUsed: false,
    fixture: { version: 'synthetic-routine-reuse-v1', sourceRows: 225, targetRows: 3,
      expectedCounts, expectedDeltas, expectedRelationshipCounts, expectedPrioritySourceRows: expectedPriority,
      expectationOrigin: 'Manually authored counts, findings and priority positions, independent of the product evaluator.',
      sourceRowsSha256: sha256(JSON.stringify(rows)), targetRowsSha256: sha256(JSON.stringify(supplierRows)) },
    routine, from, to, relationship, preview, mission: completed,
    checks: { realAstraOriginVerified: true, immutableOriginalEvidenceFiles: true, independentCompleteCounts: true,
      independentPriorityAndNewFindings: true, completeSourceBeyond200Rows: true, previewReadOnly: true,
      sameConfirmedFamiliesAndKeys: true, newUnknownStatusUnassessable: true, missingAndInvalidDatesVisible: true,
      countDeltasDoNotClaimCauses: true, noModelStatusOrGenerateCalls: true, noSeparateModelApi: true,
      oldMissionAndRoutineUnchanged: true, bothLiveSourcesDeletedBeforeRun: true,
      previewSurvivesRestartAndSameIdReplacement: true, stalePreviewRejectedWithoutCreatingMission: true,
      persistedResultAfterRestart: true, idempotentCreateAfterRestart: true, idempotentRunAfterRestart: true,
      changedIdempotencyPayloadRejected: true, exactlyOneNewMission: true, reusedPlanOriginExplicit: true,
      bothSourceAndSemanticHashesBound: true, confirmedRuleHashBound: true },
  };
  const serialized = JSON.stringify(report, null, 2) + '\n';
  await writeFile(join(root, 'acceptance-report.json'), serialized, { mode: 0o600 });
  await writeFile(join(curatedRoot, 'acceptance-report.json'), serialized);
  stage('passed', { acceptanceReport: join(root, 'acceptance-report.json'), curatedReport: join(curatedRoot, 'acceptance-report.json'),
    missionId: completed.id, counts: completed.result!.counts, modelCalls, checks: report.checks });
} catch (error) {
  await writeFile(join(root, 'acceptance-failure.json'), JSON.stringify({ at: new Date().toISOString(),
    error: error instanceof Error ? error.stack : String(error) }, null, 2), { mode: 0o600 });
  throw error;
} finally {
  await service?.close();
  await service?.whenIdle();
}
