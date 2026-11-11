import type { CsvTable } from './csv.js';
import type { MutationDefinition, RowSelector } from './types.js';

function matchesSelector(row: Record<string, string>, selector: RowSelector | undefined): boolean {
  if (!selector) {
    return true;
  }

  const value = row[selector.column] ?? '';
  if (selector.equals !== undefined) {
    return value === selector.equals;
  }

  if (selector.in) {
    return selector.in.includes(value);
  }

  return true;
}

export function applyMutations(table: CsvTable, mutations: MutationDefinition[]): CsvTable {
  let headers = [...table.headers];
  let rows: Array<Record<string, string>> = table.rows.map((row) => ({ ...row }));

  for (const mutation of mutations) {
    if (mutation.kind === 'rename-column' && mutation.from && mutation.to) {
      headers = headers.map((header) => (header === mutation.from ? mutation.to! : header));
      rows = rows.map((row) => {
        if (!(mutation.from! in row)) return row;
        const next: Record<string, string> = { ...row, [mutation.to!]: row[mutation.from!] ?? '' };
        delete next[mutation.from!];
        return next;
      });
      continue;
    }

    if (mutation.kind === 'drop-column' && mutation.column) {
      headers = headers.filter((header) => header !== mutation.column);
      rows = rows.map((row) => {
        const next = { ...row };
        delete next[mutation.column!];
        return next;
      });
      continue;
    }

    if (mutation.kind === 'append' && mutation.row) {
      rows.push({ ...mutation.row });
      for (const key of Object.keys(mutation.row)) {
        if (!headers.includes(key)) headers.push(key);
      }
      continue;
    }

    if (mutation.kind === 'duplicate') {
      const duplicates = rows
        .filter((row) => matchesSelector(row, mutation.selector))
        .map((row) => ({ ...row, ...Object.fromEntries(Object.entries(mutation.overrides ?? {}).map(([key, value]) => [key, value ?? ''])) }));
      rows.push(...duplicates);
      continue;
    }

    rows = rows.map((row) => {
      if (!matchesSelector(row, mutation.selector)) return row;

      if (mutation.kind === 'replace' && mutation.column) {
        return { ...row, [mutation.column]: mutation.value ?? '' };
      }

      if (mutation.kind === 'blank' && mutation.column) {
        return { ...row, [mutation.column]: '' };
      }

      return row;
    });
  }

  return { headers, rows };
}
