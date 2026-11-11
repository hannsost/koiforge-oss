import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { callProvider, withSystemMessage, type AipMessage } from '@koiforge/aip-core';
import {
  deriveColumns,
  runSteps,
  suggestPipelineSteps,
  type CreatePipelineInput,
  type PipelineRun,
  type PipelineStep,
} from '@koiforge/pipeline-core';
import type { FieldMeta } from '@koiforge/pipeline-core';
import type { DatasetRecord } from '@koiforge/data-registry';

import type { AppRegistries } from '../registries.js';
import { createSessionGuard } from './_guard.js';

interface PipelinePreviewBody {
  inputDatasetId: string;
  steps?: CreatePipelineInput['steps'];
  limit?: number;
}

interface CrosswalkHint {
  id: string;
  leftDatasetId: string;
  leftColumn: string;
  rightDatasetId: string;
  rightColumn: string;
  coverage: number;
  confidence: number;
  mappings: Array<{
    leftValue: string;
    rightValue: string | null;
    canonicalValue: string | null;
    status: string;
    confidence: number;
  }>;
}

interface PipelineGluePlanBody {
  inputDatasetId: string;
  secondaryDatasetIds?: string[];
  currentSteps?: CreatePipelineInput['steps'];
  intent?: string;
  outputNamespace?: string;
  outputName?: string;
  maxAttempts?: number;
  crosswalkHints?: CrosswalkHint[];
}

type GluePlannerDatasetContext = {
  id: string;
  name: string;
  namespace: string;
  connectorId: string;
  mode: string;
  schema: Array<{ name: string; type: string; nullable: boolean }>;
  sampleRows: Array<Record<string, string | number | boolean | null>>;
};

type GluePlannerBridgeHint = {
  fromDatasetId: string;
  fromField: string;
  toDatasetId: string;
  toField: string;
  reason: string;
  score: number;
};

interface GlueAuxiliaryDatasetDraft {
  tempId: string;
  name: string;
  namespace: string;
  description?: string;
  connectorId: string;
  mode: 'virtual' | 'materialized';
  source?: Record<string, unknown>;
  rows?: Array<Record<string, string | number | boolean | null>>;
}

interface GluePlanDraft {
  title: string;
  summary: string;
  explanation: string;
  confidence: 'high' | 'medium' | 'low';
  outputNamespace?: string;
  outputName?: string;
  auxiliaryDatasets: GlueAuxiliaryDatasetDraft[];
  steps: PipelineStep[];
}

interface GluePlanAttempt {
  attempt: number;
  title: string;
  summary: string;
  explanation: string;
  confidence: 'high' | 'medium' | 'low';
  auxiliaryDatasets: GlueAuxiliaryDatasetDraft[];
  steps: PipelineStep[];
  diagnostics: {
    rowsIn: number;
    rowsOut: number;
    changedRows: number;
    newColumns: string[];
    warning: string | null;
  } | null;
  issues: string[];
}

function serializeRow(
  row: Record<string, string | number | boolean | null>,
  columns: string[],
): string {
  return JSON.stringify(columns.map((column) => row[column] ?? null));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeSlug(value: string, fallback: string): string {
  const slug = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || fallback;
}

function normalizeRelationToken(value: string): string {
  const base = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  if (base.endsWith('id') && base.length > 2) return base.slice(0, -2);
  return base;
}

function areFieldTypesCompatible(leftType: string, rightType: string): boolean {
  if (leftType === rightType) return true;
  const numeric = new Set(['integer', 'number']);
  return numeric.has(leftType) && numeric.has(rightType);
}

function isNoisyRelationField(fieldName: string): boolean {
  return ['last_update', 'updated_at', 'created_at', 'created_on', 'modified_at'].includes(
    fieldName.trim().toLowerCase(),
  );
}

function isGeneratedGlueNamespace(namespace: string): boolean {
  return ['crosswalk', 'glue', 'derived'].includes(namespace);
}


function buildGluePlannerBridgeHints(
  allDatasets: DatasetRecord[],
  inputDatasetId: string,
  secondaryDatasetIds: string[],
): GluePlannerBridgeHint[] {
  const focusIds = new Set([inputDatasetId, ...secondaryDatasetIds]);
  const byId = new Map(allDatasets.map((dataset) => [dataset.id, dataset]));
  const hints: GluePlannerBridgeHint[] = [];

  for (const fromDatasetId of focusIds) {
    const fromDataset = byId.get(fromDatasetId);
    if (!fromDataset) continue;

    for (const toDataset of allDatasets) {
      if (toDataset.id === fromDataset.id) continue;
      if (!focusIds.has(toDataset.id) && isGeneratedGlueNamespace(toDataset.namespace)) continue;

      for (const fromField of fromDataset.schema) {
        if (isNoisyRelationField(fromField.name)) continue;
        for (const toField of toDataset.schema) {
          if (isNoisyRelationField(toField.name)) continue;
          let score = 0;
          const reasons: string[] = [];
          const fromName = fromField.name.trim().toLowerCase();
          const toName = toField.name.trim().toLowerCase();
          const fromToken = normalizeRelationToken(fromField.name);
          const toToken = normalizeRelationToken(toField.name);
          const toDatasetToken = normalizeRelationToken(toDataset.name);

          if (fromName === toName && areFieldTypesCompatible(fromField.type, toField.type)) {
            score += 9;
            reasons.push(`shared field '${fromField.name}'`);
          }

          if (fromToken && fromToken === toToken && areFieldTypesCompatible(fromField.type, toField.type)) {
            score += 6;
            reasons.push(`normalized field token '${fromToken}'`);
          }

          if (
            fromName.endsWith('_id')
            && fromToken
            && fromToken === toDatasetToken
            && areFieldTypesCompatible(fromField.type, toField.type)
          ) {
            score += 10;
            reasons.push(`FK-like field '${fromField.name}' points to dataset '${toDataset.namespace}/${toDataset.name}'`);
          }

          if (fromDataset.namespace === toDataset.namespace) {
            score += 3;
            reasons.push(`same namespace '${fromDataset.namespace}'`);
          }

          if (score < 10) continue;

          hints.push({
            fromDatasetId: fromDataset.id,
            fromField: fromField.name,
            toDatasetId: toDataset.id,
            toField: toField.name,
            reason: [...new Set(reasons)].join('; '),
            score,
          });
        }
      }
    }
  }

  return hints
    .sort((left, right) => right.score - left.score || left.toDatasetId.localeCompare(right.toDatasetId))
    .slice(0, 40);
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  const firstBrace = stripped.indexOf('{');
  const lastBrace = stripped.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;
  try {
    const parsed = JSON.parse(stripped.slice(firstBrace, lastBrace + 1)) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseDeriveExpression(value: unknown): Extract<PipelineStep, { type: 'derive' }>['expression'] | null {
  if (!isRecord(value) || typeof value.op !== 'string') return null;

  if (value.op === 'copy') {
    return typeof value.column === 'string' && value.column
      ? { op: 'copy', column: value.column }
      : null;
  }

  if (value.op === 'literal') {
    if (
      value.value !== null
      && typeof value.value !== 'string'
      && typeof value.value !== 'number'
      && typeof value.value !== 'boolean'
    ) {
      return null;
    }
    return { op: 'literal', value: value.value };
  }

  if (value.op === 'coalesce') {
    if (!Array.isArray(value.columns) || !value.columns.every((column) => typeof column === 'string' && column)) {
      return null;
    }
    if (
      value.fallback !== undefined
      && value.fallback !== null
      && typeof value.fallback !== 'string'
      && typeof value.fallback !== 'number'
      && typeof value.fallback !== 'boolean'
    ) {
      return null;
    }
    return {
      op: 'coalesce',
      columns: value.columns,
      fallback: value.fallback as string | number | boolean | null | undefined,
    };
  }

  return null;
}

function parsePipelineStep(value: unknown): PipelineStep | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;

  if (value.type === 'filter') {
    if (typeof value.column !== 'string' || !value.column) return null;
    const operator = value.operator;
    if (
      operator !== 'eq'
      && operator !== 'neq'
      && operator !== 'gt'
      && operator !== 'lt'
      && operator !== 'gte'
      && operator !== 'lte'
      && operator !== 'contains'
      && operator !== 'not_null'
      && operator !== 'is_null'
    ) {
      return null;
    }
    return {
      type: 'filter',
      column: value.column,
      operator,
      value: typeof value.value === 'string' ? value.value : undefined,
    };
  }

  if (value.type === 'select') {
    return Array.isArray(value.columns) && value.columns.every((column) => typeof column === 'string' && column)
      ? { type: 'select', columns: value.columns }
      : null;
  }

  if (value.type === 'rename') {
    return typeof value.from === 'string'
      && value.from
      && typeof value.to === 'string'
      && value.to
      ? { type: 'rename', from: value.from, to: value.to }
      : null;
  }

  if (value.type === 'derive') {
    const expression = parseDeriveExpression(value.expression);
    return typeof value.column === 'string' && value.column && expression
      ? { type: 'derive', column: value.column, expression }
      : null;
  }

  if (value.type === 'aggregate') {
    if (!Array.isArray(value.groupBy) || !value.groupBy.every((column) => typeof column === 'string' && column)) {
      return null;
    }
    if (!Array.isArray(value.aggregations) || value.aggregations.length === 0) return null;
    const aggregations = value.aggregations.map((entry) => {
      if (!isRecord(entry) || typeof entry.column !== 'string' || !entry.column || typeof entry.outputName !== 'string' || !entry.outputName) {
        return null;
      }
      const fn = entry.fn;
      return fn === 'count' || fn === 'sum' || fn === 'avg' || fn === 'min' || fn === 'max'
        ? { column: entry.column, fn, outputName: entry.outputName }
        : null;
    });
    if (aggregations.some((entry) => entry === null)) return null;
    return { type: 'aggregate', groupBy: value.groupBy, aggregations: aggregations as Extract<PipelineStep, { type: 'aggregate' }>['aggregations'] };
  }

  if (value.type === 'distinct') {
    if (
      value.columns !== undefined
      && (!Array.isArray(value.columns) || !value.columns.every((column) => typeof column === 'string' && column))
    ) {
      return null;
    }
    return { type: 'distinct', columns: value.columns as string[] | undefined };
  }

  if (value.type === 'join') {
    return typeof value.rightDatasetId === 'string'
      && value.rightDatasetId
      && typeof value.leftKey === 'string'
      && value.leftKey
      && typeof value.rightKey === 'string'
      && value.rightKey
      && (value.mode === 'inner' || value.mode === 'left')
      ? {
        type: 'join',
        rightDatasetId: value.rightDatasetId,
        leftKey: value.leftKey,
        rightKey: value.rightKey,
        mode: value.mode,
      }
      : null;
  }

  return null;
}

function parseGlueAuxiliaryDataset(value: unknown): GlueAuxiliaryDatasetDraft | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.tempId !== 'string'
    || !value.tempId
    || typeof value.name !== 'string'
    || !value.name
    || typeof value.namespace !== 'string'
    || !value.namespace
    || typeof value.connectorId !== 'string'
    || !value.connectorId
    || (value.mode !== 'virtual' && value.mode !== 'materialized')
  ) {
    return null;
  }

  if (value.rows !== undefined) {
    if (!Array.isArray(value.rows) || !value.rows.every((row) => isRecord(row))) {
      return null;
    }
  }

  if (value.source !== undefined && !isRecord(value.source)) {
    return null;
  }

  return {
    tempId: value.tempId,
    name: value.name,
    namespace: value.namespace,
    description: typeof value.description === 'string' ? value.description : undefined,
    connectorId: value.connectorId,
    mode: value.mode,
    source: value.source as Record<string, unknown> | undefined,
    rows: value.rows as Array<Record<string, string | number | boolean | null>> | undefined,
  };
}

function parseGluePlanDraft(rawContent: string): GluePlanDraft | null {
  const parsed = parseJsonObject(rawContent);
  if (!parsed) return null;

  if (
    typeof parsed.title !== 'string'
    || !parsed.title.trim()
    || typeof parsed.summary !== 'string'
    || !parsed.summary.trim()
    || typeof parsed.explanation !== 'string'
    || !parsed.explanation.trim()
    || (parsed.confidence !== 'high' && parsed.confidence !== 'medium' && parsed.confidence !== 'low')
    || !Array.isArray(parsed.steps)
  ) {
    return null;
  }

  const steps = parsed.steps.map(parsePipelineStep);
  if (steps.some((step) => step === null)) return null;

  const auxiliaryDatasets = Array.isArray(parsed.auxiliaryDatasets)
    ? parsed.auxiliaryDatasets.map(parseGlueAuxiliaryDataset)
    : [];
  if (auxiliaryDatasets.some((dataset) => dataset === null)) return null;

  return {
    title: parsed.title,
    summary: parsed.summary,
    explanation: parsed.explanation,
    confidence: parsed.confidence,
    outputNamespace: typeof parsed.outputNamespace === 'string' ? parsed.outputNamespace : undefined,
    outputName: typeof parsed.outputName === 'string' ? parsed.outputName : undefined,
    auxiliaryDatasets: auxiliaryDatasets as GlueAuxiliaryDatasetDraft[],
    steps: steps as PipelineStep[],
  };
}

function inferSchemaFromRows(rows: Array<Record<string, string | number | boolean | null>>): Array<{ name: string; type: FieldMeta['type']; nullable: boolean }> {
  const sample = rows[0] ?? {};
  return Object.keys(sample).map((name) => {
    const value = sample[name];
    const type: FieldMeta['type'] = typeof value === 'number'
      ? Number.isInteger(value)
        ? 'integer'
        : 'number'
      : typeof value === 'boolean'
        ? 'boolean'
        : 'string';
    return { name, type, nullable: true };
  });
}

async function buildGlueDatasetCatalog(
  registries: AppRegistries,
  auxiliaryDatasets: GlueAuxiliaryDatasetDraft[],
): Promise<{
  datasetMap: Map<string, DatasetRecord>;
  auxiliaryRows: Map<string, Array<Record<string, string | number | boolean | null>>>;
  issues: string[];
}> {
  const datasetMap = new Map((await registries.dataset.listDatasets()).map((dataset) => [dataset.id, dataset]));
  const auxiliaryRows = new Map<string, Array<Record<string, string | number | boolean | null>>>();
  const issues: string[] = [];

  for (const dataset of auxiliaryDatasets) {
    if (datasetMap.has(dataset.tempId)) {
      issues.push(`Auxiliary dataset tempId '${dataset.tempId}' kollidiert mit einem existierenden Dataset.`);
      continue;
    }

    const rows = dataset.rows ?? [];
    let schema = inferSchemaFromRows(rows);

    if (schema.length === 0 && dataset.connectorId !== 'inline' && dataset.source) {
      try {
        const discovery = registries.dataset.discoverSchema(dataset.connectorId, dataset.source);
        schema = discovery.fields.map((field) => ({
          name: field.name,
          type: field.type as FieldMeta['type'],
          nullable: field.nullable !== false,
        }));
      } catch (error) {
        issues.push(`Auxiliary dataset '${dataset.tempId}' schema discovery failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }

    if (schema.length === 0) {
      issues.push(`Auxiliary dataset '${dataset.tempId}' hat kein ableitbares Schema.`);
      continue;
    }

    const now = new Date().toISOString();
    datasetMap.set(dataset.tempId, {
      id: dataset.tempId,
      name: dataset.name,
      namespace: dataset.namespace,
      description: dataset.description,
      connectorId: dataset.connectorId,
      connectorCategory: dataset.connectorId === 'postgres' || dataset.connectorId === 'sqlite'
        ? 'database'
        : 'file',
      mode: dataset.mode,
      status: 'ready',
      source: dataset.source ?? { previewRows: rows },
      schema,
      sqlAccess: {
        catalog: 'koiforge',
        schema: normalizeSlug(dataset.namespace, 'derived'),
        table: normalizeSlug(dataset.name, dataset.tempId),
        queryPreview: `select * from ${normalizeSlug(dataset.namespace, 'derived')}.${normalizeSlug(dataset.name, dataset.tempId)} limit 25`,
      },
      snapshots: [],
      tags: ['glue-temp'],
      createdAt: now,
      updatedAt: now,
    });
    auxiliaryRows.set(dataset.tempId, rows);
  }

  return { datasetMap, auxiliaryRows, issues };
}

function nextColumnsForStep(
  currentColumns: Map<string, FieldMeta['type']>,
  step: PipelineStep,
  datasetMap: Map<string, DatasetRecord>,
): Map<string, FieldMeta['type']> {
  if (step.type === 'filter' || step.type === 'distinct') {
    return new Map(currentColumns);
  }

  if (step.type === 'select') {
    return new Map(step.columns.map((column) => [column, currentColumns.get(column) ?? 'string']));
  }

  if (step.type === 'rename') {
    const nextColumns = new Map<string, FieldMeta['type']>();
    for (const [column, type] of currentColumns.entries()) {
      nextColumns.set(column === step.from && step.to ? step.to : column, type);
    }
    return nextColumns;
  }

  if (step.type === 'derive') {
    const nextColumns = new Map(currentColumns);
    if (step.expression.op === 'copy') {
      nextColumns.set(step.column, currentColumns.get(step.expression.column) ?? 'string');
    } else if (step.expression.op === 'literal') {
      nextColumns.set(step.column, typeof step.expression.value === 'number'
        ? 'number'
        : typeof step.expression.value === 'boolean'
          ? 'boolean'
          : 'string');
    } else {
      const sourceType = step.expression.columns
        .map((column) => currentColumns.get(column))
        .find((type): type is FieldMeta['type'] => Boolean(type));
      nextColumns.set(step.column, sourceType ?? 'string');
    }
    return nextColumns;
  }

  if (step.type === 'aggregate') {
    const nextColumns = new Map<string, FieldMeta['type']>();
    for (const column of step.groupBy) {
      nextColumns.set(column, currentColumns.get(column) ?? 'string');
    }
    for (const aggregation of step.aggregations) {
      nextColumns.set(aggregation.outputName, aggregation.fn === 'count' ? 'integer' : 'number');
    }
    return nextColumns;
  }

  const nextColumns = new Map(currentColumns);
  const rightDataset = datasetMap.get(step.rightDatasetId);
  for (const field of rightDataset?.schema ?? []) {
    if (!nextColumns.has(field.name)) {
      nextColumns.set(field.name, field.type as FieldMeta['type']);
    }
  }
  return nextColumns;
}

function validateGlueSteps(
  inputDatasetId: string,
  steps: PipelineStep[],
  datasetMap: Map<string, DatasetRecord>,
): string[] {
  const inputDataset = datasetMap.get(inputDatasetId);
  if (!inputDataset) {
    return [`Input dataset '${inputDatasetId}' wurde nicht gefunden.`];
  }

  const issues: string[] = [];
  let currentColumns = new Map(
    inputDataset.schema.map((field) => [field.name, field.type as FieldMeta['type']]),
  );

  steps.forEach((step, stepIndex) => {
    const prefix = `Step ${stepIndex + 1} (${step.type}): `;

    if (step.type === 'filter' && !currentColumns.has(step.column)) {
      issues.push(`${prefix}Spalte '${step.column}' existiert nicht im aktuellen Zwischenergebnis.`);
    }

    if (step.type === 'select') {
      for (const column of step.columns) {
        if (!currentColumns.has(column)) {
          issues.push(`${prefix}Spalte '${column}' existiert nicht im aktuellen Zwischenergebnis.`);
        }
      }
    }

    if (step.type === 'rename') {
      if (!currentColumns.has(step.from)) {
        issues.push(`${prefix}Rename-Quelle '${step.from}' existiert nicht.`);
      }
      if (step.to !== step.from && currentColumns.has(step.to)) {
        issues.push(`${prefix}Rename-Ziel '${step.to}' existiert bereits.`);
      }
    }

    if (step.type === 'derive') {
      if (currentColumns.has(step.column)) {
        issues.push(`${prefix}Derive-Ziel '${step.column}' existiert bereits.`);
      }
      if (step.expression.op === 'copy' && !currentColumns.has(step.expression.column)) {
        issues.push(`${prefix}Derive-Quelle '${step.expression.column}' existiert nicht.`);
      }
      if (step.expression.op === 'coalesce') {
        for (const column of step.expression.columns) {
          if (!currentColumns.has(column)) {
            issues.push(`${prefix}Coalesce-Spalte '${column}' existiert nicht.`);
          }
        }
      }
    }

    if (step.type === 'aggregate') {
      const outputNames = new Set<string>();
      for (const column of step.groupBy) {
        if (!currentColumns.has(column)) {
          issues.push(`${prefix}GroupBy-Spalte '${column}' existiert nicht.`);
        }
      }
      for (const aggregation of step.aggregations) {
        if (!currentColumns.has(aggregation.column)) {
          issues.push(`${prefix}Aggregation-Spalte '${aggregation.column}' existiert nicht.`);
        }
        if (outputNames.has(aggregation.outputName)) {
          issues.push(`${prefix}Aggregation-Output '${aggregation.outputName}' ist doppelt.`);
        }
        outputNames.add(aggregation.outputName);
      }
    }

    if (step.type === 'distinct' && step.columns) {
      for (const column of step.columns) {
        if (!currentColumns.has(column)) {
          issues.push(`${prefix}Distinct-Spalte '${column}' existiert nicht.`);
        }
      }
    }

    if (step.type === 'join') {
      const rightDataset = datasetMap.get(step.rightDatasetId);
      if (!currentColumns.has(step.leftKey)) {
        issues.push(`${prefix}Left key '${step.leftKey}' existiert nicht.`);
      }
      if (!rightDataset) {
        issues.push(`${prefix}Right dataset '${step.rightDatasetId}' existiert nicht.`);
      } else if (!rightDataset.schema.some((field) => field.name === step.rightKey)) {
        issues.push(`${prefix}Right key '${step.rightKey}' existiert nicht in '${step.rightDatasetId}'.`);
      }
    }

    currentColumns = nextColumnsForStep(currentColumns, step, datasetMap);
  });

  return issues;
}

async function executeGluePlanPreview(
  registries: AppRegistries,
  inputDatasetId: string,
  steps: PipelineStep[],
  auxiliaryRows: Map<string, Array<Record<string, string | number | boolean | null>>>,
  limit = 50,
): Promise<{
  preview: {
    datasetId: string;
    columns: string[];
    rows: Array<Record<string, string | number | boolean | null>>;
    rowCount: number;
    truncated: boolean;
  };
  diagnostics: GluePlanAttempt['diagnostics'];
}> {
  const inputPreview = await registries.dataset.previewRows(inputDatasetId, 2000);
  const inputRows = inputPreview.rows;
  const rightDatasetCache = new Map<string, typeof inputRows>();

  for (const [datasetId, rows] of auxiliaryRows.entries()) {
    rightDatasetCache.set(datasetId, rows);
  }

  for (const step of steps) {
    if (step.type !== 'join' || rightDatasetCache.has(step.rightDatasetId)) continue;
    const rightPreview = await registries.dataset.previewRows(step.rightDatasetId, 100_000);
    rightDatasetCache.set(step.rightDatasetId, rightPreview.rows);
  }

  const outputRows = runSteps(inputRows, steps, (datasetId) => rightDatasetCache.get(datasetId) ?? []);
  const outputColumns = deriveColumns(outputRows);
  const inputColumns = inputPreview.columns.length > 0 ? inputPreview.columns : deriveColumns(inputRows);
  const newColumns = outputColumns.filter((column) => !inputColumns.includes(column));
  const comparableColumns = Array.from(new Set([...inputColumns, ...outputColumns]));
  const comparableCount = Math.min(inputRows.length, outputRows.length);
  let changedRows = Math.abs(outputRows.length - inputRows.length);

  for (let index = 0; index < comparableCount; index += 1) {
    if (serializeRow(inputRows[index]!, comparableColumns) !== serializeRow(outputRows[index]!, comparableColumns)) {
      changedRows += 1;
    }
  }

  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 5000));
  const warning = steps.length > 0 && changedRows === 0 && newColumns.length === 0
    ? 'Dry-run erzeugt aktuell keine sichtbare Datenveraenderung.'
    : null;

  return {
    preview: {
      datasetId: `draft:${inputDatasetId}`,
      columns: outputColumns,
      rows: outputRows.slice(0, safeLimit),
      rowCount: outputRows.length,
      truncated: outputRows.length > safeLimit,
    },
    diagnostics: {
      rowsIn: inputRows.length,
      rowsOut: outputRows.length,
      changedRows,
      newColumns,
      warning,
    },
  };
}

interface GluePlannerCrosswalkContext {
  tempId: string;
  leftDatasetId: string;
  leftColumn: string;
  rightDatasetId: string;
  rightColumn: string;
  coverage: number;
  confidence: number;
}

function buildGluePlannerPrompt(input: {
  inputDatasetId: string;
  secondaryDatasetIds: string[];
  currentSteps: PipelineStep[];
  intent?: string;
  outputNamespace?: string;
  outputName?: string;
  datasets: GluePlannerDatasetContext[];
  bridgeHints: GluePlannerBridgeHint[];
  crosswalkBridges: GluePlannerCrosswalkContext[];
  attempts: GluePlanAttempt[];
}): string {
  const crosswalkSection = input.crosswalkBridges.length > 0
    ? [
      '',
      'Pre-computed crosswalk bridges (already available as auxiliaryDatasets — do NOT reinvent them):',
      ...input.crosswalkBridges.map((cw) =>
        `- tempId="${cw.tempId}" bridges ${cw.leftDatasetId}.${cw.leftColumn} -> ${cw.rightDatasetId}.${cw.rightColumn} `
        + `(coverage=${(cw.coverage * 100).toFixed(0)}%, confidence=${(cw.confidence * 100).toFixed(0)}%). `
        + `Columns: left_value, right_value, canonical_value, confidence, status. `
        + `Join pattern: LEFT JOIN ${cw.tempId} ON left.${cw.leftColumn} = ${cw.tempId}.left_value, `
        + `then LEFT JOIN ${cw.rightDatasetId} ON ${cw.tempId}.right_value = ${cw.rightDatasetId}.${cw.rightColumn}.`,
      ),
      '- These crosswalk datasets cover ALL distinct values from the source, not just the sample rows shown above.',
      '- Always prefer these pre-computed bridges over inventing your own inline bridge table for the same column pair.',
    ]
    : [];

  return [
    'You are KOIForge Glue Planner.',
    'Design a multi-step dataset glue plan that can bridge heterogeneous datasets, optionally via temporary auxiliary lookup/bridge tables and existing live virtual datasets.',
    'You are free to use multiple steps and auxiliary datasets, but the plan must be executable by KOIForge after compilation.',
    '',
    'Executable step IR:',
    '- { "type":"filter", "column":"...", "operator":"eq|neq|gt|lt|gte|lte|contains|not_null|is_null", "value"?: "..." }',
    '- { "type":"select", "columns":["..."] }',
    '- { "type":"rename", "from":"...", "to":"..." }',
    '- { "type":"derive", "column":"...", "expression": { "op":"copy", "column":"..." } | { "op":"literal", "value": "..." } | { "op":"coalesce", "columns":["..."], "fallback"?: "..." } }',
    '- { "type":"aggregate", "groupBy":["..."], "aggregations":[{ "column":"...", "fn":"count|sum|avg|min|max", "outputName":"..." }] }',
    '- { "type":"distinct", "columns"?: ["..."] }',
    '- { "type":"join", "rightDatasetId":"existing-dataset-id-or-tempId", "leftKey":"...", "rightKey":"...", "mode":"inner|left" }',
    '',
    'Auxiliary dataset IR:',
    '- { "tempId":"tmp_bridge_1", "name":"...", "namespace":"glue", "connectorId":"inline", "mode":"materialized", "rows":[{...}] }',
    '- Existing live external DB datasets already registered with mode="virtual" may be referenced directly by their dataset id.',
    '- If a required live external DB source is not registered yet, you may propose one auxiliary dataset with connectorId postgres/sqlite/mysql and mode="virtual" plus a source object, but only if you can derive concrete connection/table details from context. Otherwise prefer a temporary inline bridge table.',
    '',
    'Critical quality rule:',
    '- Before proposing external references or synthetic inline bridge tables, inspect internal datasets first.',
    '- Prefer same-namespace/source bridge paths over generated glue/crosswalk datasets if bridgeHints or sampleRows/schema indicate transitive relations.',
    '- Do not reason only pairwise between inputDatasetId and secondaryDatasetIds. Explicitly consider multi-hop paths through internal datasets, e.g. FK-like fields such as country_id -> country.',
    '- bridgeHints are precomputed internal relation candidates. Use them as your first search frontier before inventing new bridge tables.',
    '- If a bridgeHint points from an ID field to an entity table, first join that entity table, then use its descriptive/value columns as semantic material for a generated bridge to the secondary dataset when no direct key match exists.',
    '- Generic pattern: fact_table.entity_id -> entity_table.entity_id, then entity_table.descriptive_name/code -> temporary semantic bridge -> secondary_dataset.name/code/value.',
    '- Join/select/filter/rename/derive columns are unqualified raw column names after each step. Never emit dataset.column aliases in "columns", "from", "leftKey", "rightKey", or derive references.',
    '- Only reference rightDatasetId values that exist in datasets[].id or in auxiliaryDatasets[].tempId. Do not invent hidden dataset ids unless you also declare that tempId in auxiliaryDatasets.',
    '- If previous attempts show compile errors, missing columns, or a no-op dry-run, revise the plan and try a materially different multi-step strategy.',
    '- For semantic glue mismatches, prefer bridge-table joins, derive/coalesce of resolved keys, and distinct deduplication where needed.',
    '- Do not hardcode one domain. Infer everything from schemas and sampleRows.',
    '- In explanation, name the internal bridge datasets and fields you used, and why they were preferred over external lookup tables.',
    '- Output exactly one JSON object, no markdown fences, no prose.',
    ...crosswalkSection,
    '',
    'JSON shape:',
    '{',
    '  "title": "string",',
    '  "summary": "string",',
    '  "explanation": "string",',
    '  "confidence": "high|medium|low",',
    '  "outputNamespace": "string",',
    '  "outputName": "string",',
    '  "auxiliaryDatasets": [],',
    '  "steps": []',
    '}',
    '',
    `GLUE_CONTEXT:\n${JSON.stringify(input, null, 2)}`,
  ].join('\n');
}

async function buildGluePlannerDatasetContext(
  registries: AppRegistries,
  allDatasets: DatasetRecord[],
  inputDatasetId: string,
  secondaryDatasetIds: string[],
  currentSteps: PipelineStep[],
): Promise<GluePlannerDatasetContext[]> {
  const focusNamespaces = new Set(
    allDatasets
      .filter((dataset) => dataset.id === inputDatasetId || secondaryDatasetIds.includes(dataset.id))
      .map((dataset) => dataset.namespace),
  );
  const priorityIds = new Set([
    inputDatasetId,
    ...secondaryDatasetIds,
    ...currentSteps
      .filter((step): step is Extract<PipelineStep, { type: 'join' }> => step.type === 'join')
      .map((step) => step.rightDatasetId),
  ]);
  const sortedDatasets = [...allDatasets].sort((left, right) => {
    const leftPriority = priorityIds.has(left.id) ? 0 : 1;
    const rightPriority = priorityIds.has(right.id) ? 0 : 1;
    const leftSameNamespace = focusNamespaces.has(left.namespace) ? 0 : 1;
    const rightSameNamespace = focusNamespaces.has(right.namespace) ? 0 : 1;
    const leftGeneratedNamespace = ['crosswalk', 'glue', 'derived'].includes(left.namespace) ? 1 : 0;
    const rightGeneratedNamespace = ['crosswalk', 'glue', 'derived'].includes(right.namespace) ? 1 : 0;
    return leftPriority - rightPriority
      || leftSameNamespace - rightSameNamespace
      || leftGeneratedNamespace - rightGeneratedNamespace
      || left.namespace.localeCompare(right.namespace)
      || left.name.localeCompare(right.name);
  });

  return Promise.all(
    sortedDatasets
      .filter((dataset) => priorityIds.has(dataset.id) || !isGeneratedGlueNamespace(dataset.namespace))
      .slice(0, 40)
      .map(async (dataset) => {
      const isPriority = priorityIds.has(dataset.id);
      try {
        const preview = await registries.dataset.previewRows(dataset.id, isPriority ? 8 : 2);
        return {
          id: dataset.id,
          name: dataset.name,
          namespace: dataset.namespace,
          connectorId: dataset.connectorId,
          mode: dataset.mode,
          schema: dataset.schema.slice(0, 12).map((field) => ({
            name: field.name,
            type: field.type,
            nullable: field.nullable !== false,
          })),
          sampleRows: preview.rows.slice(0, isPriority ? 8 : 2).map((row) => Object.fromEntries(
            Object.entries(row).slice(0, 12),
          )),
        };
      } catch {
        return {
          id: dataset.id,
          name: dataset.name,
          namespace: dataset.namespace,
          connectorId: dataset.connectorId,
          mode: dataset.mode,
          schema: dataset.schema.slice(0, 12).map((field) => ({
            name: field.name,
            type: field.type,
            nullable: field.nullable !== false,
          })),
          sampleRows: [],
        };
      }
    }),
  );
}

export function registerPipelinesRoutes(app: FastifyInstance, registries: AppRegistries): void {
  const { guard } = createSessionGuard(registries.security);

  // List pipelines
  app.get('/api/pipelines', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.read']))) return reply;
    return { items: await registries.pipeline.listPipelines() };
  });

  // Smart suggest: analyse dataset schemas and return step suggestions.
  // This must be registered before /api/pipelines/:id so "suggest" is not parsed as an id.
  app.post<{ Body: { primaryDatasetId: string; secondaryDatasetId?: string } }>(
    '/api/pipelines/suggest',
    async (request, reply) => {
      if (!(await guard(request, reply, ['datasets.read']))) return reply;
      const { primaryDatasetId, secondaryDatasetId } = request.body ?? {};
      if (!primaryDatasetId) { reply.code(400); return { error: 'primaryDatasetId required' }; }

      const toMeta = async (datasetId: string) => {
        const ds = await registries.dataset.getDataset(datasetId);
        if (!ds) return null;
        let sampleRows: Record<string, string | number | boolean | null>[] = [];
        try {
          const preview = await registries.dataset.previewRows(datasetId, 20);
          sampleRows = preview.rows;
        } catch {
          // Suggestions still work from schema-only metadata.
        }
        return {
          id: ds.id,
          name: ds.name,
          namespace: ds.namespace,
          fields: ds.schema.map((f) => ({
            name: f.name,
            type: f.type as FieldMeta['type'],
            nullable: f.nullable,
          })),
          sampleRows,
        };
      };

      const primary = await toMeta(primaryDatasetId);
      if (!primary) { reply.code(404); return { error: `Dataset '${primaryDatasetId}' nicht gefunden.` }; }

      const secondary = secondaryDatasetId ? await toMeta(secondaryDatasetId) : undefined;
      return suggestPipelineSteps(primary, secondary ?? undefined);
    },
  );

  // Preview draft output before saving/running.
  // Keep this before /api/pipelines/:id so "preview" is not parsed as an id.
  app.post<{ Body: PipelinePreviewBody }>('/api/pipelines/preview', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.read']))) return reply;

    const { inputDatasetId, steps = [], limit = 50 } = request.body ?? {};
    if (!inputDatasetId) {
      reply.code(400);
      return { error: 'inputDatasetId required' };
    }

    const inputDataset = await registries.dataset.getDataset(inputDatasetId);
    if (!inputDataset) {
      reply.code(404);
      return { error: `Dataset '${inputDatasetId}' nicht gefunden.` };
    }

    try {
      const inputPreview = await registries.dataset.previewRows(inputDatasetId, 2000);
      const inputRows = inputPreview.rows;

      const rightDatasetCache = new Map<string, typeof inputRows>();
      for (const step of steps) {
        if (step.type !== 'join' || rightDatasetCache.has(step.rightDatasetId)) continue;
        const rightPreview = await registries.dataset.previewRows(step.rightDatasetId, 100_000);
        rightDatasetCache.set(step.rightDatasetId, rightPreview.rows);
      }

      const outputRows = runSteps(
        inputRows,
        steps,
        (datasetId) => rightDatasetCache.get(datasetId) ?? [],
      );
      const outputColumns = deriveColumns(outputRows);
      const inputColumns = inputPreview.columns.length > 0
        ? inputPreview.columns
        : deriveColumns(inputRows);
      const newColumns = outputColumns.filter((column) => !inputColumns.includes(column));
      const comparableColumns = Array.from(new Set([...inputColumns, ...outputColumns]));
      const comparableCount = Math.min(inputRows.length, outputRows.length);
      let changedRows = Math.abs(outputRows.length - inputRows.length);

      for (let index = 0; index < comparableCount; index += 1) {
        if (
          serializeRow(inputRows[index]!, comparableColumns)
          !== serializeRow(outputRows[index]!, comparableColumns)
        ) {
          changedRows += 1;
        }
      }

      const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 5000));
      const noOpWarning = steps.length > 0 && changedRows === 0 && newColumns.length === 0
        ? 'Dry-run erzeugt aktuell keine sichtbare Datenveraenderung. Join-Keys/Crosswalk-Richtung pruefen.'
        : null;

      return {
        preview: {
          datasetId: `draft:${inputDatasetId}`,
          columns: outputColumns,
          rows: outputRows.slice(0, safeLimit),
          rowCount: outputRows.length,
          truncated: outputRows.length > safeLimit,
        },
        diagnostics: {
          rowsIn: inputRows.length,
          rowsOut: outputRows.length,
          changedRows,
          newColumns,
          warning: noOpWarning,
        },
      };
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : 'Preview failed.' };
    }
  });

  // AIP Glue Planner: ask AIP for a free multi-step glue plan, compile it,
  // dry-run it, and loop diagnostics back into AIP until a useful plan emerges.
  app.post<{ Body: PipelineGluePlanBody }>('/api/pipelines/glue-plan', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.read']))) return reply;

    const {
      inputDatasetId,
      secondaryDatasetIds = [],
      currentSteps = [],
      intent,
      outputNamespace = 'derived',
      outputName = 'glue_result',
      maxAttempts = 3,
      crosswalkHints = [],
    } = request.body ?? {};

    if (!inputDatasetId) {
      reply.code(400);
      return { error: 'inputDatasetId required' };
    }

    const config = await registries.aip.getConfig();
    if (!config) {
      reply.code(400);
      return { error: 'No AIP provider configured. Set a provider via PUT /api/aip/config.' };
    }

    const inputDataset = await registries.dataset.getDataset(inputDatasetId);
    if (!inputDataset) {
      reply.code(404);
      return { error: `Dataset '${inputDatasetId}' nicht gefunden.` };
    }

    const allDatasets = await registries.dataset.listDatasets();
    const datasetContext = await buildGluePlannerDatasetContext(
      registries,
      allDatasets,
      inputDatasetId,
      secondaryDatasetIds,
      currentSteps,
    );
    const bridgeHints = buildGluePlannerBridgeHints(
      allDatasets,
      inputDatasetId,
      secondaryDatasetIds,
    );

    // Convert crosswalk proposals into pre-built auxiliary bridge datasets for the Glue Planner.
    // This feeds the full mapping table (all values, not just samples) so AIP doesn't have to reinvent it.
    const crosswalkAuxiliaryDatasets: GlueAuxiliaryDatasetDraft[] = (crosswalkHints ?? [])
      .filter((cw) => Array.isArray(cw.mappings) && cw.mappings.length > 0)
      .map((cw) => ({
        tempId: `tmp_crosswalk_${cw.id.slice(0, 8)}`,
        name: `crosswalk_${cw.leftColumn}__${cw.rightColumn}`,
        namespace: 'crosswalk',
        description: `Pre-computed crosswalk: ${cw.leftDatasetId}.${cw.leftColumn} -> ${cw.rightDatasetId}.${cw.rightColumn} (coverage ${(cw.coverage * 100).toFixed(0)}%)`,
        connectorId: 'inline',
        mode: 'materialized' as const,
        rows: cw.mappings.map((m) => ({
          left_value: m.leftValue,
          right_value: m.rightValue ?? m.canonicalValue,
          canonical_value: m.canonicalValue ?? m.rightValue,
          status: m.status,
          confidence: m.confidence,
        })),
      }));

    const crosswalkBridges: GluePlannerCrosswalkContext[] = crosswalkAuxiliaryDatasets.map((aux, index) => {
      const cw = (crosswalkHints ?? [])[index]!;
      return {
        tempId: aux.tempId,
        leftDatasetId: cw.leftDatasetId,
        leftColumn: cw.leftColumn,
        rightDatasetId: cw.rightDatasetId,
        rightColumn: cw.rightColumn,
        coverage: cw.coverage,
        confidence: cw.confidence,
      };
    });

    const attempts: GluePlanAttempt[] = [];
    const safeAttempts = Math.max(1, Math.min(Number(maxAttempts) || 3, 5));

    for (let attempt = 1; attempt <= safeAttempts; attempt += 1) {
      const prompt = buildGluePlannerPrompt({
        inputDatasetId,
        secondaryDatasetIds,
        currentSteps,
        intent,
        outputNamespace,
        outputName,
        datasets: datasetContext,
        bridgeHints,
        crosswalkBridges,
        attempts,
      });
      const messages: AipMessage[] = [{ role: 'user', content: `Plan glue pipeline attempt ${attempt}.` }];
      let response;
      try {
        response = await callProvider(config, withSystemMessage(messages, prompt), 2200);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'AIP provider request failed.';
        if (message.includes('Provider error 429') || message.includes('Rate limit')) {
          reply.code(429);
          return {
            error: 'AIP provider rate limit erreicht. Bitte Smart Suggest in wenigen Sekunden erneut ausfuehren.',
            details: message,
          };
        }

        reply.code(502);
        return {
          error: 'AIP provider request failed.',
          details: message,
        };
      }
      // Empty content = transient AIP failure (rate-limit, truncation). Retry with back-off,
      // but don't burn a plan attempt slot for it (max 2 extra retries).
      if (!response.message.content || response.message.content.trim().length === 0) {
        if (attempt < safeAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }
        // On the last slot, fall through to push a failed attempt so the loop ends.
        attempts.push({
          attempt,
          title: `Glue plan attempt ${attempt}`,
          summary: 'AIP provider returned empty response.',
          explanation: '',
          confidence: 'low',
          auxiliaryDatasets: [],
          steps: [],
          diagnostics: null,
          issues: ['AIP-Provider hat keine Antwort zurueckgegeben (Rate-Limit oder transienter Fehler). Bitte Smart Suggest erneut ausfuehren.'],
        });
        continue;
      }

      const parsed = parseGluePlanDraft(response.message.content);

      if (!parsed) {
        attempts.push({
          attempt,
          title: `Glue plan attempt ${attempt}`,
          summary: 'AIP returned non-parseable plan JSON.',
          explanation: response.message.content.slice(0, 800),
          confidence: 'low',
          auxiliaryDatasets: [],
          steps: [],
          diagnostics: null,
          issues: ['AIP Glue Plan JSON konnte nicht geparst oder nicht kompiliert werden.'],
        });
        continue;
      }

      // Merge pre-built crosswalk bridge datasets with whatever AIP proposed.
      // AIP may reference the crosswalk tempIds directly — they must be in the catalog.
      const mergedAuxiliaryDatasets = [
        ...crosswalkAuxiliaryDatasets,
        ...parsed.auxiliaryDatasets.filter((d) => !crosswalkAuxiliaryDatasets.some((cw) => cw.tempId === d.tempId)),
      ];
      const catalog = await buildGlueDatasetCatalog(registries, mergedAuxiliaryDatasets);
      const issues = [
        ...catalog.issues,
        ...validateGlueSteps(inputDatasetId, parsed.steps, catalog.datasetMap),
      ];

      let diagnostics: GluePlanAttempt['diagnostics'] = null;
      let preview = null;

      if (issues.length === 0) {
        try {
          const previewResult = await executeGluePlanPreview(
            registries,
            inputDatasetId,
            parsed.steps,
            catalog.auxiliaryRows,
            5000,
          );
          const previewDiagnostics = previewResult.diagnostics;
          diagnostics = previewDiagnostics;
          preview = previewResult.preview;
          if (previewDiagnostics?.warning) {
            issues.push(`Dry-run warning: ${previewDiagnostics.warning}`);
          }
        } catch (error) {
          issues.push(`Dry-run failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
      }

      const attemptResult: GluePlanAttempt = {
        attempt,
        title: parsed.title,
        summary: parsed.summary,
        explanation: parsed.explanation,
        confidence: parsed.confidence,
        auxiliaryDatasets: parsed.auxiliaryDatasets,
        steps: parsed.steps,
        diagnostics,
        issues,
      };
      attempts.push(attemptResult);

      if (issues.length === 0 && diagnostics && !diagnostics.warning) {
        return {
          title: parsed.title,
          summary: parsed.summary,
          explanation: parsed.explanation,
          confidence: parsed.confidence,
          outputNamespace: normalizeSlug(parsed.outputNamespace ?? outputNamespace, 'derived'),
          outputName: normalizeSlug(parsed.outputName ?? outputName, 'glue_result'),
          auxiliaryDatasets: parsed.auxiliaryDatasets,
          steps: parsed.steps,
          preview,
          diagnostics,
          attempts,
          status: 'ready',
        };
      }
    }

    const lastAttempt = attempts[attempts.length - 1];
    return {
      title: lastAttempt?.title ?? 'Glue Plan',
      summary: lastAttempt?.summary ?? 'No valid glue plan found.',
      explanation: lastAttempt?.explanation ?? 'AIP konnte in diesem Lauf keinen brauchbaren Glue-Plan kompilieren.',
      confidence: lastAttempt?.confidence ?? 'low',
      outputNamespace: normalizeSlug(outputNamespace, 'derived'),
      outputName: normalizeSlug(outputName, 'glue_result'),
      auxiliaryDatasets: lastAttempt?.auxiliaryDatasets ?? [],
      steps: lastAttempt?.steps ?? [],
      preview: null,
      diagnostics: lastAttempt?.diagnostics ?? null,
      attempts,
      status: 'needs_review',
    };
  });

  // Get single pipeline
  app.get('/api/pipelines/:id', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.read']))) return reply;
    const { id } = request.params as { id: string };
    const pipeline = await registries.pipeline.getPipeline(id);
    if (!pipeline) { reply.code(404); return { error: 'Pipeline not found.' }; }
    return pipeline;
  });

  // Create pipeline
  app.post<{ Body: CreatePipelineInput }>('/api/pipelines', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.manage']))) return reply;
    try {
      const pipeline = await registries.pipeline.createPipeline(request.body);
      reply.code(201);
      return pipeline;
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : 'Create failed.' };
    }
  });

  // Update pipeline
  app.put<{ Body: Partial<CreatePipelineInput> }>('/api/pipelines/:id', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.manage']))) return reply;
    const { id } = request.params as { id: string };
    try {
      return await registries.pipeline.updatePipeline(id, request.body);
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : 'Update failed.' };
    }
  });

  // Delete pipeline
  app.delete('/api/pipelines/:id', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.manage']))) return reply;
    const { id } = request.params as { id: string };
    try {
      await registries.pipeline.deletePipeline(id);
      reply.code(204);
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : 'Delete failed.' };
    }
  });

  // Run pipeline
  app.post('/api/pipelines/:id/run', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.manage']))) return reply;
    const { id } = request.params as { id: string };

    const pipeline = await registries.pipeline.getPipeline(id);
    if (!pipeline) { reply.code(404); return { error: 'Pipeline not found.' }; }

    const runId = randomUUID();
    const startedAt = new Date().toISOString();

    // Record run as started
    const runRecord: PipelineRun = {
      id: runId,
      pipelineId: id,
      status: 'running',
      startedAt,
      rowsIn: 0,
      rowsOut: 0,
    };
    await registries.pipeline.recordRun(runRecord);

    try {
      // Get input rows (up to 100k for transforms)
      const inputPreview = await registries.dataset.previewRows(pipeline.inputDatasetId, 100_000);
      const inputRows = inputPreview.rows;

      // Build right-dataset lookup for join steps
      const rightDatasetCache = new Map<string, typeof inputRows>();
      const getRightRows = async (datasetId: string): Promise<typeof inputRows> => {
        if (!rightDatasetCache.has(datasetId)) {
          const preview = await registries.dataset.previewRows(datasetId, 100_000);
          rightDatasetCache.set(datasetId, preview.rows);
        }
        return rightDatasetCache.get(datasetId)!;
      };

      // Pre-fetch right datasets for join steps
      for (const step of pipeline.steps) {
        if (step.type === 'join') await getRightRows(step.rightDatasetId);
      }

      // Execute transform steps
      const outputRows = runSteps(inputRows, pipeline.steps, (dsId) => rightDatasetCache.get(dsId) ?? []);
      const columns = deriveColumns(outputRows);

      // Register output as inline derived dataset
      const outputDataset = await registries.dataset.registerInlineDataset({
        name: pipeline.outputName,
        namespace: pipeline.outputNamespace,
        description: `Derived by pipeline: ${pipeline.name}`,
        rows: outputRows,
        tags: ['derived', 'pipeline'],
      });

      // Track lineage
      await registries.assetLineage.recordEdge({
        fromAssetId: pipeline.inputDatasetId,
        toAssetId: outputDataset.id,
        operation: `pipeline:${pipeline.name}`,
      });

      // Update pipeline with output dataset id
      await registries.pipeline.setOutputDataset(id, outputDataset.id);

      const completedRun: PipelineRun = {
        ...runRecord,
        status: 'succeeded',
        completedAt: new Date().toISOString(),
        outputDatasetId: outputDataset.id,
        rowsIn: inputRows.length,
        rowsOut: outputRows.length,
      };
      await registries.pipeline.recordRun(completedRun);

      return { run: completedRun, outputDataset, columns };
    } catch (error) {
      const failedRun: PipelineRun = {
        ...runRecord,
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error',
        rowsIn: 0,
        rowsOut: 0,
      };
      await registries.pipeline.recordRun(failedRun);
      reply.code(500);
      return { error: failedRun.error };
    }
  });

  // List runs
  app.get('/api/pipelines/:id/runs', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.read']))) return reply;
    const { id } = request.params as { id: string };
    return { items: await registries.pipeline.listRuns(id) };
  });
}
