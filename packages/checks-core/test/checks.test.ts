import { describe, expect, it } from 'vitest';
import { evaluateRule } from '../src/evaluator.js';
import type { DataRow } from '../src/types.js';

const ROWS: DataRow[] = [
  { id: '1', name: 'Alice', dept: 'eng', salary: 90000 },
  { id: '2', name: 'Bob', dept: 'eng', salary: 75000 },
  { id: '3', name: null, dept: 'hr', salary: 60000 },
  { id: '1', name: 'Dave', dept: 'hr', salary: -500 },
];

describe('check evaluator', () => {
  it('not_null passes when no nulls', () => {
    const result = evaluateRule(ROWS, { id: 'r1', ruleType: 'not_null', column: 'dept' });
    expect(result.passed).toBe(true);
    expect(result.failureCount).toBe(0);
  });

  it('not_null fails when nulls present', () => {
    const result = evaluateRule(ROWS, { id: 'r1', ruleType: 'not_null', column: 'name' });
    expect(result.passed).toBe(false);
    expect(result.failureCount).toBe(1);
  });

  it('unique fails on duplicate id', () => {
    const result = evaluateRule(ROWS, { id: 'r2', ruleType: 'unique', column: 'id' });
    expect(result.passed).toBe(false);
    expect(result.failureCount).toBe(1);
  });

  it('unique passes for unique column', () => {
    const result = evaluateRule(ROWS, { id: 'r2', ruleType: 'unique', column: 'salary' });
    expect(result.passed).toBe(true);
  });

  it('in_range fails for out-of-range', () => {
    const result = evaluateRule(ROWS, {
      id: 'r3', ruleType: 'in_range', column: 'salary',
      params: { min: 0, max: 200000 },
    });
    expect(result.passed).toBe(false);
    expect(result.failureCount).toBe(1);
  });

  it('in_range passes when all in range', () => {
    const result = evaluateRule(ROWS, {
      id: 'r3', ruleType: 'in_range', column: 'salary',
      params: { min: -1000, max: 200000 },
    });
    expect(result.passed).toBe(true);
  });

  it('allowed_values passes for valid', () => {
    const result = evaluateRule(ROWS, {
      id: 'r4', ruleType: 'allowed_values', column: 'dept',
      params: { values: ['eng', 'hr'] },
    });
    expect(result.passed).toBe(true);
  });

  it('allowed_values fails for invalid', () => {
    const result = evaluateRule(ROWS, {
      id: 'r4', ruleType: 'allowed_values', column: 'dept',
      params: { values: ['eng'] },
    });
    expect(result.passed).toBe(false);
    expect(result.failureCount).toBe(2);
  });

  it('min_rows passes', () => {
    const result = evaluateRule(ROWS, { id: 'r5', ruleType: 'min_rows', params: { min: 3 } });
    expect(result.passed).toBe(true);
  });

  it('min_rows fails', () => {
    const result = evaluateRule(ROWS, { id: 'r5', ruleType: 'min_rows', params: { min: 10 } });
    expect(result.passed).toBe(false);
  });
});
