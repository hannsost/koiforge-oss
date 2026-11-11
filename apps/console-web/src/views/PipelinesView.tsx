import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Sparkles, Trash2 } from 'lucide-react';

import {
  createPipeline,
  deletePipeline,
  fetchDatasetPreview,
  fetchDatasets,
  fetchPipelineRuns,
  fetchPipelines,
  materializeCrosswalk,
  planPipelineGlue,
  previewPipelineDraft,
  registerConnectorDataset,
  runPipeline,
  suggestCrosswalks,
  suggestPipelineSteps,
  uploadInlineDataset,
  type CrosswalkProposal as CrosswalkDatasetProposal,
  type DatasetPreviewResult,
  type DatasetRecord,
  type FilterOperator,
  type PipelineDefinition,
  type PipelineGluePlanResult,
  type PipelinePreviewDiagnostics,
  type PipelineRun,
  type PipelineStep,
  type SuggestedPipelineStep,
} from '../api';
import type { CopilotSkillBinding } from '../components/AipMiniCopilot';
import { Badge, Card, ActionButton, DataTable, inputCls, selectCls, ghostBtnCls } from '../components/ui';
import { UiIcon } from '../components/ProductIdentity';
import {
  buildPipelineSkillPrompt,
  parsePipelineProposalMessage,
  validatePipelineProposalAgainstContext,
  type PipelineDraft,
  type PipelineProposal,
  type PipelineSkillContext,
} from '../copilot/pipelineSkill';

const OPERATORS: { value: FilterOperator; label: string }[] = [
  { value: 'eq', label: '=' },
  { value: 'neq', label: '≠' },
  { value: 'gt', label: '>' },
  { value: 'lt', label: '<' },
  { value: 'gte', label: '≥' },
  { value: 'lte', label: '≤' },
  { value: 'contains', label: 'contains' },
  { value: 'not_null', label: 'not null' },
  { value: 'is_null', label: 'is null' },
];

interface PipelinesViewProps {
  onCopilotBindingChange?: (binding: CopilotSkillBinding | null) => void;
}

function createInitialDraft(datasets: DatasetRecord[]): PipelineDraft {
  return {
    name: '',
    description: '',
    inputDatasetId: datasets[0]?.id ?? '',
    outputName: '',
    outputNamespace: 'derived',
    steps: [],
  };
}

function pipelineToDraft(pipeline: PipelineDefinition): PipelineDraft {
  return {
    name: pipeline.name,
    description: pipeline.description,
    inputDatasetId: pipeline.inputDatasetId,
    outputName: pipeline.outputName,
    outputNamespace: pipeline.outputNamespace,
    steps: structuredClone(pipeline.steps),
  };
}

function pickSecondaryDatasetId(
  datasets: DatasetRecord[],
  inputDatasetId: string,
  current?: string,
): string {
  if (
    current
    && current !== inputDatasetId
    && datasets.some((dataset) => dataset.id === current)
  ) {
    return current;
  }
  return datasets.find((dataset) => dataset.id !== inputDatasetId)?.id ?? '';
}

function isPipelineProposal(value: unknown): value is PipelineProposal {
  return typeof value === 'object' && value !== null && (value as { skillId?: unknown }).skillId === 'pipelines';
}

function toPipelineSlug(value: string, fallback: string): string {
  const slug = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || fallback;
}

function getDatasetColumns(dataset?: DatasetRecord | null): string[] {
  return dataset?.schema.map((field) => field.name) ?? [];
}

function mergeColumns(leftColumns: string[], rightColumns: string[]): string[] {
  const merged = [...leftColumns];
  const seen = new Set(leftColumns);
  for (const column of rightColumns) {
    if (seen.has(column)) continue;
    seen.add(column);
    merged.push(column);
  }
  return merged;
}

function deriveNextColumns(
  currentColumns: string[],
  step: PipelineStep,
  datasetsById: Map<string, DatasetRecord>,
): string[] {
  if (step.type === 'filter') return currentColumns;
  if (step.type === 'select') return step.columns;
  if (step.type === 'rename') {
    return currentColumns.map((column) => (
      column === step.from && step.to ? step.to : column
    ));
  }
  if (step.type === 'derive') {
    return mergeColumns(currentColumns, [step.column]);
  }
  if (step.type === 'aggregate') {
    return [
      ...step.groupBy,
      ...step.aggregations.map((aggregation) => aggregation.outputName).filter((column) => column),
    ];
  }
  if (step.type === 'distinct') {
    return currentColumns;
  }
  const rightDataset = datasetsById.get(step.rightDatasetId);
  return mergeColumns(currentColumns, getDatasetColumns(rightDataset));
}

function deriveStepInputColumns(draft: PipelineDraft, datasets: DatasetRecord[]): string[][] {
  const datasetsById = new Map(datasets.map((dataset) => [dataset.id, dataset]));
  let currentColumns = getDatasetColumns(datasetsById.get(draft.inputDatasetId));
  return draft.steps.map((step) => {
    const columnsBeforeStep = currentColumns;
    currentColumns = deriveNextColumns(currentColumns, step, datasetsById);
    return columnsBeforeStep;
  });
}

function deriveDraftOutputColumns(draft: PipelineDraft, datasets: DatasetRecord[]): string[] {
  const datasetsById = new Map(datasets.map((dataset) => [dataset.id, dataset]));
  return draft.steps.reduce(
    (columns, step) => deriveNextColumns(columns, step, datasetsById),
    getDatasetColumns(datasetsById.get(draft.inputDatasetId)),
  );
}

function deriveOutputSourceColumns(draft: PipelineDraft, datasets: DatasetRecord[]): string[] {
  const lastStep = draft.steps[draft.steps.length - 1];
  if (lastStep?.type !== 'select') {
    return deriveDraftOutputColumns(draft, datasets);
  }

  return deriveDraftOutputColumns(
    { ...draft, steps: draft.steps.slice(0, -1) },
    datasets,
  );
}

function deriveSelectedOutputColumns(draft: PipelineDraft, datasets: DatasetRecord[]): string[] {
  const sourceColumns = deriveOutputSourceColumns(draft, datasets);
  const lastStep = draft.steps[draft.steps.length - 1];
  if (lastStep?.type !== 'select') {
    return sourceColumns;
  }

  const selectedColumns = lastStep.columns.filter((column) => sourceColumns.includes(column));
  return selectedColumns.length > 0 ? selectedColumns : sourceColumns;
}

function applyOutputColumnsSelection(
  draft: PipelineDraft,
  datasets: DatasetRecord[],
  selectedColumns: string[],
): PipelineDraft {
  const sourceColumns = deriveOutputSourceColumns(draft, datasets);
  const normalizedColumns = sourceColumns.filter((column) => selectedColumns.includes(column));
  const baseSteps = draft.steps[draft.steps.length - 1]?.type === 'select'
    ? draft.steps.slice(0, -1)
    : draft.steps;

  if (normalizedColumns.length === 0 || normalizedColumns.length === sourceColumns.length) {
    return { ...draft, steps: baseSteps };
  }

  return {
    ...draft,
    steps: [...baseSteps, { type: 'select', columns: normalizedColumns }],
  };
}

function buildDatasetGroups(datasets: DatasetRecord[], excludeDatasetId = '') {
  const groups = new Map<string, DatasetRecord[]>();
  for (const dataset of datasets) {
    if (dataset.id === excludeDatasetId) continue;
    const group = groups.get(dataset.namespace) ?? [];
    group.push(dataset);
    groups.set(dataset.namespace, group);
  }

  return [...groups.entries()]
    .map(([namespace, entries]) => ({
      namespace,
      entries: entries.sort((left, right) => left.name.localeCompare(right.name)),
    }))
    .sort((left, right) => left.namespace.localeCompare(right.namespace));
}

function DatasetSelect({
  datasets,
  excludeDatasetId = '',
  includeEmptyOption = false,
  value,
  onChange,
}: {
  datasets: DatasetRecord[];
  excludeDatasetId?: string;
  includeEmptyOption?: boolean;
  value: string;
  onChange: (datasetId: string) => void;
}) {
  const groups = buildDatasetGroups(datasets, excludeDatasetId);
  const optionStyle = { background: '#ffffff', color: '#0f172a' } as const;

  return (
    <select className={selectCls} value={value} onChange={(event) => onChange(event.target.value)}>
      {includeEmptyOption && <option value="" style={optionStyle}>No secondary dataset</option>}
      {groups.map((group) => (
        <optgroup key={group.namespace} label={group.namespace} style={optionStyle}>
          {group.entries.map((dataset) => (
            <option key={dataset.id} value={dataset.id} style={optionStyle}>
              {dataset.namespace}/{dataset.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function renderPipelineProposal(proposal: unknown) {
  if (!isPipelineProposal(proposal)) return null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-semibold" style={{ color: 'var(--text-hi)' }}>
          {proposal.title}
        </span>
        <Badge tone={
          proposal.confidence === 'high'
            ? 'success'
            : proposal.confidence === 'medium'
              ? 'warning'
              : 'neutral'
        }>
          {proposal.confidence}
        </Badge>
      </div>
      <div className="text-[11px] leading-5" style={{ color: 'var(--text-lo)' }}>
        {proposal.summary}
      </div>
      <div className="space-y-1">
        {proposal.actions.map((action, index) => (
          <div
            key={`${action.type}-${index}`}
            className="rounded border px-2 py-1 text-[11px]"
            style={{
              background: 'rgb(var(--ink) / 0.35)',
              borderColor: 'rgb(var(--rim))',
              color: 'var(--text-mid)',
            }}
          >
            {index + 1}. {action.type}
          </div>
        ))}
      </div>
      {proposal.warnings && proposal.warnings.length > 0 && (
        <div className="text-[11px] leading-5" style={{ color: '#fbbf24' }}>
          {proposal.warnings.join(' ')}
        </div>
      )}
    </div>
  );
}

function StepEditor({ step, index, columns, datasets, onUpdate, onRemove }: {
  step: PipelineStep;
  index: number;
  columns: string[];
  datasets: DatasetRecord[];
  onUpdate: (s: PipelineStep) => void;
  onRemove: () => void;
}) {
  const stepTypeLabel = {
    filter: 'Filter',
    select: 'Select Columns',
    rename: 'Rename',
    derive: 'Derive Column',
    aggregate: 'Aggregate',
    distinct: 'Distinct',
    join: 'Join',
  }[step.type];

  return (
    <div className="rounded border p-3 space-y-2" style={{ borderColor: 'rgb(var(--rim))', background: 'rgb(var(--ink)/0.5)' }}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] px-1.5 py-0.5 rounded" style={{ background: 'rgb(var(--rim))', color: 'var(--text-mid)' }}>
          {index + 1}. {stepTypeLabel}
        </span>
        <button onClick={onRemove} type="button" className="rounded p-0.5 hover:bg-[rgba(239,68,68,0.1)] text-[#3a4e6a] hover:text-[#f87171] transition">
          <Trash2 size={13} />
        </button>
      </div>

      {step.type === 'filter' && (
        <div className="grid gap-2 grid-cols-[1fr_auto_1fr]">
          <select className={selectCls} value={step.column} onChange={(e) => onUpdate({ ...step, column: e.target.value })}>
            <option value="">Column…</option>
            {columns.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className={selectCls} style={{ width: 'auto' }} value={step.operator} onChange={(e) => onUpdate({ ...step, operator: e.target.value as FilterOperator })}>
            {OPERATORS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {step.operator !== 'not_null' && step.operator !== 'is_null'
            ? <input className={inputCls} placeholder="Value…" value={step.value ?? ''} onChange={(e) => onUpdate({ ...step, value: e.target.value })} />
            : <div />}
        </div>
      )}

      {step.type === 'select' && (
        <div className="flex flex-wrap gap-1.5">
          {columns.map((col) => {
            const selected = step.columns.includes(col);
            return (
              <button key={col} type="button"
                className="rounded px-2 py-0.5 text-[12px] transition"
                style={{
                  background: selected ? '#4F79E7' : 'rgb(var(--rim))',
                  color: selected ? '#fff' : 'var(--text-mid)',
                  border: '1px solid transparent',
                }}
                onClick={() => onUpdate({ ...step, columns: selected ? step.columns.filter((c) => c !== col) : [...step.columns, col] })}
              >{col}</button>
            );
          })}
        </div>
      )}

      {step.type === 'rename' && (
        <div className="grid grid-cols-2 gap-2">
          <select className={selectCls} value={step.from} onChange={(e) => onUpdate({ ...step, from: e.target.value })}>
            <option value="">From column…</option>
            {columns.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <input className={inputCls} placeholder="New name…" value={step.to} onChange={(e) => onUpdate({ ...step, to: e.target.value })} />
        </div>
      )}

      {step.type === 'derive' && (
        <div
          className="rounded border px-3 py-2 text-[11px] leading-5"
          style={{
            borderColor: 'rgb(var(--rim))',
            background: 'rgb(var(--ink) / 0.35)',
            color: 'var(--text-mid)',
          }}
        >
          <div style={{ color: 'var(--text-hi)', fontWeight: 600 }}>{step.column}</div>
          <pre className="whitespace-pre-wrap break-words">
            {JSON.stringify(step.expression, null, 2)}
          </pre>
        </div>
      )}

      {step.type === 'aggregate' && (
        <div className="space-y-2">
          <div>
            <div className="mb-1 text-[11px]" style={{ color: 'var(--text-lo)' }}>Group by</div>
            <div className="flex flex-wrap gap-1.5">
              {columns.map((col) => {
                const selected = step.groupBy.includes(col);
                return (
                  <button key={col} type="button"
                    className="rounded px-2 py-0.5 text-[12px] transition"
                    style={{ background: selected ? '#4F79E7' : 'rgb(var(--rim))', color: selected ? '#fff' : 'var(--text-mid)' }}
                    onClick={() => onUpdate({ ...step, groupBy: selected ? step.groupBy.filter((c) => c !== col) : [...step.groupBy, col] })}
                  >{col}</button>
                );
              })}
            </div>
          </div>
          <div>
            <div className="mb-1 text-[11px]" style={{ color: 'var(--text-lo)' }}>Aggregations</div>
            {step.aggregations.map((agg, ai) => (
              <div key={ai} className="grid grid-cols-[1fr_auto_1fr_auto] gap-1 mb-1">
                <select className={selectCls} value={agg.column} onChange={(e) => onUpdate({ ...step, aggregations: step.aggregations.map((a, i) => i === ai ? { ...a, column: e.target.value } : a) })}>
                  <option value="">Column…</option>
                  {columns.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <select className={selectCls} style={{ width: 'auto' }} value={agg.fn} onChange={(e) => onUpdate({ ...step, aggregations: step.aggregations.map((a, i) => i === ai ? { ...a, fn: e.target.value as typeof agg.fn } : a) })}>
                  {['count', 'sum', 'avg', 'min', 'max'].map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
                <input className={inputCls} placeholder="Output name…" value={agg.outputName} onChange={(e) => onUpdate({ ...step, aggregations: step.aggregations.map((a, i) => i === ai ? { ...a, outputName: e.target.value } : a) })} />
                <button type="button" aria-label={`Aggregation ${ai + 1} entfernen`} className="text-[#3a4e6a] hover:text-[#f87171]" onClick={() => onUpdate({ ...step, aggregations: step.aggregations.filter((_, i) => i !== ai) })}><UiIcon name="close" size={16} /></button>
              </div>
            ))}
            <button type="button" className={ghostBtnCls} style={{ fontSize: '11px', padding: '2px 8px' }}
              onClick={() => onUpdate({ ...step, aggregations: [...step.aggregations, { column: '', fn: 'count', outputName: 'count' }] })}>
              + Aggregation
            </button>
          </div>
        </div>
      )}

      {step.type === 'distinct' && (
        <div>
          <div className="mb-1 text-[11px]" style={{ color: 'var(--text-lo)' }}>
            Distinct columns (leer = alle Spalten)
          </div>
          <div className="flex flex-wrap gap-1.5">
            {columns.map((col) => {
              const selected = (step.columns ?? []).includes(col);
              return (
                <button
                  key={col}
                  type="button"
                  className="rounded px-2 py-0.5 text-[12px] transition"
                  style={{
                    background: selected ? '#4F79E7' : 'rgb(var(--rim))',
                    color: selected ? '#fff' : 'var(--text-mid)',
                    border: '1px solid transparent',
                  }}
                  onClick={() => onUpdate({
                    ...step,
                    columns: selected
                      ? (step.columns ?? []).filter((entry) => entry !== col)
                      : [...(step.columns ?? []), col],
                  })}
                >
                  {col}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {step.type === 'join' && (
        <div className="grid grid-cols-2 gap-2">
          <DatasetSelect
            datasets={datasets}
            includeEmptyOption
            value={step.rightDatasetId}
            onChange={(datasetId) => onUpdate({ ...step, rightDatasetId: datasetId })}
          />
          <select className={selectCls} value={step.mode} onChange={(e) => onUpdate({ ...step, mode: e.target.value as 'inner' | 'left' })}>
            <option value="inner">Inner join</option>
            <option value="left">Left join</option>
          </select>
          <select className={selectCls} value={step.leftKey} onChange={(e) => onUpdate({ ...step, leftKey: e.target.value })}>
            <option value="">Left key…</option>
            {columns.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <input className={inputCls} placeholder="Right key column…" value={step.rightKey} onChange={(e) => onUpdate({ ...step, rightKey: e.target.value })} />
        </div>
      )}
    </div>
  );
}

function PipelineEditor({
  datasets,
  draft,
  draftOutputPreview,
  draftPreviewDiagnostics,
  glueApplying,
  gluePlan,
  inputPreview,
  secondaryPreview,
  secondaryDatasetId,
  smartSuggestions,
  smartSummary,
  crosswalkProposals,
  crosswalkSummary,
  crosswalkApprovingId,
  suggesting,
  suggestError,
  onDraftChange,
  onApplyGluePlan,
  onSecondaryDatasetChange,
  onLoadSmartSuggestions,
  onApplySuggestion,
  onApproveCrosswalk,
  onSave,
  onValidationError,
  onCancel,
}: {
  datasets: DatasetRecord[];
  draft: PipelineDraft;
  draftOutputPreview: DatasetPreviewResult | null;
  draftPreviewDiagnostics: PipelinePreviewDiagnostics | null;
  glueApplying: boolean;
  gluePlan: PipelineGluePlanResult | null;
  inputPreview: DatasetPreviewResult | null;
  secondaryPreview: DatasetPreviewResult | null;
  secondaryDatasetId: string;
  smartSuggestions: SuggestedPipelineStep[];
  smartSummary: string;
  crosswalkProposals: CrosswalkDatasetProposal[];
  crosswalkSummary: string;
  crosswalkApprovingId: string | null;
  suggesting: boolean;
  suggestError: string | null;
  onDraftChange: (draft: PipelineDraft) => void;
  onApplyGluePlan: (plan: PipelineGluePlanResult) => void;
  onSecondaryDatasetChange: (datasetId: string) => void;
  onLoadSmartSuggestions: () => void;
  onApplySuggestion: (suggestion: SuggestedPipelineStep) => void;
  onApproveCrosswalk: (proposal: CrosswalkDatasetProposal) => void;
  onSave: (pipeline: PipelineDraft) => void;
  onValidationError: (message: string) => void;
  onCancel: () => void;
}) {
  const stepColumns = useMemo(() => deriveStepInputColumns(draft, datasets), [datasets, draft]);
  const columns = useMemo(() => deriveDraftOutputColumns(draft, datasets), [datasets, draft]);
  const outputSourceColumns = useMemo(
    () => deriveOutputSourceColumns(draft, datasets),
    [datasets, draft],
  );
  const outputSelectedColumns = useMemo(
    () => deriveSelectedOutputColumns(draft, datasets),
    [datasets, draft],
  );

  const addStep = (type: PipelineStep['type']) => {
    const defaults: Record<PipelineStep['type'], PipelineStep> = {
      filter: { type: 'filter', column: columns[0] ?? '', operator: 'not_null' },
      select: { type: 'select', columns: [...columns] },
      rename: { type: 'rename', from: columns[0] ?? '', to: '' },
      derive: {
        type: 'derive',
        column: 'derived_value',
        expression: { op: 'copy', column: columns[0] ?? '' },
      },
      aggregate: { type: 'aggregate', groupBy: [], aggregations: [{ column: '', fn: 'count', outputName: 'count' }] },
      distinct: { type: 'distinct' },
      join: {
        type: 'join',
        rightDatasetId: pickSecondaryDatasetId(datasets, draft.inputDatasetId, secondaryDatasetId),
        leftKey: columns[0] ?? '',
        rightKey: '',
        mode: 'inner',
      },
    };
    onDraftChange({ ...draft, steps: [...draft.steps, defaults[type]] });
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <input className={inputCls} placeholder="Pipeline name..." value={draft.name} onChange={(e) => onDraftChange({ ...draft, name: e.target.value })} />
        <input className={inputCls} placeholder="Description..." value={draft.description} onChange={(e) => onDraftChange({ ...draft, description: e.target.value })} />
      </div>
      <div>
        <div>
          <div className="mb-1 text-[11px]" style={{ color: 'var(--text-lo)' }}>Output dataset</div>
          <div className="grid grid-cols-2 gap-1">
            <input className={inputCls} placeholder="namespace..." value={draft.outputNamespace} onChange={(e) => onDraftChange({ ...draft, outputNamespace: e.target.value })} />
            <input className={inputCls} placeholder="name..." value={draft.outputName} onChange={(e) => onDraftChange({ ...draft, outputName: e.target.value })} />
          </div>
        </div>
      </div>

      <div className="rounded border p-3" style={{ borderColor: 'rgba(79,121,231,0.25)', background: 'rgba(79,121,231,0.05)' }}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="inline-flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: '#4F79E7' }}>
            <Sparkles size={13} />
            Smart Suggestions
          </div>
          {smartSummary && <Badge tone="neutral">{smartSummary}</Badge>}
        </div>

        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <DatasetSelect
            datasets={datasets}
            value={draft.inputDatasetId}
            onChange={(datasetId) => onDraftChange({ ...draft, inputDatasetId: datasetId, steps: [] })}
          />
          <DatasetSelect
            datasets={datasets}
            excludeDatasetId={draft.inputDatasetId}
            includeEmptyOption
            value={secondaryDatasetId}
            onChange={onSecondaryDatasetChange}
          />
          <ActionButton
            busy={suggesting}
            busyLabel="Suggesting..."
            label="Smart Suggest"
            onClick={onLoadSmartSuggestions}
          />
        </div>

        {suggestError && (
          <div
            className="mt-2 rounded border px-3 py-2 text-[12px]"
            style={{ borderColor: 'rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.06)', color: '#f87171' }}
          >
            {suggestError}
          </div>
        )}
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <div className="rounded border p-3" style={{ borderColor: 'rgb(var(--rim))', background: 'rgb(var(--ink) / 0.25)' }}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[12px] font-semibold" style={{ color: 'var(--text-hi)' }}>
              Input Preview
            </span>
            <div className="min-w-[240px] max-w-[320px]">
              <DatasetSelect
                datasets={datasets}
                value={draft.inputDatasetId}
                onChange={(datasetId) => onDraftChange({ ...draft, inputDatasetId: datasetId, steps: [] })}
              />
            </div>
          </div>
          <DataTable preview={inputPreview} fixedRows={10} />
        </div>

        <div className="rounded border p-3" style={{ borderColor: 'rgb(var(--rim))', background: 'rgb(var(--ink) / 0.25)' }}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[12px] font-semibold" style={{ color: 'var(--text-hi)' }}>
              Secondary Preview
            </span>
            <div className="min-w-[240px] max-w-[320px]">
              <DatasetSelect
                datasets={datasets}
                excludeDatasetId={draft.inputDatasetId}
                includeEmptyOption
                value={secondaryDatasetId}
                onChange={onSecondaryDatasetChange}
              />
            </div>
          </div>
          <DataTable preview={secondaryPreview} fixedRows={10} />
        </div>
      </div>

      <div className="rounded border p-3" style={{ borderColor: 'rgb(var(--rim))', background: 'rgb(var(--ink) / 0.25)' }}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[12px] font-semibold" style={{ color: 'var(--text-hi)' }}>
            Draft Output Preview
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {draftPreviewDiagnostics && (
              <Badge tone={draftPreviewDiagnostics.warning ? 'warning' : 'success'}>
                {`${draftPreviewDiagnostics.rowsIn} -> ${draftPreviewDiagnostics.rowsOut} rows`}
                {draftPreviewDiagnostics.newColumns.length > 0
                  ? ` | +${draftPreviewDiagnostics.newColumns.length} cols`
                  : ''}
              </Badge>
            )}
          </div>
        </div>
        {draftPreviewDiagnostics?.warning && (
          <div className="mb-2 rounded border px-3 py-2 text-[11px]"
            style={{ borderColor: 'rgba(251,191,36,0.3)', background: 'rgba(251,191,36,0.06)', color: '#fbbf24' }}>
            {draftPreviewDiagnostics.warning}
          </div>
        )}
        <DataTable
          allColumns={outputSourceColumns}
          fixedRows={10}
          onVisibleColumnsChange={(selectedColumns) => onDraftChange(
            applyOutputColumnsSelection(draft, datasets, selectedColumns),
          )}
          preview={draftOutputPreview}
          visibleColumns={outputSelectedColumns.length > 0 ? outputSelectedColumns : outputSourceColumns}
        />
      </div>

      <div>
        {(gluePlan || smartSuggestions.length > 0 || crosswalkProposals.length > 0 || crosswalkSummary) && (
        <div className="mb-4 rounded border p-3" style={{ borderColor: 'rgba(79,121,231,0.25)', background: 'rgba(79,121,231,0.05)' }}>
          {gluePlan && (
            <div
              className="mt-3 rounded border px-3 py-2"
              style={{
                borderColor: gluePlan.status === 'ready' ? 'rgba(34,197,94,0.25)' : 'rgba(251,191,36,0.3)',
                background: gluePlan.status === 'ready' ? 'rgba(34,197,94,0.05)' : 'rgba(251,191,36,0.05)',
              }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={
                      gluePlan.status === 'ready'
                        ? 'success'
                        : 'warning'
                    }>
                      AIP Glue Plan
                    </Badge>
                    <Badge tone={
                      gluePlan.confidence === 'high'
                        ? 'success'
                        : gluePlan.confidence === 'medium'
                          ? 'warning'
                          : 'neutral'
                    }>
                      {gluePlan.confidence}
                    </Badge>
                    <span className="text-[12px] font-medium" style={{ color: 'var(--text-hi)' }}>
                      {gluePlan.title}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] leading-5" style={{ color: 'var(--text-lo)' }}>
                    {gluePlan.summary}
                  </div>
                  <div className="mt-1 text-[11px] leading-5" style={{ color: 'var(--text-mid)' }}>
                    {gluePlan.explanation}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Badge tone="neutral">{gluePlan.steps.length} steps</Badge>
                    <Badge tone="neutral">{gluePlan.auxiliaryDatasets.length} temp datasets</Badge>
                    {gluePlan.diagnostics && (
                      <Badge tone={gluePlan.diagnostics.warning ? 'warning' : 'success'}>
                        {`${gluePlan.diagnostics.rowsIn} -> ${gluePlan.diagnostics.rowsOut}`}
                        {gluePlan.diagnostics.newColumns.length > 0
                          ? ` | +${gluePlan.diagnostics.newColumns.length} cols`
                          : ''}
                      </Badge>
                    )}
                    <Badge tone={gluePlan.status === 'ready' ? 'success' : 'warning'}>
                      {gluePlan.status}
                    </Badge>
                  </div>
                  {gluePlan.attempts.some((attempt) => attempt.issues.length > 0) && (
                    <div className="mt-2 text-[10px] leading-5" style={{ color: '#fbbf24' }}>
                      Retry-Loop: {gluePlan.attempts.map((attempt) => (
                        `#${attempt.attempt} ${attempt.issues.length === 0 ? 'ok' : attempt.issues[0]}`
                      )).join(' | ')}
                    </div>
                  )}
                  {gluePlan.preview && (
                    <div className="mt-2">
                      <DataTable preview={gluePlan.preview} fixedRows={10} />
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className={ghostBtnCls}
                  style={{ fontSize: '11px', padding: '3px 10px', whiteSpace: 'nowrap' }}
                  onClick={() => onApplyGluePlan(gluePlan)}
                  disabled={glueApplying}
                >
                  {glueApplying ? 'Applying...' : 'Apply Glue Plan'}
                </button>
              </div>
            </div>
          )}

          {smartSuggestions.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {smartSuggestions.map((suggestion, index) => (
                <div
                  key={`${suggestion.step.type}-${suggestion.label}-${index}`}
                  className="rounded border px-3 py-2"
                  style={{ borderColor: 'rgb(var(--rim))', background: 'rgb(var(--ink)/0.4)' }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={
                          suggestion.confidence === 'high'
                            ? 'success'
                            : suggestion.confidence === 'medium'
                              ? 'warning'
                              : 'neutral'
                        }>
                          {suggestion.confidence}
                        </Badge>
                        <span className="text-[12px] font-medium" style={{ color: 'var(--text-hi)' }}>
                          {suggestion.label}
                        </span>
                      </div>
                      <div className="mt-1 text-[11px] leading-5" style={{ color: 'var(--text-lo)' }}>
                        {suggestion.reason}
                      </div>
                    </div>
                    <button
                      type="button"
                      className={ghostBtnCls}
                      style={{ fontSize: '11px', padding: '3px 10px', whiteSpace: 'nowrap' }}
                      onClick={() => onApplySuggestion(suggestion)}
                    >
                      + Add step
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {crosswalkSummary && (
            <div className="mt-4 text-[11px]" style={{ color: 'var(--text-lo)' }}>
              {crosswalkSummary}
            </div>
          )}

          {crosswalkProposals.length > 0 && (
            <div className="mt-2 space-y-2">
              {crosswalkProposals.map((proposal) => (
                <div
                  key={proposal.id}
                  className="rounded border px-3 py-2"
                  style={{
                    borderColor: 'rgba(14,165,233,0.25)',
                    background: 'rgba(14,165,233,0.05)',
                  }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={proposal.confidence >= 0.9 ? 'success' : proposal.confidence >= 0.8 ? 'warning' : 'neutral'}>
                          Crosswalk {(proposal.confidence * 100).toFixed(0)}%
                        </Badge>
                        <span className="text-[12px] font-medium" style={{ color: 'var(--text-hi)' }}>
                          {proposal.leftColumn} {'->'} {proposal.rightColumn}
                        </span>
                        <span className="text-[11px]" style={{ color: 'var(--text-lo)' }}>
                          coverage {(proposal.coverage * 100).toFixed(0)}%
                        </span>
                      </div>
                      <div className="mt-1 text-[11px] leading-5" style={{ color: 'var(--text-lo)' }}>
                        {proposal.explanation}
                      </div>
                      {proposal.bridgeHint && (
                        <div className="mt-1 text-[10px]" style={{ color: 'var(--text-lo)' }}>
                          Bridge: {proposal.bridgeHint}
                        </div>
                      )}
                      {(proposal.sourceType || proposal.sourceUri) && (
                        <div className="mt-1 text-[10px]" style={{ color: 'var(--text-lo)' }}>
                          Quelle: {proposal.sourceType ?? 'unknown'}
                          {proposal.sourceUri ? ` | ${proposal.sourceUri}` : ''}
                        </div>
                      )}
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {proposal.mappings.slice(0, 6).map((mapping) => (
                          <span
                            key={`${proposal.id}-${mapping.leftValue}`}
                            className="rounded border px-1.5 py-0.5 text-[10px]"
                            style={{
                              borderColor: 'rgb(var(--rim))',
                              background: 'rgb(var(--ink) / 0.35)',
                              color: 'var(--text-mid)',
                            }}
                          >
                            {mapping.leftValue} {'->'} {mapping.rightValue ?? '?'}
                          </span>
                        ))}
                      </div>
                    </div>
                    <button
                      type="button"
                      className={ghostBtnCls}
                      style={{ fontSize: '11px', padding: '3px 10px', whiteSpace: 'nowrap' }}
                      onClick={() => onApproveCrosswalk(proposal)}
                      disabled={crosswalkApprovingId === proposal.id}
                    >
                      {crosswalkApprovingId === proposal.id
                        ? 'Creating...'
                        : 'Create crosswalk + add joins'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        )}

        <div className="mb-2 flex items-center justify-between">
          <span className="text-[12px]" style={{ color: 'var(--text-lo)' }}>Transform Steps</span>
          <div className="flex gap-1 flex-wrap">
            {(['filter', 'select', 'rename', 'aggregate', 'join'] as PipelineStep['type'][]).map((t) => (
              <button key={t} type="button" className={ghostBtnCls} style={{ fontSize: '11px', padding: '2px 8px' }} onClick={() => addStep(t)}>
                + {t}
              </button>
            ))}
          </div>
        </div>
        {draft.steps.length === 0 && (
          <div className="rounded border border-dashed py-6 text-center text-[12px]" style={{ borderColor: 'rgb(var(--rim))', color: 'var(--text-lo)' }}>
            Add steps to transform the input dataset
          </div>
        )}
        <div className="space-y-2">
          {draft.steps.map((step, i) => (
            <StepEditor
              key={i}
              step={step}
              index={i}
              columns={stepColumns[i] ?? columns}
              datasets={datasets}
              onUpdate={(s) => onDraftChange({ ...draft, steps: draft.steps.map((x, j) => j === i ? s : x) })}
              onRemove={() => onDraftChange({ ...draft, steps: draft.steps.filter((_, j) => j !== i) })}
            />
          ))}
        </div>
      </div>

      <div className="flex gap-2">
        <button type="button" className="rounded px-4 py-1.5 font-semibold text-[13px]" style={{ background: '#4F79E7', color: '#fff' }}
          onClick={() => {
            if (!draft.inputDatasetId) {
              onValidationError('Bitte zuerst ein Input-Dataset auswaehlen.');
              return;
            }

            const fallbackName = toPipelineSlug(
              datasets.find((dataset) => dataset.id === draft.inputDatasetId)?.name ?? 'pipeline',
              'pipeline',
            );
            const name = draft.name.trim() || fallbackName;
            const outputName = toPipelineSlug(draft.outputName || name, `${fallbackName}_out`);

            onSave({
              ...draft,
              name,
              outputName,
              outputNamespace: toPipelineSlug(draft.outputNamespace || 'derived', 'derived'),
            });
          }}>
          Save Pipeline
        </button>
        <button type="button" className={ghostBtnCls} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

export function PipelinesView({ onCopilotBindingChange }: PipelinesViewProps) {
  const [pipelines, setPipelines] = useState<PipelineDefinition[]>([]);
  const [datasets, setDatasets] = useState<DatasetRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runs, setRuns] = useState<PipelineRun[]>([]);
  const [creating, setCreating] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<PipelineDraft>(() => createInitialDraft([]));
  const [secondaryDatasetId, setSecondaryDatasetId] = useState('');
  const [smartSuggestions, setSmartSuggestions] = useState<SuggestedPipelineStep[]>([]);
  const [smartSummary, setSmartSummary] = useState('');
  const [crosswalkProposals, setCrosswalkProposals] = useState<CrosswalkDatasetProposal[]>([]);
  const [crosswalkSummary, setCrosswalkSummary] = useState('');
  const [crosswalkApprovingId, setCrosswalkApprovingId] = useState<string | null>(null);
  const [gluePlan, setGluePlan] = useState<PipelineGluePlanResult | null>(null);
  const [glueApplying, setGlueApplying] = useState(false);
  const [copilotDatasetSamples, setCopilotDatasetSamples] = useState<PipelineSkillContext['datasetSamples']>([]);
  const [inputPreview, setInputPreview] = useState<DatasetPreviewResult | null>(null);
  const [secondaryPreview, setSecondaryPreview] = useState<DatasetPreviewResult | null>(null);
  const [draftOutputPreview, setDraftOutputPreview] = useState<DatasetPreviewResult | null>(null);
  const [draftPreviewDiagnostics, setDraftPreviewDiagnostics] = useState<PipelinePreviewDiagnostics | null>(null);
  const [outputPreview, setOutputPreview] = useState<DatasetPreviewResult | null>(null);
  const [outputPreviewColumns, setOutputPreviewColumns] = useState<string[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([fetchPipelines(), fetchDatasets()])
      .then(([p, d]) => {
        setPipelines(p);
        setDatasets(d);
        setDraft((current) => (
          current.inputDatasetId && d.some((dataset) => dataset.id === current.inputDatasetId)
            ? current
            : createInitialDraft(d)
        ));
        setSecondaryDatasetId((current) => pickSecondaryDatasetId(d, d[0]?.id ?? '', current));
        if (p[0]) setSelectedId(p[0].id);
      })
      .catch((loadError) => {
        console.error(loadError);
        setError(loadError instanceof Error ? loadError.message : 'Failed to load pipelines');
      });
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setRuns([]);
      return;
    }
    fetchPipelineRuns(selectedId)
      .then(setRuns)
      .catch((loadError) => {
        console.error(loadError);
        setError(loadError instanceof Error ? loadError.message : 'Failed to load runs');
      });
  }, [selectedId]);

  const selected = pipelines.find((p) => p.id === selectedId) ?? null;
  const activeDraft = useMemo(
    () => (creating || !selected ? draft : pipelineToDraft(selected)),
    [creating, draft, selected],
  );
  const copilotDatasetIds = useMemo(
    () => [...new Set([
      activeDraft.inputDatasetId,
      secondaryDatasetId,
      ...activeDraft.steps
        .filter((step): step is Extract<PipelineStep, { type: 'join' }> => step.type === 'join')
        .map((step) => step.rightDatasetId),
    ].filter((datasetId) => datasetId.trim().length > 0))],
    [activeDraft.inputDatasetId, activeDraft.steps, secondaryDatasetId],
  );
  const pipelineSkillContext = useMemo<PipelineSkillContext>(() => ({
    datasets,
    datasetSamples: copilotDatasetSamples,
    crosswalkProposals,
    draftPreview: draftOutputPreview,
    draftPreviewDiagnostics,
    draft: activeDraft,
    mode: creating ? 'create-draft' : 'view-existing',
    selectedPipeline: selected,
    lastError: suggestError ?? error,
  }), [activeDraft, copilotDatasetSamples, creating, crosswalkProposals, datasets, draftOutputPreview, draftPreviewDiagnostics, error, selected, suggestError]);

  useEffect(() => {
    setSecondaryDatasetId((current) => pickSecondaryDatasetId(datasets, draft.inputDatasetId, current));
    setSmartSuggestions([]);
    setSmartSummary('');
    setCrosswalkProposals([]);
    setCrosswalkSummary('');
    setGluePlan(null);
    setSuggestError(null);
  }, [datasets, draft.inputDatasetId]);

  useEffect(() => {
    if (copilotDatasetIds.length === 0) {
      setCopilotDatasetSamples([]);
      return;
    }

    let cancelled = false;

    Promise.all(
      copilotDatasetIds.map(async (datasetId) => {
        const [dataset, preview] = await Promise.all([
          Promise.resolve(datasets.find((entry) => entry.id === datasetId) ?? null),
          fetchDatasetPreview(datasetId, { limit: 8 }),
        ]);

        return dataset
          ? {
              datasetId: dataset.id,
              datasetName: dataset.name,
              namespace: dataset.namespace,
              columns: preview.columns,
              rows: preview.rows.slice(0, 8),
            }
          : null;
      }),
    )
      .then((samples) => {
        if (!cancelled) {
          setCopilotDatasetSamples(samples.filter((sample): sample is PipelineSkillContext['datasetSamples'][number] => sample !== null));
        }
      })
      .catch((sampleError) => {
        if (!cancelled) {
          console.error(sampleError);
          setCopilotDatasetSamples([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [copilotDatasetIds, datasets]);

  useEffect(() => {
    if (!activeDraft.inputDatasetId) {
      setInputPreview(null);
      return;
    }

    let cancelled = false;
    fetchDatasetPreview(activeDraft.inputDatasetId, { limit: 5000 })
      .then((preview) => {
        if (!cancelled) setInputPreview(preview);
      })
      .catch((previewError) => {
        console.error(previewError);
        if (!cancelled) setInputPreview(null);
      });

    return () => {
      cancelled = true;
    };
  }, [activeDraft.inputDatasetId]);

  useEffect(() => {
    if (!secondaryDatasetId) {
      setSecondaryPreview(null);
      return;
    }

    let cancelled = false;
    fetchDatasetPreview(secondaryDatasetId, { limit: 5000 })
      .then((preview) => {
        if (!cancelled) setSecondaryPreview(preview);
      })
      .catch((previewError) => {
        console.error(previewError);
        if (!cancelled) setSecondaryPreview(null);
      });

    return () => {
      cancelled = true;
    };
  }, [secondaryDatasetId]);

  useEffect(() => {
    if (!selected?.lastOutputDatasetId) {
      setOutputPreview(null);
      setOutputPreviewColumns([]);
      return;
    }

    let cancelled = false;
    fetchDatasetPreview(selected.lastOutputDatasetId, { limit: 5000 })
      .then((preview) => {
        if (cancelled) return;
        setOutputPreview(preview);
        setOutputPreviewColumns((current) => {
          const next = current.filter((column) => preview.columns.includes(column));
          return next.length > 0 ? next : preview.columns;
        });
      })
      .catch((previewError) => {
        console.error(previewError);
        if (!cancelled) {
          setOutputPreview(null);
          setOutputPreviewColumns([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selected?.lastOutputDatasetId]);

  useEffect(() => {
    if (!creating || !activeDraft.inputDatasetId) {
      setDraftOutputPreview(null);
      setDraftPreviewDiagnostics(null);
      return;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      previewPipelineDraft({
        inputDatasetId: activeDraft.inputDatasetId,
        steps: activeDraft.steps,
        limit: 5000,
      })
        .then((result) => {
          if (cancelled) return;
          setDraftOutputPreview(result.preview);
          setDraftPreviewDiagnostics(result.diagnostics);
        })
        .catch((previewError) => {
          if (cancelled) return;
          console.error(previewError);
          setDraftOutputPreview(null);
          setDraftPreviewDiagnostics({
            rowsIn: 0,
            rowsOut: 0,
            changedRows: 0,
            newColumns: [],
            warning: previewError instanceof Error
              ? `Draft preview failed: ${previewError.message}`
              : 'Draft preview failed.',
          });
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [activeDraft.inputDatasetId, activeDraft.steps, creating]);

  const loadSmartSuggestions = useCallback(async (
    primaryDatasetId = draft.inputDatasetId,
    secondaryOverride = secondaryDatasetId,
  ) => {
    if (!primaryDatasetId) return 'No input dataset selected.';

    setSuggesting(true);
    setSuggestError(null);
    try {
      const [pipelineResult, crosswalkResult] = await Promise.all([
        suggestPipelineSteps(primaryDatasetId, secondaryOverride || undefined),
        secondaryOverride
          ? suggestCrosswalks(primaryDatasetId, secondaryOverride)
          : Promise.resolve({ items: [], summary: 'Kein Secondary Dataset fuer Crosswalk-Suche gesetzt.' }),
      ]);
      setSmartSuggestions(pipelineResult.suggestions);
      setSmartSummary(pipelineResult.summary);
      setCrosswalkProposals(crosswalkResult.items);
      setCrosswalkSummary(crosswalkResult.summary);

      try {
        const glueResult = await planPipelineGlue({
          inputDatasetId: primaryDatasetId,
          secondaryDatasetIds: secondaryOverride ? [secondaryOverride] : [],
          currentSteps: draft.steps,
          outputNamespace: draft.outputNamespace,
          outputName: draft.outputName || toPipelineSlug(
            datasets.find((dataset) => dataset.id === primaryDatasetId)?.name ?? 'glue_result',
            'glue_result',
          ),
          intent: secondaryOverride
            ? `Find a meaningful multi-step glue plan between ${primaryDatasetId} and ${secondaryOverride}, using auxiliary bridge/live reference datasets if needed.`
            : `Find a meaningful multi-step glue plan for ${primaryDatasetId}, using auxiliary bridge/live reference datasets if needed.`,
          maxAttempts: 2,
          crosswalkHints: crosswalkResult.items,
        });
        setGluePlan(glueResult);
        return `Loaded ${pipelineResult.suggestions.length} smart suggestions, ${crosswalkResult.items.length} crosswalk proposals, and one AIP glue plan.`;
      } catch (glueError) {
        console.error(glueError);
        setGluePlan(null);
        setSuggestError(glueError instanceof Error ? glueError.message : 'AIP glue planning failed.');
        return `Loaded ${pipelineResult.suggestions.length} smart suggestions and ${crosswalkResult.items.length} crosswalk proposals. AIP glue planning failed.`;
      }
    } catch (suggestionError) {
      const message = suggestionError instanceof Error ? suggestionError.message : 'Suggest failed';
      setSuggestError(message);
      setSmartSuggestions([]);
      setSmartSummary('');
      setCrosswalkProposals([]);
      setCrosswalkSummary('');
      setGluePlan(null);
      throw new Error(message);
    } finally {
      setSuggesting(false);
    }
  }, [datasets, draft.inputDatasetId, draft.outputName, draft.outputNamespace, draft.steps, secondaryDatasetId]);

  const handleApproveCrosswalk = useCallback(async (proposal: CrosswalkDatasetProposal) => {
    setCrosswalkApprovingId(proposal.id);
    setError(null);
    try {
      const result = await materializeCrosswalk(proposal);
      setDatasets((current) => [
        ...current,
        result.dataset,
        ...(result.augmentedRightDataset ? [result.augmentedRightDataset] : []),
      ].sort((a, b) => a.name.localeCompare(b.name)));
      setDraft((current) => ({
        ...current,
        steps: [...current.steps, result.joinPlan.firstJoin, result.joinPlan.secondJoin],
      }));
      setCreating(true);
      setSelectedId(null);
      setSmartSummary(result.augmentedRightDataset
        ? `Crosswalk dataset ${result.dataset.namespace}/${result.dataset.name} und Augmented-Right ${result.augmentedRightDataset.namespace}/${result.augmentedRightDataset.name} erstellt. Join-Steps wurden hinzugefuegt.`
        : `Crosswalk dataset ${result.dataset.namespace}/${result.dataset.name} created and join steps added.`);
    } catch (crosswalkError) {
      setError(crosswalkError instanceof Error ? crosswalkError.message : 'Crosswalk materialization failed');
    } finally {
      setCrosswalkApprovingId(null);
    }
  }, []);

  const handleApplyGluePlan = useCallback(async (plan: PipelineGluePlanResult) => {
    setGlueApplying(true);
    setError(null);

    try {
      const tempIdMap = new Map<string, string>();
      const createdDatasets: DatasetRecord[] = [];

      for (const datasetDraft of plan.auxiliaryDatasets) {
        const createdDataset = datasetDraft.connectorId === 'inline' || datasetDraft.rows
          ? await uploadInlineDataset(datasetDraft.rows ?? [], {
            name: datasetDraft.name,
            namespace: datasetDraft.namespace,
            description: datasetDraft.description,
          })
          : await registerConnectorDataset({
            name: datasetDraft.name,
            namespace: datasetDraft.namespace,
            description: datasetDraft.description,
            connectorId: datasetDraft.connectorId,
            mode: datasetDraft.mode,
            source: datasetDraft.source ?? {},
          });

        tempIdMap.set(datasetDraft.tempId, createdDataset.id);
        createdDatasets.push(createdDataset);
      }

      const remappedSteps = plan.steps.map((step) => (
        step.type === 'join' && tempIdMap.has(step.rightDatasetId)
          ? { ...step, rightDatasetId: tempIdMap.get(step.rightDatasetId)! }
          : structuredClone(step)
      ));

      setDatasets((current) => [
        ...current,
        ...createdDatasets,
      ].sort((left, right) => left.name.localeCompare(right.name)));
      setDraft((current) => ({
        ...current,
        outputNamespace: plan.outputNamespace,
        outputName: plan.outputName,
        steps: remappedSteps,
      }));
      setCreating(true);
      setSelectedId(null);
      setSmartSummary(`AIP Glue Plan angewendet: ${plan.title}`);
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : 'Glue plan apply failed');
    } finally {
      setGlueApplying(false);
    }
  }, []);

  const applyPipelineProposal = useCallback(async (proposal: unknown) => {
    if (!isPipelineProposal(proposal)) {
      throw new Error('Pipeline proposal payload is invalid.');
    }

    const validation = validatePipelineProposalAgainstContext(proposal, pipelineSkillContext);
    if (!validation.ok) {
      throw new Error(validation.issues.join(' '));
    }

    let nextDraft = structuredClone(pipelineSkillContext.draft);
    let nextSecondary = pickSecondaryDatasetId(
      datasets,
      nextDraft.inputDatasetId,
      secondaryDatasetId,
    );
    const applied: string[] = [];

    for (const action of proposal.actions) {
      if (action.type === 'setInputDataset') {
        nextDraft = { ...nextDraft, inputDatasetId: action.datasetId, steps: [] };
        nextSecondary = pickSecondaryDatasetId(datasets, action.datasetId, nextSecondary);
        applied.push(`set input dataset to ${action.datasetId}`);
      }

      if (action.type === 'setOutputDataset') {
        nextDraft = {
          ...nextDraft,
          outputNamespace: action.namespace,
          outputName: action.name,
        };
        applied.push(`set output to ${action.namespace}/${action.name}`);
      }

      if (action.type === 'addStep') {
        nextDraft = { ...nextDraft, steps: [...nextDraft.steps, structuredClone(action.step)] };
        applied.push(`added ${action.step.type} step`);
      }

      if (action.type === 'updateStep') {
        nextDraft = {
          ...nextDraft,
          steps: nextDraft.steps.map((entry, index) => (
            index === action.index ? structuredClone(action.step) : entry
          )),
        };
        applied.push(`updated step ${action.index + 1}`);
      }

      if (action.type === 'removeStep') {
        nextDraft = {
          ...nextDraft,
          steps: nextDraft.steps.filter((_, index) => index !== action.index),
        };
        applied.push(`removed step ${action.index + 1}`);
      }

      if (action.type === 'replaceDraft') {
        nextDraft = structuredClone(action.draft);
        nextSecondary = pickSecondaryDatasetId(datasets, nextDraft.inputDatasetId, nextSecondary);
        applied.push('replaced draft');
      }

      if (action.type === 'runSuggest') {
        const summary = await loadSmartSuggestions(
          action.primaryDatasetId,
          action.secondaryDatasetId ?? '',
        );
        if (action.secondaryDatasetId !== undefined) {
          nextSecondary = action.secondaryDatasetId;
        }
        applied.push(summary);
      }

      if (action.type === 'validateDraft') {
        applied.push('validated draft');
      }
    }

    setDraft(nextDraft);
    setSecondaryDatasetId(nextSecondary);
    setCreating(true);
    setSelectedId(null);
    setError(null);

    return applied.length > 0 ? applied.join(' | ') : 'No draft changes applied.';
  }, [datasets, loadSmartSuggestions, pipelineSkillContext, secondaryDatasetId]);

  useEffect(() => {
    if (!onCopilotBindingChange) return undefined;

    onCopilotBindingChange({
      skillId: 'pipelines',
      label: 'Pipeline Skill',
      contextSummary: creating
        ? `${draft.steps.length} draft steps | ${datasets.length} datasets`
        : selected
          ? `${selected.name} | ${selected.steps.length} steps`
          : `${datasets.length} datasets`,
      buildPromptContext: () => buildPipelineSkillPrompt(pipelineSkillContext),
      parseAssistantMessage: (content: string) => parsePipelineProposalMessage(content, pipelineSkillContext),
      renderProposal: renderPipelineProposal,
      applyProposal: applyPipelineProposal,
    });

    return () => onCopilotBindingChange(null);
  }, [
    applyPipelineProposal,
    creating,
    datasets.length,
    draft.steps.length,
    onCopilotBindingChange,
    pipelineSkillContext,
    selected,
  ]);

  const handleSave = useCallback(async (data: PipelineDraft) => {
    setError(null);
    try {
      const created = await createPipeline(data);
      setPipelines((prev) => [...prev, created]);
      setSelectedId(created.id);
      setDraft(createInitialDraft(datasets));
      setSecondaryDatasetId(pickSecondaryDatasetId(datasets, datasets[0]?.id ?? ''));
      setSmartSuggestions([]);
      setSmartSummary('');
      setCrosswalkProposals([]);
      setCrosswalkSummary('');
      setSuggestError(null);
      setCreating(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  }, [datasets]);

  const handleRun = useCallback(async () => {
    if (!selectedId) return;
    setRunning(true); setError(null);
    try {
      await runPipeline(selectedId);
      const [updated, newRuns] = await Promise.all([fetchPipelines(), fetchPipelineRuns(selectedId)]);
      setPipelines(updated);
      setRuns(newRuns);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Run failed');
    } finally {
      setRunning(false);
    }
  }, [selectedId]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await deletePipeline(id);
      setPipelines((prev) => {
        const next = prev.filter((p) => p.id !== id);
        if (selectedId === id) setSelectedId(next[0]?.id ?? null);
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }, [selectedId]);

  const handleStartCreate = useCallback(() => {
    setDraft(createInitialDraft(datasets));
    setSecondaryDatasetId(pickSecondaryDatasetId(datasets, datasets[0]?.id ?? ''));
    setSmartSuggestions([]);
    setSmartSummary('');
    setCrosswalkProposals([]);
    setCrosswalkSummary('');
    setSuggestError(null);
    setCreating(true);
    setSelectedId(null);
    setError(null);
  }, [datasets]);

  const handleCancelCreate = useCallback(() => {
    setCreating(false);
    setSmartSuggestions([]);
    setSmartSummary('');
    setCrosswalkProposals([]);
    setCrosswalkSummary('');
    setSuggestError(null);
    setSelectedId((current) => current ?? pipelines[0]?.id ?? null);
  }, [pipelines]);

  return (
    <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
      {/* Pipeline list */}
      <Card
        title="Pipelines"
        action={
          <button type="button" className="rounded border px-2.5 py-1 text-[11px] font-semibold transition"
            style={{ borderColor: 'rgba(79,121,231,0.4)', background: 'rgba(79,121,231,0.1)', color: '#4F79E7' }}
            onClick={handleStartCreate}>
            <Plus size={11} className="inline mr-1" />New
          </button>
        }
      >
        <div className="space-y-1">
          {pipelines.length === 0 && !creating && (
            <div className="py-6 text-center text-[12px]" style={{ color: 'var(--text-lo)' }}>
              No pipelines yet. Click "New" to create one.
            </div>
          )}
          {pipelines.map((p) => {
            const active = selectedId === p.id;
            return (
              <button key={p.id} type="button"
                className="relative w-full text-left rounded border transition"
                style={{ padding: '8px 12px 8px 14px', borderColor: active ? 'rgba(79,121,231,0.35)' : 'transparent', background: active ? 'rgba(79,121,231,0.05)' : 'transparent' }}
                onClick={() => {
                  setSelectedId(p.id);
                  setCreating(false);
                  setSmartSuggestions([]);
                  setSmartSummary('');
                  setCrosswalkProposals([]);
                  setCrosswalkSummary('');
                  setSuggestError(null);
                }}>
                {active && <span className="absolute inset-y-0 left-0 w-[2px] rounded-r" style={{ background: '#4F79E7' }} />}
                <div className="text-[13px] font-medium" style={{ color: 'var(--text-hi)' }}>{p.name}</div>
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-lo)' }}>{p.steps.length} steps · → {p.outputNamespace}/{p.outputName}</div>
              </button>
            );
          })}
        </div>
      </Card>

      {/* Detail / editor */}
      <div className="space-y-4">
        {error && (
          <div className="rounded border px-4 py-3 text-[13px]" style={{ borderColor: 'rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.06)', color: '#f87171' }}>{error}</div>
        )}

        {creating && (
          <Card title="New Pipeline">
            <PipelineEditor
              crosswalkApprovingId={crosswalkApprovingId}
              crosswalkProposals={crosswalkProposals}
              crosswalkSummary={crosswalkSummary}
              datasets={datasets}
              draft={draft}
              draftOutputPreview={draftOutputPreview}
              draftPreviewDiagnostics={draftPreviewDiagnostics}
              glueApplying={glueApplying}
              gluePlan={gluePlan}
              inputPreview={inputPreview}
              onApplySuggestion={(suggestion) => setDraft((current) => ({
                ...current,
                steps: [...current.steps, structuredClone(suggestion.step)],
              }))}
              onApplyGluePlan={handleApplyGluePlan}
              onCancel={handleCancelCreate}
              onDraftChange={setDraft}
              onApproveCrosswalk={handleApproveCrosswalk}
              onLoadSmartSuggestions={() => void loadSmartSuggestions()}
              onSave={handleSave}
              onSecondaryDatasetChange={setSecondaryDatasetId}
              onValidationError={setError}
              secondaryPreview={secondaryPreview}
              secondaryDatasetId={secondaryDatasetId}
              smartSuggestions={smartSuggestions}
              smartSummary={smartSummary}
              suggestError={suggestError}
              suggesting={suggesting}
            />
          </Card>
        )}

        {selected && !creating && (
          <>
            <Card
              title={selected.name}
              action={
                <div className="flex gap-2">
                  <ActionButton onClick={() => void handleRun()} busy={running} busyLabel="Running…" label="Run" />
                  <button type="button" className="rounded p-1.5 transition hover:bg-[rgba(239,68,68,0.1)] hover:text-[#f87171]"
                    style={{ color: 'var(--text-lo)' }} onClick={() => void handleDelete(selected.id)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              }
            >
              <div className="mb-3 flex flex-wrap gap-2 text-[12px]" style={{ color: 'var(--text-lo)' }}>
                <span>Input: <span style={{ color: 'var(--text-hi)' }}>{datasets.find((d) => d.id === selected.inputDatasetId)?.name ?? selected.inputDatasetId}</span></span>
                <span>→</span>
                <span>Output: <span style={{ color: 'var(--text-hi)' }}>{selected.outputNamespace}/{selected.outputName}</span></span>
                {selected.lastOutputDatasetId && <Badge tone="success">Last output: {selected.lastOutputDatasetId.slice(0, 8)}</Badge>}
              </div>
              <div className="space-y-1.5">
                {selected.steps.map((step, i) => (
                  <div key={i} className="flex items-center gap-2 rounded border px-3 py-2 text-[12px]"
                    style={{ borderColor: 'rgb(var(--rim))', background: 'rgb(var(--ink)/0.5)' }}>
                    <span className="font-mono px-1.5 py-0.5 rounded text-[10px]" style={{ background: 'rgb(var(--rim))', color: 'var(--text-mid)' }}>{i + 1}</span>
                    <span style={{ color: '#4F79E7', fontWeight: 600 }}>{step.type}</span>
                    <span style={{ color: 'var(--text-lo)' }}>
                      {step.type === 'filter' && `${step.column} ${step.operator}${step.value ? ` "${step.value}"` : ''}`}
                      {step.type === 'select' && `[${step.columns.join(', ')}]`}
                      {step.type === 'rename' && `${step.from} → ${step.to}`}
                      {step.type === 'aggregate' && `group by [${step.groupBy.join(', ')}]`}
                      {step.type === 'join' && `${step.mode} on ${step.leftKey}=${step.rightKey}`}
                    </span>
                  </div>
                ))}
              </div>
            </Card>

            <div className="grid gap-4 xl:grid-cols-2">
              <Card title="Input Preview">
                <div className="mb-2 text-[12px]" style={{ color: 'var(--text-lo)' }}>
                  {datasets.find((dataset) => dataset.id === selected.inputDatasetId)
                    ? `${datasets.find((dataset) => dataset.id === selected.inputDatasetId)?.namespace}/${datasets.find((dataset) => dataset.id === selected.inputDatasetId)?.name}`
                    : selected.inputDatasetId}
                </div>
                <DataTable preview={inputPreview} fixedRows={10} />
              </Card>

              <Card title="Output Preview">
                <div className="mb-2 text-[12px]" style={{ color: 'var(--text-lo)' }}>
                  {selected.lastOutputDatasetId
                    ? selected.lastOutputDatasetId
                    : 'Pipeline noch nicht gelaufen.'}
                </div>
                <DataTable
                  fixedRows={10}
                  onVisibleColumnsChange={setOutputPreviewColumns}
                  preview={outputPreview}
                  visibleColumns={outputPreviewColumns}
                />
              </Card>
            </div>

            {/* Run history */}
            <Card title="Run History">
              {runs.length === 0 ? (
                <div className="py-4 text-center text-[12px]" style={{ color: 'var(--text-lo)' }}>
                  No runs yet. Click "Run" to execute this pipeline.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {runs.map((run) => (
                    <div key={run.id} className="flex items-center justify-between gap-3 rounded border px-3 py-2 text-[12px]"
                      style={{ borderColor: 'rgb(var(--rim))' }}>
                      <div className="flex items-center gap-2">
                        <Badge tone={run.status === 'succeeded' ? 'success' : run.status === 'failed' ? 'danger' : 'warning'}>
                          {run.status}
                        </Badge>
                        <span style={{ color: 'var(--text-lo)' }}>
                          {new Date(run.startedAt).toLocaleTimeString()} · {run.rowsIn}→{run.rowsOut} rows
                        </span>
                      </div>
                      {run.error && <span className="truncate text-[11px]" style={{ color: '#f87171' }}>{run.error}</span>}
                      {run.outputDatasetId && (
                        <span className="font-mono text-[10px]" style={{ color: 'var(--text-lo)' }}>{run.outputDatasetId.slice(0, 8)}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
