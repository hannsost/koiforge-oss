import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile, readdir, rename } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { promisify } from 'node:util';
import { EXECUTION_PROFILE, executeImportParser, rowsHash, validateRows, type ExecutionReceipt } from '../import-capability/isolated-executor.js';
import { createPluginStore } from '../import-capability/plugin-store.js';
import { auditGeneration, emptyGenerationAudit, type GenerationAudit } from '../import-capability/generation-audit.js';
import { validateParserCandidate } from '../import-capability/parser-validation.js';
import { parseCsvRecords, parseCsvRowsStrict } from '../import-capability/csv-rows.js';
import { execStateWriter } from '../operations/state-lease.js';

import type { FastifyInstance } from 'fastify';
import {
  builtInConnectors,
  decodeUtf8,
  readTabularText,
  getSqliteSchema,
  listSqliteTables,
  type ConnectorDefinition,
} from '@koiforge/data-registry';
import { generationProvider, type GenerationProvider } from '../import-capability/generation-provider.js';

import {
  IMPORT_INSPECTOR_CONTRACT,
  IMPORT_IMPLEMENTER_CONTRACT,
  IMPORT_PLANNER_CONTRACT,
  IMPORT_VERIFIER_CONTRACT,
  type AcquisitionPath,
  type CapabilityGapDimension,
  type CapabilityNextAction,
  type ExecutionGoal,
  type ImportSourceClass,
  type ImportCapabilityRecord,
  type ImportImplementerResult,
  type ImportInspectorResult,
  type ImportPlannerResult,
  type ImportVerifierResult,
  type RuntimeFamily,
} from '../import-capability/contracts.js';
import type { AppRegistries } from '../registries.js';
import { createSessionGuard } from './_guard.js';

const execFileAsync = promisify(execFile);
const importDataRoot = process.env.KOIFORGE_IMPORT_DATA_ROOT ?? join(process.cwd(), '.koiforge');
/** Exposes the root captured at module load so server startup can reject later environment drift. */
export function getImportSessionDataRoot(): string { return importDataRoot; }
const importSessionsRoot = join(importDataRoot, 'import-sessions');
const generatedPluginRoot = join(importDataRoot, 'import-plugins');
const archiveExts = new Set(['.zip', '.7z', '.tar', '.gz', '.bz2', '.xz', '.rar', '.tgz']);
const spreadsheetExts = new Set(['.xlsx', '.xls', '.ods']);
const textConfigExts = new Set(['.env', '.ini', '.cnf', '.conf', '.cfg', '.properties', '.yaml', '.yml', '.json', '.txt']);
const builtinDatabaseConnectors = builtInConnectors.filter((entry) => entry.category === 'database');
const plannerRuntimeActions = [
  'reuse_existing',
  'ask_user_input',
  'compose_existing',
  'extend_existing',
  'acquire_runtime',
  'generate_adapter',
  'reload_runtime',
  'resume_discovery',
] as const;
const plannerRuntimeFamilies = [
  'direct_parser',
  'embedded_runtime',
  'connection_runtime',
  'driver_bridge',
  'external_tool_bridge',
  'adapter_layer',
  'none',
] as const satisfies readonly RuntimeFamily[];
const plannerAcquisitionPaths = [
  'builtin_capability',
  'existing_runtime',
  'dependency_install',
  'system_driver',
  'service_binding',
  'tool_bridge',
  'generated_adapter',
  'manual_input',
  'none',
] as const satisfies readonly AcquisitionPath[];
const plannerExecutionGoals = [
  'open_source',
  'enumerate_entities',
  'describe_schema',
  'preview_rows',
  'stream_rows_for_import',
  'register_import_path',
] as const satisfies readonly ExecutionGoal[];
const plannerTokenBudget = 1600;
const implementerTokenBudget = 1200;

type CellValue = string | number | boolean | null;

type GeneratedPluginStrategy =
  | { type: 'csv'; delimiter: string }
  | { type: 'json'; path?: string }
  | { type: 'xml' }
  | { type: 'javascript'; code: string }
  | { type: 'sql-insert-dump' }
  | { type: 'runtime-discovery'; executor: 'powershell-odbc'; shellPath?: string; driverNameHint: string; connectionStringTemplate: string; tableLimit?: number; rowLimit?: number }
  | { type: 'db-discovery'; connectorId: 'postgres' | 'mysql' | 'mariadb' | 'mongodb' };

interface GeneratedImportPlugin {
  id: string;
  label: string;
  createdAt?: string;
  updatedAt?: string;
  artifactHash?: string;
  lastExecution?: ExecutionReceipt;
  introducedBy?: 'builtin' | 'generated' | 'extended';
  reusePriority?: number;
  dependencies?: string[];
  successCount?: number;
  lastUsedAt?: string;
  match: {
    extensions: string[];
  };
  strategy: GeneratedPluginStrategy;
  notes?: string;
}

interface ImportFormField {
  key: string;
  label: string;
  kind: 'text' | 'password' | 'number' | 'select' | 'checkbox';
  required: boolean;
  placeholder?: string;
  description?: string;
  options?: Array<{ label: string; value: string }>;
}

interface ImportInputForm {
  title: string;
  description?: string;
  fields: ImportFormField[];
}

function generatedParserContractFields(): ImportFormField[] {
  return [
    { key: 'expectedRows', label: 'Erwartete Datensätze', kind: 'number', required: true,
      description: 'Unabhängig bestätigte Anzahl aus der Quelle. Die KI setzt diese Erwartung nicht selbst.' },
    { key: 'requiredColumns', label: 'Bestätigte Pflichtspalten', kind: 'text', required: true,
      description: 'Kommagetrennte Feldnamen des vereinbarten Importvertrags.' },
  ];
}

interface ImportPreview {
  columns: string[];
  rows: Array<Record<string, CellValue>>;
  rowCount: number;
}

interface ImportTreeNode {
  id: string;
  parentId: string | null;
  label: string;
  kind:
    | 'folder'
    | 'archive'
    | 'file'
    | 'excel-workbook'
    | 'sheet'
    | 'json-array'
    | 'xml-table'
    | 'sqlite-database'
    | 'db-table'
    | 'db-connection';
  status: 'group' | 'ready' | 'needs_input' | 'gap' | 'importing' | 'imported' | 'failed';
  selected: boolean;
  detectedFormat?: string;
  capabilityId?: string;
  sourcePath?: string;
  children: string[];
  diagnostics: string[];
  preview?: ImportPreview;
  inputForm?: ImportInputForm;
  config: Record<string, string | number | boolean>;
  metadata?: Record<string, unknown>;
  importedDatasetId?: string;
}

interface ImportLogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  nodeId?: string;
}

interface CapabilityGap {
  id: string;
  nodeId: string;
  status: 'open' | 'resolved' | 'blocked';
  missingDimension: CapabilityGapDimension;
  bestKnownNextAction: CapabilityNextAction;
  message: string;
  diagnostics: string[];
  reuseCandidateIds: string[];
  attemptCount: number;
  updatedAt: string;
  lastInspector?: ImportInspectorResult;
  lastPlan?: ImportPlannerResult;
  lastImplementer?: ImportImplementerResult;
  lastVerifier?: ImportVerifierResult;
}

interface CapabilityRepairTrace {
  id: string;
  nodeId: string;
  createdAt: string;
  updatedAt: string;
  status: 'planned' | 'running' | 'implemented' | 'verified' | 'failed' | 'blocked';
  inspector: ImportInspectorResult;
  planner?: ImportPlannerResult;
  implementer?: ImportImplementerResult;
  verifier?: ImportVerifierResult;
  notes: string[];
}

interface CapabilityExecutionTask {
  id: string;
  nodeId: string;
  createdAt: string;
  updatedAt: string;
  status: 'running' | 'completed' | 'blocked' | 'failed';
  action: ImportImplementerResult['action'];
  summary: string;
  steps: string[];
  dependencies: string[];
  targetFiles: string[];
  runtimeArtifacts: string[];
  verificationPlan: string[];
  planType?: ImportPlannerResult['planType'];
  targetCapabilityId?: string;
  sourceClass: ImportSourceClass;
  runtimeFamily?: RuntimeFamily;
  acquisitionPath?: AcquisitionPath;
  executionGoals?: ExecutionGoal[];
  diagnostics?: string[];
  notes?: string[];
  artifactPath?: string;
}

interface RuntimeDriverCandidate {
  name: string;
  platform?: string;
}

interface RuntimeAcquisitionMetadata {
  status?: 'available' | 'missing';
  runtimeFamily?: RuntimeFamily;
  acquisitionPath?: AcquisitionPath;
  matchedDrivers?: string[];
  matchedDriverPlatforms?: string[];
  bridgeExecutable?: string;
  bridgeArchitecture?: string;
  processArchitecture?: string;
  connectionStringTemplate?: string;
  requiredSourceExtensions?: string[];
  requiredArchitecture?: string;
  requirements?: string[];
  acquisitionArtifactPath?: string;
  diagnostics?: string[];
}

interface ToolAcquisitionArtifact {
  kind: 'runtime-tool-acquisition';
  createdAt: string;
  sessionId: string;
  taskId: string;
  nodeId: string;
  source: {
    label: string;
    path?: string;
    extension?: string;
    detectedFormat?: string;
    sourceClass: ImportSourceClass;
  };
  runtimeRequirement: {
    runtimeFamily: RuntimeFamily;
    acquisitionPath: AcquisitionPath;
    processArchitecture?: string;
    requiredArchitecture?: string;
    requiredSourceExtensions: string[];
    executionGoals: ExecutionGoal[];
    requirements: string[];
  };
  observedDrivers: Array<{
    name: string;
    platform?: string;
    advertisedExtensions: string[];
    compatible: boolean;
    reasons: string[];
  }>;
  diagnostics: string[];
}

interface ImportSessionState {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: 'staged' | 'discovered' | 'running' | 'completed' | 'needs_review' | 'failed';
  rootPath: string;
  rootNodeIds: string[];
  nodes: Record<string, ImportTreeNode>;
  selectedNodeIds: string[];
  log: ImportLogEntry[];
  gaps: CapabilityGap[];
  repairHistory: CapabilityRepairTrace[];
  executionTasks: CapabilityExecutionTask[];
  generation: GenerationAudit;
}

function find7zBin(): string {
  const candidates = [
    'C:/Program Files/7-Zip/7z.exe',
    'C:/Program Files (x86)/7-Zip/7z.exe',
  ];
  return candidates.find(existsSync) ?? '7z';
}

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 63);
}

function nowIso(): string {
  return new Date().toISOString();
}

function addLog(session: ImportSessionState, level: ImportLogEntry['level'], message: string, nodeId?: string): void {
  session.log.unshift({
    id: randomUUID(),
    timestamp: nowIso(),
    level,
    message,
    nodeId,
  });
  session.updatedAt = nowIso();
}

function inferCell(value: string): CellValue {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (!Number.isNaN(Number(trimmed))) return Number(trimmed);
  return trimmed;
}

function inferDelimiter(filePath: string, sample: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.tsv')) return '\t';
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestScore = -1;
  for (const delimiter of candidates) {
    try {
      // Infer from complete records: quoted newlines are part of a field.
      const records = parseCsvRecords(sample, delimiter);
      const first = records[0]?.length ?? 0;
      const consistent = first > 1 && records.every(record => record.length === first);
      const score = first > 1 ? first + (consistent ? 0.5 : 0) : 0;
      if (score > bestScore) { best = delimiter; bestScore = score; }
    } catch { /* Other delimiters may interpret quoted cells correctly. */ }
  }
  return best;
}

function parseCsvPreview(text: string, delimiter: string): ImportPreview {
  const rows = parseCsvRows(text, delimiter);
  return {
    columns: rows.length > 0 ? Object.keys(rows[0]!) : [],
    rows: rows.slice(0, 10),
    rowCount: rows.length,
  };
}

function parseCsvRows(text: string, delimiter: string): Array<Record<string, CellValue>> {
  return parseCsvRowsStrict(text, delimiter);
}

function rowsToPreview(rows: Array<Record<string, CellValue>>): ImportPreview {
  const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
  return {
    columns,
    rows: rows.slice(0, 10),
    rowCount: rows.length,
  };
}

function parseJsonRows(text: string, path?: string): Array<Record<string, CellValue>> {
  let parsed = JSON.parse(text) as unknown;
  if (path) {
    for (const key of path.split('.')) {
      if (parsed && typeof parsed === 'object' && key in (parsed as Record<string, unknown>)) {
        parsed = (parsed as Record<string, unknown>)[key];
      } else {
        throw new Error(`JSON path '${path}' not found.`);
      }
    }
  }
  if (!Array.isArray(parsed)) {
    if (parsed && typeof parsed === 'object') {
      const firstArray = Object.entries(parsed as Record<string, unknown>).find(([, value]) => Array.isArray(value));
      if (firstArray) {
        parsed = firstArray[1];
      } else {
        parsed = [parsed];
      }
    } else {
      parsed = [{ value: parsed }];
    }
  }
  return (parsed as unknown[]).map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { value: entry == null ? null : String(entry) };
    }
    return Object.fromEntries(
      Object.entries(entry as Record<string, unknown>).map(([key, value]) => [
        key,
        value == null
          ? null
          : typeof value === 'number' || typeof value === 'boolean'
            ? value
            : typeof value === 'object'
              ? JSON.stringify(value)
              : String(value),
      ]),
    ) as Record<string, CellValue>;
  });
}

function parseJsonCandidates(text: string): Array<{ label: string; path?: string; rows: Array<Record<string, CellValue>> }> {
  const parsed = JSON.parse(text) as unknown;
  if (Array.isArray(parsed)) {
    return [{ label: 'root', rows: parseJsonRows(text) }];
  }
  if (!parsed || typeof parsed !== 'object') {
    return [{ label: 'root', rows: [{ value: parsed == null ? null : String(parsed) }] }];
  }

  const entries = Object.entries(parsed as Record<string, unknown>)
    .filter(([, value]) => Array.isArray(value))
    .map(([key]) => ({
      label: key,
      path: key,
      rows: parseJsonRows(text, key),
    }));

  if (entries.length > 0) {
    return entries;
  }

  return [{ label: 'root', rows: parseJsonRows(text) }];
}

function parseXmlRows(text: string): Array<Record<string, CellValue>> {
  const matchAll = [...text.matchAll(/<([A-Za-z_][A-Za-z0-9_.:-]*)\b[^>]*>([\s\S]*?)<\/\1>/g)];
  const counts = new Map<string, number>();
  for (const match of matchAll) {
    const tag = match[1];
    if (!tag) continue;
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  const repeated = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((left, right) => right[1] - left[1])[0]?.[0];

  if (!repeated) {
    throw new Error('XML structure has no supported repeated records; no partial XML import accepted.');
  }

  const itemRegex = new RegExp(`<${repeated}\\b[^>]*>([\\s\\S]*?)<\\/${repeated}>`, 'g');
  const items = [...text.matchAll(itemRegex)];
  return items.map((item) => {
    const body = item[1] ?? '';
    const fields = [...body.matchAll(/<([A-Za-z_][A-Za-z0-9_.:-]*)\b[^>]*>([\s\S]*?)<\/\1>/g)];
    if (fields.length === 0) {
      return { value: body.trim() };
    }
    return Object.fromEntries(
      fields.map((field) => {
        const fieldName = field[1] ?? 'value';
        const value = (field[2] ?? '').replace(/<[^>]+>/g, '').trim();
        return [fieldName, inferCell(value)];
      }),
    ) as Record<string, CellValue>;
  });
}

function normalizeFormFields(connector: ConnectorDefinition): ImportFormField[] {
  return connector.configFields
    .filter((field) => field.key !== 'columns')
    .map((field) => ({
      key: field.key,
      label: field.label,
      kind: field.type === 'number' ? 'number' : field.key.toLowerCase().includes('password') ? 'password' : 'text',
      required: Boolean(field.required),
      description: field.description,
      placeholder: field.required ? 'Required' : 'Optional',
    }));
}

function dbDiscoveryFields(connectorId: string): ImportFormField[] {
  if (connectorId === 'mysql' || connectorId === 'mariadb') {
    return [
      { key: 'host', label: 'Host', kind: 'text', required: true, placeholder: 'localhost' },
      { key: 'port', label: 'Port', kind: 'number', required: false, placeholder: '3306' },
      { key: 'database', label: 'Database', kind: 'text', required: true, placeholder: 'app' },
      { key: 'user', label: 'User', kind: 'text', required: true, placeholder: 'root' },
      { key: 'password', label: 'Password', kind: 'password', required: true },
      { key: 'schema', label: 'Schema', kind: 'text', required: false, placeholder: 'public' },
      { key: 'table', label: 'Table', kind: 'text', required: false, placeholder: 'leave empty for discovery only' },
    ];
  }
  if (connectorId === 'mongodb') {
    return [
      { key: 'uri', label: 'URI', kind: 'text', required: false, placeholder: 'mongodb://...' },
      { key: 'host', label: 'Host', kind: 'text', required: false, placeholder: 'localhost' },
      { key: 'port', label: 'Port', kind: 'number', required: false, placeholder: '27017' },
      { key: 'database', label: 'Database', kind: 'text', required: true, placeholder: 'app' },
      { key: 'user', label: 'User', kind: 'text', required: false },
      { key: 'password', label: 'Password', kind: 'password', required: false },
      { key: 'collection', label: 'Collection', kind: 'text', required: false, placeholder: 'leave empty for discovery only' },
    ];
  }
  return [];
}

function commonDatasetFields(includeMode = false): ImportFormField[] {
  const fields: ImportFormField[] = [
    { key: 'datasetName', label: 'Dataset Name', kind: 'text', required: true, placeholder: 'dataset_name' },
    { key: 'namespace', label: 'Namespace', kind: 'text', required: true, placeholder: 'imports' },
  ];
  if (includeMode) {
    fields.push({
      key: 'mode',
      label: 'Mode',
      kind: 'select',
      required: true,
      options: [
        { label: 'Materialized', value: 'materialized' },
        { label: 'Virtual', value: 'virtual' },
      ],
    });
  }
  return fields;
}

function requiredFieldsMissing(node: ImportTreeNode): boolean {
  if (!node.inputForm) return false;
  return node.inputForm.fields.some((field) => {
    const value = node.config[field.key];
    if (!field.required) return false;
    if (field.kind === 'checkbox') return value !== true && value !== false;
    return value == null || String(value).trim().length === 0;
  });
}

function createSessionState(id: string, rootPath: string): ImportSessionState {
  const timestamp = nowIso();
  return {
    id,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: 'staged',
    rootPath,
    rootNodeIds: [],
    nodes: {},
    selectedNodeIds: [],
    log: [],
    gaps: [],
    repairHistory: [],
    executionTasks: [],
    generation: emptyGenerationAudit(),
  };
}

function addNode(session: ImportSessionState, node: Omit<ImportTreeNode, 'id' | 'children'> & { id?: string; children?: string[] }): ImportTreeNode {
  const id = node.id ?? randomUUID();
  const created: ImportTreeNode = {
    ...node,
    id,
    children: node.children ?? [],
  };
  session.nodes[id] = created;
  if (created.parentId) {
    session.nodes[created.parentId]?.children.push(id);
  } else {
    session.rootNodeIds.push(id);
  }
  if (created.selected) {
    session.selectedNodeIds.push(id);
  }
  return created;
}

function sanitizeFileName(input: string): string {
  return input.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || `upload_${Date.now()}`;
}

async function writeSession(session: ImportSessionState): Promise<void> {
  await mkdir(session.rootPath, { recursive: true });
  const temporary = join(session.rootPath, `session-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, join(session.rootPath, 'session.json'));
  } finally { await rm(temporary, { force: true }); }
}

async function readSession(sessionId: string): Promise<ImportSessionState | null> {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(sessionId)) return null;
  const filePath = join(importSessionsRoot, sessionId, 'session.json');
  try {
    const content = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(content) as ImportSessionState & { gaps?: CapabilityGap[]; repairHistory?: CapabilityRepairTrace[]; executionTasks?: CapabilityExecutionTask[] };
    return {
      ...parsed,
      gaps: parsed.gaps ?? [],
      repairHistory: parsed.repairHistory ?? [],
      executionTasks: parsed.executionTasks ?? [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('Import session could not be read; persisted state was not replaced.');
  }
}

async function ensureUniquePath(targetDir: string, fileName: string): Promise<string> {
  const ext = extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length) || 'upload';
  let attempt = 0;
  while (true) {
    const candidate = join(targetDir, attempt === 0 ? fileName : `${stem}_${attempt}${ext}`);
    if (!existsSync(candidate)) {
      return candidate;
    }
    attempt += 1;
  }
}

function sourceExtensionOf(node: ImportTreeNode): string | undefined {
  return node.sourcePath ? extname(node.sourcePath).toLowerCase() || undefined : undefined;
}

function extractAdvertisedFileExtensions(label: string): string[] {
  const extensions = [...label.matchAll(/\*\.([a-z0-9_+-]+)/gi)]
    .map((match) => `.${(match[1] ?? '').toLowerCase()}`)
    .filter((entry) => entry.length > 1);
  return dedupeStrings(extensions);
}

function driverMatchesExtensionFamily(driverName: string, extension?: string): {
  compatible: boolean;
  advertisedExtensions: string[];
  reason?: string;
} {
  const advertisedExtensions = extractAdvertisedFileExtensions(driverName);
  if (!extension || advertisedExtensions.length === 0) {
    return {
      compatible: true,
      advertisedExtensions,
    };
  }
  if (advertisedExtensions.includes(extension.toLowerCase())) {
    return {
      compatible: true,
      advertisedExtensions,
    };
  }
  return {
    compatible: false,
    advertisedExtensions,
    reason: `Driver advertises ${advertisedExtensions.join(', ')} but the source requires ${extension.toLowerCase()}.`,
  };
}

function assessDriverCompatibility(driver: RuntimeDriverCandidate, node?: ImportTreeNode): {
  compatible: boolean;
  reasons: string[];
  advertisedExtensions: string[];
} {
  const reasons: string[] = [];
  const extension = node ? sourceExtensionOf(node) ?? undefined : undefined;
  const sourceClass = node ? inferSourceClass(node) : undefined;
  const lower = driver.name.toLowerCase();
  const extensionMatch = driverMatchesExtensionFamily(driver.name, extension);

  if (sourceClass === 'binary_runtime_candidate') {
    if (/(text|csv|oracle|excel|paradox|dbase)/i.test(lower)) {
      reasons.push(`Driver family '${driver.name}' is semantically incompatible with source class '${sourceClass}'.`);
    }
    if (extension && !['.txt', '.csv', '.tsv', '.xls', '.xlsx'].includes(extension) && /(txt|csv)/i.test(lower)) {
      reasons.push(`Driver family '${driver.name}' is semantically incompatible with source extension '${extension}'.`);
    }
  }

  if (sourceClass === 'tabular_text' || sourceClass === 'structured_text') {
    if (/(oracle|access|sql server|mysql|postgres)/i.test(lower) && !['.sql'].includes(extension ?? '')) {
      reasons.push(`Driver family '${driver.name}' is semantically incompatible with source class '${sourceClass}'.`);
    }
  }

  if (!extensionMatch.compatible && extensionMatch.reason) {
    reasons.push(extensionMatch.reason);
  }

  return {
    compatible: reasons.length === 0,
    reasons: dedupeStrings(reasons),
    advertisedExtensions: extensionMatch.advertisedExtensions,
  };
}

function requiredRuntimeSourceExtensions(node: ImportTreeNode): string[] {
  const extension = sourceExtensionOf(node);
  if (!extension) {
    return [];
  }
  const sourceClass = inferSourceClass(node);
  if (sourceClass === 'binary_runtime_candidate' || sourceClass === 'connection_config' || sourceClass === 'database_entity') {
    return [extension];
  }
  return [];
}

function looksLikeRuntimeBackedBinary(node: ImportTreeNode, extension?: string): boolean {
  const detected = (node.detectedFormat ?? '').toLowerCase();
  const stem = extension?.replace(/^\./, '') ?? '';
  const dbishToken = /\b(database|catalog|schema|record|table|index|collection|engine|connection)\b/i;
  return detected.includes('sqlite')
    || detected.includes('connection')
    || (stem.length > 0 && /(?:db|db\d+|database)$/i.test(stem))
    || dbishToken.test(detected);
}

function runtimeFamiliesForSourceClass(sourceClass: ImportSourceClass): RuntimeFamily[] {
  if (sourceClass === 'tabular_text' || sourceClass === 'structured_text') {
    return ['direct_parser', 'adapter_layer'];
  }
  if (sourceClass === 'connection_config') {
    return ['connection_runtime', 'driver_bridge', 'adapter_layer'];
  }
  if (sourceClass === 'binary_runtime_candidate' || sourceClass === 'database_entity') {
    return ['embedded_runtime', 'driver_bridge', 'adapter_layer', 'external_tool_bridge'];
  }
  if (sourceClass === 'archive_or_bundle' || sourceClass === 'mixed_source') {
    return ['direct_parser', 'embedded_runtime', 'connection_runtime', 'adapter_layer'];
  }
  return ['direct_parser', 'embedded_runtime', 'connection_runtime', 'driver_bridge', 'external_tool_bridge', 'adapter_layer'];
}

function acquisitionPathsForGap(missingDimension: CapabilityGapDimension): AcquisitionPath[] {
  if (missingDimension === 'ask_input') {
    return ['manual_input'];
  }
  if (missingDimension === 'runtime_strategy') {
    return ['existing_runtime', 'dependency_install', 'system_driver', 'tool_bridge', 'generated_adapter'];
  }
  if (missingDimension === 'tool_acquisition') {
    return ['dependency_install', 'system_driver', 'tool_bridge'];
  }
  if (missingDimension === 'adapter_generation') {
    return ['generated_adapter', 'existing_runtime'];
  }
  if (missingDimension === 'discover_entities' || missingDimension === 'preview_rows' || missingDimension === 'import_entity') {
    return ['builtin_capability', 'existing_runtime', 'generated_adapter', 'service_binding'];
  }
  return ['builtin_capability', 'existing_runtime', 'generated_adapter', 'service_binding', 'tool_bridge'];
}

function executionGoalsForNode(sourceClass: ImportSourceClass, missingDimension: CapabilityGapDimension): ExecutionGoal[] {
  if (missingDimension === 'ask_input') {
    return ['register_import_path'];
  }
  if (sourceClass === 'tabular_text' || sourceClass === 'structured_text') {
    return ['open_source', 'preview_rows', 'register_import_path'];
  }
  if (sourceClass === 'binary_runtime_candidate' || sourceClass === 'database_entity' || sourceClass === 'connection_config') {
    return ['open_source', 'enumerate_entities', 'describe_schema', 'preview_rows', 'stream_rows_for_import', 'register_import_path'];
  }
  return plannerExecutionGoals.slice();
}

function inferSourceClass(node: ImportTreeNode): ImportSourceClass {
  const extension = sourceExtensionOf(node);
  const detected = (node.detectedFormat ?? '').toLowerCase();

  if (node.kind === 'archive' || node.kind === 'folder') {
    return 'archive_or_bundle';
  }
  if (node.kind === 'db-connection') {
    return 'connection_config';
  }
  if (node.kind === 'db-table' || node.kind === 'sqlite-database') {
    return 'database_entity';
  }
  if (node.kind === 'json-array' || node.kind === 'xml-table' || node.kind === 'sheet') {
    return 'structured_text';
  }
  if (extension && ['.csv', '.tsv'].includes(extension)) {
    return 'tabular_text';
  }
  if (extension && ['.json', '.xml', '.txt', '.yaml', '.yml', '.ini', '.cfg', '.conf', '.cnf', '.properties', '.env'].includes(extension)) {
    return 'structured_text';
  }
  if (looksLikeRuntimeBackedBinary(node, extension)) {
    return 'binary_runtime_candidate';
  }
  if (node.kind === 'file' && extension && !textConfigExts.has(extension) && !archiveExts.has(extension) && !spreadsheetExts.has(extension)) {
    return 'binary_structured';
  }
  if (node.kind === 'excel-workbook') {
    return 'mixed_source';
  }
  return 'unknown_source';
}

function readRuntimeAcquisitionMetadata(node: ImportTreeNode): RuntimeAcquisitionMetadata | undefined {
  if (!node.metadata || typeof node.metadata !== 'object' || !('runtimeAcquisition' in node.metadata)) {
    return undefined;
  }
  const runtimeAcquisition = (node.metadata as Record<string, unknown>).runtimeAcquisition;
  if (!runtimeAcquisition || typeof runtimeAcquisition !== 'object') {
    return undefined;
  }
  return runtimeAcquisition as RuntimeAcquisitionMetadata;
}

function runtimePlanningContext(node: ImportTreeNode): {
  processArchitecture?: string;
  bridgeArchitecture?: string;
  bridgeExecutable?: string;
  requiredArchitecture?: string;
  requiredSourceExtensions?: string[];
  requirements?: string[];
  acquisitionArtifactPath?: string;
  matchedDrivers: Array<{ name: string; platform?: string }>;
  diagnostics: string[];
} | undefined {
  const runtimeAcquisition = readRuntimeAcquisitionMetadata(node);
  if (!runtimeAcquisition) {
    return undefined;
  }
  return {
    processArchitecture: runtimeAcquisition.processArchitecture,
    bridgeArchitecture: runtimeAcquisition.bridgeArchitecture,
    bridgeExecutable: runtimeAcquisition.bridgeExecutable,
    requiredArchitecture: runtimeAcquisition.requiredArchitecture,
    requiredSourceExtensions: runtimeAcquisition.requiredSourceExtensions,
    requirements: runtimeAcquisition.requirements,
    acquisitionArtifactPath: runtimeAcquisition.acquisitionArtifactPath,
    matchedDrivers: (runtimeAcquisition.matchedDrivers ?? []).map((name, index) => ({
      name,
      platform: runtimeAcquisition.matchedDriverPlatforms?.[index],
    })),
    diagnostics: runtimeAcquisition.diagnostics ?? [],
  };
}

function binaryPlanningContext(
  node: ImportTreeNode,
  buffer: Buffer,
): {
  sizeBytes: number;
  extension?: string;
  signatureHex: string;
  printableSample: string;
} {
  const asciiSample = buffer
    .slice(0, 512)
    .toString('latin1')
    .replace(/[^\x20-\x7E]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);

  return {
    sizeBytes: buffer.byteLength,
    extension: sourceExtensionOf(node),
    signatureHex: buffer.slice(0, 32).toString('hex'),
    printableSample: asciiSample,
  };
}

function pluginDependencies(plugin: GeneratedImportPlugin): string[] {
  if (plugin.dependencies && plugin.dependencies.length > 0) {
    return plugin.dependencies;
  }
  if (plugin.strategy.type === 'db-discovery') {
    if (plugin.strategy.connectorId === 'postgres') return ['postgres'];
    if (plugin.strategy.connectorId === 'mysql' || plugin.strategy.connectorId === 'mariadb') return ['mysql2'];
    if (plugin.strategy.connectorId === 'mongodb') return ['mongodb'];
  }
  return [];
}

function connectorToCapabilityRecord(connector: ConnectorDefinition): ImportCapabilityRecord {
  return {
    id: connector.id,
    kind: 'connector',
    handles: {
      sourceKinds: [connector.category],
      dbEngines: connector.category === 'database' ? [connector.id] : undefined,
      formats: connector.capabilities,
    },
    reusePriority: connector.category === 'database' ? 100 : 90,
    dependencies:
      connector.id === 'postgres'
        ? ['postgres']
        : connector.id === 'sqlite'
          ? ['better-sqlite3']
          : connector.id === 'mysql'
            ? ['mysql2']
            : [],
    files: ['packages/data-registry/src/builtin-connectors.ts', 'packages/data-registry/src/file-dataset-registry.ts'],
    introducedBy: 'builtin',
    successCount: 0,
    notes: `${connector.name} built-in capability`,
  };
}

function generatedPluginToCapabilityRecord(plugin: GeneratedImportPlugin): ImportCapabilityRecord {
  return {
    id: plugin.id,
    kind: plugin.strategy.type === 'db-discovery' || plugin.strategy.type === 'runtime-discovery' ? 'discovery' : 'plugin',
    handles: {
      sourceKinds: plugin.strategy.type === 'db-discovery' || plugin.strategy.type === 'runtime-discovery' ? ['database', 'file'] : ['file'],
      fileExtensions: plugin.match.extensions,
      dbEngines: plugin.strategy.type === 'db-discovery' ? [plugin.strategy.connectorId] : undefined,
      formats: [plugin.strategy.type],
    },
    reusePriority: plugin.reusePriority ?? (plugin.strategy.type === 'db-discovery' || plugin.strategy.type === 'runtime-discovery' ? 85 : 80),
    dependencies: pluginDependencies(plugin),
    files: [join('.koiforge', 'import-plugins', `${plugin.id}.json`)],
    introducedBy: plugin.introducedBy ?? 'generated',
    successCount: plugin.successCount ?? 0,
    lastUsedAt: plugin.lastUsedAt,
    notes: plugin.notes,
  };
}

function runtimeDiscoveryPluginLooksCatalogCompatible(plugin: GeneratedImportPlugin): boolean {
  const { strategy } = plugin;
  if (strategy.type !== 'runtime-discovery') {
    return true;
  }
  const matchExtensions = plugin.match.extensions ?? [];
  return matchExtensions.every((extension) => driverMatchesExtensionFamily(strategy.driverNameHint, extension).compatible);
}

async function loadCapabilityCatalog(): Promise<ImportCapabilityRecord[]> {
  const plugins = await loadGeneratedPlugins();
  return [
    ...builtInConnectors.map(connectorToCapabilityRecord),
    ...plugins
      .filter(runtimeDiscoveryPluginLooksCatalogCompatible)
      .map(generatedPluginToCapabilityRecord),
  ].sort((left, right) => right.reusePriority - left.reusePriority || left.id.localeCompare(right.id));
}

function findReuseCandidateIds(node: ImportTreeNode, capabilityCatalog: ImportCapabilityRecord[]): string[] {
  const extension = sourceExtensionOf(node);
  const sourceClass = inferSourceClass(node);
  const sourceKind =
    sourceClass === 'connection_config' || sourceClass === 'database_entity'
      ? 'database'
      : sourceClass === 'archive_or_bundle'
        ? 'archive'
        : 'file';

  return capabilityCatalog
    .filter((entry) => {
      if (!entry.handles.sourceKinds.includes(sourceKind) && !entry.handles.sourceKinds.includes('file')) {
        return false;
      }
      if (extension && entry.handles.fileExtensions?.includes(extension)) {
        return true;
      }
      if (sourceClass === 'connection_config' && entry.kind === 'connector') {
        return entry.handles.sourceKinds.includes('database');
      }
      if (sourceClass === 'binary_structured' || sourceClass === 'binary_runtime_candidate') {
        return (
          (entry.kind === 'discovery' || entry.kind === 'connector')
          && (entry.handles.sourceKinds.includes('database') || Boolean(entry.handles.dbEngines?.length))
        );
      }
      if (sourceClass === 'structured_text' || sourceClass === 'tabular_text') {
        return entry.kind === 'plugin' || entry.kind === 'parser' || entry.kind === 'connector';
      }
      if (sourceClass === 'archive_or_bundle') {
        return entry.kind === 'discovery';
      }
      if ((node.detectedFormat ?? '') && entry.handles.formats?.some((format) => (node.detectedFormat ?? '').toLowerCase().includes(format.toLowerCase()))) {
        return true;
      }
      return false;
    })
    .map((entry) => entry.id)
    .slice(0, 8);
}

function inspectNodeCapabilityGap(
  node: ImportTreeNode,
  capabilityCatalog: ImportCapabilityRecord[],
): ImportInspectorResult {
  const sourceClass = inferSourceClass(node);
  const runtimeAcquisition = readRuntimeAcquisitionMetadata(node);
  const requiredInputs = (node.inputForm?.fields ?? [])
    .filter((field) => field.required)
    .filter((field) => {
      const value = node.config[field.key];
      if (field.kind === 'checkbox') return value !== true && value !== false;
      return value == null || String(value).trim().length === 0;
    })
    .map((field) => field.key);
  const reuseCandidateIds = findReuseCandidateIds(node, capabilityCatalog);
  const diagnostics = node.diagnostics.length > 0 ? node.diagnostics : ['Import flow is currently blocked.'];

  let missingDimension: CapabilityGapDimension = 'import_entity';
  if (requiredInputs.length > 0 || node.status === 'needs_input') {
    missingDimension = 'ask_input';
  } else if (runtimeAcquisition?.status === 'available' && !node.capabilityId) {
    missingDimension = 'adapter_generation';
  } else if (runtimeAcquisition?.status === 'missing') {
    missingDimension = 'tool_acquisition';
  } else if (sourceClass === 'binary_structured' || sourceClass === 'binary_runtime_candidate') {
    missingDimension = 'runtime_strategy';
  } else if (diagnostics.some((entry) => /driver|dependency|runtime|tool|execution capability/i.test(entry))) {
    missingDimension = 'tool_acquisition';
  } else if (node.kind === 'db-connection' && !node.capabilityId) {
    missingDimension = 'discover_entities';
  } else if (node.kind === 'db-table' && !node.preview) {
    missingDimension = 'preview_rows';
  } else if (node.status === 'failed') {
    missingDimension = 'preview_rows';
  } else if (!node.capabilityId && (node.detectedFormat === 'unknown' || diagnostics.some((entry) => /no existing import capability/i.test(entry)))) {
    missingDimension = 'classify_source';
  }

  let bestKnownNextAction: CapabilityNextAction = 'extend_existing';
  if (missingDimension === 'ask_input') {
    bestKnownNextAction = 'ask_user_input';
  } else if (missingDimension === 'runtime_strategy') {
    bestKnownNextAction = reuseCandidateIds.length > 0 ? 'acquire_runtime' : 'generate_adapter';
  } else if (missingDimension === 'tool_acquisition') {
    bestKnownNextAction = 'acquire_runtime';
  } else if (missingDimension === 'adapter_generation') {
    bestKnownNextAction = 'generate_adapter';
  } else if (missingDimension === 'discover_entities') {
    bestKnownNextAction = node.capabilityId ? 'resume_discovery' : 'extend_existing';
  } else if (missingDimension === 'preview_rows') {
    bestKnownNextAction = 'resume_discovery';
  } else if (reuseCandidateIds.length > 0) {
    bestKnownNextAction = node.capabilityId ? 'reuse_existing' : 'extend_existing';
  } else if (missingDimension === 'classify_source') {
    bestKnownNextAction = sourceClass === 'binary_structured' ? 'acquire_runtime' : 'generate_adapter';
  }

  return {
    nodeId: node.id,
    nodeLabel: node.label,
    nodeKind: node.kind,
    sourceClass,
    detectedFormat: node.detectedFormat,
    sourceExtension: sourceExtensionOf(node),
    diagnostics,
    requiredInputs,
    reuseCandidateIds,
    missingDimension,
    bestKnownNextAction,
    capabilityGap: diagnostics[0] ?? 'Import capability gap detected.',
  };
}

function upsertGap(
  session: ImportSessionState,
  node: ImportTreeNode,
  inspector: ImportInspectorResult,
): void {
  const existing = session.gaps.find((gap) => gap.nodeId === node.id);
  if (existing) {
    existing.missingDimension = inspector.missingDimension;
    existing.bestKnownNextAction = inspector.bestKnownNextAction;
    existing.message = inspector.capabilityGap;
    existing.diagnostics = inspector.diagnostics;
    existing.reuseCandidateIds = inspector.reuseCandidateIds;
    existing.lastInspector = inspector;
    existing.status = verifiedImport(session, node) ? 'resolved' : existing.status === 'blocked' ? 'blocked' : 'open';
    existing.updatedAt = nowIso();
    return;
  }
  session.gaps.push({
    id: randomUUID(),
    nodeId: node.id,
    status: verifiedImport(session, node) ? 'resolved' : 'open',
    missingDimension: inspector.missingDimension,
    bestKnownNextAction: inspector.bestKnownNextAction,
    message: inspector.capabilityGap,
    diagnostics: inspector.diagnostics,
    reuseCandidateIds: inspector.reuseCandidateIds,
    attemptCount: 0,
    updatedAt: nowIso(),
    lastInspector: inspector,
  });
}

async function syncGaps(session: ImportSessionState): Promise<ImportCapabilityRecord[]> {
  const capabilityCatalog = await loadCapabilityCatalog();
  for (const node of Object.values(session.nodes)) {
    if (node.status !== 'gap' && node.status !== 'failed' && node.status !== 'needs_input' && !node.metadata?.pluginActivationError) {
      continue;
    }
    upsertGap(session, node, inspectNodeCapabilityGap(node, capabilityCatalog));
  }

  session.gaps = session.gaps.map((gap) => {
    const node = session.nodes[gap.nodeId];
    const verified = node && verifiedImport(session, node);
    const verifier: ImportVerifierResult | undefined = verified ? {
      verdict: 'resolved', closedGap: true,
      summary: 'Registered dataset passed complete readback and integrity verification.',
      diagnostics: [], resultingCapabilityId: node.capabilityId,
    } : gap.lastVerifier?.verdict === 'resolved' ? {
      verdict: 'needs_retry', closedGap: false,
      summary: 'Registered dataset verification is pending.', diagnostics: [],
    } : gap.lastVerifier;
    const trace = session.repairHistory.find((entry) => entry.nodeId === gap.nodeId);
    if (trace && verified) { trace.status = 'verified'; trace.verifier = verifier; }
    return { ...gap, status: verified ? 'resolved' : gap.status === 'blocked' ? 'blocked' : 'open',
      lastVerifier: verifier, updatedAt: nowIso() };
  });

  return capabilityCatalog;
}

function verifiedImport(session: ImportSessionState, node: ImportTreeNode, seen = new Set<string>()): boolean {
  if (seen.has(node.id)) return false;
  seen.add(node.id);
  if (node.children.length > 0) return node.children.every((id) => {
    const child = session.nodes[id];
    return child ? verifiedImport(session, child, new Set(seen)) : false;
  });
  const proof = node.metadata?.importVerification as { datasetId?: string; coverage?: string } | undefined;
  return node.status === 'imported' && !node.metadata?.pluginActivationError && !!node.importedDatasetId
    && proof?.datasetId === node.importedDatasetId && proof.coverage === 'complete';
}

async function extractArchive(filePath: string, outputDir: string): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await execStateWriter(importDataRoot, find7zBin(), ['x', filePath, `-o${outputDir}`, '-y'], { timeout: 60_000 });
}

async function loadXlsx(): Promise<{
  read: (data: Buffer, options: { type: 'buffer' }) => { SheetNames: string[]; Sheets: Record<string, unknown> };
  utils: {
    sheet_to_json: <T>(sheet: unknown, options: { defval: null }) => T[];
  };
}> {
  // @ts-ignore - reuse workspace dependency from console-web for the first import-session cut
  return import('../../../console-web/node_modules/xlsx/xlsx.mjs');
}

function buildDbConnectionForm(connectorId: string, description?: string): ImportInputForm {
  const connector = builtinDatabaseConnectors.find((entry) => entry.id === runtimeConnectorId(connectorId)) ?? builtinDatabaseConnectors[0];
  const connectorFields = dbDiscoveryFields(connectorId).length > 0
    ? dbDiscoveryFields(connectorId)
    : connector ? normalizeFormFields(connector) : [];
  return {
    title: `Configure ${connector?.name ?? 'Database Connector'}`,
    description,
    fields: [
      {
        key: 'connectorId',
        label: 'Connector',
        kind: 'select',
        required: true,
        options: builtinDatabaseConnectors.map((entry) => ({ label: entry.name, value: entry.id })),
      },
      ...commonDatasetFields(true),
      ...connectorFields,
    ],
  };
}

function refreshDbConnectionNode(node: ImportTreeNode): void {
  const connectorId = typeof node.config.connectorId === 'string' ? String(node.config.connectorId) : 'postgres';
  node.inputForm = buildDbConnectionForm(
    connectorId,
    'The system found a database connection candidate. Complete or correct the missing fields before importing.',
  );
  node.status = requiredFieldsMissing(node) ? 'needs_input' : 'ready';
}

async function detectConnectionHints(filePath: string): Promise<Array<{ connectorId: string; config: Record<string, string | number | boolean>; diagnostics: string[] }>> {
  const content = await readTabularText(filePath);
  const hints: Array<{ connectorId: string; config: Record<string, string | number | boolean>; diagnostics: string[] }> = [];
  const uriMatch = content.match(/\b(postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?):\/\/[^\s'"`]+/i);
  if (uriMatch) {
    const uri = uriMatch[0];
    try {
      const url = new URL(uri);
      const protocol = url.protocol.replace(':', '').toLowerCase();
      if (protocol === 'postgres' || protocol === 'postgresql') {
        hints.push({
          connectorId: 'postgres',
          config: {
            connectorId: 'postgres',
            datasetName: slugify(url.pathname.replace(/^\//, '') || basename(filePath, extname(filePath))),
            namespace: 'imports',
            mode: 'materialized',
            host: url.hostname,
            port: url.port ? Number(url.port) : 5432,
            database: url.pathname.replace(/^\//, ''),
            user: decodeURIComponent(url.username),
            password: decodeURIComponent(url.password),
            schema: 'public',
            table: '',
          },
          diagnostics: [`Detected connection URI in ${basename(filePath)}.`],
        });
      } else if (protocol === 'mysql' || protocol === 'mariadb') {
        hints.push({
          connectorId: 'mysql',
          config: {
            connectorId: 'mysql',
            datasetName: slugify(url.pathname.replace(/^\//, '') || basename(filePath, extname(filePath))),
            namespace: 'imports',
            mode: 'materialized',
            database: url.pathname.replace(/^\//, ''),
            schema: '',
            table: '',
          },
          diagnostics: [`Detected ${protocol} connection URI in ${basename(filePath)}.`],
        });
      } else if (protocol.startsWith('mongodb')) {
        hints.push({
          connectorId: 'mongodb',
          config: {
            connectorId: 'mongodb',
            datasetName: slugify(basename(filePath, extname(filePath))),
            namespace: 'imports',
          },
          diagnostics: ['MongoDB connection detected, but no built-in connector exists yet.'],
        });
      }
    } catch {
      // Ignore malformed URI.
    }
  }

  const env = Object.fromEntries(
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const idx = line.indexOf('=');
        return [line.slice(0, idx).trim().toUpperCase(), line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '')];
      }),
  );

  if (Object.keys(env).length > 0) {
    if (env.POSTGRES_DB || env.PGHOST || env.PGUSER) {
      hints.push({
        connectorId: 'postgres',
        config: {
          connectorId: 'postgres',
          datasetName: slugify(String(env.POSTGRES_DB ?? env.PGDATABASE ?? basename(filePath, extname(filePath)))),
          namespace: 'imports',
          mode: 'materialized',
          host: String(env.PGHOST ?? env.POSTGRES_HOST ?? 'localhost'),
          port: Number(env.PGPORT ?? env.POSTGRES_PORT ?? 5432),
          database: String(env.POSTGRES_DB ?? env.PGDATABASE ?? ''),
          user: String(env.PGUSER ?? env.POSTGRES_USER ?? ''),
          password: String(env.PGPASSWORD ?? env.POSTGRES_PASSWORD ?? ''),
          schema: 'public',
          table: '',
        },
        diagnostics: ['Detected Postgres environment variables.'],
      });
    }
    if (env.MYSQL_DATABASE || env.MARIADB_DATABASE || env.MYSQL_HOST) {
      hints.push({
        connectorId: 'mysql',
        config: {
          connectorId: 'mysql',
          datasetName: slugify(String(env.MYSQL_DATABASE ?? env.MARIADB_DATABASE ?? basename(filePath, extname(filePath)))),
          namespace: 'imports',
          mode: 'materialized',
          database: String(env.MYSQL_DATABASE ?? env.MARIADB_DATABASE ?? ''),
          schema: String(env.MYSQL_SCHEMA ?? env.MARIADB_SCHEMA ?? ''),
          table: '',
        },
        diagnostics: ['Detected MySQL or MariaDB environment variables.'],
      });
    }
    if (env.MONGO_URL || env.MONGODB_URI) {
      hints.push({
        connectorId: 'mongodb',
        config: {
          connectorId: 'mongodb',
          datasetName: slugify(basename(filePath, extname(filePath))),
          namespace: 'imports',
        },
        diagnostics: ['Detected MongoDB environment variables, but no built-in connector exists yet.'],
      });
    }
  }

  const deduped = new Map<string, { connectorId: string; config: Record<string, string | number | boolean>; diagnostics: string[] }>();
  for (const hint of hints) {
    deduped.set(`${hint.connectorId}:${JSON.stringify(hint.config)}`, hint);
  }
  return [...deduped.values()];
}

function looksLikeConnectionObject(rows: Array<Record<string, CellValue>>): boolean {
  if (rows.length !== 1) return false;
  const keys = Object.keys(rows[0] ?? {}).map((key) => key.toLowerCase());
  const signals = ['host', 'port', 'database', 'db', 'user', 'username', 'password', 'uri', 'url', 'schema', 'table'];
  return keys.filter((key) => signals.some((signal) => key.includes(signal))).length >= 2;
}

async function writeRowsArtifact(session: ImportSessionState, nodeId: string, rows: Array<Record<string, CellValue>>): Promise<string> {
  rows = validateRows(rows);
  const artifactDir = join(session.rootPath, 'artifacts');
  await mkdir(artifactDir, { recursive: true });
  const filePath = join(artifactDir, `${nodeId}.rows.json`);
  const serialized = JSON.stringify(rows);
  if (Buffer.byteLength(serialized) > EXECUTION_PROFILE.maxOutputBytes) throw new Error('Rows artifact exceeds output budget.');
  await writeFile(filePath, `${serialized}\n`, 'utf8');
  await writeFile(`${filePath}.proof.json`, JSON.stringify({ rows: rows.length, hash: rowsHash(rows) }), 'utf8');
  return filePath;
}

async function readRowsArtifact(pathValue: string): Promise<Array<Record<string, CellValue>>> {
  const content = await readFile(pathValue, 'utf8');
  const rows = validateRows(JSON.parse(content));
  const proof = JSON.parse(await readFile(`${pathValue}.proof.json`, 'utf8')) as { rows: number; hash: string };
  if (proof.rows !== rows.length || proof.hash !== rowsHash(rows)) throw new Error('Rows artifact integrity check failed.');
  return rows;
}

function normalizeSqlIdentifier(raw: string): string {
  return raw.trim().replace(/^[`"'[]+|[`"'\]]+$/g, '');
}

function normalizeDiscoveryConnectorId(connectorId: string): 'postgres' | 'mysql' | 'mariadb' | 'mongodb' {
  if (connectorId === 'mariadb') return 'mariadb';
  if (connectorId === 'mongodb') return 'mongodb';
  if (connectorId === 'mysql') return 'mysql';
  return 'postgres';
}

function runtimeConnectorId(connectorId: string): string {
  return connectorId === 'mariadb' ? 'mysql' : connectorId;
}

function parseSqlScalar(token: string): CellValue {
  const trimmed = token.trim();
  if (!trimmed || /^null$/i.test(trimmed)) return null;
  if (/^true$/i.test(trimmed)) return true;
  if (/^false$/i.test(trimmed)) return false;
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (!Number.isNaN(Number(trimmed))) return Number(trimmed);
  return trimmed;
}

function parseInsertValueTuples(raw: string): CellValue[][] {
  const tuples: CellValue[][] = [];
  let currentTuple: CellValue[] = [];
  let currentValue = '';
  let inQuote = false;
  let tupleDepth = 0;

  const pushValue = () => {
    currentTuple.push(parseSqlScalar(currentValue));
    currentValue = '';
  };

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    const next = raw[i + 1];
    if (ch === "'") {
      currentValue += ch;
      if (inQuote && next === "'") {
        currentValue += next;
        i += 1;
      } else {
        inQuote = !inQuote;
      }
      continue;
    }
    if (!inQuote && ch === '(') {
      tupleDepth += 1;
      if (tupleDepth === 1) {
        currentTuple = [];
        currentValue = '';
        continue;
      }
    }
    if (!inQuote && ch === ')') {
      tupleDepth -= 1;
      if (tupleDepth === 0) {
        pushValue();
        tuples.push(currentTuple);
        currentTuple = [];
        currentValue = '';
        continue;
      }
    }
    if (!inQuote && tupleDepth === 1 && ch === ',') {
      pushValue();
      continue;
    }
    if (tupleDepth >= 1) {
      currentValue += ch;
    }
  }

  return tuples;
}

function parseSqlDumpTables(text: string): Array<{ table: string; rows: Array<Record<string, CellValue>> }> {
  const tableRows = new Map<string, Array<Record<string, CellValue>>>();
  const insertPattern = /INSERT\s+INTO\s+([`"'[\]\w.]+)\s*\(([^)]+)\)\s*VALUES\s*([\s\S]*?);/gi;
  let match: RegExpExecArray | null;
  while ((match = insertPattern.exec(text)) !== null) {
    const table = normalizeSqlIdentifier(match[1] ?? '');
    const columns = (match[2] ?? '').split(',').map((entry) => normalizeSqlIdentifier(entry));
    const tuples = parseInsertValueTuples(match[3] ?? '');
    const rows = tuples.map((tuple) =>
      Object.fromEntries(columns.map((column, index) => [column, tuple[index] ?? null])) as Record<string, CellValue>,
    );
    tableRows.set(table, [...(tableRows.get(table) ?? []), ...rows]);
  }

  return [...tableRows.entries()].map(([table, rows]) => ({ table, rows }));
}

const pluginStore = createPluginStore<GeneratedImportPlugin>(join(generatedPluginRoot, 'versioned'));

async function loadGeneratedPlugins(): Promise<GeneratedImportPlugin[]> {
  // Legacy flat JSONs are deliberately not auto-trusted or overwritten.
  return (await pluginStore.listActive()).map(({ plugin, hash }) => ({ ...plugin, artifactHash: hash }));
}

async function saveGeneratedPlugin(plugin: GeneratedImportPlugin): Promise<void> {
  const { createdAt, updatedAt, successCount, lastUsedAt, artifactHash, lastExecution, ...definition } = plugin;
  const staged = await pluginStore.stage(definition);
  plugin.artifactHash = staged.hash;
  // Activate only after a real registered dataset passes independent readback.
}

async function ensureDbDiscoveryPluginForHint(
  connectorId: string,
  sourcePath: string,
): Promise<GeneratedImportPlugin> {
  const normalized = normalizeDiscoveryConnectorId(connectorId);
  const extension = extname(sourcePath).toLowerCase() || '.txt';
  const pluginId = `generated_db_discovery_${normalized}_${slugify(extension)}`;
  const existing = (await loadGeneratedPlugins()).find((plugin) => plugin.id === pluginId);
  if (existing) return existing;

  const plugin: GeneratedImportPlugin = {
    id: pluginId,
    label: `Generated ${normalized} discovery plugin`,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    introducedBy: 'generated',
    reusePriority: 84,
    dependencies:
      normalized === 'postgres'
        ? ['postgres']
        : normalized === 'mysql' || normalized === 'mariadb'
          ? ['mysql2']
          : ['mongodb'],
    successCount: 0,
    match: { extensions: [extension] },
    strategy: { type: 'db-discovery', connectorId: normalized },
    notes: `Generated automatically from a detected ${normalized} configuration pattern.`,
  };
  await saveGeneratedPlugin(plugin);
  return plugin;
}

async function ensureRuntimeDiscoveryPlugin(
  node: ImportTreeNode,
  task: CapabilityExecutionTask,
  runtimeBridge: {
    driverNameHint: string;
    connectionStringTemplate?: string;
    shellPath?: string;
  },
): Promise<GeneratedImportPlugin> {
  const extension = sourceExtensionOf(node) ?? '.bin';
  const pluginId = `generated_runtime_discovery_${slugify(extension)}_${slugify(runtimeBridge.driverNameHint)}`;
  const existing = (await loadGeneratedPlugins()).find((plugin) => plugin.id === pluginId);
  if (existing) return existing;

  const plugin: GeneratedImportPlugin = {
    id: pluginId,
    label: `Generated runtime discovery plugin`,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    introducedBy: 'generated',
    reusePriority: 86,
    dependencies: [],
    successCount: 0,
    match: { extensions: [extension] },
    strategy: {
      type: 'runtime-discovery',
      executor: 'powershell-odbc',
      shellPath: runtimeBridge.shellPath,
      driverNameHint: runtimeBridge.driverNameHint,
      connectionStringTemplate: runtimeBridge.connectionStringTemplate ?? 'Driver={{{DRIVER}}};Dbq={{SOURCE_PATH}};',
      tableLimit: 12,
      rowLimit: 20,
    },
    notes: `Generated from runtime family '${task.runtimeFamily ?? 'none'}' via acquisition path '${task.acquisitionPath ?? 'none'}'.`,
  };
  await saveGeneratedPlugin(plugin);
  return plugin;
}

function pluginMatchesPath(plugin: GeneratedImportPlugin, filePath: string): boolean {
  const extension = extname(filePath).toLowerCase();
  return plugin.match.extensions.includes(extension);
}

function pluginMatchesNode(plugin: GeneratedImportPlugin, node: ImportTreeNode): boolean {
  if (!pluginMatchesPath(plugin, node.sourcePath ?? '')) {
    return false;
  }
  if (plugin.strategy.type !== 'runtime-discovery') {
    return true;
  }
  const runtimeAcquisition = readRuntimeAcquisitionMetadata(node);
  if (runtimeAcquisition?.status !== 'available') {
    return false;
  }
  return (runtimeAcquisition.matchedDrivers ?? []).includes(plugin.strategy.driverNameHint);
}

async function applyGeneratedPlugin(
  plugin: GeneratedImportPlugin,
  content: string,
  sourcePath?: string,
):
  Promise<
    | { kind: 'rows'; rows: Array<Record<string, CellValue>> }
    | { kind: 'tables'; tables: Array<{ label: string; rows: Array<Record<string, CellValue>> }> }
    | { kind: 'connections'; connections: Array<{ connectorId: string; config: Record<string, string | number | boolean>; diagnostics: string[] }> }
  > {
  const strategy = plugin.strategy;

  if (strategy.type === 'runtime-discovery') {
    throw new Error('Runtime driver execution has no approved isolation/coverage profile; import blocked.');
  }

  if (strategy.type === 'csv') {
    return { kind: 'rows', rows: parseCsvRows(content, strategy.delimiter) };
  }
  if (strategy.type === 'json') {
    return { kind: 'rows', rows: parseJsonRows(content, strategy.path) };
  }
  if (strategy.type === 'xml') {
    return { kind: 'rows', rows: parseXmlRows(content) };
  }
  if (strategy.type === 'sql-insert-dump') {
    return {
      kind: 'tables',
      tables: parseSqlDumpTables(content).map((entry) => ({ label: entry.table, rows: entry.rows })),
    };
  }
  if (strategy.type === 'db-discovery') {
    if (!sourcePath) {
      throw new Error('Source path is required for db-discovery plugins.');
    }
    const hints = await detectConnectionHints(sourcePath);
    return {
      kind: 'connections',
      connections: hints.filter((hint) => normalizeDiscoveryConnectorId(hint.connectorId) === strategy.connectorId),
    };
  }

  const execution = await executeImportParser(strategy.code, content);
  plugin.lastExecution = execution.receipt;
  return { kind: 'rows', rows: execution.rows };
}

async function buildNodesFromPluginResult(
  session: ImportSessionState,
  node: ImportTreeNode,
  plugin: GeneratedImportPlugin,
  result: Awaited<ReturnType<typeof applyGeneratedPlugin>>,
): Promise<void> {
  if (result.kind === 'rows') {
    const artifactPath = await writeRowsArtifact(session, node.id, result.rows);
    node.kind = 'file';
    node.status = 'ready';
    node.capabilityId = 'plugin-inline';
    node.preview = rowsToPreview(result.rows);
    node.inputForm = {
      title: `Generated Plugin: ${plugin.label}`,
      description: plugin.notes ?? 'A generated import plugin converted this file into rows.',
      fields: [...commonDatasetFields(false), ...(plugin.strategy.type === 'javascript' ? generatedParserContractFields() : [])],
    };
    node.config = {
      ...node.config,
      datasetName: String(node.config.datasetName ?? slugify(basename(node.sourcePath ?? node.label, extname(node.sourcePath ?? node.label)))),
      namespace: String(node.config.namespace ?? 'imports'),
    };
    node.metadata = {
      ...(node.metadata ?? {}),
      artifactPath,
      pluginId: plugin.id,
      pluginHash: plugin.artifactHash,
      executionReceipt: plugin.lastExecution,
    };
    node.diagnostics = node.diagnostics.filter((entry) => !entry.toLowerCase().includes('no existing import capability'));
    return;
  }

  if (result.kind === 'connections') {
    node.kind = 'file';
    node.status = 'group';
    node.capabilityId = undefined;
    node.children = [];
    for (const connection of result.connections) {
      const child = addNode(session, {
        parentId: node.id,
        label: `${connection.connectorId} candidate`,
        kind: 'db-connection',
        status: 'needs_input',
        selected: true,
        detectedFormat: `${connection.connectorId}-connection`,
        capabilityId: connection.connectorId === 'mongodb' ? undefined : 'db-connector',
        sourcePath: node.sourcePath,
        diagnostics: [`Recovered by generated plugin '${plugin.label}'.`, ...connection.diagnostics],
        config: connection.config,
        metadata: {
          pluginId: plugin.id,
      pluginHash: plugin.artifactHash,
      executionReceipt: plugin.lastExecution,
          sourceFile: basename(node.sourcePath ?? node.label),
        },
      });
      if (connection.connectorId === 'mongodb') {
        child.status = 'gap';
        child.diagnostics.push('MongoDB execution capability is still missing.');
      } else {
        refreshDbConnectionNode(child);
      }
    }
    return;
  }

  node.kind = 'file';
  node.status = 'group';
  node.capabilityId = undefined;
  node.children = [];
  if (result.tables.length === 0) {
    node.status = 'gap';
    node.diagnostics = dedupeStrings([
      ...(node.diagnostics ?? []),
      `Generated plugin '${plugin.label}' opened the source but returned no importable entities.`,
    ]);
    return;
  }
  for (const table of result.tables) {
    const artifactPath = await writeRowsArtifact(session, `${node.id}_${slugify(table.label)}`, table.rows);
    addNode(session, {
      parentId: node.id,
      label: table.label,
      kind: 'db-table',
      status: 'ready',
      selected: true,
      detectedFormat: 'plugin-table',
      capabilityId: 'plugin-inline',
      sourcePath: node.sourcePath,
      diagnostics: [`Recovered by generated plugin '${plugin.label}'.`],
      preview: rowsToPreview(table.rows),
      config: {
        datasetName: slugify(table.label),
        namespace: slugify(basename(node.sourcePath ?? node.label, extname(node.sourcePath ?? node.label))) || 'imports',
      },
      inputForm: {
        title: `Generated Plugin Table Import`,
        description: plugin.notes ?? 'The generated plugin extracted multiple tables from this file.',
        fields: commonDatasetFields(false),
      },
      metadata: {
        artifactPath,
        pluginId: plugin.id,
      pluginHash: plugin.artifactHash,
      executionReceipt: plugin.lastExecution,
      },
    });
  }
}

async function applyGeneratedPluginsToOpenGaps(session: ImportSessionState): Promise<string[]> {
  const plugins = await loadGeneratedPlugins();
  if (plugins.length === 0) return [];

  const repaired: string[] = [];
  for (const node of Object.values(session.nodes)) {
    if ((node.status !== 'gap' && node.status !== 'failed') || !node.sourcePath) {
      continue;
    }
    const plugin = plugins.find((entry) => pluginMatchesNode(entry, node));
    if (!plugin) continue;
    try {
      const result = await applyGeneratedPlugin(plugin, await readTabularText(node.sourcePath), node.sourcePath);
      await buildNodesFromPluginResult(session, node, plugin, result);
        repaired.push(node.id);
      addLog(session, 'info', `Applied stored plugin '${plugin.id}' (${plugin.artifactHash}); import verification pending.`, node.id);
    } catch (error) {
      node.diagnostics = [...node.diagnostics, error instanceof Error ? error.message : 'Generated plugin application failed.'];
    }
  }

  return repaired;
}

async function discoverViaGeneratedPlugin(
  session: ImportSessionState,
  parentId: string | null,
  filePath: string,
): Promise<ImportTreeNode | null> {
  const plugins = await loadGeneratedPlugins();
  const plugin = plugins.find((entry) => pluginMatchesPath(entry, filePath) && entry.strategy.type !== 'runtime-discovery');
  if (!plugin) return null;

  const node = addNode(session, {
    parentId,
    label: basename(filePath),
    kind: 'file',
    status: 'gap',
    selected: true,
    detectedFormat: `${extname(filePath).slice(1)}-plugin`,
    sourcePath: filePath,
    diagnostics: [`Matched generated plugin '${plugin.label}'.`],
    config: {},
  });

  try {
    const result = await applyGeneratedPlugin(plugin, await readTabularText(filePath), filePath);
    if (result.kind === 'connections' && result.connections.length === 0) {
      delete session.nodes[node.id];
      if (node.parentId) {
        session.nodes[node.parentId]!.children = session.nodes[node.parentId]!.children.filter((entry) => entry !== node.id);
      } else {
        session.rootNodeIds = session.rootNodeIds.filter((entry) => entry !== node.id);
      }
      session.selectedNodeIds = session.selectedNodeIds.filter((entry) => entry !== node.id);
      return null;
    }
    await buildNodesFromPluginResult(session, node, plugin, result);
    addLog(session, 'info', `Discovery reused generated plugin '${plugin.id}' for '${node.label}'.`, node.id);
    return node;
  } catch (error) {
    node.status = 'gap';
    node.diagnostics.push(error instanceof Error ? error.message : 'Generated plugin failed during discovery.');
    return node;
  }
}

interface RepairOutcome {
  repaired: boolean;
  planner?: ImportPlannerResult;
  implementer?: ImportImplementerResult;
  verifier?: ImportVerifierResult;
  executionTask?: CapabilityExecutionTask;
  notes?: string[];
}

function createOrReuseRepairTrace(session: ImportSessionState, inspector: ImportInspectorResult): CapabilityRepairTrace {
  const existing = session.repairHistory.find((trace) => trace.nodeId === inspector.nodeId);
  if (existing) {
    existing.inspector = inspector;
    existing.updatedAt = nowIso();
    return existing;
  }

  const trace: CapabilityRepairTrace = {
    id: randomUUID(),
    nodeId: inspector.nodeId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: 'planned',
    inspector,
    notes: [],
  };
  session.repairHistory.unshift(trace);
  return trace;
}

function updateRepairTrace(
  trace: CapabilityRepairTrace,
  patch: Partial<Omit<CapabilityRepairTrace, 'id' | 'nodeId' | 'createdAt'>>,
): void {
  Object.assign(trace, patch);
  trace.updatedAt = nowIso();
}

async function persistExecutionTaskArtifact(session: ImportSessionState, task: CapabilityExecutionTask): Promise<string> {
  const tasksDir = join(session.rootPath, 'tasks');
  await mkdir(tasksDir, { recursive: true });
  const filePath = join(tasksDir, `${task.id}.json`);
  await writeFile(filePath, `${JSON.stringify(task, null, 2)}\n`, 'utf8');
  return filePath;
}

const runtimeProbeStopwords = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'into',
  'from',
  'then',
  'than',
  'through',
  'using',
  'existing',
  'generic',
  'runtime',
  'bridge',
  'driver',
  'database',
  'discovery',
  'preview',
  'import',
  'source',
  'system',
  'path',
  'step',
  'steps',
  'plan',
  'file',
  'files',
  'node',
  'host',
  'worker',
]);

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function tokenizeProbeKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9.+_-]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 3)
    .filter((entry) => !runtimeProbeStopwords.has(entry));
}

function inferTaskRuntimeFamily(task: CapabilityExecutionTask): RuntimeFamily {
  if (task.runtimeFamily) return task.runtimeFamily;
  const haystack = [
    task.summary,
    ...task.steps,
    ...task.dependencies,
    ...task.runtimeArtifacts,
  ].join(' ').toLowerCase();
  if (/odbc|jdbc|ole[\s-]?db|driver/i.test(haystack)) return 'driver_bridge';
  if (/adapter/i.test(haystack)) return 'adapter_layer';
  if (/tool/i.test(haystack)) return 'external_tool_bridge';
  if (/connection|dsn|uri|host|port/i.test(haystack)) return 'connection_runtime';
  return 'none';
}

function inferTaskAcquisitionPath(task: CapabilityExecutionTask): AcquisitionPath {
  if (task.acquisitionPath) return task.acquisitionPath;
  const haystack = [
    task.summary,
    ...task.steps,
    ...task.dependencies,
    ...task.runtimeArtifacts,
  ].join(' ').toLowerCase();
  if (/odbc|jdbc|ole[\s-]?db|system driver|installed driver|provider/i.test(haystack)) return 'system_driver';
  if (/install|dependency|package/i.test(haystack)) return 'dependency_install';
  if (/tool|cli/i.test(haystack)) return 'tool_bridge';
  if (/adapter/i.test(haystack)) return 'generated_adapter';
  if (/runtime/i.test(haystack)) return 'existing_runtime';
  return 'none';
}

function taskProbeKeywords(task: CapabilityExecutionTask, node?: ImportTreeNode): string[] {
  const parts = [
    task.summary,
    ...task.steps,
    ...task.dependencies,
    ...task.runtimeArtifacts,
    ...task.verificationPlan,
    node?.label ?? '',
    node?.detectedFormat ?? '',
    node ? sourceExtensionOf(node) ?? '' : '',
  ];
  return dedupeStrings(parts.flatMap(tokenizeProbeKeywords));
}

function processArchitectureLabel(): string {
  if (process.arch === 'x64') return '64-bit';
  if (process.arch === 'ia32') return '32-bit';
  if (process.arch === 'arm64') return 'arm64';
  return process.arch;
}

function alternatePowerShellBridges(): Array<{
  shellPath: string;
  architecture: string;
  runtimeFamily: RuntimeFamily;
  acquisitionPath: AcquisitionPath;
}> {
  if (process.platform !== 'win32') {
    return [];
  }

  const bridges: Array<{
    shellPath: string;
    architecture: string;
    runtimeFamily: RuntimeFamily;
    acquisitionPath: AcquisitionPath;
  }> = [];

  const wow64Path = 'C:/Windows/SysWOW64/WindowsPowerShell/v1.0/powershell.exe';
  if (process.arch === 'x64' && existsSync(wow64Path)) {
    bridges.push({
      shellPath: wow64Path,
      architecture: '32-bit',
      runtimeFamily: 'external_tool_bridge',
      acquisitionPath: 'tool_bridge',
    });
  }

  const sysnativePath = 'C:/Windows/Sysnative/WindowsPowerShell/v1.0/powershell.exe';
  if (process.arch === 'ia32' && existsSync(sysnativePath)) {
    bridges.push({
      shellPath: sysnativePath,
      architecture: '64-bit',
      runtimeFamily: 'external_tool_bridge',
      acquisitionPath: 'tool_bridge',
    });
  }

  return bridges;
}

function extractExecErrorDiagnostics(error: unknown, fallback: string): string[] {
  if (error && typeof error === 'object') {
    const stderr = 'stderr' in error && typeof (error as { stderr?: unknown }).stderr === 'string'
      ? (error as { stderr: string }).stderr.trim()
      : '';
    const stdout = 'stdout' in error && typeof (error as { stdout?: unknown }).stdout === 'string'
      ? (error as { stdout: string }).stdout.trim()
      : '';
    const message = error instanceof Error ? error.message : '';
    return dedupeStrings([
      stderr,
      stdout,
      message && stderr.length === 0 && stdout.length === 0 ? message : '',
      fallback,
    ]);
  }
  return [fallback];
}

async function probeWindowsRegistryOdbcDrivers(): Promise<{ drivers: RuntimeDriverCandidate[]; diagnostics: string[] }> {
  const locations = [
    { key: 'HKLM\\SOFTWARE\\ODBC\\ODBCINST.INI\\ODBC Drivers', platform: '64-bit' },
    { key: 'HKLM\\SOFTWARE\\WOW6432Node\\ODBC\\ODBCINST.INI\\ODBC Drivers', platform: '32-bit' },
  ] as const;
  const drivers: RuntimeDriverCandidate[] = [];
  const diagnostics: string[] = [];

  for (const location of locations) {
    try {
      const { stdout, stderr } = await execFileAsync(
        'reg.exe',
        ['query', location.key],
        { timeout: 15_000, windowsHide: true },
      );
      diagnostics.push(...(stderr.trim().length > 0 ? [stderr.trim()] : []));
      const parsed = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /\s+REG_\w+\s+/i.test(line))
        .map((line) => line.replace(/\s+REG_\w+\s+.*$/i, '').trim())
        .filter((name) => name.length > 0);
      for (const name of parsed) {
        drivers.push({ name, platform: location.platform });
      }
    } catch (error) {
      diagnostics.push(...extractExecErrorDiagnostics(error, `Registry ODBC probe failed for ${location.key}.`));
    }
  }

  return {
    drivers: drivers.filter(
      (entry, index, list) => list.findIndex((candidate) => candidate.name.toLowerCase() === entry.name.toLowerCase() && candidate.platform === entry.platform) === index,
    ),
    diagnostics,
  };
}

async function probeWindowsOdbcDrivers(): Promise<{ drivers: RuntimeDriverCandidate[]; diagnostics: string[] }> {
  const script = "$drivers = Get-OdbcDriver -ErrorAction Stop | Select-Object Name,Platform; if ($null -eq $drivers) { '[]' } else { $drivers | ConvertTo-Json -Compress }";
  try {
    const { stdout, stderr } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-Command', script],
      { timeout: 15_000, windowsHide: true },
    );
    const parsed = stdout.trim().length > 0
      ? JSON.parse(stdout.trim()) as { Name?: string; Platform?: string } | Array<{ Name?: string; Platform?: string }>
      : [];
    const entries = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : [];
    const drivers = entries
      .filter((entry) => typeof entry?.Name === 'string' && entry.Name.trim().length > 0)
      .map((entry) => ({
        name: entry.Name!.trim(),
        platform: typeof entry.Platform === 'string' && entry.Platform.trim().length > 0 ? entry.Platform.trim() : undefined,
      }));
    return {
      drivers,
      diagnostics: stderr.trim().length > 0 ? [stderr.trim()] : [],
    };
  } catch (error) {
    const fallback = await probeWindowsRegistryOdbcDrivers();
    return {
      drivers: fallback.drivers,
      diagnostics: dedupeStrings([
        'PowerShell ODBC probe failed; registry fallback was used.',
        ...extractExecErrorDiagnostics(error, 'Windows ODBC driver probe failed.'),
        ...fallback.diagnostics,
      ]),
    };
  }
}

async function probeUnixOdbcDrivers(): Promise<{ drivers: RuntimeDriverCandidate[]; diagnostics: string[] }> {
  try {
    const { stdout, stderr } = await execFileAsync('odbcinst', ['-q', '-d'], { timeout: 15_000 });
    return {
      drivers: stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => ({ name: line.replace(/^\[|\]$/g, ''), platform: processArchitectureLabel() })),
      diagnostics: stderr.trim().length > 0 ? [stderr.trim()] : [],
    };
  } catch (error) {
    return {
      drivers: [],
      diagnostics: [error instanceof Error ? error.message : 'Unix ODBC driver probe failed.'],
    };
  }
}

function fileBackedConnectionTemplates(preferred?: string): string[] {
  return dedupeStrings([
    preferred ?? '',
    'Driver={{{DRIVER}}};Dbq={{SOURCE_PATH}};',
    'Driver={{{DRIVER}}};DBQ={{SOURCE_PATH}};',
    'Driver={{{DRIVER}}};Database={{SOURCE_PATH}};',
    'Driver={{{DRIVER}}};Data Source={{SOURCE_PATH}};',
  ]);
}

async function probeDriverOpenability(
  shellPath: string,
  driverName: string,
  sourcePath: string,
  connectionTemplate: string,
): Promise<{ ok: boolean; diagnostics: string[] }> {
  const script = `
$driver = $env:KOI_DRIVER_HINT
$sourcePath = $env:KOI_SOURCE_PATH
$template = $env:KOI_CONNECTION_TEMPLATE
$connectionString = $template.Replace('{{DRIVER}}', $driver).Replace('{{SOURCE_PATH}}', $sourcePath)
$connection = New-Object System.Data.Odbc.OdbcConnection($connectionString)
try {
  $connection.Open()
  [pscustomobject]@{
    ok = $true
    connectionString = $connectionString
  } | ConvertTo-Json -Compress
} finally {
  if ($connection.State -ne [System.Data.ConnectionState]::Closed) {
    $connection.Close()
  }
}
`.trim();

  try {
    const { stdout, stderr } = await execFileAsync(
      shellPath,
      ['-NoProfile', '-Command', script],
      {
        timeout: 20_000,
        windowsHide: true,
        env: {
          ...process.env,
          KOI_DRIVER_HINT: driverName,
          KOI_SOURCE_PATH: sourcePath,
          KOI_CONNECTION_TEMPLATE: connectionTemplate,
        },
      },
    );
    const diagnostics = stderr.trim().length > 0 ? [stderr.trim()] : [];
    const parsed = stdout.trim().length > 0 ? JSON.parse(stdout.trim()) as { ok?: boolean } : {};
    return { ok: parsed.ok === true, diagnostics };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [error instanceof Error ? error.message : 'Driver open probe failed.'],
    };
  }
}

async function probeDriverDiscovery(
  shellPath: string,
  driverName: string,
  sourcePath: string,
  connectionTemplate: string,
): Promise<{ ok: boolean; tableCount?: number; diagnostics: string[] }> {
  const script = `
$driver = $env:KOI_DRIVER_HINT
$sourcePath = $env:KOI_SOURCE_PATH
$template = $env:KOI_CONNECTION_TEMPLATE
$connectionString = $template.Replace('{{DRIVER}}', $driver).Replace('{{SOURCE_PATH}}', $sourcePath)
$connection = New-Object System.Data.Odbc.OdbcConnection($connectionString)
try {
  $connection.Open()
  $schema = $connection.GetSchema('Tables')
  $tableCount = 0
  foreach ($row in $schema.Rows) {
    $tableType = [string]$row['TABLE_TYPE']
    $tableName = [string]$row['TABLE_NAME']
    if ([string]::IsNullOrWhiteSpace($tableName)) { continue }
    if ($tableType -and $tableType -notin @('TABLE', 'VIEW')) { continue }
    $tableCount += 1
  }
  [pscustomobject]@{
    ok = $true
    tableCount = $tableCount
  } | ConvertTo-Json -Compress
} finally {
  if ($connection.State -ne [System.Data.ConnectionState]::Closed) {
    $connection.Close()
  }
}
`.trim();

  try {
    const { stdout, stderr } = await execFileAsync(
      shellPath,
      ['-NoProfile', '-Command', script],
      {
        timeout: 25_000,
        windowsHide: true,
        env: {
          ...process.env,
          KOI_DRIVER_HINT: driverName,
          KOI_SOURCE_PATH: sourcePath,
          KOI_CONNECTION_TEMPLATE: connectionTemplate,
        },
      },
    );
    const diagnostics = stderr.trim().length > 0 ? [stderr.trim()] : [];
    const parsed = stdout.trim().length > 0 ? JSON.parse(stdout.trim()) as { ok?: boolean; tableCount?: number } : {};
    return { ok: parsed.ok === true, tableCount: typeof parsed.tableCount === 'number' ? parsed.tableCount : undefined, diagnostics };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [error instanceof Error ? error.message : 'Driver discovery probe failed.'],
    };
  }
}

async function resolveWorkingSystemDriverBridge(
  sourcePath: string,
  drivers: RuntimeDriverCandidate[],
  node?: ImportTreeNode,
  preferredTemplate?: string,
): Promise<{
  matchedDriver?: string;
  matchedDriverPlatform?: string;
  connectionStringTemplate?: string;
  bridgeExecutable?: string;
  bridgeArchitecture?: string;
  runtimeFamily?: RuntimeFamily;
  acquisitionPath?: AcquisitionPath;
  diagnostics: string[];
}> {
  const diagnostics: string[] = [];
  const processArchitecture = processArchitectureLabel();
  const templates = fileBackedConnectionTemplates(preferredTemplate);
  for (const driver of drivers) {
    const compatibility = assessDriverCompatibility(driver, node);
    if (!compatibility.compatible) {
      diagnostics.push(...compatibility.reasons.map((reason) => `Driver '${driver.name}' was rejected: ${reason}`));
      continue;
    }
    const shellCandidates = [
      {
        shellPath: 'powershell.exe',
        architecture: processArchitecture,
        runtimeFamily: 'driver_bridge' as const,
        acquisitionPath: 'system_driver' as const,
      },
      ...alternatePowerShellBridges(),
    ].sort((left, right) => {
      const leftScore = driver.platform && left.architecture === driver.platform ? 0 : 1;
      const rightScore = driver.platform && right.architecture === driver.platform ? 0 : 1;
      return leftScore - rightScore;
    });

    if (driver.platform && driver.platform !== processArchitecture) {
      diagnostics.push(`Architecture mismatch detected: KOIForge runtime is ${processArchitecture}, but candidate driver '${driver.name}' is ${driver.platform}.`);
    }

    const uniqueShells = shellCandidates.filter(
      (candidate, index, list) => list.findIndex((entry) => entry.shellPath.toLowerCase() === candidate.shellPath.toLowerCase()) === index,
    );

    for (const bridge of uniqueShells) {
      if (driver.platform && bridge.architecture !== driver.platform) {
        diagnostics.push(`Bridge '${bridge.shellPath}' (${bridge.architecture}) does not match candidate driver '${driver.name}' (${driver.platform}).`);
      }
      if (driver.platform && bridge.architecture !== driver.platform) {
        continue;
      }
      for (const template of templates) {
        const result = await probeDriverOpenability(bridge.shellPath, driver.name, sourcePath, template);
        diagnostics.push(...result.diagnostics.map((entry) => `[${driver.name} via ${bridge.architecture}] ${entry}`));
        if (result.ok) {
          const discovery = await probeDriverDiscovery(bridge.shellPath, driver.name, sourcePath, template);
          diagnostics.push(...discovery.diagnostics.map((entry) => `[${driver.name} via ${bridge.architecture}] ${entry}`));
          if (!discovery.ok) {
            continue;
          }
          if (typeof discovery.tableCount === 'number' && discovery.tableCount <= 0) {
            diagnostics.push(`[${driver.name} via ${bridge.architecture}] Driver opened the source but exposed no importable entities.`);
            continue;
          }
          return {
            matchedDriver: driver.name,
            matchedDriverPlatform: driver.platform,
            connectionStringTemplate: template,
            bridgeExecutable: bridge.shellPath,
            bridgeArchitecture: bridge.architecture,
            runtimeFamily: bridge.runtimeFamily,
            acquisitionPath: bridge.acquisitionPath,
            diagnostics,
          };
        }
      }
    }

    for (const template of templates) {
      diagnostics.push(`[${driver.name}] No compatible bridge runtime could verify the source with template '${template}'.`);
    }
  }
  return { diagnostics };
}

async function probeSystemDriverBridge(task: CapabilityExecutionTask, node?: ImportTreeNode): Promise<{
  matchedDrivers: RuntimeDriverCandidate[];
  availableDrivers: RuntimeDriverCandidate[];
  diagnostics: string[];
  processArchitecture: string;
}> {
  const windowsProbe = process.platform === 'win32' ? await probeWindowsOdbcDrivers() : { drivers: [], diagnostics: [] };
  const unixProbe = process.platform === 'win32' ? { drivers: [], diagnostics: [] } : await probeUnixOdbcDrivers();
  const availableDrivers = [...windowsProbe.drivers, ...unixProbe.drivers].filter(
    (entry, index, list) => list.findIndex((candidate) => candidate.name.toLowerCase() === entry.name.toLowerCase()) === index,
  );
  const diagnostics = dedupeStrings([...windowsProbe.diagnostics, ...unixProbe.diagnostics]);
  const keywords = taskProbeKeywords(task, node);
  const ranked = availableDrivers
    .map((driver) => {
      const lower = driver.name.toLowerCase();
      const score = keywords.reduce((total, keyword) => (lower.includes(keyword) ? total + Math.max(1, Math.min(keyword.length, 12)) : total), 0);
      return { driver, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.driver.name.localeCompare(right.driver.name));

  return {
    matchedDrivers: ranked.map((entry) => entry.driver),
    availableDrivers,
    diagnostics: diagnostics.length > 0 ? diagnostics : ['System driver probe completed.'],
    processArchitecture: processArchitectureLabel(),
  };
}

function findGapForNode(session: ImportSessionState, nodeId: string): CapabilityGap | undefined {
  return session.gaps.find((gap) => gap.nodeId === nodeId);
}

function findRepairTraceForNode(session: ImportSessionState, nodeId: string): CapabilityRepairTrace | undefined {
  return session.repairHistory.find((trace) => trace.nodeId === nodeId);
}

function pushTaskNote(task: CapabilityExecutionTask, note: string): void {
  task.notes = dedupeStrings([...(task.notes ?? []), note]);
}

async function finalizeExecutionTask(
  session: ImportSessionState,
  task: CapabilityExecutionTask,
  patch: {
    status: CapabilityExecutionTask['status'];
    summary?: string;
    diagnostics?: string[];
    runtimeArtifacts?: string[];
    note?: string;
  },
): Promise<void> {
  task.status = patch.status;
  task.updatedAt = nowIso();
  if (patch.summary) {
    task.summary = patch.summary;
  }
  if (patch.diagnostics) {
    task.diagnostics = dedupeStrings([...(task.diagnostics ?? []), ...patch.diagnostics]);
  }
  if (patch.runtimeArtifacts) {
    task.runtimeArtifacts = dedupeStrings([...task.runtimeArtifacts, ...patch.runtimeArtifacts]);
  }
  if (patch.note) {
    pushTaskNote(task, patch.note);
  }
  task.artifactPath = await persistExecutionTaskArtifact(session, task);
}

function setRuntimeAcquisitionMetadata(
  node: ImportTreeNode,
  metadata: RuntimeAcquisitionMetadata,
): void {
  node.metadata = {
    ...(node.metadata ?? {}),
    runtimeAcquisition: {
      ...metadata,
      updatedAt: nowIso(),
    },
  };
}

async function writeToolAcquisitionArtifact(
  session: ImportSessionState,
  task: CapabilityExecutionTask,
  artifact: ToolAcquisitionArtifact,
): Promise<string> {
  const artifactDir = join(session.rootPath, 'artifacts');
  await mkdir(artifactDir, { recursive: true });
  const filePath = join(artifactDir, `${task.nodeId}.${task.id}.tool-acquisition.json`);
  await writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return filePath;
}

async function finalizeToolAcquisitionTask(
  session: ImportSessionState,
  task: CapabilityExecutionTask,
  node: ImportTreeNode,
  options: {
    runtimeFamily: RuntimeFamily;
    acquisitionPath: AcquisitionPath;
    processArchitecture?: string;
    requiredArchitecture?: string;
    candidateDrivers: RuntimeDriverCandidate[];
    diagnostics: string[];
  },
): Promise<void> {
  task.runtimeFamily = options.runtimeFamily;
  task.acquisitionPath = options.acquisitionPath;
  const requiredSourceExtensions = requiredRuntimeSourceExtensions(node);
  const candidateAssessments = options.candidateDrivers.map((driver) => {
    const assessment = assessDriverCompatibility(driver, node);
    return {
      ...driver,
      ...assessment,
    };
  });

  const familyCompatibleCandidates = candidateAssessments.filter((candidate) => candidate.compatible);
  const requirements = dedupeStrings([
    requiredSourceExtensions.length > 0
      ? `Acquire or bind a runtime that explicitly advertises support for ${requiredSourceExtensions.join(', ')}.`
      : 'Acquire or bind a runtime that matches the source family.',
    options.requiredArchitecture
      ? `Provide the runtime through a ${options.requiredArchitecture} process architecture or an external bridge with that architecture.`
      : '',
    familyCompatibleCandidates.length > 0
      ? 'The selected runtime must pass open_source and expose at least one importable entity.'
      : 'No currently detected candidate satisfies the required source family and runtime checks.',
  ].filter((entry) => entry.length > 0));

  const summary = options.requiredArchitecture
    ? 'Tool acquisition plan prepared. A compatible bridge or host runtime is still required before discovery can resume.'
    : requiredSourceExtensions.length > 0
      ? `Tool acquisition plan prepared. A compatible runtime for ${requiredSourceExtensions.join(', ')} is still required before discovery can resume.`
      : 'Tool acquisition plan prepared. A compatible runtime bridge is still required before discovery can resume.';

  const artifact: ToolAcquisitionArtifact = {
    kind: 'runtime-tool-acquisition',
    createdAt: nowIso(),
    sessionId: session.id,
    taskId: task.id,
    nodeId: node.id,
    source: {
      label: node.label,
      path: node.sourcePath,
      extension: sourceExtensionOf(node),
      detectedFormat: node.detectedFormat,
      sourceClass: inferSourceClass(node),
    },
    runtimeRequirement: {
      runtimeFamily: options.runtimeFamily,
      acquisitionPath: options.acquisitionPath,
      processArchitecture: options.processArchitecture,
      requiredArchitecture: options.requiredArchitecture,
      requiredSourceExtensions,
      executionGoals: task.executionGoals ?? [],
      requirements,
    },
    observedDrivers: candidateAssessments.map((candidate) => ({
      name: candidate.name,
      platform: candidate.platform,
      advertisedExtensions: candidate.advertisedExtensions,
      compatible: candidate.compatible,
      reasons: candidate.reasons,
    })),
    diagnostics: options.diagnostics,
  };
  const artifactPath = await writeToolAcquisitionArtifact(session, task, artifact);

  setRuntimeAcquisitionMetadata(node, {
    status: 'missing',
    runtimeFamily: options.runtimeFamily,
    acquisitionPath: options.acquisitionPath,
    matchedDrivers: options.candidateDrivers.map((candidate) => candidate.name),
    matchedDriverPlatforms: options.candidateDrivers.map((candidate) => candidate.platform ?? 'unknown'),
    processArchitecture: options.processArchitecture,
    requiredArchitecture: options.requiredArchitecture,
    requiredSourceExtensions,
    requirements,
    acquisitionArtifactPath: artifactPath,
    diagnostics: options.diagnostics,
  });

  node.status = 'gap';
  node.diagnostics = dedupeStrings([
    summary,
    `Tool acquisition artifact: ${artifactPath}`,
    ...requirements,
    ...candidateAssessments.map((candidate) =>
      `Candidate driver detected: ${candidate.name}${candidate.platform ? ` (${candidate.platform})` : ''}${candidate.compatible ? '' : ` -> ${candidate.reasons.join(' | ')}`}`),
    ...options.diagnostics,
  ]);

  await finalizeExecutionTask(session, task, {
    status: 'completed',
    summary,
    diagnostics: [...node.diagnostics],
    runtimeArtifacts: [`tool_acquisition_artifact:${artifactPath}`],
    note: 'Tool acquisition requirements persisted.',
  });

  const gap = findGapForNode(session, node.id);
  if (gap) {
    gap.missingDimension = 'tool_acquisition';
    gap.bestKnownNextAction = 'acquire_runtime';
    gap.message = summary;
    gap.diagnostics = [...node.diagnostics];
    gap.status = 'open';
    gap.updatedAt = nowIso();
  }

  updatePostExecutionGap(session, node, task, {
    verdict: 'needs_retry',
    closedGap: false,
    summary,
    diagnostics: [...node.diagnostics],
  });
}

function updatePostExecutionGap(
  session: ImportSessionState,
  node: ImportTreeNode,
  task: CapabilityExecutionTask,
  verifier: ImportVerifierResult,
): void {
  const gap = findGapForNode(session, node.id);
  const trace = findRepairTraceForNode(session, node.id);
  if (gap) {
    gap.lastVerifier = verifier;
    gap.updatedAt = nowIso();
  }
  if (trace) {
    updateRepairTrace(trace, {
      verifier,
      status:
        verifier.verdict === 'resolved'
          ? 'verified'
          : verifier.verdict === 'blocked'
            ? 'blocked'
            : task.status === 'completed'
              ? 'implemented'
              : task.status === 'failed'
                ? 'failed'
                : 'running',
      notes: dedupeStrings([...(trace.notes ?? []), ...(task.notes ?? []), ...(task.diagnostics ?? [])]),
    });
  }
}

async function executeAcquireRuntimeTask(
  session: ImportSessionState,
  task: CapabilityExecutionTask,
  node: ImportTreeNode,
): Promise<void> {
  const runtimeFamily = inferTaskRuntimeFamily(task);
  const acquisitionPath = inferTaskAcquisitionPath(task);

  task.runtimeFamily = runtimeFamily;
  task.acquisitionPath = acquisitionPath;
  task.executionGoals = task.executionGoals ?? executionGoalsForNode(task.sourceClass, 'runtime_strategy');

  if (!['driver_bridge', 'external_tool_bridge'].includes(runtimeFamily)) {
    const summary = `No execution handler is registered for runtime family '${runtimeFamily}' via acquisition path '${acquisitionPath}'.`;
    node.diagnostics = dedupeStrings([summary]);
    await finalizeExecutionTask(session, task, {
      status: 'blocked',
      summary,
      diagnostics: [summary],
      note: summary,
    });
    updatePostExecutionGap(session, node, task, {
      verdict: 'blocked',
      closedGap: false,
      summary,
      diagnostics: [summary],
    });
    addLog(session, 'warning', summary, node.id);
    return;
  }

  const probe = await probeSystemDriverBridge(task, node);
  if (probe.matchedDrivers.length > 0) {
    const candidates = probe.matchedDrivers.slice(0, 5);
    const working = node.sourcePath
      ? await resolveWorkingSystemDriverBridge(node.sourcePath, candidates, node)
      : { diagnostics: ['Source path is missing for runtime open verification.'] };
    if (!working.matchedDriver || !working.connectionStringTemplate) {
      const familyCompatibleCandidates = candidates.filter((candidate) => assessDriverCompatibility(candidate, node).compatible);
      const requiredArchitecture = familyCompatibleCandidates.some((candidate) => candidate.platform && candidate.platform !== probe.processArchitecture)
        ? probe.processArchitecture
        : undefined;
      const acquisitionRequirementPath = requiredArchitecture
        ? 'tool_bridge'
        : familyCompatibleCandidates.length === 0 || acquisitionPath === 'none'
          ? 'dependency_install'
          : acquisitionPath;
      await finalizeToolAcquisitionTask(session, task, node, {
        runtimeFamily: requiredArchitecture ? 'external_tool_bridge' : runtimeFamily,
        acquisitionPath: acquisitionRequirementPath,
        processArchitecture: probe.processArchitecture,
        requiredArchitecture,
        candidateDrivers: candidates,
        diagnostics: dedupeStrings([...probe.diagnostics, ...working.diagnostics]),
      });
      addLog(session, 'info', `Execution task '${task.action}' persisted tool acquisition requirements for '${node.label}'.`, node.id);
      return;
    }

    const matchedDrivers = [working.matchedDriver];
    const resolvedRuntimeFamily = working.runtimeFamily ?? runtimeFamily;
    const resolvedAcquisitionPath = working.acquisitionPath ?? acquisitionPath;
    const summary = resolvedRuntimeFamily === 'external_tool_bridge'
      ? 'A verified external runtime bridge is available. Next step: generate an adapter or resume runtime-backed discovery.'
      : 'A verified system driver bridge is available. Next step: generate an adapter or resume runtime-backed discovery.';
    setRuntimeAcquisitionMetadata(node, {
      status: 'available',
      runtimeFamily: resolvedRuntimeFamily,
      acquisitionPath: resolvedAcquisitionPath,
      matchedDrivers,
      matchedDriverPlatforms: working.matchedDriverPlatform ? [working.matchedDriverPlatform] : undefined,
      bridgeExecutable: working.bridgeExecutable,
      bridgeArchitecture: working.bridgeArchitecture,
      processArchitecture: probe.processArchitecture,
      connectionStringTemplate: working.connectionStringTemplate,
      diagnostics: dedupeStrings([...probe.diagnostics, ...working.diagnostics]),
    });
    node.status = 'gap';
    node.diagnostics = dedupeStrings([
      `Compatible runtime bridge detected: ${matchedDrivers[0]}.`,
      working.bridgeExecutable && resolvedRuntimeFamily === 'external_tool_bridge'
        ? `External runtime bridge verified via ${working.bridgeExecutable}${working.bridgeArchitecture ? ` (${working.bridgeArchitecture})` : ''}.`
        : 'Runtime acquisition completed and the source opened successfully. Adapter generation or runtime reload can continue.',
      ...working.diagnostics,
    ]);
    await finalizeExecutionTask(session, task, {
      status: 'completed',
      summary,
      diagnostics: [
        `Compatible runtime bridge detected: ${matchedDrivers[0]}.`,
        ...working.diagnostics,
      ],
      runtimeArtifacts: [
        ...matchedDrivers.map((driver) => `${resolvedAcquisitionPath}:${driver}`),
        ...(working.bridgeExecutable ? [`bridge_executable:${working.bridgeExecutable}`] : []),
      ],
      note: `Runtime probe matched: ${matchedDrivers[0]}.`,
    });
    task.runtimeFamily = resolvedRuntimeFamily;
    task.acquisitionPath = resolvedAcquisitionPath;
    const gap = findGapForNode(session, node.id);
    if (gap) {
      gap.missingDimension = 'adapter_generation';
      gap.bestKnownNextAction = 'generate_adapter';
      gap.message = summary;
      gap.diagnostics = [...node.diagnostics];
      gap.status = 'open';
      gap.updatedAt = nowIso();
    }
    updatePostExecutionGap(session, node, task, {
      verdict: 'needs_retry',
      closedGap: false,
      summary,
      diagnostics: [...node.diagnostics],
    });
    addLog(session, 'info', `Execution task '${task.action}' matched runtime bridge '${matchedDrivers[0]}' for '${node.label}'.`, node.id);
    return;
  }

  const summary = 'No compatible runtime bridge was detected on the host. Tool, driver, or external bridge acquisition is still required.';
  await finalizeToolAcquisitionTask(session, task, node, {
    runtimeFamily: runtimeFamily === 'external_tool_bridge' ? runtimeFamily : 'external_tool_bridge',
    acquisitionPath: acquisitionPath === 'tool_bridge' ? acquisitionPath : 'dependency_install',
    processArchitecture: probe.processArchitecture,
    candidateDrivers: probe.availableDrivers.slice(0, 10),
    diagnostics: dedupeStrings([
      summary,
      ...probe.diagnostics,
      `KOIForge runtime architecture: ${probe.processArchitecture}.`,
    ]),
  });
  addLog(session, 'info', `Execution task '${task.action}' could not find a compatible runtime bridge for '${node.label}' and persisted tool acquisition requirements.`, node.id);
}

async function executeGenerateAdapterTask(
  session: ImportSessionState,
  task: CapabilityExecutionTask,
  node: ImportTreeNode,
): Promise<void> {
  const runtimeAcquisition = readRuntimeAcquisitionMetadata(node);

  if (!node.sourcePath) {
    const summary = 'Adapter generation requires a readable source path.';
    node.diagnostics = dedupeStrings([summary]);
    await finalizeExecutionTask(session, task, {
      status: 'failed',
      summary,
      diagnostics: [summary],
      note: summary,
    });
    updatePostExecutionGap(session, node, task, {
      verdict: 'blocked',
      closedGap: false,
      summary,
      diagnostics: [summary],
    });
    addLog(session, 'error', summary, node.id);
    return;
  }

  const driverNameHint = runtimeAcquisition?.matchedDrivers?.[0];
  if (!driverNameHint) {
    const summary = 'Adapter generation requires a previously detected runtime bridge.';
    node.diagnostics = dedupeStrings([summary]);
    await finalizeExecutionTask(session, task, {
      status: 'blocked',
      summary,
      diagnostics: [summary],
      note: summary,
    });
    updatePostExecutionGap(session, node, task, {
      verdict: 'blocked',
      closedGap: false,
      summary,
      diagnostics: [summary],
    });
    addLog(session, 'warning', summary, node.id);
    return;
  }

  try {
    const working = node.sourcePath
      ? await resolveWorkingSystemDriverBridge(
          node.sourcePath,
          [{
            name: driverNameHint,
            platform: runtimeAcquisition?.matchedDriverPlatforms?.[0],
          }],
          node,
          runtimeAcquisition?.connectionStringTemplate,
        )
      : { diagnostics: ['Source path is missing for runtime open verification.'] };
    if (!working.matchedDriver || !working.connectionStringTemplate) {
      const summary = 'Adapter generation requires a verified runtime bridge that can actually open the source.';
      node.status = 'gap';
      node.diagnostics = dedupeStrings([
        summary,
        ...working.diagnostics,
      ]);
      await finalizeExecutionTask(session, task, {
        status: 'blocked',
        summary,
        diagnostics: [...node.diagnostics],
        note: summary,
      });
      updatePostExecutionGap(session, node, task, {
        verdict: 'blocked',
        closedGap: false,
        summary,
        diagnostics: [...node.diagnostics],
      });
      addLog(session, 'warning', summary, node.id);
      return;
    }

    const plugin = await ensureRuntimeDiscoveryPlugin(node, task, {
      driverNameHint: working.matchedDriver,
      connectionStringTemplate: working.connectionStringTemplate,
      shellPath: working.bridgeExecutable,
    });
    if (plugin.strategy.type === 'runtime-discovery') {
      plugin.strategy.connectionStringTemplate = working.connectionStringTemplate;
      plugin.strategy.shellPath = working.bridgeExecutable;
      plugin.updatedAt = nowIso();
      await saveGeneratedPlugin(plugin);
    }
    const result = await applyGeneratedPlugin(plugin, '', node.sourcePath);
    await buildNodesFromPluginResult(session, node, plugin, result);

    if (node.children.length === 0 && node.status === 'gap') {
      const summary = `Generated adapter '${plugin.id}' did not expose any importable entities.`;
      await finalizeExecutionTask(session, task, {
        status: 'blocked',
        summary,
        diagnostics: [...node.diagnostics],
        note: summary,
      });
      updatePostExecutionGap(session, node, task, {
        verdict: 'blocked',
        closedGap: false,
        summary,
        diagnostics: [...node.diagnostics],
      });
      addLog(session, 'warning', summary, node.id);
      return;
    }

    node.diagnostics = node.diagnostics.filter((entry) => !/no execution handler is registered/i.test(entry));
    node.metadata = {
      ...(node.metadata ?? {}),
      pluginId: plugin.id,
      pluginHash: plugin.artifactHash,
      executionReceipt: plugin.lastExecution,
      adapterGeneration: {
        pluginId: plugin.id,
        pluginHash: plugin.artifactHash,
        executionReceipt: plugin.lastExecution,
        driverNameHint,
        bridgeExecutable: working.bridgeExecutable,
        updatedAt: nowIso(),
      },
    };

    const summary = `Generated adapter '${plugin.id}' was applied and discovery resumed for this source.`;
    await finalizeExecutionTask(session, task, {
      status: 'completed',
      summary,
      diagnostics: [`Generated adapter '${plugin.id}' applied successfully.`],
      runtimeArtifacts: [`generated_plugin:${plugin.id}`],
      note: `Generated adapter '${plugin.id}' applied successfully.`,
    });

    const gap = findGapForNode(session, node.id);
    if (gap) {
      gap.status = 'open';
      gap.message = summary;
      gap.updatedAt = nowIso();
    }
    updatePostExecutionGap(session, node, task, {
      verdict: 'needs_retry',
      closedGap: false,
      summary,
      diagnostics: [`Generated adapter '${plugin.id}' applied successfully.`],
      resultingCapabilityId: plugin.id,
    });
    addLog(session, 'info', `Execution task '${task.action}' generated adapter '${plugin.id}' for '${node.label}'.`, node.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Adapter generation failed.';
    node.status = 'gap';
    node.diagnostics = dedupeStrings([message]);
    await finalizeExecutionTask(session, task, {
      status: 'failed',
      summary: 'Adapter generation failed.',
      diagnostics: [message],
      note: message,
    });
    updatePostExecutionGap(session, node, task, {
      verdict: 'needs_retry',
      closedGap: false,
      summary: 'Adapter generation failed.',
      diagnostics: [message],
    });
    addLog(session, 'error', `Execution task '${task.action}' failed for '${node.label}': ${message}`, node.id);
  }
}

async function processExecutionTask(session: ImportSessionState, task: CapabilityExecutionTask): Promise<void> {
  if (task.status !== 'running') return;
  const node = session.nodes[task.nodeId];
  if (!node) {
    await finalizeExecutionTask(session, task, {
      status: 'failed',
      summary: 'Execution task references a node that no longer exists.',
      diagnostics: ['Execution task references a node that no longer exists.'],
    });
    return;
  }

  if (task.action === 'acquire_runtime' || task.action === 'generate_adapter') {
    const message = 'Driver-backed tasks require an approved isolation and full-import profile.';
    await finalizeExecutionTask(session, task, { status: 'blocked', summary: message, diagnostics: [message] });
    updatePostExecutionGap(session, node, task, {
      verdict: 'blocked', closedGap: false, summary: message, diagnostics: [message],
    });
    return;
  }

  const summary = `No execution handler is registered for action '${task.action}'.`;
  node.diagnostics = dedupeStrings([summary]);
  await finalizeExecutionTask(session, task, {
    status: 'blocked',
    summary,
    diagnostics: [summary],
    note: summary,
  });
  updatePostExecutionGap(session, node, task, {
    verdict: 'blocked',
    closedGap: false,
    summary,
    diagnostics: [summary],
  });
  addLog(session, 'warning', summary, node.id);
}

async function processRunningExecutionTasks(session: ImportSessionState): Promise<void> {
  const runningTasks = session.executionTasks.filter((task) => task.status === 'running');
  for (const task of runningTasks) {
    await processExecutionTask(session, task);
  }
}

async function startExecutionTask(
  session: ImportSessionState,
  node: ImportTreeNode,
  inspector: ImportInspectorResult,
  planner: ImportPlannerResult | undefined,
  implementer: ImportImplementerResult | undefined,
): Promise<CapabilityExecutionTask | undefined> {
  if (!implementer) return undefined;
  if (implementer.action === 'blocked' || implementer.action === 'collect_input') {
    return undefined;
  }

  const existing = session.executionTasks.find(
    (task) => task.nodeId === node.id && task.action === implementer.action && task.status === 'running',
  );
  if (existing) {
    existing.updatedAt = nowIso();
    existing.summary = implementer.summary;
    existing.steps = implementer.steps;
    existing.dependencies = implementer.dependencies;
    existing.targetFiles = implementer.targetFiles;
    existing.runtimeArtifacts = implementer.runtimeArtifacts;
    existing.verificationPlan = implementer.verificationPlan;
    existing.planType = planner?.planType;
    existing.targetCapabilityId = planner?.targetCapabilityId;
    existing.sourceClass = inspector.sourceClass;
    existing.runtimeFamily = implementer.runtimeFamily ?? planner?.runtimeFamily;
    existing.acquisitionPath = implementer.acquisitionPath ?? planner?.acquisitionPath;
    existing.executionGoals = implementer.executionGoals ?? planner?.executionGoals;
    existing.artifactPath = await persistExecutionTaskArtifact(session, existing);
    return existing;
  }

  const task: CapabilityExecutionTask = {
    id: randomUUID(),
    nodeId: node.id,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: 'running',
    action: implementer.action,
    summary: implementer.summary,
    steps: implementer.steps,
    dependencies: implementer.dependencies,
    targetFiles: implementer.targetFiles,
    runtimeArtifacts: implementer.runtimeArtifacts,
    verificationPlan: implementer.verificationPlan,
    planType: planner?.planType,
    targetCapabilityId: planner?.targetCapabilityId,
    sourceClass: inspector.sourceClass,
    runtimeFamily: implementer.runtimeFamily ?? planner?.runtimeFamily,
    acquisitionPath: implementer.acquisitionPath ?? planner?.acquisitionPath,
    executionGoals: implementer.executionGoals ?? planner?.executionGoals,
    diagnostics: [],
    notes: [],
  };
  task.artifactPath = await persistExecutionTaskArtifact(session, task);
  session.executionTasks.unshift(task);
  addLog(session, 'info', `Started execution task '${task.action}' for '${node.label}'.`, node.id);
  return task;
}

function extractJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const objectStart = trimmed.indexOf('{');
  const objectEnd = trimmed.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) {
    return trimmed.slice(objectStart, objectEnd + 1).trim();
  }
  return trimmed;
}

function parseModelJson<T>(raw: string): T {
  const jsonText = extractJsonPayload(raw);
  if (!jsonText) {
    throw new Error('Model returned empty JSON content.');
  }
  try {
    return JSON.parse(jsonText) as T;
  } catch (error) {
    const snippet = jsonText.replace(/\s+/g, ' ').slice(0, 320);
    const message = error instanceof Error ? error.message : 'Unknown JSON parse failure.';
    throw new Error(`Model JSON parse failed: ${message}. Raw snippet: ${snippet}`);
  }
}

async function callProviderForJson<T>(
  config: GenerationProvider,
  systemContent: string,
  prompt: string,
  maxTokens: number,
  session: ImportSessionState,
): Promise<{ parsed: T; raw: string }> {
  let lastError = 'Model JSON parse failed.';
  let lastRaw = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const attemptPrompt = attempt === 0
      ? prompt
      : `${prompt}

The previous answer was invalid or incomplete JSON.
Previous parser error: ${lastError}

Return exactly one compact JSON object. No markdown. No commentary. No prose outside the JSON object.`;
    session.generation ??= emptyGenerationAudit();
    if (session.generation.calls >= 8) throw new Error('Generation budget exhausted for this import session.');
    await auditGeneration(join(importDataRoot, 'generation-events.jsonl'), session.id, session.generation, true, config);
    await writeSession(session);
    lastRaw = (await config.generate(systemContent, attemptPrompt, maxTokens)).trim();
    try {
      return {
        parsed: parseModelJson<T>(lastRaw),
        raw: lastRaw,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Model JSON parse failed.';
    }
  }
  throw new Error(lastError + (lastRaw ? ` Final raw snippet: ${lastRaw.replace(/\s+/g, ' ').slice(0, 320)}` : ''));
}

function summarizeCapabilitiesForPrompt(
  capabilityCatalog: ImportCapabilityRecord[],
  capabilityIds: string[],
): Array<Pick<ImportCapabilityRecord, 'id' | 'kind' | 'handles' | 'reusePriority' | 'dependencies' | 'introducedBy'>> {
  return capabilityCatalog
    .filter((entry) => capabilityIds.includes(entry.id))
    .slice(0, 6)
    .map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      handles: entry.handles,
      reusePriority: entry.reusePriority,
      dependencies: entry.dependencies,
      introducedBy: entry.introducedBy,
    }));
}

async function planImplementationTask(
  session: ImportSessionState,
  aipConfig: GenerationProvider,
  node: ImportTreeNode,
  inspector: ImportInspectorResult,
  planner: ImportPlannerResult,
  capabilityCatalog: ImportCapabilityRecord[],
  binaryContext?: ReturnType<typeof binaryPlanningContext>,
): Promise<ImportImplementerResult> {
  const context = {
    inspector,
    planner,
    relevantCapabilities: summarizeCapabilitiesForPrompt(capabilityCatalog, inspector.reuseCandidateIds),
    availableRuntimeActions: plannerRuntimeActions,
    availableRuntimeFamilies: runtimeFamiliesForSourceClass(inspector.sourceClass),
    availableAcquisitionPaths: acquisitionPathsForGap(inspector.missingDimension),
    requiredExecutionGoals: planner.executionGoals ?? executionGoalsForNode(inspector.sourceClass, inspector.missingDimension),
    runtimeEnvironment: runtimePlanningContext(node) ?? undefined,
    binaryContext: binaryContext ?? undefined,
  };

  const prompt = `
Translate the selected repair plan into the next concrete implementation task for the import runtime.

Context:
\`\`\`json
${JSON.stringify(context, null, 2)}
\`\`\`

Rules:
- Pick the smallest resumable step that moves the node toward discovery, preview, or import.
- Reuse existing KOIForge capability paths before proposing new runtime work.
- Respect the selected runtime family, acquisition path, and execution goals.
- If the plan depends on runtime acquisition or adapter generation, make that explicit in action, steps, dependencies, and verificationPlan.
- Choose a concrete technology only if it is the minimal realization of the chosen generic runtime family.
- Do not explain the problem again. Produce the implementation task only.
`.trim();

  const { parsed } = await callProviderForJson<ImportImplementerResult>(
    aipConfig,
    `${IMPORT_IMPLEMENTER_CONTRACT}\n\nReturn exactly one valid JSON object. No markdown.`,
    prompt,
    implementerTokenBudget,
    session,
  );
  return parsed;
}

type AiRepairPlannerResult =
  ImportPlannerResult & {
    strategy?: 'csv' | 'json' | 'xml' | 'javascript' | 'none';
    params?: {
      delimiter?: string;
      path?: string;
      code?: string;
    };
  };

async function applyAiRepairPlan(plan: AiRepairPlannerResult, content: string): Promise<{ rows: Array<Record<string, CellValue>>; receipt?: ExecutionReceipt }> {
  if (plan.strategy === 'csv') {
    return { rows: parseCsvRows(content, String(plan.params?.delimiter ?? ',')) };
  }

  if (plan.strategy === 'json') {
    return { rows: parseJsonRows(content, typeof plan.params?.path === 'string' ? plan.params.path : undefined) };
  }

  if (plan.strategy === 'xml') {
    return { rows: parseXmlRows(content) };
  }

  return executeImportParser(String(plan.params?.code ?? ''), content);
}

async function tryAiRepairNode(
  session: ImportSessionState,
  node: ImportTreeNode,
  registries: AppRegistries,
  inspector: ImportInspectorResult,
  capabilityCatalog: ImportCapabilityRecord[],
): Promise<RepairOutcome> {
  if (process.env.KOIFORGE_GENERATION_DISABLED === '1') {
    session.generation ??= emptyGenerationAudit();
    try { await auditGeneration(join(importDataRoot, 'generation-events.jsonl'), session.id, session.generation); }
    finally { await writeSession(session); }
  }
  const aipConfig = await generationProvider(registries);
  const availability = await aipConfig.status();
  if (!availability.available || !node.sourcePath) {
    return {
      repaired: false,
      planner: {
        planType: 'blocked',
        executionMode: 'none',
        reasoning: availability.reason ?? 'Quelldatei für die Erweiterung fehlt.',
        expectedOutcome: 'Die lokale Erweiterung benötigt eine verfügbare Codex-Anmeldung und eine Quelldatei.',
      },
      verifier: {
        verdict: 'blocked',
        closedGap: false,
        summary: 'Fähigkeitsplanung ist nicht verfügbar.',
        diagnostics: [availability.reason ?? 'Quelldatei fehlt.'],
      },
    };
  }

  const fileBuffer = await readFile(node.sourcePath);
  const rawText = fileBuffer.slice(0, 4000).toString('utf8');
  const isBinary = rawText.includes('\u0000') || [...rawText.slice(0, 200)].filter((c) => c.charCodeAt(0) < 9 || (c.charCodeAt(0) > 13 && c.charCodeAt(0) < 32)).length > 10;

  const contentSample = rawText;
  if (fileBuffer.length > EXECUTION_PROFILE.maxInputBytes) {
    throw new Error('Source exceeds 10 MiB; no truncated repair input accepted.');
  }
  const contentText = isBinary ? '' : decodeUtf8(fileBuffer);
  const binaryContext = binaryPlanningContext(node, fileBuffer);
  let lastError: string | undefined;
  let lastPlanner: ImportPlannerResult | undefined;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const plannerContext = {
      repairTarget: {
        fileName: basename(node.sourcePath),
        nodeKind: node.kind,
        sourceClass: inspector.sourceClass,
        detectedFormat: node.detectedFormat ?? 'unknown',
        diagnostics: node.diagnostics,
      },
      inspector,
      reuseCandidates: summarizeCapabilitiesForPrompt(capabilityCatalog, inspector.reuseCandidateIds),
      planningPriority: plannerRuntimeActions,
      runtimeFamilies: runtimeFamiliesForSourceClass(inspector.sourceClass),
      acquisitionPaths: acquisitionPathsForGap(inspector.missingDimension),
      executionGoals: executionGoalsForNode(inspector.sourceClass, inspector.missingDimension),
      availableRuntimeActions: plannerRuntimeActions,
      runtimeEnvironment: runtimePlanningContext(node) ?? undefined,
      availableParserStrategies: isBinary
        ? []
        : [
            { strategy: 'csv', params: { delimiter: ',' } },
            { strategy: 'json', params: { path: 'optional.dot.path' } },
            { strategy: 'xml', params: {} },
            { strategy: 'javascript', params: { code: '<assign result = [...]>' } },
          ],
      binaryContext: isBinary ? binaryContext : undefined,
      contentSample: isBinary ? undefined : contentSample,
      confirmedFormatDescription: node.config.formatDescription,
      previousAttemptError: lastError ?? undefined,
    };

    const prompt = `
Plan the next resumable import-capability step for the selected node.

Context:
\`\`\`json
${JSON.stringify(plannerContext, null, 2)}
\`\`\`

Rules:
- Reuse first. If that is insufficient, propose the smallest durable runtime, adapter, discovery, or parser step.
- Reason first in source class, capability gap, runtime family, acquisition path, and execution goals.
- For runtime-backed sources, prefer runtime acquisition and adapter paths over blocking.
- Choose concrete technologies only after the generic access path is clear.
- For supported text parsing, return executionMode tabular_parser, strategy javascript and params.code assigning result from the complete content string. Reject malformed input. Do not hardcode sample rows or field names.
- Optimize for making the node discoverable, previewable, and importable.
- If no current capability fits, produce a usable next step anyway instead of restating the gap.
`.trim();

    try {
      const { parsed: plan } = await callProviderForJson<AiRepairPlannerResult>(
        aipConfig,
        `${IMPORT_PLANNER_CONTRACT}\n\nReturn exactly one valid JSON object. No markdown.`,
        prompt,
        plannerTokenBudget,
        session,
      );
      lastPlanner = plan;

      if (plan.planType === 'blocked') {
        return {
          repaired: false,
          planner: plan,
          verifier: {
            verdict: 'blocked',
            closedGap: false,
            summary: plan.expectedOutcome,
            diagnostics: [plan.reasoning],
          },
        };
      }

      if (
        (plan.planType === 'acquire_runtime'
        || plan.planType === 'generate_adapter'
        || plan.planType === 'reload_runtime'
        || plan.planType === 'resume_discovery'
        || plan.planType === 'reuse_existing'
        || plan.planType === 'compose_existing')
        && !(plan.executionMode === 'tabular_parser' && ['javascript', 'csv', 'json', 'xml'].includes(plan.strategy ?? ''))
      ) {
        const implementer = await planImplementationTask(
          session,
          aipConfig,
          node,
          inspector,
          plan,
          capabilityCatalog,
          isBinary ? binaryContext : undefined,
        );
        return {
          repaired: false,
          planner: plan,
          implementer,
          verifier: {
            verdict: 'needs_retry',
            closedGap: false,
            summary: plan.expectedOutcome,
            diagnostics: [plan.reasoning],
          },
        };
      }

      if (plan.planType === 'reuse_with_input') {
        return {
          repaired: false,
          planner: plan,
          implementer: {
            action: 'collect_input',
            summary: 'The next step is to collect the missing required inputs.',
            steps: inspector.requiredInputs.map((field) => `Collect required input: ${field}`),
            dependencies: [],
            targetFiles: [],
            runtimeArtifacts: [],
            verificationPlan: ['Re-run capability inspection after the missing fields are provided.'],
          },
          verifier: {
            verdict: 'blocked',
            closedGap: false,
            summary: 'The planner requires user input instead of code generation.',
            diagnostics: [plan.reasoning],
          },
        };
      }

      if (!plan.strategy || plan.strategy === 'none') {
        return {
          repaired: false,
          planner: {
            ...plan,
            planType: 'blocked',
          },
          implementer: {
            action: 'blocked',
            summary: 'The planner did not return an executable next step.',
            steps: [],
            dependencies: [],
            targetFiles: [],
            runtimeArtifacts: [],
            verificationPlan: [],
          },
          verifier: {
            verdict: 'blocked',
            closedGap: false,
            summary: 'The planner did not return an executable parser strategy.',
            diagnostics: [plan.reasoning],
          },
        };
      }

      const candidateValidation = plan.strategy === 'javascript'
        ? await validateParserCandidate(String(plan.params?.code ?? ''), node.config.validationFixtures)
        : undefined;
      const execution = await applyAiRepairPlan(plan, contentText);
      const rows = validateRows(execution.rows);
      const artifactPath = await writeRowsArtifact(session, node.id, rows);
      const extension = extname(node.sourcePath).toLowerCase();
      const pluginId = `generated_${slugify(`${extension || 'text'}_${plan.strategy}`)}`;
      const plugin: GeneratedImportPlugin = {
        id: pluginId,
        label: `Generated ${plan.strategy} parser for ${extension || 'text'}`,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        introducedBy: plan.planType === 'extend_existing' ? 'extended' : 'generated',
        reusePriority: 80,
        dependencies: [],
        successCount: 0,
        match: { extensions: [extension] },
        strategy: plan.strategy === 'csv'
          ? { type: 'csv', delimiter: String(plan.params?.delimiter ?? ',') }
          : plan.strategy === 'json'
            ? { type: 'json', path: typeof plan.params?.path === 'string' ? plan.params.path : undefined }
            : plan.strategy === 'xml'
              ? { type: 'xml' }
              : { type: 'javascript', code: String(plan.params?.code ?? '') },
        notes: 'Generated automatically by the import repair loop.',
      };
      await saveGeneratedPlugin(plugin);
        node.capabilityId = 'aip-inline';
      node.status = 'ready';
      node.preview = rowsToPreview(rows);
      node.config = {
        ...node.config,
        datasetName: String(node.config.datasetName ?? slugify(basename(node.sourcePath, extname(node.sourcePath)))),
        namespace: String(node.config.namespace ?? 'imports'),
      };
      node.inputForm = {
        title: 'AIP Repaired Import',
        description: `AIP generated a tabular repair strategy (${plan.strategy}).`,
        fields: [...commonDatasetFields(false), ...(plan.strategy === 'javascript' ? generatedParserContractFields() : [])],
      };
      node.metadata = {
        ...(node.metadata ?? {}),
        artifactPath,
        pluginId,
        pluginHash: plugin.artifactHash,
        executionReceipt: execution.receipt,
        candidateValidation,
        aipStrategy: plan.strategy,
        aipReasoning: plan.reasoning,
      };
      node.diagnostics = node.diagnostics.filter((entry) => !entry.toLowerCase().includes('no existing import capability'));
      addLog(session, 'info', `AIP repaired node '${node.label}' via ${plan.strategy}.`, node.id);
      return {
        repaired: true,
        planner: plan,
        verifier: {
          verdict: 'needs_retry',
          closedGap: false,
          summary: `Parser candidate created; registered dataset verification is still pending.`,
          diagnostics: [`Generated plugin '${pluginId}' created ${rows.length} row(s).`],
          resultingCapabilityId: node.capabilityId,
        },
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'AIP repair failed.';
    }
  }

  if (lastError) {
    node.diagnostics = [...node.diagnostics, lastError];
  }
  return {
    repaired: false,
    planner: lastPlanner,
    verifier: {
      verdict: 'needs_retry',
      closedGap: false,
      summary: 'Planner could not produce a usable repair.',
      diagnostics: [lastError ?? 'Unknown planning failure.'],
    },
    notes: lastError ? [lastError] : [],
  };
}

async function tryDeterministicRepairNode(
  session: ImportSessionState,
  node: ImportTreeNode,
  inspector: ImportInspectorResult,
): Promise<RepairOutcome> {
  if (!node.sourcePath) {
    return {
      repaired: false,
      verifier: {
        verdict: 'blocked',
        closedGap: false,
        summary: 'The node has no source path for deterministic repair.',
        diagnostics: inspector.diagnostics,
      },
    };
  }

  if (extname(node.sourcePath).toLowerCase() === '.sql') {
    const content = await readTabularText(node.sourcePath);
    const tables = parseSqlDumpTables(content);
    if (tables.length === 0) {
      node.diagnostics = [...node.diagnostics, 'SQL dump repair found no INSERT statements.'];
      return {
        repaired: false,
        planner: {
          planType: 'generate_adapter',
          executionMode: 'tabular_parser',
          targetCapabilityId: 'generated_sql_insert_dump',
          strategy: 'sql-insert-dump',
          reasoning: 'The deterministic SQL dump path found no INSERT statements to convert into tables.',
          expectedOutcome: 'The node still requires another capability path.',
        },
        verifier: {
          verdict: 'needs_retry',
          closedGap: false,
          summary: 'Deterministic SQL repair did not find importable rows.',
          diagnostics: [...inspector.diagnostics, 'SQL dump repair found no INSERT statements.'],
        },
      };
    }
    const pluginId = 'generated_sql_insert_dump';
    const plugin: GeneratedImportPlugin = {
      id: pluginId,
      label: 'Generated SQL INSERT dump importer',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      introducedBy: 'generated',
      reusePriority: 82,
      dependencies: [],
      successCount: 0,
      match: { extensions: ['.sql'] },
      strategy: { type: 'sql-insert-dump' },
      notes: 'Generated automatically from a successful SQL dump repair.',
    };
    await saveGeneratedPlugin(plugin);

    node.status = 'group';
    node.kind = 'file';
    node.capabilityId = undefined;
    node.children = [];
    for (const table of tables) {
      const artifactPath = await writeRowsArtifact(session, `${node.id}_${slugify(table.table)}`, table.rows);
      addNode(session, {
        parentId: node.id,
        label: table.table,
        kind: 'db-table',
        status: 'ready',
        selected: true,
        detectedFormat: 'sql-dump-table',
        capabilityId: 'sql-dump-table',
        sourcePath: node.sourcePath,
        diagnostics: [`Recovered from SQL dump '${basename(node.sourcePath)}'.`],
        preview: rowsToPreview(table.rows),
        config: {
          datasetName: slugify(table.table),
          namespace: slugify(basename(node.sourcePath, extname(node.sourcePath))) || 'imports',
        },
        inputForm: {
          title: 'SQL Dump Table Import',
          description: 'Rows were extracted from the SQL dump and can now be imported as inline datasets.',
          fields: commonDatasetFields(false),
        },
        metadata: {
          artifactPath,
          sourceTable: table.table,
          pluginId,
          pluginHash: plugin.artifactHash,
        },
      });
    }
    addLog(session, 'info', `SQL dump '${node.label}' expanded into ${tables.length} table node(s).`, node.id);
    return {
      repaired: true,
      planner: {
        planType: 'generate_adapter',
        executionMode: 'tabular_parser',
        targetCapabilityId: pluginId,
        strategy: 'sql-insert-dump',
        reasoning: 'The SQL dump could be closed by a generated table-extraction plugin.',
        expectedOutcome: 'The node expands into importable table children.',
      },
      verifier: {
        verdict: 'needs_retry',
        closedGap: false,
        summary: `SQL dump expanded into ${tables.length} candidates; registered dataset verification pending.`,
        diagnostics: [`Generated plugin '${pluginId}' is now reusable for future SQL dumps.`],
      },
    };
  }

  return {
    repaired: false,
    verifier: {
      verdict: 'needs_retry',
      closedGap: false,
      summary: 'No deterministic repair matched this node.',
      diagnostics: inspector.diagnostics,
    },
  };
}

async function discoverFile(
  session: ImportSessionState,
  parentId: string | null,
  filePath: string,
  depth: number,
): Promise<ImportTreeNode> {
  const lowerExt = extname(filePath).toLowerCase();
  const label = basename(filePath);

  if (textConfigExts.has(lowerExt)) {
    const pluginNode = await discoverViaGeneratedPlugin(session, parentId, filePath);
    if (pluginNode) return pluginNode;
  }

  if (archiveExts.has(lowerExt) && depth < 4) {
    const archiveNode = addNode(session, {
      parentId,
      label,
      kind: 'archive',
      status: 'group',
      selected: true,
      detectedFormat: lowerExt.slice(1),
      sourcePath: filePath,
      diagnostics: [],
      config: {},
    });

    const extractDir = join(dirname(filePath), `${basename(filePath, lowerExt)}__extracted`);
    try {
      await extractArchive(filePath, extractDir);
      const entries = await readdir(extractDir);
      for (const entry of entries.sort()) {
        await discoverPath(session, archiveNode.id, join(extractDir, entry), depth + 1);
      }
      addLog(session, 'info', `Archive extracted: ${label}`, archiveNode.id);
    } catch (error) {
      archiveNode.status = 'gap';
      archiveNode.diagnostics.push(error instanceof Error ? error.message : 'Archive extraction failed.');
      addLog(session, 'error', `Archive extraction failed for ${label}.`, archiveNode.id);
    }
    return archiveNode;
  }

  if (lowerExt === '.csv' || lowerExt === '.tsv' || lowerExt === '.txt') {
    const sample = await readTabularText(filePath);
    const delimiter = inferDelimiter(filePath, sample);
    return addNode(session, {
      parentId,
      label,
      kind: 'file',
      status: 'ready',
      selected: true,
      detectedFormat: lowerExt.slice(1) || 'text',
      capabilityId: 'csv-file',
      sourcePath: filePath,
      diagnostics: [],
      preview: parseCsvPreview(sample, delimiter),
      config: {
        datasetName: slugify(basename(filePath, lowerExt)),
        namespace: 'imports',
        delimiter,
      },
      inputForm: {
        title: 'CSV Import',
        description: 'This file can be imported through the existing CSV connector.',
        fields: [
          ...commonDatasetFields(false),
          {
            key: 'delimiter',
            label: 'Delimiter',
            kind: 'select',
            required: true,
            options: [
              { label: 'Comma (,)', value: ',' },
              { label: 'Semicolon (;)', value: ';' },
              { label: 'Tab', value: '\t' },
              { label: 'Pipe (|)', value: '|' },
            ],
          },
        ],
      },
    });
  }

  if (spreadsheetExts.has(lowerExt)) {
    const workbookNode = addNode(session, {
      parentId,
      label,
      kind: 'excel-workbook',
      status: 'group',
      selected: true,
      detectedFormat: lowerExt.slice(1),
      sourcePath: filePath,
      diagnostics: [],
      config: {},
    });
    try {
      const XLSX = await loadXlsx();
      const workbook = XLSX.read(await readFile(filePath), { type: 'buffer' });
      for (const sheetName of workbook.SheetNames) {
        const worksheet = workbook.Sheets[sheetName];
        const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, { defval: null }) as Array<Record<string, unknown>>;
        const rows = rawRows.map((entry: Record<string, unknown>) =>
          Object.fromEntries(
            Object.entries(entry).map(([key, value]) => [
              key,
              value == null
                ? null
                : typeof value === 'number' || typeof value === 'boolean'
                  ? value
                  : String(value),
            ]),
          ) as Record<string, CellValue>,
        );
        addNode(session, {
          parentId: workbookNode.id,
          label: sheetName,
          kind: 'sheet',
          status: 'ready',
          selected: true,
          detectedFormat: 'sheet',
          capabilityId: 'excel-sheet',
          sourcePath: filePath,
          diagnostics: [],
          preview: rowsToPreview(rows),
          config: {
            datasetName: slugify(`${basename(filePath, lowerExt)}_${sheetName}`),
            namespace: 'imports',
          },
          inputForm: {
            title: 'Excel Sheet Import',
            description: 'The sheet will be imported as an inline dataset.',
            fields: commonDatasetFields(false),
          },
          metadata: {
            sheetName,
          },
        });
      }
    } catch (error) {
      workbookNode.status = 'gap';
      workbookNode.diagnostics.push(error instanceof Error ? error.message : 'Workbook parsing failed.');
    }
    return workbookNode;
  }

  if (lowerExt === '.json') {
    const node = addNode(session, {
      parentId,
      label,
      kind: 'file',
      status: 'group',
      selected: true,
      detectedFormat: 'json',
      sourcePath: filePath,
      diagnostics: [],
      config: {},
    });
    try {
      const content = await readTabularText(filePath);
      const hints = await detectConnectionHints(filePath);
      const candidates = parseJsonCandidates(content);
      if (hints.length > 0 && candidates.length === 1 && candidates[0] && looksLikeConnectionObject(candidates[0].rows)) {
        for (const hint of hints) {
          const generatedPlugin = await ensureDbDiscoveryPluginForHint(hint.connectorId, filePath);
          const candidate = addNode(session, {
            parentId: node.id,
            label: `${hint.connectorId} candidate`,
            kind: 'db-connection',
            status: 'needs_input',
            selected: true,
            detectedFormat: `${hint.connectorId}-connection`,
            capabilityId: hint.connectorId === 'mongodb' ? undefined : 'db-connector',
            sourcePath: filePath,
            diagnostics: [...hint.diagnostics],
            config: hint.config,
            metadata: {
              sourceFile: basename(filePath),
              pluginId: generatedPlugin.id,
              pluginHash: generatedPlugin.artifactHash,
            },
          });
          if (hint.connectorId === 'mongodb') {
            candidate.status = 'gap';
            candidate.diagnostics.push('MongoDB requires a new capability and cannot be registered yet.');
          } else {
            refreshDbConnectionNode(candidate);
          }
        }
        return node;
      }
      if (candidates.length === 1 && candidates[0] && candidates[0].label === 'root') {
        node.status = 'ready';
        node.kind = 'json-array';
        node.capabilityId = 'json-file';
        node.preview = rowsToPreview(candidates[0].rows);
        node.config = {
          datasetName: slugify(basename(filePath, lowerExt)),
          namespace: 'imports',
        };
        node.inputForm = {
          title: 'JSON Import',
          description: 'The JSON payload will be normalized into an inline dataset.',
          fields: commonDatasetFields(false),
        };
      } else {
        for (const candidate of candidates) {
          addNode(session, {
            parentId: node.id,
            label: candidate.label,
            kind: 'json-array',
            status: 'ready',
            selected: true,
            detectedFormat: 'json-array',
            capabilityId: 'json-file',
            sourcePath: filePath,
            diagnostics: [],
            preview: rowsToPreview(candidate.rows),
            config: {
              datasetName: slugify(`${basename(filePath, lowerExt)}_${candidate.label}`),
              namespace: 'imports',
            },
            inputForm: {
              title: 'JSON Import',
              fields: commonDatasetFields(false),
            },
            metadata: {
              jsonPath: candidate.path ?? '',
            },
          });
        }
      }
    } catch (error) {
      node.status = 'gap';
      node.diagnostics.push(error instanceof Error ? error.message : 'JSON parsing failed.');
    }
    return node;
  }

  if (lowerExt === '.xml') {
    const rows = parseXmlRows(await readTabularText(filePath));
    return addNode(session, {
      parentId,
      label,
      kind: 'xml-table',
      status: 'ready',
      selected: true,
      detectedFormat: 'xml',
      capabilityId: 'xml-file',
      sourcePath: filePath,
      diagnostics: [],
      preview: rowsToPreview(rows),
      config: {
        datasetName: slugify(basename(filePath, lowerExt)),
        namespace: 'imports',
      },
      inputForm: {
        title: 'XML Import',
        description: 'A repeated XML structure was normalized into rows.',
        fields: commonDatasetFields(false),
      },
    });
  }

  if (lowerExt === '.sqlite' || lowerExt === '.sqlite3' || lowerExt === '.db') {
    const sqliteNode = addNode(session, {
      parentId,
      label,
      kind: 'sqlite-database',
      status: 'group',
      selected: true,
      detectedFormat: 'sqlite',
      sourcePath: filePath,
      diagnostics: [],
      config: {},
    });
    try {
      const tables = listSqliteTables(filePath);
      for (const table of tables) {
        addNode(session, {
          parentId: sqliteNode.id,
          label: table,
          kind: 'db-table',
          status: 'ready',
          selected: true,
          detectedFormat: 'sqlite-table',
          capabilityId: 'sqlite-table',
          sourcePath: filePath,
          diagnostics: [],
          preview: {
            columns: getSqliteSchema(filePath, table).map((entry) => entry.name),
            rows: [],
            rowCount: 0,
          },
          config: {
            datasetName: slugify(table),
            namespace: slugify(basename(filePath, lowerExt)) || 'sqlite',
            mode: 'materialized',
          },
          inputForm: {
            title: 'SQLite Table Import',
            description: 'The existing SQLite connector will be used.',
            fields: commonDatasetFields(true),
          },
          metadata: {
            table,
          },
        });
      }
    } catch (error) {
      sqliteNode.status = 'gap';
      sqliteNode.diagnostics.push(error instanceof Error ? error.message : 'SQLite discovery failed.');
    }
    return sqliteNode;
  }

  if (lowerExt === '.sql') {
    const pluginNode = await discoverViaGeneratedPlugin(session, parentId, filePath);
    if (pluginNode) return pluginNode;
    return addNode(session, {
      parentId,
      label,
      kind: 'file',
      status: 'gap',
      selected: true,
      detectedFormat: 'sql',
      sourcePath: filePath,
      diagnostics: ['SQL dumps are staged, but no automatic dump importer exists yet.'],
      config: {},
    });
  }

  if (textConfigExts.has(lowerExt)) {
    const configNode = addNode(session, {
      parentId,
      label,
      kind: 'file',
      status: 'group',
      selected: true,
      detectedFormat: lowerExt.slice(1) || 'text-config',
      sourcePath: filePath,
      diagnostics: [],
      config: {},
    });
    try {
      const hints = await detectConnectionHints(filePath);
      if (hints.length === 0) {
        configNode.status = 'gap';
        configNode.diagnostics.push('No reusable import capability was detected for this config file.');
      } else {
        for (const hint of hints) {
          const generatedPlugin = await ensureDbDiscoveryPluginForHint(hint.connectorId, filePath);
          const candidate = addNode(session, {
            parentId: configNode.id,
            label: `${hint.connectorId} candidate`,
            kind: 'db-connection',
            status: 'needs_input',
            selected: true,
            detectedFormat: `${hint.connectorId}-connection`,
            capabilityId: hint.connectorId === 'mongodb' ? undefined : 'db-connector',
            sourcePath: filePath,
            diagnostics: [...hint.diagnostics],
            config: hint.config,
            metadata: {
              sourceFile: basename(filePath),
              pluginId: generatedPlugin.id,
              pluginHash: generatedPlugin.artifactHash,
            },
          });
          if (hint.connectorId === 'mongodb') {
            candidate.status = 'gap';
            candidate.diagnostics.push('MongoDB requires a new capability and cannot be registered yet.');
          } else {
            refreshDbConnectionNode(candidate);
          }
        }
      }
    } catch (error) {
      configNode.status = 'gap';
      configNode.diagnostics.push(error instanceof Error ? error.message : 'Config inspection failed.');
    }
    return configNode;
  }

  const pluginNode = await discoverViaGeneratedPlugin(session, parentId, filePath);
  if (pluginNode) return pluginNode;

  return addNode(session, {
    parentId,
    label,
    kind: 'file',
    status: 'gap',
    selected: true,
    detectedFormat: lowerExt ? lowerExt.slice(1) : 'unknown',
    sourcePath: filePath,
    diagnostics: ['No existing import capability matched this file yet.'],
    config: {},
    inputForm: { title: 'Neue Quelle erschließen', description: 'Format und unabhängige Prüfbeispiele bestätigen; danach Fähigkeit ergänzen.', fields: [
      { key: 'formatDescription', label: 'Formatbeschreibung', kind: 'text', required: false },
      { key: 'validationFixtures', label: 'Unabhängige Prüfbeispiele (JSON)', kind: 'text', required: false, description: 'Mindestens zwei {input,rows} und ein {input,reject:true}; nur synthetische Prüfdaten.' },
      ...generatedParserContractFields().map((field) => ({ ...field, required: false })),
    ] },
  });
}

async function discoverPath(
  session: ImportSessionState,
  parentId: string | null,
  targetPath: string,
  depth: number,
): Promise<void> {
  const stats = await stat(targetPath);
  if (stats.isDirectory()) {
    const folderNode = addNode(session, {
      parentId,
      label: basename(targetPath),
      kind: 'folder',
      status: 'group',
      selected: true,
      detectedFormat: 'folder',
      sourcePath: targetPath,
      diagnostics: [],
      config: {},
    });
    const entries = await readdir(targetPath);
    for (const entry of entries.sort()) {
      await discoverPath(session, folderNode.id, join(targetPath, entry), depth + 1);
    }
    return;
  }

  await discoverFile(session, parentId, targetPath, depth);
}

async function attemptRepairNode(
  session: ImportSessionState,
  nodeId: string,
  registries: AppRegistries,
): Promise<{ repaired: boolean; unresolved: boolean }> {
  const node = session.nodes[nodeId];
  if (!node || (node.status !== 'gap' && node.status !== 'failed' && node.status !== 'needs_input')) {
    return { repaired: false, unresolved: false };
  }

  const capabilityCatalog = await loadCapabilityCatalog();
  const inspector = inspectNodeCapabilityGap(node, capabilityCatalog);
  const trace = createOrReuseRepairTrace(session, inspector);
  const gap = session.gaps.find((entry) => entry.nodeId === nodeId);

  if (gap) {
    if (inspector.bestKnownNextAction !== 'ask_user_input') {
      gap.attemptCount += 1;
    }
    gap.updatedAt = nowIso();
    gap.lastInspector = inspector;
  }

  let outcome: RepairOutcome = {
    repaired: false,
    verifier: {
      verdict: 'needs_retry',
      closedGap: false,
      summary: 'No repair path executed.',
      diagnostics: inspector.diagnostics,
    },
  };

  try {
    if (inspector.bestKnownNextAction === 'ask_user_input') {
      outcome = {
        repaired: false,
        planner: {
          planType: 'reuse_with_input',
          executionMode: 'none',
          targetCapabilityId: inspector.reuseCandidateIds[0],
          strategy: 'none',
          params: {},
          reasoning: 'The node is blocked by missing required input, not by missing code.',
          expectedOutcome: 'Collect the required input fields and rerun import.',
        },
        implementer: {
          action: 'collect_input',
          summary: 'Provide the missing required input fields and rerun the import.',
          steps: inspector.requiredInputs.map((field) => `Fill required field: ${field}`),
          dependencies: [],
          targetFiles: [],
          runtimeArtifacts: [],
          verificationPlan: ['Re-run inspection once all required inputs are present.'],
        },
        verifier: {
          verdict: 'blocked',
          closedGap: false,
          summary: 'Repair is blocked until the required input fields are provided.',
          diagnostics: inspector.requiredInputs.map((field) => `Missing required input: ${field}`),
        },
      };
    } else {
      outcome = await tryDeterministicRepairNode(session, node, inspector);
      if (!outcome.repaired) {
        outcome = await tryAiRepairNode(session, node, registries, inspector, capabilityCatalog);
      }
    }
  } catch (error) {
    node.diagnostics = [...node.diagnostics, error instanceof Error ? error.message : 'Repair failed.'];
    outcome = {
      repaired: false,
      verifier: {
        verdict: 'needs_retry',
        closedGap: false,
        summary: 'Repair execution raised an exception.',
        diagnostics: [error instanceof Error ? error.message : 'Repair failed.'],
      },
    };
  }

  if (!outcome.repaired) {
    outcome.executionTask = await startExecutionTask(
      session,
      node,
      inspector,
      outcome.planner,
      outcome.implementer,
    );
    if (outcome.executionTask) {
      outcome.notes = [
        ...(outcome.notes ?? []),
        `Execution task started: ${outcome.executionTask.action} (${outcome.executionTask.id}).`,
      ];
    }
  }

  if (gap) {
    if (outcome.planner) gap.lastPlan = outcome.planner;
    if (outcome.implementer) gap.lastImplementer = outcome.implementer;
    if (outcome.verifier) gap.lastVerifier = outcome.verifier;
  }

  updateRepairTrace(trace, {
    planner: outcome.planner,
    implementer: outcome.implementer,
    verifier: outcome.verifier,
    status:
      outcome.verifier?.verdict === 'resolved'
        ? 'verified'
        : outcome.verifier?.verdict === 'blocked'
          ? 'blocked'
          : outcome.executionTask
            ? 'running'
            : outcome.planner?.planType === 'acquire_runtime'
              || outcome.planner?.planType === 'generate_adapter'
              || outcome.planner?.planType === 'reload_runtime'
              || outcome.planner?.planType === 'resume_discovery'
              || outcome.planner?.planType === 'reuse_existing'
              || outcome.planner?.planType === 'compose_existing'
                ? 'planned'
                : outcome.repaired
                  ? 'implemented'
                  : 'failed',
    notes: outcome.notes ?? [],
  });

  return {
    repaired: outcome.repaired,
    unresolved: !outcome.repaired,
  };
}

async function autoContinueCompletedTasks(
  session: ImportSessionState,
  registries: AppRegistries,
): Promise<{ repairedNodeIds: string[]; unresolvedNodeIds: string[] }> {
  const repairedNodeIds: string[] = [];
  const unresolvedNodeIds: string[] = [];
  const completedTasks = session.executionTasks.filter(
    (task) =>
      task.status === 'completed'
      && !(task.notes ?? []).includes('Auto-follow-up attempted.'),
  );

  for (const task of completedTasks) {
    pushTaskNote(task, 'Auto-follow-up attempted.');
    const gap = session.gaps.find((entry) => entry.nodeId === task.nodeId && entry.status === 'open');
    const hasRunningSibling = session.executionTasks.some((entry) => entry.nodeId === task.nodeId && entry.status === 'running');
    if (!gap || gap.bestKnownNextAction === 'ask_user_input' || gap.missingDimension === 'tool_acquisition' || hasRunningSibling) {
      task.artifactPath = await persistExecutionTaskArtifact(session, task);
      continue;
    }

    const result = await attemptRepairNode(session, task.nodeId, registries);
    if (result.repaired) {
      repairedNodeIds.push(task.nodeId);
    } else if (result.unresolved) {
      unresolvedNodeIds.push(task.nodeId);
    }
    task.updatedAt = nowIso();
    task.artifactPath = await persistExecutionTaskArtifact(session, task);
  }

  return { repairedNodeIds, unresolvedNodeIds };
}

function recomputeSessionStatus(session: ImportSessionState): void {
  const nodes = Object.values(session.nodes);
  if (nodes.some((node) => node.status === 'failed')) {
    session.status = 'failed';
    return;
  }
  if (session.executionTasks.some((task) => task.status === 'running')) {
    session.status = 'running';
    return;
  }
  if (nodes.some((node) => node.metadata?.pluginActivationError)) {
    session.status = 'needs_review';
    return;
  }
  if (nodes.some((node) => node.status === 'gap' || node.status === 'needs_input')) {
    session.status = 'needs_review';
    return;
  }
  if (nodes.some((node) => node.status === 'importing')) {
    session.status = 'running';
    return;
  }
  if (nodes.some((node) => node.status === 'imported')) {
    session.status = 'completed';
    return;
  }
  session.status = 'discovered';
}

function applySelection(session: ImportSessionState, selectedNodeIds: string[]): void {
  const selected = new Set(selectedNodeIds);
  for (const node of Object.values(session.nodes)) {
    node.selected = selected.has(node.id);
  }
  session.selectedNodeIds = [...selected];
  session.updatedAt = nowIso();
}

async function importNode(
  session: ImportSessionState,
  node: ImportTreeNode,
  registries: AppRegistries,
): Promise<Awaited<ReturnType<AppRegistries['dataset']['registerInlineDataset']>> | Awaited<ReturnType<AppRegistries['dataset']['registerDataset']>> | null> {
  const datasetName = String(node.config.datasetName ?? '').trim();
  const namespace = String(node.config.namespace ?? '').trim() || 'imports';
  if (!datasetName) {
    node.status = 'needs_input';
    addLog(session, 'warning', 'Dataset name is required before import.', node.id);
    return null;
  }

  if (node.capabilityId === 'csv-file') {
    const content = await readTabularText(node.sourcePath ?? '');
    if (Buffer.byteLength(content) > EXECUTION_PROFILE.maxInputBytes) throw new Error('CSV exceeds complete-import byte limit.');
    return registries.dataset.registerInlineDataset({
      name: datasetName,
      namespace,
      rows: validateRows(parseCsvRows(content, String(node.config.delimiter ?? ','))),
    });
  }

  if (node.capabilityId === 'json-file') {
    const content = await readTabularText(node.sourcePath ?? '');
    return registries.dataset.registerInlineDataset({
      name: datasetName,
      namespace,
      rows: validateRows(parseJsonRows(content, typeof node.metadata?.jsonPath === 'string' && node.metadata.jsonPath ? String(node.metadata.jsonPath) : undefined)),
    });
  }

  if (node.capabilityId === 'xml-file') {
    const content = await readTabularText(node.sourcePath ?? '');
    return registries.dataset.registerInlineDataset({
      name: datasetName,
      namespace,
      rows: validateRows(parseXmlRows(content)),
    });
  }

  if (node.capabilityId === 'excel-sheet') {
    const XLSX = await loadXlsx();
    const workbook = XLSX.read(await readFile(node.sourcePath ?? ''), { type: 'buffer' });
    const sheetName = String(node.metadata?.sheetName ?? workbook.SheetNames[0] ?? '');
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) {
      throw new Error(`Sheet '${sheetName}' was not found.`);
    }
    const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, { defval: null }) as Array<Record<string, unknown>>;
    const rows = rawRows.map((entry: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(entry).map(([key, value]) => [
          key,
          value == null ? null : typeof value === 'number' || typeof value === 'boolean' ? value : String(value),
        ]),
      ) as Record<string, CellValue>,
    );
    return registries.dataset.registerInlineDataset({
      name: datasetName,
      namespace,
      rows: validateRows(rows),
    });
  }

  if (node.capabilityId === 'sqlite-table') {
    return registerCompleteDatabaseSnapshot(registries, {
      name: datasetName,
      namespace,
      connectorId: 'sqlite',
      mode: 'materialized',
      source: {
        filePath: node.sourcePath ?? '',
        table: String(node.metadata?.table ?? ''),
      },
    });
  }

  if (node.capabilityId === 'sql-dump-table' || node.capabilityId === 'aip-inline' || node.capabilityId === 'plugin-inline') {
    const artifactPath = typeof node.metadata?.artifactPath === 'string' ? node.metadata.artifactPath : '';
    if (!artifactPath) {
      throw new Error('Recovered rows artifact is missing.');
    }
    return registries.dataset.registerInlineDataset({
      name: datasetName,
      namespace,
      rows: await readRowsArtifact(artifactPath),
    });
  }

  if (node.capabilityId === 'db-connector') {
    const connectorId = runtimeConnectorId(String(node.config.connectorId ?? ''));
    const connector = builtinDatabaseConnectors.find((entry) => entry.id === connectorId);
    if (!connector) {
      throw new Error(`Connector '${connectorId}' is not supported.`);
    }
    const sourceKeys = new Set([
      ...connector.configFields.filter((field) => field.key !== 'columns').map((field) => field.key),
      ...dbDiscoveryFields(connectorId).map((field) => field.key),
    ]);
    const source = Object.fromEntries(
      [...sourceKeys]
        .map((key) => [key, node.config[key]])
        .filter(([, value]) => value != null && String(value).trim().length > 0),
    );

    return registerCompleteDatabaseSnapshot(registries, {
      name: datasetName,
      namespace,
      connectorId,
      mode: 'materialized',
      source,
    });
  }

  return null;
}

async function registerCompleteDatabaseSnapshot(
  registries: AppRegistries,
  input: Parameters<AppRegistries['dataset']['registerDataset']>[0],
) {
  // Source registration is temporary. Historical evidence must not query a
  // changing database again when the imported dataset is opened later.
  const probe = await registries.dataset.registerDataset({ ...input,
    name: randomUUID(), namespace: 'import-verification', mode: 'virtual' });
  let rows: Array<Record<string, CellValue>>;
  try {
    const result = await registries.dataset.previewRows(probe.id, EXECUTION_PROFILE.maxRows + 1);
    if (result.truncated || result.rows.length !== result.rowCount) {
      throw new Error('Database source exceeds the complete snapshot limit.');
    }
    rows = validateRows(result.rows);
  } finally { await registries.dataset.deleteDataset(probe.id); }
  return registries.dataset.registerInlineDataset({ name: input.name, namespace: input.namespace, rows });
}

async function verifyRegisteredImport(
  node: ImportTreeNode,
  datasetId: string,
  registries: AppRegistries,
): Promise<void> {
  const preview = await registries.dataset.previewRows(datasetId, EXECUTION_PROFILE.maxRows + 1);
  const rows = validateRows(preview.rows);
  if (preview.truncated || preview.rowCount !== rows.length) {
    throw new Error('Registered import is incomplete; capability remains unresolved.');
  }
  if (node.metadata?.executionReceipt || node.metadata?.aipStrategy === 'javascript') {
    if (node.config.expectedRows === undefined || typeof node.config.requiredColumns !== 'string') {
      throw new Error('Generated parser requires an independently confirmed row count and field contract.');
    }
    const columns = node.config.requiredColumns.split(',').map((entry) => entry.trim()).filter(Boolean);
    if (columns.length === 0 || new Set(columns).size !== columns.length
      || rows.some((row) => columns.some((column) => !Object.hasOwn(row, column)))) {
      throw new Error('Generated parser output does not satisfy the confirmed field contract.');
    }
  }
  const artifactPath = node.metadata?.artifactPath;
  if (typeof artifactPath === 'string') {
    const expected = await readRowsArtifact(artifactPath);
    if (rowsHash(expected) !== rowsHash(rows)) throw new Error('Registered dataset does not match the verified rows artifact.');
  }
  if (node.config.expectedRows !== undefined) {
    const expectedRows = Number(node.config.expectedRows);
    if (!Number.isSafeInteger(expectedRows) || expectedRows < 0 || expectedRows !== rows.length) {
      throw new Error('Imported row count does not match the confirmed input contract.');
    }
  }
  if (node.config.expectedRowsHash !== undefined && String(node.config.expectedRowsHash) !== rowsHash(rows)) {
    throw new Error('Imported content does not match the independent expected result.');
  }
  const hash = rowsHash(rows);
  node.metadata = {
    ...node.metadata,
    importVerification: { datasetId, rows: rows.length, hash, coverage: 'complete', verifiedAt: nowIso() },
  };
}

async function activateVerifiedPlugins(session: ImportSessionState): Promise<void> {
  const groups = new Map<string, ImportTreeNode[]>();
  for (const node of Object.values(session.nodes)) {
    const { pluginId, pluginHash } = node.metadata ?? {};
    if (typeof pluginId !== 'string' || typeof pluginHash !== 'string') continue;
    const key = `${pluginId}:${pluginHash}`;
    groups.set(key, [...(groups.get(key) ?? []), node]);
  }
  for (const nodes of groups.values()) {
    // A multi-entity candidate becomes reusable only after every entity passed.
    if (!nodes.every((node) => node.status === 'imported' && !!node.metadata?.importVerification)) continue;
    const { pluginId, pluginHash } = nodes[0]!.metadata!;
    if (nodes.every((node) => node.metadata?.activatedPluginHash === pluginHash)) continue;
    const previous = (await pluginStore.listActive()).find((entry) => entry.plugin.id === pluginId);
    let switched = false;
    try {
      const definition = await pluginStore.read(String(pluginHash));
      await pluginStore.activate(String(pluginId), String(pluginHash));
      switched = previous?.hash !== pluginHash;
      if (definition.strategy.type === 'javascript') {
        for (const node of nodes) {
          if (!node.sourcePath) throw new Error('Reload source missing.');
          const reloaded = await executeImportParser(definition.strategy.code, await readTabularText(node.sourcePath));
          const expected = await readRowsArtifact(String(node.metadata?.artifactPath));
          if (rowsHash(reloaded.rows) !== rowsHash(expected)) throw new Error('Reload changed verified output.');
          node.metadata = { ...node.metadata, reloadReceipt: { ...reloaded.receipt, sessionId: session.id, nodeId: node.id, moduleHash: pluginHash } };
          addLog(session, 'info', `Reloaded ${pluginHash} in execution ${reloaded.receipt.executionId}; continued verified import.`, node.id);
        }
      }
      await pluginStore.recordUse(String(pluginId), String(pluginHash));
      for (const node of nodes) node.metadata = { ...node.metadata, pluginActivationError: undefined, activatedPluginHash: pluginHash };
      addLog(session, 'info', `Activated verified plugin '${pluginId}' at ${pluginHash}.`);
    } catch {
      if (switched) {
        try {
          if (previous) await pluginStore.rollback(String(pluginId));
          else await pluginStore.deactivate(String(pluginId), String(pluginHash));
        } catch {
          addLog(session, 'error', `Could not restore the activation state for '${pluginId}'; inspect capability storage before retrying.`);
        }
      }
      for (const node of nodes) {
        node.metadata = { ...node.metadata, pluginActivationError: true };
        node.diagnostics = dedupeStrings([...node.diagnostics, 'Plugin activation is pending; registered data was retained.']);
      }
      addLog(session, 'error', `Plugin '${pluginId}' activation failed; imported data retained, retry activation with run.`);
    }
  }
}

function computeSummary(session: ImportSessionState) {
  const nodes = Object.values(session.nodes);
  return {
    totalNodes: nodes.length,
    importableNodes: nodes.filter((node) => node.capabilityId).length,
    importedNodes: nodes.filter((node) => node.status === 'imported').length,
    failedNodes: nodes.filter((node) => node.status === 'failed').length,
  };
}

type ImportSessionPayload = ImportSessionState & {
  summary: ReturnType<typeof computeSummary>;
  capabilityCatalog: ImportCapabilityRecord[];
};

async function buildSessionPayload(
  session: ImportSessionState,
  capabilityCatalog?: ImportCapabilityRecord[],
): Promise<ImportSessionPayload> {
  return {
    ...session,
    generation: session.generation ?? emptyGenerationAudit(),
    summary: computeSummary(session),
    capabilityCatalog: capabilityCatalog ?? await loadCapabilityCatalog(),
  };
}

export async function registerImportSessionRoutes(app: FastifyInstance, registries: AppRegistries): Promise<void> {
  const { guard } = createSessionGuard(registries.security);
  // Serialize mutation of import sessions/registries in this API process. A read
  // remains non-mutating and can observe the last atomically saved session.
  let mutationTail = Promise.resolve();
  const releases = new WeakMap<object, () => void>();
  app.addHook('preHandler', async (request) => {
    if (request.method !== 'POST' || !request.url.startsWith('/api/import/sessions')) return;
    const previous = mutationTail;
    mutationTail = new Promise<void>((resolve) => { releases.set(request, resolve); });
    await previous;
  });
  app.addHook('onResponse', async (request) => { releases.get(request)?.(); releases.delete(request); });
  app.addHook('onError', async (request) => { releases.get(request)?.(); releases.delete(request); });

  app.post('/api/import/sessions', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.manage']))) return reply;

    const files: Array<{ filename: string; buffer: Buffer }> = [];
    try {
      const parts = request.parts({ limits: { fileSize: EXECUTION_PROFILE.maxInputBytes, files: 8, parts: 8, fields: 0 } });

      for await (const part of parts) {
        if (part.type === 'file' && part.toBuffer) {
          if (files.length >= 8) throw new Error('Import supports at most eight files per session.');
          const buffer = await part.toBuffer();
          if (buffer.length > EXECUTION_PROFILE.maxInputBytes) throw new Error('Import source exceeds 10 MiB.');
          files.push({
            filename: sanitizeFileName(part.filename ?? `upload_${files.length + 1}`),
            buffer,
          });
        }
      }
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : 'Multipart parsing failed.' };
    }

    if (files.length === 0) {
      reply.code(400);
      return { error: 'At least one file is required.' };
    }

    const sessionId = randomUUID();
    const rootPath = join(importSessionsRoot, sessionId);
    const stagingDir = join(rootPath, 'staging');
    const session = createSessionState(sessionId, rootPath);

    try {
      await mkdir(stagingDir, { recursive: true, mode: 0o700 });

      for (const file of files) {
        const targetPath = await ensureUniquePath(stagingDir, file.filename);
        await writeFile(targetPath, file.buffer, { mode: 0o600 });
        addLog(session, 'info', `Staged ${basename(targetPath)}.`);
      }

      const stagedEntries = await readdir(stagingDir);
      for (const entry of stagedEntries.sort()) {
        await discoverPath(session, null, join(stagingDir, entry), 0);
      }
      await applyGeneratedPluginsToOpenGaps(session);

      session.status = 'discovered';
      addLog(session, 'info', `Discovery completed for ${files.length} input file(s).`);
      const capabilityCatalog = await syncGaps(session);
      recomputeSessionStatus(session);
      await writeSession(session);

      return { session: await buildSessionPayload(session, capabilityCatalog) };
    } catch (error) {
      await rm(rootPath, { recursive: true, force: true });
      throw error;
    }
  });

  app.get('/api/import/sessions/:id', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.read']))) return reply;
    const session = await readSession((request.params as { id: string }).id);
    if (!session) {
      reply.code(404);
      return { error: 'Import session not found.' };
    }
    // Reading a session must never execute repair tasks with only datasets.read.
    const capabilityCatalog = await syncGaps(session);
    recomputeSessionStatus(session);
    return { session: await buildSessionPayload(session, capabilityCatalog) };
  });

  app.post('/api/import/sessions/:id/select', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.manage']))) return reply;
    const session = await readSession((request.params as { id: string }).id);
    if (!session) {
      reply.code(404);
      return { error: 'Import session not found.' };
    }
    const body = request.body as { selectedNodeIds?: string[] };
    applySelection(session, Array.isArray(body.selectedNodeIds) ? body.selectedNodeIds.filter((entry) => typeof entry === 'string') : []);
    const capabilityCatalog = await syncGaps(session);
    recomputeSessionStatus(session);
    await writeSession(session);
    return { session: await buildSessionPayload(session, capabilityCatalog) };
  });

  app.post('/api/import/sessions/:id/nodes/:nodeId/configure', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.manage']))) return reply;
    const params = request.params as { id: string; nodeId: string };
    const session = await readSession(params.id);
    if (!session) {
      reply.code(404);
      return { error: 'Import session not found.' };
    }
    const node = session.nodes[params.nodeId];
    if (!node) {
      reply.code(404);
      return { error: 'Import node not found.' };
    }
    if (node.importedDatasetId) {
      reply.code(409);
      return { error: 'An imported source is immutable; create a new session for changed inputs or mappings.' };
    }

    const values = (request.body as { values?: Record<string, string | number | boolean> }).values ?? {};
    node.config = {
      ...node.config,
      ...Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)),
    };

    if (node.kind === 'db-connection') {
      refreshDbConnectionNode(node);
    } else if (node.inputForm) {
      node.status = requiredFieldsMissing(node) ? 'needs_input' : node.capabilityId ? 'ready' : node.status;
    }

    session.updatedAt = nowIso();
    const capabilityCatalog = await syncGaps(session);
    recomputeSessionStatus(session);
    await writeSession(session);
    return { session: await buildSessionPayload(session, capabilityCatalog), node };
  });

  app.post('/api/import/sessions/:id/run', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.manage']))) return reply;
    const session = await readSession((request.params as { id: string }).id);
    if (!session) {
      reply.code(404);
      return { error: 'Import session not found.' };
    }

    const body = request.body as { selectedNodeIds?: string[] } | undefined;
    if (body?.selectedNodeIds) {
      applySelection(session, body.selectedNodeIds);
    }

    session.status = 'running';
    const importedDatasets: unknown[] = [];
    const selected = new Set(session.selectedNodeIds);
    const importableNodes = Object.values(session.nodes)
      .filter((node) => selected.has(node.id) && node.capabilityId && node.children.length === 0 && node.status !== 'imported')
      .sort((left, right) => left.label.localeCompare(right.label));

    for (const node of importableNodes) {
      if (node.inputForm && requiredFieldsMissing(node)) {
        node.status = 'needs_input';
        addLog(session, 'warning', `Node '${node.label}' still needs input.`, node.id);
        continue;
      }

      try {
        node.status = 'importing';
        const dataset = await importNode(session, node, registries);
        if (dataset) {
          try {
            await verifyRegisteredImport(node, dataset.id, registries);
          } catch (error) {
            await registries.dataset.deleteDataset(dataset.id);
            node.metadata = { ...node.metadata, importVerification: undefined };
            throw error;
          }
          node.status = 'imported';
          node.importedDatasetId = dataset.id;
          importedDatasets.push(dataset);
          addLog(session, 'info', `Imported ${node.label} as dataset '${dataset.id}'.`, node.id);
        } else {
          node.status = 'gap';
          addLog(session, 'warning', `No importer was available for ${node.label}.`, node.id);
        }
      } catch (error) {
        node.status = 'failed';
        node.diagnostics = [...node.diagnostics, error instanceof Error ? error.message : 'Import failed.'];
        addLog(session, 'error', `Import failed for ${node.label}: ${error instanceof Error ? error.message : 'unknown error'}.`, node.id);
      }
    }

    await activateVerifiedPlugins(session);
    const capabilityCatalog = await syncGaps(session);
    recomputeSessionStatus(session);
    await writeSession(session);
    return {
      session: await buildSessionPayload(session, capabilityCatalog),
      importedDatasets,
    };
  });

  app.post('/api/import/sessions/:id/repair', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.manage']))) return reply;
    const session = await readSession((request.params as { id: string }).id);
    if (!session) {
      reply.code(404);
      return { error: 'Import session not found.' };
    }
    await processRunningExecutionTasks(session);

    const body = request.body as { nodeIds?: string[] } | undefined;
    const defaultRepairableNodeIds = session.gaps
      .filter((gap) => gap.status === 'open' && gap.bestKnownNextAction !== 'ask_user_input')
      .map((gap) => gap.nodeId);
    const targetIds = new Set(body?.nodeIds?.filter((entry) => typeof entry === 'string') ?? defaultRepairableNodeIds);
    const repairedNodeIds: string[] = [];
    const unresolvedNodeIds: string[] = [];

    if (targetIds.size === 0) {
      const refreshedCapabilityCatalog = await syncGaps(session);
      recomputeSessionStatus(session);
      await writeSession(session);
      return {
        session: await buildSessionPayload(session, refreshedCapabilityCatalog),
        repairedNodeIds,
        unresolvedNodeIds,
      };
    }

    for (const nodeId of targetIds) {
      const result = await attemptRepairNode(session, nodeId, registries);
      if (result.repaired) {
        repairedNodeIds.push(nodeId);
      } else if (result.unresolved) {
        unresolvedNodeIds.push(nodeId);
      }
    }

    await processRunningExecutionTasks(session);
    const autoContinued = await autoContinueCompletedTasks(session, registries);
    await processRunningExecutionTasks(session);
    for (const nodeId of autoContinued.repairedNodeIds) {
      if (!repairedNodeIds.includes(nodeId)) repairedNodeIds.push(nodeId);
    }
    for (const nodeId of autoContinued.unresolvedNodeIds) {
      if (!unresolvedNodeIds.includes(nodeId) && !repairedNodeIds.includes(nodeId)) unresolvedNodeIds.push(nodeId);
    }

    const hotReloadedNodeIds = await applyGeneratedPluginsToOpenGaps(session);
    for (const nodeId of hotReloadedNodeIds) {
      if (!repairedNodeIds.includes(nodeId)) {
        repairedNodeIds.push(nodeId);
      }
    }

    const refreshedCapabilityCatalog = await syncGaps(session);
    recomputeSessionStatus(session);
    await writeSession(session);

    return {
      session: await buildSessionPayload(session, refreshedCapabilityCatalog),
      repairedNodeIds,
      unresolvedNodeIds,
    };
  });

  app.delete('/api/import/sessions/:id', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.manage']))) return reply;
    const sessionId = (request.params as { id: string }).id;
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return reply.code(400).send({ error: 'Invalid session id.' });
    const rootPath = join(importSessionsRoot, sessionId);
    await rm(rootPath, { recursive: true, force: true });
    reply.code(204);
    return;
  });
}
