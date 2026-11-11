export type CrosswalkMatchMethod =
  | 'exact'
  | 'normalized'
  | 'token'
  | 'fuzzy'
  | 'reference';

export type CrosswalkMappingStatus = 'matched' | 'ambiguous' | 'unmatched';

export interface CrosswalkColumnProfile {
  datasetId: string;
  datasetName: string;
  namespace: string;
  column: string;
  values: Array<string | number | boolean | null>;
}

export interface CrosswalkReferenceEntry {
  canonicalValue: string;
  aliases: string[];
}

export interface CrosswalkMapping {
  leftValue: string;
  rightValue: string | null;
  canonicalValue: string | null;
  confidence: number;
  method: CrosswalkMatchMethod;
  status: CrosswalkMappingStatus;
  alternatives: Array<{
    rightValue: string;
    confidence: number;
    method: CrosswalkMatchMethod;
  }>;
}

export interface CrosswalkSuggestInput {
  left: CrosswalkColumnProfile;
  right: CrosswalkColumnProfile;
  referenceEntries?: CrosswalkReferenceEntry[];
  maxSuggestionsPerValue?: number;
  minConfidence?: number;
}

export interface CrosswalkSuggestionResult {
  left: Omit<CrosswalkColumnProfile, 'values'> & { distinctCount: number };
  right: Omit<CrosswalkColumnProfile, 'values'> & { distinctCount: number };
  mappings: CrosswalkMapping[];
  summary: {
    matched: number;
    ambiguous: number;
    unmatched: number;
    totalLeftValues: number;
  };
}
