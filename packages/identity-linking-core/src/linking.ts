import type {
  CandidateStats,
  CanonicalCluster,
  EntityLink,
  IdentityLinkingReport,
  LinkingDatasetInput,
  LinkingHint,
} from './types.js';

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function label(confidence: number): 'high' | 'medium' | 'low' {
  if (confidence >= 0.85) return 'high';
  if (confidence >= 0.6) return 'medium';
  return 'low';
}

function rowKey(datasetId: string, row: Record<string, string | number | boolean | null>, index: number): string {
  const preferred = row.id ?? row.ident ?? row.poNumber ?? row.supplierId ?? row.shipmentId ?? row.name;
  return `${datasetId}:${preferred == null ? index + 1 : String(preferred)}`;
}

function bestLabel(row: Record<string, string | number | boolean | null>, index: number): string {
  return String(row.name ?? row.title ?? row.poNumber ?? row.ident ?? row.id ?? `row-${index + 1}`);
}

function blockingTokens(value: string): string[] {
  const normalized = normalize(value);
  const tokens = value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 0);
  const firstToken = tokens[0] ?? '';
  const prefixes = new Set<string>();

  if (normalized.length > 0) prefixes.add(normalized.slice(0, 3));
  if (firstToken.length > 0) prefixes.add(firstToken.slice(0, 3));
  if (tokens.length > 1) prefixes.add(tokens.map((token) => token[0]).join(''));

  return [...prefixes].filter((token) => token.length > 0);
}

function buildBlockingKeys(row: Record<string, string | number | boolean | null>, primaryColumn: string): string[] {
  const primaryValue = String(row[primaryColumn] ?? '');
  const countryValue = String(row.country ?? row.countryCode ?? row.iso_country ?? row.iso_country_code ?? '');

  const keys = new Set<string>();
  for (const token of blockingTokens(primaryValue)) {
    keys.add(token);
    keys.add(countryValue ? `${countryValue.toLowerCase()}|${token}` : token);
  }

  if (keys.size === 0 && primaryValue.trim().length > 0) {
    keys.add(primaryValue.toLowerCase());
  }

  return [...keys];
}

function buildLinks(datasets: LinkingDatasetInput[], hints: LinkingHint[]): { links: EntityLink[]; stats: CandidateStats } {
  const byId = new Map(datasets.map((dataset) => [dataset.datasetId, dataset]));
  const links: EntityLink[] = [];
  let rowComparisonsEstimated = 0;
  let candidatePairsGenerated = 0;
  let bucketCount = 0;

  for (const hint of hints) {
    if (hint.confidence < 0.6) continue;

    const fromDataset = byId.get(hint.fromDatasetId);
    const toDataset = byId.get(hint.toDatasetId);
    if (!fromDataset || !toDataset) continue;

    rowComparisonsEstimated += fromDataset.rows.length * toDataset.rows.length;

    const index = new Map<string, Array<{ row: Record<string, string | number | boolean | null>; key: string }>>();
    toDataset.rows.forEach((row, rowIndex) => {
      const value = row[hint.toColumn];
      const baseValue = String(value ?? '');
      if (!baseValue.trim()) return;
      for (const blockKey of buildBlockingKeys(row, hint.toColumn)) {
        const bucket = index.get(blockKey) ?? [];
        bucket.push({ row, key: rowKey(toDataset.datasetId, row, rowIndex) });
        index.set(blockKey, bucket);
      }
    });
    bucketCount += index.size;

    fromDataset.rows.forEach((row, rowIndex) => {
      const fromValueRaw = row[hint.fromColumn];
      const fromValue = String(fromValueRaw ?? '');
      const normalized = normalize(fromValue);
      if (!normalized) return;
      const candidates = buildBlockingKeys(row, hint.fromColumn).flatMap((blockKey) => index.get(blockKey) ?? []);
      candidatePairsGenerated += candidates.length;

      for (const candidate of candidates.slice(0, 5)) {
        const candidateValue = String(candidate.row[hint.toColumn] ?? '');
        const normalizedCandidate = normalize(candidateValue);
        const exactRequired = hint.suggestionType === 'exact-key' || hint.suggestionType === 'reference-key';
        if (exactRequired && normalized !== normalizedCandidate) {
          continue;
        }

        links.push({
          fromDatasetId: fromDataset.datasetId,
          fromRowKey: rowKey(fromDataset.datasetId, row, rowIndex),
          fromColumn: hint.fromColumn,
          fromValue,
          toDatasetId: toDataset.datasetId,
          toRowKey: candidate.key,
          toColumn: hint.toColumn,
          toValue: candidateValue,
          confidence: Math.min(hint.confidence + 0.05, 0.99),
          confidenceLabel: label(Math.min(hint.confidence + 0.05, 0.99)),
          reasons: [...hint.reasons, 'normalized_value_match'],
        });
      }
    });
  }

  const unique = new Map<string, EntityLink>();
  for (const link of links) {
    const key = `${link.fromRowKey}->${link.toRowKey}`;
    const existing = unique.get(key);
    if (!existing || link.confidence > existing.confidence) unique.set(key, link);
  }

  const finalLinks = [...unique.values()].sort((left, right) => right.confidence - left.confidence).slice(0, 200);
  const stats: CandidateStats = {
    hintCount: hints.filter((hint) => hint.confidence >= 0.6).length,
    bucketCount,
    rowComparisonsEstimated,
    candidatePairsGenerated,
    blockedPairsSkipped: Math.max(rowComparisonsEstimated - candidatePairsGenerated, 0),
    finalLinkCount: finalLinks.length,
  };

  return { links: finalLinks, stats };
}

function buildClusters(datasets: LinkingDatasetInput[]): CanonicalCluster[] {
  const clusters: CanonicalCluster[] = [];

  for (const dataset of datasets) {
    const hasName = dataset.rows.some((row) => typeof row.name === 'string');
    if (!hasName) continue;

    const groups = new Map<string, Array<{ row: Record<string, string | number | boolean | null>; rowKey: string; label: string }>>();
    dataset.rows.forEach((row, index) => {
      const name = String(row.name ?? '');
      if (!name) return;
      const country = String(row.country ?? row.countryCode ?? row.iso_country ?? '');
      const key = `${normalize(name)}|${normalize(country)}`;
      const bucket = groups.get(key) ?? [];
      bucket.push({ row, rowKey: rowKey(dataset.datasetId, row, index), label: bestLabel(row, index) });
      groups.set(key, bucket);
    });

    for (const [key, members] of groups.entries()) {
      if (members.length < 2) continue;
      const statuses = [...new Set(members.map((entry) => String(entry.row.status ?? '')).filter(Boolean))];
      const ids = [...new Set(members.map((entry) => String(entry.row.supplierId ?? entry.row.id ?? '')).filter(Boolean))];
      const conflicts: string[] = [];
      if (statuses.length > 1) conflicts.push('status');
      if (ids.length > 1) conflicts.push('identifier');

      const confidence = conflicts.length > 0 ? 0.72 : 0.9;
      clusters.push({
        datasetId: dataset.datasetId,
        entityType: 'entity',
        clusterKey: key,
        confidence,
        confidenceLabel: label(confidence),
        members: members.map((entry) => ({ rowKey: entry.rowKey, label: entry.label })),
        conflicts,
      });
    }
  }

  return clusters;
}

export function buildIdentityLinkingReport(datasets: LinkingDatasetInput[], hints: LinkingHint[]): IdentityLinkingReport {
  const { links, stats } = buildLinks(datasets, hints);
  return {
    links,
    clusters: buildClusters(datasets),
    candidateStats: stats,
  };
}
