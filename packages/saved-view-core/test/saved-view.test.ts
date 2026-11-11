import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FileSavedViewRegistry } from '../src/index.js';

async function createRegistry() {
  const directory = await mkdtemp(join(tmpdir(), 'koiforge-views-'));
  const registry = new FileSavedViewRegistry({ filePath: join(directory, 'views.json') });

  return {
    registry,
    cleanup: async () => rm(directory, { recursive: true, force: true }),
  };
}

describe('file saved view registry', () => {
  it('stores and lists saved views', async () => {
    const { registry, cleanup } = await createRegistry();

    try {
      await registry.upsertView({
        tenantId: 'demo',
        type: 'dataset-preview',
        name: 'Sample Events by Severity',
        createdBy: 'admin',
        state: { datasetId: 'platform_sample_events', filters: [{ field: 'severity', value: 'warning' }] },
      });

      await registry.upsertView({
        tenantId: 'demo',
        type: 'dataset-preview',
        name: 'All Metrics',
        createdBy: 'admin',
        state: { datasetId: 'platform_sample_metrics', q: '' },
      });

      const views = await registry.listViews('demo', 'dataset-preview');
      expect(views.some((entry) => entry.name === 'Sample Events by Severity')).toBe(true);
      expect(views.some((entry) => entry.name === 'All Metrics')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('updates an existing view by name and type', async () => {
    const { registry, cleanup } = await createRegistry();

    try {
      await registry.upsertView({
        tenantId: 'demo',
        type: 'object-explorer',
        name: 'Events by Source',
        createdBy: 'admin',
        state: { objectType: 'platform-event', sortBy: 'source' },
      });

      const updated = await registry.upsertView({
        tenantId: 'demo',
        type: 'object-explorer',
        name: 'Events by Source',
        createdBy: 'admin',
        state: { objectType: 'platform-event', sortBy: 'source', sortDir: 'desc' },
      });

      expect(updated.state).toMatchObject({ sortDir: 'desc' });
      const views = await registry.listViews('demo', 'object-explorer');
      expect(views.some((entry) => entry.name === 'Events by Source')).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
