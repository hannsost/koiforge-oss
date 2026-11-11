import { ApiError, apiBaseUrl, authenticatedFetch } from './http';
export interface ModuleRecord {
  id: string;
  status: 'installed' | 'enabled' | 'disabled';
  currentVersion: string;
  versions: Array<{ version: string; installedAt: string }>;
  updatedAt: string;
}

export interface CapabilityRegistration {
  capability: string;
  moduleId: string;
  version: string;
}

export interface ConnectorDefinition {
  id: string;
  name: string;
  category: 'file' | 'database' | 'object-storage' | 'stream';
  capabilities: string[];
  configFields: Array<{
    key: string;
    label: string;
    type: 'string' | 'number' | 'boolean' | 'json';
    required?: boolean;
    description?: string;
  }>;
}

export interface SessionContext {
  user: {
    id: string;
    displayName: string;
    email?: string;
  };
  tenant: {
    id: string;
    name: string;
    slug: string;
    status: 'active' | 'inactive';
  };
  roleIds: string[];
  permissions: string[];
}

export interface TenantRecord {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'inactive';
}

export interface RoleRecord {
  id: string;
  name: string;
  description?: string;
  permissions: string[];
}

export interface UserRecord {
  id: string;
  displayName: string;
  email?: string;
  memberships: Array<{
    tenantId: string;
    roleIds: string[];
  }>;
}

export interface SecretMetadata {
  id: string;
  name: string;
  scope: 'global' | 'tenant';
  tenantId?: string;
  description?: string;
  tags: string[];
  maskedValue: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConfigEntryRecord {
  id: string;
  key: string;
  scope: 'global' | 'tenant';
  tenantId?: string;
  valueType: 'string' | 'number' | 'boolean' | 'json' | 'secret-ref';
  value: string | number | boolean | Record<string, unknown> | string[];
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResolvedConfigEntry {
  key: string;
  scope: 'global' | 'tenant';
  tenantId?: string;
  valueType: 'string' | 'number' | 'boolean' | 'json' | 'secret-ref';
  resolvedValue: string | number | boolean | Record<string, unknown> | string[];
  description?: string;
  source: 'literal' | 'secret';
}

export interface OntologyProperty {
  name: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'date' | 'datetime' | 'object' | 'array';
  required: boolean;
  computed: boolean;
  contributors: string[];
}

export interface OntologyObjectContract {
  key: string;
  name: string;
  namespace: string;
  contractVersion: number;
  contributors: string[];
  properties: OntologyProperty[];
  extensionContributors: string[];
}

export interface OntologyActionContract {
  key: string;
  name: string;
  contractVersion: number;
  input: string;
  permissions: string[];
  contributors: string[];
}

export interface OntologyConflict {
  kind:
    | 'reserved-object'
    | 'duplicate-object-contract'
    | 'missing-base-object'
    | 'property-type-conflict'
    | 'namespace-conflict'
    | 'action-signature-conflict';
  severity: 'error' | 'warning';
  moduleId: string;
  message: string;
  subject: string;
}

export interface OntologyValidationResult {
  ok: boolean;
  snapshot: {
    modules: string[];
    objects: OntologyObjectContract[];
    actions: OntologyActionContract[];
    extensions: number;
  };
  conflicts: OntologyConflict[];
}

export interface AssetRecord {
  id: string;
  name: string;
  kind: 'dataset' | 'job' | 'transform' | 'view';
  tenantId: string;
  datasetId?: string;
  owner?: string;
  domain?: string;
  description?: string;
  status: 'draft' | 'active' | 'stale';
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface LineageEdge {
  id: string;
  fromAssetId: string;
  toAssetId: string;
  operation: string;
  createdAt: string;
}

export interface RunRecord {
  id: string;
  assetId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt?: string;
  triggeredBy: string;
  summary?: string;
}

export interface LineageEvent {
  id: string;
  type: 'lineage.edge-recorded' | 'run.recorded' | 'asset.registered';
  subjectId: string;
  timestamp: string;
  details?: string;
}

export interface DatasetPreviewResult {
  datasetId: string;
  columns: string[];
  rows: Array<Record<string, string | number | boolean | null>>;
  rowCount: number;
  truncated: boolean;
}

export interface ExplorerObjectSummary {
  id: string;
  type: string;
  title: string;
  subtitle?: string;
  confidence: number;
  confidenceLabel: 'high' | 'medium' | 'low';
  attributes: Record<string, string | number | boolean | null>;
  relationCounts: Record<string, number>;
}

export interface ExplorerObjectDetail {
  summary: ExplorerObjectSummary;
  related: Array<{
    label: string;
    type: string;
    items: ExplorerObjectSummary[];
  }>;
}

export interface ExplorerLinkSuggestion {
  fromId: string;
  fromType: string;
  fromTitle: string;
  fromSubtitle?: string;
  fromStatus?: string;
  toId: string;
  toType: string;
  toTitle: string;
  toSubtitle?: string;
  toStatus?: string;
  confidence: number;
  confidenceLabel: 'high' | 'medium' | 'low';
  reasons: string[];
}

export interface DiscoveryReport {
  profiles: Array<{
    datasetId: string;
    datasetName: string;
    namespace: string;
    columns: Array<{
      datasetId: string;
      column: string;
      rowCount: number;
      nullCount: number;
      distinctCount: number;
      uniquenessRatio: number;
      typeHints: string[];
      sampleValues: string[];
    }>;
  }>;
  suggestions: Array<{
    fromDatasetId: string;
    fromColumn: string;
    toDatasetId: string;
    toColumn: string;
    confidence: number;
    confidenceLabel: 'high' | 'medium' | 'low';
    suggestionType: 'exact-key' | 'reference-key' | 'semantic-match' | 'geo-match';
    reasons: string[];
  }>;
}

export interface IdentityLinkingReport {
  links: Array<{
    fromDatasetId: string;
    fromRowKey: string;
    fromColumn: string;
    fromValue: string;
    toDatasetId: string;
    toRowKey: string;
    toColumn: string;
    toValue: string;
    confidence: number;
    confidenceLabel: 'high' | 'medium' | 'low';
    reasons: string[];
  }>;
  clusters: Array<{
    datasetId: string;
    entityType: string;
    clusterKey: string;
    confidence: number;
    confidenceLabel: 'high' | 'medium' | 'low';
    members: Array<{ rowKey: string; label: string }>;
    conflicts: string[];
  }>;
  candidateStats: {
    hintCount: number;
    bucketCount: number;
    rowComparisonsEstimated: number;
    candidatePairsGenerated: number;
    blockedPairsSkipped: number;
    finalLinkCount: number;
  };
}

export type SavedViewType = 'dataset-preview' | 'object-explorer' | 'board-viewer' | 'workshop';

export interface SavedViewRecord {
  id: string;
  tenantId: string;
  type: SavedViewType;
  name: string;
  description?: string;
  createdBy: string;
  state: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface UiSlotRegistration {
  slot: string;
  component: string;
  lazy?: boolean;
  moduleId: string;
  version: string;
}

export interface AuditEvent {
  type: 'install' | 'upgrade' | 'enable' | 'disable' | 'rollback';
  moduleId: string;
  version: string;
  timestamp: string;
  details?: string;
}

export interface DatasetField {
  name: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'date' | 'datetime' | 'json';
  nullable?: boolean;
  description?: string;
}

export interface DatasetRecord {
  id: string;
  name: string;
  namespace: string;
  description?: string;
  connectorId: string;
  connectorCategory: 'file' | 'database' | 'object-storage' | 'stream';
  mode: 'virtual' | 'materialized';
  status: 'registered' | 'ready' | 'stale';
  schema: DatasetField[];
  snapshots: Array<{ id: string; createdAt: string; reason: string }>;
  sqlAccess: { catalog: string; schema: string; table: string; queryPreview: string };
  tags: string[];
  updatedAt: string;
}

export interface DataEvent {
  id: string;
  type: 'dataset.registered' | 'dataset.snapshotted' | 'dataset.schema-updated';
  datasetId: string;
  timestamp: string;
  details?: string;
}

export interface HealthStatus {
  status: string;
  service: string;
  coreVersion: string;
}

export type MonitoringSensorState = 'ok' | 'warning' | 'critical' | 'unknown';
export type MonitoringWindow = '15m' | '1h' | '6h' | '24h' | '7d';

export interface MonitoringSensorRecord {
  id: string;
  name: string;
  group: 'node' | 'kubernetes' | 'flux' | 'tls' | 'backup' | 'endpoint' | 'alerts' | 'runner' | 'application' | 'monitoring';
  assessment?: 'informational' | 'threshold';
  kind: 'gauge' | 'status' | 'duration' | 'count';
  unit?: 'percent' | 'bytes' | 'count' | 'days' | 'hours' | 'boolean';
  description: string;
  defaultWindow: MonitoringWindow;
}

export interface MonitoringSensorSummary extends MonitoringSensorRecord {
  timestamp: string;
  value: number | null;
  state: MonitoringSensorState;
}

export interface MonitoringSummary {
  source: 'ready' | 'degraded';
  items: MonitoringSensorSummary[];
}

export interface MonitoringAlertRecord {
  alertname: string;
  severity?: 'info' | 'warning' | 'critical';
  namespace?: string;
  state: 'pending' | 'firing';
  activeAt?: string;
}

export interface MonitoringAlerts {
  items: MonitoringAlertRecord[];
}

export interface MonitoringSeries {
  sensorId: string;
  window: MonitoringWindow;
  points: Array<{ timestamp: string; value: number | null }>;
}

export interface MonitoringEndpoints {
  source: 'ready' | 'degraded';
  observedAt: string;
  items: Array<{
    id: string; name: string; observer: string | null; state: 'ok' | 'critical' | 'unknown';
    checkedAt: string | null; maxAgeSeconds: number; tlsDays: number | null;
    reason: 'fresh' | 'stale' | 'missing' | 'ambiguous';
  }>;
}

export function fetchMonitoringEndpoints(signal?: AbortSignal): Promise<MonitoringEndpoints> {
  return request<MonitoringEndpoints>('/api/monitoring/endpoints', { signal });
}




async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const response = await authenticatedFetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      details?: string;
      error?: string;
      message?: string;
    } | null;
    const message = [body?.error, body?.details, body?.message]
      .filter((entry): entry is string => Boolean(entry))
      .join(' | ');
    throw new ApiError(response.status, message || `Request ${path} fehlgeschlagen.`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  if (!text) {
    return undefined as T;
  }

  return JSON.parse(text) as T;
}

export async function fetchHealth(): Promise<HealthStatus> {
  return request<HealthStatus>('/health');
}


export async function fetchMonitoringSummary(signal?: AbortSignal): Promise<MonitoringSummary> {
  return request<MonitoringSummary>('/api/monitoring/summary', { signal });
}

export interface GitLabQueueCounts {
  running: number;
  pending: number;
  duoRunning: number;
  duoPending: number;
  upcoming: number;
  resourceWaiting: number;
  scheduled: number;
  canceling: number;
}

export interface GitLabQueueSnapshot {
  source: 'ready' | 'degraded';
  observedAt: string;
  counts: GitLabQueueCounts | null;
  oldestPendingSeconds: number | null;
  projects: Array<{
    project: string;
    url: string;
    counts: GitLabQueueCounts | null;
    oldestPendingSeconds: number | null;
  }>;
}

export function fetchGitLabQueue(signal?: AbortSignal): Promise<GitLabQueueSnapshot> {
  return request<GitLabQueueSnapshot>('/api/monitoring/gitlab-queue', { signal });
}

export async function fetchMonitoringAlerts(signal?: AbortSignal): Promise<MonitoringAlerts> {
  return request<MonitoringAlerts>('/api/monitoring/alerts', { signal });
}

export async function fetchMonitoringSeries(
  sensorId: string,
  window: MonitoringWindow,
  signal?: AbortSignal,
): Promise<MonitoringSeries> {
  const params = new URLSearchParams({ window });
  return request<MonitoringSeries>(
    `/api/monitoring/sensors/${encodeURIComponent(sensorId)}/series?${params.toString()}`, { signal },
  );
}


export async function fetchSession(): Promise<SessionContext> {
  return request<SessionContext>('/api/auth/session');
}

export async function fetchTenants(): Promise<TenantRecord[]> {
  const response = await request<{ items: TenantRecord[] }>('/api/security/tenants');
  return response.items;
}

export async function fetchRoles(): Promise<RoleRecord[]> {
  const response = await request<{ items: RoleRecord[] }>('/api/security/roles');
  return response.items;
}

export async function fetchUsers(): Promise<UserRecord[]> {
  const response = await request<{ items: UserRecord[] }>('/api/security/users');
  return response.items;
}

export async function fetchSecrets(): Promise<SecretMetadata[]> {
  const response = await request<{ items: SecretMetadata[] }>('/api/secrets');
  return response.items;
}

export async function fetchConfigEntries(): Promise<ConfigEntryRecord[]> {
  const response = await request<{ items: ConfigEntryRecord[] }>('/api/config/entries');
  return response.items;
}

export async function fetchResolvedConfig(): Promise<ResolvedConfigEntry[]> {
  const response = await request<{ items: ResolvedConfigEntry[] }>('/api/config/resolved');
  return response.items;
}

export async function fetchOntologySnapshot(): Promise<OntologyValidationResult> {
  return request<OntologyValidationResult>('/api/ontology/snapshot');
}

export async function fetchAssets(): Promise<AssetRecord[]> {
  const response = await request<{ items: AssetRecord[] }>('/api/assets');
  return response.items;
}

export async function fetchLineageEdges(): Promise<LineageEdge[]> {
  const response = await request<{ items: LineageEdge[] }>('/api/lineage/edges');
  return response.items;
}

export async function fetchRuns(): Promise<RunRecord[]> {
  const response = await request<{ items: RunRecord[] }>('/api/lineage/runs');
  return response.items;
}

export async function fetchLineageEvents(): Promise<LineageEvent[]> {
  const response = await request<{ items: LineageEvent[] }>('/api/lineage/events');
  return response.items;
}

export async function bootstrapAssets(): Promise<void> {
  await request('/api/bootstrap/assets', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function fetchDatasetPreview(
  datasetId: string,
  options?: { limit?: number; q?: string; sortBy?: string; sortDir?: 'asc' | 'desc'; filters?: Record<string, string> },
): Promise<DatasetPreviewResult> {
  const params = new URLSearchParams();
  params.set('limit', String(options?.limit ?? 20));
  if (options?.q) params.set('q', options.q);
  if (options?.sortBy) params.set('sortBy', options.sortBy);
  if (options?.sortDir) params.set('sortDir', options.sortDir);
  if (options?.filters && Object.keys(options.filters).length > 0) params.set('filters', JSON.stringify(options.filters));

  return request<DatasetPreviewResult>(`/api/datasets/${datasetId}/preview?${params.toString()}`);
}

export async function fetchObjects(
  objectType: string,
  options?: {
    q?: string;
    sortBy?: string;
    sortDir?: 'asc' | 'desc';
    filters?: Record<string, string>;
  },
): Promise<ExplorerObjectSummary[]> {
  const params = new URLSearchParams();
  if (options?.q) params.set('q', options.q);
  if (options?.sortBy) params.set('sortBy', options.sortBy);
  if (options?.sortDir) params.set('sortDir', options.sortDir);
  if (options?.filters && Object.keys(options.filters).length > 0) params.set('filters', JSON.stringify(options.filters));
  const query = params.toString();
  const response = await request<{ items: ExplorerObjectSummary[] }>(`/api/objects/${objectType}${query ? `?${query}` : ''}`);
  return response.items;
}

export async function fetchObjectDetail(
  objectType: string,
  objectId: string,
): Promise<ExplorerObjectDetail> {
  return request<ExplorerObjectDetail>(`/api/objects/${objectType}/${objectId}`);
}

export async function fetchBoardSuggestions(): Promise<ExplorerLinkSuggestion[]> {
  const response = await request<{ items: ExplorerLinkSuggestion[] }>('/api/board/suggestions');
  return response.items;
}

export async function fetchDiscoveryReport(): Promise<DiscoveryReport> {
  return request<DiscoveryReport>('/api/discovery/report');
}

export async function fetchIdentityReport(): Promise<IdentityLinkingReport> {
  return request<IdentityLinkingReport>('/api/identity/report');
}

export async function fetchSavedViews(type?: SavedViewType | string): Promise<SavedViewRecord[]> {
  const query = type ? `?type=${type}` : '';
  const response = await request<{ items: SavedViewRecord[] }>(`/api/views${query}`);
  return response.items;
}

export async function saveView(input: {
  id?: string;
  type: SavedViewType | string;
  name: string;
  description?: string;
  state: Record<string, unknown>;
}): Promise<SavedViewRecord> {
  return request<SavedViewRecord>('/api/views/upsert', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function fetchModules(): Promise<ModuleRecord[]> {
  const response = await request<{ items: ModuleRecord[] }>('/api/modules');
  return response.items;
}

export async function fetchCapabilities(): Promise<CapabilityRegistration[]> {
  const response = await request<{ items: CapabilityRegistration[] }>('/api/modules/capabilities');
  return response.items;
}

export async function fetchConnectors(): Promise<ConnectorDefinition[]> {
  const response = await request<{ items: ConnectorDefinition[] }>('/api/connectors');
  return response.items;
}

export async function fetchDatasets(): Promise<DatasetRecord[]> {
  const response = await request<{ items: DatasetRecord[] }>('/api/datasets');
  return response.items;
}

export async function fetchDataEvents(): Promise<DataEvent[]> {
  const response = await request<{ items: DataEvent[] }>('/api/datasets/events');
  return response.items;
}

export async function fetchUiContributions(): Promise<UiSlotRegistration[]> {
  const response = await request<{ items: UiSlotRegistration[] }>('/api/modules/ui');
  return response.items;
}

export async function fetchAudit(): Promise<AuditEvent[]> {
  const response = await request<{ items: AuditEvent[] }>('/api/audit');
  return response.items;
}

export async function bootstrapExamples(): Promise<void> {
  await request('/api/bootstrap/examples', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function bootstrapDatasets(): Promise<void> {
  await request('/api/bootstrap/datasets', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function uploadCsvDataset(
  file: File,
  meta: { name: string; namespace: string; description?: string; delimiter?: string },
): Promise<DatasetRecord> {
  const form = new FormData();
  form.append('name', meta.name);
  form.append('namespace', meta.namespace);
  if (meta.description) form.append('description', meta.description);
  form.append('delimiter', meta.delimiter ?? ',');
  form.append('file', file);
  const res = await authenticatedFetch(`${apiBaseUrl}/api/datasets/upload`, { method: 'POST', body: form });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? `Upload fehlgeschlagen (${res.status})`);
  }
  return res.json() as Promise<DatasetRecord>;
}

export type AiImportResult =
  | { impossible: true; reason: string }
  | {
      impossible: false;
      rows: Array<Record<string, string | number | boolean | null>>;
      schema: Array<{ name: string; type: string; nullable: boolean }>;
      strategy: string;
      reasoning: string;
    };

export async function aiImportFile(file: File): Promise<AiImportResult> {
  const form = new FormData();
  form.append('file', file);
  const res = await authenticatedFetch(`${apiBaseUrl}/api/datasets/ai-import`, { method: 'POST', body: form });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? `AI-Import fehlgeschlagen (${res.status})`);
  }
  return res.json() as Promise<AiImportResult>;
}

export interface ArchiveExtractedFile {
  name: string;
  ext: string;
  size: number;
  contentBase64?: string;
}

export interface ImportFormField {
  key: string;
  label: string;
  kind: 'text' | 'password' | 'number' | 'select' | 'checkbox';
  required: boolean;
  placeholder?: string;
  description?: string;
  options?: Array<{ label: string; value: string }>;
}

export interface ImportInputForm {
  title: string;
  description?: string;
  fields: ImportFormField[];
}

export interface ImportNodePreview {
  columns: string[];
  rows: Array<Record<string, string | number | boolean | null>>;
  rowCount: number;
}

export interface ImportTreeNode {
  id: string;
  parentId: string | null;
  label: string;
  kind:
    | 'folder'
    | 'archive'
    | 'file'
    | 'excel-workbook'
    | 'sheet'
    | 'json-array'
    | 'xml-table'
    | 'sqlite-database'
    | 'db-table'
    | 'db-connection';
  status: 'group' | 'ready' | 'needs_input' | 'gap' | 'importing' | 'imported' | 'failed';
  selected: boolean;
  detectedFormat?: string;
  capabilityId?: string;
  sourcePath?: string;
  children: string[];
  diagnostics: string[];
  preview?: ImportNodePreview;
  inputForm?: ImportInputForm;
  config: Record<string, string | number | boolean>;
  metadata?: Record<string, unknown>;
  importedDatasetId?: string;
}

export interface ImportLogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  nodeId?: string;
}

export interface CapabilityGapRecord {
  id: string;
  nodeId: string;
  status: 'open' | 'resolved' | 'blocked';
  missingDimension: 'classify_source' | 'inspect_source' | 'ask_input' | 'runtime_strategy' | 'tool_acquisition' | 'adapter_generation' | 'discover_entities' | 'preview_rows' | 'import_entity' | 'runtime_reload';
  bestKnownNextAction: 'reuse_existing' | 'ask_user_input' | 'compose_existing' | 'extend_existing' | 'acquire_runtime' | 'generate_adapter' | 'reload_runtime' | 'resume_discovery';
  message: string;
  diagnostics: string[];
  reuseCandidateIds: string[];
  attemptCount: number;
  updatedAt: string;
  lastInspector?: {
    nodeId: string;
    nodeLabel: string;
    nodeKind: string;
    sourceClass: 'archive_or_bundle' | 'connection_config' | 'structured_text' | 'tabular_text' | 'binary_structured' | 'binary_runtime_candidate' | 'database_entity' | 'mixed_source' | 'unknown_source';
    detectedFormat?: string;
    sourceExtension?: string;
    diagnostics: string[];
    requiredInputs: string[];
    reuseCandidateIds: string[];
    missingDimension: CapabilityGapRecord['missingDimension'];
    bestKnownNextAction: CapabilityGapRecord['bestKnownNextAction'];
    capabilityGap: string;
  };
  lastPlan?: {
    planType: 'reuse_existing' | 'reuse_with_input' | 'compose_existing' | 'extend_existing' | 'acquire_runtime' | 'generate_adapter' | 'reload_runtime' | 'resume_discovery' | 'blocked';
    targetCapabilityId?: string;
    executionMode?: 'tabular_parser' | 'runtime_adapter' | 'entity_discovery' | 'none';
    strategy?: 'csv' | 'json' | 'xml' | 'javascript' | 'sql-insert-dump' | 'db-discovery' | 'none';
    runtimeFamily?: 'direct_parser' | 'embedded_runtime' | 'connection_runtime' | 'driver_bridge' | 'external_tool_bridge' | 'adapter_layer' | 'none';
    acquisitionPath?: 'builtin_capability' | 'existing_runtime' | 'dependency_install' | 'system_driver' | 'service_binding' | 'tool_bridge' | 'generated_adapter' | 'manual_input' | 'none';
    executionGoals?: Array<'open_source' | 'enumerate_entities' | 'describe_schema' | 'preview_rows' | 'stream_rows_for_import' | 'register_import_path'>;
    params?: Record<string, unknown>;
    reasoning: string;
    expectedOutcome: string;
  };
  lastImplementer?: {
    action: 'apply_existing' | 'collect_input' | 'acquire_runtime' | 'generate_adapter' | 'reload_runtime' | 'resume_discovery' | 'blocked';
    runtimeFamily?: 'direct_parser' | 'embedded_runtime' | 'connection_runtime' | 'driver_bridge' | 'external_tool_bridge' | 'adapter_layer' | 'none';
    acquisitionPath?: 'builtin_capability' | 'existing_runtime' | 'dependency_install' | 'system_driver' | 'service_binding' | 'tool_bridge' | 'generated_adapter' | 'manual_input' | 'none';
    executionGoals?: Array<'open_source' | 'enumerate_entities' | 'describe_schema' | 'preview_rows' | 'stream_rows_for_import' | 'register_import_path'>;
    summary: string;
    steps: string[];
    dependencies: string[];
    targetFiles: string[];
    runtimeArtifacts: string[];
    verificationPlan: string[];
  };
  lastVerifier?: {
    verdict: 'resolved' | 'needs_retry' | 'blocked';
    closedGap: boolean;
    summary: string;
    diagnostics: string[];
    resultingCapabilityId?: string;
  };
}

export interface ImportCapabilityRecord {
  id: string;
  kind: 'connector' | 'plugin' | 'parser' | 'discovery' | 'repair';
  handles: {
    sourceKinds: string[];
    fileExtensions?: string[];
    dbEngines?: string[];
    formats?: string[];
  };
  reusePriority: number;
  dependencies: string[];
  files: string[];
  introducedBy: 'builtin' | 'generated' | 'extended';
  successCount: number;
  lastUsedAt?: string;
  notes?: string;
}

export interface CapabilityRepairTraceRecord {
  id: string;
  nodeId: string;
  createdAt: string;
  updatedAt: string;
  status: 'planned' | 'running' | 'implemented' | 'verified' | 'failed' | 'blocked';
  inspector: NonNullable<CapabilityGapRecord['lastInspector']>;
  planner?: NonNullable<CapabilityGapRecord['lastPlan']>;
  implementer?: NonNullable<CapabilityGapRecord['lastImplementer']>;
  verifier?: NonNullable<CapabilityGapRecord['lastVerifier']>;
  notes: string[];
}

export interface CapabilityExecutionTaskRecord {
  id: string;
  nodeId: string;
  createdAt: string;
  updatedAt: string;
  status: 'running' | 'completed' | 'blocked' | 'failed';
  action: NonNullable<CapabilityGapRecord['lastImplementer']>['action'];
  summary: string;
  steps: string[];
  dependencies: string[];
  targetFiles: string[];
  runtimeArtifacts: string[];
  verificationPlan: string[];
  planType?: NonNullable<CapabilityGapRecord['lastPlan']>['planType'];
  targetCapabilityId?: string;
  sourceClass: NonNullable<CapabilityGapRecord['lastInspector']>['sourceClass'];
  runtimeFamily?: NonNullable<CapabilityGapRecord['lastPlan']>['runtimeFamily'];
  acquisitionPath?: NonNullable<CapabilityGapRecord['lastPlan']>['acquisitionPath'];
  executionGoals?: NonNullable<CapabilityGapRecord['lastPlan']>['executionGoals'];
  diagnostics?: string[];
  notes?: string[];
  artifactPath?: string;
}

export interface ImportSessionRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: 'staged' | 'discovered' | 'running' | 'completed' | 'needs_review' | 'failed';
  rootPath: string;
  rootNodeIds: string[];
  nodes: Record<string, ImportTreeNode>;
  selectedNodeIds: string[];
  log: ImportLogEntry[];
  gaps: CapabilityGapRecord[];
  repairHistory: CapabilityRepairTraceRecord[];
  executionTasks: CapabilityExecutionTaskRecord[];
  capabilityCatalog: ImportCapabilityRecord[];
  summary: {
    totalNodes: number;
    importableNodes: number;
    importedNodes: number;
    failedNodes: number;
  };
}

export async function extractArchive(file: File): Promise<{ files: ArchiveExtractedFile[] }> {
  const form = new FormData();
  form.append('file', file);
  const res = await authenticatedFetch(`${apiBaseUrl}/api/datasets/extract-archive`, { method: 'POST', body: form });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? `Extraktion fehlgeschlagen (${res.status})`);
  }
  return res.json() as Promise<{ files: ArchiveExtractedFile[] }>;
}

export async function createImportSession(files: File[]): Promise<ImportSessionRecord> {
  const form = new FormData();
  for (const file of files) {
    form.append('file', file);
  }
  const res = await authenticatedFetch(`${apiBaseUrl}/api/import/sessions`, { method: 'POST', body: form });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? `Import session creation failed (${res.status})`);
  }
  const body = await res.json() as { session: ImportSessionRecord };
  return body.session;
}

export async function fetchImportSession(sessionId: string): Promise<ImportSessionRecord> {
  const res = await request<{ session: ImportSessionRecord }>(`/api/import/sessions/${encodeURIComponent(sessionId)}`);
  return res.session;
}

export async function updateImportSessionSelection(sessionId: string, selectedNodeIds: string[]): Promise<ImportSessionRecord> {
  const res = await request<{ session: ImportSessionRecord }>(`/api/import/sessions/${encodeURIComponent(sessionId)}/select`, {
    method: 'POST',
    body: JSON.stringify({ selectedNodeIds }),
  });
  return res.session;
}

export async function configureImportNode(
  sessionId: string,
  nodeId: string,
  values: Record<string, string | number | boolean>,
): Promise<ImportSessionRecord> {
  const res = await request<{ session: ImportSessionRecord }>(
    `/api/import/sessions/${encodeURIComponent(sessionId)}/nodes/${encodeURIComponent(nodeId)}/configure`,
    {
      method: 'POST',
      body: JSON.stringify({ values }),
    },
  );
  return res.session;
}

export async function runImportSession(sessionId: string, selectedNodeIds: string[]): Promise<{ session: ImportSessionRecord; importedDatasets: DatasetRecord[] }> {
  return request<{ session: ImportSessionRecord; importedDatasets: DatasetRecord[] }>(
    `/api/import/sessions/${encodeURIComponent(sessionId)}/run`,
    {
      method: 'POST',
      body: JSON.stringify({ selectedNodeIds }),
    },
  );
}

export async function repairImportSession(sessionId: string, nodeIds?: string[]): Promise<{ session: ImportSessionRecord; repairedNodeIds: string[]; unresolvedNodeIds: string[] }> {
  return request<{ session: ImportSessionRecord; repairedNodeIds: string[]; unresolvedNodeIds: string[] }>(
    `/api/import/sessions/${encodeURIComponent(sessionId)}/repair`,
    {
      method: 'POST',
      body: JSON.stringify({ nodeIds }),
    },
  );
}

export async function deleteImportSession(sessionId: string): Promise<void> {
  await request(`/api/import/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
}

export async function uploadInlineDataset(
  rows: Array<Record<string, string | number | boolean | null>>,
  meta: { name: string; namespace: string; description?: string },
): Promise<DatasetRecord> {
  const res = await request('/api/datasets/inline', {
    method: 'POST',
    body: JSON.stringify({ ...meta, rows }),
  });
  return res as DatasetRecord;
}

export async function registerConnectorDataset(body: {
  name: string;
  namespace: string;
  description?: string;
  connectorId: string;
  mode: 'virtual' | 'materialized';
  source: Record<string, unknown>;
}): Promise<DatasetRecord> {
  const res = await request('/api/datasets/register', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return res as DatasetRecord;
}

export async function deleteDataset(datasetId: string): Promise<void> {
  await request(`/api/datasets/${encodeURIComponent(datasetId)}`, { method: 'DELETE' });
}

export async function deleteDatasetsByNamespace(namespace: string): Promise<{ deleted: string[]; count: number }> {
  return request(`/api/datasets?namespace=${encodeURIComponent(namespace)}`, { method: 'DELETE' }) as Promise<{ deleted: string[]; count: number }>;
}

// ── Pipelines ─────────────────────────────────────────────────────────────────

export type FilterOperator = 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains' | 'not_null' | 'is_null';
export type AggregationFn = 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface Aggregation { column: string; fn: AggregationFn; outputName: string; }

export type DeriveExpression =
  | { op: 'copy'; column: string }
  | { op: 'literal'; value: string | number | boolean | null }
  | { op: 'coalesce'; columns: string[]; fallback?: string | number | boolean | null };

export type PipelineStep =
  | { type: 'filter'; column: string; operator: FilterOperator; value?: string }
  | { type: 'select'; columns: string[] }
  | { type: 'rename'; from: string; to: string }
  | { type: 'derive'; column: string; expression: DeriveExpression }
  | { type: 'aggregate'; groupBy: string[]; aggregations: Aggregation[] }
  | { type: 'distinct'; columns?: string[] }
  | { type: 'join'; rightDatasetId: string; leftKey: string; rightKey: string; mode: 'inner' | 'left' };

export interface PipelineDefinition {
  id: string;
  name: string;
  description: string;
  inputDatasetId: string;
  outputName: string;
  outputNamespace: string;
  steps: PipelineStep[];
  lastOutputDatasetId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PipelineRun {
  id: string;
  pipelineId: string;
  status: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  completedAt?: string;
  outputDatasetId?: string;
  rowsIn: number;
  rowsOut: number;
  error?: string;
}

export interface SuggestedPipelineStep {
  step: PipelineStep;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  label: string;
}

export interface PipelineSuggestResult {
  suggestions: SuggestedPipelineStep[];
  summary: string;
}

export interface PipelinePreviewDiagnostics {
  rowsIn: number;
  rowsOut: number;
  changedRows: number;
  newColumns: string[];
  warning: string | null;
}

export interface PipelineDraftPreviewResult {
  preview: DatasetPreviewResult;
  diagnostics: PipelinePreviewDiagnostics;
}

export interface PipelineGlueAuxiliaryDatasetDraft {
  tempId: string;
  name: string;
  namespace: string;
  description?: string;
  connectorId: string;
  mode: 'virtual' | 'materialized';
  source?: Record<string, unknown>;
  rows?: Array<Record<string, string | number | boolean | null>>;
}

export interface PipelineGluePlanAttempt {
  attempt: number;
  title: string;
  summary: string;
  explanation: string;
  confidence: 'high' | 'medium' | 'low';
  auxiliaryDatasets: PipelineGlueAuxiliaryDatasetDraft[];
  steps: PipelineStep[];
  diagnostics: PipelinePreviewDiagnostics | null;
  issues: string[];
}

export interface PipelineGluePlanResult {
  title: string;
  summary: string;
  explanation: string;
  confidence: 'high' | 'medium' | 'low';
  outputNamespace: string;
  outputName: string;
  auxiliaryDatasets: PipelineGlueAuxiliaryDatasetDraft[];
  steps: PipelineStep[];
  preview: DatasetPreviewResult | null;
  diagnostics: PipelinePreviewDiagnostics | null;
  attempts: PipelineGluePlanAttempt[];
  status: 'ready' | 'needs_review';
}

export interface CrosswalkMappingRow {
  leftValue: string;
  rightValue: string | null;
  canonicalValue: string | null;
  confidence: number;
  method: 'exact' | 'normalized' | 'token' | 'fuzzy' | 'reference';
  status: 'matched' | 'ambiguous' | 'unmatched';
  alternatives: Array<{
    rightValue: string;
    confidence: number;
    method: 'exact' | 'normalized' | 'token' | 'fuzzy' | 'reference';
  }>;
}

export interface CrosswalkProposal {
  id: string;
  leftDatasetId: string;
  leftDatasetName: string;
  leftNamespace: string;
  leftColumn: string;
  rightDatasetId: string;
  rightDatasetName: string;
  rightNamespace: string;
  rightColumn: string;
  confidence: number;
  coverage: number;
  directOverlapRatio: number;
  mappingDatasetName: string;
  mappingDatasetNamespace: string;
  mappings: CrosswalkMappingRow[];
  explanation: string;
  sourceType?: 'external_reference' | 'aip_generated' | 'heuristic';
  sourceUri?: string;
  bridgeHint?: string;
}

export interface CrosswalkSuggestResponse {
  items: CrosswalkProposal[];
  summary: string;
}

export interface MaterializeCrosswalkResponse {
  dataset: DatasetRecord;
  augmentedRightDataset?: DatasetRecord;
  joinPlan: {
    firstJoin: Extract<PipelineStep, { type: 'join' }>;
    secondJoin: Extract<PipelineStep, { type: 'join' }>;
  };
}

export async function fetchPipelines(): Promise<PipelineDefinition[]> {
  const res = await request<{ items: PipelineDefinition[] }>('/api/pipelines');
  return res.items;
}

export async function createPipeline(body: Omit<PipelineDefinition, 'id' | 'createdAt' | 'updatedAt' | 'lastOutputDatasetId'>): Promise<PipelineDefinition> {
  return request<PipelineDefinition>('/api/pipelines', { method: 'POST', body: JSON.stringify(body) });
}

export async function updatePipeline(id: string, body: Partial<PipelineDefinition>): Promise<PipelineDefinition> {
  return request<PipelineDefinition>(`/api/pipelines/${id}`, { method: 'PUT', body: JSON.stringify(body) });
}

export async function deletePipeline(id: string): Promise<void> {
  await request(`/api/pipelines/${id}`, { method: 'DELETE' });
}

export async function runPipeline(id: string): Promise<{ run: PipelineRun; outputDatasetId: string }> {
  const res = await request<{ run: PipelineRun; outputDataset: { id: string } }>(`/api/pipelines/${id}/run`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  return { run: res.run, outputDatasetId: res.outputDataset.id };
}

export async function fetchPipelineRuns(pipelineId: string): Promise<PipelineRun[]> {
  const res = await request<{ items: PipelineRun[] }>(`/api/pipelines/${pipelineId}/runs`);
  return res.items;
}

export async function suggestPipelineSteps(
  primaryDatasetId: string,
  secondaryDatasetId?: string,
): Promise<PipelineSuggestResult> {
  return request<PipelineSuggestResult>('/api/pipelines/suggest', {
    method: 'POST',
    body: JSON.stringify({ primaryDatasetId, secondaryDatasetId }),
  });
}

export async function previewPipelineDraft(body: {
  inputDatasetId: string;
  steps: PipelineStep[];
  limit?: number;
}): Promise<PipelineDraftPreviewResult> {
  return request<PipelineDraftPreviewResult>('/api/pipelines/preview', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function planPipelineGlue(body: {
  inputDatasetId: string;
  secondaryDatasetIds?: string[];
  currentSteps?: PipelineStep[];
  intent?: string;
  outputNamespace?: string;
  outputName?: string;
  maxAttempts?: number;
  crosswalkHints?: CrosswalkProposal[];
}, timeoutMs = 60_000): Promise<PipelineGluePlanResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await request<PipelineGluePlanResult>('/api/pipelines/glue-plan', {
      method: 'POST',
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('AIP Glue Plan timeout (>60s). Bitte erneut versuchen.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function suggestCrosswalks(
  leftDatasetId: string,
  rightDatasetId: string,
): Promise<CrosswalkSuggestResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
  try {
    return await request<CrosswalkSuggestResponse>('/api/crosswalks/suggest', {
      method: 'POST',
      body: JSON.stringify({ leftDatasetId, rightDatasetId }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { items: [], summary: 'Crosswalk-Analyse Timeout (>35s). Ergebnis unvollständig.' };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function materializeCrosswalk(
  proposal: CrosswalkProposal,
): Promise<MaterializeCrosswalkResponse> {
  return request<MaterializeCrosswalkResponse>('/api/crosswalks/materialize', {
    method: 'POST',
    body: JSON.stringify({
      leftDatasetId: proposal.leftDatasetId,
      leftColumn: proposal.leftColumn,
      rightDatasetId: proposal.rightDatasetId,
      rightColumn: proposal.rightColumn,
      mappings: proposal.mappings,
      mappingDatasetName: proposal.mappingDatasetName,
      mappingDatasetNamespace: proposal.mappingDatasetNamespace,
    }),
  });
}

// ── Checks ────────────────────────────────────────────────────────────────────

export type CheckRuleType = 'not_null' | 'unique' | 'regex' | 'in_range' | 'min_rows' | 'allowed_values';

export interface CheckRule {
  id: string;
  column?: string;
  ruleType: CheckRuleType;
  params?: { pattern?: string; min?: number; max?: number; values?: string[] };
  errorMessage?: string;
}

export interface CheckDefinition {
  id: string;
  name: string;
  description: string;
  datasetId: string;
  rules: CheckRule[];
  createdAt: string;
  updatedAt: string;
  latestRun?: CheckRun | null;
}

export interface RuleResult {
  ruleId: string;
  ruleType: CheckRuleType;
  column?: string;
  passed: boolean;
  failureCount: number;
  totalChecked: number;
  message: string;
}

export interface CheckRun {
  id: string;
  checkId: string;
  datasetId: string;
  status: 'passed' | 'failed' | 'warning';
  ruleResults: RuleResult[];
  executedAt: string;
  rowsChecked: number;
}

export async function fetchChecks(datasetId?: string): Promise<CheckDefinition[]> {
  const url = datasetId ? `/api/checks?datasetId=${encodeURIComponent(datasetId)}` : '/api/checks';
  const res = await request<{ items: CheckDefinition[] }>(url);
  return res.items;
}

export async function createCheck(body: { name: string; description: string; datasetId: string; rules: Omit<CheckRule, 'id'>[] }): Promise<CheckDefinition> {
  return request<CheckDefinition>('/api/checks', { method: 'POST', body: JSON.stringify(body) });
}

export async function deleteCheck(id: string): Promise<void> {
  await request(`/api/checks/${id}`, { method: 'DELETE' });
}

export async function runCheck(id: string): Promise<CheckRun> {
  return request<CheckRun>(`/api/checks/${id}/run`, { method: 'POST' });
}

// ── Actions ───────────────────────────────────────────────────────────────────

export interface ActionDefinition {
  name: string;
  moduleId: string;
  contractVersion: number;
  input: string;
  permissions: string[];
  sideEffects: string[];
  executable: boolean;
  unavailableReason?: string;
}

export interface ActionResult {
  action: string;
  moduleId: string;
  objectType: string;
  objectId: string;
  executedAt: string;
  status: string;
  message: string;
}

export async function fetchActions(): Promise<ActionDefinition[]> {
  const res = await request<{ items: ActionDefinition[] }>('/api/actions');
  return res.items;
}

export async function executeAction(actionName: string, objectType: string, objectId: string, params?: Record<string, unknown>): Promise<ActionResult> {
  return request<ActionResult>(`/api/actions/${encodeURIComponent(actionName)}/execute`, {
    method: 'POST',
    body: JSON.stringify({ objectType, objectId, params }),
  });
}

// ── AIP ───────────────────────────────────────────────────────────────────────

export type AipRole = 'system' | 'user' | 'assistant';
export interface AipMessage { role: AipRole; content: string; }

export type AipReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface AipProviderConfig {
  provider: 'openai' | 'anthropic' | 'ollama' | 'custom';
  baseUrl: string;
  apiKey?: string;
  model: string;
  reasoningEffort?: AipReasoningEffort;
  systemPrompt?: string;
  hasKey?: boolean;
  clearKey?: boolean;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: AipMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface AipChatResponse {
  sessionId: string;
  message: AipMessage;
  usage?: { promptTokens: number; completionTokens: number };
  model: string;
  provider: string;
}

export interface AipContext {
  datasetRows?: Array<Record<string, unknown>>;
  datasetName?: string;
  objectAttributes?: Record<string, unknown>;
  objectType?: string;
  objectId?: string;
  extra?: string;
}

export async function fetchAipConfig(): Promise<AipProviderConfig | null> {
  const res = await request<{ config: AipProviderConfig | null }>('/api/aip/config');
  return res.config;
}

export interface AipConfiguration { config: AipProviderConfig | null; revision: string }
export function fetchAipConfiguration(): Promise<AipConfiguration> { return request('/api/aip/config'); }
export async function saveAipConfig(config: AipProviderConfig & { revision: string }): Promise<AipConfiguration> {
  return request('/api/aip/config', { method: 'PUT', body: JSON.stringify(config) });
}

export async function fetchAipSessions(): Promise<ChatSession[]> {
  const res = await request<{ items: ChatSession[] }>('/api/aip/sessions');
  return res.items;
}

export async function deleteAipSession(id: string): Promise<void> {
  await request(`/api/aip/sessions/${id}`, { method: 'DELETE' });
}

export async function sendAipMessage(body: {
  sessionId?: string;
  message: string;
  context?: AipContext;
  maxTokens?: number;
}): Promise<AipChatResponse> {
  return request<AipChatResponse>('/api/aip/chat', { method: 'POST', body: JSON.stringify(body) });
}

// ── App Store ─────────────────────────────────────────────────────────────────

export interface AppEntry {
  id: string;
  name: string;
  description: string;
  category: 'legacy' | 'sandbox';
  icon: string;
  version: string;
  author: string;
  license: string;
  homepage: string;
  tags: string[];
  requires: string[];
  installed: boolean;
  enabled: boolean;
}

export async function fetchAppStore(): Promise<AppEntry[]> {
  const res = await request<{ items: AppEntry[] }>('/api/appstore');
  return res.items;
}

export async function installApp(appId: string): Promise<AppEntry[]> {
  const res = await request<{ items: AppEntry[] }>(`/api/appstore/${encodeURIComponent(appId)}/install`, { method: 'POST' });
  return res.items;
}

export async function uninstallApp(appId: string): Promise<AppEntry[]> {
  const res = await request<{ items: AppEntry[] }>(`/api/appstore/${encodeURIComponent(appId)}/uninstall`, { method: 'POST' });
  return res.items;
}
