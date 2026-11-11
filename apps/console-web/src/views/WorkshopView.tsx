import { useCallback, useEffect, useState } from 'react';
import { GripVertical, Plus, Trash2, Eye } from 'lucide-react';

import {
  fetchChecks,
  fetchDatasets,
  fetchDatasetPreview,
  fetchPipelines,
  runCheck,
  runPipeline,
  saveView,
  fetchSavedViews,
  type CheckDefinition,
  type DatasetRecord,
  type DatasetPreviewResult,
  type PipelineDefinition,
  type SavedViewRecord,
} from '../api';
import { Badge, Card, DataTable, inputCls, selectCls, ghostBtnCls } from '../components/ui';

// ── Block types ───────────────────────────────────────────────────────────────

type BlockType = 'dataset-preview' | 'metric-card' | 'check-status' | 'pipeline-runner' | 'markdown';

interface BlockBase { id: string; type: BlockType; title: string; }
interface DatasetPreviewBlock extends BlockBase { type: 'dataset-preview'; datasetId: string; }
interface MetricCardBlock extends BlockBase { type: 'metric-card'; datasetId: string; column: string; fn: 'count' | 'sum' | 'avg' | 'min' | 'max'; }
interface CheckStatusBlock extends BlockBase { type: 'check-status'; checkId: string; }
interface PipelineRunnerBlock extends BlockBase { type: 'pipeline-runner'; pipelineId: string; }
interface MarkdownBlock extends BlockBase { type: 'markdown'; content: string; }

type Block = DatasetPreviewBlock | MetricCardBlock | CheckStatusBlock | PipelineRunnerBlock | MarkdownBlock;

interface WorkshopApp {
  id: string;
  name: string;
  blocks: Block[];
}

function randomId() { return Math.random().toString(36).slice(2, 9); }

// ── Block renderers ───────────────────────────────────────────────────────────

function DatasetPreviewBlockView({ block, datasets }: { block: DatasetPreviewBlock; datasets: DatasetRecord[] }) {
  const [preview, setPreview] = useState<DatasetPreviewResult | null>(null);
  const dataset = datasets.find((d) => d.id === block.datasetId);

  useEffect(() => {
    if (!block.datasetId) return;
    fetchDatasetPreview(block.datasetId, { limit: 10 }).then(setPreview).catch(console.error);
  }, [block.datasetId]);

  return (
    <div>
      {dataset && <div className="mb-2 text-[11px]" style={{ color: 'var(--text-lo)' }}>{dataset.namespace}/{dataset.name}</div>}
      <DataTable preview={preview} />
    </div>
  );
}

function MetricCardBlockView({ block, datasets }: { block: MetricCardBlock; datasets: DatasetRecord[] }) {
  const [value, setValue] = useState<string | null>(null);

  useEffect(() => {
    if (!block.datasetId || !block.column) return;
    fetchDatasetPreview(block.datasetId, { limit: 100_000 }).then((p) => {
      const nums = p.rows.map((r) => Number(r[block.column])).filter((n) => !Number.isNaN(n));
      let result = 0;
      switch (block.fn) {
        case 'count': result = p.rows.length; break;
        case 'sum': result = nums.reduce((a, b) => a + b, 0); break;
        case 'avg': result = nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : 0; break;
        case 'min': result = nums.length > 0 ? Math.min(...nums) : 0; break;
        case 'max': result = nums.length > 0 ? Math.max(...nums) : 0; break;
      }
      setValue(block.fn === 'avg' ? result.toFixed(2) : result.toLocaleString('de-DE'));
    }).catch(console.error);
  }, [block.datasetId, block.column, block.fn]);

  return (
    <div className="flex flex-col items-center justify-center py-4">
      <div className="tabular-nums font-semibold" style={{ fontSize: '36px', color: 'var(--text-hi)' }}>{value ?? '—'}</div>
      <div className="mt-1 text-[12px]" style={{ color: 'var(--text-lo)' }}>
        {block.fn}({block.column}) · {datasets.find((d) => d.id === block.datasetId)?.name ?? block.datasetId}
      </div>
    </div>
  );
}

function CheckStatusBlockView({ block, checks }: { block: CheckStatusBlock; checks: CheckDefinition[] }) {
  const check = checks.find((c) => c.id === block.checkId);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState(check?.latestRun?.status ?? null);

  if (!check) return <div className="text-[12px]" style={{ color: 'var(--text-lo)' }}>Check not found.</div>;

  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <div className="text-[13px] font-medium" style={{ color: 'var(--text-hi)' }}>{check.name}</div>
        <div className="text-[11px]" style={{ color: 'var(--text-lo)' }}>{check.rules.length} rules</div>
      </div>
      <div className="flex items-center gap-2">
        {status && <Badge tone={status === 'passed' ? 'success' : 'danger'}>{status}</Badge>}
        <button type="button" className="rounded border px-2.5 py-1 text-[11px] font-medium transition"
          style={{ borderColor: 'rgba(79,121,231,0.3)', color: '#4F79E7', opacity: running ? 0.5 : 1 }}
          disabled={running}
          onClick={async () => {
            setRunning(true);
            try { const run = await runCheck(check.id); setStatus(run.status); } finally { setRunning(false); }
          }}>
          {running ? 'Running…' : 'Run'}
        </button>
      </div>
    </div>
  );
}

function PipelineRunnerBlockView({ block, pipelines, datasets }: { block: PipelineRunnerBlock; pipelines: PipelineDefinition[]; datasets: DatasetRecord[] }) {
  const pipeline = pipelines.find((p) => p.id === block.pipelineId);
  const [running, setRunning] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);

  if (!pipeline) return <div className="text-[12px]" style={{ color: 'var(--text-lo)' }}>Pipeline not found.</div>;

  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <div className="text-[13px] font-medium" style={{ color: 'var(--text-hi)' }}>{pipeline.name}</div>
        <div className="text-[11px]" style={{ color: 'var(--text-lo)' }}>
          {datasets.find((d) => d.id === pipeline.inputDatasetId)?.name ?? pipeline.inputDatasetId} → {pipeline.outputNamespace}/{pipeline.outputName}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {lastResult && <span className="text-[11px]" style={{ color: 'var(--text-lo)' }}>{lastResult}</span>}
        <button type="button" className="rounded px-3 py-1.5 text-[12px] font-semibold transition"
          style={{ background: '#4F79E7', color: '#fff', opacity: running ? 0.5 : 1 }}
          disabled={running}
          onClick={async () => {
            setRunning(true);
            try {
              const { run } = await runPipeline(pipeline.id);
              setLastResult(`${run.rowsIn}→${run.rowsOut} rows`);
            } finally { setRunning(false); }
          }}>
          {running ? 'Running…' : 'Run Pipeline'}
        </button>
      </div>
    </div>
  );
}

function MarkdownBlockView({ block }: { block: MarkdownBlock }) {
  // Very simple: just render as preformatted text — no external markdown dep needed
  return (
    <div className="whitespace-pre-wrap leading-6" style={{ fontSize: '13px', color: 'var(--text-hi)' }}>
      {block.content}
    </div>
  );
}

// ── Block editor ──────────────────────────────────────────────────────────────

function BlockEditor({ block, datasets, checks, pipelines, onChange, onRemove }: {
  block: Block;
  datasets: DatasetRecord[];
  checks: CheckDefinition[];
  pipelines: PipelineDefinition[];
  onChange: (b: Block) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded border p-3 space-y-2" style={{ borderColor: 'rgb(var(--rim))', background: 'rgb(var(--ink)/0.5)' }}>
      <div className="flex items-center gap-2">
        <GripVertical size={14} style={{ color: 'var(--text-lo)' }} />
        <select className={selectCls} style={{ maxWidth: '140px', fontSize: '12px', padding: '3px 28px 3px 8px' }}
          value={block.type}
          onChange={(e) => {
            const t = e.target.value as BlockType;
            const { id: bid, title } = block;
            const defaults: Record<BlockType, Block> = {
              'dataset-preview': { id: bid, title, type: 'dataset-preview', datasetId: datasets[0]?.id ?? '' },
              'metric-card': { id: bid, title, type: 'metric-card', datasetId: datasets[0]?.id ?? '', column: '', fn: 'count' },
              'check-status': { id: bid, title, type: 'check-status', checkId: checks[0]?.id ?? '' },
              'pipeline-runner': { id: bid, title, type: 'pipeline-runner', pipelineId: pipelines[0]?.id ?? '' },
              'markdown': { id: bid, title, type: 'markdown', content: '# Heading\n\nText…' },
            };
            onChange(defaults[t]);
          }}>
          <option value="dataset-preview">Dataset Preview</option>
          <option value="metric-card">Metric Card</option>
          <option value="check-status">Check Status</option>
          <option value="pipeline-runner">Pipeline Runner</option>
          <option value="markdown">Markdown Note</option>
        </select>
        <input className={`${inputCls} flex-1`} style={{ fontSize: '12px', padding: '3px 8px' }}
          placeholder="Block title…" value={block.title}
          onChange={(e) => onChange({ ...block, title: e.target.value } as Block)} />
        <button type="button" onClick={onRemove} className="rounded p-1 hover:bg-[rgba(239,68,68,0.1)] hover:text-[#f87171] transition" style={{ color: 'var(--text-lo)' }}>
          <Trash2 size={13} />
        </button>
      </div>

      {block.type === 'dataset-preview' && (
        <select className={selectCls} value={block.datasetId} onChange={(e) => onChange({ ...block, datasetId: e.target.value })}>
          {datasets.map((d) => <option key={d.id} value={d.id}>{d.namespace}/{d.name}</option>)}
        </select>
      )}

      {block.type === 'metric-card' && (
        <div className="grid grid-cols-3 gap-2">
          <select className={selectCls} value={block.datasetId} onChange={(e) => onChange({ ...block, datasetId: e.target.value } as MetricCardBlock)}>
            {datasets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <input className={inputCls} placeholder="Column…" value={block.column} onChange={(e) => onChange({ ...block, column: e.target.value } as MetricCardBlock)} />
          <select className={selectCls} value={block.fn} onChange={(e) => onChange({ ...block, fn: e.target.value as MetricCardBlock['fn'] } as MetricCardBlock)}>
            {['count', 'sum', 'avg', 'min', 'max'].map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
      )}

      {block.type === 'check-status' && (
        <select className={selectCls} value={block.checkId} onChange={(e) => onChange({ ...block, checkId: e.target.value } as CheckStatusBlock)}>
          {checks.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      )}

      {block.type === 'pipeline-runner' && (
        <select className={selectCls} value={block.pipelineId} onChange={(e) => onChange({ ...block, pipelineId: e.target.value } as PipelineRunnerBlock)}>
          {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      )}

      {block.type === 'markdown' && (
        <textarea className={inputCls} rows={4} style={{ resize: 'vertical' }} value={block.content}
          onChange={(e) => onChange({ ...block, content: e.target.value } as MarkdownBlock)} />
      )}
    </div>
  );
}

// ── Block viewer ──────────────────────────────────────────────────────────────

function BlockView({ block, datasets, checks, pipelines }: {
  block: Block;
  datasets: DatasetRecord[];
  checks: CheckDefinition[];
  pipelines: PipelineDefinition[];
}) {
  return (
    <Card title={block.title || block.type}>
      {block.type === 'dataset-preview' && <DatasetPreviewBlockView block={block} datasets={datasets} />}
      {block.type === 'metric-card' && <MetricCardBlockView block={block} datasets={datasets} />}
      {block.type === 'check-status' && <CheckStatusBlockView block={block} checks={checks} />}
      {block.type === 'pipeline-runner' && <PipelineRunnerBlockView block={block} pipelines={pipelines} datasets={datasets} />}
      {block.type === 'markdown' && <MarkdownBlockView block={block} />}
    </Card>
  );
}

// ── Workshop ──────────────────────────────────────────────────────────────────

const DEFAULT_APP: WorkshopApp = { id: 'default', name: 'My Dashboard', blocks: [] };

export function WorkshopView() {
  const [app, setApp] = useState<WorkshopApp>(DEFAULT_APP);
  const [editing, setEditing] = useState(true);
  const [datasets, setDatasets] = useState<DatasetRecord[]>([]);
  const [checks, setChecks] = useState<CheckDefinition[]>([]);
  const [pipelines, setPipelines] = useState<PipelineDefinition[]>([]);
  const [savedApps, setSavedApps] = useState<SavedViewRecord[]>([]);
  const [saveName, setSaveName] = useState('');

  useEffect(() => {
    Promise.all([fetchDatasets(), fetchChecks(), fetchPipelines(), fetchSavedViews('workshop')])
      .then(([ds, ch, pi, sv]) => { setDatasets(ds); setChecks(ch); setPipelines(pi); setSavedApps(sv); })
      .catch(console.error);
  }, []);

  const addBlock = (type: BlockType) => {
    const id = randomId();
    const defaults: Record<BlockType, Block> = {
      'dataset-preview': { id, type: 'dataset-preview', title: 'Dataset Preview', datasetId: datasets[0]?.id ?? '' },
      'metric-card': { id, type: 'metric-card', title: 'Metric', datasetId: datasets[0]?.id ?? '', column: '', fn: 'count' },
      'check-status': { id, type: 'check-status', title: 'Check', checkId: checks[0]?.id ?? '' },
      'pipeline-runner': { id, type: 'pipeline-runner', title: 'Run Pipeline', pipelineId: pipelines[0]?.id ?? '' },
      'markdown': { id, type: 'markdown', title: 'Note', content: 'Write your notes here…' },
    };
    setApp((a) => ({ ...a, blocks: [...a.blocks, defaults[type]] }));
  };

  const updateBlock = useCallback((id: string, updated: Block) => {
    setApp((a) => ({ ...a, blocks: a.blocks.map((b) => b.id === id ? updated : b) }));
  }, []);

  const removeBlock = useCallback((id: string) => {
    setApp((a) => ({ ...a, blocks: a.blocks.filter((b) => b.id !== id) }));
  }, []);

  const handleSave = async () => {
    if (!saveName.trim()) return;
    await saveView({ type: 'workshop', name: saveName.trim(), state: app as unknown as Record<string, unknown> });
    setSaveName('');
    setSavedApps(await fetchSavedViews('workshop'));
  };

  const loadApp = (sv: SavedViewRecord) => {
    setApp(sv.state as unknown as WorkshopApp);
  };

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <input className={`${inputCls} max-w-[220px]`} placeholder="App name…" value={app.name}
          onChange={(e) => setApp((a) => ({ ...a, name: e.target.value }))} />

        <div className="h-5 w-px" style={{ background: 'rgb(var(--rim))' }} />

        <button type="button"
          className="inline-flex items-center gap-1.5 rounded px-3 py-1.5 font-medium text-[12px] transition"
          style={{ background: editing ? '#4F79E7' : 'transparent', color: editing ? '#fff' : 'var(--text-mid)', border: editing ? '1px solid transparent' : '1px solid rgb(var(--rim))' }}
          onClick={() => setEditing(true)}>
          Edit
        </button>
        <button type="button"
          className="inline-flex items-center gap-1.5 rounded px-3 py-1.5 font-medium text-[12px] transition"
          style={{ background: !editing ? '#4F79E7' : 'transparent', color: !editing ? '#fff' : 'var(--text-mid)', border: !editing ? '1px solid transparent' : '1px solid rgb(var(--rim))' }}
          onClick={() => setEditing(false)}>
          <Eye size={12} />Preview
        </button>

        <div className="h-5 w-px" style={{ background: 'rgb(var(--rim))' }} />

        <input className={`${inputCls} max-w-[160px]`} placeholder="Save as…" value={saveName} onChange={(e) => setSaveName(e.target.value)} />
        <button type="button" className="rounded px-3 py-1.5 font-semibold text-[12px]"
          style={{ background: '#4F79E7', color: '#fff' }}
          onClick={() => void handleSave()}>Save</button>

        {savedApps.map((sv) => (
          <button key={sv.id} type="button" className={ghostBtnCls} style={{ fontSize: '12px' }} onClick={() => loadApp(sv)}>
            {sv.name}
          </button>
        ))}
      </div>

      {/* Edit mode: block list + add buttons */}
      {editing && (
        <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
          <Card title="Add Blocks">
            <div className="space-y-2">
              {([
                { type: 'dataset-preview' as BlockType, label: 'Dataset Preview', desc: 'Show a table of rows' },
                { type: 'metric-card' as BlockType, label: 'Metric Card', desc: 'Aggregate a numeric column' },
                { type: 'check-status' as BlockType, label: 'Check Status', desc: 'Run a quality check' },
                { type: 'pipeline-runner' as BlockType, label: 'Pipeline Runner', desc: 'Execute a transform pipeline' },
                { type: 'markdown' as BlockType, label: 'Markdown Note', desc: 'Text and documentation' },
              ]).map(({ type, label, desc }) => (
                <button key={type} type="button"
                  className="w-full rounded border px-3 py-2.5 text-left transition"
                  style={{ borderColor: 'rgb(var(--rim))', background: 'transparent' }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'rgba(79,121,231,0.4)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'rgb(var(--rim))'; }}
                  onClick={() => addBlock(type)}>
                  <div className="flex items-center gap-2">
                    <Plus size={12} style={{ color: '#4F79E7' }} />
                    <span className="text-[13px] font-medium" style={{ color: 'var(--text-hi)' }}>{label}</span>
                  </div>
                  <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-lo)' }}>{desc}</div>
                </button>
              ))}
            </div>
          </Card>

          <Card title={`Blocks (${app.blocks.length})`}>
            {app.blocks.length === 0 ? (
              <div className="py-8 text-center text-[12px]" style={{ color: 'var(--text-lo)' }}>
                Add blocks from the left panel to compose your dashboard.
              </div>
            ) : (
              <div className="space-y-2">
                {app.blocks.map((block) => (
                  <BlockEditor
                    key={block.id} block={block} datasets={datasets} checks={checks} pipelines={pipelines}
                    onChange={(b) => updateBlock(block.id, b)}
                    onRemove={() => removeBlock(block.id)}
                  />
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {/* Preview mode: rendered blocks */}
      {!editing && (
        <div className="space-y-4">
          <h2 className="font-semibold" style={{ fontSize: '20px', color: 'var(--text-hi)' }}>{app.name}</h2>
          {app.blocks.length === 0 ? (
            <div className="py-12 text-center text-[13px]" style={{ color: 'var(--text-lo)' }}>
              No blocks yet — switch to Edit mode to add content.
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {app.blocks.map((block) => (
                <BlockView key={block.id} block={block} datasets={datasets} checks={checks} pipelines={pipelines} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
