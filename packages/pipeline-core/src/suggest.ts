/**
 * Smart pipeline suggestion engine.
 *
 * Given schema information for one or two datasets it returns a ranked list
 * of suggested pipeline steps (joins, aggregations, filters, selects).
 */

import type { PipelineStep } from './types.js';

export interface FieldMeta {
  name: string;
  type: 'string' | 'integer' | 'number' | 'boolean' | 'date' | 'datetime' | 'json';
  nullable?: boolean;
}

export interface DatasetMeta {
  id: string;
  name: string;
  namespace: string;
  fields: FieldMeta[];
  /** Optional sample rows for value-level heuristics */
  sampleRows?: Record<string, string | number | boolean | null>[];
}

export interface SuggestedStep {
  step: PipelineStep;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  label: string;
}

export interface SuggestResult {
  suggestions: SuggestedStep[];
  summary: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const ID_SUFFIXES = ['id', 'Id', 'ID', '_id', 'Id', 'Pk', 'pk', 'key', 'Key'];
const DATE_PATTERNS = ['date', 'Date', 'time', 'Time', 'created', 'updated', 'timestamp'];
const NUMERIC_TYPES = new Set(['integer', 'number']);
const CATEGORY_TYPES = new Set(['string', 'boolean']);

function isIdField(name: string): boolean {
  return ID_SUFFIXES.some((s) => name.endsWith(s) || name === s);
}

function isDateField(f: FieldMeta): boolean {
  return (
    f.type === 'date'
    || f.type === 'datetime'
    || DATE_PATTERNS.some((p) => f.name.toLowerCase().includes(p.toLowerCase()))
  );
}

function isNumeric(f: FieldMeta): boolean {
  return NUMERIC_TYPES.has(f.type);
}

function isCategory(f: FieldMeta): boolean {
  return CATEGORY_TYPES.has(f.type);
}

/** Normalize field name for fuzzy matching: lowercase, strip id/fk suffixes */
function normalize(name: string): string {
  return name.toLowerCase()
    .replace(/(_id|id|_fk|fk|_key|key|_pk|pk)$/, '')
    .replace(/[_\s-]+/g, '');
}

/** Score how well two field names match as a join key (0–1) */
function joinScore(a: string, b: string): number {
  if (a === b) return 1;
  if (a.toLowerCase() === b.toLowerCase()) return 0.95;
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb && na.length > 2) return 0.9;
  // one contains the other
  if (na.includes(nb) && nb.length > 3) return 0.7;
  if (nb.includes(na) && na.length > 3) return 0.7;
  return 0;
}

function stringifyValue(value: string | number | boolean | null | undefined): string {
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

function sampleValues(
  rows: Record<string, string | number | boolean | null>[] | undefined,
  column: string,
): string[] {
  return [...new Set(
    (rows ?? [])
      .map((row) => stringifyValue(row[column]))
      .filter((value) => value.length > 0),
  )];
}

function sampleOverlapRatio(leftValues: string[], rightValues: string[]): number | null {
  if (leftValues.length < 3 || rightValues.length < 3) return null;
  const rightExact = new Set(rightValues);
  const rightNormalized = new Set(rightValues.map((value) => normalizeValue(value)).filter(Boolean));
  let overlap = 0;

  for (const leftValue of leftValues) {
    if (
      rightExact.has(leftValue)
      || rightNormalized.has(normalizeValue(leftValue))
    ) {
      overlap += 1;
    }
  }

  return leftValues.length === 0 ? null : overlap / leftValues.length;
}

// ── Core logic ────────────────────────────────────────────────────────────────

export function suggestPipelineSteps(
  primary: DatasetMeta,
  secondary?: DatasetMeta,
): SuggestResult {
  const suggestions: SuggestedStep[] = [];

  // ── 1. JOIN suggestions ───────────────────────────────────────────────────
  if (secondary) {
    const joinCandidates: { leftKey: string; rightKey: string; score: number }[] = [];

    for (const lf of primary.fields) {
      for (const rf of secondary.fields) {
        if (lf.type !== rf.type) continue;
        const score = joinScore(lf.name, rf.name);
        if (score >= 0.7) {
          if (lf.type === 'string') {
            const overlap = sampleOverlapRatio(
              sampleValues(primary.sampleRows, lf.name),
              sampleValues(secondary.sampleRows, rf.name),
            );
            if (overlap !== null && overlap < 0.2) continue;
          }
          joinCandidates.push({ leftKey: lf.name, rightKey: rf.name, score });
        }
      }
    }

    // Prefer ID fields
    joinCandidates.sort((a, b) => {
      const aIsId = isIdField(a.leftKey) || isIdField(a.rightKey) ? 1 : 0;
      const bIsId = isIdField(b.leftKey) || isIdField(b.rightKey) ? 1 : 0;
      return (bIsId - aIsId) || (b.score - a.score);
    });

    const seen = new Set<string>();
    for (const c of joinCandidates.slice(0, 3)) {
      const key = `${c.leftKey}__${c.rightKey}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const confidence = c.score >= 0.9 ? 'high' : c.score >= 0.7 ? 'medium' : 'low';
      suggestions.push({
        step: { type: 'join', rightDatasetId: secondary.id, leftKey: c.leftKey, rightKey: c.rightKey, mode: 'inner' },
        confidence,
        label: `Join ${primary.name} ⟕ ${secondary.name} on ${c.leftKey} = ${c.rightKey}`,
        reason: `Feldbenennung stimmt überein (Score ${Math.round(c.score * 100)}%). ${c.score >= 0.9 ? 'Wahrscheinlich Fremdschlüssel.' : 'Möglicher Join-Kandidat.'}`,
      });

      // Also offer a LEFT join variant
      suggestions.push({
        step: { type: 'join', rightDatasetId: secondary.id, leftKey: c.leftKey, rightKey: c.rightKey, mode: 'left' },
        confidence: confidence === 'high' ? 'medium' : 'low',
        label: `LEFT Join ${primary.name} ⟕ ${secondary.name} on ${c.leftKey} = ${c.rightKey}`,
        reason: `Wie oben, aber alle Zeilen aus ${primary.name} bleiben erhalten.`,
      });
    }
  }

  // ── 2. AGGREGATE suggestions ──────────────────────────────────────────────
  const numericFields = primary.fields.filter(isNumeric);
  const categoryFields = primary.fields.filter((f) => isCategory(f) && !isIdField(f.name));
  const dateFields = primary.fields.filter(isDateField);

  // Group by category + count
  if (categoryFields.length > 0) {
    const groupBy = categoryFields.slice(0, 2).map((f) => f.name);
    suggestions.push({
      step: {
        type: 'aggregate',
        groupBy,
        aggregations: [{ column: primary.fields[0]?.name ?? 'id', fn: 'count', outputName: "count" }],
      },
      confidence: 'high',
      label: `Zählen nach ${groupBy.join(', ')}`,
      reason: `${groupBy.join(', ')} ${groupBy.length > 1 ? 'sind Kategorie-Felder' : 'ist ein Kategorie-Feld'} — gut geeignet als GROUP BY.`,
    });
  }

  // Group by date + sum numeric
  if (dateFields.length > 0 && numericFields.length > 0) {
    const dateField = dateFields[0]!;
    const numField = numericFields[0]!;
    suggestions.push({
      step: {
        type: 'aggregate',
        groupBy: [dateField.name],
        aggregations: [
          { column: numField.name, fn: 'sum', outputName: `total_${numField.name}` },
          { column: numField.name, fn: 'avg', outputName: `avg_${numField.name}` },
        ],
      },
      confidence: 'high',
      label: `Summe + Durchschnitt von ${numField.name} nach ${dateField.name}`,
      reason: `Zeitreihen-Aggregation: ${dateField.name} ist ein Datumsfeld, ${numField.name} ist numerisch.`,
    });
  }

  // Sum all numeric fields
  if (numericFields.length > 0) {
    const aggs = numericFields.slice(0, 4).map((f) => ({
      column: f.name,
      fn: 'sum' as const,
      outputName: `sum_${f.name}`,
    }));
    const groupCandidates = categoryFields.slice(0, 1).map((f) => f.name);
    if (groupCandidates.length > 0 || aggs.length > 1) {
      suggestions.push({
        step: { type: 'aggregate', groupBy: groupCandidates, aggregations: aggs },
        confidence: 'medium',
        label: `Summe aller numerischen Felder${groupCandidates.length ? ` nach ${groupCandidates[0]}` : ''}`,
        reason: `${numericFields.map((f) => f.name).join(', ')} sind numerisch und können aufsummiert werden.`,
      });
    }
  }

  // ── 3. FILTER suggestions ─────────────────────────────────────────────────
  // Filter nulls on required-looking fields
  const nullableImportant = primary.fields.filter((f) => f.nullable !== false && (isIdField(f.name) || isNumeric(f)));
  for (const f of nullableImportant.slice(0, 2)) {
    suggestions.push({
      step: { type: 'filter', column: f.name, operator: 'not_null' },
      confidence: 'medium',
      label: `Filter: ${f.name} nicht leer`,
      reason: `${f.name} scheint ein wichtiges Feld zu sein — leere Werte herausfiltern verbessert die Datenqualität.`,
    });
  }

  // ── 4. SELECT suggestions ─────────────────────────────────────────────────
  // If many fields, suggest a select of the most relevant ones
  if (primary.fields.length > 6) {
    const relevant = primary.fields
      .filter((f) => !f.name.toLowerCase().includes('internal') && !f.name.toLowerCase().includes('raw'))
      .slice(0, 6)
      .map((f) => f.name);
    suggestions.push({
      step: { type: 'select', columns: relevant },
      confidence: 'low',
      label: `Spalten auf ${relevant.length} wichtigste reduzieren`,
      reason: `Dataset hat ${primary.fields.length} Spalten — Select-Step verbessert Performance und Übersicht.`,
    });
  }

  // ── Sort: high > medium > low, joins first ────────────────────────────────
  const order = { high: 0, medium: 1, low: 2 };
  const typeOrder = {
    join: 0,
    derive: 1,
    aggregate: 2,
    distinct: 3,
    filter: 4,
    select: 5,
    rename: 6,
  };
  suggestions.sort((a, b) => {
    const conf = order[a.confidence] - order[b.confidence];
    if (conf !== 0) return conf;
    return (typeOrder[a.step.type] ?? 9) - (typeOrder[b.step.type] ?? 9);
  });

  const joinCount = suggestions.filter((s) => s.step.type === 'join').length;
  const aggCount = suggestions.filter((s) => s.step.type === 'aggregate').length;
  const summary = [
    joinCount > 0 && `${joinCount} Join-Vorschlag${joinCount > 1 ? 'e' : ''}`,
    aggCount > 0 && `${aggCount} Aggregations-Vorschlag${aggCount > 1 ? 'e' : ''}`,
    `${suggestions.filter((s) => s.step.type === 'filter').length} Filter`,
  ].filter(Boolean).join(' · ');

  return { suggestions, summary };
}
