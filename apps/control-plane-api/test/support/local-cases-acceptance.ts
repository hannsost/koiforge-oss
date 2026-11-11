import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileDatasetRegistry } from '@koiforge/data-registry';
import type { SessionContext } from '@koiforge/security-core';
import { createCaseService } from '../../src/cases/service.js';
import type { Mission } from '../../src/missions/contracts.js';
import { createSemanticModelService } from '../../src/semantic-model/service.js';

// Direct local services only. Reuse the documented synthetic Astra origin;
// create no mission engine, generator, server, login or external action.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const priorRoot = resolve(process.argv[2] ?? join(repository, '.koiforge/verification/orders-local-zLV1G7'));
const evidenceRoot = resolve(process.argv[3] ?? join(repository, '.koiforge/verification'));
const curatedRoot = resolve(process.argv[4] ?? join(repository, 'docs/verification/cases-2026-09-23'));
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const priorReportBytes = await readFile(join(priorRoot, 'acceptance-report.json'));
const prior = JSON.parse(priorReportBytes.toString('utf8')) as {
  synthetic: boolean; customerAcceptance: boolean; realLocalCli: boolean; separateModelApiConfigured: boolean;
  generation: { backend: string; model: string; reasoningEffort: string }; mission: Mission;
  fixture: { expectedSha256: string; sourceCsvSha256: string; targetCsvSha256: string };
};
assert.equal(prior.synthetic, true);
assert.equal(prior.customerAcceptance, false);
assert.equal(prior.realLocalCli, true);
assert.equal(prior.separateModelApiConfigured, false);
assert.deepEqual(prior.generation, { backend: 'codex', model: 'gpt-6-astra', reasoningEffort: 'xhigh' });
assert.equal(prior.mission.status, 'completed');
assert.equal(prior.mission.plan?.capabilityId, 'order_review');
assert.deepEqual(prior.mission.plan?.generation, prior.generation);
for (const [file, expected] of [['expected.json', prior.fixture.expectedSha256],
  ['bestellungen.csv', prior.fixture.sourceCsvSha256], ['lieferanten.csv', prior.fixture.targetCsvSha256]] as const) {
  assert.equal(sha256(await readFile(join(repository, 'examples/order-review', file))), expected);
}
const originalFinding = prior.mission.result!.rows.find(row => row.Quellzeile === 1)!;
assert.equal(originalFinding.Befund, 'Überfällig');
assert.equal(originalFinding['Bestellungs-ID'], '"O-001"');
assert.equal(originalFinding['Tage überfällig'], 13);
const files = ['missions/state.json', 'semantic-model/state.json', 'dataset-registry.json'];
const preserved = new Map<string, Buffer>();
for (const file of files) preserved.set(file, await readFile(join(priorRoot, file)));
const missionState = JSON.parse(preserved.get('missions/state.json')!.toString('utf8')) as { missions: Record<string, Mission> };
assert.deepEqual(missionState.missions[prior.mission.id], prior.mission);
assert.equal(Object.keys(missionState.missions).length, 1);
await mkdir(evidenceRoot, { recursive: true });
await mkdir(curatedRoot, { recursive: true });
const root = await mkdtemp(join(evidenceRoot, 'cases-local-'));
for (const [file, bytes] of preserved) {
  await mkdir(dirname(join(root, file)), { recursive: true, mode: 0o700 });
  await writeFile(join(root, file), bytes, { mode: 0o600 });
}
assert.equal((await readdir(root)).includes('auth.json'), false);
const owner: SessionContext = {
  user: { id: prior.mission.ownerId, displayName: 'Synthetic case acceptance owner' },
  tenant: { id: prior.mission.tenantId, name: 'Synthetic case acceptance', slug: 'case-acceptance', status: 'active' },
  roleIds: ['owner'], permissions: ['datasets.read', 'datasets.manage', 'cases.read', 'cases.manage'],
};
const authority = {
  async resolvePrincipal(reference: { userId: string; tenantId: string }) {
    return reference.userId === owner.user.id && reference.tenantId === owner.tenant.id ? structuredClone(owner) : null;
  },
  assertPermissions(session: SessionContext, permissions: string[]) {
    assert(permissions.every(permission => session.permissions.includes(permission)));
  },
};
function openService() {
  const dataset = new FileDatasetRegistry({ filePath: join(root, 'dataset-registry.json') });
  const semanticModel = createSemanticModelService({ root, registries: { dataset }, ...authority });
  return createCaseService({ root, semanticModel, ...authority });
}
const stage = (stage: string, details: Record<string, unknown> = {}) => console.log(JSON.stringify({ stage, at: new Date().toISOString(), ...details }));
stage('started', { root, sourceMissionId: prior.mission.id, originRealLocalCli: true, newModelInvocation: false });
try {
  let service = openService();
  const selection = { missionId: prior.mission.id, sourceRow: 1 };
  const preview = await service.preview(owner, selection);
  assert.equal(preview.existingCaseId, null);
  assert.deepEqual(preview.evidence.finding, originalFinding);
  assert.equal(preview.evidence.orderRuleHash, prior.mission.result!.evidence.orderRuleHash);
  assert.equal(preview.evidence.source.hash, prior.mission.result!.evidence.sourceHash);
  assert.equal(preview.evidence.targetSource.hash, prior.mission.result!.evidence.targetSourceHash);
  assert.equal(preview.evidence.relationship.fromSnapshotHash, prior.mission.result!.evidence.fromSnapshotHash);
  assert.equal(preview.evidence.relationship.toSnapshotHash, prior.mission.result!.evidence.toSnapshotHash);
  assert.equal(preview.evidence.capabilityVersion, 'order-review-v1');
  assert.equal(preview.evidence.orderKeyField, 'bestell_id');
  assert.equal((await service.list(owner)).length, 0, 'preview creates no case');
  const createInput = { ...selection, previewHash: preview.previewHash, confirmed: true, requestId: randomUUID() };
  const created = await service.create(owner, createInput);
  assert.equal(created.status, 'open');
  assert.equal(created.revision, 1);
  assert.equal(created.assignee, null);
  assert.equal(created.resolution, null);
  assert.equal((await service.create(owner, createInput)).id, created.id);
  const claimed = await service.transition(owner, created.id, { revision: 1, action: 'claim', confirmed: true, requestId: randomUUID() });
  assert.equal(claimed.status, 'in_progress');
  assert.deepEqual(claimed.assignee, { id: owner.user.id, displayName: owner.user.displayName });
  const resolution = 'Synthetischen Befund geprüft; keine externe Handlung ausgeführt.';
  const resolved = await service.transition(owner, created.id, { revision: 2, action: 'resolve', note: resolution,
    confirmed: true, requestId: randomUUID() });
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolution, resolution);
  const reason = 'Synthetische erneute Prüfung des ursprünglichen Befunds erforderlich.';
  const reopened = await service.transition(owner, created.id, { revision: 3, action: 'reopen', note: reason,
    confirmed: true, requestId: randomUUID() });
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.revision, 4);
  assert.equal(reopened.assignee, null);
  assert.equal(reopened.resolution, null);
  assert.deepEqual(reopened.events.map(event => event.kind), ['created', 'claimed', 'resolved', 'reopened']);
  assert.deepEqual(reopened.events.map(event => event.note), [null, null, resolution, reason]);
  for (const item of [created, claimed, resolved, reopened]) {
    assert.deepEqual(item.evidence, preview.evidence);
    assert.equal(item.evidenceHash, preview.evidenceHash);
    assert.equal(item.events.length, item.revision);
    assert(item.events.every(event => event.actorId === owner.user.id && event.actorName === owner.user.displayName));
  }
  // Reopen all concrete stores. A fresh request ID is still the same business
  // finding, so neither a duplicate case nor another created event is allowed.
  service = openService();
  assert.deepEqual(await service.get(owner, created.id), reopened);
  const duplicate = await service.create(owner, { ...createInput, requestId: randomUUID() });
  assert.deepEqual(duplicate, reopened);
  assert.deepEqual(await service.create(owner, createInput), reopened);
  assert.deepEqual(await service.list(owner), [reopened]);
  assert.equal((await service.preview(owner, selection)).existingCaseId, created.id);
  for (const [file, bytes] of preserved) {
    assert((await readFile(join(root, file))).equals(bytes), `copied ${file} stays byte-for-byte unchanged`);
    assert((await readFile(join(priorRoot, file))).equals(bytes), `original ${file} stays byte-for-byte unchanged`);
  }
  assert((await readFile(join(priorRoot, 'acceptance-report.json'))).equals(priorReportBytes));
  const report = {
    completedAt: new Date().toISOString(), synthetic: true, customerAcceptance: false,
    interface: 'Direct real CaseService and semantic/file stores; authentication routes and browser behavior are verified separately.',
    root: relative(repository, root),
    origin: { root: relative(repository, priorRoot), sourceMissionId: prior.mission.id, realLocalCli: true,
      generation: prior.generation, acceptanceReportSha256: sha256(priorReportBytes),
      preservedStateSha256: Object.fromEntries([...preserved].map(([file, bytes]) => [file, sha256(bytes)])) },
    newModelInvocations: 0, newCliInvocations: 0, separateModelApiUsed: false, copiedAuthOrCredentials: false,
    preview, case: reopened, observedStatuses: [created.status, claimed.status, resolved.status, reopened.status],
    checks: { realAstraOriginAndFixtureVerified: true, originalOverdueFindingReproduced: true,
      previewDoesNotCreateCase: true, exactConfirmedPreviewCreated: true, selfAssignmentFromCurrentPrincipal: true,
      documentedResolution: true, documentedReopening: true, reopenedAssignmentAndResolutionCleared: true,
      fourImmutableEvidenceEvents: true, persistedCaseAfterRestart: true, originalRequestIdempotentAfterRestart: true,
      newRequestIdReturnsExistingCase: true, exactlyOneCaseAndCreatedEvent: true, existingCaseVisibleInPreview: true,
      copiedMissionSemanticDatasetBytesUnchanged: true, originalStateAndReportBytesUnchanged: true,
      bothSourceAndSemanticReceipts: true, confirmedRulesAndCapabilityBound: true, noNewModelCliOrExternalAction: true },
  };
  const serialized = JSON.stringify(report, null, 2) + '\n';
  await writeFile(join(root, 'acceptance-report.json'), serialized, { mode: 0o600 });
  await writeFile(join(curatedRoot, 'acceptance-report.json'), serialized);
  stage('passed', { caseId: reopened.id, revision: reopened.revision, status: reopened.status,
    curatedReport: join(curatedRoot, 'acceptance-report.json'), checks: report.checks });
} catch (error) {
  await writeFile(join(root, 'acceptance-failure.json'), JSON.stringify({ at: new Date().toISOString(),
    error: error instanceof Error ? error.stack : String(error) }, null, 2), { mode: 0o600 });
  throw error;
}
