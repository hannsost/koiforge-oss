import { describe, expect, it } from 'vitest';

import { buildDiscoveryReport } from '../src/index.js';
import type { DiscoveryDatasetInput } from '../src/types.js';

const suppliers: DiscoveryDatasetInput = {
  datasetId: 'suppliers',
  datasetName: 'Suppliers',
  namespace: 'procurement',
  columns: ['supplierId', 'name', 'country'],
  rows: [
    { supplierId: 'SUP-100', name: 'Acme Components', country: 'DE' },
    { supplierId: 'SUP-200', name: 'Nordic Steel', country: 'SE' },
  ],
};

const orders: DiscoveryDatasetInput = {
  datasetId: 'orders',
  datasetName: 'Orders',
  namespace: 'procurement',
  columns: ['poNumber', 'supplierId', 'supplierName'],
  rows: [
    { poNumber: 'PO-1', supplierId: 'SUP-100', supplierName: 'Acme Components' },
    { poNumber: 'PO-2', supplierId: 'SUP-200', supplierName: 'Nordic Steel' },
  ],
};

describe('buildDiscoveryReport', () => {
  it('finds supplier/order relationship suggestions automatically', () => {
    const { suggestions } = buildDiscoveryReport([suppliers, orders]);
    expect(suggestions.some((s) => s.fromColumn === 'supplierId' && s.toColumn === 'supplierId')).toBe(true);
  });

  it('returns empty suggestions for a single dataset', () => {
    const { suggestions } = buildDiscoveryReport([suppliers]);
    expect(suggestions).toHaveLength(0);
  });

  it('assigns exact-key suggestion type for id-to-id column matches', () => {
    const { suggestions } = buildDiscoveryReport([suppliers, orders]);
    const idLink = suggestions.find((s) => s.fromColumn === 'supplierId' && s.toColumn === 'supplierId');
    expect(idLink?.suggestionType).toBe('exact-key');
  });

  it('assigns geo-match suggestion type for country-to-country column', () => {
    const withCountry: DiscoveryDatasetInput = {
      datasetId: 'regions',
      datasetName: 'Regions',
      namespace: 'geo',
      columns: ['regionId', 'country'],
      rows: [
        { regionId: 'R-1', country: 'DE' },
        { regionId: 'R-2', country: 'SE' },
      ],
    };
    const { suggestions } = buildDiscoveryReport([suppliers, withCountry]);
    const geoLink = suggestions.find((s) => s.fromColumn === 'country' && s.toColumn === 'country');
    expect(geoLink?.suggestionType).toBe('geo-match');
  });

  it('labels high confidence suggestions correctly', () => {
    const { suggestions } = buildDiscoveryReport([suppliers, orders]);
    const high = suggestions.find((s) => s.confidence >= 0.85);
    expect(high?.confidenceLabel).toBe('high');
  });

  it('returns profiles for all input datasets', () => {
    const { profiles } = buildDiscoveryReport([suppliers, orders]);
    expect(profiles).toHaveLength(2);
    expect(profiles.map((p) => p.datasetId)).toContain('suppliers');
    expect(profiles.map((p) => p.datasetId)).toContain('orders');
  });

  it('includes column profiles with correct stats', () => {
    const { profiles } = buildDiscoveryReport([suppliers]);
    const supplierProfile = profiles.find((p) => p.datasetId === 'suppliers');
    const idProfile = supplierProfile?.columns.find((c) => c.column === 'supplierId');
    expect(idProfile?.rowCount).toBe(2);
    expect(idProfile?.distinctCount).toBe(2);
    expect(idProfile?.uniquenessRatio).toBe(1);
    expect(idProfile?.nullCount).toBe(0);
  });

  it('includes business-key type hint for supplierId values', () => {
    const { profiles } = buildDiscoveryReport([suppliers]);
    const supplierProfile = profiles[0];
    const idProfile = supplierProfile?.columns.find((c) => c.column === 'supplierId');
    expect(idProfile?.typeHints).toContain('business-key');
  });

  it('limits output to at most 50 suggestions', () => {
    const columnNames = Array.from({ length: 10 }, (_, i) => `id${i}`);
    const makeRows = () =>
      Array.from({ length: 5 }, (_, i) =>
        Object.fromEntries(columnNames.map((col) => [col, `V${i}`])),
      );
    const left: DiscoveryDatasetInput = { datasetId: 'left', datasetName: 'Left', namespace: 'test', columns: columnNames, rows: makeRows() };
    const right: DiscoveryDatasetInput = { datasetId: 'right', datasetName: 'Right', namespace: 'test', columns: columnNames, rows: makeRows() };
    const { suggestions } = buildDiscoveryReport([left, right]);
    expect(suggestions.length).toBeLessThanOrEqual(50);
  });
});
