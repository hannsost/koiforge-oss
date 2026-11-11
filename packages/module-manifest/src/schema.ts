import { readFileSync } from 'node:fs';

const schemaUrl = new URL('../module.schema.json', import.meta.url);

export const moduleSchema = JSON.parse(
  readFileSync(schemaUrl, 'utf8'),
) as Record<string, unknown>;

