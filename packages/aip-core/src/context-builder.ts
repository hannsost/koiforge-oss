import type { AipContext, AipMessage } from './types.js';

const MAX_ROWS = 50;
const MAX_COLS = 10;

function formatRows(rows: Array<Record<string, unknown>>, name: string): string {
  if (rows.length === 0) return `Dataset '${name}' is empty.`;
  const keys = Object.keys(rows[0]!).slice(0, MAX_COLS);
  const sample = rows.slice(0, MAX_ROWS);
  const header = keys.join('\t');
  const lines = sample.map((row) => keys.map((k) => String(row[k] ?? '')).join('\t'));
  const truncated = rows.length > MAX_ROWS ? `\n… and ${rows.length - MAX_ROWS} more rows` : '';
  return `Dataset '${name}' (${rows.length} rows, showing ${Math.min(rows.length, MAX_ROWS)}):\n${header}\n${lines.join('\n')}${truncated}`;
}

/**
 * Builds a system prompt that injects relevant context so the LLM
 * can answer questions about the data grounded in actual values.
 */
export function buildSystemPrompt(context?: AipContext): string {
  const parts: string[] = [
    'You are an AI assistant embedded in KOIForge, an open-source Palantir Foundry clone.',
    'You help users understand their data, ontology objects, pipelines, and quality checks.',
    'Be concise, factual, and ground your answers in the provided context.',
  ];

  if (context?.datasetRows && context.datasetRows.length > 0) {
    parts.push('\n--- DATA CONTEXT ---');
    parts.push(formatRows(context.datasetRows as Array<Record<string, unknown>>, context.datasetName ?? 'dataset'));
  }

  if (context?.objectAttributes) {
    parts.push('\n--- OBJECT CONTEXT ---');
    parts.push(`Object type: ${context.objectType ?? 'unknown'}, ID: ${context.objectId ?? 'unknown'}`);
    parts.push(JSON.stringify(context.objectAttributes, null, 2));
  }

  if (context?.extra) {
    parts.push('\n--- ADDITIONAL CONTEXT ---');
    parts.push(context.extra);
  }

  return parts.join('\n');
}

/**
 * Prepends system message to a message list.
 */
export function withSystemMessage(messages: AipMessage[], systemContent: string): AipMessage[] {
  return [{ role: 'system', content: systemContent }, ...messages];
}
