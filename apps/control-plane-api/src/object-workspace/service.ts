import type { SessionContext } from '@koiforge/security-core';
import { FileSemanticModelStore, safeField, SEMANTIC_UUID, type SemanticState } from '../semantic-model/store.js';
import type { SemanticPrincipal } from '../semantic-model/contracts.js';
import { ObjectWorkspaceError, type ObjectQuery } from './contracts.js';
import * as projection from './projection.js';
import { ProjectError } from '../projects/contracts.js';
import type { ProjectService } from '../projects/service.js';

export interface ObjectWorkspaceOptions {
  root: string;
  resolvePrincipal: (reference: { userId: string; tenantId: string }) => Promise<SessionContext | null>;
  assertPermissions: (session: SessionContext, permissions: string[]) => void;
  projects?: Pick<ProjectService, 'resolveAccess' | 'assertAccess'>;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !SEMANTIC_UUID.test(value.toLowerCase())) throw new ObjectWorkspaceError('Ungültige Modell- oder Beziehungs-ID.');
  return value.toLowerCase();
}
function objectId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new ObjectWorkspaceError('Ungültige Objekt-ID.');
  return value;
}
function queryRecord(raw: unknown, allowed: string[]): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.entries(raw).some(([key, value]) => !allowed.includes(key) || typeof value !== 'string')) {
    throw new ObjectWorkspaceError('Ungültige oder mehrfach angegebene Suchparameter.');
  }
  // Fastify's parser uses its own prototype. Copy only checked own entries so
  // inherited properties can never become a filter or selected revision.
  return Object.fromEntries(Object.entries(raw)) as Record<string, string>;
}
function integer(value: string | undefined, fallback: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new ObjectWorkspaceError('offset muss nichtnegativ sein; limit muss zwischen 1 und 100 liegen.');
  }
  return number;
}
function page(query: Record<string, string>) {
  return { ...(query.setId !== undefined ? { setId: uuid(query.setId) } : {}),
    offset: integer(query.offset, 0, 0), limit: integer(query.limit, 25, 1, 100) };
}
function objectQuery(raw: unknown): ObjectQuery {
  const query = queryRecord(raw, ['setId', 'q', 'identity', 'filterField', 'filterValue', 'sortBy', 'sortDir', 'offset', 'limit']);
  if (query.q !== undefined && query.q.length > 200) throw new ObjectWorkspaceError('Die Suche darf höchstens 200 Zeichen enthalten.');
  if (query.identity !== undefined && !['unique', 'missing', 'duplicate'].includes(query.identity)) throw new ObjectWorkspaceError('Ungültiger ID-Status.');
  if (query.sortDir !== undefined && !['asc', 'desc'].includes(query.sortDir)) throw new ObjectWorkspaceError('Ungültige Sortierrichtung.');
  if ((query.filterField !== undefined) !== (query.filterValue !== undefined)) throw new ObjectWorkspaceError('Filterfeld und Filterwert müssen zusammen angegeben werden.');
  for (const name of ['filterField', 'sortBy'] as const) {
    if (query[name] !== undefined && !safeField(query[name])) throw new ObjectWorkspaceError('Ungültiges Attribut.');
  }
  let filterValue: ObjectQuery['filterValue'];
  if (query.filterValue !== undefined) {
    try { filterValue = JSON.parse(query.filterValue); } catch { throw new ObjectWorkspaceError('Ungültiger Filterwert.'); }
    if (!(filterValue === null || typeof filterValue === 'string' || typeof filterValue === 'boolean'
      || (typeof filterValue === 'number' && Number.isFinite(filterValue)))) throw new ObjectWorkspaceError('Der Filterwert muss Text, Zahl, Wahrheitswert oder null sein.');
  }
  return { ...page(query), q: query.q, identity: query.identity as ObjectQuery['identity'],
    ...(query.filterField !== undefined ? { filterField: query.filterField, filterValue } : {}),
    sortBy: query.sortBy, sortDir: query.sortDir as ObjectQuery['sortDir'] ?? 'asc' };
}

export function createObjectWorkspaceService(options: ObjectWorkspaceOptions) {
  const store = new FileSemanticModelStore(options.root);
  function authorize(session: SessionContext, scoped = false): void {
    if (!session?.user?.id || !session?.tenant?.id) throw new ObjectWorkspaceError('Bitte anmelden.', 401);
    if (session.tenant.status !== 'active') throw new ObjectWorkspaceError('Der Arbeitsbereich ist nicht aktiv.', 403);
    if (!scoped && session.roleIds.includes('project_reader')) throw new ObjectWorkspaceError('Bitte ein freigegebenes Projekt auswählen.', 403);
    try { options.assertPermissions(session, scoped ? ['projects.read', 'objects.read'] : ['datasets.read']); }
    catch { throw new ObjectWorkspaceError('Keine Berechtigung für diese Objekte.', 403); }
  }
  async function current(session: SessionContext, scoped = false): Promise<void> {
    authorize(session, scoped);
    const live = await options.resolvePrincipal({ userId: session.user.id, tenantId: session.tenant.id });
    if (!live || live.user.id !== session.user.id || live.tenant.id !== session.tenant.id) throw new ObjectWorkspaceError('Die Objektberechtigung ist nicht mehr gültig.', 403);
    authorize(live, scoped);
  }
  async function read<T>(session: SessionContext, raw: unknown, project: (state: SemanticState, principal: SemanticPrincipal, query: unknown) => T): Promise<T> {
    try {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ObjectWorkspaceError('Ungültige Suchparameter.');
      const query = Object.fromEntries(Object.entries(raw));
      const projectId = Object.hasOwn(query, 'projectId') ? uuid(query.projectId) : undefined;
      delete query.projectId;
      await current(session, projectId !== undefined);
      if (projectId && !options.projects) throw new ObjectWorkspaceError('Dieses Projekt ist nicht verfügbar.', 404);
      const access = projectId ? await options.projects!.resolveAccess(session, projectId) : undefined;
      const principal = access?.principal ?? { tenantId: session.tenant.id, ownerId: session.user.id };
      // Filter the single validated snapshot BEFORE any counters, history or links are projected.
      let state = await store.read();
      if (access) {
        const allowed = new Set(access.familyIds);
        const objectSets = Object.fromEntries(Object.entries(state.objectSets).filter(([, { objectSet: s }]) =>
          s.tenantId === principal.tenantId && s.ownerId === principal.ownerId && allowed.has(s.familyId)));
        const relationships = Object.fromEntries(Object.entries(state.relationships).filter(([, { relationship: r }]) =>
          r.tenantId === principal.tenantId && r.ownerId === principal.ownerId && Object.hasOwn(objectSets, r.fromSetId) && Object.hasOwn(objectSets, r.toSetId)));
        state = { objectSets, relationships, requests: {} };
      }
      const result = project(state, principal, query);
      await current(session, projectId !== undefined);
      if (access) await options.projects!.assertAccess(session, projectId!, access.revision);
      return result;
    } catch (error) {
      if (error instanceof ProjectError) throw new ObjectWorkspaceError(error.message, error.statusCode);
      throw error;
    }
  }
  return {
    listFamilies(session: SessionContext, raw: unknown = {}) {
      return read(session, raw, (state, principal, query) => { queryRecord(query, []); return projection.listFamilies(state, principal); });
    },
    listObjects(session: SessionContext, familyId: string, raw: unknown = {}) {
      return read(session, raw, (state, principal, query) => projection.listObjects(state, principal, uuid(familyId), objectQuery(query)));
    },
    getObject(session: SessionContext, familyId: string, id: string, raw: unknown = {}) {
      return read(session, raw, (state, principal, scopedQuery) => {
        const query = queryRecord(scopedQuery, ['setId']);
        return projection.getObject(state, principal, uuid(familyId), objectId(id), query.setId === undefined ? undefined : uuid(query.setId));
      });
    },
    getObjectLinks(session: SessionContext, familyId: string, id: string, relationshipId: string, raw: unknown = {}) {
      return read(session, raw, (state, principal, scopedQuery) => {
        const query = queryRecord(scopedQuery, ['setId', 'offset', 'limit', 'direction']);
        if (query.direction !== undefined && !['incoming', 'outgoing'].includes(query.direction)) throw new ObjectWorkspaceError('Ungültige Beziehungsrichtung.');
        return projection.getObjectLinks(state, principal, uuid(familyId), objectId(id), uuid(relationshipId),
          { ...page(query), direction: query.direction as 'incoming' | 'outgoing' | undefined });
      });
    },
  };
}
export type ObjectWorkspaceService = ReturnType<typeof createObjectWorkspaceService>;
