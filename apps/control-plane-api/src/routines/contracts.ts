import type { OrderReviewBinding, OrderReviewRule } from '../domain/orders/review.js';
import type { ImportRow } from '../import-capability/isolated-executor.js';
import type { MissionRelationship, MissionSource } from '../missions/contracts.js';
import type { RelationshipDetail } from '../semantic-model/contracts.js';

export interface RoutineSnapshot { detail: RelationshipDetail; fromRows: ImportRow[] }

/** A new confirmed rule requires a new routine; an existing definition is never edited. */
export interface RoutineDefinition {
  id: string;
  tenantId: string;
  ownerId: string;
  name: string;
  createdAt: string;
  sourceMissionId: string;
  capabilityId: 'order_review';
  capabilityVersion: string;
  question: string;
  binding: OrderReviewBinding;
  orderRule: OrderReviewRule;
  baseline: {
    source: MissionSource;
    targetSource: MissionSource;
    relationship: MissionRelationship;
    orderKeyField: string;
    fromFamilyId: string;
    toFamilyId: string;
    counts: Record<string, number>;
    orderRuleHash: string;
  };
}

export interface RoutineSourceChanges {
  previousRevision: number;
  revision: number;
  previousRows: number;
  rows: number;
  removedColumns: string[];
  addedColumns: string[];
}
export interface RoutineValueChange { previous: string; current: string; changed: boolean }
export interface RoutineChanges {
  from: RoutineSourceChanges;
  to: RoutineSourceChanges;
  orderKey: RoutineValueChange;
  referenceField: RoutineValueChange;
  targetKey: RoutineValueChange;
  asOf: RoutineValueChange;
}
export interface RoutineStatusProfile {
  field: string;
  totalRows: number;
  knownOpenRows: number;
  knownClosedRows: number;
  unknownRows: number;
  missingRows: number;
  nonTextRows: number;
  unassignableRows: number;
  unknownValues: Array<{ value: string; count: number }>;
  unknownUniqueTotal: number;
  truncated: boolean;
}
export interface RoutinePreview {
  routineId: string;
  relationshipId: string;
  asOf: string;
  ready: boolean;
  blockingReasons: string[];
  warnings: string[];
  previewHash?: string;
  source: MissionSource;
  targetSource: MissionSource;
  relationship: MissionRelationship;
  orderKeyField: string;
  binding: OrderReviewBinding;
  orderRule: OrderReviewRule;
  changes: RoutineChanges;
  statusProfile: RoutineStatusProfile;
  previousCounts: Record<string, number>;
  newCounts?: Record<string, number>;
  deltas?: Record<string, number>;
  orderRuleHash: string;
}
