import type { ObjectRow, ObjectSet, Relationship, RelationshipRow, SemanticPrimitive } from '../semantic-model/contracts.js';

export class ObjectWorkspaceError extends Error {
  constructor(message: string, public readonly statusCode = 400) { super(message); }
}
export interface ObjectFamily { id: string; name: string; latest: ObjectSet; revisions: ObjectSet[] }
export interface WorkspaceObject extends ObjectRow { objectId: string | null }
export interface ObjectQuery {
  setId?: string; q?: string; identity?: ObjectRow['identity'];
  filterField?: string; filterValue?: SemanticPrimitive | null;
  sortBy?: string; sortDir: 'asc' | 'desc'; offset: number; limit: number;
}
export interface ObjectPage {
  objectSet: ObjectSet; items: WorkspaceObject[];
  offset: number; limit: number; totalRows: number; totalSourceRows: number;
}
export type ObjectPresence = 'present' | 'ambiguous' | 'absent' | 'key_changed';
export interface ObjectHistoryEntry {
  objectSetId: string; revision: number; keyField: string; state: ObjectPresence;
  sourceRows: number[]; totalMatches: number;
}
export interface ObjectRelationshipSummary {
  relationship: Relationship; direction: 'outgoing' | 'incoming'; otherSet: ObjectSet;
  totalRows: number; linkedRows: number;
}
export interface WorkspaceObjectDetail {
  objectId: string; key: SemanticPrimitive; keyField: string; state: ObjectPresence;
  objectSet: ObjectSet; object: WorkspaceObject | null;
  candidates: WorkspaceObject[]; candidateCount: number;
  history: ObjectHistoryEntry[]; relationships: ObjectRelationshipSummary[];
}
export interface ObjectLinkPage {
  relationship: Relationship; direction: 'outgoing' | 'incoming';
  objectSet: ObjectSet; otherSet: ObjectSet;
  items: Array<{ status: RelationshipRow['status']; sourceRow: number; reference: SemanticPrimitive | null; object: WorkspaceObject | null }>;
  offset: number; limit: number; totalRows: number;
}
