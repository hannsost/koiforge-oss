import { readFile, writeFile } from 'node:fs/promises';

export interface CsvTable {
  headers: string[];
  rows: Array<Record<string, string>>;
}

export function parseCsvLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (character === '"') {
      const nextCharacter = line[index + 1];
      if (inQuotes && nextCharacter === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (character === delimiter && !inQuotes) {
      cells.push(current);
      current = '';
      continue;
    }

    current += character;
  }

  cells.push(current);
  return cells;
}

export async function readCsvTable(path: string, delimiter = ','): Promise<CsvTable> {
  const content = await readFile(path, 'utf8');
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const headers = lines.length > 0 ? parseCsvLine(lines[0]!, delimiter) : [];
  const rows = lines.slice(1).map((line) => {
    const cells = parseCsvLine(line, delimiter);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] ?? '';
    });
    return row;
  });

  return { headers, rows };
}

export async function writeCsvTable(path: string, table: CsvTable, delimiter = ','): Promise<void> {
  const lines = [table.headers.join(delimiter)];
  for (const row of table.rows) {
    lines.push(table.headers.map((header) => String(row[header] ?? '')).join(delimiter));
  }

  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
}

