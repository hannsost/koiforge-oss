import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { createDefaultSavedViewState } from './defaults.js';

import type {
  FileSavedViewRegistryOptions,
  SavedViewRecord,
  SavedViewState,
  SavedViewType,
  SavedViewUpsertInput,
} from './types.js';

function emptyState(): SavedViewState {
  return { views: [] };
}

function sortViews(left: SavedViewRecord, right: SavedViewRecord): number {
  return left.name.localeCompare(right.name);
}

function mergeDefaultViews(state: SavedViewState): SavedViewState {
  const defaults = createDefaultSavedViewState();
  const views = [...state.views];

  for (const defaultView of defaults.views) {
    const existingIndex = views.findIndex(
      (entry) =>
        entry.tenantId === defaultView.tenantId &&
        entry.type === defaultView.type &&
        entry.name === defaultView.name,
    );

    if (existingIndex === -1) {
      views.push(defaultView);
      continue;
    }

    const existing = views[existingIndex];
    if (existing && existing.createdBy === 'system') {
      views[existingIndex] = {
        ...defaultView,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: defaultView.updatedAt,
      };
    }
  }

  return { views: views.sort(sortViews) };
}

export class FileSavedViewRegistry {
  readonly #filePath: string;

  constructor(options: FileSavedViewRegistryOptions) {
    this.#filePath = options.filePath;
  }

  async #readState(): Promise<SavedViewState> {
    await mkdir(dirname(this.#filePath), { recursive: true });

    try {
      const content = await readFile(this.#filePath, 'utf8');
      const parsed = JSON.parse(content) as SavedViewState;
      const merged = mergeDefaultViews(parsed);

      if (JSON.stringify(parsed) !== JSON.stringify(merged)) {
        await this.#writeState(merged);
      }

      return merged;
    } catch {
      const state = mergeDefaultViews(emptyState());
      await this.#writeState(state);
      return state;
    }
  }

  async #writeState(state: SavedViewState): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true });
    await writeFile(this.#filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  async listViews(tenantId: string, type?: SavedViewType): Promise<SavedViewRecord[]> {
    const state = await this.#readState();
    return state.views
      .filter((entry) => entry.tenantId === tenantId && (!type || entry.type === type))
      .sort(sortViews);
  }

  async getView(tenantId: string, viewId: string): Promise<SavedViewRecord | null> {
    const state = await this.#readState();
    return state.views.find((entry) => entry.tenantId === tenantId && entry.id === viewId) ?? null;
  }

  async upsertView(input: SavedViewUpsertInput): Promise<SavedViewRecord> {
    const state = await this.#readState();
    const now = new Date().toISOString();

    if (input.id) {
      const existingById = state.views.find((entry) => entry.id === input.id && entry.tenantId === input.tenantId);
      if (existingById) {
        existingById.name = input.name;
        existingById.description = input.description;
        existingById.state = input.state as Record<string, unknown>;
        existingById.updatedAt = now;
        await this.#writeState(state);
        return existingById;
      }
    }

    const existingByName = state.views.find(
      (entry) => entry.tenantId === input.tenantId && entry.type === input.type && entry.name === input.name,
    );
    if (existingByName) {
      existingByName.description = input.description;
      existingByName.state = input.state as Record<string, unknown>;
      existingByName.updatedAt = now;
      await this.#writeState(state);
      return existingByName;
    }

    const view: SavedViewRecord = {
      id: input.id ?? `view-${randomUUID()}`,
      tenantId: input.tenantId,
      type: input.type,
      name: input.name,
      description: input.description,
      createdBy: input.createdBy,
      state: input.state as Record<string, unknown>,
      createdAt: now,
      updatedAt: now,
    };

    state.views.push(view);
    await this.#writeState(state);
    return view;
  }
}
