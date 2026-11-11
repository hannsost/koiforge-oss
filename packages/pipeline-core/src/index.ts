export { FilePipelineRegistry } from './file-pipeline-registry.js';
export { suggestPipelineSteps } from './suggest.js';
export type { DatasetMeta, FieldMeta, SuggestedStep, SuggestResult } from './suggest.js';
export type { FilePipelineRegistryOptions } from './file-pipeline-registry.js';
export { runSteps, deriveColumns } from './runner.js';
export type {
  Aggregation,
  AggregationFn,
  CreatePipelineInput,
  DataRow,
  DeriveExpression,
  FilterOperator,
  PipelineDefinition,
  PipelineRegistryState,
  PipelineRun,
  PipelineStep,
} from './types.js';
