import { access, lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FileDatasetRegistry } from '../src/index.js';

async function createDirectory(): Promise<{ directory: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'koiforge-registry-safety-'));
  return {
    directory,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function inlineInput(name: string, value = name) {
  return {
    name,
    namespace: 'safety',
    rows: [{ id: value, label: `row-${value}` }],
  };
}

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toThrow();
}

describe('file dataset registry persistence safety', () => {
  it('returns empty collections for a missing registry without creating the file', async () => {
    const { directory, cleanup } = await createDirectory();
    const filePath = join(directory, 'datasets.json');
    const registry = new FileDatasetRegistry({ filePath });

    try {
      await expect(registry.listDatasets()).resolves.toEqual([]);
      await expect(registry.getDataset('missing')).resolves.toBeNull();
      await expect(registry.listEvents()).resolves.toEqual([]);
      await expectMissing(filePath);
    } finally {
      await cleanup();
    }
  });

  it.each([
    ['invalid JSON', '{"datasets":'],
    ['null state', 'null'],
    ['missing datasets', '{"events":[]}'],
    ['missing events', '{"datasets":{}}'],
    ['datasets is an array', '{"datasets":[],"events":[]}'],
    ['events is an object', '{"datasets":{},"events":{}}'],
    ['invalid event record', '{"datasets":{},"events":[{}]}'],
    ['invalid dataset record', '{"datasets":{"broken":{"id":"broken"}},"events":[]}'],
  ])('rejects %s and preserves the original bytes during mutations', async (_label, original) => {
    const { directory, cleanup } = await createDirectory();
    const filePath = join(directory, 'datasets.json');
    const registry = new FileDatasetRegistry({ filePath });

    try {
      await writeFile(filePath, original, 'utf8');

      await expect(registry.listDatasets()).rejects.toThrow();
      await expect(registry.registerInlineDataset(inlineInput('must-not-write'))).rejects.toThrow();
      await expect(readFile(filePath, 'utf8')).resolves.toBe(original);
    } finally {
      await cleanup();
    }
  });

  it('propagates a real read error when the registry path is a directory and preserves it', async () => {
    const { directory, cleanup } = await createDirectory();
    const filePath = join(directory, 'datasets.json');

    try {
      await mkdir(filePath);
      const registry = new FileDatasetRegistry({ filePath });

      await expect(registry.listDatasets()).rejects.toThrow();
      await expect(registry.registerInlineDataset(inlineInput('must-fail'))).rejects.toThrow();
      expect((await stat(filePath)).isDirectory()).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('rejects a symlink to an existing registry without changing the link or target', async () => {
    const { directory, cleanup } = await createDirectory();
    const targetPath = join(directory, 'datasets.json');
    const linkPath = join(directory, 'datasets-link.json');

    try {
      const targetRegistry = new FileDatasetRegistry({ filePath: targetPath });
      await targetRegistry.registerInlineDataset(inlineInput('symlink-target'));
      const targetBytes = await readFile(targetPath, 'utf8');
      await symlink('datasets.json', linkPath);
      const linkTarget = await readlink(linkPath);
      const registry = new FileDatasetRegistry({ filePath: linkPath });

      await expect(registry.listDatasets()).rejects.toThrow();
      await expect(registry.registerInlineDataset(inlineInput('must-not-follow-link'))).rejects.toThrow();
      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
      await expect(readlink(linkPath)).resolves.toBe(linkTarget);
      await expect(readFile(targetPath, 'utf8')).resolves.toBe(targetBytes);
    } finally {
      await cleanup();
    }
  });

  it('rejects a dangling registry symlink without creating its missing target', async () => {
    const { directory, cleanup } = await createDirectory();
    const missingTargetPath = join(directory, 'missing-datasets.json');
    const linkPath = join(directory, 'datasets-link.json');

    try {
      await symlink('missing-datasets.json', linkPath);
      const linkTarget = await readlink(linkPath);
      const registry = new FileDatasetRegistry({ filePath: linkPath });

      await expect(registry.listDatasets()).rejects.toThrow();
      await expect(registry.registerInlineDataset(inlineInput('must-not-create-target'))).rejects.toThrow();
      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
      await expect(readlink(linkPath)).resolves.toBe(linkTarget);
      await expectMissing(missingTargetPath);
    } finally {
      await cleanup();
    }
  });

  it('serializes unique registrations across two instances and retains existing entries and events', async () => {
    const { directory, cleanup } = await createDirectory();
    const filePath = join(directory, 'datasets.json');
    const first = new FileDatasetRegistry({ filePath });
    const second = new FileDatasetRegistry({ filePath: `${directory}/nested/../datasets.json` });

    try {
      const existing = await first.registerInlineDataset(inlineInput('existing', 'existing'));
      const registrations = Array.from({ length: 20 }, (_, index) => {
        const registry = index % 2 === 0 ? first : second;
        return registry.registerInlineDataset(inlineInput(`parallel-${index}`, String(index)));
      });
      const results = await Promise.all(registrations);
      const persisted = await first.listDatasets();
      const events = await first.listEvents(100);

      expect(results).toHaveLength(20);
      expect(new Set(results.map((dataset) => dataset.id)).size).toBe(20);
      expect(persisted).toHaveLength(21);
      expect(persisted.some((dataset) => dataset.id === existing.id)).toBe(true);
      expect(events.filter((event) => event.type === 'dataset.uploaded')).toHaveLength(21);
      expect(events.some((event) => event.datasetId === existing.id)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('derives a complete nullable schema from every inline row and preserves rows exactly', async () => {
    const { directory, cleanup } = await createDirectory();
    const registry = new FileDatasetRegistry({ filePath: join(directory, 'datasets.json') });
    const rows = [{ id: null }, { id: 123, extra: 'sichtbar' }];

    try {
      const dataset = await registry.registerInlineDataset({
        name: 'Complete Schema',
        namespace: 'schema',
        rows,
      });

      expect(dataset.schema).toEqual([
        { name: 'id', type: 'integer', nullable: true },
        { name: 'extra', type: 'string', nullable: true },
      ]);
      const preview = await registry.previewRows(dataset.id);
      expect(preview.rows).toEqual(rows);
    } finally {
      await cleanup();
    }
  });

  it.each(['nullable string', 'description number', 'event details number', 'unsafe previewRows key'])
    ('rejects persisted %s while preserving the original bytes', async (variant) => {
      type PersistedState = {
        datasets: Record<string, {
          description?: unknown;
          schema: Array<Record<string, unknown>>;
          source: Record<string, unknown>;
        }>;
        events: Array<Record<string, unknown>>;
      };

      const { directory, cleanup } = await createDirectory();
      const filePath = join(directory, 'datasets.json');
      const registry = new FileDatasetRegistry({ filePath });

      try {
        const dataset = await registry.registerInlineDataset(inlineInput(`persisted-${variant}`));
        const persisted = JSON.parse(await readFile(filePath, 'utf8')) as PersistedState;
        const stored = persisted.datasets[dataset.id]!;

        if (variant === 'nullable string') stored.schema[0]!.nullable = 'yes';
        if (variant === 'description number') stored.description = 42;
        if (variant === 'event details number') persisted.events[0]!.details = 42;
        if (variant === 'unsafe previewRows key') {
          stored.source.previewRows = [JSON.parse('{"__proto__":"blocked"}') as Record<string, unknown>];
        }

        const invalidBytes = `${JSON.stringify(persisted, null, 2)}\n`;
        await writeFile(filePath, invalidBytes, 'utf8');

        await expect(registry.listDatasets()).rejects.toThrow();
        await expect(registry.registerInlineDataset(inlineInput('must-not-overwrite-invalid-state'))).rejects.toThrow();
        await expect(readFile(filePath, 'utf8')).resolves.toBe(invalidBytes);
      } finally {
        await cleanup();
      }
    });

  it('widens mixed numeric inline fields and marks mixed string/number fields as json without conversion', async () => {
    const { directory, cleanup } = await createDirectory();
    const registry = new FileDatasetRegistry({ filePath: join(directory, 'datasets.json') });

    try {
      const numeric = await registry.registerInlineDataset({
        name: 'Mixed Numbers',
        namespace: 'schema',
        rows: [{ value: 1 }, { value: 1.5 }],
      });
      const mixedRows = [{ value: '001' }, { value: 2 }];
      const mixed = await registry.registerInlineDataset({
        name: 'Mixed Values',
        namespace: 'schema',
        rows: mixedRows,
      });

      expect(numeric.schema).toEqual([{ name: 'value', type: 'number', nullable: false }]);
      expect(mixed.schema).toEqual([{ name: 'value', type: 'json', nullable: false }]);
      const mixedPreview = await registry.previewRows(mixed.id);
      expect(mixedPreview.rows).toEqual(mixedRows);
    } finally {
      await cleanup();
    }
  });

  it('allows exactly one winner for concurrent registrations of the same id', async () => {
    const { directory, cleanup } = await createDirectory();
    const filePath = join(directory, 'datasets.json');
    const first = new FileDatasetRegistry({ filePath });
    const second = new FileDatasetRegistry({ filePath: `${directory}/nested/../datasets.json` });

    try {
      const attempts = Array.from({ length: 8 }, (_, index) => {
        const registry = index % 2 === 0 ? first : second;
        return registry.registerInlineDataset(inlineInput('same-id', String(index)));
      });
      const results = await Promise.allSettled(attempts);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(7);
      await expect(first.listDatasets()).resolves.toHaveLength(1);
      await expect(first.listEvents(100)).resolves.toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it('does not lose snapshots when two instances snapshot one dataset in parallel', async () => {
    const { directory, cleanup } = await createDirectory();
    const filePath = join(directory, 'datasets.json');
    const first = new FileDatasetRegistry({ filePath });
    const second = new FileDatasetRegistry({ filePath: `${directory}/nested/../datasets.json` });

    try {
      const dataset = await first.registerInlineDataset(inlineInput('snapshot-target'));
      const snapshots = Array.from({ length: 12 }, (_, index) => {
        const registry = index % 2 === 0 ? first : second;
        return registry.snapshotDataset(dataset.id, `parallel-${index}`);
      });

      await expect(Promise.all(snapshots)).resolves.toHaveLength(12);
      const persisted = await first.getDataset(dataset.id);
      const events = await first.listEvents(100);

      expect(persisted?.snapshots).toHaveLength(13);
      expect(events.filter((event) => event.type === 'dataset.snapshotted')).toHaveLength(12);
    } finally {
      await cleanup();
    }
  });

  it('releases the transaction queue after a failed mutation', async () => {
    const { directory, cleanup } = await createDirectory();
    const filePath = join(directory, 'datasets.json');
    const registry = new FileDatasetRegistry({ filePath });

    try {
      const failed = registry.snapshotDataset('does-not-exist', 'must-fail');
      const succeeded = registry.registerInlineDataset(inlineInput('after-failure'));
      const results = await Promise.allSettled([failed, succeeded]);

      expect(results[0]?.status).toBe('rejected');
      expect(results[1]?.status).toBe('fulfilled');
      await expect(registry.listDatasets()).resolves.toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it('keeps concurrent readers on complete JSON while writes are in flight and writes mode 0600', async () => {
    const { directory, cleanup } = await createDirectory();
    const filePath = join(directory, 'datasets.json');
    const first = new FileDatasetRegistry({ filePath });
    const second = new FileDatasetRegistry({ filePath: `${directory}/nested/../datasets.json` });

    try {
      await first.registerInlineDataset(inlineInput('reader-seed'));
      const readErrors: unknown[] = [];
      let writing = true;
      const reader = (async () => {
        while (writing) {
          try {
            JSON.parse(await readFile(filePath, 'utf8'));
          } catch (error) {
            readErrors.push(error);
          }
          await new Promise<void>((resolveNext) => setImmediate(resolveNext));
        }
      })();

      try {
        await Promise.all(
          Array.from({ length: 15 }, (_, index) => {
            const registry = index % 2 === 0 ? first : second;
            return registry.registerInlineDataset(inlineInput(`reader-${index}`));
          }),
        );
      } finally {
        writing = false;
        await reader;
      }

      expect(readErrors).toEqual([]);
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    } finally {
      await cleanup();
    }
  });
});
