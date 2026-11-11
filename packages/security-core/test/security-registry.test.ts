import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FileSecurityRegistry } from '../src/index.js';

async function createRegistry() {
  const directory = await mkdtemp(join(tmpdir(), 'koiforge-security-'));
  const registry = new FileSecurityRegistry({
    filePath: join(directory, 'security.json'),
  });

  return {
    registry,
    cleanup: async () => rm(directory, { recursive: true, force: true }),
  };
}

describe('file security registry', () => {
  it('returns a default admin session', async () => {
    const { registry, cleanup } = await createRegistry();

    try {
      const session = await registry.getSession();

      expect(session.user.id).toBe('admin');
      expect(session.tenant.id).toBe('demo');
      expect(session.permissions).toContain('modules.manage');
    } finally {
      await cleanup();
    }
  });

  it('supports tenant-aware viewer sessions', async () => {
    const { registry, cleanup } = await createRegistry();

    try {
      const session = await registry.getSession({ userId: 'analyst', tenantId: 'demo' });

      expect(session.permissions).toContain('datasets.read');
      expect(session.permissions).not.toContain('datasets.manage');
    } finally {
      await cleanup();
    }
  });

  it('rejects missing permissions', async () => {
    const { registry, cleanup } = await createRegistry();

    try {
      const session = await registry.getSession({ userId: 'analyst', tenantId: 'demo' });
      expect(() => registry.assertPermissions(session, ['datasets.manage'])).toThrow(/Fehlende Berechtigung/i);
    } finally {
      await cleanup();
    }
  });
});
