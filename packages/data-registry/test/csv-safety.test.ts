import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FileDatasetRegistry, parseCsvTable } from '../src/index.js';

async function createDirectory(): Promise<{ directory: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'koiforge-csv-safety-'));
  return {
    directory,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

describe('CSV connector safety', () => {
  it('preserves BOM, escaped quotes, quoted newlines, leading zeros, and large decimals in previews', async () => {
    const { directory, cleanup } = await createDirectory();
    const csvPath = join(directory, 'values.csv');
    const registryPath = join(directory, 'datasets.json');
    const csv = [
      '\uFEFFid,description,code,amount',
      '001,"hello ""world""",0007,12345678901234567890.123456789',
      '002,"line one\nline two",0008,2.50',
      '',
    ].join('\n');

    try {
      await writeFile(csvPath, csv, 'utf8');
      const registry = new FileDatasetRegistry({ filePath: registryPath });
      const dataset = await registry.registerDataset({
        name: 'CSV Safety',
        namespace: 'safety',
        connectorId: 'csv',
        mode: 'virtual',
        source: { path: csvPath, delimiter: ',' },
      });

      const preview = await registry.previewRows(dataset.id, 10);

      expect(preview.columns).toEqual(['id', 'description', 'code', 'amount']);
      expect(preview.rows).toEqual([
        {
          id: '001',
          description: 'hello "world"',
          code: '0007',
          amount: '12345678901234567890.123456789',
        },
        {
          id: '002',
          description: 'line one\nline two',
          code: '0008',
          amount: '2.50',
        },
      ]);
      expect(preview.rowCount).toBe(2);
      expect(preview.truncated).toBe(false);

      await expect(readFile(csvPath, 'utf8')).resolves.toBe(csv);
    } finally {
      await cleanup();
    }
  });

  it.each([
    ['duplicate header', 'id,id\n1,2\n'],
    ['blank header', 'id,\n1,2\n'],
    ['unsafe __proto__ header', 'id,__proto__\n1,value\n'],
    ['unsafe constructor header', 'id,constructor\n1,value\n'],
    ['unsafe prototype header', 'id,prototype\n1,value\n'],
    ['wrong field count', 'id,label\n1\n'],
  ])('rejects %s through parseCsvTable and CSV preview', async (_label, csv) => {
    const { directory, cleanup } = await createDirectory();
    const csvPath = join(directory, 'invalid.csv');

    try {
      await writeFile(csvPath, csv, 'utf8');
      expect(() => parseCsvTable(csv, ',')).toThrow();

      const registry = new FileDatasetRegistry({ filePath: join(directory, 'datasets.json') });
      const dataset = await registry.registerDataset({
        name: 'Invalid CSV',
        namespace: 'safety',
        connectorId: 'csv',
        mode: 'virtual',
        source: { path: csvPath, delimiter: ',' },
      });

      await expect(registry.previewRows(dataset.id, 10)).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });
});
