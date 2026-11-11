import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { createDefaultAssetLineageState } from './defaults.js';
import type {
  AssetLineageState,
  AssetRecord,
  AssetUpsertInput,
  FileAssetLineageRegistryOptions,
  LineageEdge,
  LineageEdgeInput,
  LineageEvent,
  RunRecord,
  RunRecordInput,
} from './types.js';

function sortByName(left: AssetRecord, right: AssetRecord): number {
  return left.name.localeCompare(right.name);
}

export class FileAssetLineageRegistry {
  readonly #filePath: string;

  constructor(options: FileAssetLineageRegistryOptions) {
    this.#filePath = options.filePath;
  }

  async #readState(): Promise<AssetLineageState> {
    await mkdir(dirname(this.#filePath), { recursive: true });

    try {
      const content = await readFile(this.#filePath, 'utf8');
      return JSON.parse(content) as AssetLineageState;
    } catch {
      const state = createDefaultAssetLineageState();
      await this.#writeState(state);
      return state;
    }
  }

  async #writeState(state: AssetLineageState): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true });
    await writeFile(this.#filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  #event(type: LineageEvent['type'], subjectId: string, details?: string): LineageEvent {
    return {
      id: randomUUID(),
      type,
      subjectId,
      timestamp: new Date().toISOString(),
      details,
    };
  }

  async listAssets(tenantId?: string): Promise<AssetRecord[]> {
    const state = await this.#readState();
    return Object.values(state.assets)
      .filter((entry) => !tenantId || entry.tenantId === tenantId)
      .sort(sortByName);
  }

  async listEdges(): Promise<LineageEdge[]> {
    const state = await this.#readState();
    return [...state.edges];
  }

  async listRuns(assetId?: string): Promise<RunRecord[]> {
    const state = await this.#readState();
    return state.runs.filter((entry) => !assetId || entry.assetId === assetId);
  }

  async listEvents(): Promise<LineageEvent[]> {
    const state = await this.#readState();
    return [...state.events];
  }

  async upsertAsset(input: AssetUpsertInput): Promise<AssetRecord> {
    const state = await this.#readState();
    const id = input.id ?? input.datasetId ?? `asset-${randomUUID()}`;
    const now = new Date().toISOString();
    const existing = state.assets[id];

    const asset: AssetRecord = {
      id,
      name: input.name,
      kind: input.kind,
      tenantId: input.tenantId,
      datasetId: input.datasetId,
      owner: input.owner,
      domain: input.domain,
      description: input.description,
      status: input.status ?? 'active',
      tags: input.tags ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    state.assets[id] = asset;
    state.events.unshift(this.#event('asset.registered', id, `${asset.kind} · ${asset.name}`));
    await this.#writeState(state);
    return asset;
  }

  async recordEdge(input: LineageEdgeInput): Promise<LineageEdge> {
    const state = await this.#readState();
    const edge: LineageEdge = {
      id: randomUUID(),
      fromAssetId: input.fromAssetId,
      toAssetId: input.toAssetId,
      operation: input.operation,
      createdAt: new Date().toISOString(),
    };

    state.edges.unshift(edge);
    state.events.unshift(this.#event('lineage.edge-recorded', edge.id, `${edge.fromAssetId} -> ${edge.toAssetId}`));
    await this.#writeState(state);
    return edge;
  }

  async recordRun(input: RunRecordInput): Promise<RunRecord> {
    const state = await this.#readState();
    const now = new Date().toISOString();
    const run: RunRecord = {
      id: randomUUID(),
      assetId: input.assetId,
      status: input.status,
      startedAt: now,
      finishedAt: input.status === 'running' || input.status === 'queued' ? undefined : now,
      triggeredBy: input.triggeredBy,
      summary: input.summary,
    };

    state.runs.unshift(run);
    state.events.unshift(this.#event('run.recorded', run.id, `${run.assetId} · ${run.status}`));
    await this.#writeState(state);
    return run;
  }

  async seedFromDatasets(
    tenantId: string,
    datasets: Array<{ id: string; name: string; description?: string; tags?: string[] }>,
  ): Promise<AssetRecord[]> {
    const assets: AssetRecord[] = [];

    for (const dataset of datasets) {
      assets.push(
        await this.upsertAsset({
          id: dataset.id,
          name: dataset.name,
          kind: 'dataset',
          tenantId,
          datasetId: dataset.id,
          description: dataset.description,
          tags: dataset.tags ?? [],
          domain: 'operations',
          owner: 'data-platform',
        }),
      );
    }

    return assets;
  }
}

