import { describe, expect, it } from 'vitest';

import { buildAiHandoff, buildAiHandoffMarkdown, buildTriageSummary } from '../src/triage.js';
import type {
  InvariantResult,
  RegressionCommandResult,
  ResilienceRunSummary,
  ResilienceSnapshot,
  TriageSummary,
} from '../src/types.js';

function makeSnapshot(metrics: Record<string, number | boolean> = {}): ResilienceSnapshot {
  return { metrics, samples: { supplierPreview: [], supplierObjects: [], orderObjects: [] } };
}

function makeSummary(overrides: Partial<ResilienceRunSummary> = {}): ResilienceRunSummary {
  return {
    runId: 'run-001',
    scenarioId: 'scenario-baseline',
    bundlePath: '/tmp/bundle',
    status: 'passed',
    failedInvariantIds: [],
    regressionFailed: false,
    domRegressionFailed: false,
    ...overrides,
  };
}

function makeInvariantResult(overrides: Partial<InvariantResult> = {}): InvariantResult {
  return {
    id: 'supplier_preview_rows_min',
    kind: 'hard',
    metric: 'supplier_preview_rows',
    operator: '>=',
    expected: 10,
    description: 'Enough supplier rows',
    observed: 10,
    passed: true,
    ...overrides,
  };
}

function makeRegressionResult(overrides: Partial<RegressionCommandResult> = {}): RegressionCommandResult {
  return {
    command: ['pnpm', 'test'],
    exitCode: 0,
    ok: true,
    durationMs: 500,
    ...overrides,
  };
}

describe('buildTriageSummary', () => {
  it('returns passed status with no suspect components when everything is ok', () => {
    const result = buildTriageSummary({
      summary: makeSummary({ status: 'passed' }),
      invariants: [makeInvariantResult({ passed: true })],
      before: makeSnapshot({ supplier_preview_rows: 10 }),
      after: makeSnapshot({ supplier_preview_rows: 10 }),
      regression: [makeRegressionResult({ ok: true })],
      domRegression: null,
    });

    expect(result.status).toBe('passed');
    expect(result.failedInvariantIds).toHaveLength(0);
    expect(result.topIssue).toBe('Keine kritischen Probleme erkannt.');
    expect(result.suspectComponents).toEqual(['none']);
    expect(result.domFailure).toBe(false);
    expect(result.changedMetrics).toHaveLength(0);
  });

  it('reports failing hard invariants in failedInvariantIds', () => {
    const result = buildTriageSummary({
      summary: makeSummary({ status: 'failed' }),
      invariants: [
        makeInvariantResult({ id: 'supplier_preview_rows_min', passed: false, description: 'Not enough rows' }),
      ],
      before: makeSnapshot(),
      after: makeSnapshot(),
      regression: [],
      domRegression: null,
    });

    expect(result.failedInvariantIds).toContain('supplier_preview_rows_min');
    expect(result.topIssue).toBe('Not enough rows');
    expect(result.suspectComponents).toContain('data-registry');
    expect(result.suspectComponents).toContain('object-explorer');
  });

  it('excludes diagnostic invariants from failedInvariantIds', () => {
    const result = buildTriageSummary({
      summary: makeSummary({ status: 'failed' }),
      invariants: [
        makeInvariantResult({ id: 'diag-1', kind: 'diagnostic', passed: false }),
      ],
      before: makeSnapshot(),
      after: makeSnapshot(),
      regression: [],
      domRegression: null,
    });

    expect(result.failedInvariantIds).toHaveLength(0);
    expect(result.suspectComponents).toEqual(['none']);
  });

  it('detects dom regression failure', () => {
    const result = buildTriageSummary({
      summary: makeSummary({ status: 'failed' }),
      invariants: [],
      before: makeSnapshot(),
      after: makeSnapshot(),
      regression: [],
      domRegression: makeRegressionResult({ ok: false, exitCode: 1 }),
    });

    expect(result.domFailure).toBe(true);
    expect(result.suspectComponents).toContain('console-web');
    expect(result.suspectComponents).toContain('e2e-tests');
    expect(result.recommendedFiles).toContain('apps/console-web/src/App.tsx');
    expect(result.topIssue).toBe('DOM-Regression fehlgeschlagen.');
  });

  it('adds regression command failure info', () => {
    const result = buildTriageSummary({
      summary: makeSummary({ status: 'failed' }),
      invariants: [],
      before: makeSnapshot(),
      after: makeSnapshot(),
      regression: [
        makeRegressionResult({
          command: ['pnpm', '--filter', '@koiforge/data-registry', 'test'],
          ok: false,
          exitCode: 1,
        }),
      ],
      domRegression: null,
    });

    expect(result.regressionFailures).toHaveLength(1);
    expect(result.suspectComponents).toContain('@koiforge/data-registry');
    expect(result.recommendedFiles.some((f) => f.includes('data-registry'))).toBe(true);
    expect(result.topIssue).toMatch(/Regression fehlgeschlagen/);
  });

  it('computes changed metrics between before and after snapshots', () => {
    const result = buildTriageSummary({
      summary: makeSummary(),
      invariants: [],
      before: makeSnapshot({ supplier_preview_rows: 10, orphan_count: 0 }),
      after: makeSnapshot({ supplier_preview_rows: 8, orphan_count: 0 }),
      regression: [],
      domRegression: null,
    });

    expect(result.changedMetrics).toHaveLength(1);
    expect(result.changedMetrics[0]).toMatchObject({ metric: 'supplier_preview_rows', before: 10, after: 8 });
  });

  it('reports metric added in after snapshot as changed', () => {
    const result = buildTriageSummary({
      summary: makeSummary(),
      invariants: [],
      before: makeSnapshot({}),
      after: makeSnapshot({ new_metric: 5 }),
      regression: [],
      domRegression: null,
    });

    expect(result.changedMetrics).toHaveLength(1);
    expect(result.changedMetrics[0]).toMatchObject({ metric: 'new_metric', before: null, after: 5 });
  });
});

describe('buildAiHandoff', () => {
  function makeTriageSummary(overrides: Partial<TriageSummary> = {}): TriageSummary {
    return {
      runId: 'run-001',
      scenarioId: 'scenario-baseline',
      status: 'passed',
      topIssue: 'Keine kritischen Probleme erkannt.',
      failedInvariantIds: [],
      regressionFailures: [],
      domFailure: false,
      suspectComponents: ['none'],
      changedMetrics: [],
      recommendedFiles: [],
      ...overrides,
    };
  }

  it('returns fallback action when no failures', () => {
    const packet = buildAiHandoff(makeTriageSummary(), '/tmp/bundle');
    expect(packet.nextActions).toHaveLength(1);
    expect(packet.nextActions[0]).toMatch(/Kein akuter Fehler/);
  });

  it('adds invariant action when invariants fail', () => {
    const packet = buildAiHandoff(makeTriageSummary({ failedInvariantIds: ['inv-1'] }), '/tmp/bundle');
    expect(packet.nextActions.some((a) => a.includes('Invarianten'))).toBe(true);
  });

  it('adds regression action when regressions fail', () => {
    const packet = buildAiHandoff(makeTriageSummary({ regressionFailures: ['pnpm test'] }), '/tmp/bundle');
    expect(packet.nextActions.some((a) => a.includes('Regression'))).toBe(true);
  });

  it('adds playwright action when dom fails', () => {
    const packet = buildAiHandoff(makeTriageSummary({ domFailure: true }), '/tmp/bundle');
    expect(packet.nextActions.some((a) => a.includes('Playwright'))).toBe(true);
  });

  it('can accumulate multiple actions', () => {
    const packet = buildAiHandoff(
      makeTriageSummary({ failedInvariantIds: ['inv-1'], regressionFailures: ['pnpm test'], domFailure: true }),
      '/tmp/bundle',
    );
    expect(packet.nextActions.length).toBeGreaterThanOrEqual(3);
  });

  it('preserves runId, scenarioId and bundlePath', () => {
    const packet = buildAiHandoff(
      makeTriageSummary({ runId: 'my-run', scenarioId: 'my-scenario' }),
      '/my/bundle',
    );
    expect(packet.runId).toBe('my-run');
    expect(packet.scenarioId).toBe('my-scenario');
    expect(packet.bundlePath).toBe('/my/bundle');
  });
});

describe('buildAiHandoffMarkdown', () => {
  it('produces a markdown string with all sections', () => {
    const md = buildAiHandoffMarkdown({
      runId: 'run-001',
      scenarioId: 'baseline',
      bundlePath: '/tmp/bundle',
      topIssue: 'Not enough rows',
      failedInvariantIds: ['inv-1', 'inv-2'],
      suspectComponents: ['data-registry'],
      changedMetrics: [{ metric: 'supplier_preview_rows', before: 10, after: 8 }],
      recommendedFiles: ['packages/data-registry/src/file-dataset-registry.ts'],
      nextActions: ['Fix the registry.'],
    });

    expect(md).toContain('# AI Handoff - baseline');
    expect(md).toContain('run-001');
    expect(md).toContain('Not enough rows');
    expect(md).toContain('inv-1, inv-2');
    expect(md).toContain('## Changed Metrics');
    expect(md).toContain('supplier_preview_rows: 10 -> 8');
    expect(md).toContain('## Recommended Files');
    expect(md).toContain('file-dataset-registry.ts');
    expect(md).toContain('## Next Actions');
    expect(md).toContain('Fix the registry.');
  });

  it('shows "none" for failed invariants when empty', () => {
    const md = buildAiHandoffMarkdown({
      runId: 'r',
      scenarioId: 's',
      bundlePath: '/b',
      topIssue: 'ok',
      failedInvariantIds: [],
      suspectComponents: ['none'],
      changedMetrics: [],
      recommendedFiles: [],
      nextActions: ['All good.'],
    });

    expect(md).toContain('Failed invariants: none');
  });
});
