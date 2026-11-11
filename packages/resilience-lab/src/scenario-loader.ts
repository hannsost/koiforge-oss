import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { ResilienceScenario } from './types.js';

function workspaceRoot(): string {
  return process.env.INIT_CWD ?? process.cwd();
}

export function getScenarioPath(scenarioId: string): string {
  return resolve(workspaceRoot(), 'scenarios', 'resilience', `${scenarioId}.json`);
}

export async function loadScenario(scenarioId: string): Promise<ResilienceScenario> {
  const content = await readFile(getScenarioPath(scenarioId), 'utf8');
  return JSON.parse(content) as ResilienceScenario;
}
