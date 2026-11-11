import { describe, expect, it } from 'vitest';

import { buildIdentityLinkingReport } from '../src/index.js';
import type { LinkingDatasetInput, LinkingHint } from '../src/types.js';

const suppliersDataset: LinkingDatasetInput = {
  datasetId: 'suppliers',
  datasetName: 'Suppliers',
  rows: [
    { supplierId: 'SUP-100', name: 'Acme Components', country: 'DE' },
    { supplierId: 'SUP-200', name: 'Nordic Steel', country: 'SE' },
  ],
};

const ordersDataset: LinkingDatasetInput = {
  datasetId: 'orders',
  datasetName: 'Orders',
  rows: [
    { poNumber: 'PO-1001', supplierId: 'SUP-100', supplierName: 'Acme Components' },
    { poNumber: 'PO-1002', supplierId: 'SUP-200', supplierName: 'Nordic Steel' },
  ],
};

const exactKeyHint: LinkingHint = {
  fromDatasetId: 'orders',
  fromColumn: 'supplierId',
  toDatasetId: 'suppliers',
  toColumn: 'supplierId',
  confidence: 0.95,
  confidenceLabel: 'high',
  suggestionType: 'exact-key',
  reasons: ['test'],
};

describe('buildIdentityLinkingReport — links', () => {
  it('links rows using discovery hints', () => {
    const { links } = buildIdentityLinkingReport([suppliersDataset, ordersDataset], [exactKeyHint]);
    expect(links).toHaveLength(2);
  });

  it('produces no links when no hints are provided', () => {
    const { links } = buildIdentityLinkingReport([suppliersDataset, ordersDataset], []);
    expect(links).toHaveLength(0);
  });

  it('skips hints with confidence below 0.6', () => {
    const lowConfidenceHint: LinkingHint = { ...exactKeyHint, confidence: 0.55 };
    const { links } = buildIdentityLinkingReport([suppliersDataset, ordersDataset], [lowConfidenceHint]);
    expect(links).toHaveLength(0);
  });

  it('skips hint when fromDatasetId is not in the datasets', () => {
    const badHint: LinkingHint = { ...exactKeyHint, fromDatasetId: 'nonexistent' };
    const { links } = buildIdentityLinkingReport([suppliersDataset, ordersDataset], [badHint]);
    expect(links).toHaveLength(0);
  });

  it('does not produce cross-links for non-matching exact-key values', () => {
    const { links } = buildIdentityLinkingReport([suppliersDataset, ordersDataset], [exactKeyHint]);
    // SUP-100 order must not link to SUP-200 supplier
    for (const link of links) {
      if (link.fromValue === 'SUP-100') {
        expect(link.toValue).toBe('SUP-100');
      }
    }
  });

  it('deduplicates links: same from→to pair only appears once', () => {
    // Provide duplicate rows in orders
    const duplicateOrders: LinkingDatasetInput = {
      datasetId: 'orders',
      datasetName: 'Orders',
      rows: [
        { poNumber: 'PO-1001', supplierId: 'SUP-100', supplierName: 'Acme' },
        { poNumber: 'PO-1001', supplierId: 'SUP-100', supplierName: 'Acme' },
      ],
    };
    const { links } = buildIdentityLinkingReport([suppliersDataset, duplicateOrders], [exactKeyHint]);
    const seen = new Set(links.map((l) => `${l.fromRowKey}->${l.toRowKey}`));
    expect(seen.size).toBe(links.length);
  });

  it('boosts confidence by 0.05 over the hint confidence (capped at 0.99)', () => {
    const { links } = buildIdentityLinkingReport([suppliersDataset, ordersDataset], [exactKeyHint]);
    for (const link of links) {
      expect(link.confidence).toBeGreaterThan(exactKeyHint.confidence);
      expect(link.confidence).toBeLessThanOrEqual(0.99);
    }
  });

  it('appends normalized_value_match to link reasons', () => {
    const { links } = buildIdentityLinkingReport([suppliersDataset, ordersDataset], [exactKeyHint]);
    expect(links[0]?.reasons).toContain('normalized_value_match');
  });

  it('populates candidateStats with correct hintCount', () => {
    const { candidateStats } = buildIdentityLinkingReport([suppliersDataset, ordersDataset], [exactKeyHint]);
    expect(candidateStats.hintCount).toBe(1);
  });

  it('returns 0 hintCount when all hints are below threshold', () => {
    const { candidateStats } = buildIdentityLinkingReport(
      [suppliersDataset, ordersDataset],
      [{ ...exactKeyHint, confidence: 0.4 }],
    );
    expect(candidateStats.hintCount).toBe(0);
  });
});

describe('buildIdentityLinkingReport — clusters', () => {
  it('creates a cluster for duplicate supplier names', () => {
    const duplicates: LinkingDatasetInput = {
      datasetId: 'suppliers',
      datasetName: 'Suppliers',
      rows: [
        { supplierId: 'SUP-100', name: 'Acme Components', country: 'DE', status: 'active' },
        { supplierId: 'SUP-100B', name: 'Acme Components', country: 'DE', status: 'active' },
      ],
    };
    const { clusters } = buildIdentityLinkingReport([duplicates], []);
    expect(clusters.length).toBeGreaterThan(0);
    const cluster = clusters.find((c) => c.members.length === 2);
    expect(cluster).toBeDefined();
  });

  it('returns no clusters when all names are unique', () => {
    const { clusters } = buildIdentityLinkingReport([suppliersDataset], []);
    expect(clusters).toHaveLength(0);
  });

  it('marks status conflict when duplicated rows have differing statuses', () => {
    const conflicted: LinkingDatasetInput = {
      datasetId: 'suppliers',
      datasetName: 'Suppliers',
      rows: [
        { supplierId: 'SUP-100', name: 'Acme Components', country: 'DE', status: 'active' },
        { supplierId: 'SUP-100', name: 'Acme Components', country: 'DE', status: 'review' },
      ],
    };
    const { clusters } = buildIdentityLinkingReport([conflicted], []);
    const cluster = clusters[0];
    expect(cluster?.conflicts).toContain('status');
    expect(cluster?.confidence).toBeLessThan(0.9);
  });

  it('does not create a cluster for a dataset with no name column', () => {
    const noName: LinkingDatasetInput = {
      datasetId: 'noname',
      datasetName: 'No Name',
      rows: [
        { id: '1', value: 'A' },
        { id: '2', value: 'A' },
      ],
    };
    const { clusters } = buildIdentityLinkingReport([noName], []);
    expect(clusters).toHaveLength(0);
  });
});
