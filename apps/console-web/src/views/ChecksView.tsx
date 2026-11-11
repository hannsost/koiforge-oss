import { useCallback, useEffect, useState } from 'react';
import { CheckCircle, XCircle, Plus, Play, Trash2 } from 'lucide-react';

import {
  createCheck,
  deleteCheck,
  fetchChecks,
  fetchDatasets,
  runCheck,
  type CheckDefinition,
  type CheckRuleType,
  type CheckRun,
  type DatasetRecord,
} from '../api';
import { Badge, Card, inputCls, selectCls, ghostBtnCls } from '../components/ui';
import { UiIcon } from '../components/ProductIdentity';

const RULE_TYPES: { value: CheckRuleType; label: string; hasColumn: boolean }[] = [
  { value: 'not_null', label: 'Not Null', hasColumn: true },
  { value: 'unique', label: 'Unique', hasColumn: true },
  { value: 'regex', label: 'Regex Match', hasColumn: true },
  { value: 'in_range', label: 'In Range', hasColumn: true },
  { value: 'allowed_values', label: 'Allowed Values', hasColumn: true },
  { value: 'min_rows', label: 'Min Rows', hasColumn: false },
];

interface DraftRule {
  ruleType: CheckRuleType;
  column: string;
  pattern: string;
  min: string;
  max: string;
  values: string;
}

function CheckStatusIcon({ status }: { status: 'passed' | 'failed' | 'warning' | null | undefined }) {
  if (status === 'passed') return <CheckCircle size={14} style={{ color: '#22c55e' }} />;
  if (status === 'failed') return <XCircle size={14} style={{ color: '#ef4444' }} />;
  return <span className="inline-block h-3.5 w-3.5 rounded-full" style={{ background: 'rgb(var(--rim))' }} />;
}

export function ChecksView() {
  const [datasets, setDatasets] = useState<DatasetRecord[]>([]);
  const [checks, setChecks] = useState<CheckDefinition[]>([]);
  const [selectedCheckId, setSelectedCheckId] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<CheckRun | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // New check form
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newDatasetId, setNewDatasetId] = useState('');
  const [draftRules, setDraftRules] = useState<DraftRule[]>([]);

  useEffect(() => {
    Promise.all([fetchDatasets(), fetchChecks()])
      .then(([ds, ch]) => { setDatasets(ds); setChecks(ch); if (ch[0]) setSelectedCheckId(ch[0].id); })
      .catch(console.error);
  }, []);

  const selectedCheck = checks.find((c) => c.id === selectedCheckId) ?? null;
  const selectedDataset = datasets.find((d) => d.id === (creating ? newDatasetId : selectedCheck?.datasetId));
  const columns = selectedDataset?.schema.map((f) => f.name) ?? [];

  const addDraftRule = () => {
    setDraftRules((prev) => [...prev, { ruleType: 'not_null', column: columns[0] ?? '', pattern: '', min: '', max: '', values: '' }]);
  };

  const handleCreate = useCallback(async () => {
    if (!newName || !newDatasetId || draftRules.length === 0) return;
    setError(null);
    try {
      const rules = draftRules.map((r) => ({
        ruleType: r.ruleType,
        column: r.column || undefined,
        params: {
          pattern: r.pattern || undefined,
          min: r.min ? Number(r.min) : undefined,
          max: r.max ? Number(r.max) : undefined,
          values: r.values ? r.values.split(',').map((v) => v.trim()).filter(Boolean) : undefined,
        },
      }));
      const created = await createCheck({ name: newName, description: newDesc, datasetId: newDatasetId, rules });
      setChecks((prev) => [...prev, created]);
      setSelectedCheckId(created.id);
      setCreating(false);
      setNewName(''); setNewDesc(''); setNewDatasetId(''); setDraftRules([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed');
    }
  }, [newName, newDesc, newDatasetId, draftRules]);

  const handleRun = useCallback(async (checkId: string) => {
    setRunning(checkId); setError(null);
    try {
      const run = await runCheck(checkId);
      setLastRun(run);
      setSelectedCheckId(checkId);
      // Refresh checks to get updated latestRun
      const updated = await fetchChecks();
      setChecks(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Run failed');
    } finally {
      setRunning(null);
    }
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await deleteCheck(id);
      setChecks((prev) => prev.filter((c) => c.id !== id));
      if (selectedCheckId === id) setSelectedCheckId(checks.find((c) => c.id !== id)?.id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }, [selectedCheckId, checks]);

  return (
    <div className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
      {/* Check list */}
      <Card
        title="Quality Checks"
        action={
          <button type="button" className="rounded border px-2.5 py-1 text-[11px] font-semibold transition"
            style={{ borderColor: 'rgba(79,121,231,0.4)', background: 'rgba(79,121,231,0.1)', color: '#4F79E7' }}
            onClick={() => { setCreating(true); setSelectedCheckId(null); setLastRun(null); }}>
            <Plus size={11} className="inline mr-1" />New
          </button>
        }
      >
        <div className="space-y-1">
          {checks.length === 0 && !creating && (
            <div className="py-6 text-center text-[12px]" style={{ color: 'var(--text-lo)' }}>No checks yet.</div>
          )}
          {checks.map((check) => {
            const active = selectedCheckId === check.id;
            const status = check.latestRun?.status;
            return (
              <button key={check.id} type="button"
                className="relative w-full text-left rounded border transition"
                style={{ padding: '8px 12px 8px 14px', borderColor: active ? 'rgba(79,121,231,0.35)' : 'transparent', background: active ? 'rgba(79,121,231,0.05)' : 'transparent' }}
                onClick={() => { setSelectedCheckId(check.id); setCreating(false); setLastRun(null); }}>
                {active && <span className="absolute inset-y-0 left-0 w-[2px] rounded-r" style={{ background: '#4F79E7' }} />}
                <div className="flex items-center gap-2">
                  <CheckStatusIcon status={status} />
                  <span className="text-[13px] font-medium" style={{ color: 'var(--text-hi)' }}>{check.name}</span>
                </div>
                <div className="mt-0.5 text-[11px] pl-5" style={{ color: 'var(--text-lo)' }}>
                  {check.rules.length} rules · {datasets.find((d) => d.id === check.datasetId)?.name ?? check.datasetId}
                </div>
              </button>
            );
          })}
        </div>
      </Card>

      {/* Detail panel */}
      <div className="space-y-4">
        {error && (
          <div className="rounded border px-4 py-3 text-[13px]" style={{ borderColor: 'rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.06)', color: '#f87171' }}>{error}</div>
        )}

        {/* Create form */}
        {creating && (
          <Card title="New Quality Check">
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <input className={inputCls} placeholder="Check name…" value={newName} onChange={(e) => setNewName(e.target.value)} />
                <input className={inputCls} placeholder="Description…" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} />
              </div>
              <select className={selectCls} value={newDatasetId} onChange={(e) => setNewDatasetId(e.target.value)}>
                <option value="">Select dataset…</option>
                {datasets.map((d) => <option key={d.id} value={d.id}>{d.namespace}/{d.name}</option>)}
              </select>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[12px]" style={{ color: 'var(--text-lo)' }}>Rules</span>
                  <button type="button" className={ghostBtnCls} style={{ fontSize: '11px', padding: '2px 8px' }} onClick={addDraftRule}>+ Rule</button>
                </div>
                {draftRules.map((rule, ri) => (
                  <div key={ri} className="rounded border p-2 mb-2 space-y-2" style={{ borderColor: 'rgb(var(--rim))' }}>
                    <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
                      <select className={selectCls} value={rule.ruleType} onChange={(e) => setDraftRules((prev) => prev.map((r, i) => i === ri ? { ...r, ruleType: e.target.value as CheckRuleType } : r))}>
                        {RULE_TYPES.map((rt) => <option key={rt.value} value={rt.value}>{rt.label}</option>)}
                      </select>
                      {RULE_TYPES.find((r) => r.value === rule.ruleType)?.hasColumn && (
                        <select className={selectCls} value={rule.column} onChange={(e) => setDraftRules((prev) => prev.map((r, i) => i === ri ? { ...r, column: e.target.value } : r))}>
                          <option value="">Column…</option>
                          {columns.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      )}
                      <button type="button" aria-label={`Regel ${ri + 1} entfernen`} className="text-[#3a4e6a] hover:text-[#f87171]" onClick={() => setDraftRules((prev) => prev.filter((_, i) => i !== ri))}><UiIcon name="close" size={16} /></button>
                    </div>
                    {rule.ruleType === 'regex' && (
                      <input className={inputCls} placeholder="Regex pattern…" value={rule.pattern} onChange={(e) => setDraftRules((prev) => prev.map((r, i) => i === ri ? { ...r, pattern: e.target.value } : r))} />
                    )}
                    {rule.ruleType === 'in_range' && (
                      <div className="grid grid-cols-2 gap-2">
                        <input className={inputCls} placeholder="Min…" type="number" value={rule.min} onChange={(e) => setDraftRules((prev) => prev.map((r, i) => i === ri ? { ...r, min: e.target.value } : r))} />
                        <input className={inputCls} placeholder="Max…" type="number" value={rule.max} onChange={(e) => setDraftRules((prev) => prev.map((r, i) => i === ri ? { ...r, max: e.target.value } : r))} />
                      </div>
                    )}
                    {(rule.ruleType === 'allowed_values') && (
                      <input className={inputCls} placeholder="Allowed values (comma-separated)…" value={rule.values} onChange={(e) => setDraftRules((prev) => prev.map((r, i) => i === ri ? { ...r, values: e.target.value } : r))} />
                    )}
                    {rule.ruleType === 'min_rows' && (
                      <input className={inputCls} placeholder="Minimum row count…" type="number" value={rule.min} onChange={(e) => setDraftRules((prev) => prev.map((r, i) => i === ri ? { ...r, min: e.target.value } : r))} />
                    )}
                  </div>
                ))}
              </div>

              <div className="flex gap-2">
                <button type="button" className="rounded px-4 py-1.5 font-semibold text-[13px]" style={{ background: '#4F79E7', color: '#fff' }} onClick={() => void handleCreate()}>
                  Save Check
                </button>
                <button type="button" className={ghostBtnCls} onClick={() => setCreating(false)}>Cancel</button>
              </div>
            </div>
          </Card>
        )}

        {/* Check detail */}
        {selectedCheck && !creating && (
          <Card
            title={selectedCheck.name}
            action={
              <div className="flex gap-2">
                <button type="button" className="inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-[12px] font-semibold transition"
                  style={{ background: '#4F79E7', color: '#fff', opacity: running === selectedCheck.id ? 0.5 : 1 }}
                  disabled={running === selectedCheck.id}
                  onClick={() => void handleRun(selectedCheck.id)}>
                  <Play size={12} />{running === selectedCheck.id ? 'Running…' : 'Run Check'}
                </button>
                <button type="button" className="rounded p-1.5 transition hover:bg-[rgba(239,68,68,0.1)] hover:text-[#f87171]"
                  style={{ color: 'var(--text-lo)' }} onClick={() => void handleDelete(selectedCheck.id)}>
                  <Trash2 size={14} />
                </button>
              </div>
            }
          >
            <div className="mb-3 text-[12px]" style={{ color: 'var(--text-lo)' }}>
              Dataset: <span style={{ color: 'var(--text-hi)' }}>{datasets.find((d) => d.id === selectedCheck.datasetId)?.name ?? selectedCheck.datasetId}</span>
              {selectedCheck.description && <span className="ml-3">{selectedCheck.description}</span>}
            </div>

            {/* Rules */}
            <div className="space-y-1 mb-4">
              {selectedCheck.rules.map((rule) => {
                const runResult = (lastRun ?? selectedCheck.latestRun)?.ruleResults.find((r) => r.ruleId === rule.id);
                return (
                  <div key={rule.id} className="flex items-center gap-2 rounded border px-3 py-2 text-[12px]"
                    style={{ borderColor: 'rgb(var(--rim))' }}>
                    {runResult ? <CheckStatusIcon status={runResult.passed ? 'passed' : 'failed'} /> : <CheckStatusIcon status={null} />}
                    <span className="font-medium" style={{ color: 'var(--text-hi)' }}>{rule.ruleType}</span>
                    {rule.column && <span style={{ color: 'var(--text-lo)' }}>on <span style={{ color: 'var(--text-mid)' }}>{rule.column}</span></span>}
                    {runResult && (
                      <span className="ml-auto" style={{ color: runResult.passed ? '#22c55e' : '#f87171' }}>
                        {runResult.message}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Latest run summary */}
            {(lastRun ?? selectedCheck.latestRun) && (() => {
              const run = lastRun ?? selectedCheck.latestRun!;
              return (
                <div className="rounded border px-3 py-2 text-[12px]"
                  style={{ borderColor: run.status === 'passed' ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)', background: run.status === 'passed' ? 'rgba(34,197,94,0.05)' : 'rgba(239,68,68,0.05)' }}>
                  <div className="flex items-center gap-2">
                    <Badge tone={run.status === 'passed' ? 'success' : 'danger'}>{run.status}</Badge>
                    <span style={{ color: 'var(--text-lo)' }}>{run.rowsChecked} rows checked · {new Date(run.executedAt).toLocaleString()}</span>
                  </div>
                </div>
              );
            })()}
          </Card>
        )}
      </div>
    </div>
  );
}
