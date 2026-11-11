import type {
  ColumnProfile,
  DatasetProfile,
  DiscoveryDatasetInput,
  DiscoveryReport,
  RelationshipSuggestion,
} from './types.js';

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function tokenizeColumnName(value: string): string[] {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function detectTypeHints(values: Array<string | number | boolean | null>): string[] {
  const hints = new Set<string>();

  for (const value of values) {
    if (value == null) continue;
    if (typeof value === 'number') hints.add('number');
    if (typeof value === 'boolean') hints.add('boolean');
    const text = String(value);
    if (/^[A-Z]{2}$/.test(text)) hints.add('country-code');
    if (/^[A-Z]{2,4}-?[0-9A-Z]+$/i.test(text)) hints.add('business-key');
    if (/^-?\d+(\.\d+)?$/.test(text)) hints.add('numeric-string');
    if (/^[A-Z]{2,4}$/.test(text)) hints.add('short-code');
  }

  if (hints.size === 0) hints.add('string');
  return [...hints].sort();
}

function profileColumn(datasetId: string, column: string, rows: Array<Record<string, string | number | boolean | null>>): ColumnProfile {
  const values = rows.map((row) => row[column] ?? null);
  const nonNullValues = values.filter((value) => value != null).map((value) => String(value));
  const distinct = new Set(nonNullValues.map((value) => normalizeToken(value)));
  const nullCount = values.length - nonNullValues.length;

  return {
    datasetId,
    column,
    rowCount: rows.length,
    nullCount,
    distinctCount: distinct.size,
    uniquenessRatio: rows.length === 0 ? 0 : distinct.size / rows.length,
    typeHints: detectTypeHints(values),
    sampleValues: [...new Set(nonNullValues)].slice(0, 5),
  };
}

function profileDataset(input: DiscoveryDatasetInput): DatasetProfile {
  return {
    datasetId: input.datasetId,
    datasetName: input.datasetName,
    namespace: input.namespace,
    columns: input.columns.map((column) => profileColumn(input.datasetId, column, input.rows)),
  };
}

function overlapRatio(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left.map(normalizeToken));
  const rightSet = new Set(right.map(normalizeToken));
  let overlap = 0;
  for (const value of leftSet) {
    if (rightSet.has(value)) overlap += 1;
  }
  return overlap / Math.min(leftSet.size || 1, rightSet.size || 1);
}

function nameSimilarity(left: string, right: string): number {
  const leftTokens = tokenizeColumnName(left);
  const rightTokens = tokenizeColumnName(right);
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;
  let matches = 0;
  for (const token of leftTokens) {
    if (rightTokens.includes(token)) matches += 1;
  }
  return matches / Math.max(leftTokens.length, rightTokens.length);
}

function label(confidence: number): 'high' | 'medium' | 'low' {
  if (confidence >= 0.85) return 'high';
  if (confidence >= 0.6) return 'medium';
  return 'low';
}

function inferSuggestionType(from: ColumnProfile, to: ColumnProfile): RelationshipSuggestion['suggestionType'] {
  const fromName = from.column.toLowerCase();
  const toName = to.column.toLowerCase();
  if (fromName.endsWith('id') && toName.endsWith('id')) return 'exact-key';
  if (fromName.includes('country') && toName.includes('country')) return 'geo-match';
  if (fromName.includes('code') || toName.includes('code')) return 'reference-key';
  return 'semantic-match';
}

function buildSuggestions(inputs: DiscoveryDatasetInput[], profiles: DatasetProfile[]): RelationshipSuggestion[] {
  const suggestions: RelationshipSuggestion[] = [];

  for (let leftIndex = 0; leftIndex < inputs.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < inputs.length; rightIndex += 1) {
      const left = inputs[leftIndex]!;
      const right = inputs[rightIndex]!;
      const leftProfile = profiles[leftIndex]!;
      const rightProfile = profiles[rightIndex]!;

      for (const leftColumn of leftProfile.columns) {
        for (const rightColumn of rightProfile.columns) {
          const reasons: string[] = [];
          let confidence = 0;

          const nameScore = nameSimilarity(leftColumn.column, rightColumn.column);
          if (nameScore >= 0.66) {
            confidence += 0.35;
            reasons.push('column_name_similarity');
          }

          const leftValues = left.rows.map((row) => row[leftColumn.column] ?? null).filter((value) => value != null).map((value) => String(value));
          const rightValues = right.rows.map((row) => row[rightColumn.column] ?? null).filter((value) => value != null).map((value) => String(value));
          const overlap = overlapRatio(leftValues, rightValues);
          if (overlap >= 0.5) {
            confidence += 0.45;
            reasons.push('high_value_overlap');
          } else if (overlap >= 0.2) {
            confidence += 0.25;
            reasons.push('partial_value_overlap');
          }

          const keyLike = leftColumn.uniquenessRatio >= 0.5 && rightColumn.uniquenessRatio >= 0.3;
          if (keyLike) {
            confidence += 0.1;
            reasons.push('key_like_cardinality');
          }

          const sharedHints = leftColumn.typeHints.filter((hint) => rightColumn.typeHints.includes(hint));
          if (sharedHints.length > 0) {
            confidence += 0.1;
            reasons.push(`shared_type_hints:${sharedHints.join('|')}`);
          }

          if (confidence < 0.5) continue;

          suggestions.push({
            fromDatasetId: left.datasetId,
            fromColumn: leftColumn.column,
            toDatasetId: right.datasetId,
            toColumn: rightColumn.column,
            confidence: Math.min(confidence, 0.99),
            confidenceLabel: label(confidence),
            suggestionType: inferSuggestionType(leftColumn, rightColumn),
            reasons,
          });
        }
      }
    }
  }

  return suggestions.sort((left, right) => right.confidence - left.confidence).slice(0, 50);
}

export function buildDiscoveryReport(inputs: DiscoveryDatasetInput[]): DiscoveryReport {
  const profiles = inputs.map(profileDataset);
  const suggestions = buildSuggestions(inputs, profiles);
  return { profiles, suggestions };
}

