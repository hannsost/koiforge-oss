import { randomUUID } from 'node:crypto';
import type { SessionContext } from '@koiforge/security-core';
import type { AppRegistries } from '../registries.js';
import { rowsHash, validateRows, type ImportRow } from '../import-capability/isolated-executor.js';
import type { CreateObjectSetInput, CreateRelationshipInput, ObjectRow, ObjectSet, ObjectSetDetail, PageOptions,
  Relationship, RelationshipDetail, RelationshipRow, SemanticPrimitive, SemanticPrincipal } from './contracts.js';
import { FileSemanticModelStore, SEMANTIC_LIMITS, SEMANTIC_UUID, isRecord, receiptKey, safeField,
  semanticHash, snapshotHash, type FrozenField, type SemanticReceipt, type SemanticState, type StoredObjectSet } from './store.js';

export class SemanticModelError extends Error {
  constructor(message: string, public readonly statusCode = 400) { super(message); }
}
export interface SemanticModelOptions {
  root: string;
  registries: Pick<AppRegistries, 'dataset'>;
  resolvePrincipal: (reference: { userId: string; tenantId: string }) => Promise<SessionContext | null>;
  assertPermissions: (session: SessionContext, permissions: string[]) => void;
}
export interface DataflowPublication {
  flowId: string;
  definitionId: string;
  runId: string;
  name: string;
  keyField: string;
  labelField?: string;
  rows: ImportRow[];
  schema: FrozenField[];
  createdAt: string;
  expectedPreviousId?: string;
  sources: Array<{ setId: string; snapshotHash: string }>;
}
const cell = (row: ImportRow, field: string) => Object.hasOwn(row, field) ? row[field] : undefined;
const missing = (value: unknown) => value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
const keyValue = (value: SemanticPrimitive | null | undefined): SemanticPrimitive | null => missing(value) ? null : value!;
const keyToken = (value: SemanticPrimitive): string => JSON.stringify(value);
function uuid(value: unknown, field = 'ID'): string {
  if (typeof value !== 'string' || !SEMANTIC_UUID.test(value.toLowerCase())) throw new SemanticModelError(`${field} muss eine UUID sein.`);
  return value.toLowerCase();
}
function text(value: unknown, label: string, trim = true, maximum = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new SemanticModelError(`${label} ist erforderlich und darf höchstens ${maximum} Zeichen enthalten.`);
  return trim ? value.trim() : value;
}
function field(value: unknown, label: string): string {
  if (!safeField(value)) throw new SemanticModelError(`${label} muss ein gültiger Quellspaltenname sein.`);
  return value;
}
function inputBody(value: unknown, required: string[], optional: string[]): Record<string, unknown> {
  if (!isRecord(value) || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key)) || value.confirmed !== true) {
    throw new SemanticModelError('Bitte genau die beschriebenen Angaben übergeben und das Fachmodell ausdrücklich bestätigen.');
  }
  return value;
}
function objectInput(value: unknown): CreateObjectSetInput {
  const input = inputBody(value, ['name', 'datasetId', 'keyField', 'confirmed', 'requestId'], ['labelField', 'previousId']);
  return { name: text(input.name, 'Fachname'), datasetId: text(input.datasetId, 'Datenquelle'),
    keyField: field(input.keyField, 'ID-Feld'), confirmed: true, requestId: uuid(input.requestId, 'requestId'),
    ...(input.labelField !== undefined ? { labelField: field(input.labelField, 'Anzeigename-Feld') } : {}),
    ...(input.previousId !== undefined ? { previousId: uuid(input.previousId, 'previousId') } : {}) };
}
function relationshipInput(value: unknown): CreateRelationshipInput {
  const input = inputBody(value, ['name', 'fromSetId', 'toSetId', 'fromField', 'confirmed', 'requestId'], []);
  return { name: text(input.name, 'Beziehungsname'), fromSetId: uuid(input.fromSetId, 'fromSetId'),
    toSetId: uuid(input.toSetId, 'toSetId'), fromField: field(input.fromField, 'Fremdschlüsselfeld'),
    confirmed: true, requestId: uuid(input.requestId, 'requestId') };
}
const schemaTypes = ['string', 'number', 'integer', 'boolean', 'date', 'datetime', 'json'];
const digest = /^[a-f0-9]{64}$/;
function dataflowPublicationInput(value: unknown): DataflowPublication {
  const required = ['flowId', 'definitionId', 'runId', 'name', 'keyField', 'rows', 'schema', 'createdAt', 'sources'];
  const optional = ['labelField', 'expectedPreviousId'];
  if (!isRecord(value) || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new SemanticModelError('Ungültige Datenflussveröffentlichung.');
  }
  const flowId = uuid(value.flowId, 'flowId'); const definitionId = uuid(value.definitionId, 'definitionId');
  const runId = uuid(value.runId, 'runId'); const name = text(value.name, 'Fachname');
  const keyField = field(value.keyField, 'ID-Feld');
  const labelField = value.labelField === undefined ? undefined : field(value.labelField, 'Anzeigename-Feld');
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || new Date(value.createdAt).toISOString() !== value.createdAt) {
    throw new SemanticModelError('createdAt muss ein kanonischer Zeitstempel sein.');
  }
  if (!Array.isArray(value.schema) || value.schema.length > 512 || value.schema.some(item => !isRecord(item)
    || !Object.hasOwn(item, 'name') || !Object.hasOwn(item, 'type')
    || Object.keys(item).some(key => !['name', 'type', 'nullable'].includes(key))
    || !safeField(item.name) || typeof item.type !== 'string' || !schemaTypes.includes(item.type)
    || (item.nullable !== undefined && typeof item.nullable !== 'boolean'))) {
    throw new SemanticModelError('Das Datenflussschema ist ungültig.');
  }
  const schema: FrozenField[] = value.schema.map(item => ({ name: item.name as string, type: item.type as string,
    ...(item.nullable !== undefined ? { nullable: item.nullable as boolean } : {}) }));
  const columns = schema.map(item => item.name);
  if (new Set(columns).size !== columns.length || !columns.includes(keyField)
    || (labelField !== undefined && !columns.includes(labelField))) {
    throw new SemanticModelError('Bitte eindeutige vorhandene Spalten als ID und Anzeigename auswählen.');
  }
  let rows: ImportRow[];
  try { rows = validateRows(value.rows); }
  catch (error) { throw new SemanticModelError(error instanceof Error ? error.message : 'Ungültige Datenflusszeilen.'); }
  if (rows.some(row => Object.keys(row).some(key => !columns.includes(key)))) {
    throw new SemanticModelError('Die vollständigen Datenflusszeilen stimmen nicht mit dem Schema überein.');
  }
  const quality = keyIndex(rows, keyField).quality;
  if (quality.missingKeys > 0 || quality.duplicateRows > 0) {
    throw new SemanticModelError('Das ID-Feld der Datenflussausgabe muss vollständig und eindeutig sein.');
  }
  if (!Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 3
    || value.sources.some(source => !isRecord(source) || !Object.hasOwn(source, 'setId') || !Object.hasOwn(source, 'snapshotHash')
      || Object.keys(source).some(key => !['setId', 'snapshotHash'].includes(key)))) {
    throw new SemanticModelError('Die Datenflussquellen sind ungültig.');
  }
  const sources = value.sources.map(source => ({
    setId: uuid((source as Record<string, unknown>).setId, 'Quellmodell-ID'),
    snapshotHash: (source as Record<string, unknown>).snapshotHash,
  }));
  if (sources.some(source => typeof source.snapshotHash !== 'string' || !digest.test(source.snapshotHash))
    || new Set(sources.map(source => source.setId)).size !== sources.length) {
    throw new SemanticModelError('Datenflussquellen müssen eindeutig auf gültige Quellenstände verweisen.');
  }
  return { flowId, definitionId, runId, name, keyField, ...(labelField !== undefined ? { labelField } : {}), rows, schema,
    createdAt: value.createdAt, ...(value.expectedPreviousId !== undefined
      ? { expectedPreviousId: uuid(value.expectedPreviousId, 'expectedPreviousId') } : {}),
    sources: sources as Array<{ setId: string; snapshotHash: string }> };
}
function pagination(options: PageOptions | undefined): Required<PageOptions> {
  if (options !== undefined && (!isRecord(options) || Object.keys(options).some(key => key !== 'offset' && key !== 'limit'))) {
    throw new SemanticModelError('Ungültige Seitenangaben.');
  }
  const offset = options?.offset ?? 0; const limit = options?.limit ?? SEMANTIC_LIMITS.maxPageRows;
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0
    || typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > SEMANTIC_LIMITS.maxPageRows) {
    throw new SemanticModelError('offset muss nichtnegativ sein; limit muss zwischen 1 und 100 liegen.');
  }
  return { offset, limit };
}
interface KeyGroup { count: number; positions: number[] }
function keyIndex(rows: ImportRow[], keyField: string): { groups: Map<string, KeyGroup>; quality: ObjectSet['keyQuality'] } {
  const groups = new Map<string, KeyGroup>();
  const quality = { totalRows: rows.length, identifiedRows: 0, missingKeys: 0, duplicateRows: 0, duplicateGroups: 0 };
  rows.forEach((row, index) => {
    const value = keyValue(cell(row, keyField));
    if (value === null) { quality.missingKeys++; return; }
    const token = keyToken(value);
    const group = groups.get(token) ?? { count: 0, positions: [] };
    group.count++;
    if (group.positions.length < SEMANTIC_LIMITS.maxTargetExamples) group.positions.push(index + 1);
    groups.set(token, group);
  });
  for (const group of groups.values()) {
    if (group.count === 1) quality.identifiedRows++;
    else { quality.duplicateRows += group.count; quality.duplicateGroups++; }
  }
  return { groups, quality };
}
function rowLabel(stored: StoredObjectSet, row: ImportRow, position: number): string {
  const label = stored.objectSet.labelField ? cell(row, stored.objectSet.labelField) : undefined;
  const value = !missing(label) ? label : keyValue(cell(row, stored.objectSet.keyField));
  const result = value === null ? `Zeile ${position}` : String(value);
  return result.length > 300 ? `${result.slice(0, 299)}…` : result;
}
function ownedObject(state: SemanticState, principal: SemanticPrincipal, id: string): StoredObjectSet {
  const stored = Object.hasOwn(state.objectSets, id) ? state.objectSets[id] : undefined;
  if (!stored || stored.objectSet.tenantId !== principal.tenantId || stored.objectSet.ownerId !== principal.ownerId) {
    throw new SemanticModelError('Fachmodell nicht gefunden.', 404);
  }
  return stored;
}
function ownedRelationship(state: SemanticState, principal: SemanticPrincipal, id: string): Relationship {
  const stored = Object.hasOwn(state.relationships, id) ? state.relationships[id] : undefined;
  if (!stored || stored.relationship.tenantId !== principal.tenantId || stored.relationship.ownerId !== principal.ownerId) {
    throw new SemanticModelError('Beziehung nicht gefunden.', 404);
  }
  return stored.relationship;
}
export function objectRowAt(stored: StoredObjectSet, sourceRow: number, index = objectKeyIndex(stored)): ObjectRow {
  const attributes = stored.rows[sourceRow - 1];
  if (!Number.isSafeInteger(sourceRow) || sourceRow < 1 || !attributes) throw new Error('Ungültige interne Quellzeile.');
  const key = keyValue(cell(attributes, stored.objectSet.keyField));
  const identity = key === null ? 'missing' : index.groups.get(keyToken(key))!.count === 1 ? 'unique' : 'duplicate';
  return { sourceRow, key, label: rowLabel(stored, attributes, sourceRow), identity, attributes };
}
export function objectDetail(stored: StoredObjectSet, page: Required<PageOptions>): ObjectSetDetail {
  const index = objectKeyIndex(stored);
  const rows = stored.rows.slice(page.offset, page.offset + page.limit).map((_, offset) => objectRowAt(stored, page.offset + offset + 1, index));
  return { objectSet: stored.objectSet, rows, totalRows: stored.rows.length, truncated: rows.length < stored.rows.length, offset: page.offset };
}
const statusOrder: RelationshipRow['status'][] = ['invalid_source_key', 'missing_reference', 'ambiguous_reference', 'unmatched_reference', 'linked'];
export function objectKeyIndex(stored: StoredObjectSet) { return keyIndex(stored.rows, stored.objectSet.keyField); }

// Shared classification rules without allocating a full relationship page.
// Callers may reuse indexes within one immutable snapshot, never across reads.
export function relationshipClassifier(from: StoredObjectSet, to: StoredObjectSet, fromField: string,
  sourceIndex = objectKeyIndex(from), targetIndex = objectKeyIndex(to)) {
  return (row: ImportRow): { status: RelationshipRow['status']; key: SemanticPrimitive | null; reference: SemanticPrimitive | null; target?: KeyGroup } => {
    const key = keyValue(cell(row, from.objectSet.keyField));
    const reference = keyValue(cell(row, fromField));
    if (key === null || sourceIndex.groups.get(keyToken(key))?.count !== 1) return { status: 'invalid_source_key', key, reference };
    if (reference === null) return { status: 'missing_reference', key, reference };
    const target = targetIndex.groups.get(keyToken(reference));
    return { status: !target ? 'unmatched_reference' : target.count > 1 ? 'ambiguous_reference' : 'linked', key, reference, target };
  };
}
export function relationProjection(from: StoredObjectSet, to: StoredObjectSet, fromField: string, page?: Required<PageOptions>) {
  const classify = relationshipClassifier(from, to, fromField);
  const counts: Relationship['counts'] = { sourceRows: from.rows.length, linkedRows: 0, missingReferences: 0,
    unmatchedReferences: 0, ambiguousReferences: 0, invalidSourceRows: 0 };
  const positions = new Map(statusOrder.map(status => [status, [] as number[]]));
  from.rows.forEach((row, index) => {
    const { status } = classify(row);
    if (status === 'linked') counts.linkedRows++;
    else if (status === 'missing_reference') counts.missingReferences++;
    else if (status === 'unmatched_reference') counts.unmatchedReferences++;
    else if (status === 'ambiguous_reference') counts.ambiguousReferences++;
    else counts.invalidSourceRows++;
    if (page) positions.get(status)!.push(index);
  });
  const rows: RelationshipRow[] = [];
  if (page) {
    const selected = statusOrder.flatMap(status => positions.get(status)!).slice(page.offset, page.offset + page.limit);
    for (const index of selected) {
      const row = from.rows[index]!;
      const classified = classify(row);
      const targetRows = classified.target?.positions ?? [];
      const targetRowCount = classified.target?.count ?? 0;
      rows.push({ sourceRow: index + 1, sourceKey: classified.key, reference: classified.reference, status: classified.status,
        targetRows: [...targetRows], targetRowCount, targetRowsTruncated: targetRowCount > targetRows.length,
        sourceLabel: rowLabel(from, row, index + 1),
        ...(classified.status === 'linked' ? { targetLabel: rowLabel(to, to.rows[targetRows[0]! - 1]!, targetRows[0]!) } : {}) });
    }
  }
  return { counts, rows };
}

export function createSemanticModelService(options: SemanticModelOptions) {
  const store = new FileSemanticModelStore(options.root);
  const principal = (session: SessionContext): SemanticPrincipal => ({ tenantId: session.tenant.id, ownerId: session.user.id });
  function authorize(session: SessionContext, write: boolean) {
    if (!session?.user?.id || !session?.tenant?.id) throw new SemanticModelError('Bitte anmelden.', 401);
    if (session.tenant.status !== 'active') throw new SemanticModelError('Der Arbeitsbereich ist nicht aktiv.', 403);
    try { options.assertPermissions(session, write ? ['datasets.read', 'datasets.manage'] : ['datasets.read']); }
    catch { throw new SemanticModelError('Keine Berechtigung für dieses Fachmodell.', 403); }
  }
  async function current(session: SessionContext, write: boolean): Promise<void> {
    authorize(session, write);
    const resolved = await options.resolvePrincipal({ userId: session.user.id, tenantId: session.tenant.id });
    if (!resolved || resolved.user.id !== session.user.id || resolved.tenant.id !== session.tenant.id) {
      throw new SemanticModelError('Die Fachmodellberechtigung ist nicht mehr gültig.', 403);
    }
    authorize(resolved, write);
  }
  function receipt(state: SemanticState, session: SessionContext, operation: SemanticReceipt['operation'], input: CreateObjectSetInput | CreateRelationshipInput) {
    const { requestId, ...payload } = input;
    const base = { ...principal(session), operation, requestId };
    const key = receiptKey(base); const payloadHash = semanticHash(payload);
    const prior = Object.hasOwn(state.requests, key) ? state.requests[key] : undefined;
    if (prior && prior.payloadHash !== payloadHash) throw new SemanticModelError('requestId wurde bereits für andere Angaben verwendet.', 409);
    return { key, prior, value: { ...base, payloadHash } };
  }
  function room(state: SemanticState) {
    if (Object.keys(state.objectSets).length + Object.keys(state.relationships).length >= SEMANTIC_LIMITS.maxEntities) {
      throw new SemanticModelError('Die Fachmodellablage hat ihre Datensatzgrenze erreicht.', 413);
    }
  }
  function relationshipDetail(state: SemanticState, owner: SemanticPrincipal, id: string, page: Required<PageOptions>): RelationshipDetail {
    const relationship = ownedRelationship(state, owner, id);
    const from = ownedObject(state, owner, relationship.fromSetId); const to = ownedObject(state, owner, relationship.toSetId);
    const projection = relationProjection(from, to, relationship.fromField, page);
    if (semanticHash(projection.counts) !== semanticHash(relationship.counts)) throw new Error('Gespeicherte Beziehungsbefunde stimmen nicht mit den Quellenständen überein.');
    return { relationship, from: from.objectSet, to: to.objectSet, rows: projection.rows,
      totalRows: projection.counts.sourceRows, truncated: projection.rows.length < projection.counts.sourceRows, offset: page.offset };
  }
  return {
    async publishDataflow(session: SessionContext, input: DataflowPublication,
      guard?: (state: SemanticState) => void): Promise<ObjectSet> {
      let frozen: unknown;
      try { frozen = structuredClone(input); }
      catch { throw new SemanticModelError('Ungültige Datenflussveröffentlichung.'); }
      await current(session, true);
      const publication = dataflowPublicationInput(frozen);
      return store.update(state => {
        const owner = principal(session);
        const base = { ...owner, operation: 'object-set' as const, requestId: publication.runId };
        const key = receiptKey(base);
        const payloadHash = semanticHash({ operation: 'dataflow-publication-v1', ...publication });
        const prior = Object.hasOwn(state.requests, key) ? state.requests[key] : undefined;
        if (prior && prior.payloadHash !== payloadHash) {
          throw new SemanticModelError('runId wurde bereits für andere Angaben verwendet.', 409);
        }
        if (prior) return ownedObject(state, owner, prior.entityId).objectSet;
        guard?.(structuredClone(state));
        room(state);
        for (const binding of publication.sources) {
          const source = ownedObject(state, owner, binding.setId).objectSet;
          if (source.snapshotHash !== binding.snapshotHash
            || Object.values(state.objectSets).some(entry => entry.objectSet.familyId === source.familyId
              && entry.objectSet.revision > source.revision)) {
            throw new SemanticModelError('Ein Quellenstand hat sich geändert. Bitte den Datenfluss erneut ausführen.', 409);
          }
        }
        let previous: ObjectSet | undefined;
        if (publication.expectedPreviousId !== undefined) {
          previous = ownedObject(state, owner, publication.expectedPreviousId).objectSet;
          if (previous.familyId !== publication.flowId
            || Object.values(state.objectSets).some(entry => entry.objectSet.familyId === publication.flowId
              && entry.objectSet.revision > previous!.revision)) {
            throw new SemanticModelError('Die Datenflussausgabe hat bereits eine neuere Revision. Bitte den aktuellen Stand laden.', 409);
          }
        } else if (Object.hasOwn(state.objectSets, publication.flowId)
          || Object.hasOwn(state.relationships, publication.flowId)
          || Object.values(state.objectSets).some(entry => entry.objectSet.familyId === publication.flowId)) {
          throw new SemanticModelError('Für diesen Datenfluss besteht bereits eine veröffentlichte Ausgabe.', 409);
        }
        const id = previous ? randomUUID() : publication.flowId;
        const columns = publication.schema.map(item => item.name);
        const objectSet: ObjectSet = {
          id, familyId: publication.flowId, revision: previous ? previous.revision + 1 : 1,
          ...(previous ? { previousId: previous.id } : {}), ...owner, name: publication.name, keyField: publication.keyField,
          ...(publication.labelField !== undefined ? { labelField: publication.labelField } : {}),
          source: { datasetId: `dataflow:${publication.flowId}:${publication.runId}`, name: publication.name,
            columns, rowCount: publication.rows.length, hash: rowsHash(publication.rows), capturedAt: publication.createdAt,
            coverage: 'complete' },
          snapshotHash: '', createdAt: publication.createdAt, confirmedBy: session.user.id,
          keyQuality: keyIndex(publication.rows, publication.keyField).quality,
        };
        objectSet.snapshotHash = snapshotHash(objectSet, publication.schema);
        state.objectSets[id] = { objectSet, rows: publication.rows, schema: publication.schema, confirmed: true };
        state.requests[key] = { ...base, payloadHash, entityId: id };
        return objectSet;
      }, () => current(session, true));
    },
    async createObjectSet(session: SessionContext, raw: unknown): Promise<ObjectSet> {
      await current(session, true);
      const input = objectInput(raw);
      return store.update(async state => {
        const request = receipt(state, session, 'object-set', input);
        if (request.prior) return ownedObject(state, principal(session), request.prior.entityId).objectSet;
        room(state);
        const previous = input.previousId ? ownedObject(state, principal(session), input.previousId).objectSet : undefined;
        if (previous && Object.values(state.objectSets).some(entry => entry.objectSet.familyId === previous.familyId
          && entry.objectSet.source.datasetId.startsWith(`dataflow:${previous.familyId}:`))) {
          throw new SemanticModelError('Diese Objektfamilie wird von einem Datenfluss berechnet. Bitte einen neuen Durchlauf prüfen und veröffentlichen.', 409);
        }
        if (previous && Object.values(state.objectSets).some(entry => entry.objectSet.familyId === previous.familyId && entry.objectSet.revision > previous.revision)) {
          throw new SemanticModelError('Dieses Fachmodell hat bereits eine neuere Revision. Bitte den aktuellen Stand laden.', 409);
        }
        // A single registry read supplies metadata AND full rows: no live preview race.
        const dataset = await options.registries.dataset.getDataset(input.datasetId);
        if (!dataset || dataset.connectorId !== 'inline' || !isRecord(dataset.source) || !Array.isArray(dataset.source.previewRows)
          || (dataset.source.coverage !== undefined && dataset.source.coverage !== 'complete')) {
          throw new SemanticModelError('Bitte eine vollständig importierte Inline-Datenquelle auswählen.');
        }
        let rows: ImportRow[];
        try { rows = validateRows(dataset.source.previewRows); }
        catch (error) { throw new SemanticModelError(error instanceof Error ? error.message : 'Ungültige Quelldaten.'); }
        if (!Array.isArray(dataset.schema) || dataset.schema.length > 512 || dataset.schema.some(item => !isRecord(item)
          || !safeField(item.name) || !['string', 'number', 'integer', 'boolean', 'date', 'datetime', 'json'].includes(item.type)
          || (item.nullable !== undefined && typeof item.nullable !== 'boolean'))) throw new SemanticModelError('Das gespeicherte Quellschema ist ungültig.');
        const schema: FrozenField[] = dataset.schema.map(item => ({ name: item.name, type: item.type,
          ...(item.nullable !== undefined ? { nullable: item.nullable } : {}) }));
        const columns = schema.map(item => item.name);
        if (new Set(columns).size !== columns.length || rows.some(row => Object.keys(row).some(key => !columns.includes(key)))) {
          throw new SemanticModelError('Die vollständigen Quelldaten stimmen nicht mit dem gespeicherten Schema überein.');
        }
        if (!columns.includes(input.keyField) || (input.labelField !== undefined && !columns.includes(input.labelField))) {
          throw new SemanticModelError('Bitte vorhandene Quellenspalten als ID und Anzeigename auswählen.');
        }
        const id = randomUUID(); const createdAt = new Date().toISOString();
        const objectSet: ObjectSet = { id, familyId: previous?.familyId ?? id, revision: previous ? previous.revision + 1 : 1,
          ...(previous ? { previousId: previous.id } : {}), ...principal(session), name: input.name, keyField: input.keyField,
          ...(input.labelField !== undefined ? { labelField: input.labelField } : {}),
          source: { datasetId: input.datasetId, name: text(dataset.name, 'Quellenname'), columns, rowCount: rows.length,
            hash: rowsHash(rows), capturedAt: createdAt, coverage: 'complete' }, snapshotHash: '', createdAt,
          confirmedBy: session.user.id, keyQuality: keyIndex(rows, input.keyField).quality };
        objectSet.snapshotHash = snapshotHash(objectSet, schema);
        state.objectSets[id] = { objectSet, rows, schema, confirmed: true };
        state.requests[request.key] = { ...request.value, entityId: id };
        return objectSet;
      }, () => current(session, true));
    },
    async listObjectSets(session: SessionContext): Promise<ObjectSet[]> {
      await current(session, false);
      return Object.values((await store.read()).objectSets).map(entry => entry.objectSet)
        .filter(set => set.tenantId === session.tenant.id && set.ownerId === session.user.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    },
    async getObjectSet(session: SessionContext, id: string, options?: PageOptions): Promise<ObjectSetDetail> {
      await current(session, false);
      return objectDetail(ownedObject(await store.read(), principal(session), uuid(id)), pagination(options));
    },
    async createRelationship(session: SessionContext, raw: unknown): Promise<Relationship> {
      await current(session, true); const input = relationshipInput(raw);
      return store.update(state => {
        const request = receipt(state, session, 'relationship', input);
        if (request.prior) return ownedRelationship(state, principal(session), request.prior.entityId);
        room(state);
        const from = ownedObject(state, principal(session), input.fromSetId); const to = ownedObject(state, principal(session), input.toSetId);
        if (!from.objectSet.source.columns.includes(input.fromField)) throw new SemanticModelError('Bitte ein vorhandenes Fremdschlüsselfeld des Quellmodells wählen.');
        const relationship: Relationship = { id: randomUUID(), ...principal(session), name: input.name, fromSetId: from.objectSet.id,
          toSetId: to.objectSet.id, fromField: input.fromField, createdAt: new Date().toISOString(), confirmedBy: session.user.id,
          cardinality: 'many-to-one', contractVersion: 'relationship-v1', counts: relationProjection(from, to, input.fromField).counts,
          evidence: { sourceHash: from.objectSet.source.hash, targetHash: to.objectSet.source.hash,
            fromRevision: from.objectSet.revision, toRevision: to.objectSet.revision } };
        state.relationships[relationship.id] = { relationship, confirmed: true };
        state.requests[request.key] = { ...request.value, entityId: relationship.id };
        return relationship;
      }, () => current(session, true));
    },
    async listRelationships(session: SessionContext): Promise<Relationship[]> {
      await current(session, false);
      return Object.values((await store.read()).relationships).map(entry => entry.relationship)
        .filter(relation => relation.tenantId === session.tenant.id && relation.ownerId === session.user.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    },
    async getRelationship(session: SessionContext, id: string, options?: PageOptions): Promise<RelationshipDetail> {
      await current(session, false);
      return relationshipDetail(await store.read(), principal(session), uuid(id), pagination(options));
    },
    async relationshipForMission(reference: SemanticPrincipal, id: string): Promise<RelationshipDetail> {
      if (!isRecord(reference) || Object.keys(reference).some(key => !['tenantId', 'ownerId'].includes(key))
        || typeof reference.tenantId !== 'string' || !reference.tenantId || typeof reference.ownerId !== 'string' || !reference.ownerId) {
        throw new SemanticModelError('Ungültige Auftragsidentität.', 403);
      }
      const resolved = await options.resolvePrincipal({ userId: reference.ownerId, tenantId: reference.tenantId });
      if (!resolved || resolved.user.id !== reference.ownerId || resolved.tenant.id !== reference.tenantId) throw new SemanticModelError('Die Auftragsberechtigung ist nicht mehr gültig.', 403);
      authorize(resolved, true);
      return relationshipDetail(await store.read(), reference, uuid(id), pagination(undefined));
    },
    // Internal execution access: both frozen objects and every association are
    // derived from ONE checked state. This is never an unbounded HTTP endpoint.
    async relationshipSnapshotForMission(reference: SemanticPrincipal, id: string): Promise<{ detail: RelationshipDetail; fromRows: ImportRow[] }> {
      if (!isRecord(reference) || Object.keys(reference).some(key => !['tenantId', 'ownerId'].includes(key))
        || typeof reference.tenantId !== 'string' || !reference.tenantId || typeof reference.ownerId !== 'string' || !reference.ownerId) {
        throw new SemanticModelError('Ungültige Auftragsidentität.', 403);
      }
      const resolved = await options.resolvePrincipal({ userId: reference.ownerId, tenantId: reference.tenantId });
      if (!resolved || resolved.user.id !== reference.ownerId || resolved.tenant.id !== reference.tenantId) throw new SemanticModelError('Die Auftragsberechtigung ist nicht mehr gültig.', 403);
      authorize(resolved, true);
      const state = await store.read();
      const relationship = ownedRelationship(state, reference, uuid(id));
      const from = ownedObject(state, reference, relationship.fromSetId);
      const detail = relationshipDetail(state, reference, relationship.id, { offset: 0, limit: from.rows.length });
      await current(resolved, true);
      return { detail, fromRows: from.rows };
    },
  };
}

export type SemanticModelService = ReturnType<typeof createSemanticModelService>;
