import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FileConfigRegistry } from '../src/index.js';

async function createRegistry() {
  const directory = await mkdtemp(join(tmpdir(), 'koiforge-config-'));
  const registry = new FileConfigRegistry({
    filePath: join(directory, 'config.json'),
  });

  return {
    registry,
    cleanup: async () => rm(directory, { recursive: true, force: true }),
  };
}

describe('file config registry', () => {
  it('lists masked secrets only', async () => {
    const { registry, cleanup } = await createRegistry();

    try {
      const secrets = await registry.listSecrets('global');
      expect(secrets.length).toBeGreaterThan(0);
      expect(secrets[0]?.maskedValue).toMatch(/\*/);
    } finally {
      await cleanup();
    }
  });

  it('resolves global config with secret references masked', async () => {
    const { registry, cleanup } = await createRegistry();

    try {
      const entries = await registry.resolveEntries('global');
      const accessKey = entries.find((entry) => entry.key === 'storage.s3.accessKey');

      expect(accessKey?.source).toBe('secret');
      expect(typeof accessKey?.resolvedValue).toBe('string');
    } finally {
      await cleanup();
    }
  });

  it('supports upserting config entries and secrets', async () => {
    const { registry, cleanup } = await createRegistry();

    try {
      await registry.upsertSecret({
        name: 'api.token',
        scope: 'tenant',
        tenantId: 'demo',
        value: 'super-secret-token',
      });

      const entry = await registry.upsertEntry({
        key: 'api.tokenRef',
        scope: 'tenant',
        tenantId: 'demo',
        valueType: 'string',
        value: 'enabled',
      });

      expect(entry.key).toBe('api.tokenRef');
    } finally {
      await cleanup();
    }
  });
});
