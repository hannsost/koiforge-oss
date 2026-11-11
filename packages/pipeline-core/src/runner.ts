import type { DataRow, DeriveExpression, FilterOperator, PipelineStep } from './types.js';

function coerce(val: unknown): string | number | boolean | null {
  if (val == null) return null;
  if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') return val;
  return String(val);
}

function joinKey(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') {
    return value
      .normalize('NFKC')
      .trim()
      .replace(/\s+/g, ' ');
  }
  return String(value).trim();
}

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim().length > 0;
}

function evaluateDeriveExpression(expression: DeriveExpression, row: DataRow): string | number | boolean | null {
  if (expression.op === 'copy') {
    return coerce(row[expression.column]);
  }

  if (expression.op === 'literal') {
    return coerce(expression.value);
  }

  for (const column of expression.columns) {
    const value = coerce(row[column]);
    if (hasValue(value)) return value;
  }

  return coerce(expression.fallback);
}

function distinctKey(row: DataRow, columns: string[]): string {
  return JSON.stringify(columns.map((column) => row[column] ?? null));
}

function matchFilter(val: unknown, operator: FilterOperator, value?: string): boolean {
  const coerced = coerce(val);
  switch (operator) {
    case 'not_null': return coerced != null;
    case 'is_null': return coerced == null;
    case 'eq': return String(coerced ?? '') === (value ?? '');
    case 'neq': return String(coerced ?? '') !== (value ?? '');
    case 'gt': return Number(coerced) > Number(value ?? 0);
    case 'lt': return Number(coerced) < Number(value ?? 0);
    case 'gte': return Number(coerced) >= Number(value ?? 0);
    case 'lte': return Number(coerced) <= Number(value ?? 0);
    case 'contains': return String(coerced ?? '').includes(value ?? '');
  }
}

export function runSteps(
  rows: DataRow[],
  steps: PipelineStep[],
  getRightRows?: (datasetId: string) => DataRow[],
): DataRow[] {
  let current = rows.map((r) => ({ ...r }));

  for (const step of steps) {
    switch (step.type) {
      case 'filter': {
        current = current.filter((row) => matchFilter(row[step.column], step.operator, step.value));
        break;
      }
      case 'select': {
        current = current.map((row) => {
          const out: DataRow = {};
          for (const col of step.columns) out[col] = row[col] ?? null;
          return out;
        });
        break;
      }
      case 'rename': {
        current = current.map((row) => {
          const out: DataRow = { ...row };
          out[step.to] = out[step.from] ?? null;
          delete out[step.from];
          return out;
        });
        break;
      }
      case 'derive': {
        current = current.map((row) => ({
          ...row,
          [step.column]: evaluateDeriveExpression(step.expression, row),
        }));
        break;
      }
      case 'aggregate': {
        const groups = new Map<string, DataRow[]>();
        for (const row of current) {
          const key = step.groupBy.map((col) => String(row[col] ?? '')).join('\0');
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key)!.push(row);
        }
        current = Array.from(groups.values()).map((groupRows) => {
          const out: DataRow = {};
          for (const col of step.groupBy) out[col] = groupRows[0]?.[col] ?? null;
          for (const agg of step.aggregations) {
            const vals = groupRows.map((r) => Number(r[agg.column] ?? 0));
            switch (agg.fn) {
              case 'count': out[agg.outputName] = groupRows.length; break;
              case 'sum': out[agg.outputName] = vals.reduce((a, b) => a + b, 0); break;
              case 'avg': out[agg.outputName] = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0; break;
              case 'min': out[agg.outputName] = vals.length > 0 ? Math.min(...vals) : 0; break;
              case 'max': out[agg.outputName] = vals.length > 0 ? Math.max(...vals) : 0; break;
            }
          }
          return out;
        });
        break;
      }
      case 'distinct': {
        const columns = step.columns?.length ? step.columns : deriveColumns(current);
        const seen = new Set<string>();
        current = current.filter((row) => {
          const key = distinctKey(row, columns);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        break;
      }
      case 'join': {
        if (!getRightRows) break;
        const right = getRightRows(step.rightDatasetId);
        const rightIndex = new Map<string, DataRow[]>();
        for (const row of right) {
          const key = joinKey(row[step.rightKey]);
          if (!rightIndex.has(key)) rightIndex.set(key, []);
          rightIndex.get(key)!.push(row);
        }
        const joined: DataRow[] = [];
        for (const leftRow of current) {
          const key = joinKey(leftRow[step.leftKey]);
          const matches = rightIndex.get(key);
          if (matches && matches.length > 0) {
            for (const rightRow of matches) {
              joined.push({ ...leftRow, ...rightRow });
            }
          } else if (step.mode === 'left') {
            joined.push({ ...leftRow });
          }
        }
        current = joined;
        break;
      }
    }
  }

  return current;
}

export function deriveColumns(rows: DataRow[]): string[] {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const column of Object.keys(row)) {
      if (seen.has(column)) continue;
      seen.add(column);
      columns.push(column);
    }
  }
  return columns;
}
