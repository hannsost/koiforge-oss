import { randomUUID } from 'node:crypto';
import type { SessionContext } from '@koiforge/security-core';
import { FileMissionStore } from '../missions/store.js';
import type { SemanticModelService } from '../semantic-model/service.js';
import type { CaseRecord, CaseEvidence } from './contracts.js';
import { buildCaseEvidence, listCaseFindings } from './evidence.js';
import { caseHash, FileCaseStore, findingKey, type CaseState } from './store.js';

export class CaseServiceError extends Error {
  constructor(message: string, public readonly statusCode = 400) { super(message); }
}
interface Options {
  root: string;
  semanticModel: Pick<SemanticModelService, 'relationshipSnapshotForMission'>;
  resolvePrincipal(reference: { userId: string; tenantId: string }): Promise<SessionContext | null>;
  assertPermissions(session: SessionContext, permissions: string[]): void;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function body(value: unknown, allowed: string[]) {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new CaseServiceError('Ungültige Fallangaben.');
  return value;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new CaseServiceError('Eine gültige ID ist erforderlich.');
  return value.toLowerCase();
}
function owned(state: CaseState, session: SessionContext, id: string): CaseRecord {
  const item = Object.hasOwn(state.cases, id) ? state.cases[id] : undefined;
  if (!item || item.tenantId !== session.tenant.id || item.ownerId !== session.user.id) throw new CaseServiceError('Klärungsfall nicht gefunden.', 404);
  return item;
}
const stamp = (after?: string) => new Date(Math.max(Date.now(), after ? Date.parse(after) : 0)).toISOString();
function location(input: Record<string, unknown>) {
  const missionId = uuid(input.missionId);
  if (!Number.isSafeInteger(input.sourceRow) || (input.sourceRow as number) < 1) throw new CaseServiceError('Eine gültige Quellzeile ist erforderlich.');
  return { missionId, sourceRow: input.sourceRow as number };
}
export function createCaseService(options: Options) {
  const store = new FileCaseStore(options.root); const missions = new FileMissionStore(options.root);
  function authorize(session: SessionContext, write: boolean, source = false) {
    if (!session?.user?.id || !session?.tenant?.id) throw new CaseServiceError('Bitte anmelden.', 401);
    if (session.tenant.status !== 'active') throw new CaseServiceError('Der Arbeitsbereich ist nicht aktiv.', 403);
    try { options.assertPermissions(session, ['datasets.read', 'cases.read', ...(write ? ['cases.manage'] : []), ...(source ? ['datasets.manage'] : [])]); }
    catch { throw new CaseServiceError('Keine Berechtigung für diese Fallbearbeitung.', 403); }
  }
  async function current(session: SessionContext, write: boolean, source = false) {
    authorize(session, write, source);
    const resolved = await options.resolvePrincipal({ userId: session.user.id, tenantId: session.tenant.id });
    if (!resolved || resolved.user.id !== session.user.id || resolved.tenant.id !== session.tenant.id) throw new CaseServiceError('Die Berechtigung ist nicht mehr gültig.', 403);
    authorize(resolved, write, source); return resolved;
  }
  async function snapshot(session: SessionContext, id: string) {
    const state = await missions.read(); const mission = Object.hasOwn(state.missions, id) ? state.missions[id] : undefined;
    if (!mission || mission.ownerId !== session.user.id || mission.tenantId !== session.tenant.id) throw new CaseServiceError('Auftrag nicht gefunden.', 404);
    if (mission.status !== 'completed' || mission.plan?.capabilityId !== 'order_review' || !mission.relationshipId) throw new CaseServiceError('Nur eine abgeschlossene Bestellprüfung kann einen Klärungsfall begründen.', 409);
    try {
      const source = await options.semanticModel.relationshipSnapshotForMission({ ownerId: session.user.id, tenantId: session.tenant.id }, mission.relationshipId);
      return { mission, source };
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 400 || status === 403 || status === 404) throw new CaseServiceError(error instanceof Error ? error.message : 'Quellenbeleg nicht verfügbar.', status);
      throw error;
    }
  }
  async function evidence(session: SessionContext, selection: { missionId: string; sourceRow: number }) {
    const { mission, source } = await snapshot(session, selection.missionId);
    try { return buildCaseEvidence(mission, source, selection.sourceRow); }
    catch (error) { throw new CaseServiceError(error instanceof Error ? error.message : 'Der Befund kann keinen Fall begründen.', 409); }
  }
  function proposal(session: SessionContext, item: CaseEvidence) {
    const label = typeof item.finding.Bestellung === 'string' ? item.finding.Bestellung : `Quellzeile ${item.sourceRow}`;
    const title = `Bestellung klären: ${label}`.trim().slice(0, 180).trim();
    const evidenceHash = caseHash(item);
    return { title, evidence: item, evidenceHash, previewHash: caseHash({ action: 'create-order-case-v1', tenantId: session.tenant.id, ownerId: session.user.id, title, evidenceHash }) };
  }
  function receipt(state: CaseState, session: SessionContext, operation: string, requestId: string, payload: unknown) {
    const key = caseHash([session.tenant.id, session.user.id, operation, requestId]); const hash = caseHash(payload);
    const prior = state.requests[key];
    if (prior && prior.hash !== hash) throw new CaseServiceError('Diese Anfrage-ID wurde bereits für andere Angaben verwendet.', 409);
    return { key, hash, item: prior ? owned(state, session, prior.caseId) : undefined };
  }
  return {
    async list(session: SessionContext) {
      await current(session, false); const state = await store.read();
      const items = Object.values(state.cases).filter(item => item.ownerId === session.user.id && item.tenantId === session.tenant.id)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
      await current(session, false); return items;
    },
    async get(session: SessionContext, id: string) {
      await current(session, false); const item = owned(await store.read(), session, id); await current(session, false); return item;
    },
    async findings(session: SessionContext, input: unknown) {
      await current(session, true, true); const b = body(input, ['missionId', 'offset', 'limit']); const id = uuid(b.missionId);
      const offset = b.offset === undefined ? 0 : Number(b.offset); const limit = b.limit === undefined ? 25 : Number(b.limit);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new CaseServiceError('Ungültige Seitenauswahl.');
      const { mission, source } = await snapshot(session, id);
      let page;
      try { page = listCaseFindings(mission, source, { offset, limit }); }
      catch (error) { throw new CaseServiceError(error instanceof Error ? error.message : 'Die Befunde konnten nicht geprüft werden.', 409); }
      await current(session, true, true); return page;
    },
    async preview(session: SessionContext, input: unknown) {
      await current(session, true, true); const b = body(input, ['missionId', 'sourceRow']); const selection = location(b);
      const result = proposal(session, await evidence(session, selection)); const state = await store.read();
      const existingCaseId = state.findings[findingKey(session.tenant.id, session.user.id, selection.missionId, selection.sourceRow)] ?? null;
      await current(session, true, true); return { ...result, existingCaseId };
    },
    async create(session: SessionContext, input: unknown) {
      const principal = await current(session, true, true);
      const b = body(input, ['missionId', 'sourceRow', 'previewHash', 'confirmed', 'requestId']); const selection = location(b); const requestId = uuid(b.requestId);
      if (b.confirmed !== true || typeof b.previewHash !== 'string' || !/^[a-f0-9]{64}$/.test(b.previewHash)) throw new CaseServiceError('Bitte die angezeigte Fallvorschau bestätigen.');
      return store.update(async state => {
        const previous = receipt(state, session, 'create', requestId, { ...selection, previewHash: b.previewHash, confirmed: true });
        if (previous.item) return previous.item;
        const preview = proposal(session, await evidence(session, selection));
        if (preview.previewHash !== b.previewHash) throw new CaseServiceError('Der Befund stimmt nicht mit der bestätigten Vorschau überein. Bitte neu prüfen.', 409);
        const key = findingKey(session.tenant.id, session.user.id, selection.missionId, selection.sourceRow);
        const existing = state.findings[key];
        if (existing) {
          const item = owned(state, session, existing);
          if (item.evidenceHash !== preview.evidenceHash) throw new CaseServiceError('Der bestehende Fall hat einen abweichenden Quellenbeleg.', 409);
          state.requests[previous.key] = { hash: previous.hash, caseId: item.id }; return item;
        }
        if (Object.keys(state.cases).length >= 10000) throw new CaseServiceError('Die Fallablage hat ihre Grenze von 10.000 Fällen erreicht.', 413);
        const now = stamp();
        const item: CaseRecord = { id: randomUUID(), tenantId: session.tenant.id, ownerId: session.user.id, title: preview.title,
          status: 'open', revision: 1, createdAt: now, updatedAt: now, evidence: preview.evidence, evidenceHash: preview.evidenceHash,
          assignee: null, resolution: null, events: [{ at: now, actorId: principal.user.id, actorName: principal.user.displayName, kind: 'created', note: null }] };
        state.cases[item.id] = item; state.findings[key] = item.id; state.requests[previous.key] = { hash: previous.hash, caseId: item.id }; return item;
      }, async () => { await current(session, true, true); });
    },
    async transition(session: SessionContext, id: string, input: unknown) {
      const principal = await current(session, true);
      const b = body(input, ['revision', 'requestId', 'action', 'note', 'confirmed']); const requestId = uuid(b.requestId);
      if (b.confirmed !== true || !Number.isSafeInteger(b.revision) || (b.revision as number) < 1
        || !['claim', 'resolve', 'reopen'].includes(b.action as string)) throw new CaseServiceError('Bitte eine gültige Fallaktion ausdrücklich bestätigen.');
      const note = typeof b.note === 'string' ? b.note.trim() : null;
      if (b.action === 'claim' ? b.note !== undefined : !note || note.length > 2000) throw new CaseServiceError('Abschluss und Wiederöffnung benötigen eine Notiz mit 1 bis 2.000 Zeichen.');
      return store.update(state => {
        const previous = receipt(state, session, 'transition', requestId, { id, revision: b.revision, action: b.action, note, confirmed: true });
        if (previous.item) return previous.item;
        const item = owned(state, session, id);
        if (item.revision !== b.revision) throw new CaseServiceError('Der Fall wurde inzwischen geändert. Bitte den aktuellen Stand laden und erneut bestätigen.', 409);
        if (item.events.length >= 10000) throw new CaseServiceError('Die Ereignisgrenze dieses Falls ist erreicht.', 413);
        const now = stamp(item.updatedAt);
        let kind: CaseRecord['events'][number]['kind'];
        if (b.action === 'claim' && item.status === 'open') {
          item.status = 'in_progress'; item.assignee = { id: principal.user.id, displayName: principal.user.displayName }; kind = 'claimed';
        } else if (b.action === 'resolve' && item.status === 'in_progress') {
          item.status = 'resolved'; item.resolution = note; kind = 'resolved';
        } else if (b.action === 'reopen' && item.status === 'resolved') {
          item.status = 'open'; item.assignee = null; item.resolution = null; kind = 'reopened';
        } else throw new CaseServiceError('Diese Aktion passt nicht mehr zum aktuellen Fallstatus. Bitte neu laden.', 409);
        item.revision++; item.updatedAt = now;
        item.events.push({ at: now, actorId: principal.user.id, actorName: principal.user.displayName, kind, note });
        state.requests[previous.key] = { hash: previous.hash, caseId: item.id }; return item;
      }, async () => { await current(session, true); });
    },
  };
}
export type CaseService = ReturnType<typeof createCaseService>;
