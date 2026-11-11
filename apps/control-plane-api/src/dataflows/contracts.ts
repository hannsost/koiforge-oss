import type { ImportCell, ImportRow } from '../import-capability/isolated-executor.js';
import type { FrozenField } from '../semantic-model/store.js';
import type { ObjectSet } from '../semantic-model/contracts.js';

export class DataflowError extends Error {
  constructor(message: string, public readonly statusCode = 400) { super(message); }
}
export const DATAFLOW_ENGINE = 'typed-enrichment-v1';
export interface FlowJoin {
  familyId: string; leftField: string; rightField: string;
  fields: Array<{ source: string; target: string }>;
  required: boolean;
}
export interface FlowFilter {
  field: string;
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'is_null' | 'not_null';
  value?: ImportCell;
}
export interface FlowSpec {
  name: string; description: string; inputFamilyId: string;
  keyField: string; labelField?: string;
  joins: FlowJoin[]; filters: FlowFilter[]; minRows: number;
}
export interface FlowSource {
  familyId: string; setId: string; revision: number; name: string;
  snapshotHash: string; sourceHash: string; rowCount: number;
}
export interface FlowInput { source: FlowSource; rows: ImportRow[]; schema: FrozenField[] }
export interface FlowEvaluation {
  status: 'ready' | 'blocked'; issues: string[];
  rows: ImportRow[]; schema: FrozenField[]; rowCount: number; outputHash: string;
  steps: Array<{ label: string; rowsIn: number; rowsOut: number; unmatched?: number }>;
}
export interface FlowDefinition {
  id: string; flowId: string; revision: number; previousId?: string;
  tenantId: string; ownerId: string; createdAt: string;
  spec: FlowSpec; bindings: Array<{ familyId: string; schemaHash: string }>; definitionHash: string;
}
export interface FlowRun extends FlowEvaluation {
  id: string; flowId: string; definitionId: string; tenantId: string; ownerId: string;
  createdAt: string; engineVersion: typeof DATAFLOW_ENGINE; sources: FlowSource[];
  expectedPreviousId?: string; runHash: string;
}
export type FlowRunSummary = Omit<FlowRun, 'rows'> & { published?: ObjectSet; sourcesChanged: boolean };
export interface FlowSummary {
  id: string; name: string; description: string; revision: number; definitionId: string;
  updatedAt: string; inputFamilyIds: string[]; latestRun?: FlowRunSummary; published?: ObjectSet;
}
export interface FlowDetail { definition: FlowDefinition; revisions: FlowDefinition[]; runs: FlowRunSummary[]; published?: ObjectSet }
export interface FlowRunDetail { run: FlowRunSummary; rows: ImportRow[]; offset: number; limit: number }

export type FlowDependencyStatus = 'current' | 'needs_run' | 'needs_definition' | 'waiting' | 'unpublished' | 'unavailable';
export interface FlowDependencyInput {
  familyId: string; name: string; setId?: string; revision?: number; producerFlowId?: string;
  schemaChanged: boolean; missing: boolean;
}
export interface FlowDependencyNode {
  flowId: string; definitionId: string; name: string; revision: number;
  status: FlowDependencyStatus; issues: string[]; inputs: FlowDependencyInput[];
  dependsOn: string[]; affectedFlowIds: string[]; published?: ObjectSet;
}
export interface FlowDependencyGraph {
  nodes: FlowDependencyNode[]; edges: Array<{ fromFlowId: string; toFlowId: string }>;
  updateOrder: string[]; nextFlowId?: string; graphHash: string;
}
