import type { ImportRow } from '../import-capability/isolated-executor.js';
import type { ObjectRow, ObjectSet, RelationshipRow, SemanticPrincipal, SemanticPrimitive } from '../semantic-model/contracts.js';
import { objectDetail, objectKeyIndex, objectRowAt, relationshipClassifier } from '../semantic-model/service.js';
import { SEMANTIC_LIMITS, semanticHash, type SemanticState, type StoredObjectSet } from '../semantic-model/store.js';
import type {
  ObjectFamily, ObjectHistoryEntry, ObjectLinkPage, ObjectPage, ObjectPresence, ObjectQuery,
  ObjectRelationshipSummary, WorkspaceObject, WorkspaceObjectDetail,
} from './contracts.js';
import { ObjectWorkspaceError } from './contracts.js';

/**
 * The object id is a stable address inside one object family.  The field name
 * is part of the address deliberately: changing the confirmed key field must
 * never silently attach an old object to a new column.
 */
export function objectReference(set: ObjectSet, key: SemanticPrimitive): string {
  return semanticHash(['object-reference-v1', set.tenantId, set.ownerId, set.familyId, set.keyField, key]);
}

type Stored = StoredObjectSet;
type Principal = SemanticPrincipal;
type PrimitiveOrNull = SemanticPrimitive | null;

const has = (row: ImportRow, field: string): boolean => Object.hasOwn(row, field);
const cell = (row: ImportRow, field: string): ImportRow[string] | undefined => has(row, field) ? row[field] : undefined;

// This is the same missing-key contract used by the semantic model. Empty
// strings are missing keys, while empty strings in ordinary properties remain
// ordinary strings for filtering and sorting.
function keyValue(value: PrimitiveOrNull | undefined): SemanticPrimitive | null {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '') ? null : value;
}
function keyToken(value: SemanticPrimitive): string { return JSON.stringify(value); }
function clone<T>(value: T): T { return structuredClone(value); }
function notFound(message: string): never { throw new ObjectWorkspaceError(message, 404); }
function bad(message: string): never { throw new ObjectWorkspaceError(message, 400); }

function ownedSet(state: SemanticState, principal: Principal, id: string): Stored {
  const stored = Object.hasOwn(state.objectSets, id) ? state.objectSets[id] : undefined;
  if (!stored || stored.objectSet.tenantId !== principal.tenantId || stored.objectSet.ownerId !== principal.ownerId) {
    return notFound('Objektmodell nicht gefunden.');
  }
  return stored;
}

function ownedRelationship(state: SemanticState, principal: Principal, id: string) {
  const stored = Object.hasOwn(state.relationships, id) ? state.relationships[id] : undefined;
  if (!stored || stored.relationship.tenantId !== principal.tenantId || stored.relationship.ownerId !== principal.ownerId) {
    return notFound('Beziehung nicht gefunden.');
  }
  return stored.relationship;
}

function familySets(state: SemanticState, principal: Principal, familyId: string): Stored[] {
  const sets = Object.values(state.objectSets).filter(entry => entry.objectSet.familyId === familyId
    && entry.objectSet.tenantId === principal.tenantId && entry.objectSet.ownerId === principal.ownerId);
  if (sets.length === 0) return notFound('Objektfamilie nicht gefunden.');
  return sets.sort((a, b) => b.objectSet.revision - a.objectSet.revision || b.objectSet.id.localeCompare(a.objectSet.id));
}

function selectedSet(state: SemanticState, principal: Principal, familyId: string, setId?: string): Stored {
  const sets = familySets(state, principal, familyId);
  if (setId !== undefined) {
    const selected = sets.find(entry => entry.objectSet.id === setId);
    if (!selected) return notFound('Objektmodell nicht gefunden.');
    return selected;
  }
  return sets[0]!;
}

function fields(stored: Stored): Set<string> { return new Set(stored.objectSet.source.columns); }

function withObjectId(stored: Stored, row: ObjectRow): WorkspaceObject {
  return { ...clone(row), objectId: row.key === null ? null : objectReference(stored.objectSet, row.key) };
}

// Indexes belong to one immutable read, so authority or source changes cannot
// reuse cached data. Only requested output rows become WorkspaceObjects.
function projectionContext() {
  const indexes = new Map<Stored, ReturnType<typeof objectKeyIndex>>();
  const matches = new Map<Stored, Map<string, number[]>>();
  const selections = new Map<string, RelationSelection>();
  const index = (stored: Stored) => {
    let value = indexes.get(stored);
    if (!value) { value = objectKeyIndex(stored); indexes.set(stored, value); }
    return value;
  };
  const positions = (stored: Stored, field: string, key: SemanticPrimitive) => {
    let fields = matches.get(stored);
    if (!fields) { fields = new Map(); matches.set(stored, fields); }
    const token = JSON.stringify([field, key]);
    let rows = fields.get(token);
    if (!rows) {
      rows = [];
      stored.rows.forEach((row, offset) => { if (samePrimitive(keyValue(cell(row, field)), key)) rows!.push(offset + 1); });
      fields.set(token, rows);
    }
    return rows;
  };
  return { index, positions, selections,
    object: (stored: Stored, sourceRow: number) => withObjectId(stored, objectRowAt(stored, sourceRow, index(stored))) };
}
type ProjectionContext = ReturnType<typeof projectionContext>;
const statusOrder: RelationshipRow['status'][] = ['invalid_source_key', 'missing_reference', 'ambiguous_reference', 'unmatched_reference', 'linked'];
interface RelationSelection {
  from: Stored; to: Stored; classify: ReturnType<typeof relationshipClassifier>;
  positions: number[]; totalRows: number; linkedRows: number;
}
function relationSelection(context: ProjectionContext, from: Stored, to: Stored, fromField: string,
  direction: 'outgoing' | 'incoming', key: SemanticPrimitive): RelationSelection {
  const cacheKey = JSON.stringify([from.objectSet.id, to.objectSet.id, fromField, direction, key]);
  const cached = context.selections.get(cacheKey);
  if (cached) return cached;
  const classify = relationshipClassifier(from, to, fromField, context.index(from), context.index(to));
  const matching = context.positions(from, direction === 'outgoing' ? from.objectSet.keyField : fromField, key);
  const buckets = new Map(statusOrder.map(status => [status, [] as number[]]));
  let totalRows = 0; let linkedRows = 0;
  for (const sourceRow of matching) {
    const result = classify(from.rows[sourceRow - 1]!);
    buckets.get(result.status)!.push(sourceRow);
    totalRows += direction === 'outgoing' && result.status === 'ambiguous_reference' ? result.target!.count : 1;
    if (result.status === 'linked') linkedRows++;
  }
  const result = { from, to, classify, positions: statusOrder.flatMap(status => buckets.get(status)!), totalRows, linkedRows };
  context.selections.set(cacheKey, result);
  return result;
}

function samePrimitive(a: SemanticPrimitive | null, b: SemanticPrimitive | null): boolean {
  return a === null || b === null ? a === b : typeof a === typeof b && a === b;
}

function revisionsForObject(storeds: Stored[], objectId: string): { key: SemanticPrimitive; keyField: string } | null {
  const matches = new Map<string, { key: SemanticPrimitive; keyField: string }>();
  for (const stored of storeds) {
    const field = stored.objectSet.keyField;
    for (const row of stored.rows) {
      const key = keyValue(cell(row, field));
      if (key !== null && objectReference(stored.objectSet, key) === objectId) {
        const token = `${field}\u0000${keyToken(key)}`;
        matches.set(token, { key, keyField: field });
      }
    }
  }
  // A valid objectReference has one field/key pair. Keeping this as a map
  // avoids selecting a first row when a revision contains duplicates.
  return matches.size === 1 ? [...matches.values()][0]! : null;
}

function matchRows(stored: Stored, keyField: string, key: SemanticPrimitive): number[] {
  if (stored.objectSet.keyField !== keyField) return [];
  const rows: number[] = [];
  stored.rows.forEach((row, index) => { if (samePrimitive(keyValue(cell(row, keyField)), key)) rows.push(index + 1); });
  return rows;
}

function presence(totalMatches: number, keyChanged: boolean): ObjectPresence {
  if (keyChanged) return 'key_changed';
  if (totalMatches === 0) return 'absent';
  if (totalMatches === 1) return 'present';
  return 'ambiguous';
}

function historyEntry(stored: Stored, original: { key: SemanticPrimitive; keyField: string }): ObjectHistoryEntry {
  const keyChanged = stored.objectSet.keyField !== original.keyField;
  const rows = keyChanged ? [] : matchRows(stored, original.keyField, original.key);
  const state = presence(rows.length, keyChanged);
  return {
    objectSetId: stored.objectSet.id,
    revision: stored.objectSet.revision,
    keyField: stored.objectSet.keyField,
    state,
    sourceRows: rows.slice(0, SEMANTIC_LIMITS.maxTargetExamples),
    totalMatches: rows.length,
  };
}

function relationshipSummaries(state: SemanticState, principal: Principal, selected: Stored, stateOfObject: ObjectPresence, key: SemanticPrimitive, context: ProjectionContext): ObjectRelationshipSummary[] {
  if (stateOfObject === 'absent' || stateOfObject === 'key_changed') return [];
  const summaries: ObjectRelationshipSummary[] = [];
  for (const entry of Object.values(state.relationships)) {
    const relationship = entry.relationship;
    if (relationship.tenantId !== principal.tenantId || relationship.ownerId !== principal.ownerId) continue;
    const directions: Array<'outgoing' | 'incoming'> = [];
    if (relationship.fromSetId === selected.objectSet.id) directions.push('outgoing');
    if (relationship.toSetId === selected.objectSet.id) directions.push('incoming');
    for (const direction of directions) {
      // A relationship is only readable when both endpoints are readable
      // under the same principal. This prevents a foreign counterpart
      // leaking through a relation owned by the caller.
      const other = ownedSet(state, principal, direction === 'outgoing' ? relationship.toSetId : relationship.fromSetId);
      const counts = relationSelection(context, direction === 'outgoing' ? selected : other,
        direction === 'outgoing' ? other : selected, relationship.fromField, direction, key);
      summaries.push({ relationship: clone(relationship), direction, otherSet: clone(other.objectSet),
        totalRows: counts.totalRows, linkedRows: counts.linkedRows });
    }
  }
  return summaries.sort((a, b) => a.relationship.name.localeCompare(b.relationship.name) || a.relationship.id.localeCompare(b.relationship.id)
    || a.direction.localeCompare(b.direction));
}

export function listFamilies(state: SemanticState, principal: Principal): ObjectFamily[] {
  const groups = new Map<string, Stored[]>();
  for (const stored of Object.values(state.objectSets)) {
    if (stored.objectSet.tenantId !== principal.tenantId || stored.objectSet.ownerId !== principal.ownerId) continue;
    const group = groups.get(stored.objectSet.familyId) ?? [];
    group.push(stored); groups.set(stored.objectSet.familyId, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, entries]) => {
    const revisions = entries.sort((a, b) => b.objectSet.revision - a.objectSet.revision || b.objectSet.id.localeCompare(a.objectSet.id));
    return { id: revisions[0]!.objectSet.familyId, name: revisions[0]!.objectSet.name,
      latest: clone(revisions[0]!.objectSet), revisions: revisions.map(entry => clone(entry.objectSet)) };
  });
}

function validateQuery(stored: Stored, query: ObjectQuery): Required<Pick<ObjectQuery, 'offset' | 'limit' | 'sortDir'>> & ObjectQuery {
  const offset = query.offset ?? 0;
  const limit = query.limit ?? SEMANTIC_LIMITS.maxPageRows;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > SEMANTIC_LIMITS.maxPageRows) {
    return bad('Ungültige Seitenangaben.');
  }
  const sortDir = query.sortDir ?? 'asc';
  if (sortDir !== 'asc' && sortDir !== 'desc') return bad('Ungültige Sortierrichtung.');
  const sourceFields = fields(stored);
  if (query.filterField !== undefined && !sourceFields.has(query.filterField)) return bad('Unbekanntes Filterfeld.');
  if (query.sortBy !== undefined && !sourceFields.has(query.sortBy)) return bad('Unbekanntes Sortierfeld.');
  if (query.identity !== undefined && !['unique', 'missing', 'duplicate'].includes(query.identity)) return bad('Ungültige Objektidentität.');
  return { ...query, offset, limit, sortDir };
}

function orderValue(value: ImportRow[string] | undefined): { rank: number; value: ImportRow[string] | null } {
  if (value === undefined || value === null) return { rank: 0, value: null };
  if (typeof value === 'boolean') return { rank: 1, value };
  if (typeof value === 'number') return { rank: 2, value };
  return { rank: 3, value };
}

function compareValues(a: ImportRow[string] | undefined, b: ImportRow[string] | undefined): number {
  const left = orderValue(a); const right = orderValue(b);
  if (left.rank !== right.rank) return left.rank - right.rank;
  if (left.value === right.value) return 0;
  if (left.value === null) return -1;
  if (right.value === null) return 1;
  if (typeof left.value === 'boolean' && typeof right.value === 'boolean') return Number(left.value) - Number(right.value);
  if (typeof left.value === 'number' && typeof right.value === 'number') return left.value < right.value ? -1 : 1;
  const l = String(left.value); const r = String(right.value);
  return l < r ? -1 : l > r ? 1 : 0;
}

function rowSearch(row: ObjectRow, query: string): boolean {
  const needle = query.toLocaleLowerCase();
  if (!needle) return true;
  return Object.values(row.attributes).some(value => String(value).toLocaleLowerCase().includes(needle));
}

export function listObjects(state: SemanticState, principal: Principal, familyId: string, query: ObjectQuery): ObjectPage {
  const stored = selectedSet(state, principal, familyId, query.setId);
  const normalized = validateQuery(stored, query);
  const detail = objectDetail(stored, { offset: 0, limit: stored.rows.length || 1 });
  let rows = detail.rows.filter(row => {
    if (normalized.q !== undefined && !rowSearch(row, normalized.q)) return false;
    if (normalized.identity !== undefined && row.identity !== normalized.identity) return false;
    if (normalized.filterField !== undefined) {
      const actual = cell(row.attributes, normalized.filterField);
      const wanted = normalized.filterValue ?? null;
      if (!samePrimitive(actual === undefined ? null : actual, wanted)) return false;
    }
    return true;
  });
  const sortBy = normalized.sortBy;
  rows = rows.slice().sort((a, b) => {
    const result = sortBy === undefined ? a.sourceRow - b.sourceRow : compareValues(cell(a.attributes, sortBy), cell(b.attributes, sortBy));
    return (normalized.sortDir === 'desc' ? -result : result) || a.sourceRow - b.sourceRow;
  });
  return {
    objectSet: clone(detail.objectSet),
    items: rows.slice(normalized.offset, normalized.offset + normalized.limit).map(row => withObjectId(stored, row)),
    offset: normalized.offset,
    limit: normalized.limit,
    totalRows: rows.length,
    totalSourceRows: detail.totalRows,
  };
}

export function getObject(state: SemanticState, principal: Principal, familyId: string, objectId: string, setId?: string): WorkspaceObjectDetail {
  const revisions = familySets(state, principal, familyId);
  const original = revisionsForObject(revisions, objectId);
  if (!original) return notFound('Objekt nicht gefunden.');
  const selected = selectedSet(state, principal, familyId, setId);
  const selectedRows = matchRows(selected, original.keyField, original.key);
  const selectedState = presence(selectedRows.length, selected.objectSet.keyField !== original.keyField);
  const context = projectionContext();
  const candidates = selectedRows.slice(0, SEMANTIC_LIMITS.maxTargetExamples).map(row => context.object(selected, row));
  const object = selectedState === 'present' ? context.object(selected, selectedRows[0]!) : null;
  return {
    objectId,
    key: clone(original.key),
    keyField: original.keyField,
    state: selectedState,
    objectSet: clone(selected.objectSet),
    object,
    candidates,
    candidateCount: selectedRows.length,
    history: revisions.map(stored => historyEntry(stored, original)),
    relationships: relationshipSummaries(state, principal, selected, selectedState, original.key, context),
  };
}

function emptyLinks(relationship: ObjectLinkPage['relationship'], direction: 'outgoing' | 'incoming', selected: Stored, other: Stored,
  page: { offset: number; limit: number }): ObjectLinkPage {
  return { relationship: clone(relationship), direction, objectSet: clone(selected.objectSet), otherSet: clone(other.objectSet),
    items: [], offset: page.offset, limit: page.limit, totalRows: 0 };
}

function validatePage(page: { offset: number; limit: number }): void {
  if (!Number.isSafeInteger(page.offset) || page.offset < 0 || !Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > SEMANTIC_LIMITS.maxPageRows) {
    bad('Ungültige Seitenangaben.');
  }
}

export function getObjectLinks(state: SemanticState, principal: Principal, familyId: string, objectId: string, relationshipId: string,
  page: { setId?: string; direction?: 'outgoing' | 'incoming'; offset: number; limit: number }): ObjectLinkPage {
  validatePage(page);
  const selected = selectedSet(state, principal, familyId, page.setId);
  const revisions = familySets(state, principal, familyId);
  const original = revisionsForObject(revisions, objectId);
  if (!original) return notFound('Objekt nicht gefunden.');
  const relationship = ownedRelationship(state, principal, relationshipId);
  let direction: 'outgoing' | 'incoming';
  let otherId: string;
  if (page.direction === 'incoming') {
    if (relationship.toSetId !== selected.objectSet.id) return notFound('Beziehung nicht gefunden.');
    direction = 'incoming'; otherId = relationship.fromSetId;
  } else if (page.direction === 'outgoing') {
    if (relationship.fromSetId !== selected.objectSet.id) return notFound('Beziehung nicht gefunden.');
    direction = 'outgoing'; otherId = relationship.toSetId;
  } else if (relationship.fromSetId === selected.objectSet.id) { direction = 'outgoing'; otherId = relationship.toSetId;
  } else if (relationship.toSetId === selected.objectSet.id) { direction = 'incoming'; otherId = relationship.fromSetId;
  } else return notFound('Beziehung nicht gefunden.');
  const other = ownedSet(state, principal, otherId);
  // The object address was found in history, but links are available only when
  // this revision still uses that key field and has at least one matching key.
  const selectedRows = matchRows(selected, original.keyField, original.key);
  if (selected.objectSet.keyField !== original.keyField || selectedRows.length === 0) {
    return emptyLinks(relationship, direction, selected, other, page);
  }
  const context = projectionContext();
  const from = direction === 'outgoing' ? selected : other;
  const to = direction === 'outgoing' ? other : selected;
  const selection = relationSelection(context, from, to, relationship.fromField, direction, original.key);
  const items: ObjectLinkPage['items'] = [];
  if (direction === 'incoming') {
    for (const sourceRow of selection.positions.slice(page.offset, page.offset + page.limit)) {
      const row = selection.classify(from.rows[sourceRow - 1]!);
      items.push({ status: row.status, sourceRow, reference: row.reference, object: context.object(from, sourceRow) });
    }
  } else {
    let position = 0;
    for (const sourceRow of selection.positions) {
      const row = selection.classify(from.rows[sourceRow - 1]!);
      const expanded = row.status === 'linked' || row.status === 'ambiguous_reference';
      const count = expanded ? row.target!.count : 1;
      const end = position + count;
      if (end > page.offset && position < page.offset + page.limit) {
        if (expanded) {
          const targets = context.positions(to, to.objectSet.keyField, row.reference!);
          for (const targetRow of targets.slice(Math.max(0, page.offset - position), Math.min(count, page.offset + page.limit - position))) {
            items.push({ status: row.status, sourceRow, reference: row.reference, object: context.object(to, targetRow) });
          }
        } else items.push({ status: row.status, sourceRow, reference: row.reference, object: null });
      }
      position = end;
      if (position >= page.offset + page.limit) break;
    }
  }
  return { relationship: clone(relationship), direction, objectSet: clone(selected.objectSet), otherSet: clone(other.objectSet),
    items, offset: page.offset, limit: page.limit, totalRows: selection.totalRows };
}
