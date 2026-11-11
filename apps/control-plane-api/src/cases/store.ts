import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { CaseRecord } from './contracts.js';
import { validateCaseEvidence } from './evidence.js';

export interface CaseState {
  version: 1;
  cases: Record<string, CaseRecord>;
  requests: Record<string, { hash: string; caseId: string }>;
  findings: Record<string, string>;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, fields: string[]) => Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value === value.trim() && value.length <= max;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const instant = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const caseHash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export const findingKey = (tenantId: string, ownerId: string, missionId: string, sourceRow: number) => caseHash([tenantId, ownerId, missionId, sourceRow]);
function corrupt(): never { throw new Error('Die Fallablage ist beschädigt. Bestehende Daten wurden nicht verändert.'); }

function validateCase(value: unknown): asserts value is CaseRecord {
  if (!record(value) || !keys(value, ['id', 'tenantId', 'ownerId', 'title', 'status', 'revision', 'createdAt', 'updatedAt', 'evidence', 'evidenceHash', 'assignee', 'resolution', 'events'])
    || !uuid(value.id) || !text(value.tenantId, 200) || !text(value.ownerId, 200) || !text(value.title, 180)
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 || !instant(value.createdAt) || !instant(value.updatedAt)
    || value.updatedAt < value.createdAt || !digest(value.evidenceHash) || !Array.isArray(value.events)
    || value.events.length !== value.revision || value.events.length > 10000) corrupt();
  const evidence = validateCaseEvidence(value.evidence);
  if (caseHash(evidence) !== value.evidenceHash) corrupt();
  let status = 'open'; let assignee: { id: string; displayName: string } | null = null; let resolution: string | null = null;
  let previousAt = value.createdAt as string;
  for (const [index, event] of value.events.entries()) {
    if (!record(event) || !keys(event, ['at', 'actorId', 'actorName', 'kind', 'note']) || !instant(event.at)
      || event.at < previousAt || event.actorId !== value.ownerId || !text(event.actorName, 200)) corrupt();
    previousAt = event.at;
    if (index === 0) {
      if (event.kind !== 'created' || event.at !== value.createdAt || event.note !== null) corrupt();
    } else if (event.kind === 'claimed' && status === 'open' && event.note === null) {
      status = 'in_progress'; assignee = { id: event.actorId as string, displayName: event.actorName as string };
    } else if (event.kind === 'resolved' && status === 'in_progress' && text(event.note, 2000)) {
      status = 'resolved'; resolution = event.note;
    } else if (event.kind === 'reopened' && status === 'resolved' && text(event.note, 2000)) {
      status = 'open'; assignee = null; resolution = null;
    } else corrupt();
  }
  if (value.updatedAt !== previousAt || value.status !== status || canonical(value.assignee) !== canonical(assignee) || value.resolution !== resolution) corrupt();
}
function parse(raw: string): CaseState {
  const value: unknown = JSON.parse(raw);
  if (!record(value) || !keys(value, ['version', 'cases', 'requests', 'findings']) || value.version !== 1
    || !record(value.cases) || !record(value.requests) || !record(value.findings)) corrupt();
  if (Object.keys(value.cases).length > 10000) corrupt();
  const expected: Record<string, string> = {};
  for (const [id, entry] of Object.entries(value.cases)) {
    validateCase(entry); if (entry.id !== id) corrupt();
    const key = findingKey(entry.tenantId, entry.ownerId, entry.evidence.missionId, entry.evidence.sourceRow);
    if (Object.hasOwn(expected, key)) corrupt(); expected[key] = id;
  }
  if (canonical(expected) !== canonical(value.findings)) corrupt();
  for (const [key, receipt] of Object.entries(value.requests)) {
    if (!digest(key) || !record(receipt) || !keys(receipt, ['hash', 'caseId']) || !digest(receipt.hash)
      || !uuid(receipt.caseId) || !Object.hasOwn(value.cases, receipt.caseId)) corrupt();
  }
  return value as unknown as CaseState;
}
const queues = new Map<string, Promise<void>>();
/** Case, business-key uniqueness, events and idempotency receipt commit together. */
export class FileCaseStore {
  readonly path: string;
  constructor(root: string) { this.path = resolve(join(root, 'cases', 'state.json')); }
  async read(): Promise<CaseState> {
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.size > 64 * 1024 * 1024) corrupt();
      return parse(await readFile(this.path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, cases: {}, requests: {}, findings: {} };
      throw error;
    }
  }
  async update<T>(change: (state: CaseState) => T | Promise<T>, beforeCommit: () => Promise<void>): Promise<T> {
    const previous = queues.get(this.path) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const state = await this.read(); const result = await change(state); const bytes = JSON.stringify(state);
      parse(bytes);
      if (Buffer.byteLength(bytes) > 64 * 1024 * 1024) throw new Error('Die Fallablage hat ihre Größenbegrenzung erreicht.');
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
