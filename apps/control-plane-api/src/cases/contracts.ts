import type { OrderReviewBinding, OrderReviewRule } from '../domain/orders/review.js';
import type { ImportRow } from '../import-capability/isolated-executor.js';
import type { MissionRelationship, MissionSource } from '../missions/contracts.js';
import type { RelationshipDetail } from '../semantic-model/contracts.js';

/** Internal input from the checked semantic store, including every source row. */
export interface CaseSnapshot { detail: RelationshipDetail; fromRows: ImportRow[] }

/** Immutable business evidence; sourceRow is a 1-based source position, not an order identity. */
export interface CaseEvidence {
  missionId: string;
  sourceRow: number;
  question: string;
  source: MissionSource;
  targetSource: MissionSource;
  relationship: MissionRelationship;
  capabilityVersion: 'order-review-v1';
  orderKeyField: string;
  binding: OrderReviewBinding;
  orderRule: OrderReviewRule;
  orderRuleHash: string;
  executedAt: string;
  finding: ImportRow;
}

export type CaseStatus = 'open' | 'in_progress' | 'resolved';
export type CaseEventKind = 'created' | 'claimed' | 'resolved' | 'reopened';
export interface CaseAssignee { id: string; displayName: string }
export interface CaseEvent {
  at: string;
  actorId: string;
  actorName: string;
  kind: CaseEventKind;
  note: string | null;
}

/** Evidence never changes during assignment, resolution or reopening. */
export interface CaseRecord {
  id: string;
  tenantId: string;
  ownerId: string;
  title: string;
  status: CaseStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  evidence: CaseEvidence;
  evidenceHash: string;
  assignee: CaseAssignee | null;
  resolution: string | null;
  events: CaseEvent[];
}

export interface CaseFindingsOptions { offset?: number; limit?: number }
export interface CaseFindingsPage {
  items: ImportRow[];
  offset: number;
  limit: number;
  /** Number of actionable findings over the complete source, before pagination. */
  totalRows: number;
}
