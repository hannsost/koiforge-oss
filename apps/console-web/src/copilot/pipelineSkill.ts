import type {
  CrosswalkProposal as CrosswalkDatasetProposal,
  DatasetPreviewResult,
  DatasetRecord,
  DeriveExpression,
  PipelineDefinition,
  PipelinePreviewDiagnostics,
  PipelineStep,
} from '../api';

export type PipelineDraft = Omit<
  PipelineDefinition,
  'id' | 'createdAt' | 'updatedAt' | 'lastOutputDatasetId'
>;

export type PipelineSkillAction =
  | { type: 'setInputDataset'; datasetId: string }
  | { type: 'setOutputDataset'; namespace: string; name: string }
  | { type: 'addStep'; step: PipelineStep }
  | { type: 'updateStep'; index: number; step: PipelineStep }
  | { type: 'removeStep'; index: number }
  | { type: 'replaceDraft'; draft: PipelineDraft }
  | { type: 'runSuggest'; primaryDatasetId: string; secondaryDatasetId?: string }
  | { type: 'validateDraft' };

export interface PipelineProposal {
  skillId: 'pipelines';
  title: string;
  summary: string;
  confidence: 'high' | 'medium' | 'low';
  actions: PipelineSkillAction[];
  warnings?: string[];
  requiresUserConfirmation: true;
}

export interface PipelineSkillContext {
  datasets: DatasetRecord[];
  datasetSamples: Array<{
    datasetId: string;
    datasetName: string;
    namespace: string;
    columns: string[];
    rows: Array<Record<string, string | number | boolean | null>>;
  }>;
  crosswalkProposals: CrosswalkDatasetProposal[];
  draftPreview: DatasetPreviewResult | null;
  draftPreviewDiagnostics: PipelinePreviewDiagnostics | null;
  draft: PipelineDraft;
  mode: 'create-draft' | 'view-existing';
  selectedPipeline?: PipelineDefinition | null;
  lastError?: string | null;
}

export interface PipelineProposalParseResult {
  visibleText: string;
  proposal?: PipelineProposal;
  issues: string[];
}

interface PipelineJoinCandidate {
  datasetId: string;
  datasetName: string;
  namespace: string;
  matches: Array<{ leftKey: string; rightKey: string; type: string; score: number }>;
}

const SLUG_RE = /^[a-zA-Z0-9_-]+$/;
const SAFE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseConfidence(value: unknown): PipelineProposal['confidence'] | null {
  return value === 'high' || value === 'medium' || value === 'low' ? value : null;
}

function parseDeriveExpression(value: unknown): DeriveExpression | null {
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
    if (!['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'contains', 'not_null', 'is_null'].includes(String(value.operator))) {
      return null;
    }
    return {
      type: 'filter',
      column: value.column,
      operator: value.operator as PipelineStep extends infer T
        ? T extends { type: 'filter'; operator: infer O } ? O : never
        : never,
      value: typeof value.value === 'string' ? value.value : undefined,
    };
  }

  if (value.type === 'select') {
    if (!Array.isArray(value.columns) || !value.columns.every((column) => typeof column === 'string' && column)) {
      return null;
    }
    return { type: 'select', columns: value.columns };
  }

  if (value.type === 'rename') {
    if (typeof value.from !== 'string' || !value.from || typeof value.to !== 'string' || !SAFE_NAME_RE.test(value.to)) {
      return null;
    }
    return { type: 'rename', from: value.from, to: value.to };
  }

  if (value.type === 'derive') {
    const expression = parseDeriveExpression(value.expression);
    if (typeof value.column !== 'string' || !SAFE_NAME_RE.test(value.column) || !expression) {
      return null;
    }
    return {
      type: 'derive',
      column: value.column,
      expression,
    };
  }

  if (value.type === 'aggregate') {
    if (!Array.isArray(value.groupBy) || !value.groupBy.every((column) => typeof column === 'string' && column)) {
      return null;
    }
    if (!Array.isArray(value.aggregations) || value.aggregations.length === 0) return null;
    const aggregations = value.aggregations.map((entry) => {
      if (!isRecord(entry)) return null;
      if (typeof entry.column !== 'string' || !entry.column) return null;
      if (!['count', 'sum', 'avg', 'min', 'max'].includes(String(entry.fn))) return null;
      if (typeof entry.outputName !== 'string' || !SAFE_NAME_RE.test(entry.outputName)) return null;
      return {
        column: entry.column,
        fn: entry.fn as 'count' | 'sum' | 'avg' | 'min' | 'max',
        outputName: entry.outputName,
      };
    });
    if (aggregations.some((entry) => entry === null)) return null;
    return {
      type: 'aggregate',
      groupBy: value.groupBy,
      aggregations: aggregations as Array<{ column: string; fn: 'count' | 'sum' | 'avg' | 'min' | 'max'; outputName: string }>,
    };
  }

  if (value.type === 'join') {
    if (
      typeof value.rightDatasetId !== 'string'
      || !value.rightDatasetId
      || typeof value.leftKey !== 'string'
      || !value.leftKey
      || typeof value.rightKey !== 'string'
      || !value.rightKey
      || (value.mode !== 'inner' && value.mode !== 'left')
    ) {
      return null;
    }
    return {
      type: 'join',
      rightDatasetId: value.rightDatasetId,
      leftKey: value.leftKey,
      rightKey: value.rightKey,
      mode: value.mode,
    };
  }

  if (value.type === 'distinct') {
    if (
      value.columns !== undefined
      && (
        !Array.isArray(value.columns)
        || !value.columns.every((column) => typeof column === 'string' && column)
      )
    ) {
      return null;
    }
    return {
      type: 'distinct',
      columns: value.columns,
    };
  }

  return null;
}

function parsePipelineDraft(value: unknown): PipelineDraft | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.name !== 'string'
    || !value.name.trim()
    || typeof value.description !== 'string'
    || typeof value.inputDatasetId !== 'string'
    || !value.inputDatasetId
    || typeof value.outputNamespace !== 'string'
    || !SLUG_RE.test(value.outputNamespace)
    || typeof value.outputName !== 'string'
    || !SLUG_RE.test(value.outputName)
    || !Array.isArray(value.steps)
  ) {
    return null;
  }

  const steps = value.steps.map(parsePipelineStep);
  if (steps.some((step) => step === null)) return null;

  return {
    name: value.name,
    description: value.description,
    inputDatasetId: value.inputDatasetId,
    outputNamespace: value.outputNamespace,
    outputName: value.outputName,
    steps: steps as PipelineStep[],
  };
}

function parseAction(value: unknown): PipelineSkillAction | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;

  if (value.type === 'setInputDataset' && typeof value.datasetId === 'string' && value.datasetId) {
    return { type: 'setInputDataset', datasetId: value.datasetId };
  }

  if (
    value.type === 'setOutputDataset'
    && typeof value.namespace === 'string'
    && SLUG_RE.test(value.namespace)
    && typeof value.name === 'string'
    && SLUG_RE.test(value.name)
  ) {
    return { type: 'setOutputDataset', namespace: value.namespace, name: value.name };
  }

  if (value.type === 'addStep') {
    const step = parsePipelineStep(value.step);
    return step ? { type: 'addStep', step } : null;
  }

  if (value.type === 'updateStep') {
    const step = parsePipelineStep(value.step);
    if (!Number.isInteger(value.index) || Number(value.index) < 0 || !step) return null;
    return { type: 'updateStep', index: Number(value.index), step };
  }

  if (value.type === 'removeStep' && Number.isInteger(value.index) && Number(value.index) >= 0) {
    return { type: 'removeStep', index: Number(value.index) };
  }

  if (value.type === 'replaceDraft') {
    const draft = parsePipelineDraft(value.draft);
    return draft ? { type: 'replaceDraft', draft } : null;
  }

  if (value.type === 'runSuggest' && typeof value.primaryDatasetId === 'string' && value.primaryDatasetId) {
    if (value.secondaryDatasetId !== undefined && (typeof value.secondaryDatasetId !== 'string' || !value.secondaryDatasetId)) {
      return null;
    }
    return {
      type: 'runSuggest',
      primaryDatasetId: value.primaryDatasetId,
      secondaryDatasetId: value.secondaryDatasetId,
    };
  }

  if (value.type === 'validateDraft') {
    return { type: 'validateDraft' };
  }

  return null;
}

function parseProposal(value: unknown): PipelineProposal | null {
  if (!isRecord(value)) return null;
  const confidence = parseConfidence(value.confidence);
  if (
    value.skillId !== 'pipelines'
    || typeof value.title !== 'string'
    || !value.title.trim()
    || typeof value.summary !== 'string'
    || !value.summary.trim()
    || !confidence
    || !Array.isArray(value.actions)
    || value.actions.length === 0
    || value.requiresUserConfirmation !== true
  ) {
    return null;
  }

  const actions = value.actions.map(parseAction);
  if (actions.some((action) => action === null)) return null;

  return {
    skillId: 'pipelines',
    title: value.title,
    summary: value.summary,
    confidence,
    actions: actions as PipelineSkillAction[],
    warnings: Array.isArray(value.warnings)
      ? value.warnings.filter((warning): warning is string => typeof warning === 'string')
      : [],
    requiresUserConfirmation: true,
  };
}

function extractTaggedProposal(raw: string): { visibleText: string; jsonText: string | null } {
  const match = raw.match(/<pipeline_proposal>\s*([\s\S]*?)\s*<\/pipeline_proposal>/i);
  if (!match) {
    const fallbackJson = extractLooseProposalJson(raw);
    if (!fallbackJson) return { visibleText: raw.trim(), jsonText: null };
    const visibleText = raw.replace(fallbackJson.raw, '').trim();
    return {
      visibleText: visibleText || 'Ich habe einen Pipeline-Vorschlag vorbereitet.',
      jsonText: fallbackJson.jsonText,
    };
  }
  const visibleText = raw.replace(match[0], '').trim();
  return {
    visibleText: visibleText || 'Ich habe einen Pipeline-Vorschlag vorbereitet.',
    jsonText: normalizeJsonCandidate(match[1]?.trim() ?? ''),
  };
}

function normalizeJsonCandidate(input: string): string | null {
  const stripped = input
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  const firstBrace = stripped.indexOf('{');
  const lastBrace = stripped.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
  return stripped.slice(firstBrace, lastBrace + 1).trim();
}

function extractLooseProposalJson(raw: string): { raw: string; jsonText: string } | null {
  const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1] && /["']skillId["']\s*:\s*["']pipelines["']/.test(fencedMatch[1])) {
    const jsonText = normalizeJsonCandidate(fencedMatch[1]);
    if (jsonText) return { raw: fencedMatch[0], jsonText };
  }

  const objectMatch = raw.match(/\{[\s\S]*["']skillId["']\s*:\s*["']pipelines["'][\s\S]*\}/i);
  if (objectMatch?.[0]) {
    const jsonText = normalizeJsonCandidate(objectMatch[0]);
    if (jsonText) return { raw: objectMatch[0], jsonText };
  }

  return null;
}

export function parsePipelineProposalMessage(raw: string, context: PipelineSkillContext): PipelineProposalParseResult {
  const tagged = extractTaggedProposal(raw);
  if (!tagged.jsonText) return { visibleText: tagged.visibleText, issues: [] };

  let decoded: unknown;
  try {
    decoded = JSON.parse(tagged.jsonText);
  } catch {
    return {
      visibleText: tagged.visibleText,
      issues: [`Pipeline proposal JSON konnte nicht geparst werden: ${tagged.jsonText.slice(0, 180)}`],
    };
  }

  const proposal = parseProposal(decoded);
  if (!proposal) {
    return {
      visibleText: tagged.visibleText,
      issues: ['Pipeline proposal hat ein ungueltiges oder nicht erlaubtes Action-Schema.'],
    };
  }

  const validation = validatePipelineProposalAgainstContext(proposal, context);
  return {
    visibleText: tagged.visibleText,
    proposal: validation.ok ? proposal : undefined,
    issues: validation.issues,
  };
}

function getDatasetMap(context: PipelineSkillContext): Map<string, DatasetRecord> {
  return new Map(context.datasets.map((dataset) => [dataset.id, dataset]));
}

function getFieldNames(dataset?: DatasetRecord | null): Set<string> {
  return new Set((dataset?.schema ?? []).map((field) => field.name));
}

function getFieldType(dataset: DatasetRecord | undefined, column: string): string | null {
  return dataset?.schema.find((field) => field.name === column)?.type ?? null;
}

function buildColumnState(dataset?: DatasetRecord | null): Map<string, string> {
  return new Map((dataset?.schema ?? []).map((field) => [field.name, field.type]));
}

function applyStepToColumnState(
  currentColumns: Map<string, string>,
  step: PipelineStep,
  datasetsById: Map<string, DatasetRecord>,
): Map<string, string> {
  if (step.type === 'filter') {
    return new Map(currentColumns);
  }

  if (step.type === 'select') {
    return new Map(step.columns.map((column) => [column, currentColumns.get(column) ?? 'string']));
  }

  if (step.type === 'rename') {
    const nextColumns = new Map<string, string>();
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
        .find((type): type is string => Boolean(type));
      nextColumns.set(step.column, sourceType ?? 'string');
    }
    return nextColumns;
  }

  if (step.type === 'aggregate') {
    const nextColumns = new Map<string, string>();
    for (const column of step.groupBy) {
      nextColumns.set(column, currentColumns.get(column) ?? 'string');
    }
    for (const aggregation of step.aggregations) {
      nextColumns.set(aggregation.outputName, aggregation.fn === 'count' ? 'integer' : 'number');
    }
    return nextColumns;
  }

  if (step.type === 'distinct') {
    return new Map(currentColumns);
  }

  const nextColumns = new Map(currentColumns);
  const rightDataset = datasetsById.get(step.rightDatasetId);
  for (const field of rightDataset?.schema ?? []) {
    if (!nextColumns.has(field.name)) {
      nextColumns.set(field.name, field.type);
    }
  }
  return nextColumns;
}

function normalizeFieldName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function scoreJoinColumns(leftName: string, rightName: string, sameType: boolean): number {
  if (!sameType) return 0;
  const left = normalizeFieldName(leftName);
  const right = normalizeFieldName(rightName);
  if (!left || !right) return 0;
  if (left === right) return 100;
  if (left.endsWith(right) || right.endsWith(left)) return 85;
  if (
    left.replace(/id$/, '') === right.replace(/id$/, '')
    || left.replace(/key$/, '') === right.replace(/key$/, '')
  ) {
    return 78;
  }
  if (left.includes(right) || right.includes(left)) return 68;
  return 0;
}

function buildJoinCandidates(context: PipelineSkillContext): PipelineJoinCandidate[] {
  const datasetsById = getDatasetMap(context);
  let currentColumns = buildColumnState(datasetsById.get(context.draft.inputDatasetId));
  if (currentColumns.size === 0) return [];

  for (const step of context.draft.steps) {
    currentColumns = applyStepToColumnState(currentColumns, step, datasetsById);
  }

  const currentFieldEntries = [...currentColumns.entries()].map(([name, type]) => ({ name, type }));

  return context.datasets
    .filter((dataset) => dataset.id !== context.draft.inputDatasetId)
    .map((dataset) => {
      const matches = currentFieldEntries
        .flatMap((leftField) => dataset.schema.map((rightField) => ({
          leftKey: leftField.name,
          rightKey: rightField.name,
          type: leftField.type,
          score: scoreJoinColumns(leftField.name, rightField.name, leftField.type === rightField.type),
        })))
        .filter((match) => match.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);

      return {
        datasetId: dataset.id,
        datasetName: dataset.name,
        namespace: dataset.namespace,
        matches,
      };
    })
    .filter((candidate) => candidate.matches.length > 0)
    .sort((a, b) => b.matches[0]!.score - a.matches[0]!.score)
    .slice(0, 12);
}

function validateStep(
  step: PipelineStep,
  currentColumns: Map<string, string>,
  datasetsById: Map<string, DatasetRecord>,
): string[] {
  const issues: string[] = [];

  if (step.type === 'filter' && !currentColumns.has(step.column)) {
    issues.push(`Filter-Spalte '${step.column}' existiert nicht im aktuellen Zwischenergebnis.`);
  }

  if (step.type === 'select') {
    for (const column of step.columns) {
      if (!currentColumns.has(column)) {
        issues.push(`Select-Spalte '${column}' existiert nicht im aktuellen Zwischenergebnis.`);
      }
    }
  }

  if (step.type === 'rename') {
    if (!currentColumns.has(step.from)) {
      issues.push(`Rename-Quelle '${step.from}' existiert nicht im aktuellen Zwischenergebnis.`);
    }
    if (currentColumns.has(step.to) && step.to !== step.from) {
      issues.push(`Rename-Ziel '${step.to}' wuerde eine existierende Spalte doppeln.`);
    }
  }

  if (step.type === 'derive') {
    if (currentColumns.has(step.column)) {
      issues.push(`Derive-Ziel '${step.column}' existiert bereits im aktuellen Zwischenergebnis.`);
    }
    if (step.expression.op === 'copy' && !currentColumns.has(step.expression.column)) {
      issues.push(`Derive-Quelle '${step.expression.column}' existiert nicht im aktuellen Zwischenergebnis.`);
    }
    if (step.expression.op === 'coalesce') {
      if (step.expression.columns.length === 0) {
        issues.push('Derive-Coalesce braucht mindestens eine Quellspalte.');
      }
      for (const column of step.expression.columns) {
        if (!currentColumns.has(column)) {
          issues.push(`Derive-Coalesce-Spalte '${column}' existiert nicht im aktuellen Zwischenergebnis.`);
        }
      }
    }
  }

  if (step.type === 'aggregate') {
    const outputNames = new Set<string>();
    for (const column of step.groupBy) {
      if (!currentColumns.has(column)) {
        issues.push(`GroupBy-Spalte '${column}' existiert nicht im aktuellen Zwischenergebnis.`);
      }
    }
    for (const aggregation of step.aggregations) {
      if (!currentColumns.has(aggregation.column)) {
        issues.push(`Aggregation-Spalte '${aggregation.column}' existiert nicht im aktuellen Zwischenergebnis.`);
      }
      if (outputNames.has(aggregation.outputName)) {
        issues.push(`Aggregation-Output '${aggregation.outputName}' ist doppelt.`);
      }
      outputNames.add(aggregation.outputName);
    }
  }

  if (step.type === 'distinct' && step.columns) {
    for (const column of step.columns) {
      if (!currentColumns.has(column)) {
        issues.push(`Distinct-Spalte '${column}' existiert nicht im aktuellen Zwischenergebnis.`);
      }
    }
  }

  if (step.type === 'join') {
    const rightDataset = datasetsById.get(step.rightDatasetId);
    const rightFields = getFieldNames(rightDataset);
    if (!rightDataset) {
      issues.push(`Join-Dataset '${step.rightDatasetId}' existiert nicht.`);
      return issues;
    }
    if (!currentColumns.has(step.leftKey)) {
      issues.push(`Join leftKey '${step.leftKey}' existiert nicht im aktuellen Zwischenergebnis.`);
    }
    if (!rightFields.has(step.rightKey)) {
      issues.push(`Join rightKey '${step.rightKey}' existiert nicht in '${step.rightDatasetId}'.`);
    }
    const leftType = currentColumns.get(step.leftKey) ?? null;
    const rightType = getFieldType(rightDataset, step.rightKey);
    if (leftType && rightType && leftType !== rightType) {
      issues.push(`Join-Key-Typen passen nicht zusammen: ${step.leftKey}=${leftType}, ${step.rightKey}=${rightType}.`);
    }
  }

  return issues;
}

function validateDraftSteps(
  draft: PipelineDraft,
  datasetsById: Map<string, DatasetRecord>,
): string[] {
  const inputDataset = datasetsById.get(draft.inputDatasetId);
  if (!inputDataset) {
    return [`Input dataset '${draft.inputDatasetId}' existiert nicht.`];
  }

  const issues: string[] = [];
  let currentColumns = buildColumnState(inputDataset);

  draft.steps.forEach((step, index) => {
    issues.push(...validateStep(step, currentColumns, datasetsById).map(
      (issue) => `Step ${index + 1}: ${issue}`,
    ));
    currentColumns = applyStepToColumnState(currentColumns, step, datasetsById);
  });

  return issues;
}

export function validatePipelineProposalAgainstContext(
  proposal: PipelineProposal,
  context: PipelineSkillContext,
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const datasetsById = getDatasetMap(context);
  let draft = structuredClone(context.draft);

  proposal.actions.forEach((action, actionIndex) => {
    const prefix = `Action ${actionIndex + 1} (${action.type}): `;

    if (action.type === 'setInputDataset') {
      if (!datasetsById.has(action.datasetId)) {
        issues.push(`${prefix}Dataset '${action.datasetId}' existiert nicht.`);
        return;
      }
      draft.inputDatasetId = action.datasetId;
      draft.steps = [];
      issues.push(...validateDraftSteps(draft, datasetsById).map((issue) => `${prefix}${issue}`));
      return;
    }

    if (action.type === 'setOutputDataset') {
      if (!SLUG_RE.test(action.namespace) || !SLUG_RE.test(action.name)) {
        issues.push(`${prefix}Output-Namespace/Name muessen Slug-Zeichen verwenden.`);
      } else {
        draft.outputNamespace = action.namespace;
        draft.outputName = action.name;
      }
      return;
    }

    if (action.type === 'addStep') {
      draft.steps.push(action.step);
      issues.push(...validateDraftSteps(draft, datasetsById).map((issue) => `${prefix}${issue}`));
      return;
    }

    if (action.type === 'updateStep') {
      if (action.index >= draft.steps.length) {
        issues.push(`${prefix}Step-Index ${action.index} ist ausserhalb des Drafts.`);
        return;
      }
      draft.steps[action.index] = action.step;
      issues.push(...validateDraftSteps(draft, datasetsById).map((issue) => `${prefix}${issue}`));
      return;
    }

    if (action.type === 'removeStep') {
      if (action.index >= draft.steps.length) {
        issues.push(`${prefix}Step-Index ${action.index} ist ausserhalb des Drafts.`);
      } else {
        draft.steps.splice(action.index, 1);
        issues.push(...validateDraftSteps(draft, datasetsById).map((issue) => `${prefix}${issue}`));
      }
      return;
    }

    if (action.type === 'replaceDraft') {
      if (!datasetsById.has(action.draft.inputDatasetId)) {
        issues.push(`${prefix}Input dataset '${action.draft.inputDatasetId}' existiert nicht.`);
        return;
      }
      draft = structuredClone(action.draft);
      issues.push(...validateDraftSteps(draft, datasetsById).map((issue) => `${prefix}${issue}`));
      return;
    }

    if (action.type === 'runSuggest') {
      if (!datasetsById.has(action.primaryDatasetId)) {
        issues.push(`${prefix}Primary dataset '${action.primaryDatasetId}' existiert nicht.`);
      }
      if (action.secondaryDatasetId && !datasetsById.has(action.secondaryDatasetId)) {
        issues.push(`${prefix}Secondary dataset '${action.secondaryDatasetId}' existiert nicht.`);
      }
    }
  });

  return {
    ok: issues.length === 0,
    issues,
  };
}

export function buildPipelineSkillPrompt(context: PipelineSkillContext): string {
  const datasetDigest = context.datasets.map((dataset) => ({
    id: dataset.id,
    name: dataset.name,
    namespace: dataset.namespace,
    schema: dataset.schema.map((field) => ({
      name: field.name,
      type: field.type,
      nullable: field.nullable !== false,
    })),
  }));
  const joinCandidates = buildJoinCandidates(context);

  return [
    'PAGE SKILL: pipelines',
    'You may read the provided pipeline context broadly, but you may only propose pipeline changes via whitelisted skill actions.',
    'All user-facing answers must be grounded strictly in PIPELINE_CONTEXT. Never mention datasets, columns, IDs, or business entities that are not present there.',
    '',
    'Allowed actions:',
    '- setInputDataset { datasetId }',
    '- setOutputDataset { namespace, name }',
    '- addStep { step }',
    '- updateStep { index, step }',
    '- removeStep { index }',
    '- replaceDraft { draft }',
    '- runSuggest { primaryDatasetId, secondaryDatasetId? }',
    '- validateDraft {}',
    '',
    'PipelineStep schema:',
    '- filter { type:"filter", column, operator:"eq|neq|gt|lt|gte|lte|contains|not_null|is_null", value? }',
    '- select { type:"select", columns:string[] }',
    '- rename { type:"rename", from, to }',
    '- derive { type:"derive", column, expression:{ op:"copy", column } | { op:"literal", value } | { op:"coalesce", columns:string[], fallback? } }',
    '- aggregate { type:"aggregate", groupBy:string[], aggregations:[{ column, fn:"count|sum|avg|min|max", outputName }] }',
    '- distinct { type:"distinct", columns?:string[] }',
    '- join { type:"join", rightDatasetId, leftKey, rightKey, mode:"inner|left" }',
    '',
    'Hard rules:',
    '- Never invent dataset IDs or field names. Only use IDs and schema fields from PIPELINE_CONTEXT.datasets and PIPELINE_CONTEXT.joinCandidates.',
    '- You DO have access to actual sample row values in PIPELINE_CONTEXT.datasetSamples. If the user asks for table contents or asks whether a crosswalk is needed, inspect those sample rows and answer from them. Never claim you cannot access actual values when datasetSamples are present.',
    '- You also see PIPELINE_CONTEXT.draftPreview and PIPELINE_CONTEXT.draftPreviewDiagnostics. If warning is set, changedRows is 0, or no new columns appear after a join/crosswalk, explain why the current draft is likely a no-op and propose a corrected step plan instead of pretending it works.',
    '- If a current join uses columns whose sample values look semantically related but not equal after normalization, explain that a crosswalk is likely needed and prefer proposing runSuggest with the current primary/secondary datasets.',
    '- If PIPELINE_CONTEXT.crosswalkProposals is non-empty, summarize the strongest proposal with exact left/right columns, mapping examples, coverage, and confidence.',
    '- For crosswalk-backed joins, you may propose multiple sequential actions (e.g. addStep join -> addStep derive/coalesce -> addStep join -> addStep distinct) when that produces a meaningful output and draftPreviewDiagnostics indicates the current draft is a no-op.',
    '- If the user asks "which secondary dataset?", recommend only datasets from PIPELINE_CONTEXT.joinCandidates, mention exact datasetId plus leftKey/rightKey pairs, and say "keine robuste Join-Kandidaten gefunden" if that list is empty.',
    '- Keep proposals dataset-agnostic. Infer joins/aggregations from field names/types/nullability, not hardcoded business names.',
    '- If you propose changes, include a short human explanation plus exactly one machine-readable JSON object wrapped in <pipeline_proposal>...</pipeline_proposal>.',
    '- Never put markdown fences, comments, placeholders, empty rightKey values, or prose inside <pipeline_proposal>.',
    '- The proposal JSON must match exactly: { "skillId":"pipelines", "title":"...", "summary":"...", "confidence":"high|medium|low", "actions":[...], "warnings":[], "requiresUserConfirmation":true }',
    '- Prefer "runSuggest" when the user asks for recommendations and "addStep"/"replaceDraft" only when valid keys/columns are known from context.',
    '- If no config change is needed, answer normally and do not emit <pipeline_proposal>.',
    '',
    'Example valid proposal:',
    '<pipeline_proposal>',
    '{',
    '  "skillId": "pipelines",',
    '  "title": "Load smart suggestions",',
    '  "summary": "Run heuristic suggestions for the current input dataset and selected secondary dataset.",',
    '  "confidence": "high",',
    '  "actions": [',
    '    { "type": "runSuggest", "primaryDatasetId": "DATASET_ID_FROM_CONTEXT", "secondaryDatasetId": "SECONDARY_DATASET_ID_FROM_CONTEXT" }',
    '  ],',
    '  "warnings": [],',
    '  "requiresUserConfirmation": true',
    '}',
    '</pipeline_proposal>',
    '',
    `PIPELINE_CONTEXT:\n${JSON.stringify({
      mode: context.mode,
      draft: context.draft,
      selectedPipeline: context.selectedPipeline
        ? {
            id: context.selectedPipeline.id,
            name: context.selectedPipeline.name,
            description: context.selectedPipeline.description,
            inputDatasetId: context.selectedPipeline.inputDatasetId,
            outputNamespace: context.selectedPipeline.outputNamespace,
            outputName: context.selectedPipeline.outputName,
            steps: context.selectedPipeline.steps,
            lastOutputDatasetId: context.selectedPipeline.lastOutputDatasetId,
          }
        : null,
      datasets: datasetDigest,
      datasetSamples: context.datasetSamples.map((sample) => ({
        datasetId: sample.datasetId,
        datasetName: sample.datasetName,
        namespace: sample.namespace,
        columns: sample.columns,
        rows: sample.rows.slice(0, 8),
      })),
      joinCandidates,
      draftPreview: context.draftPreview
        ? {
            columns: context.draftPreview.columns,
            rows: context.draftPreview.rows.slice(0, 8),
            rowCount: context.draftPreview.rowCount,
            truncated: context.draftPreview.truncated,
          }
        : null,
      draftPreviewDiagnostics: context.draftPreviewDiagnostics,
      crosswalkProposals: context.crosswalkProposals.slice(0, 6).map((proposal) => ({
        id: proposal.id,
        leftDatasetId: proposal.leftDatasetId,
        leftColumn: proposal.leftColumn,
        rightDatasetId: proposal.rightDatasetId,
        rightColumn: proposal.rightColumn,
        confidence: proposal.confidence,
        coverage: proposal.coverage,
        directOverlapRatio: proposal.directOverlapRatio,
        explanation: proposal.explanation,
        mappingExamples: proposal.mappings.slice(0, 8).map((mapping) => ({
          leftValue: mapping.leftValue,
          rightValue: mapping.rightValue,
          canonicalValue: mapping.canonicalValue,
          confidence: mapping.confidence,
          method: mapping.method,
          status: mapping.status,
        })),
      })),
      lastError: context.lastError ?? null,
    }, null, 2)}`,
  ].join('\n');
}
