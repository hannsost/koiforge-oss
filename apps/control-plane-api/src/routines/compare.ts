import { createHash } from 'node:crypto';
import { reviewOrders } from '../domain/orders/review.js';
import type { ImportRow } from '../import-capability/isolated-executor.js';
import type { Mission, MissionRelationship, MissionSource } from '../missions/contracts.js';
import type { RelationshipRow, SemanticPrimitive } from '../semantic-model/contracts.js';
import { buildRoutineTemplate, prepareRoutine, validateRoutineDefinition } from './prepare.js';
import type { RoutineDefinition, RoutineSnapshot } from './contracts.js';

export type ChangeCategory = 'new' | 'persisting' | 'cleared' | 'missing' | 'uncomparable';

export interface ChangeSide {
  sourceRow: number;
  finding: ImportRow;
  actionable: boolean;
}

export interface ChangeItem {
  category: ChangeCategory;
  key: string | number | boolean | null;
  reason: string | null;
  before: ChangeSide | null;
  after: ChangeSide | null;
  changedFields: string[];
}

export interface ChangeScope {
  source: MissionSource;
  targetSource: MissionSource;
  relationship: MissionRelationship;
  asOf: string;
  executedAt: string;
  orderRuleHash: string;
}

interface RoutineComparison {
  version: 'order-change-v1';
  routineId: string;
  baselineMissionId: string;
  missionId: string;
  comparisonHash: string;
  counts: Record<ChangeCategory, number>;
  before: ChangeScope;
  after: ChangeScope;
  items: ChangeItem[];
}

const VERSION = 'order-change-v1' as const;
const categoryOrder: Record<ChangeCategory, number> = {
  new: 0, persisting: 1, uncomparable: 2, missing: 3, cleared: 4,
};

/* This is deliberately independent of insertion order and keeps primitive types distinct. */
function canonical(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'number:NaN';
    if (Object.is(value, -0)) return 'number:-0';
    if (value === Infinity) return 'number:Infinity';
    if (value === -Infinity) return 'number:-Infinity';
    return `number:${JSON.stringify(value)}`;
  }
  if (typeof value === 'string') return `string:${JSON.stringify(value)}`;
  if (typeof value === 'boolean') return `boolean:${value ? 'true' : 'false'}`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return `${typeof value}:${String(value)}`;
}

/* Relationship validation and the semantic model use JSON's primitive spelling for IDs. */
const keyToken = (key: SemanticPrimitive | null): string => key === null ? 'missing:null' : JSON.stringify(key);
const isKey = (value: unknown): value is SemanticPrimitive =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

function clone<T>(value: T): T { return structuredClone(value); }

function fail(message: string): never { throw new Error(message); }

function same(left: unknown, right: unknown): boolean { return canonical(left) === canonical(right); }

function actionRequired(finding: ImportRow): boolean {
  return finding.Befund === 'Überfällig'
    || (typeof finding['Klärungsgrund'] === 'string' && finding['Klärungsgrund'].trim().length > 0);
}

/* Result columns whose values describe the finding itself. Source and target row positions are evidence plumbing. */
const findingFields = [
  'Befund', 'Klärungsgrund', 'Bestellung', 'Bestellungs-ID', 'Originalstatus', 'Liefertermin',
  'Terminbeurteilung', 'Tage überfällig', 'Lieferantenreferenz', 'Lieferantenbeziehung', 'Lieferant',
  'Zieltreffer',
];

function changedFields(before: ImportRow, after: ImportRow): string[] {
  return findingFields.filter(field => !same(before[field], after[field]));
}

function rowNumber(finding: ImportRow): number {
  const value = finding.Quellzeile;
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail('Der vollständige Bestellungsbefund enthält keine gültige Quellzeile.');
  return value as number;
}

function side(finding: ImportRow): ChangeSide {
  return { sourceRow: rowNumber(finding), finding: clone(finding), actionable: actionRequired(finding) };
}

function relationshipSourceKeys(snapshot: RoutineSnapshot): RelationshipRow[] {
  const rows = snapshot.detail.rows;
  if (rows.length !== snapshot.fromRows.length) fail('Der vollständige Beziehungsbeleg enthält nicht jede Quellzeile.');
  return rows;
}

interface RunData {
  scope: ChangeScope;
  findings: Map<number, ImportRow>;
  relationships: RelationshipRow[];
  keys: Map<number, SemanticPrimitive | null>;
  keyCounts: Map<string, number>;
}

function scopeFrom(preview: ReturnType<typeof prepareRoutine>, mission: Mission): ChangeScope {
  const executedAt = mission.result?.evidence.executedAt;
  if (typeof executedAt !== 'string') fail('Der Bestellungsauftrag enthält keinen gültigen Ausführungszeitpunkt.');
  return {
    source: clone(preview.source), targetSource: clone(preview.targetSource), relationship: clone(preview.relationship),
    asOf: preview.asOf, executedAt, orderRuleHash: preview.orderRuleHash,
  };
}

function evaluateRun(routine: RoutineDefinition, mission: Mission, snapshot: RoutineSnapshot, current = false): RunData {
  const preview = prepareRoutine(routine, snapshot, mission.input!.orderRule!.asOf);
  if (!preview.ready || !preview.previewHash) {
    fail(`Der Quellenstand kann für den Vergleich nicht ausgeführt werden: ${preview.blockingReasons.join(' ')}`);
  }
  if (current && (!mission.routine || mission.routine.previewHash !== preview.previewHash
    || mission.routine.confirmedRuleHash !== preview.orderRuleHash)) {
    fail('Der aktuelle Routinenauftrag stimmt nicht mit dem berechneten Vorprüfungs- und Regelbeleg überein.');
  }
  const review = reviewOrders(snapshot.detail, snapshot.fromRows, routine.binding,
    preview.orderRule, snapshot.fromRows.length);
  if (review.truncated || review.rows.length !== snapshot.fromRows.length) {
    fail('Der Vergleich benötigt den vollständigen Bestellungsbefund.');
  }
  const relationships = relationshipSourceKeys(snapshot);
  const findings = new Map<number, ImportRow>();
  for (const finding of review.rows) {
    const sourceRow = rowNumber(finding);
    if (findings.has(sourceRow)) fail('Der vollständige Bestellungsbefund enthält eine Quellzeile mehrfach.');
    findings.set(sourceRow, finding);
  }
  if (findings.size !== snapshot.fromRows.length) fail('Der vollständige Bestellungsbefund enthält nicht jede Quellzeile.');
  const keys = new Map<number, SemanticPrimitive | null>();
  const keyCounts = new Map<string, number>();
  for (const relation of relationships) {
    const key = relation.sourceKey;
    if (key !== null && !isKey(key)) fail('Der Beziehungsbeleg enthält eine ungültige typisierte Bestellungs-ID.');
    keys.set(relation.sourceRow, key);
    if (key !== null) {
      const token = keyToken(key);
      keyCounts.set(token, (keyCounts.get(token) ?? 0) + 1);
    }
  }
  return { scope: scopeFrom(preview, mission), findings, relationships, keys, keyCounts };
}

function assertOrigin(routine: RoutineDefinition, mission: Mission, snapshot: RoutineSnapshot): void {
  if (mission.id !== routine.sourceMissionId) fail('Der Ausgangsauftrag stimmt nicht mit der Herkunft der Routine überein.');
  const template = buildRoutineTemplate(mission, snapshot);
  const { id: _id, name: _name, createdAt: _createdAt, ...stored } = routine;
  if (!same(template, stored)) fail('Die Routinedefinition stimmt nicht mit dem belegten Ausgangsauftrag überein.');
}

function assertCurrentRun(routine: RoutineDefinition, mission: Mission, snapshot: RoutineSnapshot): void {
  const metadata = mission.routine;
  if (!metadata || metadata.id !== routine.id || metadata.name !== routine.name
    || metadata.sourceMissionId !== routine.sourceMissionId
    || metadata.baselineRuleHash !== routine.baseline.orderRuleHash
    || typeof metadata.previewHash !== 'string' || typeof metadata.confirmedRuleHash !== 'string') {
    fail('Der aktuelle Auftrag enthält keinen passenden Routinenbeleg.');
  }
  const template = buildRoutineTemplate(mission, snapshot);
  if (!same(template.binding, routine.binding)
    || !same(template.orderRule.openStatuses, routine.orderRule.openStatuses)
    || !same(template.orderRule.closedStatuses, routine.orderRule.closedStatuses)
    || template.orderRule.dueDateMeaning !== routine.orderRule.dueDateMeaning
    || template.baseline.orderKeyField !== routine.baseline.orderKeyField
    || template.baseline.relationship.fromField !== routine.baseline.relationship.fromField
    || template.baseline.relationship.toField !== routine.baseline.relationship.toField
    || template.baseline.fromFamilyId !== routine.baseline.fromFamilyId
    || template.baseline.toFamilyId !== routine.baseline.toFamilyId) {
    fail('Der aktuelle Auftrag verwendet andere bestätigte Routinenregeln oder Objektfamilien.');
  }
}

function invalidReason(sideName: 'before' | 'after', key: SemanticPrimitive | null, ownCount: number, otherCount: number): string {
  const label = sideName === 'before' ? 'Ausgangsstand' : 'neuen Stand';
  const parts: string[] = [];
  if (key === null) parts.push(`Die Bestellungs-ID fehlt im ${label}.`);
  else if (ownCount > 1) parts.push(`Die Bestellungs-ID ist im ${label} mehrfach vorhanden.`);
  if (key !== null && otherCount > 1) parts.push('Die Bestellungs-ID ist im jeweils anderen Stand mehrfach vorhanden.');
  return `${parts.join(' ')} Der Befund ist deshalb nicht eindeutig vergleichbar.`;
}

function sortItems(items: ChangeItem[]): ChangeItem[] {
  return items.sort((left, right) => {
    const category = categoryOrder[left.category] - categoryOrder[right.category];
    if (category) return category;
    const leftKey = keyToken(left.key); const rightKey = keyToken(right.key);
    const key = leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    if (key) return key;
    const leftRow = left.before?.sourceRow ?? left.after?.sourceRow ?? Number.MAX_SAFE_INTEGER;
    const rightRow = right.before?.sourceRow ?? right.after?.sourceRow ?? Number.MAX_SAFE_INTEGER;
    if (leftRow !== rightRow) return leftRow - rightRow;
    const leftSide = left.before && !left.after ? 0 : left.after && !left.before ? 1 : 2;
    const rightSide = right.before && !right.after ? 0 : right.after && !right.before ? 1 : 2;
    return leftSide - rightSide;
  });
}

export function compareRoutineRuns(
  routine: RoutineDefinition,
  beforeMission: Mission,
  beforeSnapshot: RoutineSnapshot,
  afterMission: Mission,
  afterSnapshot: RoutineSnapshot,
): RoutineComparison {
  const checkedRoutine = validateRoutineDefinition(routine);
  if (beforeMission.tenantId !== checkedRoutine.tenantId || beforeMission.ownerId !== checkedRoutine.ownerId
    || afterMission.tenantId !== checkedRoutine.tenantId || afterMission.ownerId !== checkedRoutine.ownerId) {
    fail('Routine, Aufträge und Quellenstände müssen demselben Mandanten und Besitzer gehören.');
  }
  assertOrigin(checkedRoutine, beforeMission, beforeSnapshot);
  assertCurrentRun(checkedRoutine, afterMission, afterSnapshot);
  const before = evaluateRun(checkedRoutine, beforeMission, beforeSnapshot);
  const after = evaluateRun(checkedRoutine, afterMission, afterSnapshot, true);

  const items: ChangeItem[] = [];
  const beforeByKey = new Map<string, Array<{ finding: ImportRow; key: SemanticPrimitive | null }>>();
  const afterByKey = new Map<string, Array<{ finding: ImportRow; key: SemanticPrimitive | null }>>();
  const add = (map: typeof beforeByKey, run: RunData) => {
    for (const relation of run.relationships) {
      const finding = run.findings.get(relation.sourceRow);
      if (!finding) fail('Der Beziehungsbeleg und der vollständige Bestellungsbefund sind nicht deckungsgleich.');
      const key = run.keys.get(relation.sourceRow);
      if (key === undefined) fail('Der Beziehungsbeleg enthält eine nicht auswertbare Quellzeile.');
      const token = keyToken(key);
      const entry = { finding, key };
      const list = map.get(token) ?? [];
      list.push(entry); map.set(token, list);
    }
  };
  add(beforeByKey, before); add(afterByKey, after);

  const invalidRows = (run: RunData, other: RunData, sideName: 'before' | 'after') => {
    for (const relation of run.relationships) {
      const finding = run.findings.get(relation.sourceRow)!;
      if (!actionRequired(finding)) continue;
      const key = run.keys.get(relation.sourceRow)!;
      const ownCount = key === null ? 0 : run.keyCounts.get(keyToken(key)) ?? 0;
      const otherCount = key === null ? 0 : other.keyCounts.get(keyToken(key)) ?? 0;
      if (key !== null && ownCount === 1 && otherCount <= 1) continue;
      items.push({ category: 'uncomparable', key: key ?? null, reason: invalidReason(sideName, key, ownCount, otherCount),
        before: sideName === 'before' ? side(finding) : null, after: sideName === 'after' ? side(finding) : null, changedFields: [] });
    }
  };
  invalidRows(before, after, 'before'); invalidRows(after, before, 'after');

  const validTokens = new Set<string>();
  for (const [token, entries] of beforeByKey) {
    if (entries.length === 1 && entries[0]!.key !== null && (afterByKey.get(token)?.length ?? 0) === 1) validTokens.add(token);
  }
  for (const token of validTokens) {
    const oldEntry = beforeByKey.get(token)![0]!; const newEntry = afterByKey.get(token)![0]!;
    const oldActionable = actionRequired(oldEntry.finding); const newActionable = actionRequired(newEntry.finding);
    if (!oldActionable && !newActionable) continue;
    const oldSide = side(oldEntry.finding); const newSide = side(newEntry.finding);
    const category: ChangeCategory = newActionable ? (oldActionable ? 'persisting' : 'new') : 'cleared';
    items.push({ category, key: oldEntry.key, reason: null, before: oldSide, after: newSide,
      changedFields: changedFields(oldEntry.finding, newEntry.finding) });
  }
  const unmatched = (run: RunData, other: RunData, sideName: 'before' | 'after') => {
    for (const relation of run.relationships) {
      const finding = run.findings.get(relation.sourceRow)!; if (!actionRequired(finding)) continue;
      const key = run.keys.get(relation.sourceRow)!; if (key === null) continue;
      if ((run.keyCounts.get(keyToken(key)) ?? 0) !== 1 || (other.keyCounts.get(keyToken(key)) ?? 0) > 1) continue;
      if (other.keyCounts.has(keyToken(key))) continue;
      items.push({ category: sideName === 'before' ? 'missing' : 'new', key, reason: null,
        before: sideName === 'before' ? side(finding) : null, after: sideName === 'after' ? side(finding) : null, changedFields: [] });
    }
  };
  unmatched(before, after, 'before'); unmatched(after, before, 'after');

  sortItems(items);
  const counts: Record<ChangeCategory, number> = { new: 0, persisting: 0, cleared: 0, missing: 0, uncomparable: 0 };
  for (const item of items) counts[item.category]++;
  const resultWithoutHash = { version: VERSION, routineId: checkedRoutine.id, baselineMissionId: beforeMission.id,
    missionId: afterMission.id, before: before.scope, after: after.scope, items };
  const comparisonHash = createHash('sha256').update(canonical(resultWithoutHash)).digest('hex');
  return clone({ ...resultWithoutHash, comparisonHash, counts });
}
