import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Mission, MissionStatus } from './contracts.js';
import type { RoutineDefinition } from '../routines/contracts.js';
import { validateRoutineDefinition } from '../routines/prepare.js';
import { orderReviewRuleHash, validateOrderReviewInput } from '../domain/orders/review.js';

export interface MissionState {
  version: 1;
  missions: Record<string, Mission>;
  requests: Record<string, { hash: string; missionId: string }>;
  routines: Record<string, { definition: RoutineDefinition; hash: string }>;
  routineRequests: Record<string, { hash: string; routineId: string }>;
}
const states: MissionStatus[] = ['queued', 'planning', 'awaiting_confirmation', 'running', 'completed', 'blocked', 'interrupted'];
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const queues = new Map<string, Promise<void>>();
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function routineDefinitionHash(value: RoutineDefinition): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function parse(raw: string): MissionState {
  const value: unknown = JSON.parse(raw);
  if (!record(value) || value.version !== 1 || !record(value.missions) || !record(value.requests)) {
    throw new Error('Die Auftragsablage ist beschädigt. Bestehende Daten wurden nicht verändert.');
  }
  for (const [id, m] of Object.entries(value.missions)) {
    if (!record(m) || m.id !== id || typeof m.tenantId !== 'string' || !m.tenantId
      || typeof m.ownerId !== 'string' || !m.ownerId || typeof m.question !== 'string'
      || !m.question.trim() || m.question.length > 1000 || typeof m.datasetId !== 'string'
      || !m.datasetId || !Number.isSafeInteger(m.revision) || (m.revision as number) < 1
      || !states.includes(m.status as MissionStatus) || !['plan', 'execute'].includes(m.phase as string)
      || typeof m.createdAt !== 'string' || typeof m.updatedAt !== 'string' || !Array.isArray(m.events)
      || !m.events.every(e => record(e) && typeof e.at === 'string' && typeof e.message === 'string'
        && states.includes(e.status as MissionStatus))
      || (m.status === 'completed' && (!record(m.result) || !record(m.source) || !record(m.plan)))) {
      throw new Error('Die Auftragsablage enthält einen ungültigen Auftrag. Bestehende Daten wurden nicht verändert.');
    }
  }
  for (const request of Object.values(value.requests)) {
    if (!record(request) || typeof request.hash !== 'string' || typeof request.missionId !== 'string'
      || !Object.hasOwn(value.missions, request.missionId)) throw new Error('Die Auftragsannahme ist beschädigt.');
  }
  // Additive v1 migration: old mission files need no reset or offline rewrite.
  if (!Object.hasOwn(value, 'routines')) value.routines = {};
  if (!Object.hasOwn(value, 'routineRequests')) value.routineRequests = {};
  if (!record(value.routines) || !record(value.routineRequests)) throw new Error('Die Routinenablage ist beschädigt.');
  for (const [id, entry] of Object.entries(value.routines)) {
    if (!record(entry) || Object.keys(entry).some(key => !['definition', 'hash'].includes(key))) throw new Error('Ungültige gespeicherte Routine.');
    const definition = validateRoutineDefinition(entry.definition);
    const origin = value.missions[definition.sourceMissionId];
    if (definition.id !== id || entry.hash !== routineDefinitionHash(definition) || !record(origin)
      || origin.status !== 'completed' || origin.ownerId !== definition.ownerId || origin.tenantId !== definition.tenantId
      || !record(origin.result) || !record(origin.result.evidence)
      || origin.result.evidence.orderRuleHash !== definition.baseline.orderRuleHash
      || !record(origin.plan) || origin.plan.capabilityId !== definition.capabilityId || origin.plan.capabilityVersion !== definition.capabilityVersion
      || canonical(origin.source) !== canonical(definition.baseline.source)
      || canonical(origin.plan.relationship) !== canonical(definition.baseline.relationship)
      || canonical(origin.result.counts) !== canonical(definition.baseline.counts)
      || canonical(origin.input) !== canonical({ confirmed: true, binding: definition.binding, orderRule: definition.orderRule })) {
      throw new Error('Die Routine stimmt nicht mit ihrer gespeicherten Definition und Herkunft überein.');
    }
  }
  for (const entry of Object.values(value.routineRequests)) {
    if (!record(entry) || typeof entry.hash !== 'string' || typeof entry.routineId !== 'string'
      || !Object.hasOwn(value.routines, entry.routineId)) throw new Error('Die Routinenannahme ist beschädigt.');
  }
  for (const m of Object.values(value.missions)) {
    if (!record(m) || m.routine === undefined) continue;
    if (!record(m.routine) || typeof m.routine.id !== 'string' || !Object.hasOwn(value.routines, m.routine.id)) throw new Error('Die Routinenherkunft des Auftrags ist beschädigt.');
    const definition = (value.routines[m.routine.id] as { definition: RoutineDefinition }).definition;
    if (m.ownerId !== definition.ownerId || m.tenantId !== definition.tenantId || m.routine.name !== definition.name
      || m.routine.sourceMissionId !== definition.sourceMissionId || m.routine.baselineRuleHash !== definition.baseline.orderRuleHash
      || typeof m.routine.previewHash !== 'string' || !/^[a-f0-9]{64}$/.test(m.routine.previewHash)
      || !record(m.plan) || m.plan.reusedFromMissionId !== definition.sourceMissionId
      || m.phase !== 'execute' || m.plan.capabilityId !== definition.capabilityId || m.plan.capabilityVersion !== definition.capabilityVersion
      || !record(m.source) || !Array.isArray(m.source.columns) || !record(m.input) || m.input.confirmed !== true
      || Object.keys(m.input).some(key => !['confirmed', 'binding', 'orderRule'].includes(key))) throw new Error('Der Auftrag enthält eine ungültige Routinenherkunft.');
    const input = validateOrderReviewInput(m.input.binding, m.input.orderRule, m.source.columns as string[], definition.baseline.orderKeyField);
    if (canonical(input.binding) !== canonical(definition.binding)
      || canonical(input.orderRule) !== canonical({ ...definition.orderRule, asOf: input.orderRule.asOf })
      || m.routine.confirmedRuleHash !== orderReviewRuleHash(input.binding, input.orderRule)
      || (m.status === 'completed' && (!record(m.result) || !record(m.result.evidence)
        || m.result.evidence.orderRuleHash !== m.routine.confirmedRuleHash))) {
      throw new Error('Die Routinenregeln stimmen nicht mit der bestätigten Vorprüfung überein.');
    }
  }
  return value as unknown as MissionState;
}

/** Single API writer only. State, events and idempotency receipts commit together. */
export class FileMissionStore {
  readonly path: string;
  constructor(root: string) { this.path = resolve(join(root, 'missions', 'state.json')); }

  async read(): Promise<MissionState> {
    try {
      const info = await lstat(this.path);
      if (!info.isFile()) throw new Error('Die Auftragsablage muss eine reguläre Datei sein.');
      if (info.size > 64 * 1024 * 1024) throw new Error('Die Auftragsablage hat ihre Größenbegrenzung überschritten.');
      return parse(await readFile(this.path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, missions: {}, requests: {}, routines: {}, routineRequests: {} };
      throw error;
    }
  }

  async update<T>(change: (state: MissionState) => T | Promise<T>, beforeCommit?: () => void | Promise<void>): Promise<T> {
    const previous = queues.get(this.path) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const state = await this.read();
      const value = await change(state);
      const bytes = JSON.stringify(state);
      parse(bytes);
      if (Buffer.byteLength(bytes) > 64 * 1024 * 1024) throw new Error('Die Auftragsablage hat ihre Größenbegrenzung erreicht.');
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        await beforeCommit?.();
        await rename(temporary, this.path);
        if (process.platform === 'linux') {
          const directory = await open(dirname(this.path), 'r');
          try { await directory.sync(); } finally { await directory.close(); }
        }
      } finally { await rm(temporary, { force: true }).catch(() => undefined); }
      return structuredClone(value);
    });
    const settled = operation.then(() => undefined, () => undefined);
    queues.set(this.path, settled);
    try { return await operation; }
    finally { if (queues.get(this.path) === settled) queues.delete(this.path); }
  }
}
