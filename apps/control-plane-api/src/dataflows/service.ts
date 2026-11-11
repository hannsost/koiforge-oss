import { randomUUID } from 'node:crypto';
import type { SessionContext } from '@koiforge/security-core';
import { rowsHash } from '../import-capability/isolated-executor.js';
import { FileSemanticModelStore, isRecord, SEMANTIC_UUID, semanticHash, type SemanticState, type StoredObjectSet } from '../semantic-model/store.js';
import type { SemanticModelService } from '../semantic-model/service.js';
import { DATAFLOW_ENGINE, DataflowError, type FlowDefinition, type FlowDependencyGraph, type FlowDetail, type FlowEvaluation, type FlowInput, type FlowRun, type FlowRunSummary, type FlowSummary } from './contracts.js';
import { evaluateFlow, validateFlowSpec } from './engine.js';
import { projectDependencies } from './dependencies.js';
import { definitionHash, familyIds, FileDataflowStore, FLOW_LIMITS, flowReceiptKey, runHash, type FlowState } from './store.js';

export interface DataflowOptions {
  root: string; semanticModel: Pick<SemanticModelService, 'publishDataflow'>;
  resolvePrincipal: (reference: { userId: string; tenantId: string }) => Promise<SessionContext | null>;
  assertPermissions: (session: SessionContext, permissions: string[]) => void;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !SEMANTIC_UUID.test(value.toLowerCase())) throw new DataflowError('Ungültige Datenfluss-, Versions- oder Anfrage-ID.');
  return value.toLowerCase();
}
function body(raw: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!isRecord(raw) || raw.confirmed !== true || required.some(k => !Object.hasOwn(raw, k)) || Object.keys(raw).some(k => !required.includes(k) && !optional.includes(k))) {
    throw new DataflowError('Bitte die beschriebenen Angaben übergeben und diesen Schritt ausdrücklich bestätigen.');
  }
  return raw;
}
function page(raw: unknown): { offset: number; limit: number } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.entries(raw).some(([k, v]) => !['offset', 'limit'].includes(k) || typeof v !== 'string' || !/^\d+$/.test(v))) throw new DataflowError('Ungültige Seitenangaben.');
  const query = Object.fromEntries(Object.entries(raw));
  const offset = query.offset === undefined ? 0 : Number(query.offset); const limit = query.limit === undefined ? 25 : Number(query.limit);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new DataflowError('limit muss zwischen 1 und 100 liegen, offset muss nichtnegativ sein.');
  return { offset, limit };
}
const owned = (s: { ownerId: string; tenantId: string }, session: SessionContext) => s.ownerId === session.user.id && s.tenantId === session.tenant.id;
function currentDefinitions(state: FlowState, session: SessionContext): Map<string, FlowDefinition> {
  const latest = new Map<string, FlowDefinition>();
  for (const d of Object.values(state.definitions)) if (owned(d, session) && (latest.get(d.flowId)?.revision ?? 0) < d.revision) latest.set(d.flowId, d);
  return latest;
}
function definition(state: FlowState, session: SessionContext, flowId: string): FlowDefinition {
  const found = currentDefinitions(state, session).get(flowId); if (!found) throw new DataflowError('Datenfluss nicht gefunden.', 404); return found;
}
function latestModels(state: SemanticState, session: SessionContext): Map<string, StoredObjectSet> {
  const latest = new Map<string, StoredObjectSet>();
  for (const s of Object.values(state.objectSets)) if (owned(s.objectSet, session) && (latest.get(s.objectSet.familyId)?.objectSet.revision ?? 0) < s.objectSet.revision) latest.set(s.objectSet.familyId, s);
  return latest;
}
function published(state: SemanticState, session: SessionContext, flowId: string, runId?: string) {
  return Object.values(state.objectSets).map(s => s.objectSet).filter(s => owned(s, session) && s.familyId === flowId
    && (runId ? s.source.datasetId === `dataflow:${flowId}:${runId}` : s.source.datasetId.startsWith(`dataflow:${flowId}:`)))
    .sort((a, b) => b.revision - a.revision)[0];
}
function summarize(run: FlowRun, models: SemanticState, session: SessionContext): FlowRunSummary {
  const { rows: _, ...rest } = run; const latest = latestModels(models, session);
  const output = published(models, session, run.flowId, run.id);
  return { ...rest, ...(output ? { published: output } : {}), sourcesChanged: run.sources.some(s => latest.get(s.familyId)?.objectSet.id !== s.setId) };
}
function assertNoCycle(state: FlowState, candidate: FlowDefinition, session: SessionContext) {
  const definitions = currentDefinitions(state, session); definitions.set(candidate.flowId, candidate);
  const active = new Set<string>(); const visited = new Set<string>();
  function visit(id: string) {
    if (active.has(id)) throw new DataflowError('Ein Datenfluss darf nicht von seiner eigenen Ausgabe abhängen, auch nicht über weitere Datenflüsse.');
    if (visited.has(id)) return;
    active.add(id); const d = definitions.get(id);
    if (d) for (const dependency of familyIds(d)) if (dependency === candidate.flowId || definitions.has(dependency)) visit(dependency);
    active.delete(id); visited.add(id);
  }
  visit(candidate.flowId);
}

function upstreamIssues(graph: FlowDependencyGraph, flowId: string): string[] {
  const node = graph.nodes.find(item => item.flowId === flowId);
  if (!node) throw new DataflowError('Datenfluss nicht gefunden.', 404);
  if (node.status === 'unavailable') return node.issues.length ? node.issues : ['Die Herkunft einer Quelle ist nicht vollständig verfügbar.'];
  return node.dependsOn.flatMap(id => {
    const dependency = graph.nodes.find(item => item.flowId === id);
    return dependency?.status === 'current' ? [] : [dependency
      ? `Bitte zuerst „${dependency.name}“ aktualisieren und das geprüfte Ergebnis veröffentlichen.`
      : 'Ein vorgelagerter Datenfluss ist nicht verfügbar. Bitte die Quelle prüfen.'];
  });
}

export function createDataflowService(options: DataflowOptions) {
  const store = new FileDataflowStore(options.root); const models = new FileSemanticModelStore(options.root);
  function authorize(session: SessionContext, write = false) {
    if (!session?.user?.id || !session?.tenant?.id) throw new DataflowError('Bitte anmelden.', 401);
    if (session.tenant.status !== 'active' || !session.roleIds.includes('owner')) throw new DataflowError('Nur der Inhaber kann Datenflüsse verwenden.', 403);
    try { options.assertPermissions(session, write ? ['datasets.read', 'datasets.manage'] : ['datasets.read']); }
    catch { throw new DataflowError('Keine Berechtigung für diesen Datenfluss.', 403); }
  }
  async function current(session: SessionContext, write = false) {
    authorize(session, write); const live = await options.resolvePrincipal({ userId: session.user.id, tenantId: session.tenant.id });
    if (!live || live.user.id !== session.user.id || live.tenant.id !== session.tenant.id) throw new DataflowError('Die Datenflussberechtigung ist nicht mehr gültig.', 403);
    authorize(live, write);
  }
  function receipt(state: FlowState, session: SessionContext, operation: 'definition' | 'run', requestId: string, payload: unknown) {
    const identity = { tenantId: session.tenant.id, ownerId: session.user.id, operation, requestId };
    const key = flowReceiptKey(identity); const payloadHash = semanticHash(payload); const prior = state.requests[key];
    if (prior && prior.payloadHash !== payloadHash) throw new DataflowError('Diese Anfrage wurde bereits mit anderen Angaben verwendet.', 409);
    return { key, prior, value: { ...identity, payloadHash } };
  }
  async function read<T>(session: SessionContext, project: (state: FlowState, model: SemanticState) => T) {
    await current(session); const state = await store.read(); const model = await models.read(); const result = project(state, model); await current(session); return result;
  }
  function storedRun(state: FlowState, session: SessionContext, flowId: string, id: string): FlowRun {
    definition(state, session, flowId); const r = state.runs[id];
    if (!r || r.flowId !== flowId || !owned(r, session)) throw new DataflowError('Durchlauf nicht gefunden.', 404); return r;
  }
  return {
    async dependencies(session: SessionContext): Promise<FlowDependencyGraph> {
      await current(session);
      // Serialize the two-store read with flow publications so a freshly
      // published semantic output cannot precede its corresponding flow run.
      return store.update(async state => projectDependencies(state, await models.read(),
        { ownerId: session.user.id, tenantId: session.tenant.id }), () => current(session));
    },
    list(session: SessionContext): Promise<FlowSummary[]> {
      return read(session, (state, model) => [...currentDefinitions(state, session).values()].map(d => {
        const run = Object.values(state.runs).filter(r => r.flowId === d.flowId && owned(r, session)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
        const output = published(model, session, d.flowId);
        return { id: d.flowId, name: d.spec.name, description: d.spec.description, revision: d.revision, definitionId: d.id, updatedAt: d.createdAt,
          inputFamilyIds: familyIds(d), ...(run ? { latestRun: summarize(run, model, session) } : {}), ...(output ? { published: output } : {}) };
      }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)));
    },
    get(session: SessionContext, rawId: string): Promise<FlowDetail> {
      const id = uuid(rawId); return read(session, (state, model) => {
        const d = definition(state, session, id); const output = published(model, session, id);
        return { definition: d, revisions: Object.values(state.definitions).filter(d => d.flowId === id && owned(d, session)).sort((a, b) => b.revision - a.revision),
          runs: Object.values(state.runs).filter(r => r.flowId === id && owned(r, session)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).map(r => summarize(r, model, session)),
          ...(output ? { published: output } : {}) };
      });
    },
    async save(session: SessionContext, raw: unknown): Promise<FlowDefinition> {
      await current(session, true); const input = body(raw, ['spec', 'confirmed', 'requestId'], ['previousId']);
      const spec = validateFlowSpec(input.spec); const requestId = uuid(input.requestId); const previousId = input.previousId === undefined ? undefined : uuid(input.previousId);
      return store.update(async state => {
        const request = receipt(state, session, 'definition', requestId, { spec, previousId: previousId ?? null });
        if (request.prior) return state.definitions[request.prior.entityId]!;
        if (Object.keys(state.definitions).length >= FLOW_LIMITS.definitions) throw new DataflowError('Die Datenflussablage hat ihre Versionsgrenze erreicht.', 413);
        const previous = previousId ? state.definitions[previousId] : undefined;
        if (previousId && (!previous || !owned(previous, session))) throw new DataflowError('Datenflussversion nicht gefunden.', 404);
        if (previous && definition(state, session, previous.flowId).id !== previous.id) throw new DataflowError('Der Datenfluss wurde inzwischen geändert. Bitte neu laden und erneut bestätigen.', 409);
        const sources = latestModels(await models.read(), session); const bindings = familyIds({ spec }).map(familyId => {
          const source = sources.get(familyId); if (!source) throw new DataflowError('Mindestens eine bestätigte Objektfamilie ist nicht verfügbar.');
          return { familyId, schemaHash: semanticHash(source.schema) };
        });
        const d: FlowDefinition = { id: randomUUID(), flowId: previous?.flowId ?? randomUUID(), revision: (previous?.revision ?? 0) + 1,
          ...(previous ? { previousId: previous.id } : {}), tenantId: session.tenant.id, ownerId: session.user.id, createdAt: new Date().toISOString(), spec, bindings, definitionHash: '' };
        assertNoCycle(state, d, session); d.definitionHash = definitionHash(d);
        state.definitions[d.id] = d; state.requests[request.key] = { ...request.value, entityId: d.id }; return d;
      }, () => current(session, true));
    },
    async run(session: SessionContext, rawId: string, raw: unknown): Promise<FlowRunSummary> {
      await current(session, true); const flowId = uuid(rawId); const input = body(raw, ['definitionId', 'requestId', 'confirmed']);
      const definitionId = uuid(input.definitionId); const requestId = uuid(input.requestId);
      const run = await store.update(async state => {
        const request = receipt(state, session, 'run', requestId, { flowId, definitionId });
        if (request.prior) return storedRun(state, session, flowId, request.prior.entityId);
        const d = definition(state, session, flowId);
        if (d.id !== definitionId) throw new DataflowError('Bitte die aktuelle Datenflussversion laden und den Durchlauf erneut bestätigen.', 409);
        if (Object.keys(state.runs).length >= FLOW_LIMITS.runs) throw new DataflowError('Die Datenflussablage hat ihre Durchlaufgrenze erreicht.', 413);
        const model = await models.read(); const latest = latestModels(model, session); const inputs = new Map<string, FlowInput>();
        const issues = upstreamIssues(projectDependencies(state, model, { ownerId: session.user.id, tenantId: session.tenant.id }), flowId);
        for (const binding of d.bindings) {
          const s = latest.get(binding.familyId);
          if (!s) { issues.push('Eine bestätigte Quellfamilie ist nicht mehr verfügbar.'); continue; }
          const o = s.objectSet;
          inputs.set(binding.familyId, { source: { familyId: o.familyId, setId: o.id, revision: o.revision, name: o.name,
            snapshotHash: o.snapshotHash, sourceHash: o.source.hash, rowCount: o.source.rowCount }, rows: s.rows, schema: s.schema });
          if (semanticHash(s.schema) !== binding.schemaHash) issues.push(`Das Schema von „${o.name}“ hat sich geändert. Bitte eine neue Datenflussversion bestätigen.`);
        }
        const result: FlowEvaluation = issues.length ? { status: 'blocked', issues, rows: [], schema: [], rowCount: 0, outputHash: rowsHash([]), steps: [] } : evaluateFlow(d.spec, inputs);
        const previous = published(model, session, flowId);
        const r: FlowRun = { ...result, id: randomUUID(), flowId, definitionId, tenantId: session.tenant.id, ownerId: session.user.id,
          createdAt: new Date().toISOString(), engineVersion: DATAFLOW_ENGINE, sources: [...inputs.values()].map(i => i.source),
          ...(previous ? { expectedPreviousId: previous.id } : {}), runHash: '' };
        r.runHash = runHash(r); state.runs[r.id] = r; state.requests[request.key] = { ...request.value, entityId: r.id }; return r;
      }, () => current(session, true));
      const summary = summarize(run, await models.read(), session); await current(session); return summary;
    },
    getRun(session: SessionContext, rawFlowId: string, rawRunId: string, rawQuery: unknown = {}) {
      const flowId = uuid(rawFlowId); const id = uuid(rawRunId); const pagination = page(rawQuery);
      return read(session, (state, model) => { const run = storedRun(state, session, flowId, id);
        return { run: summarize(run, model, session), rows: run.rows.slice(pagination.offset, pagination.offset + pagination.limit), ...pagination }; });
    },
    async publish(session: SessionContext, rawFlowId: string, rawRunId: string, raw: unknown) {
      await current(session, true); body(raw, ['confirmed']); const flowId = uuid(rawFlowId); const id = uuid(rawRunId);
      // Lock definitions while the semantic store atomically checks sources and publishes.
      // Publication itself is the semantic receipt; no second mutable publication pointer.
      return store.update(async state => {
        const run = storedRun(state, session, flowId, id); const d = state.definitions[run.definitionId]!;
        const prior = published(await models.read(), session, flowId, id);
        if (prior) return prior;
        if (run.status !== 'ready') throw new DataflowError('Dieser Durchlauf erfüllt die Qualitätsregeln nicht und kann nicht veröffentlicht werden.', 409);
        if (definition(state, session, flowId).id !== d.id) throw new DataflowError('Der Datenfluss wurde inzwischen geändert. Bitte die aktuelle Version ausführen.', 409);
        return options.semanticModel.publishDataflow(session, { flowId, definitionId: d.id, runId: run.id, name: d.spec.name,
          keyField: d.spec.keyField, ...(d.spec.labelField ? { labelField: d.spec.labelField } : {}), rows: run.rows, schema: run.schema,
          createdAt: run.createdAt, ...(run.expectedPreviousId ? { expectedPreviousId: run.expectedPreviousId } : {}),
          sources: run.sources.map(s => ({ setId: s.setId, snapshotHash: s.snapshotHash })) }, currentModels => {
          // Definitions are locked by the outer flow update; the semantic store
          // supplies current sources inside its publication write operation.
          const issues = upstreamIssues(projectDependencies(state, currentModels,
            { ownerId: session.user.id, tenantId: session.tenant.id }), flowId);
          if (issues.length) throw new DataflowError(issues.join(' '), 409);
        });
      }, () => current(session, true));
    },
  };
}
export type DataflowService = ReturnType<typeof createDataflowService>;
