import { apiBaseUrl, authenticatedFetch } from './http';
import type {
  ObjectRow,
  ObjectSet,
  Relationship,
  RelationshipRow,
  SemanticPrimitive,
} from './semantic-model-api';

// Browser mirror of control-plane-api/src/object-workspace/contracts.ts. Keep
// these types here so the object workspace does not depend on server code.
export interface ObjectFamily {
  id: string;
  name: string;
  latest: ObjectSet;
  revisions: ObjectSet[];
}

export interface WorkspaceObject extends ObjectRow {
  objectId: string | null;
}

export interface ObjectQuery {
  projectId?: string;
  setId?: string;
  q?: string;
  identity?: ObjectRow['identity'];
  filterField?: string;
  filterValue?: SemanticPrimitive | null;
  sortBy?: string;
  sortDir: 'asc' | 'desc';
  offset: number;
  limit: number;
}

export interface ObjectPage {
  objectSet: ObjectSet;
  items: WorkspaceObject[];
  offset: number;
  limit: number;
  totalRows: number;
  totalSourceRows: number;
}

export type ObjectPresence = 'present' | 'ambiguous' | 'absent' | 'key_changed';

export interface ObjectHistoryEntry {
  objectSetId: string;
  revision: number;
  keyField: string;
  state: ObjectPresence;
  sourceRows: number[];
  totalMatches: number;
}

export interface ObjectRelationshipSummary {
  relationship: Relationship;
  direction: 'outgoing' | 'incoming';
  otherSet: ObjectSet;
  totalRows: number;
  linkedRows: number;
}

export interface WorkspaceObjectDetail {
  objectId: string;
  key: SemanticPrimitive;
  keyField: string;
  state: ObjectPresence;
  objectSet: ObjectSet;
  object: WorkspaceObject | null;
  candidates: WorkspaceObject[];
  candidateCount: number;
  history: ObjectHistoryEntry[];
  relationships: ObjectRelationshipSummary[];
}

export interface ObjectLinkPage {
  relationship: Relationship;
  direction: 'outgoing' | 'incoming';
  objectSet: ObjectSet;
  otherSet: ObjectSet;
  items: Array<{
    status: RelationshipRow['status'];
    sourceRow: number;
    reference: SemanticPrimitive | null;
    object: WorkspaceObject | null;
  }>;
  offset: number;
  limit: number;
  totalRows: number;
}

export class ObjectWorkspaceApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ObjectWorkspaceApiError';
  }
}

// Kept as an alias for callers that use the server contract's error name.
export { ObjectWorkspaceApiError as ObjectWorkspaceError };

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await authenticatedFetch(`${apiBaseUrl}/api/object-workspace${path}`, { signal });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string; message?: string } | null;
    throw new ObjectWorkspaceApiError(
      body?.error ?? body?.message ?? 'Der Objektbereich konnte nicht geladen werden.',
      response.status,
    );
  }
  return response.json() as Promise<T>;
}

function queryString(entries: Array<[string, string | undefined]>): string {
  const params = new URLSearchParams();
  for (const [key, value] of entries) {
    if (value !== undefined && value !== '') params.set(key, value);
  }
  const value = params.toString();
  return value ? `?${value}` : '';
}

export async function fetchObjectFamilies(signal?: AbortSignal, projectId?: string): Promise<ObjectFamily[]> {
  return (await request<{ items: ObjectFamily[] }>(`/families${queryString([['projectId', projectId]])}`, signal)).items;
}

export async function fetchObjectPage(
  familyId: string,
  query: Partial<ObjectQuery> = {},
  signal?: AbortSignal,
): Promise<ObjectPage> {
  const filterValue = query.filterValue === undefined ? undefined : JSON.stringify(query.filterValue);
  const filterField = query.filterValue === undefined ? undefined : query.filterField;
  return request<ObjectPage>(
    `/families/${encodeURIComponent(familyId)}/objects${queryString([
      ['setId', query.setId],
      ['projectId', query.projectId],
      ['q', query.q],
      ['identity', query.identity],
      ['filterField', filterField],
      ['filterValue', filterValue],
      ['sortBy', query.sortBy],
      ['sortDir', query.sortDir],
      ['offset', query.offset === undefined ? undefined : String(Math.max(0, query.offset))],
      ['limit', query.limit === undefined ? undefined : String(Math.min(100, Math.max(1, query.limit)))],
    ])}`,
    signal,
  );
}

export async function fetchObjectDetail(
  familyId: string,
  objectId: string,
  setId?: string,
  signal?: AbortSignal,
  projectId?: string,
): Promise<WorkspaceObjectDetail> {
  return request<WorkspaceObjectDetail>(
    `/families/${encodeURIComponent(familyId)}/objects/${encodeURIComponent(objectId)}${queryString([['setId', setId], ['projectId', projectId]])}`,
    signal,
  );
}

export async function fetchObjectLinks(
  familyId: string,
  objectId: string,
  relationshipId: string,
  query: { projectId?: string; setId?: string; offset?: number; limit?: number; direction?: 'outgoing' | 'incoming' } = {},
  signal?: AbortSignal,
): Promise<ObjectLinkPage> {
  return request<ObjectLinkPage>(
    `/families/${encodeURIComponent(familyId)}/objects/${encodeURIComponent(objectId)}/links/${encodeURIComponent(relationshipId)}${queryString([
      ['projectId', query.projectId],
      ['setId', query.setId],
      ['direction', query.direction],
      ['offset', query.offset === undefined ? undefined : String(Math.max(0, query.offset))],
      ['limit', query.limit === undefined ? undefined : String(Math.min(100, Math.max(1, query.limit)))],
    ])}`,
    signal,
  );
}

// Descriptive aliases make the endpoint helpers easy to discover at call sites.
export const fetchObjectWorkspaceFamilies = fetchObjectFamilies;
export const fetchObjectFamilyObjects = fetchObjectPage;
export const fetchWorkspaceObject = fetchObjectDetail;
export const fetchWorkspaceObjectLinks = fetchObjectLinks;
