import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { FileDatasetRegistry } from '@koiforge/data-registry';
import type { SessionContext } from '@koiforge/security-core';
import type { CaseEvidence, CaseFindingsOptions, CaseSnapshot } from '../src/cases/contracts.js';
import { buildCaseEvidence, listCaseFindings, validateCaseEvidence } from '../src/cases/evidence.js';
import { ORDER_REVIEW_VERSION, reviewOrders } from '../src/domain/orders/review.js';
import type { ImportRow } from '../src/import-capability/isolated-executor.js';
import type { Mission, MissionRelationship } from '../src/missions/contracts.js';
import { createSemanticModelService } from '../src/semantic-model/service.js';

const owner: SessionContext = { user: { id: 'case-reference-owner', displayName: 'Synthetic case owner' },
  tenant: { id: 'case-reference-firm', name: 'Synthetic case firm', slug: 'case-reference-firm', status: 'active' },
  roleIds: ['owner'], permissions: ['datasets.read', 'datasets.manage'] };
const principal = { ownerId: owner.user.id, tenantId: owner.tenant.id };
const binding = { statusField: 'status', dueDateField: 'due' };
const orderRule = { openStatuses: ['Offen'], closedStatuses: ['Erledigt'], asOf: '2026-09-23',
  dueDateMeaning: 'promised_delivery_day' as const };
const expectedCounts = { sourceRows: 231, overdueRows: 225, openRows: 2, closedRows: 2,
  unassessableRows: 2, clarificationRows: 4, deadlineUnassessableRows: 1 };
const actionablePositions = [...Array.from({ length: 225 }, (_, index) => index + 1), 230, 231, 229, 228];

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'koi-case-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataset = new FileDatasetRegistry({ filePath: join(root, 'datasets.json') });
  const options = { root, registries: { dataset },
    async resolvePrincipal(reference: { userId: string; tenantId: string }) {
      return reference.userId === owner.user.id && reference.tenantId === owner.tenant.id ? structuredClone(owner) : null;
    },
    assertPermissions(session: SessionContext, permissions: string[]) {
      assert(permissions.every(permission => session.permissions.includes(permission)));
    },
  };
  const semantic = createSemanticModelService(options);
  const rows: ImportRow[] = Array.from({ length: 225 }, (_, index) => ({
    id: `order-${index + 1}`, supplier: 'S', status: 'Offen', due: '2026-09-20',
  }));
  rows.push(
    { id: 'clean-open', supplier: 'S', status: 'Offen', due: '2026-09-23' },
    { id: 'clean-closed', supplier: 'S', status: 'Erledigt', due: 'invalid' },
    { id: 'closed-clarification', supplier: 'MISSING', status: 'Erledigt', due: 'invalid' },
    { id: 'open-clarification', supplier: 'S', status: 'Offen', due: null },
    { id: 'unknown-status', supplier: 'S', status: 'Nicht bestätigt', due: '2026-09-20' },
    { id: null, supplier: 'S', status: 'Offen', due: '2026-09-20' },
  );
  const source = await dataset.registerInlineDataset({ name: 'Synthetic orders', namespace: 'cases-reference', rows });
  const target = await dataset.registerInlineDataset({ name: 'Synthetic suppliers', namespace: 'cases-reference', rows: [{ id: 'S', label: 'Synthetic supplier' }] });
  const from = await semantic.createObjectSet(owner, { name: 'Bestellungen', datasetId: source.id, keyField: 'id',
    confirmed: true, requestId: randomUUID() });
  const to = await semantic.createObjectSet(owner, { name: 'Lieferanten', datasetId: target.id, keyField: 'id', labelField: 'label',
    confirmed: true, requestId: randomUUID() });
  const relation = await semantic.createRelationship(owner, { name: 'Lieferant der Bestellung', fromSetId: from.id,
    toSetId: to.id, fromField: 'supplier', confirmed: true, requestId: randomUUID() });
  const snapshot = await semantic.relationshipSnapshotForMission(principal, relation.id);
  const relationship: MissionRelationship = { id: relation.id, name: relation.name, fromSetId: from.id, toSetId: to.id,
    fromName: from.name, toName: to.name, fromField: relation.fromField, toField: to.keyField, fromRevision: from.revision,
    toRevision: to.revision, sourceHash: from.source.hash, targetHash: to.source.hash, targetRows: to.source.rowCount,
    fromSnapshotHash: from.snapshotHash, toSnapshotHash: to.snapshotHash };
  const { ruleHash, ...result } = reviewOrders(snapshot.detail, snapshot.fromRows, binding, orderRule);
  assert.deepEqual(result.counts, expectedCounts, 'manually authored business reference');
  const at = '2026-09-23T11:00:00.000Z';
  const mission: Mission = { id: randomUUID(), ...principal, question: 'Welche Bestellungen benötigen Klärung?',
    datasetId: source.id, relationshipId: relation.id, status: 'completed', phase: 'execute', revision: 5,
    createdAt: at, updatedAt: at, source: structuredClone(from.source),
    plan: { capabilityId: 'order_review', capabilityVersion: ORDER_REVIEW_VERSION, summary: 'Bestellungen prüfen.',
      steps: ['Bestätigte Regeln anwenden.'], limitations: ['Keine externe Aktion.'], suggestedBinding: binding,
      generation: { backend: 'codex', model: 'case-reference-origin', reasoningEffort: 'xhigh' }, relationship, orderKeyField: 'id' },
    input: { confirmed: true, binding, orderRule },
    result: { ...result, capabilityId: 'order_review', evidence: { sourceHash: from.source.hash, targetSourceHash: to.source.hash,
      fromSnapshotHash: from.snapshotHash, toSnapshotHash: to.snapshotHash, capabilityVersion: ORDER_REVIEW_VERSION,
      executedAt: at, relationshipId: relation.id, fromSetId: from.id, toSetId: to.id, orderRuleHash: ruleHash } },
    events: [{ at, status: 'completed', message: 'Synthetic completed case reference.' }] };
  return { dataset, options, semantic, source, target, from, to, snapshot, mission };
}

test('all actionable findings are paginated in original priority order beyond the stored 100-row result', async t => {
  const f = await fixture(t);
  assert.equal(f.mission.result!.rows.length, 100);
  const positions: number[] = [];
  for (let offset = 0; offset < 229; offset += 73) {
    const page = listCaseFindings(f.mission, f.snapshot, { offset, limit: 73 });
    assert.equal(page.offset, offset);
    assert.equal(page.limit, 73);
    assert.equal(page.totalRows, 229);
    assert(page.items.length <= 73);
    positions.push(...page.items.map(row => row.Quellzeile as number));
  }
  assert.deepEqual(positions, actionablePositions);
  assert.equal(new Set(positions).size, 229);
  assert.deepEqual(listCaseFindings(f.mission, f.snapshot, { offset: 229, limit: 10 }), {
    items: [], offset: 229, limit: 10, totalRows: 229,
  });
  const defaults = listCaseFindings(f.mission, f.snapshot);
  assert.equal(defaults.offset, 0);
  assert.equal(defaults.limit, 100);
  assert.equal(defaults.items.length, 100);
});

test('a selected original source row outside the result table produces complete frozen evidence', async t => {
  const f = await fixture(t);
  assert.equal(f.mission.result!.rows.some(row => row.Quellzeile === 225), false);
  const evidence = buildCaseEvidence(f.mission, f.snapshot, 225);
  assert.equal(evidence.missionId, f.mission.id);
  assert.equal(evidence.sourceRow, 225);
  assert.equal(evidence.finding.Quellzeile, 225);
  assert.equal(evidence.finding.Befund, 'Überfällig');
  assert.equal(evidence.finding['Bestellungs-ID'], '"order-225"');
  assert.equal(evidence.finding['Tage überfällig'], 3);
  assert.equal(evidence.finding.Klärungsgrund, '', 'overdue alone is actionable');
  assert.deepEqual(evidence.source, f.from.source);
  assert.deepEqual(evidence.targetSource, f.to.source);
  assert.deepEqual(evidence.relationship, f.mission.plan!.relationship);
  assert.equal(evidence.capabilityVersion, ORDER_REVIEW_VERSION);
  assert.equal(evidence.orderKeyField, 'id');
  assert.deepEqual(evidence.binding, binding);
  assert.deepEqual(evidence.orderRule, orderRule);
  assert.equal(evidence.orderRuleHash, f.mission.result!.evidence.orderRuleHash);
  assert.equal(evidence.executedAt, f.mission.result!.evidence.executedAt);
  assert.deepEqual(validateCaseEvidence(evidence), evidence);
});

test('clean open and closed rows are rejected while clarification remains actionable regardless of order status', async t => {
  const f = await fixture(t);
  assert.throws(() => buildCaseEvidence(f.mission, f.snapshot, 226), /weder überfällig/);
  assert.throws(() => buildCaseEvidence(f.mission, f.snapshot, 227), /weder überfällig/);
  for (const [sourceRow, label] of [[228, 'Abgeschlossen'], [229, 'Offen'], [230, 'Nicht beurteilbar'], [231, 'Nicht beurteilbar']] as const) {
    const evidence = buildCaseEvidence(f.mission, f.snapshot, sourceRow);
    assert.equal(evidence.finding.Befund, label);
    assert(String(evidence.finding.Klärungsgrund).trim().length > 0);
  }
  assert.equal(buildCaseEvidence(f.mission, f.snapshot, 231).finding['Bestellungs-ID'], null,
    'a source position may evidence a clarification; it never becomes an invented business identity');
});

test('full finding access leaves the standard result limit, counts, order and inputs unchanged', async t => {
  const f = await fixture(t);
  const untouched = structuredClone({ mission: f.mission, snapshot: f.snapshot });
  const before = reviewOrders(f.snapshot.detail, f.snapshot.fromRows, binding, orderRule);
  const complete = reviewOrders(f.snapshot.detail, f.snapshot.fromRows, binding, orderRule, f.snapshot.fromRows.length);
  assert.equal(complete.rows.length, 231);
  assert.equal(complete.truncated, false);
  assert.deepEqual(complete.counts, expectedCounts);
  assert.deepEqual(complete.rows.slice(0, 100), before.rows);
  const evidence = buildCaseEvidence(f.mission, f.snapshot, 225);
  const page = listCaseFindings(f.mission, f.snapshot, { offset: 200, limit: 100 });
  evidence.source.columns.push('changed');
  evidence.finding.Befund = 'changed';
  evidence.orderRule.openStatuses.push('changed');
  page.items[0]!.Befund = 'changed';
  assert.deepEqual({ mission: f.mission, snapshot: f.snapshot }, untouched);
  assert.deepEqual(reviewOrders(f.snapshot.detail, f.snapshot.fromRows, binding, orderRule), before);
  for (const invalid of [-1, 100_001, 1.5, NaN, Infinity]) {
    assert.throws(() => reviewOrders(f.snapshot.detail, f.snapshot.fromRows, binding, orderRule, invalid));
  }
});

test('invalid source positions and pagination cannot expose an unintended row', async t => {
  const f = await fixture(t);
  for (const sourceRow of [0, -1, 232, 1.5, NaN, Infinity, '225', null]) {
    assert.throws(() => buildCaseEvidence(f.mission, f.snapshot, sourceRow as number));
  }
  for (const options of [{ offset: -1 }, { offset: 0.5 }, { offset: Infinity }, { offset: null },
    { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: null }, { limit: '10' }, { extra: true }, null, []]) {
    assert.throws(() => listCaseFindings(f.mission, f.snapshot, options as CaseFindingsOptions));
  }
});

test('every single-row and page read reproduces completed confirmation and stored result receipts', async t => {
  const f = await fixture(t);
  const mutations: Array<(mission: Mission) => void> = [
    mission => { mission.status = 'running'; },
    mission => { mission.phase = 'plan'; },
    mission => { mission.plan!.capabilityId = 'relationship_integrity'; },
    mission => { mission.plan!.capabilityVersion = 'order-review-v999'; },
    mission => { mission.input!.confirmed = false as true; },
    mission => { mission.input!.orderRule!.asOf = '2026-09-24'; },
    mission => { mission.result!.counts.overdueRows--; },
    mission => { mission.result!.rows[0]!.Befund = 'Abgeschlossen'; },
    mission => { mission.result!.rows = mission.result!.rows.slice(0, 20); },
    mission => { mission.result!.summary = 'Unverified result claim'; },
    mission => { mission.result!.evidence.orderRuleHash = '0'.repeat(64); },
    mission => { mission.result!.evidence.targetSourceHash = '0'.repeat(64); },
    mission => { mission.plan!.relationship!.fromSnapshotHash = '0'.repeat(64); },
    mission => { mission.ownerId = 'another-owner'; },
    mission => { mission.tenantId = 'another-firm'; },
  ];
  for (const mutate of mutations) {
    const mission = structuredClone(f.mission);
    mutate(mission);
    assert.throws(() => buildCaseEvidence(mission, f.snapshot, 225), String(mutate));
    assert.throws(() => listCaseFindings(mission, f.snapshot), String(mutate));
  }
});

test('truncated or changed source data cannot authorize a finding beyond the old preview', async t => {
  const f = await fixture(t);
  const mutations: Array<(snapshot: CaseSnapshot) => void> = [
    snapshot => { snapshot.fromRows[224]!.status = 'Erledigt'; },
    snapshot => { snapshot.fromRows = snapshot.fromRows.slice(0, 100); },
    snapshot => { snapshot.detail.rows = snapshot.detail.rows.slice(0, 100); snapshot.detail.truncated = true; },
    snapshot => { snapshot.detail.from.source.capturedAt = '2026-09-23T00:00:00.000Z'; },
    snapshot => { snapshot.detail.to.snapshotHash = '0'.repeat(64); },
    snapshot => { snapshot.detail.relationship.counts.linkedRows--; },
  ];
  for (const mutate of mutations) {
    const snapshot = structuredClone(f.snapshot);
    mutate(snapshot);
    assert.throws(() => buildCaseEvidence(f.mission, snapshot, 225), String(mutate));
    assert.throws(() => listCaseFindings(f.mission, snapshot), String(mutate));
  }
});

test('persisted evidence rejects malformed fields, rules and mismatched source or supplier receipts', async t => {
  const f = await fixture(t);
  const original = buildCaseEvidence(f.mission, f.snapshot, 225);
  const mutations: Array<(evidence: CaseEvidence) => void> = [
    evidence => { Object.assign(evidence, { hiddenCommand: 'ignored' }); },
    evidence => { evidence.sourceRow = 0; },
    evidence => { evidence.sourceRow = 232; },
    evidence => { evidence.sourceRow = 224; },
    evidence => { evidence.missionId = 'invalid-id'; },
    evidence => { evidence.source.coverage = 'partial' as 'complete'; },
    evidence => { evidence.source.hash = '0'.repeat(64); },
    evidence => { evidence.targetSource.hash = '0'.repeat(64); },
    evidence => { evidence.relationship.toSnapshotHash = ''; },
    evidence => { evidence.relationship.fromField = 'not-a-column'; },
    evidence => { evidence.capabilityVersion = 'order-review-v999' as 'order-review-v1'; },
    evidence => { evidence.orderKeyField = 'status'; },
    evidence => { evidence.orderKeyField = 'not-a-column'; },
    evidence => { evidence.orderRule.openStatuses = ['Invented']; },
    evidence => { evidence.orderRuleHash = '0'.repeat(64); },
    evidence => { evidence.executedAt = 'yesterday'; },
    evidence => { evidence.finding.Befund = 'Offen'; evidence.finding.Klärungsgrund = ''; },
    evidence => { evidence.finding['Bestellungs-ID'] = '{"not":"primitive"}'; },
    evidence => { evidence.finding.Zielzeilen = '2'; },
    evidence => { evidence.finding.Zieltreffer = 0; },
    evidence => { evidence.finding['Zielbeleg gekürzt'] = true; },
    evidence => { evidence.finding['Tage überfällig'] = 0; },
  ];
  for (const mutate of mutations) {
    const evidence = structuredClone(original);
    mutate(evidence);
    assert.throws(() => validateCaseEvidence(evidence), String(mutate));
  }
  const copy = validateCaseEvidence(original);
  copy.source.columns.push('mutation');
  copy.finding.Befund = 'mutation';
  assert.deepEqual(original, buildCaseEvidence(f.mission, f.snapshot, 225));
});

test('live source deletion, same-ID replacement and semantic restart preserve case evidence and all pages', async t => {
  const f = await fixture(t);
  const evidence = buildCaseEvidence(f.mission, f.snapshot, 225);
  const page = listCaseFindings(f.mission, f.snapshot, { offset: 200, limit: 100 });
  await f.dataset.deleteDataset(f.source.id);
  await f.dataset.deleteDataset(f.target.id);
  const replacement = await f.dataset.registerInlineDataset({ name: 'Synthetic orders', namespace: 'cases-reference',
    rows: [{ id: 'replacement', supplier: 'S', status: 'Erledigt', due: '2026-09-20' }] });
  assert.equal(replacement.id, f.source.id);
  const restarted = createSemanticModelService(f.options);
  const frozen = await restarted.relationshipSnapshotForMission(principal, f.mission.relationshipId!);
  assert.deepEqual(buildCaseEvidence(f.mission, frozen, 225), evidence);
  assert.deepEqual(listCaseFindings(f.mission, frozen, { offset: 200, limit: 100 }), page);
  assert.deepEqual(f.mission.result!.counts, expectedCounts);
});
