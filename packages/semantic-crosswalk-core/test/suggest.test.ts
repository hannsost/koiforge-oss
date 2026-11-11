import { describe, expect, it } from 'vitest';

import { suggestCrosswalk } from '../src/suggest.js';

describe('suggestCrosswalk', () => {
  it('uses generic reference entries instead of hardcoded domain mappings', () => {
    const result = suggestCrosswalk({
      left: {
        datasetId: 'left_ds',
        datasetName: 'left_ds',
        namespace: 'test',
        column: 'country_name',
        values: ['Germany', 'France', 'Deutschland'],
      },
      right: {
        datasetId: 'right_ds',
        datasetName: 'right_ds',
        namespace: 'test',
        column: 'country_code',
        values: ['DE', 'FR', 'US'],
      },
      referenceEntries: [
        { canonicalValue: 'DE', aliases: ['Germany', 'Deutschland', 'DE'] },
        { canonicalValue: 'FR', aliases: ['France', 'FR'] },
      ],
    });

    expect(result.summary.matched).toBe(3);
    expect(result.mappings).toEqual(expect.arrayContaining([
      expect.objectContaining({ leftValue: 'Germany', rightValue: 'DE', canonicalValue: 'DE', method: 'reference' }),
      expect.objectContaining({ leftValue: 'France', rightValue: 'FR', canonicalValue: 'FR', method: 'reference' }),
      expect.objectContaining({ leftValue: 'Deutschland', rightValue: 'DE', canonicalValue: 'DE', method: 'reference' }),
    ]));
  });

  it('resolves fuzzy aliases from external reference rows without domain-specific code', () => {
    const result = suggestCrosswalk({
      left: {
        datasetId: 'left_ds',
        datasetName: 'left_ds',
        namespace: 'test',
        column: 'country_code',
        values: ['US', 'SG'],
      },
      right: {
        datasetId: 'right_ds',
        datasetName: 'right_ds',
        namespace: 'test',
        column: 'country_name',
        values: ['United States', 'Singapore'],
      },
      referenceEntries: [
        { canonicalValue: 'US', aliases: ['United States of America'] },
        { canonicalValue: 'SG', aliases: ['Singapore, Republic of'] },
      ],
    });

    expect(result.summary.matched).toBe(2);
    expect(result.mappings).toEqual(expect.arrayContaining([
      expect.objectContaining({ leftValue: 'US', rightValue: 'United States', canonicalValue: 'US', method: 'reference' }),
      expect.objectContaining({ leftValue: 'SG', rightValue: 'Singapore', canonicalValue: 'SG', method: 'reference' }),
    ]));
  });

  it('does not magically map unrelated code/name pairs without explicit references', () => {
    const result = suggestCrosswalk({
      left: {
        datasetId: 'left_ds',
        datasetName: 'left_ds',
        namespace: 'test',
        column: 'label',
        values: ['Germany'],
      },
      right: {
        datasetId: 'right_ds',
        datasetName: 'right_ds',
        namespace: 'test',
        column: 'code',
        values: ['DE'],
      },
    });

    expect(result.summary.unmatched).toBe(1);
    expect(result.mappings[0]).toEqual(expect.objectContaining({
      leftValue: 'Germany',
      rightValue: null,
      canonicalValue: null,
      status: 'unmatched',
    }));
  });


  it('does not treat a reference canonical value as matched when its shape does not fit the right domain', () => {
    const result = suggestCrosswalk({
      left: {
        datasetId: 'left_ds',
        datasetName: 'left_ds',
        namespace: 'test',
        column: 'country_code',
        values: ['SG'],
      },
      right: {
        datasetId: 'right_ds',
        datasetName: 'right_ds',
        namespace: 'test',
        column: 'language_name',
        values: ['English', 'Mandarin'],
      },
      referenceEntries: [
        { canonicalValue: 'SG', aliases: ['SG', 'Singapore'] },
      ],
    });

    expect(result.summary.unmatched).toBe(1);
    expect(result.mappings[0]).toEqual(expect.objectContaining({
      leftValue: 'SG',
      rightValue: null,
      canonicalValue: null,
      status: 'unmatched',
    }));
  });
  it('matches generic labels by normalization and token overlap', () => {
    const result = suggestCrosswalk({
      left: {
        datasetId: 'left_ds',
        datasetName: 'left_ds',
        namespace: 'test',
        column: 'name',
        values: ['North America Sales', 'Customer-Status'],
      },
      right: {
        datasetId: 'right_ds',
        datasetName: 'right_ds',
        namespace: 'test',
        column: 'label',
        values: ['north_america_sales', 'customer status'],
      },
    });

    expect(result.summary.matched).toBe(2);
    expect(result.mappings).toEqual(expect.arrayContaining([
      expect.objectContaining({ leftValue: 'North America Sales', rightValue: 'north_america_sales', method: 'normalized' }),
      expect.objectContaining({ leftValue: 'Customer-Status', rightValue: 'customer status', method: 'normalized' }),
    ]));
  });
});

