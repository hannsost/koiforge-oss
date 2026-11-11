import type {
  CrosswalkMapping,
  CrosswalkMatchMethod,
  CrosswalkReferenceEntry,
  CrosswalkSuggestInput,
  CrosswalkSuggestionResult,
} from './types.js';

interface ValueCandidate {
  rightValue: string;
  confidence: number;
  method: CrosswalkMatchMethod;
  canonicalValue: string;
}

interface ReferenceIndex {
  exactAliases: Map<string, string>;
  entries: Array<{
    canonicalValue: string;
    aliases: string[];
  }>;
}

function stringifyValue(value: string | number | boolean | null): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

function normalizeValue(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function tokenizeValue(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function distinctValues(values: Array<string | number | boolean | null>): string[] {
  return [...new Set(values.map(stringifyValue).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function buildReferenceIndex(referenceEntries: CrosswalkReferenceEntry[] = []): ReferenceIndex {
  const exactAliases = new Map<string, string>();
  const entries: ReferenceIndex['entries'] = [];

  for (const entry of referenceEntries) {
    const canonicalValue = stringifyValue(entry.canonicalValue);
    if (!canonicalValue) continue;

    const aliases = new Set<string>([canonicalValue]);
    exactAliases.set(normalizeValue(canonicalValue), canonicalValue);

    for (const alias of entry.aliases) {
      const aliasValue = stringifyValue(alias);
      if (!aliasValue) continue;
      aliases.add(aliasValue);
      exactAliases.set(normalizeValue(aliasValue), canonicalValue);
    }

    entries.push({ canonicalValue, aliases: [...aliases] });
  }

  return { exactAliases, entries };
}

function tokenSimilarity(leftValue: string, rightValue: string): number {
  const leftTokens = new Set(tokenizeValue(leftValue));
  const rightTokens = new Set(tokenizeValue(rightValue));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }

  return (2 * overlap) / (leftTokens.size + rightTokens.size);
}

function isCodeLikeValue(value: string): boolean {
  return /^[A-Z0-9]{1,5}$/.test(value.trim());
}

function canonicalFitsRightDomain(canonicalValue: string, rightValues: string[]): boolean {
  if (rightValues.length === 0) return true;
  const rightCodeLikeRatio = rightValues.filter((value) => isCodeLikeValue(value)).length / rightValues.length;
  const canonicalCodeLike = isCodeLikeValue(canonicalValue);

  if (canonicalCodeLike && rightCodeLikeRatio < 0.5) return false;
  if (!canonicalCodeLike && rightCodeLikeRatio >= 0.8) return false;
  return true;
}

function prefixSimilarity(leftNorm: string, rightNorm: string): number {
  if (leftNorm.length < 4 || rightNorm.length < 4) return 0;
  if (leftNorm.includes(rightNorm) || rightNorm.includes(leftNorm)) return 0.82;

  const maxPrefix = Math.min(leftNorm.length, rightNorm.length);
  let prefixLength = 0;
  while (prefixLength < maxPrefix && leftNorm[prefixLength] === rightNorm[prefixLength]) {
    prefixLength += 1;
  }

  if (prefixLength < 4) return 0;
  return Math.min(0.8, 0.6 + prefixLength / Math.max(leftNorm.length, rightNorm.length) * 0.2);
}

function resolveReferenceCanonical(value: string, referenceIndex: ReferenceIndex): string | null {
  const exactMatch = referenceIndex.exactAliases.get(normalizeValue(value));
  if (exactMatch) return exactMatch;

  for (const entry of referenceIndex.entries) {
    for (const alias of entry.aliases) {
      if (
        tokenSimilarity(value, alias) >= 0.66
        || prefixSimilarity(normalizeValue(value), normalizeValue(alias)) >= 0.75
      ) {
        return entry.canonicalValue;
      }
    }
  }

  return null;
}

function scoreValuePair(
  leftValue: string,
  rightValue: string,
  referenceIndex: ReferenceIndex,
): Pick<ValueCandidate, 'confidence' | 'method' | 'canonicalValue'> | null {
  const leftNorm = normalizeValue(leftValue);
  const rightNorm = normalizeValue(rightValue);
  if (!leftNorm || !rightNorm) return null;

  const leftReference = resolveReferenceCanonical(leftValue, referenceIndex);
  const rightReference = resolveReferenceCanonical(rightValue, referenceIndex);
  if (leftReference && rightReference && leftReference === rightReference) {
    return {
      confidence: leftNorm === rightNorm ? 1 : 0.99,
      method: leftNorm === rightNorm ? 'exact' : 'reference',
      canonicalValue: leftReference,
    };
  }

  if (leftNorm === rightNorm) {
    return { confidence: 0.97, method: 'normalized', canonicalValue: rightValue };
  }

  const tokenScore = tokenSimilarity(leftValue, rightValue);
  if (tokenScore >= 0.8) {
    return { confidence: 0.9, method: 'token', canonicalValue: rightValue };
  }

  const fuzzyScore = prefixSimilarity(leftNorm, rightNorm);
  if (fuzzyScore > 0) {
    return { confidence: fuzzyScore, method: 'fuzzy', canonicalValue: rightValue };
  }

  return null;
}

export function suggestCrosswalk(input: CrosswalkSuggestInput): CrosswalkSuggestionResult {
  const minConfidence = Math.max(0, Math.min(1, input.minConfidence ?? 0.72));
  const maxSuggestionsPerValue = Math.max(1, Math.min(10, input.maxSuggestionsPerValue ?? 3));
  const leftValues = distinctValues(input.left.values);
  const rightValues = distinctValues(input.right.values);
  const referenceIndex = buildReferenceIndex(input.referenceEntries);

  const mappings = leftValues.map((leftValue): CrosswalkMapping => {
    const candidates = rightValues
      .map((rightValue): ValueCandidate | null => {
        const score = scoreValuePair(leftValue, rightValue, referenceIndex);
        return score ? { rightValue, ...score } : null;
      })
      .filter((candidate): candidate is ValueCandidate => Boolean(candidate))
      .filter((candidate) => candidate.confidence >= minConfidence)
      .sort((a, b) => b.confidence - a.confidence || a.rightValue.localeCompare(b.rightValue))
      .slice(0, maxSuggestionsPerValue);

    const best = candidates[0];
    if (!best) {
      const fallbackCanonical = resolveReferenceCanonical(leftValue, referenceIndex);
      if (fallbackCanonical && canonicalFitsRightDomain(fallbackCanonical, rightValues)) {
        return {
          leftValue,
          rightValue: null,
          canonicalValue: fallbackCanonical,
          confidence: 0.9,
          method: 'reference',
          status: 'matched',
          alternatives: [],
        };
      }

      return {
        leftValue,
        rightValue: null,
        canonicalValue: null,
        confidence: 0,
        method: 'fuzzy',
        status: 'unmatched',
        alternatives: [],
      };
    }

    const second = candidates[1];
    return {
      leftValue,
      rightValue: best.rightValue,
      canonicalValue: best.canonicalValue,
      confidence: best.confidence,
      method: best.method,
      status: second && best.confidence - second.confidence < 0.03 ? 'ambiguous' : 'matched',
      alternatives: candidates.slice(1).map((candidate) => ({
        rightValue: candidate.rightValue,
        confidence: candidate.confidence,
        method: candidate.method,
      })),
    };
  });

  return {
    left: {
      datasetId: input.left.datasetId,
      datasetName: input.left.datasetName,
      namespace: input.left.namespace,
      column: input.left.column,
      distinctCount: leftValues.length,
    },
    right: {
      datasetId: input.right.datasetId,
      datasetName: input.right.datasetName,
      namespace: input.right.namespace,
      column: input.right.column,
      distinctCount: rightValues.length,
    },
    mappings,
    summary: {
      matched: mappings.filter((entry) => entry.status === 'matched').length,
      ambiguous: mappings.filter((entry) => entry.status === 'ambiguous').length,
      unmatched: mappings.filter((entry) => entry.status === 'unmatched').length,
      totalLeftValues: mappings.length,
    },
  };
}


