import { describe, expect, it } from 'vitest';

import { suggestPipelineSteps } from '../src/suggest.js';

describe('suggestPipelineSteps', () => {
  it('suggests joins for matching id-like columns', () => {
    const result = suggestPipelineSteps(
      {
        id: 'orders',
        name: 'orders',
        namespace: 'sales',
        fields: [
          { name: 'orderId', type: 'string', nullable: false },
          { name: 'supplierId', type: 'string' },
          { name: 'amount', type: 'number' },
        ],
      },
      {
        id: 'suppliers',
        name: 'suppliers',
        namespace: 'master',
        fields: [
          { name: 'supplier_id', type: 'string', nullable: false },
          { name: 'supplierName', type: 'string' },
        ],
      },
    );

    expect(result.suggestions.some((suggestion) =>
      suggestion.step.type === 'join'
      && suggestion.step.leftKey === 'supplierId'
      && suggestion.step.rightKey === 'supplier_id'
    )).toBe(true);
  });

  it('suggests aggregations for category and numeric fields', () => {
    const result = suggestPipelineSteps({
      id: 'events',
      name: 'events',
      namespace: 'ops',
      fields: [
        { name: 'eventId', type: 'string', nullable: false },
        { name: 'status', type: 'string' },
        { name: 'createdAt', type: 'datetime' },
        { name: 'durationMs', type: 'number' },
      ],
    });

    expect(result.suggestions.some((suggestion) =>
      suggestion.step.type === 'aggregate'
      && suggestion.step.groupBy.includes('status')
    )).toBe(true);

    expect(result.suggestions.some((suggestion) =>
      suggestion.step.type === 'aggregate'
      && suggestion.step.groupBy.includes('createdAt')
      && suggestion.step.aggregations.some((aggregation) =>
        aggregation.column === 'durationMs' && aggregation.fn === 'sum'
      )
    )).toBe(true);
  });
});
