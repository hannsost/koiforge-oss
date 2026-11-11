import type { FreshnessRule } from '../analysis/freshness-contract.js';
import type { ImportRow } from '../import-capability/isolated-executor.js';
import type { OrderReviewRule } from '../domain/orders/review.js';

export type MissionCapabilityId = 'source_freshness' | 'data_quality' | 'relationship_integrity' | 'order_review';
export interface MissionCapability {
  id: MissionCapabilityId;
  version: string;
  title: string;
  description: string;
  limitations: string[];
}
export interface MissionSource {
  datasetId: string;
  name: string;
  columns: string[];
  rowCount: number;
  hash: string;
  capturedAt: string;
  coverage: 'complete';
}
export interface MissionPlan {
  capabilityId: MissionCapabilityId | null;
  capabilityVersion: string | null;
  summary: string;
  steps: string[];
  limitations: string[];
  suggestedBinding: { keyField?: string; timestampField?: string; statusField?: string; dueDateField?: string };
  unsupportedReason?: string;
  generation: { backend: 'codex' | 'api'; model: string; reasoningEffort: string };
  relationship?: MissionRelationship;
  orderKeyField?: string;
  reusedFromMissionId?: string;
}
export interface MissionRelationship {
  id: string;
  name: string;
  fromSetId: string;
  toSetId: string;
  fromName: string;
  toName: string;
  fromField: string;
  toField: string;
  fromRevision: number;
  toRevision: number;
  sourceHash: string;
  targetHash: string;
  fromSnapshotHash: string;
  toSnapshotHash: string;
  targetRows: number;
}
export interface MissionRunInput {
  confirmed: true;
  binding: { keyField?: string; timestampField?: string; statusField?: string; dueDateField?: string };
  rule?: FreshnessRule;
  orderRule?: OrderReviewRule;
}
export interface OrderStatusProfile {
  field: string;
  totalRows: number;
  missingRows: number;
  nonTextRows: number;
  unassignableRows: number;
  uniqueTotal: number;
  values: Array<{ value: string; count: number }>;
  truncated: boolean;
}
export interface MissionResult {
  capabilityId: MissionCapabilityId;
  summary: string;
  counts: Record<string, number>;
  columns: string[];
  rows: ImportRow[];
  totalRows: number;
  truncated: boolean;
  evidence: {
    sourceHash: string;
    capabilityVersion: string;
    executedAt: string;
    analysisRunId?: string;
    moduleHash?: string;
    relationshipId?: string;
    fromSetId?: string;
    toSetId?: string;
    targetSourceHash?: string;
    fromSnapshotHash?: string;
    toSnapshotHash?: string;
    orderRuleHash?: string;
  };
}
export type MissionStatus = 'queued' | 'planning' | 'awaiting_confirmation' | 'running' | 'completed' | 'blocked' | 'interrupted';
export interface Mission {
  id: string;
  tenantId: string;
  ownerId: string;
  question: string;
  datasetId: string;
  relationshipId?: string;
  routine?: { id: string; name: string; sourceMissionId: string; previewHash: string; baselineRuleHash: string; confirmedRuleHash: string };
  status: MissionStatus;
  phase: 'plan' | 'execute';
  revision: number;
  createdAt: string;
  updatedAt: string;
  source?: MissionSource;
  plan?: MissionPlan;
  input?: MissionRunInput;
  result?: MissionResult;
  error?: string;
  events: Array<{ at: string; status: MissionStatus; message: string }>;
}
export interface MissionEngine {
  capabilities: MissionCapability[];
  plan(mission: Mission): Promise<{ source: MissionSource; plan: MissionPlan }>;
  validateRun(mission: Mission, input: unknown): MissionRunInput;
  execute(mission: Mission, input: MissionRunInput): Promise<MissionResult>;
  orderStatuses?(mission: Mission, field: string): Promise<OrderStatusProfile>;
}
