import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { FileDatasetRegistry, parseCsvRowsStrict } from '@koiforge/data-registry';
import type { SessionContext } from '@koiforge/security-core';
import type { ImportRow } from '../src/import-capability/isolated-executor.js';
import { reviewOrders, type OrderReviewBinding, type OrderReviewRule } from '../src/domain/orders/review.js';
import type { RelationshipRow } from '../src/semantic-model/contracts.js';
import { createSemanticModelService } from '../src/semantic-model/service.js';

// The expected file is authored from the agreed business examples, independently
// of the classifier. This test maps its vocabulary; it does not implement another
// copy of the production classification or priority algorithm.
interface ExpectedRow {
  sourceRow: number;
  classification: 'overdue' | 'open' | 'closed' | 'unassessable';
  relationship: RelationshipRow['status'];
  dateAssessment?: 'past' | 'today' | 'future' | 'missing' | 'invalid' | 'not_assessed';
  clarification?: string[];
  targetRows?: number[];
}
interface ExpectedCounts {
  sourceRows: number; overdue: number; open: number; closed: number;
  unassessable: number; clarificationRows: number; openRowsWithoutAssessableDate: number;
}
interface Expected {
  binding: OrderReviewBinding; orderRule: OrderReviewRule;
  counts: ExpectedCounts;
  relationshipCounts: Record<string, number>;
  prioritySourceRows: number[];
  rows: ExpectedRow[];
  withoutDueDate: {
    binding: OrderReviewBinding; orderRule: OrderReviewRule;
    counts: Omit<ExpectedCounts, 'clarificationRows' | 'openRowsWithoutAssessableDate'>;
    openSourceRows: number[];
  };
}
const examples = new URL('../../../examples/order-review/', import.meta.url);
const reference: Expected = JSON.parse(await readFile(new URL('expected.json', examples), 'utf8'));
const typed: { binding: OrderReviewBinding; orderRule: OrderReviewRule; orders: ImportRow[];
  suppliers: ImportRow[]; rows: ExpectedRow[]; prioritySourceRows: number[]; counts: ExpectedCounts } =
  JSON.parse(await readFile(new URL('typed-cases.json', examples), 'utf8'));
const labels = { overdue: 'Überfällig', open: 'Offen', closed: 'Abgeschlossen', unassessable: 'Nicht beurteilbar' };
const owner: SessionContext = {
  user: { id: 'orders-reference-owner', displayName: 'Synthetic reference owner' },
  tenant: { id: 'orders-reference-firm', name: 'Synthetic reference firm', slug: 'orders-reference-firm', status: 'active' },
  roleIds: ['owner'], permissions: ['datasets.read', 'datasets.manage'],
};
const principal = { ownerId: owner.user.id, tenantId: owner.tenant.id };

async function fixture(t: TestContext, orders: ImportRow[], suppliers: ImportRow[],
  fields = { orderKey: 'bestell_id', supplierKey: 'lieferant_id', reference: 'lieferant_id' }) {
  const root = await mkdtemp(join(tmpdir(), 'koi-orders-reference-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataset = new FileDatasetRegistry({ filePath: join(root, 'datasets.json') });
  const options = {
    root, registries: { dataset },
    async resolvePrincipal(reference: { userId: string; tenantId: string }) {
      return reference.userId === owner.user.id && reference.tenantId === owner.tenant.id ? structuredClone(owner) : null;
    },
    assertPermissions(session: SessionContext, permissions: string[]) {
      assert(permissions.every(permission => session.permissions.includes(permission)));
    },
  };
  const semantic = createSemanticModelService(options);
  async function importSet(name: string, rows: ImportRow[], keyField: string) {
    const imported = await dataset.registerInlineDataset({ name, namespace: 'order-reference', rows });
    const objectSet = await semantic.createObjectSet(owner, {
      name, datasetId: imported.id, keyField, confirmed: true, requestId: randomUUID(),
    });
    return { imported, objectSet };
  }
  const from = await importSet('Synthetic orders', orders, fields.orderKey);
  const to = await importSet('Synthetic suppliers', suppliers, fields.supplierKey);
  const relationship = await semantic.createRelationship(owner, {
    name: 'Synthetic supplier of order', fromSetId: from.objectSet.id, toSetId: to.objectSet.id,
    fromField: fields.reference, confirmed: true, requestId: randomUUID(),
  });
  return { dataset, options, semantic, relationship, from, to };
}

async function csvFixture(t: TestContext) {
  const orders = parseCsvRowsStrict(await readFile(new URL('bestellungen.csv', examples), 'utf8'), ',');
  const suppliers = parseCsvRowsStrict(await readFile(new URL('lieferanten.csv', examples), 'utf8'), ',');
  return { ...await fixture(t, orders, suppliers), orders, suppliers };
}

function expectedCounts(counts: ExpectedCounts) {
  return {
    sourceRows: counts.sourceRows, overdueRows: counts.overdue, openRows: counts.open,
    closedRows: counts.closed, unassessableRows: counts.unassessable,
    clarificationRows: counts.clarificationRows, deadlineUnassessableRows: counts.openRowsWithoutAssessableDate,
  };
}

test('independent CSV business examples match every finding, date assessment, clarification and priority', async t => {
  const f = await csvFixture(t);
  const snapshot = await f.semantic.relationshipSnapshotForMission(principal, f.relationship.id);
  assert.deepEqual(snapshot.detail.relationship.counts, reference.relationshipCounts);
  const result = reviewOrders(snapshot.detail, snapshot.fromRows, reference.binding, reference.orderRule);
  assert.deepEqual(result.counts, expectedCounts(reference.counts));
  assert.equal(result.totalRows, 40);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.rows.map(row => row.Quellzeile), reference.prioritySourceRows);
  for (const expected of reference.rows) {
    const row = result.rows.find(row => row.Quellzeile === expected.sourceRow)!;
    const relation = snapshot.detail.rows.find(row => row.sourceRow === expected.sourceRow)!;
    assert(row, `missing reference source row ${expected.sourceRow}`);
    assert.equal(row.Befund, labels[expected.classification], `finding at source row ${expected.sourceRow}`);
    assert.equal(relation.status, expected.relationship, `supplier at source row ${expected.sourceRow}`);
    assert.equal(Boolean(row.Klärungsgrund), Boolean(expected.clarification?.length), `clarification at source row ${expected.sourceRow}`);
    assert.equal(row.Originalstatus, f.orders[expected.sourceRow - 1]!.status);
    if (expected.dateAssessment === 'past') assert(Number(row['Tage überfällig']) > 0);
    if (expected.dateAssessment === 'today') assert.match(String(row.Terminbeurteilung), /Am Stichtag .* fällig; noch nicht überfällig/);
    if (expected.dateAssessment === 'future') assert.match(String(row.Terminbeurteilung), /nach dem Stichtag/);
    if (expected.dateAssessment === 'not_assessed') {
      assert.equal(row['Tage überfällig'], null);
      assert.match(String(row.Terminbeurteilung), /^Nicht geprüft:/);
    }
    if (expected.dateAssessment === 'invalid' || expected.dateAssessment === 'missing') {
      assert.equal(row['Tage überfällig'], null);
      assert.equal(row.Terminbeurteilung, 'Nicht beurteilbar');
    }
  }
  assert.equal(f.orders[22]!.bestell_id, '001');
  assert.equal(f.orders[23]!.bestell_id, '1');
  assert.equal(typeof f.orders[23]!.bestell_id, 'string', 'CSV digit cells retain their textual type');
  assert.equal(result.rows.find(row => row.Quellzeile === 38)!.Befund, 'Nicht beurteilbar', 'instruction-like source text is an ordinary unknown status');
});

test('reference outcome survives deletion, reimport under the same dataset ID, and semantic service restart', async t => {
  const f = await csvFixture(t);
  const snapshot = await f.semantic.relationshipSnapshotForMission(principal, f.relationship.id);
  const original = reviewOrders(snapshot.detail, snapshot.fromRows, reference.binding, reference.orderRule);
  await f.dataset.deleteDataset(f.from.imported.id);
  await f.dataset.deleteDataset(f.to.imported.id);
  const replacement = await f.dataset.registerInlineDataset({
    name: 'Synthetic orders', namespace: 'order-reference',
    rows: [{ bestell_id: 'replacement', lieferant_id: 'replacement', status: 'Erledigt', zugesagter_liefertag: '2026-01-01' }],
  });
  assert.equal(replacement.id, f.from.imported.id);
  const restarted = createSemanticModelService(f.options);
  const retained = await restarted.relationshipSnapshotForMission(principal, f.relationship.id);
  assert.deepEqual(retained, snapshot);
  assert.deepEqual(reviewOrders(retained.detail, retained.fromRows, reference.binding, reference.orderRule), original);
});

test('without a confirmed promised day the same examples have no overdue claims', async t => {
  const f = await csvFixture(t);
  const snapshot = await f.semantic.relationshipSnapshotForMission(principal, f.relationship.id);
  const alternative = reference.withoutDueDate;
  const result = reviewOrders(snapshot.detail, snapshot.fromRows, alternative.binding, alternative.orderRule);
  assert.deepEqual(result.counts, {
    sourceRows: 40, overdueRows: 0, openRows: 24, closedRows: 4,
    unassessableRows: 12, clarificationRows: 38, deadlineUnassessableRows: 24,
  });
  assert.deepEqual(result.rows.filter(row => row.Befund === 'Offen').map(row => row.Quellzeile), alternative.openSourceRows);
  for (const row of result.rows) {
    assert.equal(row['Tage überfällig'], null, 'unconfirmed source dates cannot produce deadline claims');
    assert.equal(row.Liefertermin, null);
    if (row.Befund === 'Offen') assert.equal(row.Terminbeurteilung, 'Nicht beurteilbar');
  }
});

test('direct typed examples distinguish numeric, text and boolean identities and reject non-text status meaning', async t => {
  const f = await fixture(t, typed.orders, typed.suppliers, { orderKey: 'id', supplierKey: 'id', reference: 'ref' });
  const snapshot = await f.semantic.relationshipSnapshotForMission(principal, f.relationship.id);
  const result = reviewOrders(snapshot.detail, snapshot.fromRows, typed.binding, typed.orderRule);
  assert.deepEqual(result.counts, expectedCounts(typed.counts));
  assert.deepEqual(result.rows.map(row => row.Quellzeile), typed.prioritySourceRows);
  for (const expected of typed.rows) {
    const row = result.rows.find(row => row.Quellzeile === expected.sourceRow)!;
    const relation = snapshot.detail.rows.find(row => row.sourceRow === expected.sourceRow)!;
    assert.equal(row.Befund, labels[expected.classification], `typed row ${expected.sourceRow}`);
    assert.equal(relation.status, expected.relationship);
    assert.deepEqual(relation.targetRows, expected.targetRows);
    assert.equal(row['Bestellungs-ID'], JSON.stringify(typed.orders[expected.sourceRow - 1]!.id));
    assert.equal(row.Lieferantenreferenz, JSON.stringify(typed.orders[expected.sourceRow - 1]!.ref));
  }
});

test('an unknown status beyond both normal preview limits is counted and prioritized from the complete frozen source', async t => {
  const orders: ImportRow[] = Array.from({ length: 225 }, (_, index) => ({
    id: `synthetic-${index + 1}`, ref: 'supplier', status: index === 224 ? 'Unconfirmed final status' : 'Offen', due: '2026-09-23',
  }));
  const f = await fixture(t, orders, [{ id: 'supplier' }], { orderKey: 'id', supplierKey: 'id', reference: 'ref' });
  const ordinary = await f.semantic.getRelationship(owner, f.relationship.id);
  assert.equal(ordinary.rows.length, 100);
  const snapshot = await f.semantic.relationshipSnapshotForMission(principal, f.relationship.id);
  assert.equal(snapshot.detail.rows.length, 225);
  const result = reviewOrders(snapshot.detail, snapshot.fromRows, typed.binding, typed.orderRule);
  assert.deepEqual(result.counts, { sourceRows: 225, overdueRows: 0, openRows: 224, closedRows: 0,
    unassessableRows: 1, clarificationRows: 1, deadlineUnassessableRows: 0 });
  assert.equal(result.totalRows, 225);
  assert.equal(result.rows.length, 100);
  assert.equal(result.truncated, true);
  assert.equal(result.rows[0]!.Quellzeile, 225);
  assert.equal(result.rows[0]!.Befund, 'Nicht beurteilbar');
  assert.throws(() => reviewOrders(ordinary, snapshot.fromRows, typed.binding, typed.orderRule), /vollständigen/);
});
