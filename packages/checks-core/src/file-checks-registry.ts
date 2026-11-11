import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import { evaluateRule } from './evaluator.js';
import type {
  CheckDefinition,
  CheckRun,
  ChecksRegistryState,
  CheckStatus,
  CreateCheckInput,
  DataRow,
} from './types.js';

export interface FileChecksRegistryOptions {
  filePath: string;
}

function emptyState(): ChecksRegistryState {
  return { checks: {}, runs: [] };
}

export class FileChecksRegistry {
  readonly #filePath: string;

  constructor(options: FileChecksRegistryOptions) {
    this.#filePath = options.filePath;
  }

  async #readState(): Promise<ChecksRegistryState> {
    try {
      const raw = await readFile(this.#filePath, 'utf-8');
      return JSON.parse(raw) as ChecksRegistryState;
    } catch {
      return emptyState();
    }
  }

  async #writeState(state: ChecksRegistryState): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true });
    await writeFile(this.#filePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  async listChecks(datasetId?: string): Promise<CheckDefinition[]> {
    const state = await this.#readState();
    const all = Object.values(state.checks);
    return datasetId ? all.filter((c) => c.datasetId === datasetId) : all;
  }

  async getCheck(id: string): Promise<CheckDefinition | null> {
    const state = await this.#readState();
    return state.checks[id] ?? null;
  }

  async createCheck(input: CreateCheckInput): Promise<CheckDefinition> {
    const state = await this.#readState();
    const now = new Date().toISOString();
    const check: CheckDefinition = {
      id: randomUUID(),
      ...input,
      rules: input.rules.map((r) => ({ ...r, id: randomUUID() })),
      createdAt: now,
      updatedAt: now,
    };
    state.checks[check.id] = check;
    await this.#writeState(state);
    return check;
  }

  async deleteCheck(id: string): Promise<void> {
    const state = await this.#readState();
    if (!state.checks[id]) throw new Error(`Check '${id}' not found.`);
    delete state.checks[id];
    state.runs = state.runs.filter((r) => r.checkId !== id);
    await this.#writeState(state);
  }

  async runCheck(checkId: string, rows: DataRow[]): Promise<CheckRun> {
    const state = await this.#readState();
    const check = state.checks[checkId];
    if (!check) throw new Error(`Check '${checkId}' not found.`);

    const ruleResults = check.rules.map((rule) => evaluateRule(rows, rule));
    const allPassed = ruleResults.every((r) => r.passed);
    const status: CheckStatus = allPassed ? 'passed' : 'failed';

    const run: CheckRun = {
      id: randomUUID(),
      checkId,
      datasetId: check.datasetId,
      status,
      ruleResults,
      executedAt: new Date().toISOString(),
      rowsChecked: rows.length,
    };

    state.runs.push(run);
    if (state.runs.length > 200) state.runs = state.runs.slice(-200);
    await this.#writeState(state);

    return run;
  }

  async listRuns(checkId?: string): Promise<CheckRun[]> {
    const state = await this.#readState();
    const runs = checkId ? state.runs.filter((r) => r.checkId === checkId) : state.runs;
    return runs.slice(-50).reverse();
  }

  async latestRunPerCheck(datasetId?: string): Promise<Record<string, CheckRun>> {
    const state = await this.#readState();
    const result: Record<string, CheckRun> = {};
    const checks = Object.values(state.checks).filter((c) => !datasetId || c.datasetId === datasetId);
    for (const check of checks) {
      const runs = state.runs.filter((r) => r.checkId === check.id);
      if (runs.length > 0) result[check.id] = runs[runs.length - 1]!;
    }
    return result;
  }
}
