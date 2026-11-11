import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  expectedFreshnessRows,
  validateFreshnessRule,
  verifyFreshnessRows,
  type FreshnessRule,
} from '../src/analysis/freshness-contract.js';
import type { ImportRow } from '../src/import-capability/isolated-executor.js';

const rule: FreshnessRule = {
  asOf: '2024-03-01T00:00:00+02:00',
  maxAgeSeconds: 3_600,
  timestampMeaning: 'source_updated_at',
  timezone: 'explicit-offset',
};

const inputRows: ImportRow[] = [
  { sourceId: 'boundary', sourceUpdatedAt: '2024-02-29T23:00:00+02:00' },
  { sourceId: 'stale', sourceUpdatedAt: '2024-02-29T22:59:59+02:00' },
  { sourceId: 'same-instant', sourceUpdatedAt: '2024-02-29T22:00:00Z' },
  { sourceId: 'missing', sourceUpdatedAt: null },
  { sourceId: 'empty', sourceUpdatedAt: '' },
  { sourceId: 'invalid-calendar', sourceUpdatedAt: '2024-02-30T22:00:00Z' },
  { sourceId: 'future', sourceUpdatedAt: '2024-03-01T00:00:01+02:00' },
];

test('validates the freshness rule schema and strict calendar timestamps', () => {
  assert.deepEqual(validateFreshnessRule(rule), rule);
  assert.throws(() => validateFreshnessRule({ ...rule, maxAgeSeconds: 0 }), /maxAgeSeconds/);
  assert.throws(() => validateFreshnessRule({ ...rule, maxAgeSeconds: 315_360_001 }), /maxAgeSeconds/);
  assert.throws(() => validateFreshnessRule({ ...rule, maxAgeSeconds: 1.5 }), /maxAgeSeconds/);
  assert.throws(() => validateFreshnessRule({ ...rule, asOf: '2024-02-30T00:00:00Z' }), /asOf/);
  assert.throws(() => validateFreshnessRule({ ...rule, asOf: '2024-03-01T00:00:00' }), /asOf/);
  assert.throws(() => validateFreshnessRule({ ...rule, timezone: 'local' }), /timestampMeaning\/timezone/);
  assert.throws(() => validateFreshnessRule({ ...rule, extra: true }), /exactly/);
});

test('produces deterministic current, stale, and unassessable rows in input order', () => {
  assert.deepEqual(expectedFreshnessRows(inputRows, rule), [
    {
      sourceId: 'boundary',
      sourceUpdatedAt: '2024-02-29T23:00:00+02:00',
      status: 'current',
      ageSeconds: 3_600,
      reason: 'within_interval',
    },
    {
      sourceId: 'stale',
      sourceUpdatedAt: '2024-02-29T22:59:59+02:00',
      status: 'stale',
      ageSeconds: 3_601,
      reason: 'interval_exceeded',
    },
    {
      sourceId: 'same-instant',
      sourceUpdatedAt: '2024-02-29T22:00:00Z',
      status: 'current',
      ageSeconds: 0,
      reason: 'within_interval',
    },
    {
      sourceId: 'missing',
      sourceUpdatedAt: null,
      status: 'unassessable',
      ageSeconds: null,
      reason: 'missing_timestamp',
    },
    {
      sourceId: 'empty',
      sourceUpdatedAt: '',
      status: 'unassessable',
      ageSeconds: null,
      reason: 'missing_timestamp',
    },
    {
      sourceId: 'invalid-calendar',
      sourceUpdatedAt: '2024-02-30T22:00:00Z',
      status: 'unassessable',
      ageSeconds: null,
      reason: 'invalid_timestamp',
    },
    {
      sourceId: 'future',
      sourceUpdatedAt: '2024-03-01T00:00:01+02:00',
      status: 'unassessable',
      ageSeconds: null,
      reason: 'future_timestamp',
    },
  ]);
});

test('rejects malformed normalized inputs and duplicate IDs', () => {
  assert.throws(() => expectedFreshnessRows([{ sourceId: '', sourceUpdatedAt: null }], rule), /sourceId/);
  assert.throws(() => expectedFreshnessRows([
    { sourceId: 'duplicate', sourceUpdatedAt: null },
    { sourceId: 'duplicate', sourceUpdatedAt: null },
  ], rule), /duplicate/);
  assert.throws(() => expectedFreshnessRows([{ sourceId: 'wrong-type', sourceUpdatedAt: 42 }], rule), /sourceUpdatedAt/);
  assert.throws(() => expectedFreshnessRows([{ sourceId: 'extra', sourceUpdatedAt: null, other: 'x' }], rule), /exactly/);
});

test('accepts exact oracle output and rejects tampered or wrong nonempty output', () => {
  const expected = expectedFreshnessRows(inputRows, rule);
  assert.doesNotThrow(() => verifyFreshnessRows(inputRows, rule, expected));

  const tampered = expected.map((row) => ({ ...row }));
  tampered[0]!.ageSeconds = 3_599;
  assert.throws(() => verifyFreshnessRows(inputRows, rule, tampered), /differ/);

  const wrongNonempty = expected.map((row) => ({ ...row }));
  wrongNonempty[1] = { ...wrongNonempty[1]!, status: 'current', reason: 'within_interval', ageSeconds: 0 };
  assert.throws(() => verifyFreshnessRows(inputRows, rule, wrongNonempty), /differ/);

  assert.throws(() => verifyFreshnessRows(inputRows, rule, [{ sourceId: 'only-one' }]), /schema/);
});
