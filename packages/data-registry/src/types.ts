export type DatasetFieldType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'json';

export type DatasetMode = 'virtual' | 'materialized';
export type DatasetStatus = 'registered' | 'ready' | 'stale';
export type ConnectorCategory = 'file' | 'database' | 'object-storage' | 'stream';
export type DataEventType = 'dataset.registered' | 'dataset.snapshotted' | 'dataset.schema-updated' | 'dataset.uploaded' | 'dataset.deleted';

export interface InlineDatasetInput {
  name: string;
  namespace: string;
  description?: string;
  rows: Array<Record<string, string | number | boolean | null>>;
  tags?: string[];
}

export interface DatasetField {
  name: string;
  type: DatasetFieldType;
  nullable?: boolean;
  description?: string;
}

export interface DatasetSqlAccess {
  catalog: string;
  schema: string;
  table: string;
  queryPreview: string;
}

export interface DatasetSnapshot {
  id: string;
  createdAt: string;
  reason: string;
}

export type DatasetPreviewCell = string | number | boolean | null;

export interface DatasetPreviewResult {
  datasetId: string;
  columns: string[];
  rows: Array<Record<string, DatasetPreviewCell>>;
  rowCount: number;
  truncated: boolean;
}

export interface DatasetRecord {
  id: string;
  name: string;
  namespace: string;
  description?: string;
  connectorId: string;
  connectorCategory: ConnectorCategory;
  mode: DatasetMode;
  status: DatasetStatus;
  source: Record<string, unknown>;
  schema: DatasetField[];
  sqlAccess: DatasetSqlAccess;
  snapshots: DatasetSnapshot[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DataEvent {
  id: string;
  type: DataEventType;
  datasetId: string;
  timestamp: string;
  details?: string;
}

export interface DatasetRegistryState {
  datasets: Record<string, DatasetRecord>;
  events: DataEvent[];
}

export interface ConnectorConfigField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'json';
  required?: boolean;
  description?: string;
}

export interface SchemaDiscoveryResult {
  fields: DatasetField[];
  summary: string;
}

export interface ConnectorDefinition {
  id: string;
  name: string;
  category: ConnectorCategory;
  capabilities: string[];
  configFields: ConnectorConfigField[];
  discoverSchema(config: Record<string, unknown>): SchemaDiscoveryResult;
}

export interface DatasetRegistrationInput {
  name: string;
  namespace: string;
  description?: string;
  connectorId: string;
  mode: DatasetMode;
  source: Record<string, unknown>;
  tags?: string[];
}
