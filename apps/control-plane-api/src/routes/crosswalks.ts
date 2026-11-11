import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { callProvider, type AipMessage } from '@koiforge/aip-core';
import { suggestCrosswalk, type CrosswalkMapping } from '@koiforge/semantic-crosswalk-core';

import type { AppRegistries } from '../registries.js';
import { createSessionGuard } from './_guard.js';

interface SuggestCrosswalksBody {
  leftDatasetId: string;
  rightDatasetId: string;
  minCoverage?: number;
  minConfidence?: number;
}

interface MaterializeCrosswalkBody {
  leftDatasetId: string;
  leftColumn: string;
  rightDatasetId: string;
  rightColumn: string;
  mappings: CrosswalkMapping[];
  mappingDatasetName?: string;
  mappingDatasetNamespace?: string;
}

interface CrosswalkProposal {
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
  mappings: CrosswalkMapping[];
  explanation: string;
  sourceType?: 'external_reference' | 'aip_generated' | 'heuristic';
  sourceUri?: string;
  bridgeHint?: string;
}

interface ValueShapeProfile {
  avgLength: number;
  avgTokens: number;
  codeLikeRatio: number;
  numericLikeRatio: number;
}

interface ExternalReferencePlan {
  sourceUrl: string;
  format: 'json' | 'csv';
  canonicalField: string;
  aliasFields: string[];
}

interface SemanticBridgeCandidate {
  leftColumn: string;
  rightColumn: string;
  concept: string;
  reason: string;
  confidence: number;
}

interface ExternalReferenceSearchState {
  rejectedSourceUrls: string[];
  unresolvedLeftValues: string[];
  currentBestCoverage: number;
}

function normalizeValue(value: string | number | boolean | null): string {
  return value === null || value === undefined
    ? ''
    : String(value)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
      .trim();
}

function toSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

function uniqueValues(rows: Array<Record<string, string | number | boolean | null>>, column: string) {
  return [...new Set(
    rows
      .map((row) => row[column])
      .filter((value) => value !== null && value !== undefined && String(value).trim().length > 0)
      .map((value) => String(value).trim()),
  )];
}

function directOverlapRatio(leftValues: string[], rightValues: string[]): number {
  if (leftValues.length === 0) return 0;
  const rightSet = new Set(rightValues.map((value) => value.trim()));
  const overlap = leftValues.filter((value) => rightSet.has(value.trim())).length;
  return overlap / leftValues.length;
}

function normalizedOverlapRatio(leftValues: string[], rightValues: string[]): number {
  if (leftValues.length === 0) return 0;
  const rightSet = new Set(rightValues.map((value) => normalizeValue(value)).filter(Boolean));
  const overlap = leftValues
    .map((value) => normalizeValue(value))
    .filter((value) => value && rightSet.has(value))
    .length;
  return overlap / leftValues.length;
}

function normalizeColumnName(value: string): string {
  return value
    .toLowerCase()
    .replace(/(_id|id|_code|code|_key|key|_name|name)$/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function columnAffinity(leftColumn: string, rightColumn: string): number {
  const left = normalizeColumnName(leftColumn);
  const right = normalizeColumnName(rightColumn);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.82;
  return 0;
}

function inspectValueShape(values: string[]): ValueShapeProfile {
  if (values.length === 0) {
    return { avgLength: 0, avgTokens: 0, codeLikeRatio: 0, numericLikeRatio: 0 };
  }

  let totalLength = 0;
  let totalTokens = 0;
  let codeLike = 0;
  let numericLike = 0;

  for (const value of values) {
    const trimmed = value.trim();
    totalLength += trimmed.length;
    totalTokens += trimmed.split(/[\s._-]+/g).filter(Boolean).length;
    if (/^[A-Z0-9]{1,5}$/.test(trimmed)) codeLike += 1;
    if (/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) numericLike += 1;
  }

  return {
    avgLength: totalLength / values.length,
    avgTokens: totalTokens / values.length,
    codeLikeRatio: codeLike / values.length,
    numericLikeRatio: numericLike / values.length,
  };
}

function crosswalkNeedScore(params: {
  leftColumn: string;
  rightColumn: string;
  leftValues: string[];
  rightValues: string[];
  directOverlap: number;
  normalizedOverlap: number;
  semanticAffinity?: number;
}): number {
  const affinity = Math.max(
    columnAffinity(params.leftColumn, params.rightColumn),
    params.semanticAffinity ?? 0,
  );
  if (affinity < 0.8) return 0;
  if (params.directOverlap >= 0.95 || params.normalizedOverlap >= 0.95) return 0;

  const leftShape = inspectValueShape(params.leftValues);
  const rightShape = inspectValueShape(params.rightValues);
  const shapeGap = Math.min(1, (
    Math.abs(leftShape.avgLength - rightShape.avgLength) / 16
    + Math.abs(leftShape.avgTokens - rightShape.avgTokens) / 4
    + Math.abs(leftShape.codeLikeRatio - rightShape.codeLikeRatio)
    + Math.abs(leftShape.numericLikeRatio - rightShape.numericLikeRatio)
  ) / 2);
  const lowOverlapSignal = Math.max(0, 1 - Math.max(params.directOverlap, params.normalizedOverlap));

  return Number((0.55 * affinity + 0.3 * shapeGap + 0.15 * lowOverlapSignal).toFixed(3));
}

function parseJsonObject(raw: string): unknown | null {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  const firstBrace = stripped.indexOf('{');
  const lastBrace = stripped.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;
  try {
    return JSON.parse(stripped.slice(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
}

function isSafeExternalReferenceUrl(sourceUrl: string): boolean {
  try {
    const parsed = new URL(sourceUrl);
    if (parsed.protocol !== 'https:') return false;

    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname.endsWith('.local')
      || hostname.endsWith('.internal')
    ) {
      return false;
    }

    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
      const [a = 0, b = 0] = hostname.split('.').map((part) => Number.parseInt(part, 10));
      if (a === 10 || a === 127 || a === 0) return false;
      if (a === 192 && b === 168) return false;
      if (a === 172 && b >= 16 && b <= 31) return false;
      if (a === 169 && b === 254) return false;
    }

    return true;
  } catch {
    return false;
  }
}

function getFieldValuesByPath(row: unknown, path: string): string[] {
  let current: unknown[] = [row];
  for (const segment of path.split('.').filter(Boolean)) {
    const next: unknown[] = [];
    for (const value of current) {
      if (Array.isArray(value)) {
        next.push(...value);
      } else if (value && typeof value === 'object' && segment in value) {
        next.push((value as Record<string, unknown>)[segment]);
      }
    }
    current = next;
  }

  const flattened: string[] = [];
  const queue = [...current];
  while (queue.length > 0) {
    const value = queue.shift();
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const text = String(value).trim();
      if (text) flattened.push(text);
    }
  }

  return [...new Set(flattened)];
}

function parseCsvRows(raw: string): Record<string, string>[] {
  const lines = raw.split(/\r?\n/g).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];
  const delimiter = lines[0]!.includes(';') && !lines[0]!.includes(',') ? ';' : ',';

  const parseLine = (line: string): string[] => {
    const cells: string[] = [];
    let cell = '';
    let inQuotes = false;

    for (let index = 0; index < line.length; index += 1) {
      const char = line[index]!;
      const nextChar = line[index + 1];

      if (char === '"' && inQuotes && nextChar === '"') {
        cell += '"';
        index += 1;
        continue;
      }

      if (char === '"') {
        inQuotes = !inQuotes;
        continue;
      }

      if (char === delimiter && !inQuotes) {
        cells.push(cell.trim());
        cell = '';
        continue;
      }

      cell += char;
    }

    cells.push(cell.trim());
    return cells;
  };

  const headers = parseLine(lines[0]!);
  return lines.slice(1, 3001).map((line) => {
    const values = parseLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
  });
}

async function fetchExternalReferenceEntries(
  plan: ExternalReferencePlan,
): Promise<Array<{ canonicalValue: string; aliases: string[] }> | null> {
  if (!isSafeExternalReferenceUrl(plan.sourceUrl)) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);

  try {
    const response = await fetch(plan.sourceUrl, {
      signal: controller.signal,
      headers: {
        accept: plan.format === 'json'
          ? 'application/json,text/plain;q=0.8,*/*;q=0.5'
          : 'text/csv,text/plain;q=0.8,*/*;q=0.5',
      },
    });
    if (!response.ok) return null;

    const raw = (await response.text()).slice(0, 5_000_000);
    const rows = plan.format === 'json'
      ? (() => {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) return parsed.slice(0, 3000);
        if (parsed && typeof parsed === 'object') {
          const arrayValue = Object.values(parsed).find((value) => Array.isArray(value));
          return Array.isArray(arrayValue) ? arrayValue.slice(0, 3000) : [];
        }
        return [];
      })()
      : parseCsvRows(raw);

    const entries = rows.flatMap((row) => {
      const canonicalCandidates = getFieldValuesByPath(row, plan.canonicalField);
      const canonicalValue = canonicalCandidates[0];
      if (!canonicalValue) return [];

      const aliases = new Set<string>([canonicalValue]);
      for (const field of plan.aliasFields) {
        for (const alias of getFieldValuesByPath(row, field)) {
          aliases.add(alias);
        }
      }

      return [{ canonicalValue, aliases: [...aliases] }];
    });

    return entries.length > 0 ? entries : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function draftExternalReferencePlansWithAip(
  registries: AppRegistries,
  leftColumn: string,
  rightColumn: string,
  leftValues: string[],
  rightValues: string[],
  state: ExternalReferenceSearchState,
  bridgeHint?: string,
): Promise<ExternalReferencePlan[]> {
  const config = await registries.aip.getConfig();
  if (!config) return [];

  const messages: AipMessage[] = [
    {
      role: 'system',
      content: [
        'You find downloadable public reference tables for generic crosswalks between two columns.',
        'Return exactly one JSON object, no markdown and no prose.',
        'Schema: { "plans": [{ "sourceUrl": string, "format": "json"|"csv", "canonicalField": string, "aliasFields": string[] }] }',
        'Use only HTTPS URLs to directly downloadable public JSON/CSV data.',
        'canonicalField is the field/path that should become canonicalValue.',
        'Prefer a canonicalField whose value format and language match rightSampleValues, because missing right-side rows may be materialized from canonicalValue.',
        'aliasFields are field/path entries containing equivalent aliases/codes/names.',
        'Return up to 5 candidate plans ordered by expected fit for the actual left/right sample values.',
        'Prefer sources whose rows contain both sides as explicit fields or aliases.',
        'If bridgeHint is present, use it to search for reference datasets that connect both value domains even when left/right column names differ.',
        'Do not return any URL from rejectedSourceUrls.',
        'Use unresolvedLeftValues to focus on values that are still missing in the current best candidate.',
        'If no reliable public table is likely available, return {"plans":[]}.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        leftColumn,
        rightColumn,
        leftSampleValues: leftValues.slice(0, 40),
        rightSampleValues: rightValues.slice(0, 80),
        bridgeHint: bridgeHint ?? null,
        rejectedSourceUrls: state.rejectedSourceUrls.slice(0, 20),
        unresolvedLeftValues: state.unresolvedLeftValues.slice(0, 40),
        currentBestCoverage: state.currentBestCoverage,
      }, null, 2),
    },
  ];

  try {
    const response = await callProvider(config, messages, 800);
    const parsed = parseJsonObject(response.message.content);
    if (!parsed || typeof parsed !== 'object') return [];

    const plans = (parsed as { plans?: unknown }).plans;
    if (!Array.isArray(plans)) return [];

    return plans.flatMap((plan): ExternalReferencePlan[] => {
      if (!plan || typeof plan !== 'object') return [];
      const sourceUrl = (plan as { sourceUrl?: unknown }).sourceUrl;
      const format = (plan as { format?: unknown }).format;
      const canonicalField = (plan as { canonicalField?: unknown }).canonicalField;
      const aliasFields = (plan as { aliasFields?: unknown }).aliasFields;

      if (
        typeof sourceUrl !== 'string'
        || !sourceUrl
        || (format !== 'json' && format !== 'csv')
        || typeof canonicalField !== 'string'
        || !canonicalField
        || !Array.isArray(aliasFields)
        || !aliasFields.every((field) => typeof field === 'string' && field.trim().length > 0)
      ) {
        return [];
      }

      return [{
        sourceUrl,
        format,
        canonicalField,
        aliasFields,
      }];
    }).slice(0, 5);
  } catch {
    return [];
  }
}

async function draftSemanticBridgeCandidatesWithAip(
  registries: AppRegistries,
  leftDataset: { id: string; name: string; namespace: string; schema: Array<{ name: string; type: string }> },
  rightDataset: { id: string; name: string; namespace: string; schema: Array<{ name: string; type: string }> },
  leftRows: Array<Record<string, string | number | boolean | null>>,
  rightRows: Array<Record<string, string | number | boolean | null>>,
): Promise<SemanticBridgeCandidate[]> {
  const config = await registries.aip.getConfig();
  if (!config) return [];

  const leftSamples = leftDataset.schema
    .filter((field) => field.type === 'string')
    .map((field) => ({
      column: field.name,
      values: uniqueValues(leftRows, field.name).slice(0, 25),
    }))
    .filter((entry) => entry.values.length > 0);

  const rightSamples = rightDataset.schema
    .filter((field) => field.type === 'string')
    .map((field) => ({
      column: field.name,
      values: uniqueValues(rightRows, field.name).slice(0, 40),
    }))
    .filter((entry) => entry.values.length > 0);

  if (leftSamples.length === 0 || rightSamples.length === 0) return [];

  const messages: AipMessage[] = [
    {
      role: 'system',
      content: [
        'You are a generic semantic bridge planner for datasets.',
        'Inspect string columns and actual sample values from two datasets.',
        'Return exactly one JSON object, no markdown and no prose.',
        'Schema: { "bridges": [{ "leftColumn": string, "rightColumn": string, "concept": string, "reason": string, "confidence": number }] }',
        'A bridge means the left and right value domains are semantically connectable via an external reference table, even if direct equality and column names do not match.',
        'Examples of valid generic bridges: country_code -> language_name, currency_symbol -> currency_name, product_sku -> product_category, translated_label -> canonical_label.',
        'Use only left/right column names that exist in the provided datasets.',
        'Do not return direct joins with obvious exact value overlap; only return cases where a reference/crosswalk layer could plausibly help.',
        'confidence must be between 0 and 1. Return at most 6 bridges sorted descending by confidence.',
        'If there is no plausible bridge, return {"bridges":[]}.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        leftDataset: {
          id: leftDataset.id,
          name: leftDataset.name,
          namespace: leftDataset.namespace,
          columns: leftSamples,
        },
        rightDataset: {
          id: rightDataset.id,
          name: rightDataset.name,
          namespace: rightDataset.namespace,
          columns: rightSamples,
        },
      }, null, 2),
    },
  ];

  try {
    const response = await callProvider(config, messages, 1200);
    const parsed = parseJsonObject(response.message.content);
    if (!parsed || typeof parsed !== 'object') return [];

    const bridges = (parsed as { bridges?: unknown }).bridges;
    if (!Array.isArray(bridges)) return [];

    const leftColumns = new Set(leftSamples.map((entry) => entry.column));
    const rightColumns = new Set(rightSamples.map((entry) => entry.column));

    return bridges.flatMap((bridge): SemanticBridgeCandidate[] => {
      if (!bridge || typeof bridge !== 'object') return [];

      const leftColumn = (bridge as { leftColumn?: unknown }).leftColumn;
      const rightColumn = (bridge as { rightColumn?: unknown }).rightColumn;
      const concept = (bridge as { concept?: unknown }).concept;
      const reason = (bridge as { reason?: unknown }).reason;
      const confidence = (bridge as { confidence?: unknown }).confidence;

      if (
        typeof leftColumn !== 'string'
        || !leftColumns.has(leftColumn)
        || typeof rightColumn !== 'string'
        || !rightColumns.has(rightColumn)
        || typeof concept !== 'string'
        || !concept.trim()
        || typeof reason !== 'string'
        || !reason.trim()
        || typeof confidence !== 'number'
      ) {
        return [];
      }

      return [{
        leftColumn,
        rightColumn,
        concept: concept.trim(),
        reason: reason.trim(),
        confidence: Math.max(0, Math.min(1, confidence)),
      }];
    }).sort((a, b) => b.confidence - a.confidence).slice(0, 6);
  } catch {
    return [];
  }
}

function scoreCrosswalkMappings(mappings: CrosswalkMapping[]): {
  coverage: number;
  confidence: number;
  unresolvedLeftValues: string[];
} {
  const matched = mappings.filter((mapping) => mapping.status !== 'unmatched');
  return {
    coverage: mappings.length === 0 ? 0 : matched.length / mappings.length,
    confidence: matched.length === 0
      ? 0
      : matched.reduce((sum, mapping) => sum + mapping.confidence, 0) / matched.length,
    unresolvedLeftValues: mappings
      .filter((mapping) => mapping.status === 'unmatched')
      .map((mapping) => mapping.leftValue),
  };
}

function mergeCrosswalkMappings(
  currentMappings: CrosswalkMapping[],
  candidateMappings: CrosswalkMapping[],
): CrosswalkMapping[] {
  const candidateByLeft = new Map(candidateMappings.map((mapping) => [mapping.leftValue, mapping]));

  return currentMappings.map((currentMapping) => {
    const candidate = candidateByLeft.get(currentMapping.leftValue);
    if (!candidate) return currentMapping;

    if (currentMapping.status === 'unmatched' && candidate.status !== 'unmatched') {
      return candidate;
    }

    if (
      currentMapping.status === 'ambiguous'
      && candidate.status === 'matched'
      && candidate.confidence >= currentMapping.confidence
    ) {
      return candidate;
    }

    if (
      currentMapping.status === candidate.status
      && candidate.confidence > currentMapping.confidence + 0.05
    ) {
      return candidate;
    }

    return currentMapping;
  });
}

async function draftCrosswalkMappingsWithAip(
  registries: AppRegistries,
  leftColumn: string,
  rightColumn: string,
  leftValues: string[],
  rightValues: string[],
): Promise<CrosswalkMapping[] | null> {
  const config = await registries.aip.getConfig();
  if (!config) return null;

  const messages: AipMessage[] = [
    {
      role: 'system',
      content: [
        'You draft generic crosswalk mappings between two categorical columns.',
        'Return exactly one JSON object, no markdown fences and no prose.',
        'Schema: { "mappings": [{ "leftValue": string, "rightValue": string|null, "confidence": number }] }',
        'Rules:',
        '- Use only values from LEFT_VALUES as leftValue.',
        '- rightValue must be null or one exact string from RIGHT_VALUES.',
        '- Never invent right-side values.',
        '- If values are unrelated or uncertain, use rightValue:null and confidence:0.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        leftColumn,
        rightColumn,
        leftValues: leftValues.slice(0, 120),
        rightValues: rightValues.slice(0, 300),
      }, null, 2),
    },
  ];

  try {
    const response = await callProvider(config, messages, 1600);
    const parsed = parseJsonObject(response.message.content);
    if (!parsed || typeof parsed !== 'object' || !('mappings' in parsed) || !Array.isArray((parsed as { mappings?: unknown }).mappings)) {
      return null;
    }

    const rightSet = new Set(rightValues);
    const byLeft = new Map<string, CrosswalkMapping>();
    for (const entry of (parsed as { mappings: unknown[] }).mappings) {
      if (!entry || typeof entry !== 'object') continue;
      const leftValue = (entry as { leftValue?: unknown }).leftValue;
      const rightValue = (entry as { rightValue?: unknown }).rightValue;
      const confidence = (entry as { confidence?: unknown }).confidence;
      if (typeof leftValue !== 'string' || !leftValues.includes(leftValue)) continue;
      if (rightValue !== null && (typeof rightValue !== 'string' || !rightSet.has(rightValue))) continue;
      const numericConfidence = typeof confidence === 'number'
        ? Math.max(0, Math.min(1, confidence))
        : 0;
      byLeft.set(leftValue, {
        leftValue,
        rightValue,
        canonicalValue: rightValue,
        confidence: numericConfidence,
        method: rightValue ? 'reference' : 'fuzzy',
        status: rightValue && numericConfidence >= 0.75 ? 'matched' : rightValue ? 'ambiguous' : 'unmatched',
        alternatives: [],
      });
    }

    return leftValues.map((leftValue) => (
      byLeft.get(leftValue) ?? {
        leftValue,
        rightValue: null,
        canonicalValue: null,
        confidence: 0,
        method: 'fuzzy',
        status: 'unmatched',
        alternatives: [],
      }
    ));
  } catch {
    return null;
  }
}

export function registerCrosswalksRoutes(app: FastifyInstance, registries: AppRegistries): void {
  const { guard } = createSessionGuard(registries.security);

  app.post<{ Body: SuggestCrosswalksBody }>('/api/crosswalks/suggest', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.read']))) return reply;

    const { leftDatasetId, rightDatasetId, minConfidence = 0.72, minCoverage = 0.3 } = request.body ?? {};
    const deadline = Date.now() + 30_000; // hard 30s wall-clock limit
    if (!leftDatasetId || !rightDatasetId) {
      reply.code(400);
      return { error: 'leftDatasetId und rightDatasetId sind erforderlich.' };
    }

    const [leftDataset, rightDataset] = await Promise.all([
      registries.dataset.getDataset(leftDatasetId),
      registries.dataset.getDataset(rightDatasetId),
    ]);
    if (!leftDataset || !rightDataset) {
      reply.code(404);
      return { error: 'Mindestens eines der Datasets wurde nicht gefunden.' };
    }

    const [leftPreview, rightPreview] = await Promise.all([
      registries.dataset.previewRows(leftDatasetId, 2000),
      registries.dataset.previewRows(rightDatasetId, 2000),
    ]);
    const bridgeCandidates = await draftSemanticBridgeCandidatesWithAip(
      registries,
      {
        id: leftDataset.id,
        name: leftDataset.name,
        namespace: leftDataset.namespace,
        schema: leftDataset.schema.map((field) => ({ name: field.name, type: field.type })),
      },
      {
        id: rightDataset.id,
        name: rightDataset.name,
        namespace: rightDataset.namespace,
        schema: rightDataset.schema.map((field) => ({ name: field.name, type: field.type })),
      },
      leftPreview.rows,
      rightPreview.rows,
    );
    const bridgeCandidateMap = new Map(
      bridgeCandidates.map((candidate) => [`${candidate.leftColumn}__${candidate.rightColumn}`, candidate]),
    );

    const proposals: CrosswalkProposal[] = [];
    const leftColumns = leftDataset.schema.filter((field) => field.type === 'string').map((field) => field.name);
    const rightColumns = rightDataset.schema.filter((field) => field.type === 'string').map((field) => field.name);

    for (const leftColumn of leftColumns) {
      if (Date.now() > deadline) break;
      const leftValues = uniqueValues(leftPreview.rows, leftColumn);
      if (leftValues.length === 0) continue;

      for (const rightColumn of rightColumns) {
        if (Date.now() > deadline) break;
        const rightValues = uniqueValues(rightPreview.rows, rightColumn);
        if (rightValues.length === 0) continue;

        const directOverlap = directOverlapRatio(leftValues, rightValues);
        const normalizedOverlap = normalizedOverlapRatio(leftValues, rightValues);
        const bridgeCandidate = bridgeCandidateMap.get(`${leftColumn}__${rightColumn}`);
        const suggestion = suggestCrosswalk({
          left: {
            datasetId: leftDataset.id,
            datasetName: leftDataset.name,
            namespace: leftDataset.namespace,
            column: leftColumn,
            values: leftValues,
          },
          right: {
            datasetId: rightDataset.id,
            datasetName: rightDataset.name,
            namespace: rightDataset.namespace,
            column: rightColumn,
            values: rightValues,
          },
          minConfidence,
        });

        const matchedOrAmbiguous = suggestion.summary.matched + suggestion.summary.ambiguous;
        const coverage = suggestion.summary.totalLeftValues === 0
          ? 0
          : matchedOrAmbiguous / suggestion.summary.totalLeftValues;
        const avgConfidence = matchedOrAmbiguous === 0
          ? 0
          : suggestion.mappings
            .filter((mapping) => mapping.status !== 'unmatched')
            .reduce((sum, mapping) => sum + mapping.confidence, 0) / matchedOrAmbiguous;
        const needScore = crosswalkNeedScore({
          leftColumn,
          rightColumn,
          leftValues,
          rightValues,
          directOverlap,
          normalizedOverlap,
          semanticAffinity: bridgeCandidate?.confidence,
        });

        let mappings = suggestion.mappings;
        let proposalCoverage = coverage;
        let proposalConfidence = avgConfidence;
        let sourceType: CrosswalkProposal['sourceType'] = matchedOrAmbiguous > 0 ? 'heuristic' : undefined;
        let sourceUri: string | undefined;
        const usedSourceUrls: string[] = [];
        let explanation = directOverlap === 0 && (normalizedOverlap > 0 || avgConfidence >= 0.9)
          ? `Direkter Join zwischen ${leftColumn} und ${rightColumn} hat kaum exakte Treffer, aber normalisierte/reference Mappings decken ${(coverage * 100).toFixed(1)}% der linken Werte ab.`
          : `Crosswalk zwischen ${leftColumn} und ${rightColumn} verbessert Join-Abdeckung auf ${(coverage * 100).toFixed(1)}% bei Confidence ${avgConfidence.toFixed(2)}.`;

        if (proposalCoverage < minCoverage && needScore >= 0.7) {
          const searchState: ExternalReferenceSearchState = {
            rejectedSourceUrls: [],
            unresolvedLeftValues: leftValues.slice(0, 80),
            currentBestCoverage: proposalCoverage,
          };

          for (let round = 0; round < 2; round += 1) {
            const externalPlans = await draftExternalReferencePlansWithAip(
              registries,
              leftColumn,
              rightColumn,
              leftValues,
              rightValues,
              searchState,
              bridgeCandidate
                ? `${bridgeCandidate.concept}: ${bridgeCandidate.reason}`
                : undefined,
            );

            if (externalPlans.length === 0) break;

            let improvedInRound = false;
            for (const externalPlan of externalPlans) {
              if (searchState.rejectedSourceUrls.includes(externalPlan.sourceUrl)) continue;

              const referenceEntries = await fetchExternalReferenceEntries(externalPlan);
              if (!referenceEntries) {
                searchState.rejectedSourceUrls.push(externalPlan.sourceUrl);
                continue;
              }

              const externalSuggestion = suggestCrosswalk({
                left: {
                  datasetId: leftDataset.id,
                  datasetName: leftDataset.name,
                  namespace: leftDataset.namespace,
                  column: leftColumn,
                  values: leftValues,
                },
                right: {
                  datasetId: rightDataset.id,
                  datasetName: rightDataset.name,
                  namespace: rightDataset.namespace,
                  column: rightColumn,
                  values: rightValues,
                },
                referenceEntries,
                minConfidence: 0.7,
              });

              const quality = scoreCrosswalkMappings(externalSuggestion.mappings);
              const mergedMappings = mergeCrosswalkMappings(mappings, externalSuggestion.mappings);
              const mergedQuality = scoreCrosswalkMappings(mergedMappings);
              const currentScore = proposalCoverage * 1000 + proposalConfidence;
              const candidateScore = mergedQuality.coverage * 1000 + mergedQuality.confidence;

              if (candidateScore > currentScore + 0.001) {
                mappings = mergedMappings;
                proposalCoverage = mergedQuality.coverage;
                proposalConfidence = mergedQuality.confidence || needScore;
                sourceType = 'external_reference';
                if (!usedSourceUrls.includes(externalPlan.sourceUrl)) {
                  usedSourceUrls.push(externalPlan.sourceUrl);
                }
                sourceUri = usedSourceUrls.join(' | ');
                searchState.currentBestCoverage = mergedQuality.coverage;
                searchState.unresolvedLeftValues = mergedQuality.unresolvedLeftValues;
                explanation = mergedQuality.unresolvedLeftValues.length === 0
                  ? `Direkter Join zwischen ${leftColumn} und ${rightColumn} passt wegen der Sample-Werte nicht. ${usedSourceUrls.length} externe Referenztabelle(n) wurden im Optimierungsloop kombiniert und decken alle linken Werte ab.`
                  : `Direkter Join zwischen ${leftColumn} und ${rightColumn} passt wegen der Sample-Werte nicht. ${usedSourceUrls.length} externe Referenztabelle(n) wurden im Optimierungsloop kombiniert und liefern ${(proposalCoverage * 100).toFixed(1)}% Coverage. Offen: ${mergedQuality.unresolvedLeftValues.slice(0, 6).join(', ')}.`;
                improvedInRound = true;
              } else {
                searchState.rejectedSourceUrls.push(externalPlan.sourceUrl);
              }

              if (proposalCoverage >= 1 && proposalConfidence >= 0.95) break;
            }

            if ((proposalCoverage >= 1 && proposalConfidence >= 0.95) || !improvedInRound) break;
          }

          if (proposalCoverage < 1) {
            const aipMappings = await draftCrosswalkMappingsWithAip(
              registries,
              leftColumn,
              rightColumn,
              leftValues,
              rightValues,
            );
            if (aipMappings) {
              const mergedMappings = mergeCrosswalkMappings(mappings, aipMappings);
              const mergedQuality = scoreCrosswalkMappings(mergedMappings);
              if (mergedQuality.coverage > proposalCoverage || mergedQuality.confidence > proposalConfidence + 0.05) {
                mappings = mergedMappings;
                proposalCoverage = mergedQuality.coverage;
                proposalConfidence = mergedQuality.confidence || needScore;
                sourceType = usedSourceUrls.length > 0 ? 'external_reference' : 'aip_generated';
                if (usedSourceUrls.length > 0) {
                  explanation = mergedQuality.unresolvedLeftValues.length === 0
                    ? `${explanation} Verbleibende offene Werte wurden danach per AIP gegen echte rechte Sample-Werte aufgeloest.`
                    : `${explanation} Verbleibende offene Werte wurden per AIP fallback geprueft, aber noch offen: ${mergedQuality.unresolvedLeftValues.slice(0, 6).join(', ')}.`;
                } else {
                  explanation = mergedQuality.unresolvedLeftValues.length === 0
                    ? `Sample-Werte in ${leftColumn} und ${rightColumn} sind semantisch ueber einen Bridge-Crosswalk verbindbar. AIP hat aus den echten Werten einen Mapping-Draft mit ${(proposalCoverage * 100).toFixed(1)}% Coverage erstellt.`
                    : `Sample-Werte in ${leftColumn} und ${rightColumn} sind semantisch ueber einen Bridge-Crosswalk verbindbar. AIP hat aus den echten Werten einen Mapping-Draft mit ${(proposalCoverage * 100).toFixed(1)}% Coverage erstellt. Offen: ${mergedQuality.unresolvedLeftValues.slice(0, 6).join(', ')}.`;
                }
              }
            }
          }
        }

        if (directOverlap >= 0.95) continue;
        if (proposalCoverage < minCoverage) continue;
        if (proposalConfidence < minConfidence && needScore < 0.7) continue;

        const finalQuality = scoreCrosswalkMappings(mappings);
        proposalCoverage = finalQuality.coverage;
        proposalConfidence = finalQuality.confidence || proposalConfidence || needScore;
        if (finalQuality.unresolvedLeftValues.length > 0 && sourceType === 'external_reference') {
          explanation = `Direkter Join zwischen ${leftColumn} und ${rightColumn} passt wegen der Sample-Werte nicht. ${usedSourceUrls.length} externe Referenztabelle(n) wurden im Optimierungsloop kombiniert und liefern ${(proposalCoverage * 100).toFixed(1)}% Coverage. Fuer ${finalQuality.unresolvedLeftValues.slice(0, 6).join(', ')} wurde in den rechten Sample-Werten kein valider Zielwert gefunden.`;
        }

        const mappingDatasetName = toSlug(`${leftDataset.name}_${leftColumn}__${rightDataset.name}_${rightColumn}_crosswalk`);
        proposals.push({
          id: randomUUID(),
          leftDatasetId: leftDataset.id,
          leftDatasetName: leftDataset.name,
          leftNamespace: leftDataset.namespace,
          leftColumn,
          rightDatasetId: rightDataset.id,
          rightDatasetName: rightDataset.name,
          rightNamespace: rightDataset.namespace,
          rightColumn,
          confidence: Number(Math.max(proposalConfidence, needScore).toFixed(3)),
          coverage: Number(proposalCoverage.toFixed(3)),
          directOverlapRatio: Number(directOverlap.toFixed(3)),
          mappingDatasetName,
          mappingDatasetNamespace: 'crosswalk',
          mappings,
          explanation,
          sourceType,
          sourceUri,
          bridgeHint: bridgeCandidate
            ? `${bridgeCandidate.concept}: ${bridgeCandidate.reason}`
            : undefined,
        });
      }
    }

    proposals.sort((a, b) => b.coverage - a.coverage || b.confidence - a.confidence);

    return {
      items: proposals.slice(0, 20),
      summary: proposals.length === 0
        ? 'Keine belastbaren Crosswalk-Kandidaten gefunden.'
        : `${Math.min(proposals.length, 20)} Crosswalk-Kandidaten gefunden.`,
    };
  });

  app.post<{ Body: MaterializeCrosswalkBody }>('/api/crosswalks/materialize', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.manage']))) return reply;

    const {
      leftDatasetId,
      leftColumn,
      rightDatasetId,
      rightColumn,
      mappings,
      mappingDatasetName,
      mappingDatasetNamespace = 'crosswalk',
    } = request.body ?? {};

    if (!leftDatasetId || !leftColumn || !rightDatasetId || !rightColumn || !Array.isArray(mappings)) {
      reply.code(400);
      return { error: 'left/right Dataset, left/right Column und mappings sind erforderlich.' };
    }

    const rightDataset = await registries.dataset.getDataset(rightDatasetId);
    if (!rightDataset) {
      reply.code(404);
      return { error: `Right dataset '${rightDatasetId}' wurde nicht gefunden.` };
    }

    const normalizedMappings = mappings.map((mapping) => ({
      ...mapping,
      rightValue: mapping.rightValue ?? mapping.canonicalValue,
      canonicalValue: mapping.canonicalValue ?? mapping.rightValue,
    }));

    const rightPreview = await registries.dataset.previewRows(rightDatasetId, 100_000);
    const rightValues = new Set(
      rightPreview.rows
        .map((row) => row[rightColumn])
        .filter((value) => value !== null && value !== undefined && String(value).trim().length > 0)
        .map((value) => String(value).trim()),
    );
    const fallbackRows = normalizedMappings
      .filter((mapping) => mapping.rightValue && !rightValues.has(mapping.rightValue))
      .map((mapping) => ({
        ...Object.fromEntries(rightDataset.schema.map((field) => [field.name, null])),
        [rightColumn]: mapping.rightValue,
      }));

    const augmentedRightDataset = fallbackRows.length > 0
      ? await registries.dataset.registerInlineDataset({
        name: toSlug(`${rightDataset.name}_${rightColumn}_augmented_${randomUUID().slice(0, 8)}`),
        namespace: toSlug(mappingDatasetNamespace) || 'crosswalk',
        description: `Augmented right dataset for ${rightDatasetId}.${rightColumn} with external crosswalk fallback rows`,
        tags: ['crosswalk', 'derived', 'reference-augmentation'],
        rows: [...rightPreview.rows, ...fallbackRows],
      })
      : null;

    const outputDataset = await registries.dataset.registerInlineDataset({
      name: mappingDatasetName
        ? toSlug(`${mappingDatasetName}_${randomUUID().slice(0, 8)}`)
        : toSlug(`${leftDatasetId}_${leftColumn}__${rightDatasetId}_${rightColumn}_${randomUUID().slice(0, 8)}`),
      namespace: toSlug(mappingDatasetNamespace) || 'crosswalk',
      description: `Crosswalk mapping for ${leftDatasetId}.${leftColumn} -> ${rightDatasetId}.${rightColumn}`,
      tags: ['crosswalk', 'derived', 'semantic-join'],
      rows: normalizedMappings.map((mapping) => ({
        left_value: mapping.leftValue,
        right_value: mapping.rightValue,
        canonical_value: mapping.canonicalValue,
        confidence: mapping.confidence,
        method: mapping.method,
        status: mapping.status,
      })),
    });

    reply.code(201);
    return {
      dataset: outputDataset,
      joinPlan: {
        firstJoin: {
          type: 'join',
          rightDatasetId: outputDataset.id,
          leftKey: leftColumn,
          rightKey: 'left_value',
          mode: 'left',
        },
        secondJoin: {
          type: 'join',
          rightDatasetId: augmentedRightDataset?.id ?? rightDatasetId,
          leftKey: 'right_value',
          rightKey: rightColumn,
          mode: 'left',
        },
      },
      augmentedRightDataset: augmentedRightDataset ?? undefined,
    };
  });
}
