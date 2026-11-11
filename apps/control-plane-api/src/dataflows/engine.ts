import type { ImportCell, ImportRow } from '../import-capability/isolated-executor.js';
import { rowsHash, validateRows } from '../import-capability/isolated-executor.js';
import { DataflowError, type FlowEvaluation, type FlowFilter, type FlowInput, type FlowJoin, type FlowSource, type FlowSpec } from './contracts.js';
import { isRecord, safeField, SEMANTIC_UUID, type FrozenField } from '../semantic-model/store.js';

const MAX_JOINS = 2;
const MAX_FILTERS = 10;
const MAX_SELECTED_FIELDS = 30;
const MAX_ROWS = 10_000;
const MAX_COLUMNS = 512;
const MAX_ISSUES = 30;
const HASH = /^[a-f0-9]{64}$/;
const FIELD_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'date', 'datetime', 'json']);
const OPERATORS = new Set<FlowFilter['operator']>(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'is_null', 'not_null']);

type Primitive = ImportCell;
type WorkingRow = ImportRow;

function syntax(message: string): never {
  throw new DataflowError(message, 400);
}

function ownKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SEMANTIC_UUID.test(value.toLowerCase())) syntax(`${label} muss eine UUID sein.`);
  return value.toLowerCase();
}

function field(value: unknown, label: string): string {
  if (!safeField(value)) syntax(`${label} muss ein gültiger Feldname sein.`);
  return value;
}

function boundedText(value: unknown, label: string, max: number, required = true): string {
  if (typeof value !== 'string' || value.length > max || (required && value.trim().length === 0)) {
    syntax(`${label} ist ungültig.`);
  }
  return value;
}

function primitive(value: unknown, label: string): Primitive {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  syntax(`${label} muss ein endlicher JSON-Grundwert sein.`);
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}

/** Parse a plan into a detached, frozen, bounded representation. */
export function validateFlowSpec(raw: unknown): FlowSpec {
  if (!isRecord(raw) || !ownKeys(raw, ['name', 'description', 'inputFamilyId', 'keyField', 'joins', 'filters', 'minRows'], ['labelField'])) {
    syntax('Der Datenflussplan hat eine ungültige Struktur.');
  }
  const name = boundedText(raw.name, 'Name', 120);
  const description = boundedText(raw.description, 'Beschreibung', 2000, false);
  const inputFamilyId = uuid(raw.inputFamilyId, 'Eingabefamilie');
  const keyField = field(raw.keyField, 'Schlüsselfeld');
  const labelField = raw.labelField === undefined ? undefined : field(raw.labelField, 'Bezeichnungsfeld');
  if (!Array.isArray(raw.joins) || raw.joins.length > MAX_JOINS) syntax(`Es sind höchstens ${MAX_JOINS} Verknüpfungen erlaubt.`);
  if (!Array.isArray(raw.filters) || raw.filters.length > MAX_FILTERS) syntax(`Es sind höchstens ${MAX_FILTERS} Filter erlaubt.`);
  if (!Number.isSafeInteger(raw.minRows) || (raw.minRows as number) < 0 || (raw.minRows as number) > MAX_ROWS) syntax('Die Mindestzeilenzahl liegt außerhalb des erlaubten Bereichs.');
  const minRows = raw.minRows as number;

  const joins: FlowJoin[] = [];
  let selectedFields = 0;
  for (const [index, rawJoin] of raw.joins.entries()) {
    if (!isRecord(rawJoin) || !ownKeys(rawJoin, ['familyId', 'leftField', 'rightField', 'fields', 'required'])) {
      syntax(`Verknüpfung ${index + 1} ist ungültig.`);
    }
    if (!Array.isArray(rawJoin.fields) || rawJoin.fields.length === 0) syntax(`Verknüpfung ${index + 1} muss Felder auswählen.`);
    selectedFields += rawJoin.fields.length;
    if (selectedFields > MAX_SELECTED_FIELDS) syntax(`Verknüpfungen dürfen höchstens ${MAX_SELECTED_FIELDS} Zielfelder auswählen.`);
    const fields: Array<{ source: string; target: string }> = [];
    for (const [fieldIndex, rawField] of rawJoin.fields.entries()) {
      if (!isRecord(rawField) || !ownKeys(rawField, ['source', 'target'])) syntax(`Feld ${fieldIndex + 1} in Verknüpfung ${index + 1} ist ungültig.`);
      fields.push({ source: field(rawField.source, `Quellfeld der Verknüpfung ${index + 1}`), target: field(rawField.target, `Zielfeld der Verknüpfung ${index + 1}`) });
    }
    if (typeof rawJoin.required !== 'boolean') syntax(`Die Verknüpfung ${index + 1} muss ein gültiges Pflichtkennzeichen enthalten.`);
    joins.push({
      familyId: uuid(rawJoin.familyId, `Familienkennung der Verknüpfung ${index + 1}`),
      leftField: field(rawJoin.leftField, `linkes Feld der Verknüpfung ${index + 1}`),
      rightField: field(rawJoin.rightField, `rechtes Feld der Verknüpfung ${index + 1}`),
      fields,
      required: rawJoin.required,
    });
  }

  const filters: FlowFilter[] = [];
  for (const [index, rawFilter] of raw.filters.entries()) {
    if (!isRecord(rawFilter) || !ownKeys(rawFilter, ['field', 'operator'], ['value'])) syntax(`Filter ${index + 1} ist ungültig.`);
    const operator = rawFilter.operator;
    if (typeof operator !== 'string' || !OPERATORS.has(operator as FlowFilter['operator'])) syntax(`Der Filter ${index + 1} enthält einen ungültigen Operator.`);
    const needsValue = operator !== 'is_null' && operator !== 'not_null';
    if (needsValue !== Object.hasOwn(rawFilter, 'value')) syntax(`Der Filter ${index + 1} enthält einen ungültigen Wert.`);
    let value: ImportCell | undefined;
    if (needsValue) {
      value = primitive(rawFilter.value, `filter ${index + 1} value`);
      if (typeof value === 'string' && value.length > 4096) syntax(`Der Wert des Filters ${index + 1} ist zu lang.`);
      if ((operator === 'gt' || operator === 'gte' || operator === 'lt' || operator === 'lte') && typeof value !== 'number') {
        syntax(`Der Vergleichswert des Filters ${index + 1} muss eine Zahl sein.`);
      }
      if (operator === 'contains' && typeof value !== 'string') syntax(`Der Suchwert des Filters ${index + 1} muss Text sein.`);
    }
    filters.push({ field: field(rawFilter.field, `Feld des Filters ${index + 1}`), operator: operator as FlowFilter['operator'], ...(needsValue ? { value } : {}) });
  }

  return freeze({
    name,
    description,
    inputFamilyId,
    keyField,
    ...(labelField === undefined ? {} : { labelField }),
    joins,
    filters,
    minRows,
  });
}

function missing(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function nullish(value: unknown): boolean {
  return value === null || value === undefined;
}

function cell(row: ImportRow, name: string): Primitive | undefined {
  return Object.hasOwn(row, name) ? row[name] : undefined;
}

function token(value: Primitive): string {
  return JSON.stringify(value);
}

function kind(value: Primitive | undefined): 'string' | 'number' | 'boolean' | 'null' | 'missing' {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  return typeof value as 'string' | 'number' | 'boolean';
}

function schemaKind(type: string): 'string' | 'number' | 'boolean' | 'unknown' {
  if (type === 'number' || type === 'integer') return 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'string' || type === 'date' || type === 'datetime') return 'string';
  return 'unknown';
}

function compatibleTypes(left: string, right: string): boolean {
  const a = schemaKind(left); const b = schemaKind(right);
  if (left === right) return true;
  return a !== 'unknown' && a === b;
}

function validCell(value: unknown): value is Primitive {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

function matchesSchema(value: Primitive, type: string): boolean {
  if (value === null) return true;
  if (type === 'number') return typeof value === 'number';
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'string' || type === 'date' || type === 'datetime') return typeof value === 'string';
  // ImportCell deliberately has no object value, so every accepted primitive is
  // the only representable value for a frozen json column here.
  return true;
}

function cloneSchema(value: FrozenField[]): FrozenField[] {
  return value.map(item => ({ name: item.name, type: item.type, ...(item.nullable === undefined ? {} : { nullable: item.nullable }) }));
}

function validateSchema(value: unknown): { schema: FrozenField[]; issue?: string } {
  if (!Array.isArray(value)) return { schema: [], issue: 'Ein Quellschema fehlt.' };
  if (value.length > MAX_COLUMNS) return { schema: [], issue: `Ein Quellschema überschreitet ${MAX_COLUMNS} Spalten.` };
  const schema: FrozenField[] = [];
  const names = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || !ownKeys(item, ['name', 'type'], ['nullable']) || !safeField(item.name)
      || typeof item.type !== 'string' || !FIELD_TYPES.has(item.type)
      || (item.nullable !== undefined && typeof item.nullable !== 'boolean')) {
      return { schema: [], issue: 'Ein Quellschema ist ungültig.' };
    }
    if (names.has(item.name)) return { schema: [], issue: 'Ein Quellschema enthält doppelte Spalten.' };
    names.add(item.name);
    schema.push({ name: item.name, type: item.type, ...(item.nullable === undefined ? {} : { nullable: item.nullable }) });
  }
  return { schema };
}

function cloneSource(source: unknown): { source?: FlowSource; issue?: string } {
  if (!isRecord(source) || !ownKeys(source, ['familyId', 'setId', 'revision', 'name', 'snapshotHash', 'sourceHash', 'rowCount'])) {
    return { issue: 'Die Metadaten einer Quelle sind ungültig.' };
  }
  if (typeof source.familyId !== 'string' || !SEMANTIC_UUID.test(source.familyId.toLowerCase())
    || typeof source.setId !== 'string' || !SEMANTIC_UUID.test(source.setId.toLowerCase())
    || !Number.isSafeInteger(source.revision) || (source.revision as number) < 1
    || typeof source.name !== 'string' || source.name.trim().length === 0 || source.name.length > 200
    || typeof source.snapshotHash !== 'string' || !HASH.test(source.snapshotHash)
    || typeof source.sourceHash !== 'string' || !HASH.test(source.sourceHash)
    || !Number.isSafeInteger(source.rowCount) || (source.rowCount as number) < 0 || (source.rowCount as number) > MAX_ROWS) {
    return { issue: 'Die Metadaten einer Quelle sind ungültig.' };
  }
  return { source: {
    familyId: source.familyId.toLowerCase(), setId: source.setId.toLowerCase(), revision: source.revision as number,
    name: source.name, snapshotHash: source.snapshotHash, sourceHash: source.sourceHash, rowCount: source.rowCount as number,
  } };
}

function prepareInput(mapKey: string, input: unknown): { input?: FlowInput; schema: FrozenField[]; rows: WorkingRow[]; issues: string[] } {
  const issues: string[] = [];
  if (!isRecord(input)) return { schema: [], rows: [], issues: ['Eine Quellangabe ist ungültig.'] };
  if (!ownKeys(input, ['source', 'rows', 'schema'])) return { schema: [], rows: [], issues: ['Eine Quellangabe enthält unerwartete Felder.'] };
  const sourceResult = cloneSource(input.source);
  const schemaResult = validateSchema(input.schema);
  const schema = schemaResult.schema;
  if (sourceResult.issue) issues.push(sourceResult.issue);
  if (schemaResult.issue) issues.push(schemaResult.issue);
  let rows: WorkingRow[] = [];
  if (!Array.isArray(input.rows) || input.rows.length > MAX_ROWS) {
    issues.push(`Eine Quelle enthält mehr als ${MAX_ROWS} Zeilen oder ist keine Liste.`);
  } else {
    const rawRows: unknown[] = input.rows;
    let valid = true;
    const schemaNames = new Set(schema.map(item => item.name));
    for (const rawRow of rawRows) {
      if (!isRecord(rawRow)) { valid = false; break; }
      for (const key of Object.keys(rawRow)) {
        if (!safeField(key) || !schemaNames.has(key) || !validCell(rawRow[key])) { valid = false; break; }
      }
      if (!valid) break;
    }
    if (!valid) issues.push('Eine Quellzeile ist ungültig oder weicht vom eingefrorenen Schema ab.');
    else {
      try { rows = validateRows(rawRows); }
      catch { issues.push('Die Quellzeilen sind ungültig.'); }
    }
  }
  if (rows.length > 0 && schema.length > 0) {
    const fields = new Map(schema.map(item => [item.name, item]));
    if (rows.some(row => Object.entries(row).some(([name, value]) => !matchesSchema(value, fields.get(name)!.type)))) {
      issues.push('Eine Quellzeile enthält einen Wert, der nicht zum eingefrorenen Schema passt.');
    }
  }
  if (sourceResult.source) {
    if (sourceResult.source.familyId !== mapKey.toLowerCase()) issues.push('Der Quellenstand stimmt nicht mit der Eingabefamilie überein.');
    if (sourceResult.source.rowCount !== rows.length || sourceResult.source.sourceHash !== rowsHash(rows)) issues.push('Der Quellenstand stimmt nicht mit den eingefrorenen Zeilen überein.');
  }
  return { input: sourceResult.source ? { source: sourceResult.source, rows, schema } : undefined, schema, rows, issues };
}

function output(rows: ImportRow[], schema: FrozenField[], issues: string[], steps: FlowEvaluation['steps']): FlowEvaluation {
  const boundedIssues = issues.slice(0, MAX_ISSUES);
  // Oversized results must still leave a persistable, bounded failure record.
  // An empty schema avoids presenting a truncated schema as a complete result.
  if (boundedIssues.length > 0) return { status: 'blocked', issues: boundedIssues, rows: [], schema: schema.length > MAX_COLUMNS ? [] : cloneSchema(schema), rowCount: 0, outputHash: rowsHash([]), steps };
  let checked: ImportRow[];
  try { checked = validateRows(rows); }
  catch { return { status: 'blocked', issues: ['Das ausgewertete Ergebnis ist ungültig.'], rows: [], schema: cloneSchema(schema), rowCount: 0, outputHash: rowsHash([]), steps }; }
  return { status: 'ready', issues: [], rows: checked, schema: cloneSchema(schema), rowCount: checked.length, outputHash: rowsHash(checked), steps };
}

function addIssue(issues: string[], value: string): void {
  if (issues.length < MAX_ISSUES && !issues.includes(value)) issues.push(value);
}

function schemaField(schema: FrozenField[], name: string): FrozenField | undefined {
  return schema.find(item => item.name === name);
}

/** Evaluate a validated typed-enrichment plan using only supplied frozen snapshots. */
export function evaluateFlow(spec: FlowSpec, inputs: Map<string, FlowInput>): FlowEvaluation {
  const plan = validateFlowSpec(spec);
  const issues: string[] = [];
  const steps: FlowEvaluation['steps'] = [];
  if (!(inputs instanceof Map)) return output([], [], ['Die Eingaben müssen eine Zuordnung sein.'], steps);
  if (inputs.size > MAX_JOINS + 1) return output([], [], [`Es sind höchstens ${MAX_JOINS + 1} Quellstände erlaubt.`], steps);

  const prepared = new Map<string, { input?: FlowInput; schema: FrozenField[]; rows: WorkingRow[]; issues: string[] }>();
  for (const [mapKey, input] of inputs.entries()) {
    if (typeof mapKey !== 'string' || !SEMANTIC_UUID.test(mapKey.toLowerCase())) {
      addIssue(issues, 'Eine Eingabefamilie ist ungültig.');
      continue;
    }
    const result = prepareInput(mapKey, input);
    prepared.set(mapKey.toLowerCase(), result);
    for (const issue of result.issues) addIssue(issues, issue);
  }

  const base = prepared.get(plan.inputFamilyId);
  let rows: WorkingRow[] = base?.rows.map(row => ({ ...row })) ?? [];
  let schema = base ? cloneSchema(base.schema) : [];
  if (!base) addIssue(issues, 'Der Quellenstand der Eingabefamilie fehlt.');
  if (base && base.input?.source.familyId !== plan.inputFamilyId) addIssue(issues, 'Der Quellenstand der Eingabefamilie ist widersprüchlich.');
  steps.push({ label: 'Quelle', rowsIn: rows.length, rowsOut: rows.length });

  if (schema.length > MAX_COLUMNS) addIssue(issues, `Das Ergebnis überschreitet ${MAX_COLUMNS} Spalten.`);

  for (const [joinIndex, join] of plan.joins.entries()) {
    const right = prepared.get(join.familyId);
    const rowsIn = rows.length;
    let unmatched = 0;
    if (!right) {
      addIssue(issues, `Der Quellenstand für Verknüpfung ${joinIndex + 1} fehlt.`);
      steps.push({ label: `Verknüpfung ${joinIndex + 1}`, rowsIn, rowsOut: rowsIn, unmatched });
      continue;
    }
    const leftField = schemaField(schema, join.leftField);
    const rightField = schemaField(right.schema, join.rightField);
    if (!leftField) addIssue(issues, `Das linke Feld der Verknüpfung ${joinIndex + 1} fehlt im aktuellen Schema.`);
    if (!rightField) addIssue(issues, `Das rechte Feld der Verknüpfung ${joinIndex + 1} fehlt im Quellschema.`);
    if (leftField && rightField && !compatibleTypes(leftField.type, rightField.type)) addIssue(issues, `Die Schlüsselfeldtypen der Verknüpfung ${joinIndex + 1} sind nicht kompatibel.`);
    const targets = new Set(schema.map(item => item.name));
    let collision = false;
    for (const selected of join.fields) {
      if (!schemaField(right.schema, selected.source)) addIssue(issues, `Ein ausgewähltes Feld der Verknüpfung ${joinIndex + 1} fehlt im Quellschema.`);
      if (targets.has(selected.target)) collision = true;
      targets.add(selected.target);
    }
    if (collision) addIssue(issues, `Ausgewählte Felder der Verknüpfung ${joinIndex + 1} überschneiden sich mit dem Ergebnis.`);
    const rightIndex = new Map<string, ImportRow>();
    let invalidRight = false;
    for (const row of right.rows) {
      const value = cell(row, join.rightField);
      if (missing(value)) { invalidRight = true; continue; }
      const keyToken = token(value as Primitive);
      if (rightIndex.has(keyToken)) { invalidRight = true; continue; }
      rightIndex.set(keyToken, row);
    }
    if (invalidRight) addIssue(issues, `Die rechten Schlüssel der Verknüpfung ${joinIndex + 1} fehlen oder sind doppelt.`);
    const next: WorkingRow[] = [];
    for (const row of rows) {
      const value = cell(row, join.leftField);
      const found = !missing(value) ? rightIndex.get(token(value as Primitive)) : undefined;
      if (!found) {
        unmatched++;
        if (join.required) continue;
      }
      const nextRow: WorkingRow = { ...row };
      for (const selected of join.fields) {
        nextRow[selected.target] = found && Object.hasOwn(found, selected.source) ? (found[selected.source] ?? null) : null;
      }
      next.push(nextRow);
    }
    if (join.required && unmatched > 0) addIssue(issues, `Die Pflichtverknüpfung ${joinIndex + 1} hat nicht zugeordnete Zeilen.`);
    for (const selected of join.fields) {
      const sourceField = schemaField(right.schema, selected.source);
      if (sourceField && !schemaField(schema, selected.target) && !collision) {
        const nullable = join.required ? sourceField.nullable : true;
        schema.push({ name: selected.target, type: sourceField.type, ...(nullable === undefined ? {} : { nullable }) });
      }
    }
    if (schema.length > MAX_COLUMNS) addIssue(issues, `Das Ergebnis überschreitet ${MAX_COLUMNS} Spalten.`);
    rows = next;
    steps.push({ label: `Verknüpfung ${joinIndex + 1}`, rowsIn, rowsOut: rows.length, unmatched });
  }

  for (const [filterIndex, filter] of plan.filters.entries()) {
    const rowsIn = rows.length;
    const fieldInfo = schemaField(schema, filter.field);
    if (!fieldInfo) {
      addIssue(issues, `Das Feld des Filters ${filterIndex + 1} fehlt im aktuellen Schema.`);
      steps.push({ label: `Filter ${filterIndex + 1}`, rowsIn, rowsOut: rowsIn });
      continue;
    }
    const value = filter.value;
    if (filter.operator === 'contains' && schemaKind(fieldInfo.type) !== 'string') addIssue(issues, `Der Filter ${filterIndex + 1} benötigt ein Textfeld.`);
    if (['gt', 'gte', 'lt', 'lte'].includes(filter.operator) && schemaKind(fieldInfo.type) !== 'number') addIssue(issues, `Der Filter ${filterIndex + 1} benötigt ein Zahlenfeld.`);
    if ((filter.operator === 'eq' || filter.operator === 'neq') && value !== null
      && fieldInfo.type !== 'json' && schemaKind(fieldInfo.type) !== kind(value)) addIssue(issues, `Der Wert des Filters ${filterIndex + 1} passt typmäßig nicht zum Feld.`);
    let invalidType = false;
    const next = rows.filter(row => {
      const current = cell(row, filter.field);
      if (filter.operator === 'contains') {
        if (typeof current !== 'string') { invalidType = true; return false; }
        return current.includes(value as string);
      }
      if (filter.operator === 'gt' || filter.operator === 'gte' || filter.operator === 'lt' || filter.operator === 'lte') {
        if (typeof current !== 'number') { invalidType = true; return false; }
        if (filter.operator === 'gt') return current > (value as number);
        if (filter.operator === 'gte') return current >= (value as number);
        if (filter.operator === 'lt') return current < (value as number);
        return current <= (value as number);
      }
      if (filter.operator === 'is_null') return nullish(current);
      if (filter.operator === 'not_null') return !nullish(current);
      return filter.operator === 'eq' ? current === value : current !== value;
    });
    if (invalidType) addIssue(issues, `Der Filter ${filterIndex + 1} hat einen inkompatiblen Spaltenwert gefunden.`);
    rows = next;
    steps.push({ label: `Filter ${filterIndex + 1}`, rowsIn, rowsOut: rows.length });
  }

  if (rows.length < plan.minRows) addIssue(issues, `Das Ergebnis hat weniger als die erforderlichen ${plan.minRows} Zeilen.`);
  if (!schemaField(schema, plan.keyField)) addIssue(issues, 'Das Ergebnisfeld für den Schlüssel ist nicht im Schema vorhanden.');
  if (plan.labelField !== undefined && !schemaField(schema, plan.labelField)) addIssue(issues, 'Das optionale Bezeichnungsfeld ist nicht im Schema vorhanden.');
  const seen = new Set<string>();
  for (const row of rows) {
    const value = cell(row, plan.keyField);
    if (missing(value)) { addIssue(issues, 'Das Ergebnis enthält einen fehlenden Schlüssel.'); break; }
    const keyToken = token(value as Primitive);
    if (seen.has(keyToken)) { addIssue(issues, 'Das Ergebnis enthält doppelte Schlüssel.'); break; }
    seen.add(keyToken);
  }
  if (rows.length > MAX_ROWS) addIssue(issues, `Das Ergebnis überschreitet ${MAX_ROWS} Zeilen.`);
  if (schema.length > MAX_COLUMNS) addIssue(issues, `Das Ergebnis überschreitet ${MAX_COLUMNS} Spalten.`);
  return output(rows, schema, issues, steps);
}
