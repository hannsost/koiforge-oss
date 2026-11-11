import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  CreatePipelineInput,
  PipelineDefinition,
  PipelineRegistryState,
  PipelineRun,
} from './types.js';

export interface FilePipelineRegistryOptions {
  filePath: string;
}

function emptyState(): PipelineRegistryState {
  return { pipelines: {}, runs: [] };
}

export class FilePipelineRegistry {
  readonly #filePath: string;

  constructor(options: FilePipelineRegistryOptions) {
    this.#filePath = options.filePath;
  }

  async #readState(): Promise<PipelineRegistryState> {
    try {
      const raw = await readFile(this.#filePath, 'utf-8');
      return JSON.parse(raw) as PipelineRegistryState;
    } catch {
      return emptyState();
    }
  }

  async #writeState(state: PipelineRegistryState): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true });
    await writeFile(this.#filePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  async listPipelines(): Promise<PipelineDefinition[]> {
    const state = await this.#readState();
    return Object.values(state.pipelines).sort((a, b) => a.name.localeCompare(b.name));
  }

  async getPipeline(id: string): Promise<PipelineDefinition | null> {
    const state = await this.#readState();
    return state.pipelines[id] ?? null;
  }

  async createPipeline(input: CreatePipelineInput): Promise<PipelineDefinition> {
    const state = await this.#readState();
    const now = new Date().toISOString();
    const pipeline: PipelineDefinition = {
      id: randomUUID(),
      ...input,
      createdAt: now,
      updatedAt: now,
    };
    state.pipelines[pipeline.id] = pipeline;
    await this.#writeState(state);
    return pipeline;
  }

  async updatePipeline(id: string, input: Partial<CreatePipelineInput>): Promise<PipelineDefinition> {
    const state = await this.#readState();
    const existing = state.pipelines[id];
    if (!existing) throw new Error(`Pipeline '${id}' not found.`);
    const updated: PipelineDefinition = {
      ...existing,
      ...input,
      id,
      updatedAt: new Date().toISOString(),
    };
    state.pipelines[id] = updated;
    await this.#writeState(state);
    return updated;
  }

  async setOutputDataset(pipelineId: string, outputDatasetId: string): Promise<void> {
    const state = await this.#readState();
    const existing = state.pipelines[pipelineId];
    if (existing) {
      existing.lastOutputDatasetId = outputDatasetId;
      existing.updatedAt = new Date().toISOString();
      await this.#writeState(state);
    }
  }

  async deletePipeline(id: string): Promise<void> {
    const state = await this.#readState();
    if (!state.pipelines[id]) throw new Error(`Pipeline '${id}' not found.`);
    delete state.pipelines[id];
    state.runs = state.runs.filter((r) => r.pipelineId !== id);
    await this.#writeState(state);
  }

  async listRuns(pipelineId?: string): Promise<PipelineRun[]> {
    const state = await this.#readState();
    const runs = pipelineId
      ? state.runs.filter((r) => r.pipelineId === pipelineId)
      : state.runs;
    return runs.slice(-50).reverse();
  }

  async recordRun(run: PipelineRun): Promise<void> {
    const state = await this.#readState();
    const idx = state.runs.findIndex((r) => r.id === run.id);
    if (idx >= 0) {
      state.runs[idx] = run;
    } else {
      state.runs.push(run);
    }
    // Keep last 200 runs
    if (state.runs.length > 200) state.runs = state.runs.slice(-200);
    await this.#writeState(state);
  }
}
