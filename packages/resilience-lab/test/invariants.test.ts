import { describe, expect, it } from 'vitest';

import { evaluateInvariants } from '../src/invariants.js';
import type { ResilienceSnapshot, ScenarioInvariant } from '../src/types.js';

function makeSnapshot(metrics: Record<string, number | boolean>): ResilienceSnapshot {
  return { metrics, samples: { supplierPreview: [], supplierObjects: [], orderObjects: [] } };
}

function makeInvariant(overrides: Partial<ScenarioInvariant> = {}): ScenarioInvariant {
  return {
    id: 'test-invariant',
    kind: 'hard',
    metric: 'supplier_preview_rows',
    operator: '>=',
    expected: 10,
    description: 'Test invariant',
    ...overrides,
  };
}

describe('evaluateInvariants', () => {
  it('passes >= when observed meets threshold', () => {
    const [result] = evaluateInvariants(
      makeSnapshot({ supplier_preview_rows: 10 }),
      [makeInvariant({ operator: '>=', expected: 10 })],
    );
    expect(result?.passed).toBe(true);
    expect(result?.observed).toBe(10);
  });

  it('fails >= when observed is below threshold', () => {
    const [result] = evaluateInvariants(
      makeSnapshot({ supplier_preview_rows: 9 }),
      [makeInvariant({ operator: '>=', expected: 10 })],
    );
    expect(result?.passed).toBe(false);
  });

  it('passes <= when observed is within limit', () => {
    const [result] = evaluateInvariants(
      makeSnapshot({ orphan_count: 0 }),
      [makeInvariant({ metric: 'orphan_count', operator: '<=', expected: 2 })],
    );
    expect(result?.passed).toBe(true);
  });

  it('fails <= when observed exceeds limit', () => {
    const [result] = evaluateInvariants(
      makeSnapshot({ orphan_count: 5 }),
      [makeInvariant({ metric: 'orphan_count', operator: '<=', expected: 2 })],
    );
    expect(result?.passed).toBe(false);
  });

  it('passes == for exact numeric match', () => {
    const [result] = evaluateInvariants(
      makeSnapshot({ supplier_missing_id_count: 0 }),
      [makeInvariant({ metric: 'supplier_missing_id_count', operator: '==', expected: 0 })],
    );
    expect(result?.passed).toBe(true);
  });

  it('fails == for mismatched numeric value', () => {
    const [result] = evaluateInvariants(
      makeSnapshot({ supplier_missing_id_count: 1 }),
      [makeInvariant({ metric: 'supplier_missing_id_count', operator: '==', expected: 0 })],
    );
    expect(result?.passed).toBe(false);
  });

  it('passes == for boolean true metric', () => {
    const [result] = evaluateInvariants(
      makeSnapshot({ detail_probe_success: true }),
      [makeInvariant({ metric: 'detail_probe_success', operator: '==', expected: true })],
    );
    expect(result?.passed).toBe(true);
  });

  it('passes != when observed differs', () => {
    const [result] = evaluateInvariants(
      makeSnapshot({ detail_probe_success: false }),
      [makeInvariant({ metric: 'detail_probe_success', operator: '!=', expected: true })],
    );
    expect(result?.passed).toBe(true);
  });

  it('fails != when observed matches expected', () => {
    const [result] = evaluateInvariants(
      makeSnapshot({ detail_probe_success: true }),
      [makeInvariant({ metric: 'detail_probe_success', operator: '!=', expected: true })],
    );
    expect(result?.passed).toBe(false);
  });

  it('returns observed=null and fails when metric is missing from snapshot', () => {
    const [result] = evaluateInvariants(
      makeSnapshot({}),
      [makeInvariant({ metric: 'nonexistent_metric', operator: '>=', expected: 0 })],
    );
    expect(result?.observed).toBeNull();
    expect(result?.passed).toBe(false);
  });

  it('evaluates multiple invariants independently', () => {
    const results = evaluateInvariants(
      makeSnapshot({ supplier_preview_rows: 15, orphan_count: 0 }),
      [
        makeInvariant({ id: 'inv-1', metric: 'supplier_preview_rows', operator: '>=', expected: 10 }),
        makeInvariant({ id: 'inv-2', metric: 'orphan_count', operator: '==', expected: 0 }),
      ],
    );
    expect(results).toHaveLength(2);
    expect(results[0]?.passed).toBe(true);
    expect(results[1]?.passed).toBe(true);
  });

  it('preserves all invariant fields in the result', () => {
    const invariant = makeInvariant({ id: 'my-id', kind: 'diagnostic', description: 'My description' });
    const [result] = evaluateInvariants(makeSnapshot({ supplier_preview_rows: 5 }), [invariant]);
    expect(result?.id).toBe('my-id');
    expect(result?.kind).toBe('diagnostic');
    expect(result?.description).toBe('My description');
  });
});
