import type { DatasetPreviewCell } from './types.js';
import { open } from 'node:fs/promises';

export type TabularRow = Record<string, DatasetPreviewCell>;

/** Shared bounds for complete file imports, including generated parsers. */
export const TABULAR_LIMITS = Object.freeze({
  maxInputBytes: 10 * 1024 * 1024,
  maxOutputBytes: 16 * 1024 * 1024,
  maxRows: 100_000,
  maxColumns: 512,
});

export class DatasetInputError extends Error {
  readonly statusCode = 400;
}

export function isSafeColumn(name: string): boolean {
  return name.trim().length > 0 && !['__proto__', 'constructor', 'prototype'].includes(name);
}

export function decodeUtf8(bytes: Uint8Array): string {
  if (bytes.byteLength > TABULAR_LIMITS.maxInputBytes) {
    throw new DatasetInputError('Datei überschreitet 10 MiB; es wurde kein Ausschnitt importiert.');
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new DatasetInputError('Datei enthält ungültiges UTF-8. Bitte die Zeichenkodierung prüfen.'); }
}

/** Bound allocation even if a local source grows while it is being read. */
export async function readTabularText(path: string): Promise<string> {
  const file = await open(path, 'r');
  try {
    if ((await file.stat()).size > TABULAR_LIMITS.maxInputBytes) throw new DatasetInputError('Datei überschreitet 10 MiB; es wurde kein Ausschnitt importiert.');
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > TABULAR_LIMITS.maxInputBytes) throw new DatasetInputError('Datei überschreitet 10 MiB; es wurde kein Ausschnitt importiert.');
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    return decodeUtf8(Buffer.concat(chunks, total));
  } finally { await file.close(); }
}

export function validateTabularRows(value: unknown): TabularRow[] {
  if (!Array.isArray(value)) throw new DatasetInputError('Parser result is not an array.');
  if (value.length > TABULAR_LIMITS.maxRows) {
    throw new DatasetInputError(`Import exceeds ${TABULAR_LIMITS.maxRows} rows; no partial import was accepted.`);
  }
  const columns = new Set<string>();
  const rows: TabularRow[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const row: unknown = value[index];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new DatasetInputError(`Row ${index + 1} is not an object.`);
    }
    const entries = Object.entries(row);
    for (const [key, cell] of entries) {
      if (!isSafeColumn(key)) throw new DatasetInputError(`Unsafe field '${key}'.`);
      columns.add(key);
      if (cell !== null && typeof cell !== 'string' && typeof cell !== 'boolean'
        && !(typeof cell === 'number' && Number.isFinite(cell))) {
        throw new DatasetInputError(`Invalid cell in row ${index + 1}, field '${key}'.`);
      }
    }
    if (columns.size > TABULAR_LIMITS.maxColumns) throw new DatasetInputError('Import has too many fields.');
    rows.push(Object.fromEntries(entries) as TabularRow);
  }
  if (Buffer.byteLength(JSON.stringify(rows)) > TABULAR_LIMITS.maxOutputBytes) {
    throw new DatasetInputError('Import exceeds the 16 MiB output budget; no partial import was accepted.');
  }
  return rows;
}
