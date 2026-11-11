import { createRequire } from 'node:module';

import type {
  ConnectorDefinition,
  DatasetField,
  DatasetFieldType,
  SchemaDiscoveryResult,
} from './types.js';

// ── Postgres helpers ──────────────────────────────────────────────────────────

export interface PgConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  schema?: string;
}

function pgTypeToField(pgType: string): DatasetFieldType {
  if (['int2','int4','int8','integer','bigint','smallint','serial','bigserial'].includes(pgType)) return 'integer';
  if (['float4','float8','numeric','decimal','real','double precision','money'].includes(pgType)) return 'number';
  if (['bool','boolean'].includes(pgType)) return 'boolean';
  if (['timestamp','timestamptz','date','time','timetz','interval'].includes(pgType)) return 'datetime';
  if (['json','jsonb'].includes(pgType)) return 'json';
  return 'string';
}

function makeSql(conn: PgConnectionConfig) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const postgres = require('postgres') as any;
  return postgres({
    host: conn.host,
    port: conn.port,
    database: conn.database,
    user: conn.user,
    password: conn.password,
    max: 1,
    connect_timeout: 5,
    idle_timeout: 5,
  });
}

export async function listPostgresTables(conn: PgConnectionConfig): Promise<string[]> {
  const sql = makeSql(conn);
  try {
    const schema = conn.schema ?? 'public';
    const rows = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = ${schema} AND table_type = 'BASE TABLE' ORDER BY table_name`;
    return (rows as { table_name: string }[]).map((r) => r.table_name);
  } finally {
    await sql.end();
  }
}

export async function getPostgresSchema(conn: PgConnectionConfig, table: string): Promise<DatasetField[]> {
  const sql = makeSql(conn);
  try {
    const schema = conn.schema ?? 'public';
    const rows = await sql`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = ${schema} AND table_name = ${table} ORDER BY ordinal_position`;
    return (rows as { column_name: string; data_type: string; is_nullable: string }[]).map((r) => ({
      name: r.column_name,
      type: pgTypeToField(r.data_type),
      nullable: r.is_nullable === 'YES',
    }));
  } finally {
    await sql.end();
  }
}

export async function queryPostgresRows(
  conn: PgConnectionConfig,
  table: string,
  limit: number,
): Promise<Record<string, string | number | boolean | null>[]> {
  const sql = makeSql(conn);
  try {
    const schema = conn.schema ?? 'public';
    // Table/schema names can't be parameterized — use sql.unsafe for identifiers
    const rows = await sql.unsafe(`SELECT * FROM "${schema}"."${table}" LIMIT ${limit}`);
    return rows as Record<string, string | number | boolean | null>[];
  } finally {
    await sql.end();
  }
}

// CJS-only modules — load via createRequire to avoid ESM interop issues
const require = createRequire(import.meta.url);


interface PragmaRow { cid: number; name: string; type: string; notnull: number; dflt_value: unknown; pk: number; }

function sqliteTypeToField(sqliteType: string): DatasetFieldType {
  const t = sqliteType.toUpperCase();
  if (t.includes('INT')) return 'integer';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB') || t.includes('NUMERIC') || t.includes('DECIMAL')) return 'number';
  if (t.includes('DATE') || t.includes('TIME')) return 'datetime';
  if (t.includes('BOOL')) return 'boolean';
  if (t.includes('JSON') || t.includes('BLOB')) return 'json';
  return 'string';
}

export function getSqliteSchema(filePath: string, table: string): DatasetField[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Database = require('better-sqlite3') as any;
  const db = new Database(filePath, { readonly: true });
  try {
    const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as PragmaRow[];
    return rows.map((r) => ({
      name: r.name,
      type: sqliteTypeToField(r.type),
      nullable: r.notnull === 0 && r.pk === 0,
    }));
  } finally {
    db.close();
  }
}

export function querySqliteRows(filePath: string, table: string, limit: number): Record<string, string | number | boolean | null>[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Database = require('better-sqlite3') as any;
  const db = new Database(filePath, { readonly: true });
  try {
    return db.prepare(`SELECT * FROM "${table}" LIMIT ?`).all(limit) as Record<string, string | number | boolean | null>[];
  } finally {
    db.close();
  }
}

export function listSqliteTables(filePath: string): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Database = require('better-sqlite3') as any;
  const db = new Database(filePath, { readonly: true });
  try {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    return rows.map((r) => r.name);
  } finally {
    db.close();
  }
}

function asFieldType(value: unknown, fallback: DatasetFieldType = 'string'): DatasetFieldType {
  if (
    value === 'string' ||
    value === 'number' ||
    value === 'integer' ||
    value === 'boolean' ||
    value === 'date' ||
    value === 'datetime' ||
    value === 'json'
  ) {
    return value;
  }

  return fallback;
}

function normalizeField(entry: unknown, index: number): DatasetField {
  if (typeof entry === 'string') {
    return {
      name: entry,
      type: 'string',
      nullable: true,
    };
  }

  if (typeof entry === 'object' && entry !== null) {
    const record = entry as Record<string, unknown>;
    return {
      name: typeof record.name === 'string' ? record.name : `column_${index + 1}`,
      type: asFieldType(record.type),
      nullable: typeof record.nullable === 'boolean' ? record.nullable : true,
      description: typeof record.description === 'string' ? record.description : undefined,
    };
  }

  return {
    name: `column_${index + 1}`,
    type: 'string',
    nullable: true,
  };
}

function resolveColumns(config: Record<string, unknown>, fallback: DatasetField[]): DatasetField[] {
  const columns = config.columns;
  if (!Array.isArray(columns) || columns.length === 0) {
    return fallback;
  }

  return columns.map((entry, index) => normalizeField(entry, index));
}

function tableSummary(engine: string, config: Record<string, unknown>): string {
  const database = typeof config.database === 'string' ? config.database : 'default';
  const schema = typeof config.schema === 'string' ? config.schema : 'public';
  const table = typeof config.table === 'string' ? config.table : 'unknown_table';
  return `${engine}:${database}.${schema}.${table}`;
}

function objectStorageSummary(config: Record<string, unknown>): string {
  const bucket = typeof config.bucket === 'string' ? config.bucket : 'bucket';
  const key = typeof config.key === 'string' ? config.key : 'path';
  return `s3://${bucket}/${key}`;
}

function streamSummary(config: Record<string, unknown>): string {
  const topic = typeof config.topic === 'string' ? config.topic : 'topic';
  return `kafka:${topic}`;
}

function discovery(summary: string, fields: DatasetField[]): SchemaDiscoveryResult {
  return {
    summary,
    fields,
  };
}

export const builtInConnectors: ConnectorDefinition[] = [
  {
    id: 'csv',
    name: 'CSV File Connector',
    category: 'file',
    capabilities: ['schema-discovery', 'file-ingest', 'materialization'],
    configFields: [
      { key: 'path', label: 'File Path', type: 'string', required: true },
      { key: 'delimiter', label: 'Delimiter', type: 'string' },
      { key: 'columns', label: 'Columns', type: 'json' },
    ],
    discoverSchema(config) {
      const path = typeof config.path === 'string' ? config.path : 'file.csv';
      const fields = resolveColumns(config, [
        { name: 'id', type: 'string', nullable: false },
        { name: 'name', type: 'string', nullable: true },
        { name: 'updatedAt', type: 'datetime', nullable: true },
      ]);
      return discovery(`csv:${path}`, fields);
    },
  },
  {
    id: 'sqlite',
    name: 'SQLite Connector',
    category: 'database',
    capabilities: ['schema-discovery', 'table-registration'],
    configFields: [
      { key: 'filePath', label: 'Database File', type: 'string', required: true },
      { key: 'table', label: 'Table', type: 'string', required: true },
    ],
    discoverSchema(config) {
      const filePath = typeof config.filePath === 'string' ? config.filePath : '';
      const table = typeof config.table === 'string' ? config.table : '';
      try {
        const fields = getSqliteSchema(filePath, table);
        return discovery(`sqlite:${filePath}/${table}`, fields);
      } catch {
        return discovery(`sqlite:${filePath}/${table}`, [{ name: 'id', type: 'integer', nullable: false }]);
      }
    },
  },
  {
    id: 'postgres',
    name: 'Postgres Connector',
    category: 'database',
    capabilities: ['schema-discovery', 'table-registration', 'incremental-sync'],
    configFields: [
      { key: 'host', label: 'Host', type: 'string', required: true },
      { key: 'port', label: 'Port', type: 'string' },
      { key: 'database', label: 'Database', type: 'string', required: true },
      { key: 'user', label: 'User', type: 'string', required: true },
      { key: 'password', label: 'Password', type: 'string', required: true },
      { key: 'schema', label: 'Schema', type: 'string' },
      { key: 'table', label: 'Table', type: 'string', required: true },
    ],
    discoverSchema(config) {
      // Returns a placeholder at registration time; real schema loaded async via getPostgresSchema
      const fields = resolveColumns(config, [{ name: 'id', type: 'integer', nullable: false }]);
      return discovery(`postgres://${String(config.host ?? 'localhost')}/${String(config.database ?? '')}/${String(config.table ?? '')}`, fields);
    },
  },
  {
    id: 'mysql',
    name: 'MySQL Connector',
    category: 'database',
    capabilities: ['schema-discovery', 'table-registration', 'incremental-sync'],
    configFields: [
      { key: 'database', label: 'Database', type: 'string', required: true },
      { key: 'schema', label: 'Schema', type: 'string' },
      { key: 'table', label: 'Table', type: 'string', required: true },
      { key: 'columns', label: 'Columns', type: 'json' },
    ],
    discoverSchema(config) {
      const fields = resolveColumns(config, [
        { name: 'id', type: 'integer', nullable: false },
        { name: 'name', type: 'string', nullable: true },
        { name: 'last_modified', type: 'datetime', nullable: true },
      ]);
      return discovery(tableSummary('mysql', config), fields);
    },
  },
  {
    id: 's3',
    name: 'S3 Object Connector',
    category: 'object-storage',
    capabilities: ['schema-discovery', 'object-ingest', 'partitioned-materialization'],
    configFields: [
      { key: 'bucket', label: 'Bucket', type: 'string', required: true },
      { key: 'key', label: 'Object Key', type: 'string', required: true },
      { key: 'format', label: 'Format', type: 'string', required: true },
      { key: 'columns', label: 'Columns', type: 'json' },
    ],
    discoverSchema(config) {
      const fields = resolveColumns(config, [
        { name: 'object_key', type: 'string', nullable: false },
        { name: 'ingested_at', type: 'datetime', nullable: false },
        { name: 'payload', type: 'json', nullable: true },
      ]);
      return discovery(objectStorageSummary(config), fields);
    },
  },
  {
    id: 'kafka',
    name: 'Kafka Topic Connector',
    category: 'stream',
    capabilities: ['schema-discovery', 'stream-ingest', 'checkpointing'],
    configFields: [
      { key: 'topic', label: 'Topic', type: 'string', required: true },
      { key: 'groupId', label: 'Consumer Group', type: 'string' },
      { key: 'columns', label: 'Columns', type: 'json' },
    ],
    discoverSchema(config) {
      const fields = resolveColumns(config, [
        { name: 'message_key', type: 'string', nullable: true },
        { name: 'message_timestamp', type: 'datetime', nullable: false },
        { name: 'payload', type: 'json', nullable: true },
      ]);
      return discovery(streamSummary(config), fields);
    },
  },
];

export function getBuiltInConnector(connectorId: string): ConnectorDefinition | null {
  return builtInConnectors.find((entry) => entry.id === connectorId) ?? null;
}

