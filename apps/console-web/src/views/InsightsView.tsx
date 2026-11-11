import { useCallback, useEffect, useId, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
  Pie, PieChart, ResponsiveContainer, Scatter, ScatterChart,
  Tooltip, XAxis, YAxis,
} from 'recharts';

import { fetchDatasetPreview, fetchDatasets, type DatasetRecord } from '../api';
import { Card, ghostBtnCls, selectCls } from '../components/ui';
import { UiIcon } from '../components/ProductIdentity';

// ── Types ─────────────────────────────────────────────────────────────────────

type ChartType = 'bar' | 'line' | 'pie' | 'scatter' | 'heatmap';

interface ChartBlock {
  id: string;
  title: string;
  datasetId: string;
  chartType: ChartType;
  xColumn: string;
  yColumn: string;
  groupColumn: string;
  aggregation: 'sum' | 'count' | 'avg' | 'min' | 'max';
}

type DataRow = Record<string, string | number | boolean | null>;

// ── Color palette ─────────────────────────────────────────────────────────────

const PALETTE = ['#4F79E7', '#34c993', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#f97316', '#ec4899'];

const formatTooltipValue = (value: unknown) => (
  typeof value === 'number' ? value.toLocaleString('de-DE') : String(value ?? '')
);

// ── Aggregation helper ────────────────────────────────────────────────────────

function aggregateRows(
  rows: DataRow[],
  xCol: string,
  yCol: string,
  agg: ChartBlock['aggregation'],
  groupCol?: string,
): { key: string; value: number; group?: string }[] {
  const buckets = new Map<string, number[]>();
  for (const row of rows) {
    const key = groupCol
      ? `${String(row[xCol] ?? '—')}__${String(row[groupCol] ?? '—')}`
      : String(row[xCol] ?? '—');
    const num = typeof row[yCol] === 'number' ? (row[yCol] as number) : parseFloat(String(row[yCol] ?? '0'));
    if (!buckets.has(key)) buckets.set(key, []);
    if (!isNaN(num)) buckets.get(key)!.push(num);
    else buckets.get(key)!.push(1); // for count on non-numeric
  }

  return [...buckets.entries()].map(([key, vals]) => {
    const parts = groupCol ? key.split('__') : [key];
    let value = 0;
    if (agg === 'count') value = vals.length;
    else if (agg === 'sum') value = vals.reduce((a, b) => a + b, 0);
    else if (agg === 'avg') value = vals.reduce((a, b) => a + b, 0) / vals.length;
    else if (agg === 'min') value = Math.min(...vals);
    else if (agg === 'max') value = Math.max(...vals);
    return { key: parts[0] ?? key, value: Math.round(value * 100) / 100, group: parts[1] };
  }).slice(0, 50);
}

// ── Heatmap ───────────────────────────────────────────────────────────────────

function HeatmapChart({ data, xCol, yCol }: { data: DataRow[]; xCol: string; yCol: string }) {
  const xVals = [...new Set(data.map((r) => String(r[xCol] ?? '—')))].slice(0, 20);
  const yVals = [...new Set(data.map((r) => String(r[yCol] ?? '—')))].slice(0, 15);

  const counts = new Map<string, number>();
  for (const row of data) {
    const k = `${String(row[xCol])}__${String(row[yCol])}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const max = Math.max(...counts.values(), 1);

  return (
    <div className="overflow-auto">
      <table className="border-collapse text-[10px]">
        <thead>
          <tr>
            <th className="pr-2 text-right" style={{ color: 'var(--text-lo)', minWidth: 60 }}>{xCol} \ {yCol}</th>
            {yVals.map((y) => (
              <th key={y} className="px-1 py-1 text-center font-normal" style={{ color: 'var(--text-lo)', minWidth: 32 }}>
                <span className="block max-w-[48px] truncate">{y}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {xVals.map((x) => (
            <tr key={x}>
              <td className="pr-2 py-0.5 text-right" style={{ color: 'var(--text-mid)', maxWidth: 80 }}>
                <span className="block truncate">{x}</span>
              </td>
              {yVals.map((y) => {
                const count = counts.get(`${x}__${y}`) ?? 0;
                const intensity = count / max;
                return (
                  <td key={y} className="px-0.5 py-0.5">
                    <div
                      className="flex items-center justify-center rounded text-[9px] font-medium"
                      style={{
                        width: 32, height: 20,
                        background: count ? `rgba(79,121,231,${0.15 + intensity * 0.85})` : 'transparent',
                        color: intensity > 0.5 ? '#ffffff' : 'var(--text-lo)',
                      }}
                    >
                      {count || ''}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Chart renderer ────────────────────────────────────────────────────────────

function ChartRenderer({ block, rows }: { block: ChartBlock; rows: DataRow[] }) {
  if (rows.length === 0) {
    return <div className="flex h-48 items-center justify-center text-[12px]" style={{ color: 'var(--text-lo)' }}>Keine Daten</div>;
  }

  if (block.chartType === 'heatmap') {
    return <HeatmapChart data={rows} xCol={block.xColumn} yCol={block.yColumn} />;
  }

  const agg = aggregateRows(rows, block.xColumn, block.yColumn, block.aggregation, block.groupColumn || undefined);
  const groups = block.groupColumn ? [...new Set(agg.map((d) => d.group ?? ''))] : [];

  if (block.chartType === 'pie') {
    return (
      <ResponsiveContainer width="100%" height={240}>
        <PieChart>
          <Pie
            data={agg}
            dataKey="value"
            nameKey="key"
            cx="50%"
            cy="50%"
            outerRadius={90}
            label={({ key, percent }) => `${key} ${(((percent ?? 0) * 100)).toFixed(0)}%`}
            labelLine={false}
          >
            {agg.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
          </Pie>
          <Tooltip formatter={formatTooltipValue} />
        </PieChart>
      </ResponsiveContainer>
    );
  }

  if (block.chartType === 'scatter') {
    const scatterData = rows.map((r) => ({
      x: typeof r[block.xColumn] === 'number' ? r[block.xColumn] : parseFloat(String(r[block.xColumn] ?? 0)),
      y: typeof r[block.yColumn] === 'number' ? r[block.yColumn] : parseFloat(String(r[block.yColumn] ?? 0)),
    })).filter((p) => !isNaN(p.x as number) && !isNaN(p.y as number)).slice(0, 500);
    return (
      <ResponsiveContainer width="100%" height={240}>
        <ScatterChart>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(var(--rim),0.4)" />
          <XAxis dataKey="x" name={block.xColumn} tick={{ fill: 'var(--text-lo)', fontSize: 10 }} />
          <YAxis dataKey="y" name={block.yColumn} tick={{ fill: 'var(--text-lo)', fontSize: 10 }} />
          <Tooltip cursor={{ strokeDasharray: '3 3' }} />
          <Scatter data={scatterData} fill={PALETTE[0]} fillOpacity={0.7} />
        </ScatterChart>
      </ResponsiveContainer>
    );
  }

  if (block.chartType === 'line') {
    const lineData = groups.length > 1
      ? [...new Set(agg.map((d) => d.key))].map((key) => {
          const entry: Record<string, string | number> = { key };
          groups.forEach((g) => {
            const match = agg.find((d) => d.key === key && d.group === g);
            entry[g] = match?.value ?? 0;
          });
          return entry;
        })
      : agg.map((d) => ({ key: d.key, value: d.value }));

    return (
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={lineData}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(var(--rim),0.4)" />
          <XAxis dataKey="key" tick={{ fill: 'var(--text-lo)', fontSize: 10 }} />
          <YAxis tick={{ fill: 'var(--text-lo)', fontSize: 10 }} />
          <Tooltip formatter={formatTooltipValue} />
          {groups.length > 1 ? (
            <>
              <Legend />
              {groups.map((g, i) => <Line key={g} type="monotone" dataKey={g} stroke={PALETTE[i % PALETTE.length]} dot={false} />)}
            </>
          ) : (
            <Line type="monotone" dataKey="value" stroke={PALETTE[0]} dot={false} />
          )}
        </LineChart>
      </ResponsiveContainer>
    );
  }

  // Default: bar
  const barData = groups.length > 1
    ? [...new Set(agg.map((d) => d.key))].map((key) => {
        const entry: Record<string, string | number> = { key };
        groups.forEach((g) => {
          const match = agg.find((d) => d.key === key && d.group === g);
          entry[g] = match?.value ?? 0;
        });
        return entry;
      })
    : agg.map((d) => ({ key: d.key, value: d.value }));

  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={barData}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(var(--rim),0.4)" />
        <XAxis dataKey="key" tick={{ fill: 'var(--text-lo)', fontSize: 10 }} />
        <YAxis tick={{ fill: 'var(--text-lo)', fontSize: 10 }} />
        <Tooltip formatter={formatTooltipValue} />
        {groups.length > 1 ? (
          <>
            <Legend />
            {groups.map((g, i) => <Bar key={g} dataKey={g} fill={PALETTE[i % PALETTE.length]} radius={[2, 2, 0, 0]} />)}
          </>
        ) : (
          <Bar dataKey="value" radius={[2, 2, 0, 0]}>
            {barData.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
          </Bar>
        )}
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── Block editor ──────────────────────────────────────────────────────────────

function BlockEditor(props: {
  block: ChartBlock;
  datasets: DatasetRecord[];
  columns: string[];
  onChange: (b: ChartBlock) => void;
  onClose: () => void;
}) {
  const { block, datasets, columns, onChange, onClose } = props;
  const uid = useId();

  const set = <K extends keyof ChartBlock>(key: K, value: ChartBlock[K]) =>
    onChange({ ...block, [key]: value });

  return (
    <div className="rounded border border-rim bg-ink/80 p-4 space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-lo)' }}>Titel</div>
          <input className="w-full rounded border border-rim bg-transparent px-2 py-1 text-[13px]" style={{ color: 'var(--text-hi)' }}
            value={block.title} onChange={(e) => set('title', e.target.value)} />
        </div>
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-lo)' }}>Chart-Typ</div>
          <select className={selectCls} value={block.chartType} onChange={(e) => set('chartType', e.target.value as ChartType)}>
            <option value="bar">Bar Chart</option>
            <option value="line">Line Chart</option>
            <option value="pie">Pie Chart</option>
            <option value="scatter">Scatter Plot</option>
            <option value="heatmap">Heatmap</option>
          </select>
        </div>
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-lo)' }}>Dataset</div>
          <select className={selectCls} value={block.datasetId} onChange={(e) => set('datasetId', e.target.value)}>
            <option value="">— wählen —</option>
            {datasets.map((d) => <option key={d.id} value={d.id}>{d.namespace}/{d.name}</option>)}
          </select>
        </div>
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-lo)' }}>Aggregation</div>
          <select className={selectCls} value={block.aggregation} onChange={(e) => set('aggregation', e.target.value as ChartBlock['aggregation'])}>
            <option value="count">Count</option>
            <option value="sum">Sum</option>
            <option value="avg">Average</option>
            <option value="min">Min</option>
            <option value="max">Max</option>
          </select>
        </div>
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-lo)' }}>X-Achse / Kategorie</div>
          <select className={selectCls} value={block.xColumn} onChange={(e) => set('xColumn', e.target.value)}>
            <option value="">— wählen —</option>
            {columns.map((c) => <option key={`${uid}-x-${c}`} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-lo)' }}>Y-Achse / Wert</div>
          <select className={selectCls} value={block.yColumn} onChange={(e) => set('yColumn', e.target.value)}>
            <option value="">— wählen —</option>
            {columns.map((c) => <option key={`${uid}-y-${c}`} value={c}>{c}</option>)}
          </select>
        </div>
        {block.chartType !== 'pie' && block.chartType !== 'scatter' && block.chartType !== 'heatmap' && (
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-lo)' }}>Gruppierung (optional)</div>
            <select className={selectCls} value={block.groupColumn} onChange={(e) => set('groupColumn', e.target.value)}>
              <option value="">Keine</option>
              {columns.map((c) => <option key={`${uid}-g-${c}`} value={c}>{c}</option>)}
            </select>
          </div>
        )}
      </div>
      <div className="flex justify-end">
        <button className={ghostBtnCls} onClick={onClose} type="button">Fertig</button>
      </div>
    </div>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────────

let _id = 0;
const nextId = () => `chart-${++_id}`;

export function InsightsView() {
  const [datasets, setDatasets] = useState<DatasetRecord[]>([]);
  const [blocks, setBlocks] = useState<ChartBlock[]>([]);
  const [rowCache, setRowCache] = useState<Record<string, DataRow[]>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [columnCache, setColumnCache] = useState<Record<string, string[]>>({});

  useEffect(() => {
    fetchDatasets().then(setDatasets).catch(console.error);
  }, []);

  const loadRows = useCallback(async (datasetId: string) => {
    if (!datasetId || rowCache[datasetId]) return;
    try {
      const result = await fetchDatasetPreview(datasetId, { limit: 5000 });
      setRowCache((c) => ({ ...c, [datasetId]: result.rows as DataRow[] }));
      setColumnCache((c) => ({ ...c, [datasetId]: result.columns }));
    } catch {
      // ignore
    }
  }, [rowCache]);

  const addBlock = useCallback(() => {
    const id = nextId();
    const newBlock: ChartBlock = {
      id,
      title: 'Neues Diagramm',
      datasetId: '',
      chartType: 'bar',
      xColumn: '',
      yColumn: '',
      groupColumn: '',
      aggregation: 'count',
    };
    setBlocks((b) => [...b, newBlock]);
    setEditingId(id);
  }, []);

  const updateBlock = useCallback((updated: ChartBlock) => {
    setBlocks((bs) => bs.map((b) => b.id === updated.id ? updated : b));
    void loadRows(updated.datasetId);
  }, [loadRows]);

  const removeBlock = useCallback((id: string) => {
    setBlocks((bs) => bs.filter((b) => b.id !== id));
    if (editingId === id) setEditingId(null);
  }, [editingId]);

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <div className="text-[12px]" style={{ color: 'var(--text-lo)' }}>
          {blocks.length === 0 ? 'Noch keine Diagramme — füge eines hinzu.' : `${blocks.length} Diagramm${blocks.length !== 1 ? 'e' : ''}`}
        </div>
        <button
          className="rounded border border-rim px-3 py-1.5 text-[12px] font-medium transition hover:border-brand-border"
          style={{ color: 'var(--text-hi)', background: 'rgba(79,121,231,0.08)' }}
          onClick={addBlock}
          type="button"
        >
          + Diagramm hinzufügen
        </button>
      </div>

      {/* Chart grid */}
      <div className="grid gap-4 xl:grid-cols-2">
        {blocks.map((block) => {
          const rows = rowCache[block.datasetId] ?? [];
          const columns = columnCache[block.datasetId] ?? [];
          const isEditing = editingId === block.id;

          return (
            <Card
              key={block.id}
              title={block.title || 'Diagramm'}
              action={
                <div className="flex gap-1.5">
                  <button className={ghostBtnCls} onClick={() => setEditingId(isEditing ? null : block.id)} type="button">
                    {isEditing ? 'Schließen' : 'Bearbeiten'}
                  </button>
                  <button
                    className={ghostBtnCls}
                    style={{ color: '#ef4444' }}
                    onClick={() => removeBlock(block.id)}
                    type="button"
                    aria-label={`Diagramm ${block.title || 'ohne Titel'} entfernen`}
                  >
                    <UiIcon name="close" size={16} />
                  </button>
                </div>
              }
            >
              {isEditing && (
                <div className="mb-4">
                  <BlockEditor
                    block={block}
                    datasets={datasets}
                    columns={columns}
                    onChange={updateBlock}
                    onClose={() => setEditingId(null)}
                  />
                </div>
              )}

              {!block.datasetId || !block.xColumn ? (
                <div className="flex h-48 items-center justify-center rounded border border-dashed border-rim text-[12px]" style={{ color: 'var(--text-lo)' }}>
                  Dataset und Spalten konfigurieren →
                </div>
              ) : (
                <ChartRenderer block={block} rows={rows} />
              )}

              {block.datasetId && (
                <div className="mt-2 text-[10px]" style={{ color: 'var(--text-lo)' }}>
                  {block.datasetId} · {rows.length.toLocaleString('de-DE')} Zeilen geladen · {block.chartType} · {block.aggregation}({block.yColumn || '—'}) by {block.xColumn || '—'}
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {blocks.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded border border-dashed border-rim py-20 text-center">
          <UiIcon name="diagram" className="text-[32px]" size={32} />
          <div className="mt-3 text-[14px] font-medium" style={{ color: 'var(--text-hi)' }}>Keine Diagramme</div>
          <div className="mt-1 text-[12px]" style={{ color: 'var(--text-lo)' }}>
            Klicke auf „+ Diagramm hinzufügen" und wähle ein Dataset und Spalten
          </div>
          <button
            className="mt-4 rounded border border-rim px-4 py-2 text-[13px] font-medium transition hover:border-brand-border"
            style={{ color: 'var(--text-hi)', background: 'rgba(79,121,231,0.08)' }}
            onClick={addBlock}
            type="button"
          >
            + Diagramm hinzufügen
          </button>
        </div>
      )}
    </div>
  );
}
