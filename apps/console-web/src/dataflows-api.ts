import { apiBaseUrl, authenticatedFetch } from './http';
import type { ObjectSet } from './semantic-model-api';

export type ImportCell = string | number | boolean | null;
export type ImportRow = Record<string, ImportCell>;

export interface FlowJoin {
  familyId: string;
  leftField: string;
  rightField: string;
  fields: Array<{ source: string; target: string }>;
  required: boolean;
}

export type FlowFilterOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'is_null' | 'not_null';
export interface FlowFilter {
  field: string;
  operator: FlowFilterOperator;
  value?: ImportCell;
}

export interface FlowSpec {
  name: string;
  description: string;
  inputFamilyId: string;
  keyField: string;
  labelField?: string;
  joins: FlowJoin[];
  filters: FlowFilter[];
  minRows: number;
}

export interface FlowSource {
  familyId: string;
  setId: string;
  revision: number;
  name: string;
  snapshotHash: string;
  sourceHash: string;
  rowCount: number;
}

export interface FlowEvaluation {
  status: 'ready' | 'blocked';
  issues: string[];
  rows: ImportRow[];
  schema: Array<{ name: string; type: string; nullable?: boolean }>;
  rowCount: number;
  outputHash: string;
  steps: Array<{ label: string; rowsIn: number; rowsOut: number; unmatched?: number }>;
}

export interface FlowDefinition {
  id: string;
  flowId: string;
  revision: number;
  previousId?: string;
  tenantId: string;
  ownerId: string;
  createdAt: string;
  spec: FlowSpec;
  definitionHash: string;
  /** Schema fingerprints captured when this definition was confirmed. */
  bindings?: Array<{ familyId: string; schemaHash: string }>;
}

export interface FlowRun extends FlowEvaluation {
  id: string;
  flowId: string;
  definitionId: string;
  tenantId: string;
  ownerId: string;
  createdAt: string;
  engineVersion: string;
  sources: FlowSource[];
  expectedPreviousId?: string;
  runHash: string;
}

export type FlowRunSummary = Omit<FlowRun, 'rows'> & { published?: ObjectSet; sourcesChanged: boolean };
export interface FlowSummary {
  id: string;
  name: string;
  description: string;
  revision: number;
  definitionId: string;
  updatedAt: string;
  inputFamilyIds: string[];
  latestRun?: FlowRunSummary;
  published?: ObjectSet;
}
export interface FlowDetail {
  definition: FlowDefinition;
  revisions: FlowDefinition[];
  runs: FlowRunSummary[];
  published?: ObjectSet;
}
export interface FlowRunDetail {
  run: FlowRunSummary;
  rows: ImportRow[];
  offset: number;
  limit: number;
}

// Browser contract for control-plane-api/src/dataflows/contracts.ts.
export type FlowDependencyStatus = 'current' | 'needs_run' | 'needs_definition' | 'waiting' | 'unpublished' | 'unavailable';
export interface FlowDependencyInput {
  familyId: string;
  name: string;
  setId?: string;
  revision?: number;
  producerFlowId?: string;
  schemaChanged: boolean;
  missing: boolean;
}
export interface FlowDependencyNode {
  flowId: string;
  definitionId: string;
  name: string;
  revision: number;
  status: FlowDependencyStatus;
  issues: string[];
  inputs: FlowDependencyInput[];
  dependsOn: string[];
  affectedFlowIds: string[];
  published?: ObjectSet;
}
export interface FlowDependencyGraph {
  nodes: FlowDependencyNode[];
  edges: Array<{ fromFlowId: string; toFlowId: string }>;
  updateOrder: string[];
  nextFlowId?: string;
  graphHash: string;
}

export interface DataflowWritePayload {
  spec: FlowSpec;
  confirmed: true;
  requestId: string;
  previousId?: string;
}

export interface DataflowRunPayload {
  definitionId: string;
  confirmed: true;
  requestId: string;
}

export class DataflowApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'DataflowApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  const response = await authenticatedFetch(`${apiBaseUrl}/api/dataflows${path}`, { ...init, headers, signal });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string; message?: string } | null;
    throw new DataflowApiError(body?.error ?? body?.message ?? 'Der Datenfluss konnte nicht geladen oder gespeichert werden.', response.status);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export async function fetchDataflows(signal?: AbortSignal): Promise<FlowSummary[]> {
  return (await request<{ items: FlowSummary[] }>('', {}, signal)).items;
}

export async function fetchDataflowDependencies(signal?: AbortSignal): Promise<FlowDependencyGraph> {
  return request<FlowDependencyGraph>('/dependencies', {}, signal);
}

export async function fetchDataflow(id: string, signal?: AbortSignal): Promise<FlowDetail> {
  return request<FlowDetail>(`/${encodeURIComponent(id)}`, {}, signal);
}

export async function createDataflow(payload: DataflowWritePayload, signal?: AbortSignal): Promise<{ definition: FlowDefinition }> {
  return request<{ definition: FlowDefinition }>('', json(payload), signal);
}

export async function runDataflow(id: string, payload: DataflowRunPayload, signal?: AbortSignal): Promise<{ run: FlowRunSummary }> {
  return request<{ run: FlowRunSummary }>(`/${encodeURIComponent(id)}/runs`, json(payload), signal);
}

function query(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, String(value));
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

export async function fetchDataflowRun(id: string, runId: string, offset = 0, limit = 25, signal?: AbortSignal): Promise<FlowRunDetail> {
  return request<FlowRunDetail>(`/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}${query({ offset, limit })}`, {}, signal);
}

export async function publishDataflow(id: string, runId: string, signal?: AbortSignal): Promise<{ objectSet: ObjectSet }> {
  return request<{ objectSet: ObjectSet }>(`/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/publish`, json({ confirmed: true }), signal);
}
