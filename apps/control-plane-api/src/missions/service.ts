import { createHash, randomUUID } from 'node:crypto';
import type { SessionContext } from '@koiforge/security-core';
import type { Mission, MissionEngine, MissionResult, MissionStatus } from './contracts.js';
import { FileMissionStore, routineDefinitionHash, type MissionState } from './store.js';
import { orderReviewRuleHash, validateOrderReviewInput } from '../domain/orders/review.js';
import { buildRoutineTemplate, prepareRoutine } from '../routines/prepare.js';
import type { RoutineDefinition } from '../routines/contracts.js';
import { compareRoutineRuns, type ChangeCategory } from '../routines/compare.js';
import type { SemanticModelService } from '../semantic-model/service.js';

export class MissionServiceError extends Error {
  constructor(message: string, public readonly statusCode = 400) { super(message); }
}
export interface MissionServiceOptions {
  root: string;
  engine: MissionEngine;
  resolvePrincipal: (reference: { userId: string; tenantId: string }) => Promise<SessionContext | null>;
  assertPermissions: (session: SessionContext, permissions: string[]) => void;
  maxPending?: number;
  semanticModel?: Pick<SemanticModelService, 'relationshipSnapshotForMission'>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function body(value: unknown, keys: string[]): Record<string, unknown> {
  if (!record(value) || Object.keys(value).some(key => !keys.includes(key))) throw new MissionServiceError('Ungültige Auftragsangaben.');
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function requestId(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new MissionServiceError('requestId muss eine UUID sein.');
  return value.toLowerCase();
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new MissionServiceError('Eine gültige Auftragsrevision ist erforderlich.');
  return value as number;
}
function transition(m: Mission, status: MissionStatus, message: string) {
  m.status = status; m.revision += 1; m.updatedAt = new Date().toISOString();
  m.events.push({ at: m.updatedAt, status, message });
}
function owned(state: MissionState, session: SessionContext, id: string): Mission {
  const m = Object.hasOwn(state.missions, id) ? state.missions[id] : undefined;
  if (!m || m.ownerId !== session.user.id || m.tenantId !== session.tenant.id) throw new MissionServiceError('Auftrag nicht gefunden.', 404);
  return m;
}
function ownedRoutine(state: MissionState, session: SessionContext, id: string): RoutineDefinition {
  const entry = Object.hasOwn(state.routines, id) ? state.routines[id] : undefined;
  if (!entry || entry.definition.ownerId !== session.user.id || entry.definition.tenantId !== session.tenant.id) throw new MissionServiceError('Routine nicht gefunden.', 404);
  return entry.definition;
}

/** One API process owns this queue. Model lifetime is never the HTTP lifetime. */
export async function createMissionService(options: MissionServiceOptions) {
  const store = new FileMissionStore(options.root);
  const { engine } = options;
  const maxPending = options.maxPending ?? 16;
  if (!Number.isSafeInteger(maxPending) || maxPending < 1) throw new Error('Invalid mission queue limit.');
  let closed = false;
  let worker: Promise<void> | undefined;
  let workerFailure: Error | undefined;
  let wakeRequested = false;

  function authorize(session: SessionContext, write: boolean) {
    if (!session?.user?.id || !session?.tenant?.id) throw new MissionServiceError('Bitte anmelden.', 401);
    if (session.tenant.status !== 'active') throw new MissionServiceError('Der Arbeitsbereich ist nicht aktiv.', 403);
    try { options.assertPermissions(session, write ? ['datasets.read', 'datasets.manage'] : ['datasets.read']); }
    catch { throw new MissionServiceError('Keine Berechtigung für diesen Auftrag.', 403); }
  }
  function available() {
    if (closed || workerFailure) throw new MissionServiceError('Auftragsverarbeitung ist derzeit nicht verfügbar.', 503);
  }
  function room(state: MissionState) {
    if (Object.values(state.missions).filter(m => ['queued', 'planning', 'running'].includes(m.status)).length >= maxPending) {
      throw new MissionServiceError('Die Auftragswarteschlange ist voll. Bitte später erneut versuchen.', 429);
    }
  }
  function supported(m: Mission) {
    if (!m.source || !m.plan?.capabilityId || !engine.capabilities.some(c => c.id === m.plan!.capabilityId && c.version === m.plan!.capabilityVersion)) {
      throw new MissionServiceError('Für diesen Auftrag liegt keine ausführbare, unterstützte Fähigkeit vor.', 409);
    }
  }
  function deduplicate(state: MissionState, session: SessionContext, operation: string, id: string, payload: unknown) {
    const key = hash([session.tenant.id, session.user.id, operation, id]);
    const payloadHash = hash(payload);
    const previous = state.requests[key];
    if (previous) {
      if (previous.hash !== payloadHash) throw new MissionServiceError('requestId wurde bereits für andere Angaben verwendet.', 409);
      return { key, payloadHash, mission: owned(state, session, previous.missionId) };
    }
    return { key, payloadHash, mission: undefined };
  }
  function checkResult(m: Mission, result: MissionResult) {
    if (!result || result.capabilityId !== m.plan?.capabilityId
      || result.evidence?.sourceHash !== m.source?.hash
      || result.evidence?.capabilityVersion !== m.plan?.capabilityVersion
      || typeof result.summary !== 'string' || !Array.isArray(result.columns) || !result.columns.every(c => typeof c === 'string')
      || !Array.isArray(result.rows) || !result.rows.every(record)
      || !Number.isSafeInteger(result.totalRows) || result.totalRows < result.rows.length
      || result.truncated !== (result.totalRows > result.rows.length)
      || !record(result.counts) || !Object.values(result.counts).every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)
      || typeof result.evidence.executedAt !== 'string' || !Number.isFinite(Date.parse(result.evidence.executedAt))) {
      throw new Error('Das Ergebnis stimmt nicht mit dem bestätigten Auftrag und Quellenstand überein.');
    }
    if ((m.plan?.capabilityId === 'relationship_integrity' || m.plan?.capabilityId === 'order_review') && (!m.plan.relationship
      || result.evidence.relationshipId !== m.relationshipId
      || result.evidence.relationshipId !== m.plan.relationship.id
      || result.evidence.fromSetId !== m.plan.relationship.fromSetId
      || result.evidence.toSetId !== m.plan.relationship.toSetId
      || result.evidence.targetSourceHash !== m.plan.relationship.targetHash
      || result.evidence.fromSnapshotHash !== m.plan.relationship.fromSnapshotHash
      || result.evidence.toSnapshotHash !== m.plan.relationship.toSnapshotHash)) {
      throw new Error('Das Beziehungsergebnis stimmt nicht mit den bestätigten Objektmengen überein.');
    }
    if (m.plan?.capabilityId === 'order_review') {
      const input = validateOrderReviewInput(m.input?.binding, m.input?.orderRule, m.source!.columns, m.plan.orderKeyField!);
      if (result.evidence.orderRuleHash !== orderReviewRuleHash(input.binding, input.orderRule)) {
        throw new Error('Das Bestellergebnis stimmt nicht mit der bestätigten Status- und Terminregel überein.');
      }
    }
  }
  async function currentPrincipal(m: Mission) {
    const current = await options.resolvePrincipal({ userId: m.ownerId, tenantId: m.tenantId });
    if (!current || current.user.id !== m.ownerId || current.tenant.id !== m.tenantId) throw new MissionServiceError('Die Auftragsberechtigung ist nicht mehr gültig.', 403);
    authorize(current, true);
    return current;
  }
  async function currentSession(session: SessionContext, write: boolean) {
    authorize(session, write);
    const resolved = await options.resolvePrincipal({ userId: session.user.id, tenantId: session.tenant.id });
    if (!resolved || resolved.user.id !== session.user.id || resolved.tenant.id !== session.tenant.id) throw new MissionServiceError('Die Auftragsberechtigung ist nicht mehr gültig.', 403);
    authorize(resolved, write);
  }
  async function beforeRoutineCommit(session: SessionContext) {
    await currentSession(session, true); available();
  }
  async function routineSnapshot(session: SessionContext, id: string) {
    if (!options.semanticModel) throw new MissionServiceError('Die Fachmodellverbindung für Routinen ist nicht verfügbar.', 503);
    try {
      return await options.semanticModel.relationshipSnapshotForMission({ ownerId: session.user.id, tenantId: session.tenant.id }, id);
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 400 || status === 403 || status === 404) throw new MissionServiceError(error instanceof Error ? error.message : 'Beziehung nicht verfügbar.', status);
      throw error;
    }
  }
  function routineInput(input: unknown, run: boolean): Record<string, unknown> & { relationshipId: string; asOf: string } {
    const b = body(input, run ? ['relationshipId', 'asOf', 'previewHash', 'confirmed', 'requestId'] : ['relationshipId', 'asOf']);
    if (typeof b.relationshipId !== 'string' || !uuid.test(b.relationshipId) || typeof b.asOf !== 'string' || b.asOf.length !== 10) {
      throw new MissionServiceError('Eine gespeicherte Beziehung und ein gültiger Stichtag sind erforderlich.');
    }
    return { ...b, relationshipId: b.relationshipId.toLowerCase(), asOf: b.asOf };
  }
  function executableRoutine(routine: RoutineDefinition) {
    if (!engine.capabilities.some(c => c.id === routine.capabilityId && c.version === routine.capabilityVersion)) {
      throw new MissionServiceError('Die gespeicherte Routine verwendet eine nicht mehr ausführbare Fähigkeitsversion.', 409);
    }
  }
  async function validateRoutineMission(mission: Mission) {
    if (!mission.routine) return;
    const current = await currentPrincipal(mission);
    const definition = ownedRoutine(await store.read(), current, mission.routine.id);
    executableRoutine(definition);
    if (!mission.relationshipId || !mission.input?.orderRule) throw new Error('Die bestätigte Routinenprüfung fehlt.');
    const snapshot = await routineSnapshot(current, mission.relationshipId);
    const preview = prepareRoutine(definition, snapshot, mission.input.orderRule.asOf);
    if (!preview.ready || preview.previewHash !== mission.routine.previewHash
      || preview.orderRuleHash !== mission.routine.confirmedRuleHash
      || hash(mission.input) !== hash({ confirmed: true, binding: preview.binding, orderRule: preview.orderRule })
      || hash(mission.source) !== hash(preview.source) || mission.datasetId !== preview.source.datasetId
      || hash(mission.plan?.relationship) !== hash(preview.relationship) || mission.plan?.orderKeyField !== preview.orderKeyField) {
      throw new Error('Die Routinenprüfung stimmt nicht mehr mit der bestätigten Vorprüfung überein. Bitte eine neue Vorprüfung starten.');
    }
  }
  async function beforePublication(m: Mission) {
    await currentPrincipal(m);
    if (closed) throw new Error('Die Auftragsverarbeitung wurde vor der Veröffentlichung geschlossen.');
  }
  async function processQueue() {
    while (!closed) {
      const next = await store.update(state => {
        if (closed) return undefined;
        const m = Object.values(state.missions).find(entry => entry.status === 'queued');
        if (!m) return undefined;
        transition(m, m.phase === 'plan' ? 'planning' : 'running', m.phase === 'plan' ? 'Auftrag wird geprüft.' : 'Bestätigte Prüfung wird ausgeführt.');
        return m;
      });
      if (!next || closed) return;
      try {
        await currentPrincipal(next);
        if (closed) return;
        if (next.phase === 'plan') {
          const planned = await engine.plan(structuredClone(next));
          if (planned.source.datasetId !== next.datasetId || planned.source.coverage !== 'complete'
            || !/^[a-f0-9]{64}$/i.test(planned.source.hash) || !Number.isSafeInteger(planned.source.rowCount) || planned.source.rowCount < 0) {
            throw new Error('Der festgehaltene Quellenstand ist ungültig.');
          }
          if (planned.plan.capabilityId !== null && !engine.capabilities.some(c => c.id === planned.plan.capabilityId && c.version === planned.plan.capabilityVersion)) {
            throw new Error('Der Plan verwendet keine verfügbare Version einer Fähigkeit.');
          }
          if (closed) return;
          await currentPrincipal(next);
          await store.update(state => {
            const m = state.missions[next.id];
            if (closed || !m || m.revision !== next.revision || m.status !== 'planning') return;
            m.source = planned.source; m.plan = planned.plan; delete m.error;
            if (planned.plan.capabilityId === null) {
              m.error = planned.plan.unsupportedReason ?? 'Diese Aufgabe wird noch nicht unterstützt.';
              transition(m, 'blocked', m.error);
            } else transition(m, 'awaiting_confirmation', 'Vorgehen und fachliche Angaben können bestätigt werden.');
          }, () => beforePublication(next));
        } else {
          supported(next);
          if (!next.input) throw new Error('Die bestätigten Angaben fehlen.');
          await validateRoutineMission(next);
          const checked = engine.validateRun(next, next.input);
          const result = await engine.execute(structuredClone(next), checked);
          checkResult(next, result);
          if (closed) return;
          await currentPrincipal(next);
          await store.update(state => {
            const m = state.missions[next.id];
            if (closed || !m || m.revision !== next.revision || m.status !== 'running') return;
            m.result = result; delete m.error;
            transition(m, 'completed', 'Prüfung mit festgehaltenem Quellenbeleg abgeschlossen.');
          }, () => beforePublication(next));
        }
      } catch (error) {
        if (closed) return;
        await store.update(state => {
          const m = state.missions[next.id];
          if (closed || !m || m.revision !== next.revision) return;
          m.error = error instanceof Error ? error.message.slice(0, 1000) : 'Der Auftrag konnte nicht ausgeführt werden.';
          delete m.result;
          transition(m, 'blocked', m.error);
        });
      }
    }
  }
  function kick() {
    wakeRequested = true;
    if (closed || worker || workerFailure) return;
    worker = (async () => {
      do { wakeRequested = false; await processQueue(); }
      while (wakeRequested && !closed);
    })().catch(error => { workerFailure = error instanceof Error ? error : new Error('Mission worker failed.'); })
      .finally(() => { worker = undefined; if (wakeRequested && !closed && !workerFailure) kick(); });
  }

  await store.update(state => {
    for (const m of Object.values(state.missions)) if (m.status === 'planning' || m.status === 'running') {
      m.error = 'Der vorige Prozess wurde unterbrochen. Bitte den Auftrag bewusst erneut versuchen.';
      transition(m, 'interrupted', m.error);
    }
  });

  const service = {
    capabilities: structuredClone(engine.capabilities),
    async createRoutine(session: SessionContext, input: unknown): Promise<RoutineDefinition> {
      await currentSession(session, true); available();
      const b = body(input, ['sourceMissionId', 'name', 'confirmed', 'requestId']);
      const rid = requestId(b.requestId);
      if (b.confirmed !== true || typeof b.name !== 'string' || !b.name.trim() || b.name.trim().length > 120
        || typeof b.sourceMissionId !== 'string' || !uuid.test(b.sourceMissionId)) {
        throw new MissionServiceError('Bitte einen fertigen Bestellauftrag, einen Namen (höchstens 120 Zeichen) und das Speichern der Regeln bestätigen.');
      }
      const name = b.name.trim(); const sourceMissionId = b.sourceMissionId.toLowerCase();
      const key = hash([session.tenant.id, session.user.id, 'routine-create', rid]);
      const payloadHash = hash({ name, sourceMissionId, confirmed: true });
      return store.update(async state => {
        available();
        const previous = state.routineRequests[key];
        if (previous) {
          if (previous.hash !== payloadHash) throw new MissionServiceError('requestId wurde bereits für andere Angaben verwendet.', 409);
          return ownedRoutine(state, session, previous.routineId);
        }
        if (Object.keys(state.routines).length >= 1000) throw new MissionServiceError('Die Routinenablage hat ihre Grenze von 1.000 Routinen erreicht.', 413);
        const source = owned(state, session, sourceMissionId);
        if (source.status !== 'completed' || source.plan?.capabilityId !== 'order_review' || !source.relationshipId) {
          throw new MissionServiceError('Eine Routine kann nur aus einer abgeschlossenen Bestellungsprüfung entstehen.', 409);
        }
        const snapshot = await routineSnapshot(session, source.relationshipId);
        let template;
        try { template = buildRoutineTemplate(source, snapshot); }
        catch (error) { throw new MissionServiceError(error instanceof Error ? error.message : 'Der bestätigte Bestellauftrag ist nicht wiederverwendbar.', 409); }
        const routine: RoutineDefinition = { ...template, id: randomUUID(), name, createdAt: new Date().toISOString() };
        executableRoutine(routine);
        state.routines[routine.id] = { definition: routine, hash: routineDefinitionHash(routine) };
        state.routineRequests[key] = { hash: payloadHash, routineId: routine.id };
        return routine;
      }, () => beforeRoutineCommit(session));
    },
    async listRoutines(session: SessionContext): Promise<RoutineDefinition[]> {
      await currentSession(session, false);
      const items = Object.values((await store.read()).routines).map(entry => entry.definition)
        .filter(routine => routine.ownerId === session.user.id && routine.tenantId === session.tenant.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      await currentSession(session, false);
      return items;
    },
    async getRoutine(session: SessionContext, id: string): Promise<RoutineDefinition> {
      await currentSession(session, false);
      const routine = ownedRoutine(await store.read(), session, id);
      await currentSession(session, false);
      return routine;
    },
    async listRoutineRuns(session: SessionContext, id: string) {
      await currentSession(session, false);
      const state = await store.read();
      ownedRoutine(state, session, id);
      const items = Object.values(state.missions)
        .filter(m => m.ownerId === session.user.id && m.tenantId === session.tenant.id && m.routine?.id === id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
        .map(m => ({ id: m.id, status: m.status, createdAt: m.createdAt, updatedAt: m.updatedAt,
          sourceName: m.source?.name ?? '', asOf: m.input?.orderRule?.asOf ?? null }));
      await currentSession(session, false);
      return items;
    },
    async compareRoutineRun(session: SessionContext, id: string, input: unknown) {
      // Full row evidence has the same permission boundary as the routine preview.
      await currentSession(session, true);
      const b = body(input, ['missionId', 'category', 'offset', 'limit']);
      if (typeof b.missionId !== 'string' || !uuid.test(b.missionId)) {
        throw new MissionServiceError('Bitte einen abgeschlossenen Routinenlauf auswählen.');
      }
      const pageNumber = (value: unknown, fallback: number, min: number, max: number) => {
        if (value === undefined) return fallback;
        if (typeof value !== 'number' && (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value))) {
          throw new MissionServiceError('Ungültige Seitenauswahl für den Befundvergleich.');
        }
        const result = Number(value);
        if (!Number.isSafeInteger(result) || result < min || result > max) throw new MissionServiceError('Ungültige Seitenauswahl für den Befundvergleich.');
        return result;
      };
      const offset = pageNumber(b.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = pageNumber(b.limit, 25, 1, 100);
      const categories: ChangeCategory[] = ['new', 'persisting', 'cleared', 'missing', 'uncomparable'];
      if (b.category !== undefined && !categories.includes(b.category as ChangeCategory)) {
        throw new MissionServiceError('Unbekannte Befundkategorie.');
      }
      const state = await store.read();
      const routine = ownedRoutine(state, session, id);
      const before = owned(state, session, routine.sourceMissionId);
      const after = owned(state, session, b.missionId.toLowerCase());
      if (after.routine?.id !== id || after.status !== 'completed' || !before.relationshipId || !after.relationshipId) {
        throw new MissionServiceError('Der Vergleich benötigt einen abgeschlossenen Lauf dieser Routine.', 409);
      }
      const beforeSnapshot = await routineSnapshot(session, before.relationshipId);
      const afterSnapshot = await routineSnapshot(session, after.relationshipId);
      let comparison;
      try { comparison = compareRoutineRuns(routine, before, beforeSnapshot, after, afterSnapshot); }
      catch (error) { throw new MissionServiceError(error instanceof Error ? error.message : 'Die gespeicherten Prüfläufe sind nicht vergleichbar.', 409); }
      const items = comparison.items.filter(item => b.category === undefined || item.category === b.category);
      await currentSession(session, true);
      return { ...comparison, items: items.slice(offset, offset + limit), offset, limit, totalRows: items.length };
    },
    async previewRoutine(session: SessionContext, id: string, input: unknown) {
      await currentSession(session, true);
      const b = routineInput(input, false);
      const routine = ownedRoutine(await store.read(), session, id);
      executableRoutine(routine);
      const snapshot = await routineSnapshot(session, b.relationshipId);
      let preview;
      try { preview = prepareRoutine(routine, snapshot, b.asOf); }
      catch (error) { throw new MissionServiceError(error instanceof Error ? error.message : 'Der neue Stand kann nicht geprüft werden.'); }
      await currentSession(session, true);
      return preview;
    },
    async runRoutine(session: SessionContext, id: string, input: unknown): Promise<Mission> {
      await currentSession(session, true); available();
      const b = routineInput(input, true);
      const rid = requestId(b.requestId);
      if (b.confirmed !== true || typeof b.previewHash !== 'string' || !/^[a-f0-9]{64}$/.test(b.previewHash)) {
        throw new MissionServiceError('Bitte die geprüften Änderungen und den neuen Quellenstand ausdrücklich bestätigen.');
      }
      const accepted = await store.update(async state => {
        available();
        const previous = deduplicate(state, session, 'routine-run', rid, { id, ...b });
        if (previous.mission) return previous.mission;
        const routine = ownedRoutine(state, session, id);
        executableRoutine(routine); room(state);
        const snapshot = await routineSnapshot(session, b.relationshipId);
        let preview;
        try { preview = prepareRoutine(routine, snapshot, b.asOf); }
        catch (error) { throw new MissionServiceError(error instanceof Error ? error.message : 'Der neue Stand kann nicht geprüft werden.'); }
        if (!preview.ready || !preview.previewHash || preview.previewHash !== b.previewHash) {
          throw new MissionServiceError('Die Bestätigung passt nicht zur aktuellen Vorprüfung. Bitte Änderungen erneut prüfen.', 409);
        }
        const origin = owned(state, session, routine.sourceMissionId);
        const now = new Date().toISOString();
        const mission: Mission = { id: randomUUID(), tenantId: session.tenant.id, ownerId: session.user.id,
          question: `${routine.name} · Stichtag ${b.asOf}`, datasetId: preview.source.datasetId, relationshipId: preview.relationshipId,
          source: preview.source, plan: { ...origin.plan!, capabilityId: routine.capabilityId, capabilityVersion: routine.capabilityVersion,
            summary: `Gespeicherte Bestellregeln aus „${routine.name}“ auf den bestätigten Stand anwenden.`,
            suggestedBinding: preview.binding, relationship: preview.relationship, orderKeyField: preview.orderKeyField,
            reusedFromMissionId: origin.id, steps: ['Neue Quellenstände und Änderungen prüfen', 'Gespeicherte Regeln und neuen Stichtag bestätigen', 'Bestellungsprüfung mit Quellen- und Regelbelegen ausführen'] },
          input: { confirmed: true, binding: preview.binding, orderRule: preview.orderRule },
          routine: { id: routine.id, name: routine.name, sourceMissionId: origin.id, previewHash: preview.previewHash, baselineRuleHash: routine.baseline.orderRuleHash, confirmedRuleHash: preview.orderRuleHash },
          phase: 'execute', status: 'queued', revision: 1, createdAt: now, updatedAt: now,
          events: [{ at: now, status: 'queued', message: 'Bestätigter Routinenlauf dauerhaft angenommen; gespeicherter Plan wird wiederverwendet.' }] };
        mission.input = engine.validateRun(mission, mission.input);
        state.missions[mission.id] = mission;
        state.requests[previous.key] = { hash: previous.payloadHash, missionId: mission.id };
        return mission;
      }, () => beforeRoutineCommit(session));
      kick(); return accepted;
    },
    async create(session: SessionContext, input: unknown): Promise<Mission> {
      authorize(session, true); available();
      const b = body(input, ['question', 'datasetId', 'requestId', 'relationshipId']);
      const rid = requestId(b.requestId);
      if (typeof b.question !== 'string' || !b.question.trim() || b.question.length > 1000
        || typeof b.datasetId !== 'string' || !b.datasetId.trim() || b.datasetId.length > 200) throw new MissionServiceError('Geschäftsfrage und Datenquelle sind erforderlich; die Frage darf höchstens 1000 Zeichen enthalten.');
      const question = b.question.trim(); const datasetId = b.datasetId.trim();
      if (b.relationshipId !== undefined && (typeof b.relationshipId !== 'string' || !uuid.test(b.relationshipId))) {
        throw new MissionServiceError('Bitte eine gespeicherte Beziehung auswählen.');
      }
      const relationship = b.relationshipId === undefined ? {} : { relationshipId: (b.relationshipId as string).toLowerCase() };
      const mission = await store.update(state => {
        available();
        const request = deduplicate(state, session, 'create', rid, { question, datasetId, ...relationship });
        if (request.mission) return request.mission;
        room(state);
        const now = new Date().toISOString();
        const m: Mission = { id: randomUUID(), tenantId: session.tenant.id, ownerId: session.user.id, question, datasetId, ...relationship,
          status: 'queued', phase: 'plan', revision: 1, createdAt: now, updatedAt: now,
          events: [{ at: now, status: 'queued', message: 'Auftrag dauerhaft angenommen.' }] };
        state.missions[m.id] = m;
        state.requests[request.key] = { hash: request.payloadHash, missionId: m.id };
        return m;
      });
      kick(); return mission;
    },
    async list(session: SessionContext): Promise<Mission[]> {
      authorize(session, false);
      return Object.values((await store.read()).missions).filter(m => m.ownerId === session.user.id && m.tenantId === session.tenant.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map(m => {
          if (m.result) m.result = { ...m.result, rows: m.result.rows.slice(0, 20), truncated: m.result.totalRows > Math.min(m.result.rows.length, 20) };
          return m;
        });
    },
    async get(session: SessionContext, id: string): Promise<Mission> {
      authorize(session, false); return owned(await store.read(), session, id);
    },
    async orderStatuses(session: SessionContext, id: string, field: unknown) {
      authorize(session, true);
      const mission = owned(await store.read(), session, id);
      await currentPrincipal(mission);
      if (mission.plan?.capabilityId !== 'order_review' || !engine.orderStatuses) {
        throw new MissionServiceError('Dieser Auftrag enthält keine Bestellungsprüfung.', 409);
      }
      if (typeof field !== 'string' || !mission.source?.columns.includes(field)) {
        throw new MissionServiceError('Bitte eine vorhandene Statusspalte auswählen.');
      }
      const profile = await engine.orderStatuses(mission, field);
      await currentPrincipal(mission);
      return profile;
    },
    async run(session: SessionContext, id: string, input: unknown): Promise<Mission> {
      authorize(session, true); available();
      const b = body(input, ['revision', 'requestId', 'confirmed', 'binding', 'rule', 'orderRule']);
      const rid = requestId(b.requestId); const expected = revision(b.revision);
      const mission = await store.update(state => {
        available();
        const request = deduplicate(state, session, 'run', rid, { id, ...b });
        if (request.mission) return request.mission;
        const m = owned(state, session, id);
        if (m.routine) throw new MissionServiceError('Routinenläufe behalten ihre bestätigten Regeln. Bitte für andere Angaben eine neue Vorprüfung der Routine starten.', 409);
        if (m.revision !== expected) throw new MissionServiceError('Der Auftrag wurde inzwischen geändert. Bitte neu laden.', 409);
        const initial = m.status === 'awaiting_confirmation' && m.phase === 'plan';
        const correction = ['blocked', 'interrupted'].includes(m.status) && m.phase === 'execute';
        if (!initial && !correction) throw new MissionServiceError('Dieser Auftrag wartet nicht auf eine Bestätigung.', 409);
        supported(m); room(state);
        if (b.confirmed !== true || !record(b.binding)) throw new MissionServiceError('Bitte das Vorgehen und die fachlichen Angaben bestätigen.');
        try { m.input = engine.validateRun(m, { confirmed: true, binding: b.binding,
          ...(b.rule !== undefined ? { rule: b.rule } : {}), ...(b.orderRule !== undefined ? { orderRule: b.orderRule } : {}) }); }
        catch (error) { throw new MissionServiceError(error instanceof Error ? error.message : 'Ungültige fachliche Angaben.'); }
        m.phase = 'execute'; delete m.error; delete m.result;
        transition(m, 'queued', 'Bestätigte Prüfung dauerhaft angenommen.');
        state.requests[request.key] = { hash: request.payloadHash, missionId: m.id }; return m;
      });
      kick(); return mission;
    },
    async retry(session: SessionContext, id: string, input: unknown): Promise<Mission> {
      authorize(session, true); available();
      const b = body(input, ['revision', 'requestId']);
      const rid = requestId(b.requestId); const expected = revision(b.revision);
      const mission = await store.update(state => {
        available();
        const request = deduplicate(state, session, 'retry', rid, { id, ...b });
        if (request.mission) return request.mission;
        const m = owned(state, session, id);
        if (m.revision !== expected) throw new MissionServiceError('Der Auftrag wurde inzwischen geändert. Bitte neu laden.', 409);
        if (!['blocked', 'interrupted'].includes(m.status) || m.plan?.capabilityId === null) throw new MissionServiceError('Dieser Auftrag kann nicht erneut ausgeführt werden. Für eine andere Frage bitte einen neuen Auftrag beginnen.', 409);
        if (m.phase === 'execute') { supported(m); if (!m.input) throw new MissionServiceError('Bestätigte Angaben fehlen.', 409); }
        room(state); delete m.error; delete m.result;
        transition(m, 'queued', 'Erneuter Versuch dauerhaft angenommen.');
        state.requests[request.key] = { hash: request.payloadHash, missionId: m.id }; return m;
      });
      kick(); return mission;
    },
    async whenIdle(): Promise<void> { while (worker) await worker; if (workerFailure) throw workerFailure; },
    async close(): Promise<void> {
      if (closed) return; closed = true;
      await store.update(state => {
        for (const m of Object.values(state.missions)) if (m.status === 'planning' || m.status === 'running') {
          m.error = 'Die Verarbeitung wurde beim Beenden unterbrochen. Bitte bewusst erneut versuchen.';
          transition(m, 'interrupted', m.error);
        }
      });
    },
  };
  kick();
  return service;
}

export type MissionService = Awaited<ReturnType<typeof createMissionService>>;
