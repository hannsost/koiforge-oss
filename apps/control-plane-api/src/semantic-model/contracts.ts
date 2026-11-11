import type { MissionSource } from '../missions/contracts.js';
import type { ImportRow } from '../import-capability/isolated-executor.js';

export type SemanticPrimitive = string | number | boolean;
export interface SemanticPrincipal { tenantId: string; ownerId: string }
export interface PageOptions { offset?: number; limit?: number }

export interface ObjectSet {
  id: string;
  familyId: string;
  revision: number;
  previousId?: string;
  tenantId: string;
  ownerId: string;
  name: string;
  keyField: string;
  labelField?: string;
  source: MissionSource;
  snapshotHash: string;
  createdAt: string;
  confirmedBy: string;
  keyQuality: {
    totalRows: number;
    identifiedRows: number;
    missingKeys: number;
    duplicateRows: number;
    duplicateGroups: number;
  };
}

export interface ObjectRow {
  sourceRow: number;
  key: SemanticPrimitive | null;
  label: string;
  identity: 'unique' | 'missing' | 'duplicate';
  attributes: ImportRow;
}

export interface ObjectSetDetail {
  objectSet: ObjectSet;
  rows: ObjectRow[];
  totalRows: number;
  truncated: boolean;
  offset: number;
}

export interface Relationship {
  id: string;
  tenantId: string;
  ownerId: string;
  name: string;
  fromSetId: string;
  toSetId: string;
  fromField: string;
  createdAt: string;
  confirmedBy: string;
  cardinality: 'many-to-one';
  contractVersion: 'relationship-v1';
  counts: {
    sourceRows: number;
    linkedRows: number;
    missingReferences: number;
    unmatchedReferences: number;
    ambiguousReferences: number;
    invalidSourceRows: number;
  };
  evidence: {
    sourceHash: string;
    targetHash: string;
    fromRevision: number;
    toRevision: number;
  };
}

export interface RelationshipRow {
  sourceRow: number;
  sourceKey: SemanticPrimitive | null;
  reference: SemanticPrimitive | null;
  status: 'linked' | 'missing_reference' | 'unmatched_reference' | 'ambiguous_reference' | 'invalid_source_key';
  targetRows: number[];
  targetRowCount: number;
  targetRowsTruncated: boolean;
  sourceLabel: string;
  targetLabel?: string;
}

export interface RelationshipDetail {
  relationship: Relationship;
  from: ObjectSet;
  to: ObjectSet;
  rows: RelationshipRow[];
  totalRows: number;
  truncated: boolean;
  offset: number;
}

export interface CreateObjectSetInput {
  name: string;
  datasetId: string;
  keyField: string;
  labelField?: string;
  confirmed: true;
  requestId: string;
  previousId?: string;
}

export interface CreateRelationshipInput {
  name: string;
  fromSetId: string;
  toSetId: string;
  fromField: string;
  confirmed: true;
  requestId: string;
}
