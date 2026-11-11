import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { rowsHash, validateRows } from '../import-capability/isolated-executor.js';
import { isRecord, safeField, SEMANTIC_UUID, semanticHash } from '../semantic-model/store.js';
import { DATAFLOW_ENGINE, DataflowError, type FlowDefinition, type FlowRun } from './contracts.js';
import { validateFlowSpec } from './engine.js';

interface Receipt { tenantId: string; ownerId: string; operation: 'definition' | 'run'; requestId: string; payloadHash: string; entityId: string }
export interface FlowState { definitions: Record<string, FlowDefinition>; runs: Record<string, FlowRun>; requests: Record<string, Receipt> }
export const FLOW_LIMITS = { definitions: 300, runs: 300, bytes: 64 * 1024 * 1024 } as const;
const queues = new Map<string, Promise<void>>();
export const flowReceiptKey = (r: Pick<Receipt, 'tenantId' | 'ownerId' | 'operation' | 'requestId'>) => semanticHash([r.tenantId, r.ownerId, r.operation, r.requestId]);
export const definitionHash = (d: Pick<FlowDefinition, 'spec' | 'bindings'>) => semanticHash({ engineVersion: DATAFLOW_ENGINE, spec: d.spec, bindings: d.bindings });
export function runHash(run: Omit<FlowRun, 'runHash'> | FlowRun): string { const { runHash: _, ...rest } = run as FlowRun; return semanticHash(rest); }
const uuid = (v: unknown): v is string => typeof v === 'string' && SEMANTIC_UUID.test(v);
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const text = (v: unknown, max = 200): v is string => typeof v === 'string' && !!v.trim() && v.length <= max;
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const instant = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const keys = (v: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
function damaged(): never { throw new Error('Die Datenflussablage ist beschädigt. Bestehende Daten wurden nicht verändert.'); }
export function familyIds(d: Pick<FlowDefinition, 'spec'>): string[] { return [...new Set([d.spec.inputFamilyId, ...d.spec.joins.map(j => j.familyId)])]; }

function validate(value: unknown): FlowState {
  if (!isRecord(value) || !keys(value, ['definitions', 'runs', 'requests']) || !isRecord(value.definitions) || !isRecord(value.runs) || !isRecord(value.requests)) damaged();
  const state = value as unknown as FlowState;
  if (Object.keys(state.definitions).length > FLOW_LIMITS.definitions || Object.keys(state.runs).length > FLOW_LIMITS.runs) damaged();
  const revisions = new Set<string>();
  for (const [id, d] of Object.entries(state.definitions)) {
    if (!isRecord(d) || !keys(d, ['id', 'flowId', 'revision', 'tenantId', 'ownerId', 'createdAt', 'spec', 'bindings', 'definitionHash'], ['previousId'])
      || id !== d.id || !uuid(id) || !uuid(d.flowId) || !text(d.tenantId) || !text(d.ownerId) || !integer(d.revision) || d.revision < 1
      || !instant(d.createdAt) || !Array.isArray(d.bindings) || d.bindings.length < 1 || d.bindings.length > 3
      || !d.bindings.every(b => isRecord(b) && keys(b, ['familyId', 'schemaHash']) && uuid(b.familyId) && digest(b.schemaHash))) damaged();
    let normalized;
    try { normalized = validateFlowSpec(d.spec); } catch { damaged(); }
    if (semanticHash(normalized) !== semanticHash(d.spec) || definitionHash(d) !== d.definitionHash
      || semanticHash(familyIds(d)) !== semanticHash(d.bindings.map(b => b.familyId)) || familyIds(d).includes(d.flowId)) damaged();
    const key = `${d.flowId}:${d.revision}`; if (revisions.has(key)) damaged(); revisions.add(key);
    if (d.previousId !== undefined) {
      const previous = uuid(d.previousId) ? state.definitions[d.previousId] : undefined;
      if (!previous || previous.flowId !== d.flowId || previous.revision + 1 !== d.revision || previous.ownerId !== d.ownerId || previous.tenantId !== d.tenantId) damaged();
    } else if (d.revision !== 1) damaged();
  }
  for (const [id, r] of Object.entries(state.runs)) {
    if (!isRecord(r) || !keys(r, ['id', 'flowId', 'definitionId', 'tenantId', 'ownerId', 'createdAt', 'engineVersion', 'sources', 'runHash', 'status', 'issues', 'rows', 'schema', 'rowCount', 'outputHash', 'steps'], ['expectedPreviousId'])
      || r.id !== id || !uuid(id) || !uuid(r.flowId) || !uuid(r.definitionId) || !text(r.tenantId) || !text(r.ownerId) || !instant(r.createdAt)
      || r.engineVersion !== DATAFLOW_ENGINE || !['ready', 'blocked'].includes(r.status) || !digest(r.outputHash) || !digest(r.runHash)
      || !integer(r.rowCount) || r.rowCount > 10000 || (r.expectedPreviousId !== undefined && !uuid(r.expectedPreviousId))
      || !Array.isArray(r.issues) || r.issues.length > 30 || !r.issues.every(i => text(i, 1000))
      || (r.status === 'ready' ? r.issues.length !== 0 : r.issues.length === 0)
      || !Array.isArray(r.schema) || r.schema.length > 512 || !r.schema.every(f => isRecord(f) && keys(f, ['name', 'type'], ['nullable']) && safeField(f.name)
        && ['string', 'number', 'integer', 'boolean', 'date', 'datetime', 'json'].includes(String(f.type)) && (f.nullable === undefined || typeof f.nullable === 'boolean'))
      || new Set(r.schema.map(f => f.name)).size !== r.schema.length || !Array.isArray(r.sources) || r.sources.length > 3
      || !r.sources.every(s => isRecord(s) && keys(s, ['familyId', 'setId', 'revision', 'name', 'snapshotHash', 'sourceHash', 'rowCount'])
        && uuid(s.familyId) && uuid(s.setId) && integer(s.revision) && s.revision > 0 && text(s.name) && digest(s.snapshotHash) && digest(s.sourceHash) && integer(s.rowCount))
      || new Set(r.sources.map(s => s.familyId)).size !== r.sources.length
      || !Array.isArray(r.steps) || r.steps.length > 15 || !r.steps.every(s => isRecord(s) && keys(s, ['label', 'rowsIn', 'rowsOut'], ['unmatched'])
        && text(s.label, 1000) && integer(s.rowsIn) && integer(s.rowsOut) && (s.unmatched === undefined || integer(s.unmatched)))) damaged();
    const definition = state.definitions[r.definitionId];
    if (!definition || definition.flowId !== r.flowId || definition.ownerId !== r.ownerId || definition.tenantId !== r.tenantId
      || r.sources.some(s => !familyIds(definition).includes(s.familyId)) || (r.status === 'ready' && r.sources.length !== familyIds(definition).length)) damaged();
    let rows;
    try { rows = validateRows(r.rows); } catch { damaged(); }
    const columns = r.schema.map(f => f.name);
    if (rows.length !== r.rowCount || rowsHash(rows) !== r.outputHash || runHash(r) !== r.runHash
      || (r.status === 'blocked' && rows.length !== 0) || rows.some(row => Object.keys(row).some(k => !columns.includes(k)))) damaged();
  }
  const entities = new Set<string>();
  for (const [key, r] of Object.entries(state.requests)) {
    if (!isRecord(r) || !keys(r, ['tenantId', 'ownerId', 'operation', 'requestId', 'payloadHash', 'entityId'])
      || !text(r.tenantId) || !text(r.ownerId) || !['definition', 'run'].includes(r.operation) || !uuid(r.requestId) || !uuid(r.entityId)
      || !digest(r.payloadHash) || key !== flowReceiptKey(r)) damaged();
    const entity = r.operation === 'definition' ? state.definitions[r.entityId] : state.runs[r.entityId];
    if (!entity || entity.ownerId !== r.ownerId || entity.tenantId !== r.tenantId || entities.has(r.entityId)) damaged();
    entities.add(r.entityId);
  }
  if (entities.size !== Object.keys(state.definitions).length + Object.keys(state.runs).length) damaged();
  return state;
}

export class FileDataflowStore {
  readonly path: string;
  constructor(root: string) { this.path = resolve(join(root, 'dataflows', 'state.json')); }
  async read(): Promise<FlowState> {
    let bytes: string;
    try {
      const stat = await lstat(this.path); if (!stat.isFile() || stat.size > FLOW_LIMITS.bytes) damaged();
      bytes = await readFile(this.path, 'utf8'); if (Buffer.byteLength(bytes) > FLOW_LIMITS.bytes) damaged();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { definitions: {}, runs: {}, requests: {} };
      throw error;
    }
    const envelope: unknown = JSON.parse(bytes);
    if (!isRecord(envelope) || !keys(envelope, ['version', 'integrityHash', 'state']) || envelope.version !== 1 || envelope.integrityHash !== semanticHash(envelope.state)) damaged();
    return validate(envelope.state);
  }
  async update<T>(change: (state: FlowState) => Promise<T> | T, beforeCommit: () => Promise<void>): Promise<T> {
    const previous = queues.get(this.path) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const state = await this.read(); const before = semanticHash(state);
      const result = await change(state); validate(state); const integrityHash = semanticHash(state);
      if (before === integrityHash) { await beforeCommit(); return structuredClone(result); }
      const bytes = JSON.stringify({ version: 1, integrityHash, state });
      if (Buffer.byteLength(bytes) > FLOW_LIMITS.bytes) throw new DataflowError('Die Datenflussablage hat ihre Größenbegrenzung erreicht.', 413);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        await beforeCommit(); await rename(temporary, this.path);
        if (process.platform === 'linux') { const dir = await open(dirname(this.path), 'r'); try { await dir.sync(); } finally { await dir.close(); } }
      } finally { await rm(temporary, { force: true }).catch(() => undefined); }
      return structuredClone(result);
    });
    const settled = operation.then(() => undefined, () => undefined); queues.set(this.path, settled);
    try { return await operation; } finally { if (queues.get(this.path) === settled) queues.delete(this.path); }
  }
}
