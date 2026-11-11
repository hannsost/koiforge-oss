import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type {
  AiHandoffPacket,
  InvariantResult,
  MetricDelta,
  RegressionCommandResult,
  ResilienceRunSummary,
  ResilienceScenario,
  ResilienceSnapshot,
  TriageSummary,
} from './types.js';

function toPackageName(command: string[]): string | null {
  const filterIndex = command.findIndex((entry) => entry === '--filter');
  if (filterIndex === -1) return null;
  return command[filterIndex + 1] ?? null;
}

function packageToPath(packageName: string): string[] {
  const mapping: Record<string, string[]> = {
    '@koiforge/module-manifest': ['packages/module-manifest/src'],
    '@koiforge/module-system': ['packages/module-system/src'],
    '@koiforge/data-registry': ['packages/data-registry/src', 'apps/control-plane-api/src/object-explorer.ts'],
    '@koiforge/ontology-core': ['packages/ontology-core/src'],
    '@koiforge/security-core': ['packages/security-core/src'],
    '@koiforge/config-core': ['packages/config-core/src'],
    '@koiforge/saved-view-core': ['packages/saved-view-core/src'],
    '@koiforge/asset-lineage-core': ['packages/asset-lineage-core/src'],
    '@koiforge/control-plane-api': ['apps/control-plane-api/src'],
    '@koiforge/console-web': ['apps/console-web/src', 'apps/console-web/src/components/BoardViewer.tsx'],
  };

  return mapping[packageName] ?? [];
}

function inferComponentsFromInvariant(invariantId: string): string[] {
  if (invariantId.includes('preview') || invariantId.includes('supplier') || invariantId.includes('order')) {
    return ['data-registry', 'object-explorer'];
  }

  if (invariantId.includes('detail')) {
    return ['object-explorer', 'console-web'];
  }

  return ['unknown'];
}

function inferFilesFromInvariant(invariantId: string): string[] {
  if (invariantId.includes('preview')) {
    return ['packages/data-registry/src/file-dataset-registry.ts', 'apps/control-plane-api/src/server.ts'];
  }

  if (invariantId.includes('supplier') || invariantId.includes('order') || invariantId.includes('detail')) {
    return ['apps/control-plane-api/src/object-explorer.ts', 'apps/console-web/src/App.tsx'];
  }

  return [];
}

function buildMetricDeltas(before: ResilienceSnapshot, after: ResilienceSnapshot): MetricDelta[] {
  const keys = new Set([...Object.keys(before.metrics), ...Object.keys(after.metrics)]);
  const deltas: MetricDelta[] = [];

  for (const key of [...keys].sort()) {
    const beforeValue = key in before.metrics ? before.metrics[key]! : null;
    const afterValue = key in after.metrics ? after.metrics[key]! : null;

    if (beforeValue !== afterValue) {
      deltas.push({ metric: key, before: beforeValue, after: afterValue });
    }
  }

  return deltas;
}

export async function loadBundleArtifacts(bundlePath: string): Promise<{
  summary: ResilienceRunSummary;
  scenario: ResilienceScenario;
  invariants: InvariantResult[];
  before: ResilienceSnapshot;
  after: ResilienceSnapshot;
  regression: RegressionCommandResult[];
  domRegression: RegressionCommandResult | null;
}> {
  const [summary, scenario, invariants, before, after, regression, domRegression] = await Promise.all([
    readFile(resolve(bundlePath, 'summary.json'), 'utf8').then((text) => JSON.parse(text) as ResilienceRunSummary),
    readFile(resolve(bundlePath, 'scenario.json'), 'utf8').then((text) => JSON.parse(text) as ResilienceScenario),
    readFile(resolve(bundlePath, 'invariants.json'), 'utf8').then((text) => JSON.parse(text) as InvariantResult[]),
    readFile(resolve(bundlePath, 'before_snapshot.json'), 'utf8').then((text) => JSON.parse(text) as ResilienceSnapshot),
    readFile(resolve(bundlePath, 'after_snapshot.json'), 'utf8').then((text) => JSON.parse(text) as ResilienceSnapshot),
    readFile(resolve(bundlePath, 'regression_summary.json'), 'utf8').then((text) => JSON.parse(text) as RegressionCommandResult[]),
    readFile(resolve(bundlePath, 'dom_regression.json'), 'utf8').then((text) => JSON.parse(text) as RegressionCommandResult | null),
  ]);

  return { summary, scenario, invariants, before, after, regression, domRegression };
}

export function buildTriageSummary(input: {
  summary: ResilienceRunSummary;
  invariants: InvariantResult[];
  before: ResilienceSnapshot;
  after: ResilienceSnapshot;
  regression: RegressionCommandResult[];
  domRegression: RegressionCommandResult | null;
}): TriageSummary {
  const failingInvariants = input.invariants.filter((entry) => !entry.passed && entry.kind !== 'diagnostic');
  const regressionFailures = input.regression.filter((entry) => !entry.ok).map((entry) => entry.command.join(' '));
  const changedMetrics = buildMetricDeltas(input.before, input.after);

  const suspectComponents = new Set<string>();
  const recommendedFiles = new Set<string>();

  for (const invariant of failingInvariants) {
    for (const component of inferComponentsFromInvariant(invariant.id)) suspectComponents.add(component);
    for (const file of inferFilesFromInvariant(invariant.id)) recommendedFiles.add(file);
  }

  for (const failure of input.regression.filter((entry) => !entry.ok)) {
    const packageName = toPackageName(failure.command);
    if (packageName) {
      suspectComponents.add(packageName);
      for (const file of packageToPath(packageName)) recommendedFiles.add(file);
    }
  }

  if (input.domRegression && !input.domRegression.ok) {
    suspectComponents.add('console-web');
    suspectComponents.add('e2e-tests');
    recommendedFiles.add('apps/console-web/src/App.tsx');
    recommendedFiles.add('apps/console-web/src/components/BoardViewer.tsx');
    recommendedFiles.add('packages/e2e-tests/tests');
  }

  const topIssue = failingInvariants[0]?.description
    ?? (input.domRegression && !input.domRegression.ok ? 'DOM-Regression fehlgeschlagen.' : null)
    ?? (regressionFailures[0] ? `Regression fehlgeschlagen: ${regressionFailures[0]}` : null)
    ?? 'Keine kritischen Probleme erkannt.';

  if (suspectComponents.size === 0) suspectComponents.add('none');

  return {
    runId: input.summary.runId,
    scenarioId: input.summary.scenarioId,
    status: input.summary.status,
    topIssue,
    failedInvariantIds: failingInvariants.map((entry) => entry.id),
    regressionFailures,
    domFailure: input.domRegression ? !input.domRegression.ok : false,
    suspectComponents: [...suspectComponents],
    changedMetrics,
    recommendedFiles: [...recommendedFiles],
  };
}

export function buildAiHandoff(summary: TriageSummary, bundlePath: string): AiHandoffPacket {
  const nextActions: string[] = [];

  if (summary.failedInvariantIds.length > 0) {
    nextActions.push('Fehlgeschlagene Invarianten zuerst an der Quelle analysieren.');
  }

  if (summary.regressionFailures.length > 0) {
    nextActions.push('Regression-Fehlerpakete priorisieren und betroffene Packages fokussieren.');
  }

  if (summary.domFailure) {
    nextActions.push('Playwright-Report und Trace prüfen, um UI-Fehler lokal einzugrenzen.');
  }

  if (nextActions.length === 0) {
    nextActions.push('Kein akuter Fehler - weitere Szenarien oder härtere Invarianten definieren.');
  }

  return {
    runId: summary.runId,
    scenarioId: summary.scenarioId,
    bundlePath,
    topIssue: summary.topIssue,
    failedInvariantIds: summary.failedInvariantIds,
    suspectComponents: summary.suspectComponents,
    changedMetrics: summary.changedMetrics,
    recommendedFiles: summary.recommendedFiles,
    nextActions,
  };
}

export function buildAiHandoffMarkdown(packet: AiHandoffPacket): string {
  const lines: string[] = [];
  lines.push(`# AI Handoff - ${packet.scenarioId}`);
  lines.push('');
  lines.push('- Run: `' + packet.runId + '`');
  lines.push('- Bundle: `' + packet.bundlePath + '`');
  lines.push('- Top issue: ' + packet.topIssue);
  lines.push('- Failed invariants: ' + (packet.failedInvariantIds.length > 0 ? packet.failedInvariantIds.join(', ') : 'none'));
  lines.push('- Suspect components: ' + packet.suspectComponents.join(', '));
  lines.push('');
  lines.push('## Changed Metrics');
  for (const delta of packet.changedMetrics) {
    lines.push(`- ${delta.metric}: ${String(delta.before)} -> ${String(delta.after)}`);
  }
  lines.push('');
  lines.push('## Recommended Files');
  for (const file of packet.recommendedFiles) {
    lines.push('- `' + file + '`');
  }
  lines.push('');
  lines.push('## Next Actions');
  for (const action of packet.nextActions) {
    lines.push(`- ${action}`);
  }

  return `${lines.join('\n')}\n`;
}

