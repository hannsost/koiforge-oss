export interface DiscoveryDatasetInput {
  datasetId: string;
  datasetName: string;
  namespace: string;
  columns: string[];
  rows: Array<Record<string, string | number | boolean | null>>;
}

export interface ColumnProfile {
  datasetId: string;
  column: string;
  rowCount: number;
  nullCount: number;
  distinctCount: number;
  uniquenessRatio: number;
  typeHints: string[];
  sampleValues: string[];
}

export interface DatasetProfile {
  datasetId: string;
  datasetName: string;
  namespace: string;
  columns: ColumnProfile[];
}

export interface RelationshipSuggestion {
  fromDatasetId: string;
  fromColumn: string;
  toDatasetId: string;
  toColumn: string;
  confidence: number;
  confidenceLabel: 'high' | 'medium' | 'low';
  suggestionType: 'exact-key' | 'reference-key' | 'semantic-match' | 'geo-match';
  reasons: string[];
}

export interface DiscoveryReport {
  profiles: DatasetProfile[];
  suggestions: RelationshipSuggestion[];
}

