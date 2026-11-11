import { describe, expect, it } from 'vitest';

import { applyMutations } from '../src/mutators.js';

describe('resilience mutators', () => {
  it('applies rename and blank mutations', () => {
    const table = {
      headers: ['supplierId', 'name', 'country'],
      rows: [{ supplierId: 'SUP-100', name: 'Acme', country: 'DE' }],
    };

    const result = applyMutations(table, [
      { kind: 'blank', selector: { column: 'supplierId', equals: 'SUP-100' }, column: 'supplierId' },
      { kind: 'rename-column', from: 'country', to: 'countryCode' },
    ]);

    expect(result.headers).toContain('countryCode');
    expect(result.rows[0]?.supplierId).toBe('');
    expect(result.rows[0]?.countryCode).toBe('DE');
  });
});
