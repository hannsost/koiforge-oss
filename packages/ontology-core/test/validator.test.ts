import { describe, expect, it } from 'vitest';

import { buildOntologySnapshot, validateManifestMerge, validateOntologyModules } from '../src/index.js';

describe('ontology validator', () => {
  it('builds a snapshot from additive modules', () => {
    const result = validateOntologyModules([
      {
        moduleId: 'procurement-core-pack',
        manifest: {
          id: 'procurement-core-pack',
          version: '1.0.0',
          'trust-level': 'native',
          requires: { core: '>=0.1.0 <1.0.0' },
          contributes: {
            objects: [
              {
                name: 'supplier',
                namespace: 'procurement',
                'contract-version': 1,
                properties: [{ name: 'name', type: 'string' }],
              },
            ],
          },
          migrations: [{ from: '0.9.0', strategy: 'additive' }],
        },
      },
      {
        moduleId: 'supplier-risk-pack',
        manifest: {
          id: 'supplier-risk-pack',
          version: '1.0.0',
          'trust-level': 'sandboxed',
          requires: { core: '>=0.1.0 <1.0.0', 'ontology-contracts': ['supplier@^1'] },
          contributes: {
            extends: [{ object: 'supplier@^1', properties: [{ name: 'riskScore', type: 'number', computed: true }] }],
          },
          migrations: [{ from: '0.9.0', strategy: 'additive' }],
        },
      },
    ]);

    expect(result.ok).toBe(true);
    expect(result.snapshot.objects).toHaveLength(1);
    expect(result.snapshot.objects[0]?.properties.some((entry) => entry.name === 'riskScore')).toBe(true);
  });

  it('rejects extensions against missing objects', () => {
    const result = validateOntologyModules([
      {
        moduleId: 'orphan-pack',
        manifest: {
          id: 'orphan-pack',
          version: '1.0.0',
          'trust-level': 'sandboxed',
          requires: { core: '>=0.1.0 <1.0.0', 'ontology-contracts': ['supplier@^1'] },
          contributes: {
            extends: [{ object: 'supplier@^1', properties: [{ name: 'riskScore', type: 'number' }] }],
          },
          migrations: [{ from: '0.9.0', strategy: 'additive' }],
        },
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.conflicts.some((entry) => entry.kind === 'missing-base-object')).toBe(true);
  });

  it('rejects conflicting property types during merge', () => {
    const existing = [
      {
        moduleId: 'procurement-core-pack',
        manifest: {
          id: 'procurement-core-pack',
          version: '1.0.0',
          'trust-level': 'native',
          requires: { core: '>=0.1.0 <1.0.0' },
          contributes: {
            objects: [
              {
                name: 'supplier',
                namespace: 'procurement',
                'contract-version': 1,
                properties: [{ name: 'riskScore', type: 'number' }],
              },
            ],
          },
          migrations: [{ from: '0.9.0', strategy: 'additive' }],
        },
      },
    ];

    const incoming = {
      moduleId: 'supplier-conflict-pack',
      manifest: {
        id: 'supplier-conflict-pack',
        version: '1.0.0',
        'trust-level': 'sandboxed',
        requires: { core: '>=0.1.0 <1.0.0', 'ontology-contracts': ['supplier@^1'] },
        contributes: {
          extends: [{ object: 'supplier@^1', properties: [{ name: 'riskScore', type: 'string' }] }],
        },
        migrations: [{ from: '0.9.0', strategy: 'additive' }],
      },
    };

    const result = validateManifestMerge(existing, incoming);
    expect(result.ok).toBe(false);
    expect(result.conflicts.some((entry) => entry.kind === 'property-type-conflict')).toBe(true);
  });

  it('rejects reserved objects', () => {
    const snapshot = buildOntologySnapshot([
      {
        moduleId: 'identity-pack',
        manifest: {
          id: 'identity-pack',
          version: '1.0.0',
          'trust-level': 'native',
          requires: { core: '>=0.1.0 <1.0.0' },
          contributes: {
            objects: [{ name: 'user', namespace: 'core', 'contract-version': 1 }],
          },
          migrations: [{ from: '0.9.0', strategy: 'additive' }],
        },
      },
    ]);

    expect(snapshot.objects).toHaveLength(0);
  });
});

