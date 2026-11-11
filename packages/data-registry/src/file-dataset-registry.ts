import { existsSync } from 'node:fs';
import { mkdir, readFile, open, rename, rm, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { parseCsvTable } from './csv.js';
import { readTabularText, DatasetInputError, validateTabularRows } from './tabular-data.js';
import { DatasetStorageError, DatasetConflictError, parseDatasetState } from './dataset-state.js';

import { builtInConnectors, getBuiltInConnector, querySqliteRows, queryPostgresRows } from './builtin-connectors.js';
import type {
  ConnectorDefinition,
  DataEvent,
  DatasetField,
  DatasetPreviewResult,
  DatasetRecord,
  DatasetRegistrationInput,
  DatasetRegistryState,
  DatasetSqlAccess,
  InlineDatasetInput,
  SchemaDiscoveryResult,
} from './types.js';

export interface FileDatasetRegistryOptions {
  filePath: string;
}

function emptyState(): DatasetRegistryState {
  return {
    datasets: {},
    events: [],
  };
}

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 63);
}

function buildSqlAccess(namespace: string, datasetName: string): DatasetSqlAccess {
  const schema = slugify(namespace) || 'default';
  const table = slugify(datasetName) || 'dataset';

  return {
    catalog: 'koiforge',
    schema,
    table,
    queryPreview: `select * from koiforge.${schema}.${table} limit 100;`,
  };
}

function datasetSorter(left: DatasetRecord, right: DatasetRecord): number {
  return left.name.localeCompare(right.name);
}

function toAbsolutePath(pathValue: string): string {
  if (isAbsolute(pathValue)) {
    return pathValue;
  }

  const candidates = [
    resolve(process.cwd(), pathValue),
    resolve(process.cwd(), '..', pathValue),
    resolve(process.cwd(), '..', '..', pathValue),
    resolve(process.cwd(), '..', '..', '..', pathValue),
  ];

  const existing = candidates.find((entry) => existsSync(entry));
  return existing ?? candidates[0]!;
}

function previewSourceError(datasetId: string, source: string, error?: unknown): Error {
  const detail = error instanceof Error ? error.message : undefined;
  return new Error(
    `Preview für Dataset '${datasetId}' konnte aus der ${source}-Quelle nicht geladen werden${detail ? `: ${detail}` : '.'}`,
  );
}

function unsupportedPreviewError(datasetId: string, connectorId: string): Error {
  return new Error(
    `Preview für Dataset '${datasetId}' wird für Connector '${connectorId}' ohne explizite source.previewRows nicht unterstützt.`,
  );
}

// One queue per canonical spelling of a file within this process. Deploy one API
// worker; this intentionally does not claim inter-process or symlink coordination.
const mutations = new Map<string, Promise<void>>();

export class FileDatasetRegistry {
  readonly #filePath: string;

  constructor(options: FileDatasetRegistryOptions) {
    this.#filePath = resolve(options.filePath);
  }

  async #readState(): Promise<DatasetRegistryState> {
    try {
      if (!(await lstat(this.#filePath)).isFile()) throw new DatasetStorageError('Dataset-Ablage muss eine reguläre Datei sein; Verknüpfungen werden nicht verändert.');
    }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      throw new DatasetStorageError('Dataset-Ablage kann nicht gelesen werden. Bestehende Daten wurden nicht verändert.', { cause });
    }
    let content: string;
    try { content = await readFile(this.#filePath, 'utf8'); }
    catch (cause) { throw new DatasetStorageError('Dataset-Ablage kann nicht gelesen werden. Bestehende Daten wurden nicht verändert.', { cause }); }
    return parseDatasetState(content);
  }

  async #writeState(state: DatasetRegistryState): Promise<void> {
    const temporary = `${this.#filePath}.${randomUUID()}.tmp`;
    try {
      const content = `${JSON.stringify(state, null, 2)}\n`;
      parseDatasetState(content);
      await mkdir(dirname(this.#filePath), { recursive: true, mode: 0o700 });
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(content); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, this.#filePath);
      if (process.platform === 'linux') {
        const directory = await open(dirname(this.#filePath), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } catch (cause) {
      throw new DatasetStorageError('Dataset-Ablage konnte nicht zuverlässig gespeichert werden. Bitte den Zustand prüfen und den Vorgang erneut versuchen.', { cause });
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }

  async #mutate<T>(change: (state: DatasetRegistryState) => T | Promise<T>): Promise<T> {
    const previous = mutations.get(this.#filePath) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const state = await this.#readState();
      const result = await change(state);
      await this.#writeState(state);
      return result;
    });
    const settled = operation.then(() => undefined, () => undefined);
    mutations.set(this.#filePath, settled);
    try { return await operation; }
    finally { if (mutations.get(this.#filePath) === settled) mutations.delete(this.#filePath); }
  }

  #createEvent(type: DataEvent['type'], datasetId: string, details?: string): DataEvent {
    return {
      id: randomUUID(),
      type,
      datasetId,
      timestamp: new Date().toISOString(),
      details,
    };
  }

  #assertConnector(connectorId: string): ConnectorDefinition {
    const connector = getBuiltInConnector(connectorId);
    if (!connector) {
      throw new Error(`Connector '${connectorId}' wird aktuell nicht unterstützt.`);
    }

    return connector;
  }

  discoverSchema(connectorId: string, source: Record<string, unknown>): SchemaDiscoveryResult {
    const connector = this.#assertConnector(connectorId);
    return connector.discoverSchema(source);
  }

  async listConnectors(): Promise<ConnectorDefinition[]> {
    return builtInConnectors;
  }

  async listDatasets(): Promise<DatasetRecord[]> {
    const state = await this.#readState();
    return Object.values(state.datasets).sort(datasetSorter);
  }

  async getDataset(datasetId: string): Promise<DatasetRecord | null> {
    const state = await this.#readState();
    return Object.hasOwn(state.datasets, datasetId) ? state.datasets[datasetId]! : null;
  }

  async listEvents(limit = 50): Promise<DataEvent[]> {
    const state = await this.#readState();
    return state.events.slice(0, limit);
  }

  async registerDataset(input: DatasetRegistrationInput): Promise<DatasetRecord> {
    if (!input || typeof input.name !== 'string' || !input.name.trim()
      || typeof input.namespace !== 'string' || !input.namespace.trim()
      || !['virtual', 'materialized'].includes(input.mode)
      || !input.source || typeof input.source !== 'object' || Array.isArray(input.source)
      || (input.description !== undefined && typeof input.description !== 'string')
      || (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.some(tag => typeof tag !== 'string')))) {
      throw new DatasetInputError('Name, Bereich, Quelle oder Metadaten des Datasets sind ungültig.');
    }
    const source = { ...input.source };
    if (source.previewRows !== undefined) source.previewRows = validateTabularRows(source.previewRows);
    return this.#mutate((state) => {
      const connector = this.#assertConnector(input.connectorId);
      const discovery = connector.discoverSchema(source);
      const datasetId = slugify(`${input.namespace}-${input.name}`) || randomUUID();

      if (Object.hasOwn(state.datasets, datasetId)) {
        throw new DatasetConflictError(`Dataset '${datasetId}' existiert bereits.`);
      }

      const now = new Date().toISOString();
      const initialSnapshot = input.mode === 'materialized'
        ? [{ id: randomUUID(), createdAt: now, reason: 'initial-materialization' }]
        : [];

      const dataset: DatasetRecord = {
        id: datasetId,
        name: input.name,
        namespace: input.namespace,
        description: input.description,
        connectorId: connector.id,
        connectorCategory: connector.category,
        mode: input.mode,
        status: input.mode === 'materialized' ? 'ready' : 'registered',
        source,
        schema: discovery.fields,
        sqlAccess: buildSqlAccess(input.namespace, input.name),
        snapshots: initialSnapshot,
        tags: input.tags ?? [],
        createdAt: now,
        updatedAt: now,
      };

      state.datasets[datasetId] = dataset;
      state.events.unshift(
        this.#createEvent('dataset.registered', dataset.id, `${connector.id} · ${discovery.summary}`),
      );

      if (initialSnapshot.length > 0) {
        state.events.unshift(this.#createEvent('dataset.snapshotted', dataset.id, 'initial-materialization'));
      }

      return dataset;
    });
  }

  async snapshotDataset(datasetId: string, reason: string): Promise<DatasetRecord> {
    if (typeof reason !== 'string' || !reason.trim()) throw new DatasetInputError('Ein Grund für den Snapshot ist erforderlich.');
    return this.#mutate((state) => {
      const dataset = Object.hasOwn(state.datasets, datasetId) ? state.datasets[datasetId] : undefined;

      if (!dataset) {
        throw new Error(`Dataset '${datasetId}' wurde nicht gefunden.`);
      }

      const snapshot = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        reason,
      };

      dataset.snapshots.unshift(snapshot);
      dataset.status = 'ready';
      dataset.updatedAt = snapshot.createdAt;

      state.events.unshift(this.#createEvent('dataset.snapshotted', datasetId, reason));

      return dataset;
    });
  }

  async deleteDataset(datasetId: string): Promise<void> {
    return this.#mutate((state) => {
      if (!Object.hasOwn(state.datasets, datasetId)) {
        throw new Error(`Dataset '${datasetId}' wurde nicht gefunden.`);
      }
      delete state.datasets[datasetId];
      state.events.unshift(this.#createEvent('dataset.deleted', datasetId, `Dataset '${datasetId}' gelöscht.`));
    });
  }

  async deleteDatasetsByNamespace(namespace: string): Promise<string[]> {
    return this.#mutate((state) => {
      const deleted: string[] = [];
      for (const [id, ds] of Object.entries(state.datasets)) {
        if (ds.namespace === namespace) {
          delete state.datasets[id];
          deleted.push(id);
          state.events.unshift(this.#createEvent('dataset.deleted', id, `Dataset '${id}' gelöscht (namespace: ${namespace}).`));
        }
      }
      return deleted;
    });
  }

  async refreshSchema(datasetId: string): Promise<DatasetRecord> {
    return this.#mutate((state) => {
      const dataset = Object.hasOwn(state.datasets, datasetId) ? state.datasets[datasetId] : undefined;

      if (!dataset) {
        throw new Error(`Dataset '${datasetId}' wurde nicht gefunden.`);
      }

      const discovery = this.discoverSchema(dataset.connectorId, dataset.source);
      dataset.schema = discovery.fields;
      dataset.updatedAt = new Date().toISOString();
      dataset.status = 'ready';

      state.events.unshift(this.#createEvent('dataset.schema-updated', datasetId, discovery.summary));

      return dataset;
    });
  }

  async previewSql(datasetId: string): Promise<DatasetSqlAccess> {
    const dataset = await this.getDataset(datasetId);
    if (!dataset) {
      throw new Error(`Dataset '${datasetId}' wurde nicht gefunden.`);
    }

    return dataset.sqlAccess;
  }

  async previewRows(datasetId: string, limit = 25): Promise<DatasetPreviewResult> {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 100_001) throw new DatasetInputError('Ungültige Zeilengrenze für die Vorschau.');
    const dataset = await this.getDataset(datasetId);
    if (!dataset) {
      throw new Error(`Dataset '${datasetId}' wurde nicht gefunden.`);
    }

    const explicitPreviewRows = dataset.source.previewRows;
    if (Array.isArray(explicitPreviewRows)) {
      const rows = explicitPreviewRows.slice(0, limit).map((entry) => {
        const row = entry as Record<string, unknown>;
        return Object.fromEntries(
          Object.entries(row).map(([key, value]) => [key, value as string | number | boolean | null]),
        ) as Record<string, string | number | boolean | null>;
      });

      return {
        datasetId,
        columns: dataset.schema.map((field) => field.name),
        rows,
        rowCount: explicitPreviewRows.length,
        truncated: explicitPreviewRows.length > limit,
      };
    }

    if (dataset.connectorId === 'csv') {
      const pathValue = typeof dataset.source.path === 'string' ? dataset.source.path : null;
      if (pathValue) {
        const delimiter = typeof dataset.source.delimiter === 'string' ? dataset.source.delimiter : ',';
        try {
          const content = await readTabularText(toAbsolutePath(pathValue));
          const parsed = parseCsvTable(content, delimiter);
          return {
            datasetId,
            columns: parsed.columns,
            rows: parsed.rows.slice(0, limit),
            rowCount: parsed.rows.length,
            truncated: parsed.rows.length > limit,
          };
        } catch (error) {
          throw previewSourceError(datasetId, 'CSV', error);
        }
      }
    }

    if (dataset.connectorId === 'postgres') {
      const src = dataset.source;
      const host = typeof src.host === 'string' ? src.host : 'localhost';
      const port = typeof src.port === 'number' ? src.port : 5432;
      const database = typeof src.database === 'string' ? src.database : '';
      const user = typeof src.user === 'string' ? src.user : 'postgres';
      const password = typeof src.password === 'string' ? src.password : '';
      const schema = typeof src.schema === 'string' ? src.schema : 'public';
      const table = typeof src.table === 'string' ? src.table : '';
      if (!database || !table) {
        throw previewSourceError(datasetId, 'Postgres', new Error('Datenbank und Tabelle sind erforderlich'));
      }

      try {
        const rows = await queryPostgresRows({ host, port, database, user, password, schema }, table, limit);
        const columns = rows.length > 0 ? Object.keys(rows[0]!) : dataset.schema.map((f) => f.name);
        return { datasetId, columns, rows, rowCount: rows.length, truncated: limit > 0 && rows.length === limit };
      } catch (error) {
        throw previewSourceError(datasetId, 'Postgres', error);
      }
    }

    if (dataset.connectorId === 'sqlite') {
      const filePath = typeof dataset.source.filePath === 'string' ? dataset.source.filePath : null;
      const table = typeof dataset.source.table === 'string' ? dataset.source.table : null;
      if (!filePath || !table) {
        throw previewSourceError(datasetId, 'SQLite', new Error('Dateipfad und Tabelle sind erforderlich'));
      }

      try {
        const rows = querySqliteRows(toAbsolutePath(filePath), table, limit);
        const columns = rows.length > 0 ? Object.keys(rows[0]!) : dataset.schema.map((f) => f.name);
        return { datasetId, columns, rows, rowCount: rows.length, truncated: limit > 0 && rows.length === limit };
      } catch (error) {
        throw previewSourceError(datasetId, 'SQLite', error);
      }
    }

    throw unsupportedPreviewError(datasetId, dataset.connectorId);
  }

  async registerInlineDataset(input: InlineDatasetInput): Promise<DatasetRecord> {
    if (!input || typeof input.name !== 'string' || !input.name.trim()
      || typeof input.namespace !== 'string' || !input.namespace.trim()
      || (input.description !== undefined && typeof input.description !== 'string')
      || (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.some(tag => typeof tag !== 'string')))) {
      throw new DatasetInputError('Name, Bereich und Metadaten des Datasets sind ungültig.');
    }
    const rows = validateTabularRows(input.rows);
    return this.#mutate((state) => {
      const datasetId = slugify(`${input.namespace}-${input.name}`) || randomUUID();

      if (Object.hasOwn(state.datasets, datasetId)) {
        throw new DatasetConflictError(`Dataset '${datasetId}' existiert bereits.`);
      }

      // Include fields from every row; absent/null cells are explicit in the schema.
      const types = new Map<string, Set<DatasetField['type']>>();
      const counts = new Map<string, number>();
      for (const row of rows) for (const [key, value] of Object.entries(row)) {
        if (!types.has(key)) types.set(key, new Set());
        if (value === null) continue;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        types.get(key)!.add(typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : typeof value === 'boolean' ? 'boolean' : 'string');
      }
      const schema: DatasetField[] = [...types].map(([name, values]) => ({
        name,
        type: values.size === 0 ? 'string' : values.size === 1 ? [...values][0]! : [...values].every(value => value === 'integer' || value === 'number') ? 'number' : 'json',
        nullable: (counts.get(name) ?? 0) < rows.length,
      }));

      const now = new Date().toISOString();
      const dataset: DatasetRecord = {
        id: datasetId,
        name: input.name,
        namespace: input.namespace,
        description: input.description,
        connectorId: 'inline',
        connectorCategory: 'file',
        mode: 'materialized',
        status: 'ready',
        source: { previewRows: rows },
        schema,
        sqlAccess: buildSqlAccess(input.namespace, input.name),
        snapshots: [{ id: randomUUID(), createdAt: now, reason: 'initial-upload' }],
        tags: input.tags ?? [],
        createdAt: now,
        updatedAt: now,
      };

      state.datasets[datasetId] = dataset;
      state.events.unshift(
        this.#createEvent('dataset.uploaded', dataset.id, `inline · ${rows.length} rows · ${schema.length} columns`),
      );
      return dataset;
    });
  }

}
