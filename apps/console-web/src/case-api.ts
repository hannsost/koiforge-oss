import { apiBaseUrl, authenticatedFetch } from './http';
import type { MissionRelationship, MissionResult, MissionSource, OrderReviewRule } from './mission-api';

// Browser contract for control-plane-api/src/cases/contracts.ts.
export type CaseStatus = 'open' | 'in_progress' | 'resolved';
export type CaseAction = 'claim' | 'resolve' | 'reopen';
export interface CaseEvidence {
  missionId: string;
  sourceRow: number;
  question: string;
  source: MissionSource;
  targetSource: MissionSource;
  relationship: MissionRelationship;
  orderKeyField: string;
  capabilityVersion: 'order-review-v1';
  binding: { statusField: string; dueDateField?: string };
  orderRule: OrderReviewRule;
  orderRuleHash: string;
  executedAt: string;
  finding: MissionResult['rows'][number];
}
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
  assignee: { id: string; displayName: string } | null;
  resolution: string | null;
  events: Array<{ at: string; actorId: string; actorName: string; kind: 'created' | 'claimed' | 'resolved' | 'reopened'; note: string | null }>;
}
export interface CasePreview {
  title: string;
  evidence: CaseEvidence;
  evidenceHash: string;
  previewHash: string;
  existingCaseId: string | null;
}
export interface CaseFindings {
  items: MissionResult['rows'];
  offset: number;
  limit: number;
  totalRows: number;
}
export class CaseApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  const response = await authenticatedFetch(`${apiBaseUrl}/api/cases${path}`, { ...init, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new CaseApiError(body?.error ?? 'Die Klärungsfälle konnten nicht geladen oder verarbeitet werden.', response.status);
  }
  return response.json() as Promise<T>;
}
export async function fetchCases(signal?: AbortSignal): Promise<CaseRecord[]> {
  return (await request<{ items: CaseRecord[] }>('', { signal })).items;
}
export async function fetchCase(id: string, signal?: AbortSignal): Promise<CaseRecord> {
  return (await request<{ case: CaseRecord }>(`/${encodeURIComponent(id)}`, { signal })).case;
}
export async function fetchCaseFindings(missionId: string, offset = 0, limit = 25, signal?: AbortSignal): Promise<CaseFindings> {
  return request(`/findings?${new URLSearchParams({ missionId, offset: String(offset), limit: String(limit) })}`, { signal });
}
export async function previewCase(input: { missionId: string; sourceRow: number }, signal?: AbortSignal): Promise<CasePreview> {
  return request('/preview', { method: 'POST', body: JSON.stringify(input), signal });
}
export async function createCase(input: { missionId: string; sourceRow: number; previewHash: string; confirmed: true; requestId: string }, signal?: AbortSignal): Promise<CaseRecord> {
  return (await request<{ case: CaseRecord }>('', { method: 'POST', body: JSON.stringify(input), signal })).case;
}
export async function transitionCase(id: string, input: { revision: number; requestId: string; action: CaseAction; note?: string; confirmed: true }, signal?: AbortSignal): Promise<CaseRecord> {
  return (await request<{ case: CaseRecord }>(`/${encodeURIComponent(id)}/transition`, { method: 'POST', body: JSON.stringify(input), signal })).case;
}
