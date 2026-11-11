export type AssetKind = 'dataset' | 'job' | 'transform' | 'view';
export type AssetStatus = 'draft' | 'active' | 'stale';
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type LineageEventType = 'lineage.edge-recorded' | 'run.recorded' | 'asset.registered';

export interface AssetRecord {
  id: string;
  name: string;
  kind: AssetKind;
  tenantId: string;
  datasetId?: string;
  owner?: string;
  domain?: string;
  description?: string;
  status: AssetStatus;
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
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  triggeredBy: string;
  summary?: string;
}

export interface LineageEvent {
  id: string;
  type: LineageEventType;
  subjectId: string;
  timestamp: string;
  details?: string;
}

export interface AssetLineageState {
  assets: Record<string, AssetRecord>;
  edges: LineageEdge[];
  runs: RunRecord[];
  events: LineageEvent[];
}

export interface AssetUpsertInput {
  id?: string;
  name: string;
  kind: AssetKind;
  tenantId: string;
  datasetId?: string;
  owner?: string;
  domain?: string;
  description?: string;
  status?: AssetStatus;
  tags?: string[];
}

export interface LineageEdgeInput {
  fromAssetId: string;
  toAssetId: string;
  operation: string;
}

export interface RunRecordInput {
  assetId: string;
  status: RunStatus;
  triggeredBy: string;
  summary?: string;
}

export interface FileAssetLineageRegistryOptions {
  filePath: string;
}

