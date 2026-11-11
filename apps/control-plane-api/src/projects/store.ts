import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isRecord, SEMANTIC_UUID, semanticHash } from '../semantic-model/store.js';
import { ProjectError, type Project } from './contracts.js';

interface Receipt { tenantId: string; ownerId: string; requestId: string; payloadHash: string; projectId: string; revision: number }
export interface ProjectState { projects: Record<string, Project>; requests: Record<string, Receipt> }
export const PROJECT_LIMITS = { projects: 100, events: 1000, receipts: 10000, bytes: 16 * 1024 * 1024 } as const;
const queues = new Map<string, Promise<void>>();
const uuid = (v: unknown): v is string => typeof v === 'string' && SEMANTIC_UUID.test(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const instant = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const keys = (v: Record<string, unknown>, names: string[]) => names.length === Object.keys(v).length && names.every(k => Object.hasOwn(v, k));
export const idList = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length <= max && v.every(uuid) && new Set(v).size === v.length;
export const projectReceiptKey = (r: Pick<Receipt, 'tenantId' | 'ownerId' | 'requestId'>) => semanticHash([r.tenantId, r.ownerId, r.requestId]);
function damaged(): never { throw new Error('Die Projektablage ist beschädigt. Bestehende Daten wurden nicht verändert.'); }

function validate(value: unknown): ProjectState {
  if (!isRecord(value) || !keys(value, ['projects', 'requests']) || !isRecord(value.projects) || !isRecord(value.requests)) damaged();
  const state = value as unknown as ProjectState;
  if (Object.keys(state.projects).length > PROJECT_LIMITS.projects || Object.keys(state.requests).length > PROJECT_LIMITS.receipts) damaged();
  for (const [id, p] of Object.entries(state.projects)) {
    if (!isRecord(p) || !keys(p, ['id', 'tenantId', 'ownerId', 'name', 'description', 'revision', 'createdAt', 'updatedAt', 'familyIds', 'memberIds', 'events'])
      || !uuid(id) || p.id !== id || !text(p.tenantId, 200) || !uuid(p.ownerId) || !text(p.name, 120)
      || typeof p.description !== 'string' || p.description.length > 2000 || !instant(p.createdAt) || !instant(p.updatedAt)
      || !Number.isSafeInteger(p.revision) || p.revision < 1 || !idList(p.familyIds, 1000) || !idList(p.memberIds, 100)
      || p.memberIds.includes(p.ownerId) || !Array.isArray(p.events) || p.events.length !== p.revision || p.events.length > PROJECT_LIMITS.events) damaged();
    const families = new Set<string>(); const members = new Set<string>(); let previousAt = p.createdAt;
    for (const [index, e] of p.events.entries()) {
      if (!isRecord(e) || !keys(e, ['revision', 'at', 'actorId', 'kind', 'addedFamilies', 'removedFamilies', 'addedMembers', 'removedMembers'])
        || e.revision !== index + 1 || e.actorId !== p.ownerId || !instant(e.at) || Date.parse(e.at) < Date.parse(previousAt)
        || e.kind !== (index === 0 ? 'created' : 'updated') || !idList(e.addedFamilies, 1000) || !idList(e.removedFamilies, 1000)
        || !idList(e.addedMembers, 100) || !idList(e.removedMembers, 100) || e.addedMembers.includes(p.ownerId) || e.removedMembers.includes(p.ownerId)) damaged();
      for (const [current, added, removed] of [[families, e.addedFamilies, e.removedFamilies], [members, e.addedMembers, e.removedMembers]] as const) {
        if (added.some(id => current.has(id) || removed.includes(id)) || removed.some(id => !current.has(id))) damaged();
        removed.forEach(id => current.delete(id)); added.forEach(id => current.add(id));
      }
      if (index === 0 && e.at !== p.createdAt) damaged();
      previousAt = e.at;
    }
    if (previousAt !== p.updatedAt || semanticHash([...families].sort()) !== semanticHash([...p.familyIds].sort())
      || semanticHash([...members].sort()) !== semanticHash([...p.memberIds].sort())) damaged();
  }
  const revisions = new Set<string>();
  for (const [key, r] of Object.entries(state.requests)) {
    if (!isRecord(r) || !keys(r, ['tenantId', 'ownerId', 'requestId', 'payloadHash', 'projectId', 'revision'])
      || !text(r.tenantId, 200) || !uuid(r.ownerId) || !uuid(r.requestId) || !uuid(r.projectId)
      || typeof r.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(r.payloadHash) || key !== projectReceiptKey(r)
      || !Number.isSafeInteger(r.revision) || r.revision < 1) damaged();
    const p = state.projects[r.projectId]; const revisionKey = `${r.projectId}:${r.revision}`;
    if (!p || p.tenantId !== r.tenantId || p.ownerId !== r.ownerId || r.revision > p.revision || revisions.has(revisionKey)) damaged();
    revisions.add(revisionKey);
  }
  if (revisions.size !== Object.values(state.projects).reduce((n, p) => n + p.revision, 0)) damaged();
  return state;
}

/** One writing API process, guarded by the server's canonical state lease. */
export class FileProjectStore {
  readonly path: string;
  constructor(root: string) { this.path = resolve(join(root, 'projects', 'state.json')); }
  async read(): Promise<ProjectState> {
    let bytes: string;
    try {
      const stat = await lstat(this.path);
      if (!stat.isFile() || stat.size > PROJECT_LIMITS.bytes) damaged();
      bytes = await readFile(this.path, 'utf8');
      if (Buffer.byteLength(bytes) > PROJECT_LIMITS.bytes) damaged();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { projects: {}, requests: {} };
      throw error;
    }
    const envelope: unknown = JSON.parse(bytes);
    if (!isRecord(envelope) || !keys(envelope, ['version', 'integrityHash', 'state']) || envelope.version !== 1
      || envelope.integrityHash !== semanticHash(envelope.state)) damaged();
    return validate(envelope.state);
  }
  async update<T>(change: (state: ProjectState) => T | Promise<T>, beforeCommit: () => Promise<void>): Promise<T> {
    const previous = queues.get(this.path) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const state = await this.read(); const before = semanticHash(state);
      const result = await change(state); validate(state);
      const integrityHash = semanticHash(state);
      if (before === integrityHash) { await beforeCommit(); return structuredClone(result); }
      const bytes = JSON.stringify({ version: 1, integrityHash, state });
      if (Buffer.byteLength(bytes) > PROJECT_LIMITS.bytes) throw new ProjectError('Die Projektablage ist voll.', 409);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        await beforeCommit(); await rename(temporary, this.path);
        if (process.platform === 'linux') {
          const directory = await open(dirname(this.path), 'r');
          try { await directory.sync(); } finally { await directory.close(); }
        }
      } finally { await rm(temporary, { force: true }).catch(() => undefined); }
      return structuredClone(result);
    });
    const settled = operation.then(() => undefined, () => undefined); queues.set(this.path, settled);
    try { return await operation; } finally { if (queues.get(this.path) === settled) queues.delete(this.path); }
  }
}
