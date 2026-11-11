import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { validateManifestDocument, validateManifestText } from '../src/index.js';

const procurementManifestPath = fileURLToPath(
  new URL('../../../examples/modules/procurement-core/module.yaml', import.meta.url),
);

describe('module manifest validation', () => {
  it('accepts the procurement example manifest', () => {
    const result = validateManifestText(readFileSync(procurementManifestPath, 'utf8'), procurementManifestPath);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.manifest?.id).toBe('procurement-core-pack');
  });

  it('rejects invalid ontology contract ranges', () => {
    const result = validateManifestDocument({
      id: 'broken-module',
      version: '1.0.0',
      'trust-level': 'sandboxed',
      requires: {
        core: '>=0.1.0 <1.0.0',
        'ontology-contracts': ['supplier@not-a-range'],
      },
      contributes: {},
      migrations: [{ from: '0.9.0', strategy: 'additive' }],
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((entry) => entry.code === 'invalid-contract-reference')).toBe(true);
  });

  it('rejects duplicate object contracts', () => {
    const result = validateManifestDocument({
      id: 'duplicate-object-module',
      version: '1.0.0',
      'trust-level': 'native',
      requires: {
        core: '>=0.1.0 <1.0.0',
      },
      contributes: {
        objects: [
          { name: 'supplier', namespace: 'procurement', 'contract-version': 1 },
          { name: 'supplier', namespace: 'procurement', 'contract-version': 1 },
        ],
      },
      migrations: [{ from: '0.9.0', strategy: 'additive' }],
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((entry) => entry.code === 'duplicate-object')).toBe(true);
  });
});

