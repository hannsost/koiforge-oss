import { createHash } from 'node:crypto';
import { ORDER_REVIEW_VERSION, orderReviewRuleHash, reviewOrders, validateOrderReviewInput,
  type OrderReviewBinding, type OrderReviewRule } from '../domain/orders/review.js';
import { rowsHash, validateRows, type ImportRow } from '../import-capability/isolated-executor.js';
import type { Mission, MissionRelationship, MissionSource } from '../missions/contracts.js';
import type { ObjectSet, RelationshipDetail } from '../semantic-model/contracts.js';
import type { RoutineDefinition, RoutinePreview, RoutineSnapshot, RoutineSourceChanges, RoutineStatusProfile } from './contracts.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
const countKeys = ['sourceRows', 'overdueRows', 'openRows', 'closedRows', 'unassessableRows', 'clarificationRows', 'deadlineUnassessableRows'];
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exactKeys = (value: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const identifier = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && digest.test(value);
const instant = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const missing = (value: unknown) => value === undefined || value === null || (typeof value === 'string' && !value.trim());
const cell = (row: ImportRow, field: string) => Object.hasOwn(row, field) ? row[field] : undefined;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).filter(key => value[key] !== undefined).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
function invalid(message = 'Die gespeicherte Routinedefinition ist ungültig oder beschädigt.'): never { throw new Error(message); }

function assertSource(value: unknown): asserts value is MissionSource {
  if (!record(value) || !exactKeys(value, ['datasetId', 'name', 'columns', 'rowCount', 'hash', 'capturedAt', 'coverage'])
    || !text(value.datasetId) || !text(value.name) || !Array.isArray(value.columns) || value.columns.length > 512
    || Array.from(value.columns).some(column => !text(column) || ['__proto__', 'constructor', 'prototype'].includes(column))
    || new Set(value.columns).size !== value.columns.length || !integer(value.rowCount) || !hash(value.hash)
    || !instant(value.capturedAt) || value.coverage !== 'complete') invalid('Die Routine benötigt vollständige, gültige Quellenbelege.');
}
function assertRelationship(value: unknown): asserts value is MissionRelationship {
  if (!record(value) || !exactKeys(value, ['id', 'name', 'fromSetId', 'toSetId', 'fromName', 'toName', 'fromField', 'toField',
    'fromRevision', 'toRevision', 'sourceHash', 'targetHash', 'fromSnapshotHash', 'toSnapshotHash', 'targetRows'])
    || !['id', 'fromSetId', 'toSetId'].every(key => identifier(value[key]))
    || !['name', 'fromName', 'toName', 'fromField', 'toField'].every(key => text(value[key]))
    || !['sourceHash', 'targetHash', 'fromSnapshotHash', 'toSnapshotHash'].every(key => hash(value[key]))
    || !integer(value.fromRevision) || value.fromRevision < 1 || !integer(value.toRevision) || value.toRevision < 1
    || !integer(value.targetRows)) invalid('Die Routine benötigt einen gültigen Beziehungsbeleg.');
}
function assertCounts(value: unknown, sourceRows: number): asserts value is Record<string, number> {
  if (!record(value) || !exactKeys(value, countKeys) || !Object.values(value).every(integer)
    || value.sourceRows !== sourceRows || Number(value.overdueRows) + Number(value.openRows) + Number(value.closedRows)
      + Number(value.unassessableRows) !== sourceRows
    || Number(value.clarificationRows) > sourceRows || Number(value.deadlineUnassessableRows) > Number(value.openRows)) invalid('Die Ergebniszahlen der Ausgangsprüfung sind ungültig.');
}

/** Validate definitions again at the persistence boundary; returns an independent copy. */
export function validateRoutineDefinition(value: unknown): RoutineDefinition {
  if (!record(value) || !exactKeys(value, ['id', 'tenantId', 'ownerId', 'name', 'createdAt', 'sourceMissionId', 'capabilityId',
    'capabilityVersion', 'question', 'binding', 'orderRule', 'baseline'])
    || !identifier(value.id) || !identifier(value.sourceMissionId) || !text(value.tenantId, 200) || !text(value.ownerId, 200)
    || !text(value.name, 120) || !instant(value.createdAt) || !text(value.question, 4000)
    || value.capabilityId !== 'order_review' || value.capabilityVersion !== ORDER_REVIEW_VERSION || !record(value.baseline)) invalid();
  const baseline = value.baseline;
  if (!exactKeys(baseline, ['source', 'targetSource', 'relationship', 'orderKeyField', 'fromFamilyId', 'toFamilyId', 'counts', 'orderRuleHash'])
    || !text(baseline.orderKeyField) || !identifier(baseline.fromFamilyId) || !identifier(baseline.toFamilyId) || !hash(baseline.orderRuleHash)) invalid();
  assertSource(baseline.source); assertSource(baseline.targetSource); assertRelationship(baseline.relationship);
  const relationship = baseline.relationship;
  if (relationship.sourceHash !== baseline.source.hash || relationship.targetHash !== baseline.targetSource.hash
    || relationship.targetRows !== baseline.targetSource.rowCount || !baseline.source.columns.includes(baseline.orderKeyField)
    || !baseline.source.columns.includes(relationship.fromField) || !baseline.targetSource.columns.includes(relationship.toField)) invalid();
  const checked = validateOrderReviewInput(value.binding, value.orderRule, baseline.source.columns, baseline.orderKeyField);
  if (orderReviewRuleHash(checked.binding, checked.orderRule) !== baseline.orderRuleHash) invalid('Die bestätigte Bestellregel stimmt nicht mit ihrem Beleg überein.');
  assertCounts(baseline.counts, baseline.source.rowCount);
  return structuredClone({ ...value, ...checked } as unknown as RoutineDefinition);
}

function relationshipContext(detail: RelationshipDetail): MissionRelationship {
  const { relationship, from, to } = detail;
  return { id: relationship.id, name: relationship.name, fromSetId: from.id, toSetId: to.id,
    fromName: from.name, toName: to.name, fromField: relationship.fromField, toField: to.keyField,
    fromRevision: from.revision, toRevision: to.revision, sourceHash: from.source.hash, targetHash: to.source.hash,
    fromSnapshotHash: from.snapshotHash, toSnapshotHash: to.snapshotHash, targetRows: to.source.rowCount };
}

function assertObjectSet(set: ObjectSet, principal: { tenantId: string; ownerId: string }): void {
  assertSource(set.source);
  if (!identifier(set.id) || !identifier(set.familyId) || !integer(set.revision) || set.revision < 1 || !hash(set.snapshotHash)
    || set.tenantId !== principal.tenantId || set.ownerId !== principal.ownerId || set.confirmedBy !== principal.ownerId
    || !text(set.keyField) || !set.source.columns.includes(set.keyField)
    || (set.labelField !== undefined && !set.source.columns.includes(set.labelField))) {
    invalid('Die Objektmenge besitzt keine passende Bestätigung, Identität oder Schlüsselspalte.');
  }
}

function assertSnapshot(snapshot: RoutineSnapshot, principal: { tenantId: string; ownerId: string }): void {
  const { detail, fromRows } = snapshot;
  const { from, to, relationship } = detail;
  assertObjectSet(from, principal); assertObjectSet(to, principal);
  assertRelationship(relationshipContext(detail));
  const rows = validateRows(fromRows);
  if (relationship.tenantId !== principal.tenantId || relationship.ownerId !== principal.ownerId || relationship.confirmedBy !== principal.ownerId
    || relationship.fromSetId !== from.id || relationship.toSetId !== to.id || !from.source.columns.includes(relationship.fromField)
    || relationship.cardinality !== 'many-to-one' || relationship.contractVersion !== 'relationship-v1'
    || relationship.evidence.sourceHash !== from.source.hash || relationship.evidence.targetHash !== to.source.hash
    || relationship.evidence.fromRevision !== from.revision || relationship.evidence.toRevision !== to.revision
    || detail.truncated !== false || detail.offset !== 0 || detail.totalRows !== rows.length || detail.rows.length !== rows.length
    || from.source.rowCount !== rows.length || from.source.hash !== rowsHash(rows)
    || rows.some(row => Object.keys(row).some(column => !from.source.columns.includes(column)))) {
    invalid('Der Routine fehlen die vollständigen, unveränderten Quellzeilen und die passenden Belege beider Objektmengen.');
  }
  const keyCounts = new Map<string, number>();
  for (const row of rows) {
    const key = cell(row, from.keyField);
    if (!missing(key)) keyCounts.set(JSON.stringify(key), (keyCounts.get(JSON.stringify(key)) ?? 0) + 1);
  }
  for (const relation of detail.rows) {
    const row = rows[relation.sourceRow - 1];
    if (!row) invalid('Der Beziehungsbeleg verweist auf eine ungültige Quellzeile.');
    const key = cell(row, from.keyField); const reference = cell(row, relationship.fromField);
    const invalidKey = missing(key) || keyCounts.get(JSON.stringify(key)) !== 1;
    if ((relation.status === 'invalid_source_key') !== invalidKey
      || (!invalidKey && ((relation.status === 'missing_reference') !== missing(reference)))) {
      invalid('Die Beziehungsbedeutung stimmt nicht mit den bestätigten IDs und Lieferantenreferenzen überein.');
    }
  }
}

/** Only a completed, confirmed and reproducible order review can become a routine. */
export function buildRoutineTemplate(mission: Mission, snapshot: RoutineSnapshot): Omit<RoutineDefinition, 'id' | 'name' | 'createdAt'> {
  if (mission.status !== 'completed' || mission.phase !== 'execute' || mission.plan?.capabilityId !== 'order_review'
    || mission.plan.capabilityVersion !== ORDER_REVIEW_VERSION || mission.result?.capabilityId !== 'order_review'
    || mission.input?.confirmed !== true || mission.input.rule !== undefined || !mission.source || !mission.plan.relationship
    || !mission.plan.orderKeyField || !identifier(mission.id) || !text(mission.tenantId, 200) || !text(mission.ownerId, 200)
    || !text(mission.question, 4000)) invalid('Nur eine abgeschlossene, ausdrücklich bestätigte Bestellungsprüfung kann als Routine gespeichert werden.');
  assertSnapshot(snapshot, mission);
  const { detail, fromRows } = snapshot;
  const relationship = relationshipContext(detail);
  if (mission.datasetId !== detail.from.source.datasetId || mission.relationshipId !== relationship.id
    || mission.plan.orderKeyField !== detail.from.keyField || !same(mission.source, detail.from.source)
    || !same(mission.plan.relationship, relationship)) invalid('Der Ausgangsauftrag stimmt nicht mit dem bestätigten Fachmodell und seinen Quellenständen überein.');
  const checked = validateOrderReviewInput(mission.input.binding, mission.input.orderRule, mission.source.columns, mission.plan.orderKeyField);
  const review = reviewOrders(detail, fromRows, checked.binding, checked.orderRule);
  const evidence = mission.result.evidence;
  if (!evidence || evidence.capabilityVersion !== ORDER_REVIEW_VERSION || !instant(evidence.executedAt)
    || evidence.sourceHash !== relationship.sourceHash || evidence.targetSourceHash !== relationship.targetHash
    || evidence.fromSnapshotHash !== relationship.fromSnapshotHash || evidence.toSnapshotHash !== relationship.toSnapshotHash
    || evidence.relationshipId !== relationship.id || evidence.fromSetId !== relationship.fromSetId || evidence.toSetId !== relationship.toSetId
    || evidence.orderRuleHash !== review.ruleHash || !same(mission.result.counts, review.counts)
    || !same(mission.result.columns, review.columns) || !same(mission.result.rows, review.rows)
    || mission.result.totalRows !== review.totalRows || mission.result.truncated !== review.truncated) {
    invalid('Ergebnis, bestätigte Regel und Quellenbelege der Ausgangsprüfung stimmen nicht überein.');
  }
  return structuredClone({ tenantId: mission.tenantId, ownerId: mission.ownerId, sourceMissionId: mission.id,
    capabilityId: 'order_review', capabilityVersion: ORDER_REVIEW_VERSION, question: mission.question, ...checked,
    baseline: { source: detail.from.source, targetSource: detail.to.source, relationship, orderKeyField: detail.from.keyField,
      fromFamilyId: detail.from.familyId, toFamilyId: detail.to.familyId, counts: review.counts, orderRuleHash: review.ruleHash } });
}

function sourceChanges(previous: MissionSource, current: MissionSource, previousRevision: number, revision: number): RoutineSourceChanges {
  return { previousRevision, revision, previousRows: previous.rowCount, rows: current.rowCount,
    removedColumns: previous.columns.filter(column => !current.columns.includes(column)).sort(),
    addedColumns: current.columns.filter(column => !previous.columns.includes(column)).sort() };
}
function profile(rows: ImportRow[], binding: OrderReviewBinding, rule: OrderReviewRule): RoutineStatusProfile {
  const result: RoutineStatusProfile = { field: binding.statusField, totalRows: rows.length, knownOpenRows: 0, knownClosedRows: 0,
    unknownRows: 0, missingRows: 0, nonTextRows: 0, unassignableRows: 0, unknownValues: [], unknownUniqueTotal: 0, truncated: false };
  const unknown = new Map<string, number>();
  for (const row of rows) {
    const status = cell(row, binding.statusField);
    if (missing(status)) result.missingRows++;
    else if (typeof status !== 'string') result.nonTextRows++;
    else if (rule.openStatuses.includes(status)) result.knownOpenRows++;
    else if (rule.closedStatuses.includes(status)) result.knownClosedRows++;
    else {
      result.unknownRows++;
      if (status.length > 200) result.unassignableRows++;
      unknown.set(status, (unknown.get(status) ?? 0) + 1);
    }
  }
  result.unknownUniqueTotal = unknown.size;
  result.unknownValues = [...unknown].filter(([value]) => value.length <= 200).map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0)).slice(0, 20);
  result.truncated = result.unknownValues.length < result.unknownUniqueTotal;
  return result;
}

/** The token binds every visible approval input and both immutable provenance chains. */
export function computePreviewHash(routine: RoutineDefinition, preview: Omit<RoutinePreview, 'previewHash'>): string {
  const { previewHash: _ignored, ...content } = preview as RoutinePreview;
  return createHash('sha256').update(canonical({ contractVersion: 'routine-preview-v1', routine, preview: content })).digest('hex');
}

/** Synchronous preparation reads no registry, clock, model or scheduler. */
export function prepareRoutine(definition: RoutineDefinition, snapshot: RoutineSnapshot, asOf: string): RoutinePreview {
  const routine = validateRoutineDefinition(definition);
  const { detail, fromRows } = snapshot;
  const relationship = relationshipContext(detail);
  const baseline = routine.baseline;
  const valueChange = (previous: string, current: string) => ({ previous, current, changed: previous !== current });
  const changes: RoutinePreview['changes'] = {
    from: sourceChanges(baseline.source, detail.from.source, baseline.relationship.fromRevision, detail.from.revision),
    to: sourceChanges(baseline.targetSource, detail.to.source, baseline.relationship.toRevision, detail.to.revision),
    orderKey: valueChange(baseline.orderKeyField, detail.from.keyField),
    referenceField: valueChange(baseline.relationship.fromField, relationship.fromField),
    targetKey: valueChange(baseline.relationship.toField, relationship.toField),
    asOf: valueChange(routine.orderRule.asOf, asOf),
  };
  const blockingReasons: string[] = []; const warnings: string[] = [];
  if (detail.from.familyId !== baseline.fromFamilyId || detail.to.familyId !== baseline.toFamilyId) {
    blockingReasons.push('Bestellungen und Lieferanten müssen zu denselben Objektfamilien in derselben Beziehungsrichtung wie die Ausgangsprüfung gehören.');
  }
  if (changes.orderKey.changed) blockingReasons.push('Die Bestellungs-ID wurde geändert; dafür ist eine neue bestätigte Prüfung und Routine erforderlich.');
  if (changes.referenceField.changed) blockingReasons.push('Die Lieferantenreferenz wurde geändert; dafür ist eine neue bestätigte Prüfung und Routine erforderlich.');
  if (changes.targetKey.changed) blockingReasons.push('Die Lieferanten-ID wurde geändert; dafür ist eine neue bestätigte Prüfung und Routine erforderlich.');
  const requiredFrom = [baseline.orderKeyField, baseline.relationship.fromField, routine.binding.statusField,
    ...(routine.binding.dueDateField ? [routine.binding.dueDateField] : [])];
  for (const field of new Set(requiredFrom)) {
    if (!detail.from.source.columns.includes(field)) blockingReasons.push(`Benötigte Bestellspalte „${field}“ fehlt.`);
  }
  if (!detail.to.source.columns.includes(baseline.relationship.toField)) blockingReasons.push(`Benötigte Lieferantenspalte „${baseline.relationship.toField}“ fehlt.`);
  const orderRule = { ...routine.orderRule, asOf };
  try { validateOrderReviewInput(routine.binding, orderRule, baseline.source.columns, baseline.orderKeyField); }
  catch (error) { blockingReasons.push((error as Error).message); }
  let validRows: ImportRow[] = [];
  try { assertSnapshot(snapshot, routine); validRows = validateRows(fromRows); }
  catch (error) { blockingReasons.push((error as Error).message); }
  const statusProfile = profile(validRows, routine.binding, orderRule);
  if (statusProfile.unknownRows) warnings.push(`${statusProfile.unknownRows} Zeilen haben noch nicht bestätigte Statuswerte und bleiben fachlich ungeklärt.`);
  if (statusProfile.missingRows || statusProfile.nonTextRows) warnings.push('Fehlende Statuswerte und Statuswerte ohne Text bleiben fachlich ungeklärt.');
  if ([changes.from, changes.to].some(change => change.removedColumns.length || change.addedColumns.length)) {
    warnings.push('Quellspalten wurden hinzugefügt oder entfernt. Die bestätigten Feldzuordnungen werden unverändert verwendet.');
  }
  if (changes.asOf.changed || baseline.source.hash !== detail.from.source.hash || baseline.targetSource.hash !== detail.to.source.hash) {
    warnings.push('Die Zähler vergleichen vollständige Prüfstände. Ein anderer Stichtag oder Quellenbestand kann Differenzen erklären; sie belegen keine Einzeländerungen oder Ursachen.');
  }
  const preview: RoutinePreview = { routineId: routine.id, relationshipId: relationship.id, asOf, ready: false, blockingReasons, warnings,
    source: detail.from.source, targetSource: detail.to.source, relationship, orderKeyField: detail.from.keyField,
    binding: routine.binding, orderRule, changes, statusProfile, previousCounts: baseline.counts,
    orderRuleHash: orderReviewRuleHash(routine.binding, orderRule) };
  if (blockingReasons.length === 0) {
    try {
      const review = reviewOrders(detail, fromRows, routine.binding, orderRule);
      preview.newCounts = review.counts;
      preview.deltas = Object.fromEntries(Object.entries(review.counts).map(([key, count]) => [key, count - baseline.counts[key]!]));
      preview.orderRuleHash = review.ruleHash;
      preview.ready = true;
      preview.previewHash = computePreviewHash(routine, preview);
    } catch (error) { blockingReasons.push((error as Error).message); }
  }
  return structuredClone(preview);
}
