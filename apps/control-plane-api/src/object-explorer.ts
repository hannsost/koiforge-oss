import type { FileDatasetRegistry } from '@koiforge/data-registry';

// ── Generic ontology-driven Object Explorer ───────────────────────────────────
// Objects are dataset rows. Domain logic lives in apps (App Store), not the core.
// Object type = dataset ID. Display fields are inferred from schema heuristics.

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

export interface ExplorerListOptions {
  search?: string;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  filters?: Record<string, string>;
}

// ── Field heuristics ──────────────────────────────────────────────────────────

function asString(value: string | number | boolean | null | undefined): string {
  return value == null ? '' : String(value);
}

function toConfidenceLabel(confidence: number): 'high' | 'medium' | 'low' {
  if (confidence >= 0.85) return 'high';
  if (confidence >= 0.6) return 'medium';
  return 'low';
}

function pickIdField(row: Record<string, string | number | boolean | null>): string {
  const keys = Object.keys(row);
  if (keys.includes('id')) return 'id';
  const idKey = keys.find((k) => k.toLowerCase().endsWith('id'));
  if (idKey) return idKey;
  return keys[0] ?? '';
}

function pickTitleField(
  row: Record<string, string | number | boolean | null>,
  idField: string,
): string {
  const keys = Object.keys(row).filter((k) => k !== idField);
  if (keys.includes('name')) return 'name';
  if (keys.includes('title')) return 'title';
  if (keys.includes('label')) return 'label';
  const strKey = keys.find((k) => typeof row[k] === 'string');
  return strKey ?? keys[0] ?? idField;
}

function pickSubtitleField(
  row: Record<string, string | number | boolean | null>,
  idField: string,
  titleField: string,
): string | undefined {
  const keys = Object.keys(row).filter((k) => k !== idField && k !== titleField);
  for (const pref of ['description', 'type', 'status', 'category', 'namespace', 'kind']) {
    if (keys.includes(pref)) return pref;
  }
  return keys.find((k) => typeof row[k] === 'string');
}

function rowToSummary(
  row: Record<string, string | number | boolean | null>,
  objectType: string,
  index: number,
): ExplorerObjectSummary {
  const idField = pickIdField(row);
  const titleField = pickTitleField(row, idField);
  const subtitleField = pickSubtitleField(row, idField, titleField);

  const rawId = asString(row[idField]);
  const id = rawId.length > 0 ? rawId : `${objectType}-${index + 1}`;
  const title = asString(row[titleField]) || id;
  const subtitleRaw = subtitleField ? asString(row[subtitleField]) : '';
  const subtitle = subtitleRaw.length > 0 ? subtitleRaw : undefined;

  // Confidence: 1 for rows with an explicit ID field, lower otherwise
  const confidence = rawId.length > 0 ? 1 : 0.7;

  return {
    id,
    type: objectType,
    title,
    subtitle,
    confidence,
    confidenceLabel: toConfidenceLabel(confidence),
    attributes: { ...row },
    relationCounts: {},
  };
}

function matchesSearch(summary: ExplorerObjectSummary, search: string | undefined): boolean {
  if (!search?.trim()) return true;
  const needle = search.trim().toLowerCase();
  const haystack = [
    summary.id,
    summary.title,
    summary.subtitle ?? '',
    ...Object.values(summary.attributes).map((v) => asString(v)),
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}

function matchesFilters(
  summary: ExplorerObjectSummary,
  filters: Record<string, string> | undefined,
): boolean {
  if (!filters || Object.keys(filters).length === 0) return true;
  return Object.entries(filters).every(([key, expected]) => {
    const norm = expected.trim().toLowerCase();
    if (!norm) return true;
    if (key === 'title') return summary.title.toLowerCase().includes(norm);
    if (key === 'subtitle') return (summary.subtitle ?? '').toLowerCase().includes(norm);
    return String(summary.attributes[key] ?? '').toLowerCase() === norm;
  });
}

function sortSummaries(
  items: ExplorerObjectSummary[],
  options: ExplorerListOptions | undefined,
): ExplorerObjectSummary[] {
  const sortBy = options?.sortBy;
  if (!sortBy) return items;
  const dir = options?.sortDir === 'desc' ? -1 : 1;

  return [...items].sort((a, b) => {
    const av =
      sortBy === 'title'
        ? a.title
        : sortBy === 'subtitle'
          ? (a.subtitle ?? '')
          : String(a.attributes[sortBy] ?? '');
    const bv =
      sortBy === 'title'
        ? b.title
        : sortBy === 'subtitle'
          ? (b.subtitle ?? '')
          : String(b.attributes[sortBy] ?? '');
    const an = Number(av);
    const bn = Number(bv);
    if (!Number.isNaN(an) && !Number.isNaN(bn)) return (an - bn) * dir;
    return av.localeCompare(bv) * dir;
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

// Convention: object type 'platform-event' maps to dataset ID 'platform_event'
// This mirrors the slugify(namespace + '-' + name) convention in data-registry.
function typeToDatasetId(objectType: string): string {
  return objectType.toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

async function resolveDatasetRows(
  datasetRegistry: FileDatasetRegistry,
  objectType: string,
): Promise<Array<Record<string, string | number | boolean | null>>> {
  // Primary: type name as-is (e.g. 'platform-event' → 'platform_event')
  try {
    const result = await datasetRegistry.previewRows(typeToDatasetId(objectType), 200);
    return result.rows;
  } catch {
    // Fallback: scan datasets and match by name (e.g. type 'supplier' → dataset name 'supplier')
    try {
      const datasets = await datasetRegistry.listDatasets();
      const match = datasets.find((d) => d.name === objectType || d.id === typeToDatasetId(objectType));
      if (match) {
        const result = await datasetRegistry.previewRows(match.id, 200);
        return result.rows;
      }
    } catch {
      // ignore
    }
    return [];
  }
}

export async function listExplorerObjects(
  datasetRegistry: FileDatasetRegistry,
  objectType: string,
  options?: ExplorerListOptions,
): Promise<ExplorerObjectSummary[]> {
  const rows = await resolveDatasetRows(datasetRegistry, objectType);

  const summaries = rows.map((row, index) => rowToSummary(row, objectType, index));

  return sortSummaries(
    summaries
      .filter((s) => matchesSearch(s, options?.search))
      .filter((s) => matchesFilters(s, options?.filters)),
    options,
  );
}

export async function getExplorerObjectDetail(
  datasetRegistry: FileDatasetRegistry,
  objectType: string,
  objectId: string,
): Promise<ExplorerObjectDetail | null> {
  const summaries = await listExplorerObjects(datasetRegistry, objectType);
  const summary = summaries.find((s) => s.id === objectId);
  if (!summary) return null;
  return { summary, related: [] };
}

// Link suggestions are provided by installed apps via the App Store.
// The core platform returns an empty list until an app contributes suggestions.
export async function listLinkSuggestions(
  _datasetRegistry: FileDatasetRegistry,
): Promise<ExplorerLinkSuggestion[]> {
  return [];
}
