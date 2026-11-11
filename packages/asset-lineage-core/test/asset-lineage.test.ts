import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FileAssetLineageRegistry } from '../src/index.js';

async function createRegistry() {
  const directory = await mkdtemp(join(tmpdir(), 'koiforge-lineage-'));
  const registry = new FileAssetLineageRegistry({
    filePath: join(directory, 'lineage.json'),
  });

  return {
    registry,
    cleanup: async () => rm(directory, { recursive: true, force: true }),
  };
}

describe('file asset lineage registry', () => {
  it('creates assets and records runs', async () => {
    const { registry, cleanup } = await createRegistry();

    try {
      const asset = await registry.upsertAsset({
        id: 'dataset-a',
        name: 'Dataset A',
        kind: 'dataset',
        tenantId: 'procurement-demo',
      });

      const run = await registry.recordRun({
        assetId: asset.id,
        status: 'succeeded',
        triggeredBy: 'system',
      });

      expect(run.assetId).toBe(asset.id);
      expect((await registry.listAssets()).length).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it('records lineage edges', async () => {
    const { registry, cleanup } = await createRegistry();

    try {
      await registry.upsertAsset({ id: 'dataset-a', name: 'Dataset A', kind: 'dataset', tenantId: 'procurement-demo' });
      await registry.upsertAsset({ id: 'dataset-b', name: 'Dataset B', kind: 'dataset', tenantId: 'procurement-demo' });
      const edge = await registry.recordEdge({ fromAssetId: 'dataset-a', toAssetId: 'dataset-b', operation: 'transform' });

      expect(edge.operation).toBe('transform');
      expect((await registry.listEdges()).length).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it('seeds assets from datasets', async () => {
    const { registry, cleanup } = await createRegistry();

    try {
      const seeded = await registry.seedFromDatasets('procurement-demo', [
        { id: 'dataset-a', name: 'Dataset A', tags: ['seeded'] },
        { id: 'dataset-b', name: 'Dataset B' },
      ]);

      expect(seeded).toHaveLength(2);
      expect((await registry.listEvents()).length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });
});

