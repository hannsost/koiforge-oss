import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import type { CaseRecord } from '../../src/cases/contracts.js';
import type { Mission } from '../../src/missions/contracts.js';

// Only documented synthetic acceptance data is copied. No user auth, model
// calls, listening sockets or changes to the live workspace are involved.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const priorRoot = resolve(process.argv[2] ?? join(repository, '.koiforge/verification/cases-local-JeAXD4'));
const curated = resolve(process.argv[3] ?? join(repository, 'docs/verification/recovery-2026-09-23'));
const execFile = promisify(execFileCallback);
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const sourceFiles = ['missions/state.json', 'semantic-model/state.json', 'dataset-registry.json', 'cases/state.json'];
const priorBytes = new Map<string, Buffer>();
const priorReportBytes = await readFile(join(priorRoot, 'acceptance-report.json'));
const prior = JSON.parse(priorReportBytes.toString()) as {
  synthetic: boolean; customerAcceptance: boolean; checks: Record<string, boolean>;
  origin: { realLocalCli: boolean; generation: { backend: string; model: string; reasoningEffort: string }; sourceMissionId: string };
  case: CaseRecord;
};
assert.equal(prior.synthetic, true);
assert.equal(prior.customerAcceptance, false);
assert(Object.values(prior.checks).every(Boolean));
assert.equal(prior.origin.realLocalCli, true);
assert.deepEqual(prior.origin.generation, { backend: 'codex', model: 'gpt-6-astra', reasoningEffort: 'xhigh' });
for (const file of sourceFiles) priorBytes.set(file, await readFile(join(priorRoot, file)));
const originMission = (JSON.parse(priorBytes.get('missions/state.json')!.toString()) as { missions: Record<string, Mission> }).missions[prior.origin.sourceMissionId]!;
assert.equal(originMission.status, 'completed');
assert.deepEqual((JSON.parse(priorBytes.get('cases/state.json')!.toString()) as { cases: Record<string, CaseRecord> }).cases[prior.case.id], prior.case);

await mkdir(curated, { recursive: true });
const workspace = await mkdtemp(join(repository, '.koiforge/verification/recovery-local-'));
const root = join(workspace, 'state');
const backup = join(workspace, 'backup');
for (const [file, bytes] of priorBytes) {
  await mkdir(dirname(join(root, file)), { recursive: true, mode: 0o700 });
  await writeFile(join(root, file), bytes, { mode: 0o600 });
}
process.env.KOIFORGE_STATE_ROOT = root;
process.env.KOIFORGE_IMPORT_DATA_ROOT = root;
process.env.KOIFORGE_GENERATION_DISABLED = '1';
process.env.KOIFORGE_PUBLIC_ORIGIN = 'http://127.0.0.1:5173';
process.env.NODE_ENV = 'test';
delete process.env.KOIFORGE_BOOTSTRAP_TOKEN;
const sentinel = join(workspace, 'unexpected-model-call');
const noModel = join(workspace, 'no-model.mjs');
await writeFile(noModel, `#!${process.execPath}\nimport{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(sentinel)},'unexpected');process.exit(1);\n`, { mode: 0o700 });
process.env.KOIFORGE_CODEX_BIN = noModel;
const { AuthStore } = await import('../../src/auth-store.js');
const setup = await new AuthStore(join(root, 'auth.json')).setup({ email: 'restore@example.test',
  password: 'synthetic restore acceptance only', displayName: 'Synthetic restore owner', workspaceName: 'Synthetic recovery workspace' });
// Bind a newly generated synthetic login to the already synthetic evidence owner;
// no stored mission, semantic receipt or case evidence is rewritten.
const auth = JSON.parse(await readFile(join(root, 'auth.json'), 'utf8'));
const syntheticOwner = auth.accounts.find((account: { role: string }) => account.role === 'owner');
assert(syntheticOwner);
const setupOwnerId = syntheticOwner.id;
syntheticOwner.id = originMission.ownerId;
for (const session of auth.sessions) if (session.userId === setupOwnerId) session.userId = originMission.ownerId;
assert.equal(auth.workspace.id, originMission.tenantId);
await writeFile(join(root, 'auth.json'), JSON.stringify(auth), { mode: 0o600 });
const { buildServer } = await import('../../src/server.js');
let app: FastifyInstance | undefined;
const checks: Record<string, boolean> = {};
const headers = { cookie: `koiforge_session=${setup.token}`, 'x-koiforge-request': '1' };
async function api(path: string, payload?: Record<string, unknown>) {
  const response = await app!.inject({ method: payload ? 'POST' : 'GET', url: `/api/${path}`, headers, ...(payload ? { payload } : {}) });
  assert(response.statusCode >= 200 && response.statusCode < 300, `${path}: ${response.statusCode} ${response.body}`);
  return response.json();
}
async function command(args: string[], success = true) {
  try {
    const result = await execFile(process.execPath, [join(repository, 'scripts/state.mjs'), ...args], { cwd: repository, timeout: 30_000 });
    assert(success, `Command unexpectedly succeeded: ${args[0]}`);
    return result.stdout;
  } catch (error) {
    if (success) throw error;
    assert.equal((error as { code?: number }).code, 1, 'Expected controlled CLI rejection');
    return '';
  }
}
async function inventory(directory: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name); const key = prefix + name; const stat = await lstat(path);
    assert(!stat.isSymbolicLink());
    if (stat.isDirectory()) Object.assign(result, { [key + '/']: 'directory' }, await inventory(path, key + '/'));
    else { assert(stat.isFile()); result[key] = sha(await readFile(path)); }
  }
  return result;
}
async function missing(path: string) { await assert.rejects(lstat(path), { code: 'ENOENT' }); }
const stage = (name: string) => console.log(JSON.stringify({ stage: name, at: new Date().toISOString() }));
try {
  stage('starting-synthetic-workspace');
  app = await buildServer();
  await app.ready();
  assert.deepEqual((await api(`missions/${originMission.id}`)).mission, originMission);
  assert.deepEqual((await api(`cases/${prior.case.id}`)).case, prior.case);
  const routineInput = { sourceMissionId: originMission.id, name: 'Synthetische Wiederherstellungsroutine', confirmed: true, requestId: randomUUID() };
  const routine = (await api('routines', routineInput)).routine;
  const routinePreviewInput = { relationshipId: originMission.relationshipId!, asOf: '2026-09-24' };
  const routinePreview = await api(`routines/${routine.id}/preview`, routinePreviewInput);
  const casePreview = await api('cases/preview', { missionId: originMission.id, sourceRow: 1 });
  const findings = await api(`cases/findings?missionId=${originMission.id}&limit=100`);
  const relationship = await api(`model/relationships/${originMission.relationshipId}`);
  checks.realAstraEvidenceAndCaseReadable = true;

  // Project grants and the second synthetic account must survive the same backup.
  const invitation = await api('team/invites', { email: 'restore-reader@example.test', displayName: 'Synthetic restore reader' });
  const reader = await new AuthStore(join(root, 'auth.json')).acceptInvitation({ token: invitation.token, password: 'synthetic restore reader passphrase' });
  const projectInput = { name: 'Synthetic shared recovery project', description: 'Read-only recovery fixture',
    familyIds: [...new Set([relationship.from.familyId, relationship.to.familyId])], memberIds: [reader.session.user.id],
    confirmed: true, requestId: randomUUID() };
  const project = (await api('projects', projectInput)).project;
  const readerHeaders = { cookie: `koiforge_session=${reader.token}`, 'x-koiforge-request': '1' };
  const sharedPath = `/api/object-workspace/families/${relationship.from.familyId}/objects?projectId=${project.id}`;
  const sharedBefore = await app.inject({ url: sharedPath, headers: readerHeaders });
  assert.equal(sharedBefore.statusCode, 200); assert(sharedBefore.json().items.length > 0);

  // A confirmed relationship source family drives a real saved, run and
  // published dataflow before backup. Its full immutable records and rows are
  // retained below for exact post-restore comparison.
  const dataflowSaveInput = { spec: { name: 'Synthetischer Wiederherstellungsdatenfluss',
    description: 'Bestätigten Quellstand unverändert für den Wiederherstellungsnachweis veröffentlichen.',
    inputFamilyId: relationship.from.familyId, keyField: relationship.from.keyField,
    joins: [], filters: [{ field: relationship.from.keyField, operator: 'contains', value: 'O-00' }], minRows: 1 },
    confirmed: true, requestId: randomUUID() };
  const dataflowDefinition = (await api('dataflows', dataflowSaveInput)).definition;
  const dataflowRunInput = { definitionId: dataflowDefinition.id, requestId: randomUUID(), confirmed: true };
  const dataflowRun = (await api(`dataflows/${dataflowDefinition.flowId}/runs`, dataflowRunInput)).run;
  assert.equal(dataflowRun.status, 'ready', dataflowRun.issues.join('; '));
  assert.equal(dataflowRun.sources.length, 1);
  assert.equal(dataflowRun.sources[0].familyId, relationship.from.familyId);
  const dataflowPublication = (await api(`dataflows/${dataflowDefinition.flowId}/runs/${dataflowRun.id}/publish`,
    { confirmed: true })).objectSet;
  const frozenDataflowDetail = structuredClone(await api(`dataflows/${dataflowDefinition.flowId}`));
  const frozenDependencyGraph = structuredClone(await api('dataflows/dependencies'));
  const frozenDataflowRun = structuredClone(await api(`dataflows/${dataflowDefinition.flowId}/runs/${dataflowRun.id}?offset=0&limit=100`));
  assert.deepEqual(frozenDataflowDetail.definition, dataflowDefinition);
  assert.deepEqual(frozenDataflowDetail.published, dataflowPublication);
  assert.deepEqual(frozenDataflowRun.run, frozenDataflowDetail.runs[0]);
  assert.deepEqual(frozenDataflowRun.run.published, dataflowPublication);
  assert.equal(frozenDataflowRun.rows.length, dataflowRun.rowCount);
  assert(frozenDataflowRun.rows.length > 0);
  checks.syntheticDataflowSavedRunAndPublished = true;

  // A real CSV import session exercises absolute source/artifact paths.
  const boundary = 'koiforge-recovery-boundary';
  const upload = await app.inject({ method: 'POST', url: '/api/import/sessions',
    headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="restore.csv"\r\nContent-Type: text/csv\r\n\r\nid,status\nRESTORE-1,open\nRESTORE-2,closed\n\r\n--${boundary}--\r\n`) });
  assert.equal(upload.statusCode, 200, upload.body);
  const importSession = upload.json().session;
  const sourceNode = Object.values(importSession.nodes).find((node: any) => node.sourcePath?.endsWith('restore.csv')) as { id: string; sourcePath: string };
  assert(sourceNode);
  await api(`import/sessions/${importSession.id}/select`, { selectedNodeIds: [sourceNode.id] });
  const imported = await api(`import/sessions/${importSession.id}/run`, {});
  assert.equal(imported.importedDatasets.length, 1);
  const datasetId = imported.importedDatasets[0].id;
  const rows = (await api(`datasets/${datasetId}/preview`)).rows;
  assert.deepEqual(rows, [{ id: 'RESTORE-1', status: 'open' }, { id: 'RESTORE-2', status: 'closed' }]);
  checks.realImportedCsvReadable = true;

  await command(['backup', '--root', root, '--output', backup], false);
  await missing(backup);
  await assert.rejects(buildServer());
  checks.runningApiRejectsBackupAndSecondWriter = true;
  await app.close(); app = undefined;
  await mkdir(join(root, 'empty-state-directory'), { mode: 0o700 });
  const before = await inventory(root);
  stage('backup-and-verify');
  await command(['backup', '--root', root, '--output', backup]);
  await command(['verify', '--backup', backup]);
  assert.deepEqual(await inventory(root), before);
  checks.backupPreservesOriginalBytes = true;
  await command(['restore', '--backup', backup, '--target', root], false);
  assert.deepEqual(await inventory(root), before);
  checks.existingTargetNeverOverwritten = true;
  const movedTarget = join(workspace, 'relocated');
  await command(['restore', '--backup', backup, '--target', movedTarget], false);
  await missing(movedTarget);
  checks.relocationRejected = true;
  const corrupt = join(workspace, 'corrupt-backup');
  await cp(backup, corrupt, { recursive: true, errorOnExist: true, force: false });
  await writeFile(join(corrupt, 'data/cases/state.json'), '{}');
  await command(['verify', '--backup', corrupt], false);
  checks.corruptBackupRejected = true;

  stage('recover-same-path');
  await rename(root, join(workspace, 'preserved-before-recovery'));
  await command(['restore', '--backup', corrupt, '--target', root], false);
  await missing(root);
  checks.corruptRestoreLeavesTargetAbsent = true;
  await command(['restore', '--backup', backup, '--target', root]);
  assert.deepEqual(await inventory(root), before);
  checks.allFilesAndEmptyDirectoriesRestoredExactly = true;
  checks.syntheticAuthenticationPreservedExactly = sha(await readFile(join(root, 'auth.json'))) === before['auth.json'];
  app = await buildServer(); await app.ready();
  assert.equal((await api('auth/session')).user.id, originMission.ownerId);
  assert.deepEqual((await api(`projects/${project.id}`)).project, project);
  assert.deepEqual((await api('projects', projectInput)).project, project);
  const sharedAfter = await app.inject({ url: sharedPath, headers: readerHeaders });
  assert.equal(sharedAfter.statusCode, 200); assert.deepEqual(sharedAfter.json(), sharedBefore.json());
  assert.equal((await app.inject({ url: '/api/datasets', headers: readerHeaders })).statusCode, 403);
  checks.sharedProjectsAndReaderSessionsRestored = true;
  checks.projectIdempotencyPreserved = true;
  assert.deepEqual((await api(`missions/${originMission.id}`)).mission, originMission);
  assert.deepEqual((await api(`cases/${prior.case.id}`)).case, prior.case);
  assert.deepEqual(await api(`model/relationships/${originMission.relationshipId}`), relationship);
  assert.deepEqual(await api(`cases/findings?missionId=${originMission.id}&limit=100`), findings);
  assert.deepEqual((await api(`routines/${routine.id}`)).routine, routine);
  assert.deepEqual(await api(`routines/${routine.id}/preview`, routinePreviewInput), routinePreview);
  assert.deepEqual((await api(`datasets/${datasetId}/preview`)).rows, rows);
  assert.deepEqual(await api(`dataflows/${dataflowDefinition.flowId}`), frozenDataflowDetail);
  assert.deepEqual(await api(`dataflows/${dataflowDefinition.flowId}/runs/${dataflowRun.id}?offset=0&limit=100`), frozenDataflowRun);
  checks.dataflowDefinitionRunRowsAndPublicationRestored = true;
  assert.deepEqual(await api('dataflows/dependencies'), frozenDependencyGraph);
  checks.dataflowDependenciesRestored = true;
  assert.deepEqual((await api('dataflows', dataflowSaveInput)).definition, frozenDataflowDetail.definition);
  assert.deepEqual((await api(`dataflows/${dataflowDefinition.flowId}/runs`, dataflowRunInput)).run, frozenDataflowRun.run);
  assert.deepEqual((await api(`dataflows/${dataflowDefinition.flowId}/runs/${dataflowRun.id}/publish`,
    { confirmed: true })).objectSet, dataflowPublication);
  checks.dataflowSaveRunAndPublicationIdempotencyPreserved = true;
  const readerFlowRequests: Array<{ method: 'GET' | 'POST'; url: string; payload?: Record<string, unknown> }> = [
    { method: 'GET', url: '/api/dataflows' },
    { method: 'GET', url: `/api/dataflows/${dataflowDefinition.flowId}` },
    { method: 'GET', url: `/api/dataflows/${dataflowDefinition.flowId}/runs/${dataflowRun.id}` },
    { method: 'POST', url: '/api/dataflows', payload: dataflowSaveInput },
    { method: 'POST', url: `/api/dataflows/${dataflowDefinition.flowId}/runs`, payload: dataflowRunInput },
    { method: 'POST', url: `/api/dataflows/${dataflowDefinition.flowId}/runs/${dataflowRun.id}/publish`, payload: { confirmed: true } },
  ];
  for (const request of readerFlowRequests) {
    const response: { statusCode: number; body: string } = await app.inject({ ...request,
      headers: { ...readerHeaders, 'x-koiforge-request': '1' } });
    assert.equal(response.statusCode, 403, `${request.method} ${request.url}: ${response.statusCode} ${response.body}`);
  }
  checks.dataflowReaderAuthorizationPreserved = true;
  const restoredSession = (await api(`import/sessions/${importSession.id}`)).session;
  assert.equal(restoredSession.nodes[sourceNode.id].sourcePath, sourceNode.sourcePath);
  assert.equal(restoredSession.nodes[sourceNode.id].importedDatasetId, datasetId);
  assert((await readFile(sourceNode.sourcePath, 'utf8')).includes('RESTORE-2,closed'));
  checks.authenticatedHttpReadsAfterRestore = true;
  checks.routineRulesPreviewAndProvenancePreserved = true;
  checks.importSessionAbsolutePathsAndRowsPreserved = true;
  const duplicate = (await api('cases', { missionId: originMission.id, sourceRow: 1, previewHash: casePreview.previewHash,
    confirmed: true, requestId: randomUUID() })).case;
  assert.deepEqual(duplicate, prior.case);
  assert.deepEqual((await api('routines', routineInput)).routine, routine);
  checks.caseAndRoutineIdempotencyPreserved = true;
  const claimed = (await api(`cases/${prior.case.id}/transition`, { revision: prior.case.revision, action: 'claim', confirmed: true, requestId: randomUUID() })).case;
  assert.equal(claimed.status, 'in_progress');
  assert.equal(claimed.revision, prior.case.revision + 1);
  assert.equal(claimed.assignee.id, originMission.ownerId);
  assert.deepEqual(claimed.evidence, prior.case.evidence);
  assert.deepEqual(claimed.events.slice(0, -1), prior.case.events);
  checks.caseWorkContinuesWithEvidenceIntact = true;
  await app.close(); app = undefined;
  for (const [file, bytes] of priorBytes) assert((await readFile(join(priorRoot, file))).equals(bytes));
  assert((await readFile(join(priorRoot, 'acceptance-report.json'))).equals(priorReportBytes));
  await missing(sentinel);
  checks.originalAcceptanceUntouched = true;
  checks.noNewModelCliCalls = true;
  assert(Object.values(checks).every(Boolean));
  const report = { completedAt: new Date().toISOString(), synthetic: true, customerAcceptance: false,
    interface: 'Real full Fastify app via authenticated inject, actual backup CLI child processes, no listening ports.',
    root: relative(repository, workspace), source: relative(repository, priorRoot), sourceReportSha256: sha(priorReportBytes),
    generationOrigin: prior.origin.generation, newModelCliCalls: 0, copiedUserCredentials: false,
    restoredEntryCount: Object.keys(before).length, originalMissionId: originMission.id, caseId: prior.case.id,
    dataflow: { flowId: dataflowDefinition.flowId, definitionId: dataflowDefinition.id, runId: dataflowRun.id,
      publishedSetId: dataflowPublication.id, rowCount: frozenDataflowRun.rows.length }, checks };
  await writeFile(join(curated, 'acceptance-report.json'), JSON.stringify(report, null, 2) + '\n');
  stage('passed');
  console.log(JSON.stringify({ checks: Object.keys(checks).length, report: join(curated, 'acceptance-report.json') }));
} finally { await app?.close(); }
