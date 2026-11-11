export interface LinkingDatasetInput {
  datasetId: string;
  datasetName: string;
  rows: Array<Record<string, string | number | boolean | null>>;
}

export interface LinkingHint {
  fromDatasetId: string;
  fromColumn: string;
  toDatasetId: string;
  toColumn: string;
  confidence: number;
  confidenceLabel: 'high' | 'medium' | 'low';
  suggestionType: 'exact-key' | 'reference-key' | 'semantic-match' | 'geo-match';
  reasons: string[];
}

export interface EntityLink {
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
}

export interface CanonicalCluster {
  datasetId: string;
  entityType: string;
  clusterKey: string;
  confidence: number;
  confidenceLabel: 'high' | 'medium' | 'low';
  members: Array<{ rowKey: string; label: string }>;
  conflicts: string[];
}

export interface CandidateStats {
  hintCount: number;
  bucketCount: number;
  rowComparisonsEstimated: number;
  candidatePairsGenerated: number;
  blockedPairsSkipped: number;
  finalLinkCount: number;
}

export interface IdentityLinkingReport {
  links: EntityLink[];
  clusters: CanonicalCluster[];
  candidateStats: CandidateStats;
}
