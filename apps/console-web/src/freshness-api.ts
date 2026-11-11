import { apiBaseUrl, authenticatedFetch } from './http';
import type { DatasetPreviewResult } from './api';

export type FreshnessRunStatus = 'completed' | 'completed_with_gaps' | 'blocked';
export type FreshnessResultStatus = 'current' | 'stale' | 'unassessable';

export interface FreshnessRule {
  asOf: string;
  maxAgeSeconds: number;
  timestampMeaning: 'source_updated_at';
  timezone: 'explicit-offset';
}

export interface FreshnessMapping {
  sourceId: string;
  sourceUpdatedAt: string;
}

export interface FreshnessRunSummary {
  id: string;
  question: string;
  status: FreshnessRunStatus;
  createdAt: string;
  datasetId: string;
  moduleHash?: string;
  error?: string;
}

export interface FreshnessResult {
  sourceId: string;
  sourceUpdatedAt: string | null;
  status: FreshnessResultStatus;
  ageSeconds: number | null;
  reason: string;
}

export interface FreshnessRun extends FreshnessRunSummary {
  rule: FreshnessRule;
  mapping?: FreshnessMapping;
  generation?: {
    attempts: number;
    calls: number;
    denied: number;
  };
  results?: FreshnessResult[];
  error?: string;
  snapshot?: {
    hash: string;
    coverage: 'complete';
    rows: Array<Record<string, string | number | boolean | null>>;
  };
  executionReceipt?: unknown;
  reloadReceipt?: unknown;
}

export interface FreshnessRunDetailResponse {
  run: FreshnessRun;
}

export interface FreshnessReadiness {
  ready: boolean;
  capability: 'available' | 'missing';
  provider: 'configured' | 'missing' | 'disabled' | 'not_required';
  runtime: 'ready' | 'unavailable';
  checkedAt: string;
  generation?: {
    backend: 'codex' | 'api';
    model: string;
    reasoningEffort: string;
    available: boolean;
    reason?: string;
  };
}

export interface CreateFreshnessRunInput {
  question: string;
  datasetId: string;
  mapping: FreshnessMapping;
  rule: FreshnessRule;
}

export interface FreshnessSnapshotInput {
  datasetId: string;
  preview: DatasetPreviewResult;
}



async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const response = await authenticatedFetch(`${apiBaseUrl}${path}`, { ...init, headers });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string; message?: string; details?: string } | null;
    const message = [body?.error, body?.message, body?.details].filter((entry): entry is string => Boolean(entry)).join(' | ');
    throw new Error(message || `Request ${path} fehlgeschlagen.`);
  }
  return response.json() as Promise<T>;
}

export async function fetchFreshnessRuns(): Promise<FreshnessRunSummary[]> {
  const response = await request<{ runs: FreshnessRunSummary[] }>('/api/analysis/freshness');
  return response.runs;
}

export async function fetchFreshnessReadiness(): Promise<FreshnessReadiness> {
  return request<FreshnessReadiness>('/api/analysis/freshness/readiness');
}

export async function fetchFreshnessRun(id: string): Promise<FreshnessRun> {
  const response = await request<FreshnessRunDetailResponse>(`/api/analysis/freshness/${encodeURIComponent(id)}`);
  return response.run;
}

export async function createFreshnessRun(input: CreateFreshnessRunInput): Promise<FreshnessRun> {
  const response = await request<FreshnessRunDetailResponse>('/api/analysis/freshness', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return response.run;
}
