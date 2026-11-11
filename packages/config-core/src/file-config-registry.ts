import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import { createDefaultConfigState } from './defaults.js';
import type {
  ConfigEntryRecord,
  ConfigEntryUpsertInput,
  ConfigScope,
  ConfigState,
  FileConfigRegistryOptions,
  ResolvedConfigEntry,
  SecretMetadata,
  SecretRecord,
  SecretUpsertInput,
} from './types.js';

function sortByName<T extends { name?: string; key?: string; id: string }>(left: T, right: T): number {
  return (left.name ?? left.key ?? left.id).localeCompare(right.name ?? right.key ?? right.id);
}

function sortResolved(left: ResolvedConfigEntry, right: ResolvedConfigEntry): number {
  return left.key.localeCompare(right.key);
}

function matchesScope<T extends { scope: ConfigScope; tenantId?: string }>(
  item: T,
  tenantId?: string,
): boolean {
  if (item.scope === 'global') {
    return true;
  }

  return item.tenantId === tenantId;
}

function maskSecret(value: string): string {
  if (value.length <= 4) {
    return '****';
  }

  return `${value.slice(0, 2)}****${value.slice(-2)}`;
}

export class FileConfigRegistry {
  readonly #filePath: string;

  constructor(options: FileConfigRegistryOptions) {
    this.#filePath = options.filePath;
  }

  async #readState(): Promise<ConfigState> {
    await mkdir(dirname(this.#filePath), { recursive: true });

    try {
      const content = await readFile(this.#filePath, 'utf8');
      const parsed = JSON.parse(content) as Partial<ConfigState>;
      const defaults = createDefaultConfigState();
      // Merge: ensure required arrays are always present even in old state files
      return {
        secrets: parsed.secrets ?? defaults.secrets,
        entries: parsed.entries ?? defaults.entries,
      };
    } catch {
      const state = createDefaultConfigState();
      await this.#writeState(state);
      return state;
    }
  }

  async #writeState(state: ConfigState): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true });
    await writeFile(this.#filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  #toMetadata(secret: SecretRecord): SecretMetadata {
    return {
      id: secret.id,
      name: secret.name,
      scope: secret.scope,
      tenantId: secret.tenantId,
      description: secret.description,
      tags: secret.tags,
      maskedValue: maskSecret(secret.value),
      createdAt: secret.createdAt,
      updatedAt: secret.updatedAt,
    };
  }

  async listSecrets(tenantId?: string): Promise<SecretMetadata[]> {
    const state = await this.#readState();
    return state.secrets
      .filter((entry) => matchesScope(entry, tenantId))
      .map((entry) => this.#toMetadata(entry))
      .sort(sortByName);
  }

  async listEntries(tenantId?: string): Promise<ConfigEntryRecord[]> {
    const state = await this.#readState();
    return state.entries.filter((entry) => matchesScope(entry, tenantId)).sort(sortByName);
  }

  async upsertSecret(input: SecretUpsertInput): Promise<SecretMetadata> {
    const state = await this.#readState();
    const scope = input.scope ?? 'global';
    const now = new Date().toISOString();
    const existing = state.secrets.find(
      (entry) => entry.name === input.name && entry.scope === scope && entry.tenantId === input.tenantId,
    );

    if (existing) {
      existing.value = input.value;
      existing.description = input.description;
      existing.tags = input.tags ?? [];
      existing.updatedAt = now;
      await this.#writeState(state);
      return this.#toMetadata(existing);
    }

    const secret: SecretRecord = {
      id: `secret-${randomUUID()}`,
      name: input.name,
      scope,
      tenantId: input.tenantId,
      description: input.description,
      tags: input.tags ?? [],
      value: input.value,
      createdAt: now,
      updatedAt: now,
    };

    state.secrets.push(secret);
    await this.#writeState(state);
    return this.#toMetadata(secret);
  }

  async upsertEntry(input: ConfigEntryUpsertInput): Promise<ConfigEntryRecord> {
    const state = await this.#readState();
    const scope = input.scope ?? 'global';
    const now = new Date().toISOString();
    const existing = state.entries.find(
      (entry) => entry.key === input.key && entry.scope === scope && entry.tenantId === input.tenantId,
    );

    if (existing) {
      existing.valueType = input.valueType;
      existing.value = input.value;
      existing.description = input.description;
      existing.updatedAt = now;
      await this.#writeState(state);
      return existing;
    }

    const entry: ConfigEntryRecord = {
      id: `cfg-${randomUUID()}`,
      key: input.key,
      scope,
      tenantId: input.tenantId,
      valueType: input.valueType,
      value: input.value,
      description: input.description,
      createdAt: now,
      updatedAt: now,
    };

    state.entries.push(entry);
    await this.#writeState(state);
    return entry;
  }

  async resolveEntries(tenantId?: string): Promise<ResolvedConfigEntry[]> {
    const state = await this.#readState();
    const visibleEntries = state.entries.filter((entry) => matchesScope(entry, tenantId));

    const byKey = new Map<string, ConfigEntryRecord>();
    for (const entry of visibleEntries.sort((left, right) => {
      if (left.scope === right.scope) {
        return left.key.localeCompare(right.key);
      }

      return left.scope === 'global' ? -1 : 1;
    })) {
      byKey.set(entry.key, entry);
    }

    return [...byKey.values()]
      .map((entry) => {
        if (entry.valueType !== 'secret-ref') {
          return {
            key: entry.key,
            scope: entry.scope,
            tenantId: entry.tenantId,
            valueType: entry.valueType,
            resolvedValue: entry.value,
            description: entry.description,
            source: 'literal' as const,
          };
        }

        const secret = state.secrets.find((candidate) => candidate.id === entry.value);
        return {
          key: entry.key,
          scope: entry.scope,
          tenantId: entry.tenantId,
          valueType: entry.valueType,
          resolvedValue: secret ? this.#toMetadata(secret).maskedValue : '****',
          description: entry.description,
          source: 'secret' as const,
        };
      })
      .sort(sortResolved);
  }
}
