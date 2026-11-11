import { createHash } from 'node:crypto';
import { executeImportParser, rowsHash, validateRows, type ExecutionReceipt } from './isolated-executor.js';

export async function validateParserCandidate(code: string, fixtureJson: unknown) {
  if (typeof fixtureJson !== 'string' || fixtureJson.length > 65536) {
    throw new Error('Independent parser fixtures are required (JSON, at most 64 KiB).');
  }
  const fixtures: unknown = JSON.parse(fixtureJson);
  if (!Array.isArray(fixtures) || fixtures.length < 3 || fixtures.length > 8) {
    throw new Error('Supply two positive parser fixtures and at least one malformed input.');
  }
  let positive = 0;
  let negative = 0;
  const seen = new Set<string>();
  const executions: ExecutionReceipt[] = [];
  for (const item of fixtures) {
    if (!item || typeof item.input !== 'string' || seen.has(item.input)) {
      throw new Error('Parser fixtures must have distinct string inputs.');
    }
    seen.add(item.input);
    if (item.reject === true) {
      negative += 1;
      let failed = false;
      try { await executeImportParser(code, item.input); } catch { failed = true; }
      if (!failed) throw new Error('Parser accepted a fixture that must be rejected.');
    } else {
      positive += 1;
      const expected = validateRows(item.rows);
      const actual = await executeImportParser(code, item.input);
      if (rowsHash(actual.rows) !== rowsHash(expected)) throw new Error('Independent parser fixture mismatch.');
      executions.push(actual.receipt);
    }
  }
  if (positive < 2 || negative < 1) throw new Error('Two positive fixtures and one negative fixture required.');
  return { suiteHash: createHash('sha256').update(fixtureJson).digest('hex'), positive, negative, executions };
}
