import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../src/context-builder.js';

describe('context builder', () => {
  it('builds base system prompt with no context', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('KOIForge');
    expect(prompt).toContain('concise');
  });

  it('injects dataset rows', () => {
    const prompt = buildSystemPrompt({
      datasetName: 'orders',
      datasetRows: [{ id: '1', value: 1000 }, { id: '2', value: 2000 }],
    });
    expect(prompt).toContain("Dataset 'orders'");
    expect(prompt).toContain('1000');
  });

  it('truncates at 50 rows', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ id: String(i) }));
    const prompt = buildSystemPrompt({ datasetName: 'big', datasetRows: rows });
    expect(prompt).toContain('60 rows, showing 50');
    expect(prompt).toContain('10 more rows');
  });

  it('injects object attributes', () => {
    const prompt = buildSystemPrompt({
      objectType: 'supplier',
      objectId: 'sup-1',
      objectAttributes: { name: 'Alpha', riskScore: 42 },
    });
    expect(prompt).toContain('supplier');
    expect(prompt).toContain('riskScore');
  });

  it('injects extra context', () => {
    const prompt = buildSystemPrompt({ extra: 'Pipeline has 3 steps.' });
    expect(prompt).toContain('Pipeline has 3 steps.');
  });
});
