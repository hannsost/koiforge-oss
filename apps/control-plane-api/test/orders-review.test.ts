import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { rowsHash, type ImportRow } from '../src/import-capability/isolated-executor.js';
import type { ObjectSet, RelationshipDetail, RelationshipRow } from '../src/semantic-model/contracts.js';
import { ORDER_REVIEW_VERSION, orderReviewRuleHash, reviewOrders, validateOrderReviewInput,
  type OrderReviewBinding, type OrderReviewRule } from '../src/domain/orders/review.js';

const binding: OrderReviewBinding = { statusField: 'status', dueDateField: 'due' };
const rule: OrderReviewRule = { openStatuses: ['Offen', 'In Arbeit'], closedStatuses: ['Erledigt', 'Storniert'],
  asOf: '2026-09-23', dueDateMeaning: 'promised_delivery_day' };
const columns = ['id', 'supplier', 'status', 'due'];
const order = (id: number | string | boolean | null, extra: ImportRow = {}): ImportRow =>
  ({ id, supplier: 'L1', status: 'Offen', due: '2026-09-23', ...extra });
const key = (value: ImportRow[string] | undefined) => value === undefined || value === null || (typeof value === 'string' && !value.trim()) ? null : value;

function fixture(fromRows: ImportRow[], overrides: Record<number, Partial<RelationshipRow>> = {}): RelationshipDetail {
  const objectSet = (id: string, rows: ImportRow[]): ObjectSet => ({
    id, familyId: id, revision: 1, tenantId: 'tenant', ownerId: 'owner', name: id, keyField: 'id',
    source: { datasetId: id, name: id, columns: [...new Set([...columns, ...rows.flatMap(row => Object.keys(row))])],
      rowCount: rows.length, hash: rowsHash(rows), capturedAt: '2026-09-23T12:00:00.000Z', coverage: 'complete' },
    snapshotHash: id.repeat(64).slice(0, 64), createdAt: '2026-09-23T12:00:00.000Z', confirmedBy: 'owner',
    keyQuality: { totalRows: rows.length, identifiedRows: rows.length, missingKeys: 0, duplicateRows: 0, duplicateGroups: 0 },
  });
  const from = objectSet('orders', fromRows);
  const to = objectSet('suppliers', Array.from({ length: 10 }, (_, i) => ({ id: `L${i + 1}` })));
  const rows: RelationshipRow[] = fromRows.map((row, index) => ({
    sourceRow: index + 1, sourceKey: key(row.id), reference: key(row.supplier), status: 'linked',
    targetRows: [1], targetRowCount: 1, targetRowsTruncated: false, sourceLabel: `Bestellung ${index + 1}`, targetLabel: 'Lieferant 1',
    ...overrides[index + 1],
  }));
  return {
    from, to, rows, totalRows: fromRows.length, truncated: false, offset: 0,
    relationship: { id: 'relationship', tenantId: 'tenant', ownerId: 'owner', name: 'Bestellung hat Lieferant',
      fromSetId: from.id, toSetId: to.id, fromField: 'supplier', createdAt: '2026-09-23T12:00:00.000Z', confirmedBy: 'owner',
      cardinality: 'many-to-one', contractVersion: 'relationship-v1',
      evidence: { sourceHash: from.source.hash, targetHash: to.source.hash, fromRevision: 1, toRevision: 1 },
      counts: { sourceRows: rows.length, linkedRows: rows.filter(row => row.status === 'linked').length,
        missingReferences: rows.filter(row => row.status === 'missing_reference').length,
        unmatchedReferences: rows.filter(row => row.status === 'unmatched_reference').length,
        ambiguousReferences: rows.filter(row => row.status === 'ambiguous_reference').length,
        invalidSourceRows: rows.filter(row => row.status === 'invalid_source_key').length },
    },
  };
}
const noTarget = (status: 'invalid_source_key' | 'missing_reference' | 'unmatched_reference'): Partial<RelationshipRow> =>
  ({ status, targetRows: [], targetRowCount: 0, targetRowsTruncated: false, targetLabel: undefined });

test('order review validates exact confirmed fields and preserves exact status strings', () => {
  const original = { ...rule, openStatuses: [' offen ', 'Offen', 'offen'] };
  const accepted = validateOrderReviewInput(binding, original, columns, 'id');
  assert.equal(ORDER_REVIEW_VERSION, 'order-review-v1');
  assert.deepEqual(accepted.orderRule.openStatuses, [' offen ', 'Offen', 'offen']);
  assert.notEqual(accepted.orderRule.openStatuses, original.openStatuses);
  assert.deepEqual(validateOrderReviewInput(binding, { ...rule, closedStatuses: [] }, columns, 'id').orderRule.closedStatuses, []);
  assert.deepEqual(validateOrderReviewInput(binding, { ...rule, openStatuses: [] }, columns, 'id').orderRule.openStatuses, []);
  for (const bad of [null, {}, [], { ...rule, extra: true }, { ...rule, openStatuses: [], closedStatuses: [] },
    { ...rule, openStatuses: ['Offen', 'Offen'] }, { ...rule, openStatuses: ['Erledigt'] }, { ...rule, openStatuses: Array(1) },
    { ...rule, closedStatuses: ['Storniert', 'Storniert'] }, { ...rule, openStatuses: [1] },
    { ...rule, openStatuses: [' \t'] }, { ...rule, closedStatuses: [''] },
    { ...rule, openStatuses: ['a'.repeat(201)] }, { ...rule, openStatuses: Array.from({ length: 51 }, (_, i) => String(i)) },
    { ...rule, dueDateMeaning: 'estimated_delivery_day' }, { ...rule, dueDateMeaning: 'not_available' }]) {
    assert.throws(() => validateOrderReviewInput(binding, bad, columns, 'id'));
  }
  for (const bad of [{}, [], { ...binding, unknown: 'id' }, { ...binding, keyField: 'id' },
    { statusField: 'unknown', dueDateField: 'due' }, { statusField: 'id', dueDateField: 'due' },
    { statusField: 'status', dueDateField: 'id' }, { statusField: 'status', dueDateField: 'status' },
    { statusField: 'status' }, { statusField: 'status', dueDateField: null }, Object.create(binding)]) {
    assert.throws(() => validateOrderReviewInput(bad, rule, columns, 'id'));
  }
  assert.throws(() => validateOrderReviewInput(binding, rule, columns, 'missing-id'));
  const boundaryRule = { ...rule, openStatuses: Array.from({ length: 50 }, (_, i) => `${i}:${'a'.repeat(197)}`) };
  assert.equal(validateOrderReviewInput(binding, boundaryRule, columns, 'id').orderRule.openStatuses.length, 50);
});

test('calendar rules reject rollovers, timezones, whitespace and invalid leap days', () => {
  for (const asOf of ['2026-02-29', '1900-02-29', '2100-02-29', '2026-04-31', '2026-00-01', '2026-13-01',
    '2026-01-00', '2026-01-32', '2026-9-23', '2026-09-23T00:00:00Z', '23.09.2026', ' 2026-09-23',
    '2026-09-23 ', '2026-09-23\n', '0999-12-31', '0000-01-01', '10000-01-01', 20260923, null]) {
    assert.throws(() => validateOrderReviewInput(binding, { ...rule, asOf }, columns, 'id'), String(asOf));
  }
  for (const asOf of ['1000-01-01', '9999-12-31', '2000-02-29', '2024-02-29', '2400-02-29']) {
    assert.equal(validateOrderReviewInput(binding, { ...rule, asOf }, columns, 'id').orderRule.asOf, asOf);
  }
});

test('closed, overdue, due today and future orders are disjoint with original evidence', () => {
  const rows = [order(1, { due: '2026-09-22' }), order(2), order(3, { due: '2026-09-24' }),
    order(4, { status: 'Erledigt', due: 'not a date' }), order(5, { status: 'Storniert', due: null })];
  const result = reviewOrders(fixture(rows), rows, binding, rule);
  assert.deepEqual(result.counts, { sourceRows: 5, overdueRows: 1, openRows: 2, closedRows: 2, unassessableRows: 0,
    clarificationRows: 0, deadlineUnassessableRows: 0 });
  assert.deepEqual(result.rows.map(row => row.Befund), ['Überfällig', 'Offen', 'Offen', 'Abgeschlossen', 'Abgeschlossen']);
  assert.deepEqual(result.rows.map(row => row['Tage überfällig']), [1, 0, 0, null, null]);
  assert.equal(result.rows[3]!.Liefertermin, 'not a date');
  assert.equal(result.rows[3]!.Originalstatus, 'Erledigt');
  assert.match(String(result.rows[1]!.Terminbeurteilung), /noch nicht überfällig/);
  assert.match(String(result.rows[3]!.Terminbeurteilung), /Nicht geprüft/);
  assert.equal(result.rows[0]!.Lieferantenreferenz, '"L1"');
  assert.equal(result.rows[0]!.Zielzeilen, '1');
  assert.equal(result.rows[0]!.Lieferant, 'Lieferant 1');
  assert.deepEqual(result.columns.slice(0, 2), ['Befund', 'Klärungsgrund']);
  assert.equal(result.truncated, false);
});

test('unknown, missing, numeric and differently cased statuses are never silently normalized', () => {
  const rows = [order(1, { status: 'Offen ' }), order(2, { status: 'offen' }), order(3, { status: 'Rückstand' }),
    order(4, { status: 1 }), order(5, { status: false }), order(6, { status: null }), order(7, { status: '' }),
    { id: 8, supplier: 'L1', due: '2026-09-01' }];
  const result = reviewOrders(fixture(rows), rows, binding, rule);
  assert.equal(result.counts.unassessableRows, 8);
  assert.equal(result.counts.clarificationRows, 8);
  assert.equal(result.counts.overdueRows, 0);
  assert.equal(result.counts.deadlineUnassessableRows, 0);
  assert.deepEqual(result.rows.map(row => row.Originalstatus), ['Offen ', 'offen', 'Rückstand', 1, false, null, '', null]);
  assert.match(String(result.rows[0]!.Klärungsgrund), /Statuszuordnung/);
  assert.match(String(result.rows[3]!.Klärungsgrund), /kein Text/);
  assert.match(String(result.rows[7]!.Klärungsgrund), /fehlt/);
  const exact = reviewOrders(fixture(rows.slice(0, 2)), rows.slice(0, 2), binding, { ...rule, openStatuses: ['Offen ', 'offen'], closedStatuses: [] });
  assert.equal(exact.counts.openRows, 2);
});

test('missing or invalid deadlines keep a known order open with a specific clarification', () => {
  const invalid: ImportRow[string][] = [null, '', '  ', '2026-02-29', '1900-02-29', '2026-09-22T00:00:00Z', '23.09.2026', '2026-09-23 ', '2026-09-22\n', 0, false];
  const rows = invalid.map((due, index) => order(index + 1, { due }));
  rows.push({ id: rows.length + 1, supplier: 'L1', status: 'Offen' });
  const result = reviewOrders(fixture(rows), rows, binding, rule);
  assert.equal(result.counts.openRows, rows.length);
  assert.equal(result.counts.overdueRows, 0);
  assert.equal(result.counts.unassessableRows, 0);
  assert.equal(result.counts.clarificationRows, rows.length);
  assert.equal(result.counts.deadlineUnassessableRows, rows.length);
  assert.ok(result.rows.every(row => row.Terminbeurteilung === 'Nicht beurteilbar' && row['Tage überfällig'] === null));
  assert.match(String(result.rows[0]!.Klärungsgrund), /Liefertag fehlt/);
  assert.match(String(result.rows[3]!.Klärungsgrund), /kein gültiger Kalendertag/);
  assert.ok(!JSON.stringify(result).includes('NaN'));
  for (const row of result.rows) for (const value of Object.values(row)) if (typeof value === 'number') assert.ok(Number.isFinite(value));
});

test('unmapped due dates are explicitly unavailable and closed rows remain closed', () => {
  const rows = [order(1, { due: '1000-01-01' }), order(2, { status: 'Erledigt', due: 'broken' })];
  const result = reviewOrders(fixture(rows), rows, { statusField: 'status' }, { ...rule, dueDateMeaning: 'not_available' });
  assert.equal(result.counts.openRows, 1);
  assert.equal(result.counts.closedRows, 1);
  assert.equal(result.counts.deadlineUnassessableRows, 1);
  assert.equal(result.counts.clarificationRows, 1);
  assert.equal(result.rows[0]!.Liefertermin, null);
  assert.match(String(result.rows[0]!.Klärungsgrund), /Kein zugesagter Liefertag zugeordnet/);
  assert.throws(() => validateOrderReviewInput({ statusField: 'status', dueDateField: undefined },
    { ...rule, dueDateMeaning: 'not_available' }, columns, 'id'));
});

test('valid leap days and century boundaries produce exact finite day counts', () => {
  for (const [asOf, due, days] of [['2024-03-01', '2024-02-29', 1], ['2000-03-01', '2000-02-28', 2],
    ['1900-03-01', '1900-02-28', 1], ['1000-01-02', '1000-01-01', 1], ['9999-12-31', '9999-12-30', 1]] as const) {
    const rows = [order(1, { due })];
    const result = reviewOrders(fixture(rows), rows, binding, { ...rule, asOf });
    assert.equal(result.counts.overdueRows, 1);
    assert.equal(result.rows[0]!['Tage überfällig'], days);
  }
});

test('typed IDs remain distinct while missing and duplicate identity prevents order findings', () => {
  const rows = [order(7, { supplier: 7 }), order('7', { supplier: '7' }), order(false, { supplier: false }),
    order(0, { supplier: 0 }), order(null), order(' '), order('dup', { status: 'Erledigt' }), order('dup', { due: '2026-01-01' })];
  const result = reviewOrders(fixture(rows, { 5: noTarget('invalid_source_key'), 6: noTarget('invalid_source_key'),
    7: noTarget('invalid_source_key'), 8: noTarget('invalid_source_key') }), rows, binding, rule);
  assert.equal(result.counts.openRows, 4);
  assert.equal(result.counts.unassessableRows, 4);
  assert.equal(result.counts.closedRows, 0);
  assert.equal(result.counts.overdueRows, 0);
  assert.equal(result.counts.deadlineUnassessableRows, 0);
  const originals = [...result.rows].sort((a, b) => Number(a.Quellzeile) - Number(b.Quellzeile));
  assert.deepEqual(originals.slice(0, 4).map(row => row['Bestellungs-ID']), ['7', '"7"', 'false', '0']);
  assert.deepEqual(originals.slice(0, 4).map(row => row.Lieferantenreferenz), ['7', '"7"', 'false', '0']);
  assert.match(String(originals[4]!.Klärungsgrund), /ID fehlt/);
  assert.match(String(originals[6]!.Klärungsgrund), /Mehrfachverwendung/);
});

test('supplier clarification does not erase known order state and includes target evidence', () => {
  const rows = [order(1, { due: '2026-09-22', supplier: null }), order(2, { supplier: 'unknown' }),
    order(3, { status: 'Erledigt', supplier: 'dupe' }), order(4, { supplier: 'dupe', due: null })];
  const ambiguous: Partial<RelationshipRow> = { status: 'ambiguous_reference', targetRows: [3, 7], targetRowCount: 3,
    targetRowsTruncated: true, targetLabel: undefined };
  const result = reviewOrders(fixture(rows, { 1: noTarget('missing_reference'), 2: noTarget('unmatched_reference'),
    3: ambiguous, 4: ambiguous }), rows, binding, rule);
  assert.deepEqual(result.counts, { sourceRows: 4, overdueRows: 1, openRows: 2, closedRows: 1, unassessableRows: 0,
    clarificationRows: 4, deadlineUnassessableRows: 1 });
  assert.deepEqual(result.rows.map(row => row.Quellzeile), [1, 2, 4, 3]);
  assert.equal(result.rows[3]!.Befund, 'Abgeschlossen');
  assert.match(String(result.rows[3]!.Klärungsgrund), /3 Zielzeilen/);
  assert.equal(result.rows[3]!.Zielzeilen, '3, 7');
  assert.equal(result.rows[3]!.Zieltreffer, 3);
  assert.equal(result.rows[3]!['Zielbeleg gekürzt'], true);
  assert.equal(result.rows[3]!.Lieferant, null);
  assert.match(String(result.rows[2]!.Klärungsgrund), /Lieferantenreferenz.*Liefertag fehlt/);
});

test('priority is oldest overdue, unassessable, open needing clarification, clean open, closed with original row ties', () => {
  const rows = [order(1, { status: 'Erledigt' }), order(2), order(3, { due: null }), order(4, { status: 'unknown' }),
    order(5, { due: '2026-09-22' }), order(6, { due: '2026-01-01' }), order(7, { due: '2026-01-01' }),
    order(8, { supplier: null }), order(9, { status: 'Storniert', supplier: null })];
  const detail = fixture(rows, { 8: noTarget('missing_reference'), 9: noTarget('missing_reference') });
  detail.rows.reverse();
  const before = structuredClone({ detail, rows, binding, rule });
  const result = reviewOrders(detail, rows, binding, rule);
  assert.deepEqual(result.rows.map(row => row.Quellzeile), [6, 7, 5, 4, 3, 8, 2, 1, 9]);
  assert.deepEqual({ detail, rows, binding, rule }, before);
});

test('preview cap is applied after full-source counting and prioritization', () => {
  const rows = Array.from({ length: 175 }, (_, i) => order(i + 1, i === 174 ? { due: '2020-01-01' }
    : i >= 170 ? { status: 'unknown' } : i >= 150 ? { due: null } : {}));
  const detail = fixture(rows); detail.rows.reverse();
  const result = reviewOrders(detail, rows, binding, rule);
  assert.equal(result.totalRows, 175);
  assert.equal(result.rows.length, 100);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.counts, { sourceRows: 175, overdueRows: 1, openRows: 170, closedRows: 0, unassessableRows: 4,
    clarificationRows: 24, deadlineUnassessableRows: 20 });
  assert.deepEqual(result.rows.slice(0, 6).map(row => row.Quellzeile), [175, 171, 172, 173, 174, 151]);
  assert.equal(result.rows[99]!.Quellzeile, 75);
});

test('complete empty sources produce no false success claims', () => {
  const result = reviewOrders(fixture([]), [], binding, rule);
  assert.equal(result.totalRows, 0);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.rows, []);
  assert.ok(Object.values(result.counts).every(value => value === 0));
  assert.match(result.summary, /keine Bestellungen/);
});

test('partial, mismatched, duplicate, fabricated or corrupt source evidence is rejected', () => {
  const rows = [order(1), order(2)];
  const mutations: Array<(detail: RelationshipDetail) => void> = [
    detail => { detail.truncated = true; }, detail => { detail.offset = 1; }, detail => { detail.rows.pop(); },
    detail => { detail.totalRows++; }, detail => { detail.from.source.rowCount++; },
    detail => { detail.rows[1]!.sourceRow = 1; }, detail => { detail.rows[0]!.sourceRow = 0; },
    detail => { detail.rows[0]!.sourceRow = 1.5; }, detail => { detail.rows[0]!.sourceRow = 3; },
    detail => { detail.rows[0]!.sourceKey = '1'; }, detail => { detail.rows[0]!.reference = 'fabricated'; },
    detail => { detail.relationship.evidence.sourceHash = 'changed'; }, detail => { detail.relationship.evidence.targetHash = 'changed'; },
    detail => { detail.relationship.evidence.fromRevision++; }, detail => { detail.relationship.evidence.toRevision++; },
    detail => { detail.relationship.counts.linkedRows--; }, detail => { detail.relationship.fromSetId = 'other'; },
    detail => { detail.relationship.toSetId = 'other'; }, detail => { detail.rows[0]!.targetRows = [0]; },
    detail => { detail.rows[0]!.targetRows = [11]; }, detail => { detail.rows[0]!.targetRowCount = NaN; },
    detail => { detail.rows[0]!.targetRowsTruncated = true; }, detail => { detail.rows[0]!.targetRows = Array(1); },
  ];
  for (const mutate of mutations) {
    const detail = fixture(rows); mutate(detail);
    assert.throws(() => reviewOrders(detail, rows, binding, rule), String(mutate));
  }
  assert.throws(() => reviewOrders(fixture(rows), [order(1, { status: 'changed' }), order(2)], binding, rule));
  assert.throws(() => reviewOrders(fixture(rows), [order(1)], binding, rule));
  const notFinite = [order(1, { due: NaN })];
  assert.throws(() => reviewOrders(fixture(notFinite), notFinite, binding, rule));
});

test('prototype named status and deadline columns only read own values', () => {
  const rows: ImportRow[] = [{ id: 1, supplier: 'L1', toString: 'Offen', valueOf: '2026-09-22' },
    { id: 2, supplier: 'L1', toString: 'Offen' }, { id: 3, supplier: 'L1' }];
  const result = reviewOrders(fixture(rows), rows, { statusField: 'toString', dueDateField: 'valueOf' }, rule);
  assert.deepEqual(result.counts, { sourceRows: 3, overdueRows: 1, openRows: 1, closedRows: 0, unassessableRows: 1,
    clarificationRows: 2, deadlineUnassessableRows: 1 });
});

test('rule receipt uses canonical confirmed values and changes with each semantic input', () => {
  const rows = [order(1)];
  const result = reviewOrders(fixture(rows), rows, binding, rule);
  const expected = createHash('sha256').update(JSON.stringify({ binding: { statusField: 'status', dueDateField: 'due' },
    orderRule: { openStatuses: ['In Arbeit', 'Offen'], closedStatuses: ['Erledigt', 'Storniert'], asOf: '2026-09-23',
      dueDateMeaning: 'promised_delivery_day' } })).digest('hex');
  assert.equal(result.ruleHash, expected);
  assert.equal(orderReviewRuleHash({ dueDateField: 'due', statusField: 'status' },
    { ...rule, openStatuses: [...rule.openStatuses].reverse(), closedStatuses: [...rule.closedStatuses].reverse() }), expected);
  for (const changed of [{ ...rule, asOf: '2026-09-24' }, { ...rule, openStatuses: ['Offen '] },
    { ...rule, closedStatuses: ['Erledigt'] }, { ...rule, dueDateMeaning: 'not_available' as const }]) {
    assert.notEqual(orderReviewRuleHash(binding, changed), expected);
  }
  assert.notEqual(orderReviewRuleHash({ statusField: 'other', dueDateField: 'due' }, rule), expected);
  assert.notEqual(orderReviewRuleHash({ statusField: 'status', dueDateField: 'other' }, rule), expected);
  assert.notEqual(orderReviewRuleHash({ statusField: 'status' }, rule), expected);
});
