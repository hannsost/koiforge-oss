import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { filterAndSortPreview } from '../../../apps/control-plane-api/src/routes/datasets.js';
import { FileDatasetRegistry } from '../src/index.js';

const supplierCsvPath = fileURLToPath(new URL('../../../examples/data/supplier-master.csv', import.meta.url));

async function createRegistry() {
  const directory = await mkdtemp(join(tmpdir(), 'koiforge-datasets-'));
  const registry = new FileDatasetRegistry({
    filePath: join(directory, 'datasets.json'),
  });

  return {
    registry,
    cleanup: async () => rm(directory, { recursive: true, force: true }),
  };
}

describe('file dataset registry', () => {
  it('lists built-in connectors', async () => {
    const { registry, cleanup } = await createRegistry();

    try {
      const connectors = await registry.listConnectors();
      expect(connectors.map((entry) => entry.id)).toEqual(['csv', 'sqlite', 'postgres', 'mysql', 's3', 'kafka']);
    } finally {
      await cleanup();
    }
  });

  it('registers a materialized dataset and creates initial sql access', async () => {
    const { registry, cleanup } = await createRegistry();

    try {
      const dataset = await registry.registerDataset({
        name: 'Supplier Master',
        namespace: 'procurement',
        connectorId: 'csv',
        mode: 'materialized',
        tags: ['supplier', 'core'],
        source: {
          path: './data/suppliers.csv',
          columns: [
            { name: 'supplierId', type: 'string', nullable: false },
            { name: 'name', type: 'string' },
            { name: 'country', type: 'string' },
          ],
        },
      });

      expect(dataset.status).toBe('ready');
      expect(dataset.snapshots).toHaveLength(1);
      expect(dataset.sqlAccess.queryPreview).toContain('koiforge.procurement.supplier_master');
    } finally {
      await cleanup();
    }
  });

  it('supports schema refresh and snapshots', async () => {
    const { registry, cleanup } = await createRegistry();

    try {
      const dataset = await registry.registerDataset({
        name: 'Purchase Orders',
        namespace: 'procurement',
        connectorId: 'postgres',
        mode: 'virtual',
        source: {
          database: 'ops',
          schema: 'public',
          table: 'purchase_orders',
        },
      });

      const refreshed = await registry.refreshSchema(dataset.id);
      const snapshotted = await registry.snapshotDataset(dataset.id, 'nightly-sync');
      const events = await registry.listEvents();

      expect(refreshed.schema.length).toBeGreaterThan(0);
      expect(snapshotted.snapshots).toHaveLength(1);
      expect(events.some((entry) => entry.type === 'dataset.schema-updated')).toBe(true);
      expect(events.some((entry) => entry.type === 'dataset.snapshotted')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('returns preview rows for csv datasets', async () => {
    const { registry, cleanup } = await createRegistry();

    try {
      const dataset = await registry.registerDataset({
        name: 'Supplier Master',
        namespace: 'procurement',
        connectorId: 'csv',
        mode: 'materialized',
        source: {
          path: supplierCsvPath,
          delimiter: ',',
          columns: [
            { name: 'supplierId', type: 'string', nullable: false },
            { name: 'name', type: 'string' },
            { name: 'country', type: 'string' },
            { name: 'riskScore', type: 'number' },
            { name: 'status', type: 'string' },
          ],
        },
      });

      const preview = await registry.previewRows(dataset.id, 2);
      expect(preview.columns).toContain('supplierId');
      expect(preview.rows).toHaveLength(2);
      expect(preview.rows[0]?.supplierId).toBe('SUP-100');
    } finally {
      await cleanup();
    }
  });

  it('throws for a failed source while returning a valid empty csv source as empty', async () => {
    const { registry, cleanup } = await createRegistry();
    let emptyCsvPath: string | undefined;

    try {
      emptyCsvPath = join(tmpdir(), `koiforge-empty-${Date.now()}.csv`);
      await writeFile(emptyCsvPath, 'id,label\n', 'utf8');

      const emptyDataset = await registry.registerDataset({
        name: 'Empty Records',
        namespace: 'test',
        connectorId: 'csv',
        mode: 'virtual',
        source: { path: emptyCsvPath },
      });

      await expect(registry.previewRows(emptyDataset.id, 10)).resolves.toMatchObject({
        columns: ['id', 'label'],
        rows: [],
        rowCount: 0,
        truncated: false,
      });

      const failedDataset = await registry.registerDataset({
        name: 'Missing Records',
        namespace: 'test',
        connectorId: 'csv',
        mode: 'virtual',
        source: { path: join(tmpdir(), `koiforge-missing-${Date.now()}.csv`) },
      });

      await expect(registry.previewRows(failedDataset.id, 10)).rejects.toThrow(
        /konnte.*CSV.*nicht geladen/i,
      );
    } finally {
      if (emptyCsvPath) await rm(emptyCsvPath, { force: true });
      await cleanup();
    }
  });

  it('keeps explicit inline preview rows and their truncation metadata', async () => {
    const { registry, cleanup } = await createRegistry();

    try {
      const dataset = await registry.registerInlineDataset({
        name: 'Demo Records',
        namespace: 'demo',
        rows: [
          { id: 1, label: 'first' },
          { id: 2, label: 'second' },
          { id: 3, label: 'third' },
        ],
      });

      await expect(registry.previewRows(dataset.id, 2)).resolves.toMatchObject({
        rows: [
          { id: 1, label: 'first' },
          { id: 2, label: 'second' },
        ],
        rowCount: 3,
        truncated: true,
      });
    } finally {
      await cleanup();
    }
  });

  it('throws instead of synthesizing rows for a connector without a preview source', async () => {
    const { registry, cleanup } = await createRegistry();

    try {
      const dataset = await registry.registerDataset({
        name: 'Remote Records',
        namespace: 'test',
        connectorId: 'mysql',
        mode: 'virtual',
        source: {
          database: 'operations',
          table: 'records',
          columns: [{ name: 'id', type: 'integer', nullable: false }],
        },
      });

      await expect(registry.previewRows(dataset.id, 10)).rejects.toThrow(
        /mysql.*nicht unterstützt/i,
      );
    } finally {
      await cleanup();
    }
  });

  it('preserves source row count and truncation after filtering a preview', () => {
    const filtered = filterAndSortPreview(
      {
        datasetId: 'demo-records',
        columns: ['id', 'label'],
        rows: [
          { id: 1, label: 'first' },
          { id: 2, label: 'second' },
        ],
        rowCount: 25,
        truncated: true,
      },
      { q: 'second' },
    );

    expect(filtered.rows).toEqual([{ id: 2, label: 'second' }]);
    expect(filtered.rowCount).toBe(25);
    expect(filtered.truncated).toBe(true);
  });
});
