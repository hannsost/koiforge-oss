import type { DatasetRegistryState } from './types.js';
import { isSafeColumn } from './tabular-data.js';

export class DatasetStorageError extends Error {
  readonly statusCode = 503;
}

export class DatasetConflictError extends Error {
  readonly statusCode = 409;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(v => typeof v === 'string');
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const optionalText = (value: unknown): boolean => value === undefined || typeof value === 'string';

/** Validate the persisted shape before any reader or writer can use it. */
export function parseDatasetState(content: string): DatasetRegistryState {
  try {
    const state: unknown = JSON.parse(content);
    if (!object(state) || !object(state.datasets) || !Array.isArray(state.events)) throw new Error('Invalid state');
    for (const [id, dataset] of Object.entries(state.datasets)) {
      if (!object(dataset) || dataset.id !== id || !text(id)
        || !text(dataset.name) || !text(dataset.namespace) || !text(dataset.connectorId)
        || !['file', 'database', 'object-storage', 'stream'].includes(String(dataset.connectorCategory))
        || !['virtual', 'materialized'].includes(String(dataset.mode))
        || !['registered', 'ready', 'stale'].includes(String(dataset.status))
        || !object(dataset.source) || !Array.isArray(dataset.schema) || !Array.isArray(dataset.snapshots)
        || !optionalText(dataset.description)
        || !strings(dataset.tags) || !text(dataset.createdAt) || !text(dataset.updatedAt)
        || !object(dataset.sqlAccess)
        || !['catalog', 'schema', 'table', 'queryPreview'].every(key => text(dataset.sqlAccess && (dataset.sqlAccess as Record<string, unknown>)[key]))) {
        throw new Error('Invalid dataset');
      }
      const fields = new Set<string>();
      for (const field of dataset.schema) {
        if (!object(field) || !text(field.name) || !isSafeColumn(field.name) || fields.has(field.name)
          || (field.nullable !== undefined && typeof field.nullable !== 'boolean') || !optionalText(field.description)
          || !['string', 'number', 'integer', 'boolean', 'date', 'datetime', 'json'].includes(String(field.type))) throw new Error('Invalid schema');
        fields.add(field.name);
      }
      if (!dataset.snapshots.every(snapshot => object(snapshot) && text(snapshot.id) && text(snapshot.createdAt) && text(snapshot.reason))) throw new Error('Invalid snapshot');
      if (dataset.connectorId === 'inline' && !Array.isArray(dataset.source.previewRows)) throw new Error('Missing inline rows');
      if (dataset.source.previewRows !== undefined) {
        if (!Array.isArray(dataset.source.previewRows)) throw new Error('Invalid rows');
        // Existing datasets may predate current size limits. Validate, never truncate them.
        for (const row of dataset.source.previewRows) {
          if (!object(row) || !Object.keys(row).every(isSafeColumn) || !Object.values(row).every(cell => cell === null || typeof cell === 'string' || typeof cell === 'boolean' || (typeof cell === 'number' && Number.isFinite(cell)))) throw new Error('Invalid row');
        }
      }
    }
    for (const event of state.events) {
      if (!object(event) || !text(event.id) || !text(event.datasetId) || !text(event.timestamp)
        || !optionalText(event.details)
        || !['dataset.registered', 'dataset.snapshotted', 'dataset.schema-updated', 'dataset.uploaded', 'dataset.deleted'].includes(String(event.type))) throw new Error('Invalid event');
    }
    return state as unknown as DatasetRegistryState;
  } catch (cause) {
    throw new DatasetStorageError('Dataset-Ablage ist beschädigt oder hat ein ungültiges Format. Die Originaldatei bleibt erhalten; bitte die Wiederherstellung prüfen.', { cause });
  }
}
