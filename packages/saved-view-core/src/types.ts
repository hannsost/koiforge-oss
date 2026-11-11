export type SavedViewType = 'dataset-preview' | 'object-explorer' | 'board-viewer';

export interface SavedViewRecord<TState = Record<string, unknown>> {
  id: string;
  tenantId: string;
  type: SavedViewType;
  name: string;
  description?: string;
  createdBy: string;
  state: TState;
  createdAt: string;
  updatedAt: string;
}

export interface SavedViewState {
  views: SavedViewRecord[];
}

export interface SavedViewUpsertInput<TState = Record<string, unknown>> {
  id?: string;
  tenantId: string;
  type: SavedViewType;
  name: string;
  description?: string;
  createdBy: string;
  state: TState;
}

export interface FileSavedViewRegistryOptions {
  filePath: string;
}
