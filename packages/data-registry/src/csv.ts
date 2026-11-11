import { DatasetInputError, isSafeColumn, TABULAR_LIMITS, validateTabularRows, type TabularRow } from './tabular-data.js';

/** Strict CSV records, including quoted newlines. Values are never coerced. */
export function parseCsvRecords(text: string, delimiter: string): string[][] {
  if (delimiter.length !== 1 || /["\r\n\0]/.test(delimiter)) throw new DatasetInputError('Invalid CSV delimiter.');
  if (Buffer.byteLength(text) > TABULAR_LIMITS.maxInputBytes) throw new DatasetInputError('CSV exceeds the 10 MiB input budget; no partial import was accepted.');
  const records: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  let closed = false;
  let touched = false;
  const field = () => {
    row.push(value); value = ''; closed = false;
    if (row.length > TABULAR_LIMITS.maxColumns) throw new DatasetInputError('CSV has too many fields.');
  };
  const record = () => {
    field();
    if (touched || row.length > 1 || row[0] !== '') records.push(row);
    if (records.length > TABULAR_LIMITS.maxRows + 1) throw new DatasetInputError('CSV exceeds 100000 rows; no partial import was accepted.');
    row = []; touched = false;
  };
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { value += '"'; i += 1; }
      else if (char === '"') { quoted = false; closed = true; }
      else value += char;
      continue;
    }
    if (char === delimiter) { field(); touched = true; }
    else if (char === '\r' || char === '\n') {
      record();
      if (char === '\r' && text[i + 1] === '\n') i += 1;
    } else if (char === '"' && value === '' && !closed) { quoted = true; touched = true; }
    else {
      if (closed || char === '"') throw new DatasetInputError('Malformed CSV quoting.');
      value += char; touched = true;
    }
  }
  if (quoted) throw new DatasetInputError('CSV ends inside a quoted field.');
  if (touched || value !== '' || row.length > 0) record();
  return records;
}

export function parseCsvTable(text: string, delimiter: string): { columns: string[]; rows: TabularRow[] } {
  const [headers, ...records] = parseCsvRecords(text, delimiter);
  if (!headers) return { columns: [], rows: [] };
  if (headers.some(name => !isSafeColumn(name)) || new Set(headers).size !== headers.length) {
    throw new DatasetInputError('CSV headers must be nonempty, unique and safe.');
  }
  const rows = records.map((values, index) => {
    if (values.length !== headers.length) throw new DatasetInputError(`CSV record ${index + 2} has the wrong field count.`);
    return Object.fromEntries(headers.map((name, i) => [name, values[i]!]));
  });
  return { columns: headers, rows: validateTabularRows(rows) };
}

export function parseCsvRowsStrict(text: string, delimiter: string): TabularRow[] {
  return parseCsvTable(text, delimiter).rows;
}
