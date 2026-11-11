import { randomUUID } from 'node:crypto';
import type { SessionContext } from '@koiforge/security-core';
import { FileSemanticModelStore, isRecord, SEMANTIC_UUID, semanticHash } from '../semantic-model/store.js';
import { ProjectError, type Project, type ProjectAccess, type ProjectDetail, type ProjectSummary } from './contracts.js';
import { FileProjectStore, idList, PROJECT_LIMITS, projectReceiptKey } from './store.js';

export interface ProjectOptions {
  root: string;
  resolvePrincipal: (reference: { userId: string; tenantId: string }) => Promise<SessionContext | null>;
  assertPermissions: (session: SessionContext, permissions: string[]) => void;
  listTeam: (session: SessionContext) => Promise<Array<{ id: string; status: 'invited' | 'active' | 'disabled' }>>;
}
export function projectId(value: unknown): string {
  if (typeof value !== 'string' || !SEMANTIC_UUID.test(value.toLowerCase())) throw new ProjectError('Ungültige Projekt-ID.');
  return value.toLowerCase();
}
function input(raw: unknown, updating: boolean) {
  const allowed = ['name', 'description', 'familyIds', 'memberIds', 'confirmed', 'requestId', ...(updating ? ['revision'] : [])];
  if (!isRecord(raw) || Object.keys(raw).length !== allowed.length || Object.keys(raw).some(k => !allowed.includes(k))
    || typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 120
    || typeof raw.description !== 'string' || raw.description.length > 2000 || raw.confirmed !== true
    || !idList(raw.familyIds, 1000) || !idList(raw.memberIds, 100)
    || typeof raw.requestId !== 'string' || !SEMANTIC_UUID.test(raw.requestId)
    || (updating && (!Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1))) {
    throw new ProjectError('Name, Beschreibung, gültige Familien und Mitglieder sowie die ausdrückliche Bestätigung sind erforderlich.');
  }
  return { name: raw.name.trim(), description: raw.description.trim(), familyIds: [...raw.familyIds].sort(), memberIds: [...raw.memberIds].sort(),
    requestId: raw.requestId, revision: updating ? raw.revision as number : undefined };
}

export function createProjectService(options: ProjectOptions) {
  const store = new FileProjectStore(options.root); const models = new FileSemanticModelStore(options.root);
  function authorize(session: SessionContext, manage = false) {
    if (!session?.user?.id || !session?.tenant?.id) throw new ProjectError('Bitte anmelden.', 401);
    if (session.tenant.status !== 'active') throw new ProjectError('Der Arbeitsbereich ist nicht aktiv.', 403);
    try { options.assertPermissions(session, manage ? ['projects.read', 'projects.manage'] : ['projects.read']); }
    catch { throw new ProjectError('Keine Berechtigung für diese Projekte.', 403); }
    if (manage && !session.roleIds.includes('owner')) throw new ProjectError('Nur der Inhaber kann Projekte freigeben.', 403);
  }
  async function current(session: SessionContext, manage = false): Promise<SessionContext> {
    authorize(session, manage);
    const live = await options.resolvePrincipal({ userId: session.user.id, tenantId: session.tenant.id });
    if (!live || live.user.id !== session.user.id || live.tenant.id !== session.tenant.id) throw new ProjectError('Die Projektberechtigung ist nicht mehr gültig.', 403);
    authorize(live, manage); return live;
  }
  const canSee = (p: Project, s: SessionContext) => p.tenantId === s.tenant.id && (p.ownerId === s.user.id || p.memberIds.includes(s.user.id));
  const manageable = (p: Project, s: SessionContext) => p.ownerId === s.user.id && s.roleIds.includes('owner') && s.permissions.includes('projects.manage');
  function visible(state: Awaited<ReturnType<FileProjectStore['read']>>, s: SessionContext, id: string): Project {
    const p = state.projects[id]; if (!p || !canSee(p, s)) throw new ProjectError('Dieses Projekt ist nicht verfügbar.', 404); return p;
  }
  function summary(p: Project, s: SessionContext): ProjectSummary {
    return { id: p.id, name: p.name, description: p.description, revision: p.revision, updatedAt: p.updatedAt,
      familyCount: p.familyIds.length, memberCount: p.memberIds.length, canManage: manageable(p, s) };
  }
  function detail(p: Project, s: SessionContext): ProjectDetail {
    return { ...summary(p, s), familyIds: [...p.familyIds], ...(manageable(p, s) ? { memberIds: [...p.memberIds], events: structuredClone(p.events) } : {}) };
  }
  async function resolveAccess(session: SessionContext, rawId: string): Promise<ProjectAccess> {
    const live = await current(session); const id = projectId(rawId);
    visible(await store.read(), live, id);
    const final = await current(session);
    const p = visible(await store.read(), final, id);
    return { principal: { tenantId: p.tenantId, ownerId: p.ownerId }, familyIds: [...p.familyIds], revision: p.revision };
  }
  async function assertAccess(session: SessionContext, id: string, revision: number): Promise<void> {
    const live = await current(session); const key = projectId(id);
    visible(await store.read(), live, key);
    const final = await current(session);
    const p = visible(await store.read(), final, key);
    if (p.revision !== revision) throw new ProjectError('Die Projektfreigabe wurde geändert. Bitte neu laden.', 409);
  }
  async function validateGrants(session: SessionContext, families: string[], members: string[], previousMembers: string[]) {
    const state = await models.read();
    const available = new Set(Object.values(state.objectSets).filter(({ objectSet: p }) => p.tenantId === session.tenant.id && p.ownerId === session.user.id)
      .map(({ objectSet }) => objectSet.familyId));
    if (families.some(id => !available.has(id))) throw new ProjectError('Mindestens eine Modellfamilie ist nicht verfügbar.', 400);
    const team = await options.listTeam(session);
    if (members.some(id => !team.some(m => m.id === id && (m.status !== 'disabled' || previousMembers.includes(id))))) {
      throw new ProjectError('Mindestens ein Mitglied ist nicht verfügbar. Deaktivierte Mitglieder können nicht neu hinzugefügt werden.', 400);
    }
  }
  async function save(session: SessionContext, raw: unknown, rawId?: string): Promise<ProjectDetail> {
    await current(session, true); const data = input(raw, rawId !== undefined); const id = rawId === undefined ? undefined : projectId(rawId);
    const receipt = { tenantId: session.tenant.id, ownerId: session.user.id, requestId: data.requestId };
    const receiptId = projectReceiptKey(receipt); const payloadHash = semanticHash({ ...data, id: id ?? null });
    let previousMembers: string[] = [];
    return store.update(async state => {
      const oldReceipt = state.requests[receiptId];
      if (oldReceipt) {
        if (oldReceipt.payloadHash !== payloadHash) throw new ProjectError('Diese Anfrage wurde bereits mit anderem Inhalt verwendet.', 409);
        const p = visible(state, session, oldReceipt.projectId);
        if (p.revision !== oldReceipt.revision) throw new ProjectError('Das Projekt wurde inzwischen geändert. Bitte neu laden und erneut bestätigen.', 409);
        previousMembers = [...p.memberIds]; return detail(p, session);
      }
      const previous = id ? visible(state, session, id) : undefined;
      if (previous && !manageable(previous, session)) throw new ProjectError('Dieses Projekt kann nicht geändert werden.', 403);
      if (previous && previous.revision !== data.revision) throw new ProjectError('Das Projekt wurde inzwischen geändert. Bitte neu laden und erneut bestätigen.', 409);
      if ((!previous && Object.keys(state.projects).length >= PROJECT_LIMITS.projects)
        || (previous && previous.revision >= PROJECT_LIMITS.events) || Object.keys(state.requests).length >= PROJECT_LIMITS.receipts) {
        throw new ProjectError('Die Projektablage hat ihre Größenbegrenzung erreicht.', 409);
      }
      previousMembers = previous?.memberIds ?? [];
      await validateGrants(session, data.familyIds, data.memberIds, previousMembers);
      const now = new Date(Math.max(Date.now(), previous ? Date.parse(previous.updatedAt) : 0)).toISOString();
      const revision = (previous?.revision ?? 0) + 1;
      const p: Project = { id: previous?.id ?? randomUUID(), tenantId: session.tenant.id, ownerId: session.user.id,
        name: data.name, description: data.description, familyIds: data.familyIds, memberIds: data.memberIds,
        revision, createdAt: previous?.createdAt ?? now, updatedAt: now,
        events: [...(previous?.events ?? []), { revision, at: now, actorId: session.user.id, kind: previous ? 'updated' : 'created',
          addedFamilies: data.familyIds.filter(id => !previous?.familyIds.includes(id)), removedFamilies: (previous?.familyIds ?? []).filter(id => !data.familyIds.includes(id)),
          addedMembers: data.memberIds.filter(id => !previous?.memberIds.includes(id)), removedMembers: previousMembers.filter(id => !data.memberIds.includes(id)) }] };
      state.projects[p.id] = p; state.requests[receiptId] = { ...receipt, payloadHash, projectId: p.id, revision };
      return detail(p, session);
    }, async () => { await validateGrants(session, data.familyIds, data.memberIds, previousMembers); await current(session, true); });
  }
  return {
    async list(session: SessionContext): Promise<ProjectSummary[]> {
      await current(session); await store.read();
      // Read grants after the final authority await; do not publish the earlier catalog.
      const final = await current(session); const end = await store.read();
      return Object.values(end.projects).filter(p => canSee(p, final)).map(p => summary(p, final))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    },
    async get(session: SessionContext, rawId: string): Promise<ProjectDetail> {
      const live = await current(session); const id = projectId(rawId); const p = visible(await store.read(), live, id);
      const result = detail(p, live); await assertAccess(session, id, p.revision); return result;
    },
    create: (session: SessionContext, raw: unknown) => save(session, raw),
    update: (session: SessionContext, id: string, raw: unknown) => save(session, raw, id),
    resolveAccess, assertAccess,
  };
}
export type ProjectService = ReturnType<typeof createProjectService>;
