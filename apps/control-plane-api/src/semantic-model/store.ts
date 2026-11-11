import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { rowsHash, validateRows, type ImportRow } from '../import-capability/isolated-executor.js';
import type { ObjectSet, Relationship } from './contracts.js';

export interface FrozenField { name: string; type: string; nullable?: boolean }
export interface StoredObjectSet { objectSet: ObjectSet; rows: ImportRow[]; schema: FrozenField[]; confirmed: true }
export interface StoredRelationship { relationship: Relationship; confirmed: true }
export interface SemanticReceipt {
  tenantId: string;
  ownerId: string;
  operation: 'object-set' | 'relationship';
  requestId: string;
  payloadHash: string;
  entityId: string;
}
export interface SemanticState {
  objectSets: Record<string, StoredObjectSet>;
  relationships: Record<string, StoredRelationship>;
  requests: Record<string, SemanticReceipt>;
}

export const SEMANTIC_LIMITS = Object.freeze({ maxStateBytes: 64 * 1024 * 1024, maxEntities: 1000, maxPageRows: 100, maxTargetExamples: 20 });
export const SEMANTIC_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const queues = new Map<string, Promise<void>>();
export const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const keys = (value: Record<string, unknown>, expected: string[], optional: string[] = []) =>
  expected.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => expected.includes(key) || optional.includes(key));
const text = (value: unknown, max = 200) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const integer = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const instant = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
export const safeField = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
  && value.length <= 4096 && !['__proto__', 'constructor', 'prototype'].includes(value);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function semanticHash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function snapshotHash(objectSet: Pick<ObjectSet, 'source' | 'keyField' | 'labelField'>, schema: FrozenField[]): string {
  return semanticHash({ datasetId: objectSet.source.datasetId, rowsHash: objectSet.source.hash,
    columns: objectSet.source.columns, schema, keyField: objectSet.keyField, labelField: objectSet.labelField ?? null });
}
export function receiptKey(receipt: Pick<SemanticReceipt, 'tenantId' | 'ownerId' | 'operation' | 'requestId'>): string {
  return semanticHash([receipt.tenantId, receipt.ownerId, receipt.operation, receipt.requestId]);
}
function damaged(): never { throw new Error('Die Fachmodellablage ist beschädigt. Bestehende Daten wurden nicht verändert.'); }

function validateObjectSet(id: string, entry: unknown): asserts entry is StoredObjectSet {
  if (!isRecord(entry) || !keys(entry, ['objectSet', 'rows', 'schema', 'confirmed']) || entry.confirmed !== true
    || !isRecord(entry.objectSet) || !Array.isArray(entry.schema)) damaged();
  const set = entry.objectSet;
  if (!keys(set, ['id', 'familyId', 'revision', 'tenantId', 'ownerId', 'name', 'keyField', 'source', 'snapshotHash', 'createdAt', 'confirmedBy', 'keyQuality'], ['previousId', 'labelField'])
    || set.id !== id || !SEMANTIC_UUID.test(id) || typeof set.familyId !== 'string' || !SEMANTIC_UUID.test(set.familyId)
    || !integer(set.revision) || (set.revision as number) < 1
    || (set.previousId !== undefined && (typeof set.previousId !== 'string' || !SEMANTIC_UUID.test(set.previousId)))
    || !text(set.tenantId) || !text(set.ownerId) || !text(set.name) || !safeField(set.keyField)
    || (set.labelField !== undefined && !safeField(set.labelField)) || !instant(set.createdAt)
    || set.confirmedBy !== set.ownerId || !isRecord(set.source) || !isRecord(set.keyQuality)) damaged();
  const source = set.source;
  if (!keys(source, ['datasetId', 'name', 'columns', 'rowCount', 'hash', 'capturedAt', 'coverage'])
    || !text(source.datasetId) || !text(source.name) || !Array.isArray(source.columns)
    || source.columns.length > 512 || !source.columns.every(safeField) || new Set(source.columns).size !== source.columns.length
    || !integer(source.rowCount) || source.coverage !== 'complete' || !instant(source.capturedAt)
    || typeof source.hash !== 'string' || !digest.test(source.hash)
    || !source.columns.includes(set.keyField) || (set.labelField !== undefined && !source.columns.includes(set.labelField))) damaged();
  const columns = source.columns;
  const fieldTypes = ['string', 'number', 'integer', 'boolean', 'date', 'datetime', 'json'];
  if (entry.schema.length !== columns.length || !entry.schema.every((field, index) => isRecord(field)
    && keys(field, ['name', 'type'], ['nullable']) && field.name === columns[index]
    && typeof field.type === 'string' && fieldTypes.includes(field.type)
    && (field.nullable === undefined || typeof field.nullable === 'boolean'))) damaged();
  const rows = validateRows(entry.rows);
  if (rows.length !== source.rowCount || rowsHash(rows) !== source.hash
    || rows.some(row => Object.keys(row).some(key => !columns.includes(key)))
    || typeof set.snapshotHash !== 'string' || set.snapshotHash !== snapshotHash(set as unknown as ObjectSet, entry.schema as FrozenField[])) damaged();
  const quality = set.keyQuality;
  if (!keys(quality, ['totalRows', 'identifiedRows', 'missingKeys', 'duplicateRows', 'duplicateGroups'])
    || !Object.values(quality).every(integer) || quality.totalRows !== rows.length
    || Number(quality.identifiedRows) + Number(quality.missingKeys) + Number(quality.duplicateRows) !== rows.length
    || Number(quality.duplicateGroups) * 2 > Number(quality.duplicateRows)
    || (quality.duplicateRows === 0) !== (quality.duplicateGroups === 0)) damaged();
}

function validateState(value: unknown): SemanticState {
  if (!isRecord(value) || !keys(value, ['objectSets', 'relationships', 'requests'])
    || !isRecord(value.objectSets) || !isRecord(value.relationships) || !isRecord(value.requests)) damaged();
  const state = value as unknown as SemanticState;
  const entities = Object.keys(state.objectSets).length + Object.keys(state.relationships).length;
  if (entities > SEMANTIC_LIMITS.maxEntities || Object.keys(state.requests).length !== entities) damaged();
  const revisions = new Set<string>();
  for (const [id, entry] of Object.entries(state.objectSets)) {
    validateObjectSet(id, entry);
    const set = entry.objectSet;
    const revisionKey = `${set.familyId}:${set.revision}`;
    if (revisions.has(revisionKey)) damaged();
    revisions.add(revisionKey);
    if (!set.previousId) { if (set.id !== set.familyId || set.revision !== 1) damaged(); }
    else {
      const previous = Object.hasOwn(state.objectSets, set.previousId) ? state.objectSets[set.previousId]?.objectSet : undefined;
      if (!previous || previous.familyId !== set.familyId || previous.revision + 1 !== set.revision
        || previous.tenantId !== set.tenantId || previous.ownerId !== set.ownerId) damaged();
    }
  }
  for (const [id, entry] of Object.entries(state.relationships)) {
    if (!isRecord(entry) || !keys(entry, ['relationship', 'confirmed']) || entry.confirmed !== true || !isRecord(entry.relationship)) damaged();
    const relation = entry.relationship;
    if (!keys(relation, ['id', 'tenantId', 'ownerId', 'name', 'fromSetId', 'toSetId', 'fromField', 'createdAt', 'confirmedBy', 'cardinality', 'contractVersion', 'counts', 'evidence'])
      || relation.id !== id || !SEMANTIC_UUID.test(id) || !text(relation.name) || !text(relation.tenantId) || !text(relation.ownerId)
      || !instant(relation.createdAt) || relation.confirmedBy !== relation.ownerId || relation.cardinality !== 'many-to-one'
      || relation.contractVersion !== 'relationship-v1' || typeof relation.fromSetId !== 'string' || !SEMANTIC_UUID.test(relation.fromSetId)
      || typeof relation.toSetId !== 'string' || !SEMANTIC_UUID.test(relation.toSetId) || !safeField(relation.fromField)
      || !isRecord(relation.counts) || !isRecord(relation.evidence)) damaged();
    const from = state.objectSets[relation.fromSetId]?.objectSet;
    const to = state.objectSets[relation.toSetId]?.objectSet;
    if (!from || !to || from.tenantId !== relation.tenantId || to.tenantId !== relation.tenantId
      || from.ownerId !== relation.ownerId || to.ownerId !== relation.ownerId || !from.source.columns.includes(relation.fromField)) damaged();
    const counts = relation.counts;
    if (!keys(counts, ['sourceRows', 'linkedRows', 'missingReferences', 'unmatchedReferences', 'ambiguousReferences', 'invalidSourceRows'])
      || !Object.values(counts).every(integer) || counts.sourceRows !== from.source.rowCount
      || counts.linkedRows + counts.missingReferences + counts.unmatchedReferences + counts.ambiguousReferences + counts.invalidSourceRows !== counts.sourceRows
      || counts.invalidSourceRows !== from.keyQuality.missingKeys + from.keyQuality.duplicateRows) damaged();
    const evidence = relation.evidence;
    if (!keys(evidence, ['sourceHash', 'targetHash', 'fromRevision', 'toRevision'])
      || evidence.sourceHash !== from.source.hash || evidence.targetHash !== to.source.hash
      || evidence.fromRevision !== from.revision || evidence.toRevision !== to.revision) damaged();
  }
  const receipted = new Set<string>();
  for (const [key, receipt] of Object.entries(state.requests)) {
    if (!isRecord(receipt) || !keys(receipt, ['tenantId', 'ownerId', 'operation', 'requestId', 'payloadHash', 'entityId'])
      || !text(receipt.tenantId) || !text(receipt.ownerId) || !['object-set', 'relationship'].includes(receipt.operation)
      || typeof receipt.requestId !== 'string' || !SEMANTIC_UUID.test(receipt.requestId)
      || typeof receipt.entityId !== 'string' || !SEMANTIC_UUID.test(receipt.entityId)
      || typeof receipt.payloadHash !== 'string' || !digest.test(receipt.payloadHash) || key !== receiptKey(receipt)) damaged();
    const entity = receipt.operation === 'object-set' ? state.objectSets[receipt.entityId]?.objectSet : state.relationships[receipt.entityId]?.relationship;
    if (!entity || entity.tenantId !== receipt.tenantId || entity.ownerId !== receipt.ownerId || receipted.has(receipt.entityId)) damaged();
    receipted.add(receipt.entityId);
  }
  return state;
}

function parse(bytes: string): SemanticState {
  const envelope: unknown = JSON.parse(bytes);
  if (!isRecord(envelope) || !keys(envelope, ['version', 'integrityHash', 'state']) || envelope.version !== 1
    || typeof envelope.integrityHash !== 'string' || !digest.test(envelope.integrityHash)
    || envelope.integrityHash !== semanticHash(envelope.state)) damaged();
  return validateState(envelope.state);
}

/** One writing API process. Immutable records and idempotency receipts publish together. */
export class FileSemanticModelStore {
  readonly path: string;
  constructor(root: string) { this.path = resolve(join(root, 'semantic-model', 'state.json')); }
  async read(): Promise<SemanticState> {
    try {
      const metadata = await lstat(this.path);
      if (!metadata.isFile() || metadata.size > SEMANTIC_LIMITS.maxStateBytes) damaged();
      return parse(await readFile(this.path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { objectSets: {}, relationships: {}, requests: {} };
      throw error;
    }
  }
  async update<T>(change: (state: SemanticState) => T | Promise<T>, beforeCommit: () => Promise<void>): Promise<T> {
    const previous = queues.get(this.path) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const state = await this.read();
      const result = await change(state);
      validateState(state);
      const bytes = JSON.stringify({ version: 1, integrityHash: semanticHash(state), state });
      if (Buffer.byteLength(bytes) > SEMANTIC_LIMITS.maxStateBytes) throw new Error('Die Fachmodellablage hat ihre Größenbegrenzung erreicht.');
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        // Re-resolve authority after all source/storage work and directly before publication.
        await beforeCommit();
        await rename(temporary, this.path);
        if (process.platform === 'linux') {
          const directory = await open(dirname(this.path), 'r');
          try { await directory.sync(); } finally { await directory.close(); }
        }
      } finally { await rm(temporary, { force: true }).catch(() => undefined); }
      return structuredClone(result);
    });
    const settled = operation.then(() => undefined, () => undefined);
    queues.set(this.path, settled);
    try { return await operation; }
    finally { if (queues.get(this.path) === settled) queues.delete(this.path); }
  }
}
