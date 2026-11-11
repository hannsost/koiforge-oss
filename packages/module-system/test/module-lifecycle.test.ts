import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FileModuleRegistry } from '../src/index.js';

const procurementManifestPath = fileURLToPath(
  new URL('../../../examples/modules/procurement-core/module.yaml', import.meta.url),
);
const supplierRiskManifestPath = fileURLToPath(
  new URL('../../../examples/modules/supplier-risk-pack/module.yaml', import.meta.url),
);

async function createRegistry(): Promise<{ registry: FileModuleRegistry; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'koiforge-registry-'));
  const registry = new FileModuleRegistry({
    filePath: join(directory, 'registry.json'),
    coreVersion: '0.1.0',
  });

  return {
    registry,
    cleanup: async () => rm(directory, { recursive: true, force: true }),
  };
}

describe('file module registry', () => {
  it('rejects modules with unresolved ontology contracts', async () => {
    const { registry, cleanup } = await createRegistry();

    try {
      await expect(registry.installFromFile(supplierRiskManifestPath)).rejects.toThrow(/kein kompatibler Vertrag/i);
    } finally {
      await cleanup();
    }
  });

  it('installs, enables and exposes capabilities', async () => {
    const { registry, cleanup } = await createRegistry();

    try {
      await registry.installFromFile(procurementManifestPath);
      await registry.installFromFile(supplierRiskManifestPath);
      await registry.enableModule('procurement-core-pack');
      await registry.enableModule('supplier-risk-pack');

      const capabilities = await registry.listCapabilities();
      const modules = await registry.listModules();

      expect(modules).toHaveLength(2);
      expect(capabilities.some((entry) => entry.capability === 'action-engine')).toBe(true);
      expect(capabilities.some((entry) => entry.moduleId === 'supplier-risk-pack')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('supports upgrade and rollback', async () => {
    const { registry, cleanup } = await createRegistry();

    try {
      const baseManifest = await readFile(procurementManifestPath, 'utf8');
      const upgradedManifest = baseManifest.replace('version: 1.0.0', 'version: 1.1.0');

      await registry.installRawText(baseManifest, procurementManifestPath);
      await registry.installRawText(upgradedManifest, 'inline-upgrade');
      await registry.rollbackModule('procurement-core-pack', '1.0.0');

      const moduleRecord = await registry.getModule('procurement-core-pack');
      expect(moduleRecord?.currentVersion).toBe('1.0.0');
    } finally {
      await cleanup();
    }
  });

  it('rejects ontology property conflicts during install', async () => {
    const { registry, cleanup } = await createRegistry();

    try {
      const conflictingManifest = `
id: supplier-conflict-pack
version: 1.0.0
trust-level: sandboxed
requires:
  core: ">=0.1.0 <1.0.0"
  ontology-contracts:
    - supplier@^1
contributes:
  extends:
    - object: supplier@^1
      properties:
        - name: riskScore
          type: string
migrations:
  - from: "0.9.0"
    strategy: additive
`;

      await registry.installFromFile(procurementManifestPath);
      await expect(registry.installRawText(conflictingManifest, 'inline-conflict')).rejects.toThrow(/kollidiert/i);
    } finally {
      await cleanup();
    }
  });
});
