import { rowsHash, type ImportRow } from '../import-capability/isolated-executor.js';

export interface FreshnessRule {
  asOf: string;
  maxAgeSeconds: number;
  timestampMeaning: 'source_updated_at';
  timezone: 'explicit-offset';
}

type FreshnessStatus = 'current' | 'stale' | 'unassessable';
type FreshnessReason =
  | 'within_interval'
  | 'interval_exceeded'
  | 'missing_timestamp'
  | 'invalid_timestamp'
  | 'future_timestamp';

const MAX_AGE_SECONDS = 315_360_000;
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;
const RULE_KEYS = ['asOf', 'maxAgeSeconds', 'timestampMeaning', 'timezone'];
const INPUT_ROW_KEYS = ['sourceId', 'sourceUpdatedAt'];
const OUTPUT_ROW_KEYS = ['sourceId', 'sourceUpdatedAt', 'status', 'ageSeconds', 'reason'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Return epoch milliseconds only for strict, calendar-valid ISO-8601 instants. */
function parseIsoInstant(value: string): number | null {
  const match = ISO_INSTANT.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? '';
  const zone = match[8]!;

  if (
    month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59
  ) {
    return null;
  }

  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetPartMinutes = Number(zone.slice(4, 6));
    if (offsetHours > 23 || offsetPartMinutes > 59) return null;
    const sign = zone[0] === '+' ? 1 : -1;
    offsetMinutes = sign * (offsetHours * 60 + offsetPartMinutes);
  }

  // Date.UTC treats years 0–99 as 1900–1999, so set the full year explicitly.
  // Keep sub-millisecond precision in the numeric instant so interval-boundary
  // decisions do not depend on Date's millisecond truncation.
  const fractionalMilliseconds = fraction.length > 0 ? Number(`0.${fraction}`) * 1000 : 0;
  if (!Number.isFinite(fractionalMilliseconds)) return null;
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, 0);
  const timestamp = local.getTime() + fractionalMilliseconds - offsetMinutes * 60_000;
  return Number.isFinite(timestamp) ? timestamp : null;
}

function requireFreshnessRule(value: unknown): FreshnessRule {
  if (!isRecord(value) || !hasExactKeys(value, RULE_KEYS)) {
    throw new Error('Freshness rule must contain exactly asOf, maxAgeSeconds, timestampMeaning, and timezone.');
  }
  if (typeof value.asOf !== 'string' || parseIsoInstant(value.asOf) === null) {
    throw new Error('Freshness rule asOf must be a valid ISO-8601 timestamp with Z or a numeric offset.');
  }
  if (
    typeof value.maxAgeSeconds !== 'number'
    || !Number.isSafeInteger(value.maxAgeSeconds)
    || value.maxAgeSeconds <= 0
    || value.maxAgeSeconds > MAX_AGE_SECONDS
  ) {
    throw new Error(`Freshness rule maxAgeSeconds must be a positive safe integer no greater than ${MAX_AGE_SECONDS}.`);
  }
  if (value.timestampMeaning !== 'source_updated_at' || value.timezone !== 'explicit-offset') {
    throw new Error('Freshness rule timestampMeaning/timezone does not match the freshness contract.');
  }

  return {
    asOf: value.asOf,
    maxAgeSeconds: value.maxAgeSeconds,
    timestampMeaning: 'source_updated_at',
    timezone: 'explicit-offset',
  };
}

export function validateFreshnessRule(value: unknown): FreshnessRule {
  return requireFreshnessRule(value);
}

function normalizedInputRows(rows: ImportRow[]): Array<{ sourceId: string; sourceUpdatedAt: string | null }> {
  if (!Array.isArray(rows)) throw new Error('Freshness input rows must be an array.');

  const seenIds = new Set<string>();
  return rows.map((row, index) => {
    if (!isRecord(row) || !hasExactKeys(row, INPUT_ROW_KEYS)) {
      throw new Error(`Freshness input row ${index + 1} must contain exactly sourceId and sourceUpdatedAt.`);
    }
    if (typeof row.sourceId !== 'string' || row.sourceId.trim().length === 0) {
      throw new Error(`Freshness input row ${index + 1} has an empty sourceId.`);
    }
    if (seenIds.has(row.sourceId)) {
      throw new Error(`Freshness input contains duplicate sourceId '${row.sourceId}'.`);
    }
    seenIds.add(row.sourceId);

    if (row.sourceUpdatedAt !== null && typeof row.sourceUpdatedAt !== 'string') {
      throw new Error(`Freshness input row ${index + 1} has an invalid sourceUpdatedAt.`);
    }
    return { sourceId: row.sourceId, sourceUpdatedAt: row.sourceUpdatedAt };
  });
}

function classifyTimestamp(
  sourceUpdatedAt: string | null,
  asOfMilliseconds: number,
  maxAgeSeconds: number,
): { status: FreshnessStatus; ageSeconds: number | null; reason: FreshnessReason } {
  if (sourceUpdatedAt === null || sourceUpdatedAt.trim().length === 0) {
    return { status: 'unassessable', ageSeconds: null, reason: 'missing_timestamp' };
  }

  const sourceMilliseconds = parseIsoInstant(sourceUpdatedAt);
  if (sourceMilliseconds === null) {
    return { status: 'unassessable', ageSeconds: null, reason: 'invalid_timestamp' };
  }

  const ageSeconds = (asOfMilliseconds - sourceMilliseconds) / 1000;
  if (ageSeconds < 0) {
    return { status: 'unassessable', ageSeconds: null, reason: 'future_timestamp' };
  }
  if (ageSeconds <= maxAgeSeconds) {
    return { status: 'current', ageSeconds, reason: 'within_interval' };
  }
  return { status: 'stale', ageSeconds, reason: 'interval_exceeded' };
}

export function expectedFreshnessRows(rows: ImportRow[], rule: FreshnessRule): ImportRow[] {
  const checkedRule = requireFreshnessRule(rule);
  const normalizedRows = normalizedInputRows(rows);
  const asOfMilliseconds = parseIsoInstant(checkedRule.asOf)!;

  return normalizedRows.map(({ sourceId, sourceUpdatedAt }) => ({
    sourceId,
    sourceUpdatedAt,
    ...classifyTimestamp(sourceUpdatedAt, asOfMilliseconds, checkedRule.maxAgeSeconds),
  }));
}

function validateActualRows(rows: ImportRow[]): void {
  if (!Array.isArray(rows)) throw new Error('Actual freshness rows must be an array.');
  const seenIds = new Set<string>();
  rows.forEach((row, index) => {
    if (!isRecord(row) || !hasExactKeys(row, OUTPUT_ROW_KEYS)) {
      throw new Error(`Actual freshness row ${index + 1} has an invalid schema.`);
    }
    if (typeof row.sourceId !== 'string' || row.sourceId.trim().length === 0 || seenIds.has(row.sourceId)) {
      throw new Error(`Actual freshness row ${index + 1} has an invalid or duplicate sourceId.`);
    }
    seenIds.add(row.sourceId);
    if (row.sourceUpdatedAt !== null && typeof row.sourceUpdatedAt !== 'string') {
      throw new Error(`Actual freshness row ${index + 1} has an invalid sourceUpdatedAt.`);
    }
    if (
      row.status !== 'current' && row.status !== 'stale' && row.status !== 'unassessable'
    ) {
      throw new Error(`Actual freshness row ${index + 1} has an invalid status.`);
    }
    if (row.ageSeconds !== null && (typeof row.ageSeconds !== 'number' || !Number.isFinite(row.ageSeconds) || row.ageSeconds < 0)) {
      throw new Error(`Actual freshness row ${index + 1} has an invalid ageSeconds.`);
    }
    if (
      row.reason !== 'within_interval' && row.reason !== 'interval_exceeded'
      && row.reason !== 'missing_timestamp' && row.reason !== 'invalid_timestamp'
      && row.reason !== 'future_timestamp'
    ) {
      throw new Error(`Actual freshness row ${index + 1} has an invalid reason.`);
    }
  });
}

export function verifyFreshnessRows(
  inputRows: ImportRow[],
  rule: FreshnessRule,
  actualRows: ImportRow[],
): void {
  const expectedRows = expectedFreshnessRows(inputRows, rule);
  validateActualRows(actualRows);
  if (rowsHash(expectedRows) !== rowsHash(actualRows)) {
    throw new Error('Freshness verification failed: actual rows differ from the deterministic expectation.');
  }
}
