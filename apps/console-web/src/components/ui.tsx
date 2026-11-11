import type { ReactNode } from 'react';

import type { DatasetPreviewResult } from '../api';

// ── Card ─────────────────────────────────────────────────────────────────────

export function Card(props: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section
      className="kf-card"
    >
      <div
        className="kf-card-heading flex flex-wrap items-center justify-between gap-3"
      >
        <h2
          className="font-semibold"
        >
          {props.title}
        </h2>
        {props.action && <div className="flex flex-wrap items-center justify-end gap-2">{props.action}</div>}
      </div>
      <div className="kf-card-content">{props.children}</div>
    </section>
  );
}

// ── Badge ─────────────────────────────────────────────────────────────────────

type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger';

export function Badge(props: { children: ReactNode; tone?: BadgeTone }) {
  return <span className={`kf-badge kf-badge-${props.tone ?? 'neutral'}`}>{props.children}</span>;
}

// ── StatusDot ─────────────────────────────────────────────────────────────────

const dotCls: Record<BadgeTone, string> = {
  neutral: 'bg-brand',
  success: 'bg-[#22c55e]',
  warning: 'bg-[#f59e0b]',
  danger:  'bg-[#ef4444]',
};

export function StatusDot(props: { tone?: BadgeTone }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${dotCls[props.tone ?? 'neutral']}`} />;
}

// ── ActionButton ──────────────────────────────────────────────────────────────

export function ActionButton(props: {
  onClick: () => void;
  label: string;
  busyLabel: string;
  busy: boolean;
  disabled?: boolean;
  variant?: 'primary' | 'ghost';
}) {
  const isPrimary = (props.variant ?? 'primary') === 'primary';
  const base = 'kf-button inline-flex items-center rounded px-3 py-1.5 font-semibold transition disabled:cursor-not-allowed disabled:opacity-50';
  const variant = isPrimary
    ? 'bg-brand text-white hover:bg-brand-dim'
    : 'border border-rim text-[color:var(--text-mid)] hover:border-dim hover:text-[color:var(--text-hi)]';
  return (
    <button className={`${base} ${variant}`} onClick={props.onClick} disabled={props.busy || props.disabled} type="button">
      {props.busy ? props.busyLabel : props.label}
    </button>
  );
}

// ── Input / Select helpers ────────────────────────────────────────────────────

export const inputCls =
  'w-full rounded border border-rim bg-transparent px-3 py-2 text-[color:var(--text-hi)] outline-none placeholder:text-[color:var(--text-ghost)] focus:border-brand-border focus:ring-0';

export const selectCls =
  'w-full rounded border border-rim bg-transparent px-3 py-2 text-[color:var(--text-hi)] outline-none focus:border-brand-border [&>option]:bg-[#ffffff] [&>option]:text-[#0f172a] [&>optgroup]:bg-[#ffffff] [&>optgroup]:text-[#0f172a]';

export const ghostBtnCls =
  'kf-button rounded border border-rim px-3 py-1.5 font-medium text-[color:var(--text-mid)] transition hover:border-dim hover:text-[color:var(--text-hi)]';

export const saveViewBtnCls =
  'kf-button rounded border border-brand-border bg-brand-muted px-3 py-1.5 font-semibold text-brand transition hover:bg-brand hover:text-white';

export const viewChipCls =
  'rounded border border-rim px-2.5 py-1 text-[color:var(--text-mid)] transition hover:border-brand-border hover:text-brand';

export const filterChipCls =
  'inline-flex items-center gap-1 rounded border border-rim bg-transparent px-2 py-0.5 text-[color:var(--text-mid)] hover:border-dim hover:text-[color:var(--text-hi)]';

// Apply consistent font size to string-class buttons
const textSm = { fontSize: '14px' } as const;
const textXs = { fontSize: '13px' } as const;
export { textSm, textXs };

// ── DataTable ─────────────────────────────────────────────────────────────────

export function DataTable(props: {
  preview: DatasetPreviewResult | null;
  allColumns?: string[];
  fixedRows?: number;
  visibleColumns?: string[];
  onVisibleColumnsChange?: (columns: string[]) => void;
}) {
  if (!props.preview) {
    return <div style={{ fontSize: 'var(--nf-text-body)', lineHeight: 'var(--nf-leading-body)', color: 'var(--text-lo)' }}>Noch keine Datenvorschau geladen.</div>;
  }

  const { preview } = props;
  const allColumns = props.allColumns && props.allColumns.length > 0
    ? props.allColumns
    : preview.columns;
  const visibleColumns = props.visibleColumns && props.visibleColumns.length > 0
    ? props.visibleColumns.filter((column) => allColumns.includes(column))
    : preview.columns;
  const maxVisibleRows = props.fixedRows ?? 10;
  const visibleRowCount = Math.min(preview.rows.length, maxVisibleRows);
  const tableHeight = 40 + (visibleRowCount * 40);

  return (
    <div className="space-y-2">
      {props.onVisibleColumnsChange && allColumns.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {allColumns.map((column) => {
            const active = visibleColumns.includes(column);
            return (
              <button
                key={column}
                type="button"
                className="rounded border px-2 py-0.5 font-medium transition"
                style={{
                  fontSize: '11px',
                  borderColor: active ? 'rgb(var(--brand-rgb) / .5)' : 'rgb(var(--rim))',
                  background: active ? 'rgb(var(--brand-rgb) / .08)' : 'rgb(var(--ink) / 0.35)',
                  color: active ? 'rgb(var(--brand-rgb))' : 'var(--text-lo)',
                }}
                onClick={() => {
                  const next = active
                    ? visibleColumns.filter((entry) => entry !== column)
                    : [...visibleColumns, column];
                  props.onVisibleColumnsChange?.(next.length > 0 ? next : [column]);
                }}
              >
                {active ? 'on' : 'off'} {column}
              </button>
            );
          })}
        </div>
      )}

      <div
        data-testid="dataset-preview-table"
        className="overflow-auto rounded"
        style={{
          border: '1px solid rgb(var(--rim))',
          height: `${tableHeight}px`,
          maxHeight: `${tableHeight}px`,
        }}
      >
        <table className="min-w-full border-collapse" style={{ fontSize: 'var(--nf-text-body)', lineHeight: 'var(--nf-leading-body)' }}>
          <thead>
            <tr
              style={{
                borderBottom: '1px solid rgb(var(--rim))',
                background: 'rgb(var(--ink) / 0.92)',
                position: 'sticky',
                top: 0,
                zIndex: 1,
              }}
            >
              {visibleColumns.map((col) => (
                <th
                  key={col}
                  className="px-3 py-2 text-left font-semibold uppercase tracking-[0.12em]"
                  style={{ fontSize: 'var(--nf-text-label)', lineHeight: 'var(--nf-leading-caption)', color: 'var(--text-lo)' }}
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row, i) => (
              <tr
                key={i}
                className="hover:bg-rim/30"
                style={{ borderBottom: i < preview.rows.length - 1 ? '1px solid rgb(var(--rim) / 0.5)' : 'none' }}
              >
                {visibleColumns.map((col) => (
                  <td
                    key={`${i}-${col}`}
                    className="px-3 py-2 align-top"
                    style={{
                      color: 'var(--text-mid)',
                      lineHeight: 'var(--nf-leading-body)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {row[col] == null
                      ? <span className="font-mono" style={{ fontSize: 'var(--nf-text-caption)', color: 'var(--text-ghost)' }}>null</span>
                      : String(row[col])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── confidenceTone ────────────────────────────────────────────────────────────

export function confidenceTone(label: 'high' | 'medium' | 'low'): BadgeTone {
  if (label === 'high') return 'success';
  if (label === 'medium') return 'warning';
  return 'danger';
}
