import { describe, expect, it } from 'vitest';
import { deriveColumns, runSteps } from '../src/runner.js';
import type { DataRow, PipelineStep } from '../src/types.js';

const ROWS: DataRow[] = [
  { id: '1', name: 'Alice', dept: 'eng', salary: 90000 },
  { id: '2', name: 'Bob', dept: 'eng', salary: 75000 },
  { id: '3', name: 'Carol', dept: 'hr', salary: 60000 },
  { id: '4', name: 'Dave', dept: 'hr', salary: 65000 },
  { id: '5', name: 'Eve', dept: 'eng', salary: null },
];

describe('pipeline runner', () => {
  it('filter eq', () => {
    const result = runSteps(ROWS, [{ type: 'filter', column: 'dept', operator: 'eq', value: 'eng' }]);
    expect(result).toHaveLength(3);
    expect(result.every((r) => r.dept === 'eng')).toBe(true);
  });

  it('filter not_null', () => {
    const result = runSteps(ROWS, [{ type: 'filter', column: 'salary', operator: 'not_null' }]);
    expect(result).toHaveLength(4);
  });

  it('filter gt', () => {
    const result = runSteps(ROWS, [{ type: 'filter', column: 'salary', operator: 'gt', value: '70000' }]);
    expect(result).toHaveLength(2);
  });

  it('select', () => {
    const result = runSteps(ROWS, [{ type: 'select', columns: ['id', 'name'] }]);
    expect(Object.keys(result[0]!)).toEqual(['id', 'name']);
    expect(result[0]!['dept']).toBeUndefined();
  });

  it('rename', () => {
    const result = runSteps(ROWS, [{ type: 'rename', from: 'salary', to: 'pay' }]);
    expect(result[0]!['pay']).toBe(90000);
    expect(result[0]!['salary']).toBeUndefined();
  });

  it('aggregate count per dept', () => {
    const steps: PipelineStep[] = [
      { type: 'aggregate', groupBy: ['dept'], aggregations: [{ column: 'id', fn: 'count', outputName: 'headcount' }] },
    ];
    const result = runSteps(ROWS, steps);
    const eng = result.find((r) => r.dept === 'eng');
    const hr = result.find((r) => r.dept === 'hr');
    expect(eng?.headcount).toBe(3);
    expect(hr?.headcount).toBe(2);
  });

  it('derive coalesce', () => {
    const result = runSteps(
      [
        { id: '1', right_value: null, canonical_value: 'DE' },
        { id: '2', right_value: 'US', canonical_value: 'United States' },
        { id: '3', right_value: '', canonical_value: null },
      ],
      [
        {
          type: 'derive',
          column: 'resolved_key',
          expression: { op: 'coalesce', columns: ['right_value', 'canonical_value'], fallback: 'UNKNOWN' },
        },
      ],
    );

    expect(result.map((row) => row.resolved_key)).toEqual(['DE', 'US', 'UNKNOWN']);
  });

  it('distinct by selected columns', () => {
    const result = runSteps(
      [
        { id: '1', code: 'DE', label: 'Germany' },
        { id: '2', code: 'DE', label: 'Deutschland' },
        { id: '3', code: 'US', label: 'United States' },
      ],
      [{ type: 'distinct', columns: ['code'] }],
    );

    expect(result).toHaveLength(2);
    expect(result.map((row) => row.code)).toEqual(['DE', 'US']);
  });

  it('aggregate sum salary', () => {
    const steps: PipelineStep[] = [
      { type: 'filter', column: 'salary', operator: 'not_null' },
      { type: 'aggregate', groupBy: ['dept'], aggregations: [{ column: 'salary', fn: 'sum', outputName: 'total_salary' }] },
    ];
    const result = runSteps(ROWS, steps);
    const eng = result.find((r) => r.dept === 'eng');
    expect(eng?.total_salary).toBe(165000);
  });

  it('join inner', () => {
    const left: DataRow[] = [
      { orderId: 'O1', supplierId: 'S1', value: 1000 },
      { orderId: 'O2', supplierId: 'S2', value: 2000 },
      { orderId: 'O3', supplierId: 'S3', value: 500 },
    ];
    const right: DataRow[] = [
      { supplierId: 'S1', supplierName: 'Alpha Corp' },
      { supplierId: 'S2', supplierName: 'Beta GmbH' },
    ];
    const result = runSteps(
      left,
      [{ type: 'join', rightDatasetId: 'suppliers', leftKey: 'supplierId', rightKey: 'supplierId', mode: 'inner' }],
      () => right,
    );
    expect(result).toHaveLength(2);
    expect(result[0]!['supplierName']).toBe('Alpha Corp');
  });

  it('join left', () => {
    const left: DataRow[] = [
      { id: '1', ref: 'A' },
      { id: '2', ref: 'B' },
    ];
    const right: DataRow[] = [{ ref: 'A', label: 'Alpha' }];
    const result = runSteps(
      left,
      [{ type: 'join', rightDatasetId: 'lookup', leftKey: 'ref', rightKey: 'ref', mode: 'left' }],
      () => right,
    );
    expect(result).toHaveLength(2);
    expect(result[1]!['label']).toBeUndefined();
  });

  it('join normalizes padded string keys', () => {
    const left: DataRow[] = [
      { language_id: 1, name: 'English             ' },
      { language_id: 2, name: 'German              ' },
    ];
    const crosswalk: DataRow[] = [
      { left_value: 'English', right_value: 'US' },
      { left_value: 'German', right_value: 'DE' },
    ];

    const result = runSteps(
      left,
      [
        {
          type: 'join',
          rightDatasetId: 'language_crosswalk',
          leftKey: 'name',
          rightKey: 'left_value',
          mode: 'left',
        },
      ],
      () => crosswalk,
    );

    expect(result).toHaveLength(2);
    expect(result[0]!['right_value']).toBe('US');
    expect(result[1]!['right_value']).toBe('DE');
  });

  it('deriveColumns returns columns from later joined rows too', () => {
    const result = runSteps(
      [{ id: '1', ref: 'B' }, { id: '2', ref: 'A' }],
      [{ type: 'join', rightDatasetId: 'lookup', leftKey: 'ref', rightKey: 'ref', mode: 'left' }],
      () => [{ ref: 'A', label: 'Alpha' }],
    );

    expect(result[0]!['label']).toBeUndefined();
    expect(result[1]!['label']).toBe('Alpha');
    expect(deriveColumns(result)).toEqual(['id', 'ref', 'label']);
  });

  it('chained steps', () => {
    const steps: PipelineStep[] = [
      { type: 'filter', column: 'dept', operator: 'eq', value: 'eng' },
      { type: 'filter', column: 'salary', operator: 'not_null' },
      { type: 'select', columns: ['name', 'salary'] },
      { type: 'rename', from: 'salary', to: 'pay' },
    ];
    const result = runSteps(ROWS, steps);
    expect(result).toHaveLength(2);
    expect(Object.keys(result[0]!)).toEqual(['name', 'pay']);
  });
});
