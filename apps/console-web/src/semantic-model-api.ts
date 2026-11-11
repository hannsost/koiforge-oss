import { apiBaseUrl, authenticatedFetch } from './http';
import type { MissionSource } from './mission-api';

// Browser contract for control-plane-api/src/semantic-model/contracts.ts.
export type SemanticPrimitive = string | number | boolean;
export interface ObjectSet {
  id: string; familyId: string; revision: number; previousId?: string;
  tenantId: string; ownerId: string; name: string; keyField: string; labelField?: string;
  source: MissionSource; snapshotHash: string; createdAt: string; confirmedBy: string;
  keyQuality: { totalRows: number; identifiedRows: number; missingKeys: number; duplicateRows: number; duplicateGroups: number };
}
export interface ObjectRow {
  sourceRow: number; key: SemanticPrimitive | null; label: string;
  identity: 'unique' | 'missing' | 'duplicate';
  attributes: Record<string, string | number | boolean | null>;
}
export interface ObjectSetDetail { objectSet: ObjectSet; rows: ObjectRow[]; totalRows: number; truncated: boolean; offset: number }
export interface Relationship {
  id: string; tenantId: string; ownerId: string; name: string;
  fromSetId: string; toSetId: string; fromField: string; createdAt: string; confirmedBy: string;
  cardinality: 'many-to-one'; contractVersion: 'relationship-v1';
  counts: { sourceRows: number; linkedRows: number; missingReferences: number; unmatchedReferences: number; ambiguousReferences: number; invalidSourceRows: number };
  evidence: { sourceHash: string; targetHash: string; fromRevision: number; toRevision: number };
}
export interface RelationshipRow {
  sourceRow: number; sourceKey: SemanticPrimitive | null; reference: SemanticPrimitive | null;
  status: 'linked' | 'missing_reference' | 'unmatched_reference' | 'ambiguous_reference' | 'invalid_source_key';
  targetRows: number[]; targetRowCount: number; targetRowsTruncated: boolean;
  sourceLabel: string; targetLabel?: string;
}
export interface RelationshipDetail {
  relationship: Relationship; from: ObjectSet; to: ObjectSet;
  rows: RelationshipRow[]; totalRows: number; truncated: boolean; offset: number;
}
export interface CreateObjectSetInput {
  name: string; datasetId: string; keyField: string; labelField?: string;
  confirmed: true; requestId: string; previousId?: string;
}
export interface CreateRelationshipInput {
  name: string; fromSetId: string; toSetId: string; fromField: string; confirmed: true; requestId: string;
}
export const relationshipStatusLabels: Record<RelationshipRow['status'], string> = {
  linked: 'Eindeutig zugeordnet', missing_reference: 'Referenz fehlt', unmatched_reference: 'Kein Ziel gefunden',
  ambiguous_reference: 'Ziel ist mehrdeutig', invalid_source_key: 'Quell-ID fehlt oder ist doppelt',
};
export class SemanticModelApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  const response = await authenticatedFetch(`${apiBaseUrl}/api/model${path}`, { ...init, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new SemanticModelApiError(body?.error ?? 'Das Fachmodell konnte nicht geladen oder gespeichert werden.', response.status);
  }
  return response.json() as Promise<T>;
}
export async function fetchObjectSets(signal?: AbortSignal): Promise<ObjectSet[]> {
  return (await request<{ items: ObjectSet[] }>('/object-sets', { signal })).items;
}
export async function fetchObjectSet(id: string, offset = 0, limit = 50, signal?: AbortSignal): Promise<ObjectSetDetail> {
  return request(`/object-sets/${encodeURIComponent(id)}?offset=${offset}&limit=${limit}`, { signal });
}
export async function createObjectSet(input: CreateObjectSetInput, signal?: AbortSignal): Promise<ObjectSet> {
  return (await request<{ objectSet: ObjectSet }>('/object-sets', { method: 'POST', body: JSON.stringify(input), signal })).objectSet;
}
export async function fetchRelationships(signal?: AbortSignal): Promise<Relationship[]> {
  return (await request<{ items: Relationship[] }>('/relationships', { signal })).items;
}
export async function fetchRelationship(id: string, offset = 0, limit = 50, signal?: AbortSignal): Promise<RelationshipDetail> {
  return request(`/relationships/${encodeURIComponent(id)}?offset=${offset}&limit=${limit}`, { signal });
}
export async function createRelationship(input: CreateRelationshipInput, signal?: AbortSignal): Promise<Relationship> {
  return (await request<{ relationship: Relationship }>('/relationships', { method: 'POST', body: JSON.stringify(input), signal })).relationship;
}
