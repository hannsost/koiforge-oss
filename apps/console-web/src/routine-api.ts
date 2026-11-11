import { apiBaseUrl, authenticatedFetch } from './http';
import type { Mission, MissionRelationship, MissionResult, MissionSource, OrderReviewRule } from './mission-api';

// Browser contract for control-plane-api/src/routines/contracts.ts.
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
  binding: { statusField: string; dueDateField?: string };
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
interface RoutineSourceChange {
  previousRevision: number;
  revision: number;
  previousRows: number;
  rows: number;
  removedColumns: string[];
  addedColumns: string[];
}
interface RoutineValueChange { previous: string; current: string; changed: boolean }
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
  binding: RoutineDefinition['binding'];
  orderRule: OrderReviewRule;
  changes: {
    from: RoutineSourceChange;
    to: RoutineSourceChange;
    orderKey: RoutineValueChange;
    referenceField: RoutineValueChange;
    targetKey: RoutineValueChange;
    asOf: RoutineValueChange;
  };
  statusProfile: {
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
  };
  previousCounts: Record<string, number>;
  newCounts?: Record<string, number>;
  deltas?: Record<string, number>;
  orderRuleHash: string;
}
export class RoutineApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  const response = await authenticatedFetch(`${apiBaseUrl}/api/routines${path}`, { ...init, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new RoutineApiError(body?.error ?? 'Die Routine konnte nicht geladen oder verarbeitet werden.', response.status);
  }
  return response.json() as Promise<T>;
}
export async function fetchRoutines(signal?: AbortSignal): Promise<RoutineDefinition[]> {
  return (await request<{ items: RoutineDefinition[] }>('', { signal })).items;
}
export async function fetchRoutine(id: string, signal?: AbortSignal): Promise<RoutineDefinition> {
  return (await request<{ routine: RoutineDefinition }>(`/${encodeURIComponent(id)}`, { signal })).routine;
}
export async function createRoutine(input: { sourceMissionId: string; name: string; requestId: string; confirmed: true }, signal?: AbortSignal): Promise<RoutineDefinition> {
  return (await request<{ routine: RoutineDefinition }>('', { method: 'POST', body: JSON.stringify(input), signal })).routine;
}
export async function previewRoutine(id: string, input: { relationshipId: string; asOf: string }, signal?: AbortSignal): Promise<RoutinePreview> {
  return request(`/${encodeURIComponent(id)}/preview`, { method: 'POST', body: JSON.stringify(input), signal });
}
export async function runRoutine(id: string, input: { relationshipId: string; asOf: string; previewHash: string; confirmed: true; requestId: string }, signal?: AbortSignal): Promise<Mission> {
  return (await request<{ mission: Mission }>(`/${encodeURIComponent(id)}/run`, { method: 'POST', body: JSON.stringify(input), signal })).mission;
}

export interface RoutineRunSummary {
  id: string;
  status: Mission['status'];
  createdAt: string;
  updatedAt: string;
  sourceName: string;
  asOf: string | null;
}

export type RoutineComparisonCategory = 'new' | 'persisting' | 'cleared' | 'missing' | 'uncomparable';

export interface RoutineComparisonItem {
  category: RoutineComparisonCategory;
  key: string | number | boolean | null;
  reason: string | null;
  before: null | { sourceRow: number; finding: MissionResult['rows'][number]; actionable: boolean };
  after: null | { sourceRow: number; finding: MissionResult['rows'][number]; actionable: boolean };
  changedFields: string[];
}

export interface RoutineComparisonSide {
  source: MissionSource;
  targetSource: MissionSource;
  relationship: MissionRelationship;
  asOf: string;
  executedAt: string;
  orderRuleHash: string;
}

export interface RoutineRunComparison {
  version: 'order-change-v1';
  routineId: string;
  baselineMissionId: string;
  missionId: string;
  comparisonHash: string;
  counts: Record<RoutineComparisonCategory, number>;
  before: RoutineComparisonSide;
  after: RoutineComparisonSide;
  items: RoutineComparisonItem[];
  offset: number;
  limit: number;
  totalRows: number;
}

export async function fetchRoutineRuns(id: string, signal?: AbortSignal): Promise<RoutineRunSummary[]> {
  return (await request<{ items: RoutineRunSummary[] }>(`/${encodeURIComponent(id)}/runs`, { signal })).items;
}

export async function fetchRoutineRunComparison(id: string, input: {
  missionId: string;
  category?: RoutineComparisonCategory;
  offset?: number;
  limit?: number;
}, signal?: AbortSignal): Promise<RoutineRunComparison> {
  const params = new URLSearchParams({ missionId: input.missionId, offset: String(input.offset ?? 0), limit: String(input.limit ?? 25) });
  if (input.category) params.set('category', input.category);
  return request<RoutineRunComparison>(`/${encodeURIComponent(id)}/compare?${params.toString()}`, { signal });
}
