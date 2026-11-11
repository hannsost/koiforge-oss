import assert from 'node:assert/strict';
import test from 'node:test';
import { rowsHash, type ImportRow } from '../src/import-capability/isolated-executor.js';
import { evaluateFlow, validateFlowSpec } from '../src/dataflows/engine.js';
import { DataflowError, type FlowInput, type FlowSpec } from '../src/dataflows/contracts.js';

const BASE = '11111111-1111-1111-1111-111111111111';
const RIGHT = '22222222-2222-2222-2222-222222222222';
const THIRD = '33333333-3333-3333-3333-333333333333';
const FOURTH = '44444444-4444-4444-4444-444444444444';

function input(familyId: string, rows: ImportRow[], schema: Array<{ name: string; type: string }>): FlowInput {
  return {
    source: {
      familyId,
      setId: familyId,
      revision: 1,
      name: 'fixture',
      snapshotHash: 'a'.repeat(64),
      sourceHash: rowsHash(rows),
      rowCount: rows.length,
    },
    rows,
    schema,
  };
}

function spec(overrides: Partial<FlowSpec> = {}): FlowSpec {
  return validateFlowSpec({
    name: 'Typed fixture',
    description: '',
    inputFamilyId: BASE,
    keyField: 'id',
    joins: [],
    filters: [],
    minRows: 0,
    ...overrides,
  });
}

test('validateFlowSpec rejects unknown syntax and returns a frozen detached clone', () => {
  const raw = {
    name: 'Typed fixture', description: '', inputFamilyId: BASE, keyField: 'id', joins: [], filters: [], minRows: 0,
  };
  const parsed = validateFlowSpec(raw);
  assert.notEqual(parsed, raw);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.joins));
  assert.throws(() => validateFlowSpec({ ...raw, extra: true }), (error: unknown) => error instanceof DataflowError && error.statusCode === 400);
  assert.throws(() => validateFlowSpec({ ...raw, minRows: Number.POSITIVE_INFINITY }), DataflowError);
});

test('joins use exact typed identity, preserve false and zero, and do not mutate snapshots', () => {
  const leftRows: ImportRow[] = [{ id: 10, joinKey: 0 }, { id: 11, joinKey: false }, { id: 12, joinKey: 1 }, { id: 13, joinKey: '1' }, { id: 14, joinKey: ' 1 ' }, { id: 15, joinKey: null }];
  const rightRows: ImportRow[] = [
    { rid: 0, label: 'zero' }, { rid: false, label: 'false' }, { rid: 1, label: 'number' }, { rid: '1', label: 'text' }, { rid: ' 1 ', label: 'spaced' },
  ];
  const left = input(BASE, leftRows, [{ name: 'id', type: 'number' }, { name: 'joinKey', type: 'json' }]);
  const right = input(RIGHT, rightRows, [{ name: 'rid', type: 'json' }, { name: 'label', type: 'string' }]);
  const before = structuredClone(leftRows);
  const result = evaluateFlow(spec({ joins: [{ familyId: RIGHT, leftField: 'joinKey', rightField: 'rid', fields: [{ source: 'label', target: 'label' }], required: false }] }), new Map([[BASE, left], [RIGHT, right]]));
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.rows.map(row => row.label), ['zero', 'false', 'number', 'text', 'spaced', null]);
  assert.deepEqual(leftRows, before);
});

test('required unmatched rows block, optional unmatched rows receive null, and duplicate right keys block', () => {
  const left = input(BASE, [{ id: 1 }, { id: 2 }], [{ name: 'id', type: 'number' }]);
  const right = input(RIGHT, [{ rid: 1, label: 'one' }], [{ name: 'rid', type: 'number' }, { name: 'label', type: 'string' }]);
  const optional = evaluateFlow(spec({ joins: [{ familyId: RIGHT, leftField: 'id', rightField: 'rid', fields: [{ source: 'label', target: 'label' }], required: false }] }), new Map([[BASE, left], [RIGHT, right]]));
  assert.equal(optional.status, 'ready');
  assert.equal(optional.rows[1]?.label, null);
  const required = evaluateFlow(spec({ joins: [{ familyId: RIGHT, leftField: 'id', rightField: 'rid', fields: [{ source: 'label', target: 'label' }], required: true }] }), new Map([[BASE, left], [RIGHT, right]]));
  assert.equal(required.status, 'blocked');
  assert.deepEqual(required.rows, []);
  assert.equal(required.rowCount, 0);
  assert.equal(required.outputHash, rowsHash([]));
  const duplicate = input(RIGHT, [{ rid: 1, label: 'one' }, { rid: 1, label: 'again' }], [{ name: 'rid', type: 'number' }, { name: 'label', type: 'string' }]);
  const invalid = evaluateFlow(spec({ joins: [{ familyId: RIGHT, leftField: 'id', rightField: 'rid', fields: [{ source: 'label', target: 'label' }], required: false }] }), new Map([[BASE, left], [RIGHT, duplicate]]));
  assert.equal(invalid.status, 'blocked');
  assert.ok(invalid.issues.some(issue => issue.includes('doppelt')));
});

test('filters are typed, null checks distinguish missing from blank strings, and empty schema is checked', () => {
  const rows: ImportRow[] = [{ id: 1, text: 'alpha', score: 0 }, { id: 2, text: '', score: 2 }, { id: 3, score: 3 }, { id: 4, text: null, score: 4 }];
  const source = input(BASE, rows, [{ name: 'id', type: 'number' }, { name: 'text', type: 'string' }, { name: 'score', type: 'number' }]);
  const result = evaluateFlow(spec({ filters: [{ field: 'score', operator: 'gte', value: 2 }] }), new Map([[BASE, source]]));
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.rows.map(row => row.id), [2, 3, 4]);
  const nulls = evaluateFlow(spec({ filters: [{ field: 'text', operator: 'is_null' }] }), new Map([[BASE, source]]));
  assert.equal(nulls.status, 'ready');
  assert.deepEqual(nulls.rows.map(row => row.id), [3, 4]);
  const nonNulls = evaluateFlow(spec({ filters: [{ field: 'text', operator: 'not_null' }] }), new Map([[BASE, source]]));
  assert.equal(nonNulls.status, 'ready');
  assert.deepEqual(nonNulls.rows.map(row => row.id), [1, 2]);
  const empty = input(BASE, [], [{ name: 'id', type: 'number' }]);
  const absent = evaluateFlow(spec({ filters: [{ field: 'gone', operator: 'is_null' }] }), new Map([[BASE, empty]]));
  assert.equal(absent.status, 'blocked');
  assert.equal(absent.rows.length, 0);
});

test('input snapshots are bounded to the base source plus two joins', () => {
  const empty = (familyId: string) => input(familyId, [], [{ name: 'id', type: 'number' }]);
  const result = evaluateFlow(spec(), new Map([
    [BASE, empty(BASE)], [RIGHT, empty(RIGHT)], [THIRD, empty(THIRD)], [FOURTH, empty(FOURTH)],
  ]));
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.rows, []);
  assert.ok(result.issues.some(issue => issue.includes('höchstens 3')));
});

test('bounds and reproducibility remain deterministic across three snapshots', () => {
  const source = input(BASE, [{ id: 1 }], [{ name: 'id', type: 'number' }]);
  const one = input(RIGHT, [{ rid: 1, value: 2 }], [{ name: 'rid', type: 'number' }, { name: 'value', type: 'number' }]);
  const two = input(THIRD, [{ rid: 1, value: 3 }], [{ name: 'rid', type: 'number' }, { name: 'value', type: 'number' }]);
  const plan = spec({ joins: [
    { familyId: RIGHT, leftField: 'id', rightField: 'rid', fields: [{ source: 'value', target: 'one' }], required: true },
    { familyId: THIRD, leftField: 'id', rightField: 'rid', fields: [{ source: 'value', target: 'two' }], required: true },
  ] });
  const inputs = new Map([[BASE, source], [RIGHT, one], [THIRD, two]]);
  const first = evaluateFlow(plan, inputs);
  const second = evaluateFlow(plan, inputs);
  assert.deepEqual(first, second);
  assert.equal(first.status, 'ready');
  assert.equal(first.rows[0]?.one, 2);
  assert.equal(first.rows[0]?.two, 3);
  assert.ok(first.steps.every(step => step.rowsIn <= 10_000 && step.rowsOut <= 10_000));
});

test('a label field selected by the second join remains valid and survives persistence cloning', () => {
  const source = input(BASE, [{ id: 1, firstKey: 7, labelKey: 9 }], [
    { name: 'id', type: 'number' }, { name: 'firstKey', type: 'number' }, { name: 'labelKey', type: 'number' },
  ]);
  const first = input(RIGHT, [{ rid: 7, value: 'joined' }], [
    { name: 'rid', type: 'number' }, { name: 'value', type: 'string' },
  ]);
  const second = input(THIRD, [{ rid: 9, value: 'Customer 9' }], [
    { name: 'rid', type: 'number' }, { name: 'value', type: 'string' },
  ]);
  const plan = spec({ labelField: 'customerName', joins: [
    { familyId: RIGHT, leftField: 'firstKey', rightField: 'rid', fields: [{ source: 'value', target: 'firstValue' }], required: true },
    { familyId: THIRD, leftField: 'labelKey', rightField: 'rid', fields: [{ source: 'value', target: 'customerName' }], required: true },
  ] });
  const result = evaluateFlow(plan, new Map([[BASE, source], [RIGHT, first], [THIRD, second]]));
  assert.equal(result.status, 'ready');
  assert.equal(result.rows[0]?.customerName, 'Customer 9');
  assert.deepEqual(result, structuredClone(result));
  assert.deepEqual(result, JSON.parse(JSON.stringify(result)));
});
