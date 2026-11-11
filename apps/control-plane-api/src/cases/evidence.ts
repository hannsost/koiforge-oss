import { isDeepStrictEqual } from 'node:util';
import { ORDER_REVIEW_VERSION, orderReviewRuleHash, reviewOrders, validateOrderReviewInput } from '../domain/orders/review.js';
import { validateRows, type ImportRow } from '../import-capability/isolated-executor.js';
import type { Mission, MissionRelationship, MissionSource } from '../missions/contracts.js';
import { buildRoutineTemplate } from '../routines/prepare.js';
import type { CaseEvidence, CaseFindingsOptions, CaseFindingsPage, CaseSnapshot } from './contracts.js';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value: Record<string, unknown>, keys: string[]) => keys.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => keys.includes(key));
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const instant = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const findingColumns = ['Befund', 'Klärungsgrund', 'Quellzeile', 'Bestellung', 'Bestellungs-ID', 'Originalstatus', 'Liefertermin',
  'Terminbeurteilung', 'Tage überfällig', 'Lieferantenreferenz', 'Lieferantenbeziehung', 'Lieferant', 'Zielzeilen', 'Zieltreffer', 'Zielbeleg gekürzt'];
const relationLabels = ['Eindeutig zugeordnet', 'Lieferantenreferenz fehlt', 'Lieferant nicht gefunden',
  'Lieferant mehrdeutig', 'Bestellungs-ID nicht eindeutig'];
function invalid(message = 'Der Fallbeleg ist ungültig oder beschädigt.'): never { throw new Error(message); }

function source(value: unknown): asserts value is MissionSource {
  if (!record(value) || !exact(value, ['datasetId', 'name', 'columns', 'rowCount', 'hash', 'capturedAt', 'coverage'])
    || !text(value.datasetId) || !text(value.name) || !Array.isArray(value.columns) || value.columns.length > 512
    || !value.columns.every(column => text(column) && !['__proto__', 'constructor', 'prototype'].includes(column))
    || new Set(value.columns).size !== value.columns.length || !integer(value.rowCount) || value.rowCount > 100_000
    || !digest(value.hash) || !instant(value.capturedAt) || value.coverage !== 'complete') {
    invalid('Der Fall benötigt einen vollständigen, gültigen Quellenbeleg.');
  }
}
function relationship(value: unknown): asserts value is MissionRelationship {
  if (!record(value) || !exact(value, ['id', 'name', 'fromSetId', 'toSetId', 'fromName', 'toName', 'fromField', 'toField',
    'fromRevision', 'toRevision', 'sourceHash', 'targetHash', 'fromSnapshotHash', 'toSnapshotHash', 'targetRows'])
    || !['id', 'fromSetId', 'toSetId'].every(key => uuid(value[key]))
    || !['name', 'fromName', 'toName', 'fromField', 'toField'].every(key => text(value[key]))
    || !['sourceHash', 'targetHash', 'fromSnapshotHash', 'toSnapshotHash'].every(key => digest(value[key]))
    || !integer(value.fromRevision) || value.fromRevision < 1 || !integer(value.toRevision) || value.toRevision < 1
    || !integer(value.targetRows)) invalid('Der Fall benötigt einen gültigen Beziehungsbeleg.');
}
function primitiveLiteral(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== 'string') return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return (typeof parsed === 'string' && parsed.trim().length > 0)
      || typeof parsed === 'boolean' || (typeof parsed === 'number' && Number.isFinite(parsed));
  } catch { return false; }
}
function actionable(finding: ImportRow): boolean {
  return finding.Befund === 'Überfällig' || (typeof finding.Klärungsgrund === 'string' && finding.Klärungsgrund.trim().length > 0);
}

/** Checks persisted structure and cross-references; does not re-fetch or authenticate source data. */
export function validateCaseEvidence(value: unknown): CaseEvidence {
  if (!record(value) || !exact(value, ['missionId', 'sourceRow', 'question', 'source', 'targetSource', 'relationship',
    'capabilityVersion', 'orderKeyField', 'binding', 'orderRule', 'orderRuleHash', 'executedAt', 'finding'])
    || !uuid(value.missionId) || !integer(value.sourceRow) || value.sourceRow < 1 || !text(value.question, 1000)
    || value.capabilityVersion !== ORDER_REVIEW_VERSION || !text(value.orderKeyField)
    || !digest(value.orderRuleHash) || !instant(value.executedAt)) invalid();
  source(value.source); source(value.targetSource); relationship(value.relationship);
  const relation = value.relationship;
  const targetSource = value.targetSource;
  if (value.sourceRow > value.source.rowCount || relation.sourceHash !== value.source.hash
    || relation.targetHash !== value.targetSource.hash || relation.targetRows !== value.targetSource.rowCount
    || !value.source.columns.includes(relation.fromField) || !value.targetSource.columns.includes(relation.toField)) {
    invalid('Befund, Quellenstände und Beziehung des Falls stimmen nicht überein.');
  }
  const checked = validateOrderReviewInput(value.binding, value.orderRule, value.source.columns, value.orderKeyField);
  if (orderReviewRuleHash(checked.binding, checked.orderRule) !== value.orderRuleHash) {
    invalid('Die Bestellregel des Falls stimmt nicht mit ihrem Beleg überein.');
  }
  if (!record(value.finding) || !exact(value.finding, findingColumns)) invalid('Der gespeicherte Bestellbefund ist unvollständig.');
  const [finding] = validateRows([value.finding]);
  if (!finding || finding.Quellzeile !== value.sourceRow
    || !['Überfällig', 'Offen', 'Abgeschlossen', 'Nicht beurteilbar'].includes(String(finding.Befund))
    || typeof finding.Klärungsgrund !== 'string' || typeof finding.Bestellung !== 'string'
    || !primitiveLiteral(finding['Bestellungs-ID']) || !primitiveLiteral(finding.Lieferantenreferenz)
    || !text(finding.Terminbeurteilung) || !relationLabels.includes(String(finding.Lieferantenbeziehung))
    || (finding['Tage überfällig'] !== null && !integer(finding['Tage überfällig']))
    || (finding.Lieferant !== null && typeof finding.Lieferant !== 'string')
    || typeof finding.Zielzeilen !== 'string' || !integer(finding.Zieltreffer) || finding.Zieltreffer > value.targetSource.rowCount
    || typeof finding['Zielbeleg gekürzt'] !== 'boolean' || !actionable(finding)) invalid('Der gespeicherte Befund ist kein gültiger Klärungsfall.');
  const targetRows = finding.Zielzeilen ? finding.Zielzeilen.split(', ').map(Number) : [];
  if (targetRows.some(row => !Number.isSafeInteger(row) || row < 1 || row > targetSource.rowCount)
    || new Set(targetRows).size !== targetRows.length || targetRows.length > 20 || targetRows.length > finding.Zieltreffer
    || finding['Zielbeleg gekürzt'] !== (targetRows.length < finding.Zieltreffer)
    || (finding.Lieferantenbeziehung === 'Eindeutig zugeordnet' && finding.Zieltreffer !== 1)
    || (finding.Lieferantenbeziehung === 'Lieferant mehrdeutig' && finding.Zieltreffer < 2)
    || (['Lieferantenreferenz fehlt', 'Lieferant nicht gefunden', 'Bestellungs-ID nicht eindeutig'].includes(String(finding.Lieferantenbeziehung))
      && finding.Zieltreffer !== 0)
    || (finding.Lieferantenbeziehung !== 'Eindeutig zugeordnet' && finding.Lieferant !== null)) {
    invalid('Der Lieferantenbefund des Falls enthält ungültige Zielbelege.');
  }
  if (finding.Befund === 'Überfällig' && (!integer(finding['Tage überfällig']) || finding['Tage überfällig'] < 1)
    || (finding.Befund === 'Nicht beurteilbar' && !finding.Klärungsgrund.trim())) invalid();
  return structuredClone({ ...value, ...checked, finding } as unknown as CaseEvidence);
}

function verifiedFindings(mission: Mission, snapshot: CaseSnapshot) {
  // Reproduces the original bounded result, counts, rules, ownership and both
  // source/semantic receipts before any row is exposed beyond that result.
  const template = buildRoutineTemplate(mission, snapshot);
  const review = reviewOrders(snapshot.detail, snapshot.fromRows, template.binding, template.orderRule, snapshot.fromRows.length);
  if (review.summary !== mission.result!.summary || !isDeepStrictEqual(review.counts, mission.result!.counts)) {
    invalid('Das gespeicherte Auftragsergebnis lässt sich aus seinen bestätigten Belegen nicht reproduzieren.');
  }
  return { template, findings: review.rows.filter(actionable) };
}

/** Build one frozen case receipt from an original source position, including rows beyond 100. */
export function buildCaseEvidence(mission: Mission, snapshot: CaseSnapshot, sourceRow: number): CaseEvidence {
  if (!Number.isSafeInteger(sourceRow) || sourceRow < 1 || sourceRow > snapshot.fromRows.length) {
    invalid('Die Quellzeile muss eine vorhandene, 1-basierte ganze Zeilennummer sein.');
  }
  const { template, findings } = verifiedFindings(mission, snapshot);
  const finding = findings.find(row => row.Quellzeile === sourceRow);
  if (!finding) invalid('Diese Bestellung ist weder überfällig noch als Klärungsfall gekennzeichnet.');
  return validateCaseEvidence({ missionId: mission.id, sourceRow, question: mission.question,
    source: template.baseline.source, targetSource: template.baseline.targetSource, relationship: template.baseline.relationship,
    capabilityVersion: ORDER_REVIEW_VERSION, orderKeyField: template.baseline.orderKeyField,
    binding: template.binding, orderRule: template.orderRule, orderRuleHash: template.baseline.orderRuleHash,
    executedAt: mission.result!.evidence.executedAt, finding });
}

/** Page every actionable finding in the existing priority order, never a page of the 100-row result. */
export function listCaseFindings(mission: Mission, snapshot: CaseSnapshot, options: CaseFindingsOptions = {}): CaseFindingsPage {
  if (!record(options) || Object.keys(options).some(key => !['offset', 'limit'].includes(key))) invalid('Ungültige Angaben zur Befundseite.');
  const offset = options.offset === undefined ? 0 : options.offset;
  const limit = options.limit === undefined ? 100 : options.limit;
  if (!integer(offset) || !integer(limit) || limit < 1 || limit > 100) {
    invalid('Die Befundseite benötigt einen nicht negativen Offset und 1 bis 100 Zeilen.');
  }
  const { findings } = verifiedFindings(mission, snapshot);
  return structuredClone({ items: findings.slice(offset, offset + limit), offset, limit, totalRows: findings.length });
}
