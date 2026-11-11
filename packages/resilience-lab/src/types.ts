export type MutationKind = 'replace' | 'blank' | 'duplicate' | 'rename-column' | 'drop-column' | 'append';
export type InvariantKind = 'hard' | 'soft' | 'diagnostic';
export type InvariantOperator = '>=' | '<=' | '==' | '!=';

export interface RowSelector {
  column: string;
  equals?: string;
  in?: string[];
}

export interface MutationDefinition {
  kind: MutationKind;
  selector?: RowSelector;
  column?: string;
  value?: string;
  from?: string;
  to?: string;
  overrides?: Record<string, string>;
  row?: Record<string, string>;
}

export interface ScenarioDatasetDefinition {
  datasetId: 'suppliers' | 'orders' | 'shipments';
  mutations: MutationDefinition[];
}

export interface ScenarioInvariant {
  id: string;
  kind: InvariantKind;
  metric: string;
  operator: InvariantOperator;
  expected: number | boolean;
  description: string;
}

export interface ResilienceScenario {
  id: string;
  title: string;
  description: string;
  seed: number;
  tags: string[];
  datasets: ScenarioDatasetDefinition[];
  invariants: ScenarioInvariant[];
}

export interface ResilienceSnapshot {
  metrics: Record<string, number | boolean>;
  samples: {
    supplierPreview: Array<Record<string, string | number | boolean | null>>;
    supplierObjects: Array<Record<string, unknown>>;
    orderObjects: Array<Record<string, unknown>>;
  };
}

export interface InvariantResult extends ScenarioInvariant {
  observed: number | boolean | null;
  passed: boolean;
}

export interface ResilienceLogEntry {
  timestamp: string;
  runId: string;
  scenarioId: string;
  level: 'info' | 'warn' | 'error';
  component: string;
  stage: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface RegressionCommandResult {
  command: string[];
  exitCode: number;
  ok: boolean;
  durationMs: number;
}

export interface ResilienceRunSummary {
  runId: string;
  scenarioId: string;
  bundlePath: string;
  status: 'passed' | 'failed';
  failedInvariantIds: string[];
  regressionFailed: boolean;
  domRegressionFailed: boolean;
}

export interface MetricDelta {
  metric: string;
  before: number | boolean | null;
  after: number | boolean | null;
}

export interface TriageSummary {
  runId: string;
  scenarioId: string;
  status: 'passed' | 'failed';
  topIssue: string;
  failedInvariantIds: string[];
  regressionFailures: string[];
  domFailure: boolean;
  suspectComponents: string[];
  changedMetrics: MetricDelta[];
  recommendedFiles: string[];
}

export interface AiHandoffPacket {
  runId: string;
  scenarioId: string;
  bundlePath: string;
  topIssue: string;
  failedInvariantIds: string[];
  suspectComponents: string[];
  changedMetrics: MetricDelta[];
  recommendedFiles: string[];
  nextActions: string[];
}
