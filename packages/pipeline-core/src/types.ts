export type FilterOperator =
  | 'eq' | 'neq'
  | 'gt' | 'lt' | 'gte' | 'lte'
  | 'contains'
  | 'not_null' | 'is_null';

export type AggregationFn = 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface Aggregation {
  column: string;
  fn: AggregationFn;
  outputName: string;
}

export type DeriveExpression =
  | { op: 'copy'; column: string }
  | { op: 'literal'; value: string | number | boolean | null }
  | { op: 'coalesce'; columns: string[]; fallback?: string | number | boolean | null };

export type PipelineStep =
  | { type: 'filter'; column: string; operator: FilterOperator; value?: string }
  | { type: 'select'; columns: string[] }
  | { type: 'rename'; from: string; to: string }
  | { type: 'derive'; column: string; expression: DeriveExpression }
  | { type: 'aggregate'; groupBy: string[]; aggregations: Aggregation[] }
  | { type: 'distinct'; columns?: string[] }
  | { type: 'join'; rightDatasetId: string; leftKey: string; rightKey: string; mode: 'inner' | 'left' };

export interface PipelineDefinition {
  id: string;
  name: string;
  description: string;
  inputDatasetId: string;
  outputName: string;
  outputNamespace: string;
  steps: PipelineStep[];
  lastOutputDatasetId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PipelineRun {
  id: string;
  pipelineId: string;
  status: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  completedAt?: string;
  outputDatasetId?: string;
  rowsIn: number;
  rowsOut: number;
  error?: string;
}

export interface CreatePipelineInput {
  name: string;
  description: string;
  inputDatasetId: string;
  outputName: string;
  outputNamespace: string;
  steps: PipelineStep[];
}

export interface PipelineRegistryState {
  pipelines: Record<string, PipelineDefinition>;
  runs: PipelineRun[];
}

export type DataRow = Record<string, string | number | boolean | null>;
