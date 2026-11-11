import { createHash } from 'node:crypto';
import { rowsHash, validateRows, type ImportCell, type ImportRow } from '../../import-capability/isolated-executor.js';
import type { RelationshipDetail, RelationshipRow, SemanticPrimitive } from '../../semantic-model/contracts.js';

export const ORDER_REVIEW_VERSION = 'order-review-v1';

export interface OrderReviewBinding {
  statusField: string;
  dueDateField?: string;
}
export interface OrderReviewRule {
  openStatuses: string[];
  closedStatuses: string[];
  asOf: string;
  dueDateMeaning: 'promised_delivery_day' | 'not_available';
}
export interface OrderReviewResult {
  summary: string;
  counts: {
    sourceRows: number;
    overdueRows: number;
    openRows: number;
    closedRows: number;
    unassessableRows: number;
    clarificationRows: number;
    deadlineUnassessableRows: number;
  };
  columns: string[];
  rows: ImportRow[];
  totalRows: number;
  truncated: boolean;
  ruleHash: string;
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const missing = (value: unknown) => value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
const cell = (row: ImportRow, field: string): ImportCell | undefined => Object.hasOwn(row, field) ? row[field] : undefined;
const keyValue = (value: ImportCell | undefined): SemanticPrimitive | null => missing(value) ? null : value!;
const literal = (value: SemanticPrimitive | null): string | null => value === null ? null : JSON.stringify(value);
const exactKeys = (value: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));

// Calendar days have no implicit timezone, parsing fallback or Date overflow normalization.
function calendarDay(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 10 || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4)); const month = Number(value.slice(5, 7)); const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
}
function dayNumber(value: string): number {
  return Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10))) / 86_400_000;
}
function statuses(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 50
    || Array.from(value).some(status => typeof status !== 'string' || !status.trim() || status.length > 200)
    || new Set(value).size !== value.length) {
    throw new Error(`${label} dürfen bis zu 50 unterschiedliche, nicht leere Texte mit jeweils höchstens 200 Zeichen enthalten.`);
  }
  // Sort a copy: semantics are sets, but each status remains byte-for-byte unchanged.
  return [...value].sort();
}

export function validateOrderReviewInput(bindingValue: unknown, ruleValue: unknown, columns: string[], keyField: string): {
  binding: OrderReviewBinding; orderRule: OrderReviewRule;
} {
  if (!record(bindingValue) || !exactKeys(bindingValue, ['statusField'], ['dueDateField'])) {
    throw new Error('Bitte ausschließlich die Statusspalte und gegebenenfalls die Lieferterminspalte bestätigen.');
  }
  if (!record(ruleValue) || !exactKeys(ruleValue, ['openStatuses', 'closedStatuses', 'asOf', 'dueDateMeaning'])) {
    throw new Error('Die Bestellregel benötigt genau offene Statuswerte, abgeschlossene Statuswerte, Stichtag und Terminbedeutung.');
  }
  const openStatuses = statuses(ruleValue.openStatuses, 'Offene Statuswerte');
  const closedStatuses = statuses(ruleValue.closedStatuses, 'Abgeschlossene Statuswerte');
  if (openStatuses.length + closedStatuses.length === 0) throw new Error('Bitte mindestens einen Statuswert ausdrücklich als offen oder abgeschlossen bestätigen.');
  if (openStatuses.some(status => closedStatuses.includes(status))) throw new Error('Offene und abgeschlossene Statuswerte dürfen sich nicht überschneiden.');
  if (!calendarDay(ruleValue.asOf)) throw new Error('Der Stichtag muss ein gültiger Kalendertag im Format YYYY-MM-DD (Jahre 1000 bis 9999) sein.');
  if (ruleValue.dueDateMeaning !== 'promised_delivery_day' && ruleValue.dueDateMeaning !== 'not_available') {
    throw new Error('Bitte den Termin als zugesagten Liefertag bestätigen oder als nicht verfügbar kennzeichnen.');
  }
  const { statusField } = bindingValue;
  const dueDateField = Object.hasOwn(bindingValue, 'dueDateField') ? bindingValue.dueDateField : undefined;
  if (!columns.includes(keyField) || typeof statusField !== 'string' || !statusField.trim() || !columns.includes(statusField)
    || statusField === keyField) throw new Error('Die Statusspalte muss vorhanden und von der bestätigten Bestellungs-ID verschieden sein.');
  if (ruleValue.dueDateMeaning === 'promised_delivery_day') {
    if (typeof dueDateField !== 'string' || !dueDateField.trim() || !columns.includes(dueDateField)
      || dueDateField === keyField || dueDateField === statusField) {
      throw new Error('Ein zugesagter Liefertag benötigt eine vorhandene, von ID und Status verschiedene Terminspalte.');
    }
  } else if (Object.hasOwn(bindingValue, 'dueDateField')) {
    throw new Error('Ohne verfügbaren zugesagten Liefertag darf keine Terminspalte zugeordnet sein.');
  }
  return {
    binding: { statusField, ...(typeof dueDateField === 'string' ? { dueDateField } : {}) },
    orderRule: { openStatuses, closedStatuses, asOf: ruleValue.asOf, dueDateMeaning: ruleValue.dueDateMeaning },
  };
}

export function orderReviewRuleHash(binding: OrderReviewBinding, rule: OrderReviewRule): string {
  const normalized = {
    binding: { statusField: binding.statusField, ...(binding.dueDateField !== undefined ? { dueDateField: binding.dueDateField } : {}) },
    orderRule: { openStatuses: [...rule.openStatuses].sort(), closedStatuses: [...rule.closedStatuses].sort(),
      asOf: rule.asOf, dueDateMeaning: rule.dueDateMeaning },
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

const relationshipLabels: Record<RelationshipRow['status'], string> = {
  linked: 'Eindeutig zugeordnet', missing_reference: 'Lieferantenreferenz fehlt',
  unmatched_reference: 'Lieferant nicht gefunden', ambiguous_reference: 'Lieferant mehrdeutig',
  invalid_source_key: 'Bestellungs-ID nicht eindeutig',
};
const relationshipCountKeys = {
  linked: 'linkedRows', missing_reference: 'missingReferences', unmatched_reference: 'unmatchedReferences',
  ambiguous_reference: 'ambiguousReferences', invalid_source_key: 'invalidSourceRows',
} as const;

function completeRows(detail: RelationshipDetail, inputRows: ImportRow[]): ImportRow[] {
  const rows = validateRows(inputRows);
  const { relationship, from, to } = detail;
  if (detail.truncated !== false || detail.offset !== 0 || detail.totalRows !== rows.length || detail.rows.length !== rows.length
    || from.source.coverage !== 'complete' || from.source.rowCount !== rows.length || from.source.hash !== rowsHash(rows)
    || rows.some(row => Object.keys(row).some(key => !from.source.columns.includes(key)))
    || relationship.fromSetId !== from.id || relationship.toSetId !== to.id
    || relationship.evidence.sourceHash !== from.source.hash || relationship.evidence.targetHash !== to.source.hash
    || relationship.evidence.fromRevision !== from.revision || relationship.evidence.toRevision !== to.revision
    || relationship.cardinality !== 'many-to-one' || relationship.contractVersion !== 'relationship-v1') {
    throw new Error('Die Bestellungsprüfung benötigt die vollständigen, unveränderten Quellzeilen und den passenden Beziehungsbeleg.');
  }
  const seen = new Set<number>();
  const counts = { sourceRows: rows.length, linkedRows: 0, missingReferences: 0, unmatchedReferences: 0,
    ambiguousReferences: 0, invalidSourceRows: 0 };
  for (const row of detail.rows) {
    if (!Number.isSafeInteger(row.sourceRow) || row.sourceRow < 1 || row.sourceRow > rows.length || seen.has(row.sourceRow)
      || !Object.hasOwn(relationshipLabels, row.status)) throw new Error('Der Beziehungsbeleg muss jede ursprüngliche Quellzeile genau einmal enthalten.');
    seen.add(row.sourceRow);
    const source = rows[row.sourceRow - 1]!;
    if (row.sourceKey !== keyValue(cell(source, from.keyField)) || row.reference !== keyValue(cell(source, relationship.fromField))) {
      throw new Error('Bestellungs-ID oder Lieferantenreferenz stimmen nicht mit der ursprünglichen Quellzeile überein.');
    }
    if (!Number.isSafeInteger(row.targetRowCount) || row.targetRowCount < 0 || row.targetRowCount > to.source.rowCount
      || !Array.isArray(row.targetRows) || row.targetRows.length > row.targetRowCount
      || new Set(row.targetRows).size !== row.targetRows.length
      || Array.from(row.targetRows).some(position => !Number.isSafeInteger(position) || position < 1 || position > to.source.rowCount)
      || row.targetRowsTruncated !== (row.targetRows.length < row.targetRowCount)
      || (row.status === 'linked' && (row.targetRowCount !== 1 || row.targetRows.length !== 1))
      || (row.status === 'ambiguous_reference' && row.targetRowCount < 2)
      || (['missing_reference', 'unmatched_reference', 'invalid_source_key'].includes(row.status) && row.targetRowCount !== 0)) {
      throw new Error('Der Lieferantenbeleg enthält ungültige Zielzeilen oder Trefferzahlen.');
    }
    counts[relationshipCountKeys[row.status]]++;
  }
  if (Object.entries(counts).some(([key, value]) => relationship.counts[key as keyof typeof counts] !== value)) {
    throw new Error('Die Beziehungszahlen stimmen nicht mit den vollständigen Quellzeilen überein.');
  }
  return rows;
}

type Finding = 'overdue' | 'open' | 'closed' | 'unassessable';
const findingLabels: Record<Finding, string> = { overdue: 'Überfällig', open: 'Offen', closed: 'Abgeschlossen', unassessable: 'Nicht beurteilbar' };
const columns = ['Befund', 'Klärungsgrund', 'Quellzeile', 'Bestellung', 'Bestellungs-ID', 'Originalstatus', 'Liefertermin',
  'Terminbeurteilung', 'Tage überfällig', 'Lieferantenreferenz', 'Lieferantenbeziehung', 'Lieferant', 'Zielzeilen', 'Zieltreffer', 'Zielbeleg gekürzt'];

/** Pure evaluation of confirmed rules and a complete frozen relationship, without IO or a model call. */
export function reviewOrders(detail: RelationshipDetail, fromRows: ImportRow[], confirmedBinding: OrderReviewBinding,
  confirmedRule: OrderReviewRule, resultLimit = 100): OrderReviewResult {
  if (!Number.isSafeInteger(resultLimit) || resultLimit < 0 || resultLimit > 100_000) {
    throw new Error('Die Zahl der Bestellbefunde muss zwischen 0 und 100.000 liegen.');
  }
  const { binding, orderRule } = validateOrderReviewInput(confirmedBinding, confirmedRule, detail.from.source.columns, detail.from.keyField);
  const sourceRows = completeRows(detail, fromRows);
  const keyCounts = new Map<string, number>();
  for (const source of sourceRows) {
    const key = keyValue(cell(source, detail.from.keyField));
    if (key !== null) { const token = JSON.stringify(key); keyCounts.set(token, (keyCounts.get(token) ?? 0) + 1); }
  }
  const counts: OrderReviewResult['counts'] = { sourceRows: sourceRows.length, overdueRows: 0, openRows: 0,
    closedRows: 0, unassessableRows: 0, clarificationRows: 0, deadlineUnassessableRows: 0 };
  const open = new Set(orderRule.openStatuses); const closed = new Set(orderRule.closedStatuses);
  const projected = detail.rows.map(relation => {
    const source = sourceRows[relation.sourceRow - 1]!;
    const status = cell(source, binding.statusField);
    const dueDate = binding.dueDateField ? cell(source, binding.dueDateField) : undefined;
    const reasons: string[] = [];
    const invalidIdentity = relation.status === 'invalid_source_key' || relation.sourceKey === null
      || keyCounts.get(JSON.stringify(relation.sourceKey)) !== 1;
    if (invalidIdentity) reasons.push(relation.sourceKey === null
      ? 'Bestellungs-ID fehlt; die Bestellung ist nicht eindeutig identifizierbar.'
      : 'Bestellungs-ID ist nicht eindeutig; Mehrfachverwendung der ID klären.');
    const knownOpen = typeof status === 'string' && open.has(status);
    const knownClosed = typeof status === 'string' && closed.has(status);
    if (!knownOpen && !knownClosed) reasons.push(missing(status) ? 'Bestellstatus fehlt; Status ermitteln und bestätigen.'
      : typeof status !== 'string' ? 'Bestellstatus ist kein Text; Statuswert klären.'
        : 'Bestellstatus ist weder als offen noch als abgeschlossen bestätigt; Statuszuordnung klären.');
    if (relation.status === 'missing_reference') reasons.push('Lieferantenreferenz fehlt; zuständigen Lieferanten klären.');
    if (relation.status === 'unmatched_reference') reasons.push('Lieferantenreferenz findet keinen Lieferanten im bestätigten Zielstand; Referenz und Lieferantenbestand klären.');
    if (relation.status === 'ambiguous_reference') reasons.push(`Lieferantenreferenz trifft ${relation.targetRowCount} Zielzeilen; eindeutigen Lieferanten klären.`);
    if (relation.status === 'invalid_source_key') reasons.push('Lieferantenbeziehung ist ohne eindeutige Bestellungs-ID nicht beurteilbar.');

    let finding: Finding = invalidIdentity || (!knownOpen && !knownClosed) ? 'unassessable' : knownClosed ? 'closed' : 'open';
    let deadline = finding === 'closed' ? 'Nicht geprüft: Bestellung ist abgeschlossen.' : 'Nicht geprüft: Bestellung nicht eindeutig beurteilbar.';
    let overdueDays: number | null = null;
    if (finding === 'open') {
      if (orderRule.dueDateMeaning === 'not_available' || !calendarDay(dueDate)) {
        counts.deadlineUnassessableRows++;
        deadline = 'Nicht beurteilbar';
        reasons.push(orderRule.dueDateMeaning === 'not_available'
          ? 'Kein zugesagter Liefertag zugeordnet; Liefertermin klären.'
          : missing(dueDate) ? 'Zugesagter Liefertag fehlt; Liefertermin klären.'
            : 'Zugesagter Liefertag ist kein gültiger Kalendertag (YYYY-MM-DD); Terminwert klären.');
      } else if (dueDate < orderRule.asOf) {
        finding = 'overdue';
        overdueDays = dayNumber(orderRule.asOf) - dayNumber(dueDate);
        deadline = `Zugesagter Liefertag liegt vor dem Stichtag ${orderRule.asOf}.`;
      } else {
        overdueDays = 0;
        deadline = dueDate === orderRule.asOf ? `Am Stichtag ${orderRule.asOf} fällig; noch nicht überfällig.`
          : `Zugesagter Liefertag liegt nach dem Stichtag ${orderRule.asOf}.`;
      }
    }
    counts[`${finding}Rows`]++;
    if (reasons.length) counts.clarificationRows++;
    const priority = finding === 'overdue' ? 0 : finding === 'unassessable' ? 1 : finding === 'open' ? (reasons.length ? 2 : 3) : 4;
    const row: ImportRow = {
      Befund: findingLabels[finding], Klärungsgrund: reasons.join(' '), Quellzeile: relation.sourceRow,
      Bestellung: relation.sourceLabel, 'Bestellungs-ID': literal(relation.sourceKey), Originalstatus: status ?? null,
      Liefertermin: dueDate ?? null, Terminbeurteilung: deadline, 'Tage überfällig': overdueDays,
      Lieferantenreferenz: literal(relation.reference), Lieferantenbeziehung: relationshipLabels[relation.status],
      Lieferant: relation.status === 'linked' ? relation.targetLabel ?? null : null, Zielzeilen: relation.targetRows.join(', '),
      Zieltreffer: relation.targetRowCount, 'Zielbeleg gekürzt': relation.targetRowsTruncated,
    };
    return { priority, dueDate: finding === 'overdue' ? dueDate as string : '', sourceRow: relation.sourceRow, row };
  });
  projected.sort((a, b) => a.priority - b.priority || (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0) || a.sourceRow - b.sourceRow);
  const rows = projected.slice(0, resultLimit).map(entry => entry.row);
  return {
    summary: counts.sourceRows === 0 ? 'Der bestätigte Quellenstand enthält keine Bestellungen; ein Bestellungsbefund ist nicht möglich.'
      : `${counts.sourceRows} Quellzeilen: ${counts.overdueRows} überfällig, ${counts.openRows} offen, ${counts.closedRows} abgeschlossen, `
        + `${counts.unassessableRows} nicht beurteilbar. ${counts.clarificationRows} Zeilen benötigen Klärung; `
        + `bei ${counts.deadlineUnassessableRows} offenen Bestellungen ist der Termin nicht beurteilbar.`,
    counts, columns: [...columns], rows, totalRows: sourceRows.length, truncated: rows.length < sourceRows.length,
    ruleHash: orderReviewRuleHash(binding, orderRule),
  };
}
