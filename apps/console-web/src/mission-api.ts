import { apiBaseUrl, authenticatedFetch } from './http';
import type { FreshnessRule } from './freshness-api';

// Browser contract for control-plane-api/src/missions/contracts.ts.
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
  id: string; name: string; fromSetId: string; toSetId: string; fromName: string; toName: string;
  fromField: string; toField: string; fromRevision: number; toRevision: number;
  sourceHash: string; targetHash: string; fromSnapshotHash: string; toSnapshotHash: string; targetRows: number;
}
export interface MissionRunInput {
  confirmed: true;
  binding: { keyField?: string; timestampField?: string; statusField?: string; dueDateField?: string };
  rule?: FreshnessRule;
  orderRule?: OrderReviewRule;
}
export interface OrderReviewRule {
  openStatuses: string[];
  closedStatuses: string[];
  asOf: string;
  dueDateMeaning: 'promised_delivery_day' | 'not_available';
}
export interface OrderStatusValues {
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
  rows: Array<Record<string, string | number | boolean | null>>;
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

export class MissionApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  const response = await authenticatedFetch(`${apiBaseUrl}/api/missions${path}`, { ...init, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string; message?: string } | null;
    throw new MissionApiError(body?.error ?? body?.message ?? 'Die Auftragsanfrage ist fehlgeschlagen.', response.status);
  }
  return response.json() as Promise<T>;
}

export async function fetchMissionCapabilities(signal?: AbortSignal): Promise<MissionCapability[]> {
  return (await request<{ items: MissionCapability[] }>('/capabilities', { signal })).items;
}
export async function fetchMissions(signal?: AbortSignal): Promise<Mission[]> {
  return (await request<{ items: Mission[] }>('', { signal })).items;
}
export async function fetchMission(id: string, signal?: AbortSignal): Promise<Mission> {
  return (await request<{ mission: Mission }>(`/${encodeURIComponent(id)}`, { signal })).mission;
}
export async function fetchOrderStatuses(id: string, field: string, signal?: AbortSignal): Promise<OrderStatusValues> {
  return request<OrderStatusValues>(`/${encodeURIComponent(id)}/order-statuses?${new URLSearchParams({ field })}`, { signal });
}
export async function createMission(input: { question: string; datasetId: string; requestId: string; relationshipId?: string }, signal?: AbortSignal): Promise<Mission> {
  return (await request<{ mission: Mission }>('', { method: 'POST', body: JSON.stringify(input), signal })).mission;
}
export async function runMission(id: string, input: MissionRunInput & { revision: number; requestId: string }, signal?: AbortSignal): Promise<Mission> {
  return (await request<{ mission: Mission }>(`/${encodeURIComponent(id)}/run`, { method: 'POST', body: JSON.stringify(input), signal })).mission;
}
export async function retryMission(id: string, input: { revision: number; requestId: string }, signal?: AbortSignal): Promise<Mission> {
  return (await request<{ mission: Mission }>(`/${encodeURIComponent(id)}/retry`, { method: 'POST', body: JSON.stringify(input), signal })).mission;
}

// Retain the ID after a lost response, including a browser reload. The tab's
// storage is scoped to the authenticated owner by the caller, never shared.
const pendingRequests = new Map<string, { signature: string; requestId: string }>();
export function missionRequestId(key: string, payload: unknown): string {
  const signature = JSON.stringify(payload);
  let previous = pendingRequests.get(key);
  if (!previous) {
    try { previous = JSON.parse(sessionStorage.getItem(key) ?? 'null') ?? undefined; } catch { /* Storage may be unavailable. */ }
  }
  if (previous?.signature === signature && typeof previous.requestId === 'string') return previous.requestId;
  const next = { signature, requestId: crypto.randomUUID() };
  pendingRequests.set(key, next);
  try { sessionStorage.setItem(key, JSON.stringify(next)); } catch { /* In-memory retry still works. */ }
  return next.requestId;
}
export function clearMissionRequest(key: string): void {
  pendingRequests.delete(key);
  try { sessionStorage.removeItem(key); } catch { /* Storage may be unavailable. */ }
}
