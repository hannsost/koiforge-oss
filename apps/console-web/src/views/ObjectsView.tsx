import { useCallback, useEffect, useId, useState } from 'react';
import { Zap } from 'lucide-react';

import {
  executeAction,
  fetchActions,
  fetchObjectDetail,
  fetchObjects,
  fetchOntologySnapshot,
  fetchSavedViews,
  saveView,
  type ActionDefinition,
  type ActionResult,
  type ExplorerObjectDetail,
  type ExplorerObjectSummary,
  type SavedViewRecord,
} from '../api';
import {
  Badge,
  Card,
  StatusDot,
  confidenceTone,
  filterChipCls,
  ghostBtnCls,
  inputCls,
  saveViewBtnCls,
  selectCls,
  viewChipCls,
} from '../components/ui';
import { UiIcon } from '../components/ProductIdentity';

interface FilterChip { field: string; value: string; }

interface ObjectsViewProps {
  onAddObjectToBoard: (object: ExplorerObjectSummary) => void;
}

function statusTone(status?: string | null): 'success' | 'warning' | 'danger' | 'neutral' {
  if (!status) return 'neutral';
  if (['delayed', 'watchlist', 'error', 'failed'].includes(status)) return 'danger';
  if (['review', 'pending', 'warning'].includes(status)) return 'warning';
  if (['active', 'approved', 'shipped', 'success', 'ready'].includes(status)) return 'success';
  return 'neutral';
}

export function ObjectsView({ onAddObjectToBoard }: ObjectsViewProps) {
  const [objectTypes, setObjectTypes] = useState<string[]>([]);
  const [objects, setObjects] = useState<ExplorerObjectSummary[]>([]);
  const [selectedObjectType, setSelectedObjectType] = useState<string>('');
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [objectDetail, setObjectDetail] = useState<ExplorerObjectDetail | null>(null);
  const [objectViews, setObjectViews] = useState<SavedViewRecord[]>([]);
  const [viewName, setViewName] = useState('');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('title');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [filterField, setFilterField] = useState('');
  const [filterValue, setFilterValue] = useState('');
  const [filters, setFilters] = useState<FilterChip[]>([]);
  const [availableActions, setAvailableActions] = useState<ActionDefinition[]>([]);
  const [runningAction, setRunningAction] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<ActionResult | null>(null);
  const [actionError, setActionError] = useState('');
  const actionDescriptionId = useId();

  useEffect(() => {
    fetchActions().then(setAvailableActions).catch(console.error);
  }, []);

  useEffect(() => {
    Promise.all([
      fetchOntologySnapshot(),
      fetchSavedViews('object-explorer'),
    ]).then(([snapshot, views]) => {
      const types = snapshot.snapshot.objects.map((o: { name: string }) => o.name);
      setObjectTypes(types);
      if (types.length > 0 && !selectedObjectType) setSelectedObjectType(types[0]!);
      setObjectViews(views);
    }).catch(console.error);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setSelectedObjectId(null); setObjectDetail(null); setObjects([]); setActionResult(null); }, [selectedObjectType]);
  useEffect(() => { setActionResult(null); setActionError(''); }, [selectedObjectId, selectedObjectType]);

  useEffect(() => {
    if (!selectedObjectType) return;
    let cancelled = false;
    fetchObjects(selectedObjectType, {
      q: search,
      filters: filters.length > 0 ? Object.fromEntries(filters.map((f) => [f.field, f.value])) : undefined,
      sortBy, sortDir,
    }).then((items) => {
      if (cancelled) return;
      setObjects(items);
      setSelectedObjectId((cur) => cur && items.some((i) => i.id === cur) ? cur : (items[0]?.id ?? null));
    }).catch(console.error);
    return () => { cancelled = true; };
  }, [selectedObjectType, search, filters, sortBy, sortDir]);

  useEffect(() => {
    if (!selectedObjectId || !objects.some((o) => o.id === selectedObjectId && o.type === selectedObjectType)) {
      setObjectDetail(null); return;
    }
    let cancelled = false;
    fetchObjectDetail(selectedObjectType, selectedObjectId)
      .then((detail) => { if (!cancelled) setObjectDetail(detail); })
      .catch(console.error);
    return () => { cancelled = true; };
  }, [objects, selectedObjectId, selectedObjectType]);

  const addFilter = useCallback(() => {
    if (!filterField || !filterValue.trim()) return;
    setFilters((c) => [...c.filter((f) => f.field !== filterField), { field: filterField, value: filterValue.trim() }]);
    setFilterValue('');
  }, [filterField, filterValue]);

  const resetFilters = useCallback(() => { setFilters([]); setFilterField(''); setFilterValue(''); }, []);

  const saveCurrentView = useCallback(async () => {
    if (!viewName.trim()) return;
    await saveView({ type: 'object-explorer', name: viewName.trim(), state: { objectType: selectedObjectType, objectId: selectedObjectId, q: search, filters, sortBy, sortDir } });
    setViewName('');
    setObjectViews(await fetchSavedViews('object-explorer'));
  }, [viewName, selectedObjectType, selectedObjectId, search, filters, sortBy, sortDir]);

  const applyView = useCallback((view: SavedViewRecord) => {
    const s = view.state as { objectType?: string; objectId?: string; q?: string; filters?: FilterChip[]; sortBy?: string; sortDir?: 'asc' | 'desc' };
    if (s.objectType) setSelectedObjectType(s.objectType);
    setSearch(s.q ?? '');
    setFilters(s.filters ?? []);
    setSortBy(s.sortBy ?? 'title');
    setSortDir(s.sortDir ?? 'asc');
    setSelectedObjectId(s.objectId ?? null);
  }, []);

  // Derive filterable attribute keys from current objects
  const attributeKeys = objects.length > 0
    ? Object.keys(objects[0]!.attributes).filter((k) => typeof objects[0]!.attributes[k] === 'string')
    : [];

  return (
    <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
      <p className="rounded border border-rim bg-white p-4 text-sm text-[color:var(--text-mid)] xl:col-span-2">
        Diese automatisch abgeleitete Quellvorschau betrachtet höchstens 200 Zeilen je Quelle. Vermutete IDs und Zuordnungen sind keine bestätigten Fachdefinitionen. <a className="font-medium text-brand underline" href="#/model">Objektmengen und Beziehungen im Fachmodell bestätigen</a>.
      </p>
      {/* Left: list + controls */}
      <Card title="Object Explorer">
        {/* Save view */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input className={`${inputCls} max-w-[160px]`} placeholder="Save view as…" value={viewName} onChange={(e) => setViewName(e.target.value)} />
          <button data-testid="save-object-view" className={saveViewBtnCls} onClick={() => void saveCurrentView()} type="button">Save</button>
          {objectViews.map((v) => (
            <button data-testid={`object-view-${v.id}`} key={v.id} className={viewChipCls} onClick={() => applyView(v)} type="button">{v.name}</button>
          ))}
        </div>

        {/* Type tabs */}
        <div className="mb-3 flex flex-wrap gap-1">
          {objectTypes.map((type) => (
            <button
              data-testid={`object-type-${type}`}
              key={type}
              className={`rounded px-3 py-1.5 text-[12px] font-medium transition ${selectedObjectType === type ? 'bg-brand text-white' : 'border border-rim text-[#6b82a0] hover:border-dim hover:text-white'}`}
              onClick={() => setSelectedObjectType(type)}
              type="button"
            >
              {type}
            </button>
          ))}
        </div>

        {/* Search + sort */}
        <div className="mb-3 grid gap-2 md:grid-cols-[1fr_130px_100px]">
          <input data-testid="object-search" className={inputCls} placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select data-testid="object-sort-by" className={selectCls} value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
            <option value="title">Title</option>
            <option value="subtitle">Subtitle</option>
            {attributeKeys.slice(0, 6).map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <select data-testid="object-sort-dir" className={selectCls} value={sortDir} onChange={(e) => setSortDir(e.target.value as 'asc' | 'desc')}>
            <option value="asc">Asc</option>
            <option value="desc">Desc</option>
          </select>
        </div>

        {/* Filter row */}
        <div className="mb-3 grid gap-2">
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
            <select data-testid="object-filter-field" className={selectCls} value={filterField} onChange={(e) => setFilterField(e.target.value)}>
              <option value="">No filter</option>
              {attributeKeys.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <input data-testid="object-filter-value" className={inputCls} placeholder="Value" value={filterValue} onChange={(e) => setFilterValue(e.target.value)} />
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button data-testid="add-object-filter" className={ghostBtnCls} onClick={addFilter} type="button">Add</button>
            <button className={ghostBtnCls} onClick={resetFilters} type="button">Reset</button>
          </div>
        </div>
        {filters.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {filters.map((f) => (
              <button key={`${f.field}-${f.value}`} className={filterChipCls} aria-label={`Filter ${f.field} mit Wert ${f.value} entfernen`} onClick={() => setFilters((c) => c.filter((x) => !(x.field === f.field && x.value === f.value)))} type="button">
                {f.field}={f.value} <UiIcon name="close" size={16} />
              </button>
            ))}
          </div>
        )}

        {/* Object list */}
        <div className="space-y-1">
          {objects.map((obj) => {
            const active = selectedObjectId === obj.id;
            return (
              <div
                data-testid={`object-card-${obj.type}-${obj.id}`}
                key={`${obj.type}-${obj.id}`}
                className={`relative rounded border transition ${active ? 'border-brand-border bg-brand-muted' : 'border-rim bg-ink/40 hover:border-dim'}`}
              >
                {active && <span className="absolute inset-y-0 left-0 w-[2px] rounded-r bg-brand" />}
                <button className="w-full px-3 py-2.5 text-left" onClick={() => setSelectedObjectId(obj.id)} type="button">
                  <div className="flex items-center gap-2">
                    <StatusDot tone={statusTone(obj.attributes.status as string | undefined)} />
                    <span className={`text-[13px] font-medium ${active ? 'text-white' : 'text-[#c8d6ef]'}`}>{obj.title}</span>
                  </div>
                  <div className="mt-0.5 pl-4 text-[11px] text-[#3a4e6a]">{obj.subtitle ?? obj.id}</div>
                </button>
                <div className="flex flex-wrap items-center gap-1.5 border-t border-rim/40 px-3 py-1.5">
                  <Badge>{obj.type}</Badge>
                  <Badge tone={confidenceTone(obj.confidenceLabel)}>{obj.confidence.toFixed(2)}</Badge>
                  <button
                    className="ml-auto rounded border border-rim px-2 py-0.5 text-[10px] text-[#6b82a0] hover:border-brand-border hover:text-[#a0b8e8]"
                    onClick={(e) => { e.stopPropagation(); onAddObjectToBoard(obj); }}
                    type="button"
                  >
                    + Board
                  </button>
                </div>
              </div>
            );
          })}
          {objectTypes.length === 0 && (
            <div className="py-8 text-center text-[12px] text-[#2e415a]">No object types registered. Install a module via Bootstrap.</div>
          )}
        </div>
      </Card>

      {/* Right: detail */}
      <Card
        title={objectDetail ? `Detail · ${objectDetail.summary.title}` : 'Detail'}
        action={objectDetail ? <Badge>{objectDetail.summary.type}</Badge> : undefined}
      >
        {objectDetail ? (
          <div className="space-y-4">
            <div className="rounded border border-rim bg-ink/40 p-3">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#3a4e6a]">Attributes</div>
              <div className="mb-2 text-[11px] text-[#6b82a0]">
                Confidence: <span className="text-[#c8d6ef]">{objectDetail.summary.confidence.toFixed(2)}</span>
                <span className="ml-2">{objectDetail.summary.confidenceLabel}</span>
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                {Object.entries(objectDetail.summary.attributes).map(([key, value]) => (
                  <div key={key} className="rounded border border-rim bg-ink/60 px-2.5 py-2">
                    <div className="text-[10px] uppercase tracking-wide text-[#3a4e6a]">{key}</div>
                    <div className="mt-0.5 font-mono text-[12px] text-[#c8d6ef]">{value == null ? <span className="text-[#1e2e45]">null</span> : String(value)}</div>
                  </div>
                ))}
              </div>
            </div>

            {objectDetail.related.map((group) => (
              <div key={group.label} className="rounded border border-rim bg-ink/40 p-3">
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#3a4e6a]">{group.label}</div>
                {group.items.length === 0 ? (
                  <div className="text-[12px] text-[#2e415a]">No related entries.</div>
                ) : (
                  <div className="space-y-1">
                    {group.items.map((item) => (
                      <div key={`${group.label}-${item.id}`} className="flex items-center justify-between gap-3 rounded border border-rim bg-ink/60 px-3 py-2">
                        <div>
                          <div className="text-[13px] font-medium text-[#c8d6ef]">{item.title}</div>
                          <div className="text-[11px] text-[#3a4e6a]">{item.subtitle ?? item.id}</div>
                        </div>
                        <button
                          className="shrink-0 rounded border border-rim px-2 py-0.5 text-[10px] text-[#6b82a0] hover:border-brand-border hover:text-[#a0b8e8]"
                          onClick={() => onAddObjectToBoard(item)}
                          type="button"
                        >
                          + Board
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-[12px] text-[#2e415a]">No object selected.</div>
        )}

        {/* Actions panel */}
        {objectDetail && (() => {
          const typeActions = availableActions.filter((a) => a.input.split('@')[0]?.trim() === objectDetail.summary.type);
          if (typeActions.length === 0) return null;
          return (
            <div className="mt-4 rounded border p-3" style={{ borderColor: 'rgb(var(--rim))', background: 'rgb(var(--ink)/0.4)' }}>
              <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: 'var(--text-lo)' }}>
                <Zap size={11} />Aktionen
              </div>
              <div className="flex flex-wrap gap-2">
                {typeActions.map((action, index) => {
                  const unavailable = action.executable !== true;
                  const reason = action.unavailableReason || 'Für diese Aktion ist noch keine Ausführung eingerichtet.';
                  const disabled = unavailable || runningAction !== null;
                  const descriptionId = `${actionDescriptionId}-${index}`;
                  return (
                    <div key={`${action.moduleId}:${action.name}`} className="min-w-0 max-w-sm space-y-1.5">
                      <button
                        type="button"
                        disabled={disabled}
                        aria-describedby={unavailable ? descriptionId : undefined}
                        className="inline-flex max-w-full items-center gap-1.5 rounded px-3 py-1.5 text-[12px] font-medium transition"
                        style={{
                          background: 'rgba(79,121,231,0.10)',
                          border: '1px solid rgba(79,121,231,0.30)',
                          color: '#4F79E7',
                          opacity: disabled ? 0.6 : 1,
                          cursor: disabled ? 'not-allowed' : 'pointer',
                        }}
                        onClick={async () => {
                          if (action.executable !== true || runningAction !== null) return;
                          setRunningAction(action.name);
                          setActionResult(null);
                          setActionError('');
                          try {
                            const result = await executeAction(action.name, objectDetail.summary.type, objectDetail.summary.id);
                            setActionResult(result);
                          } catch (e) {
                            setActionError(e instanceof Error ? e.message : 'Die Aktion konnte nicht ausgeführt werden.');
                          } finally {
                            setRunningAction(null);
                          }
                        }}
                      >
                        <Zap size={12} className="shrink-0" />
                        <span className="break-all">{runningAction === action.name ? 'Wird ausgeführt…' : action.name}</span>
                      </button>
                      {unavailable && (
                        <p id={descriptionId} className="text-[12px] leading-relaxed" style={{ color: 'var(--text-mid)' }}>
                          <span className="font-medium">Nicht verfügbar. </span>{reason}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
              {actionError && <p role="alert" className="mt-2 text-[12px] text-red-400">{actionError}</p>}
              {actionResult && (
                <div className="mt-2 rounded border px-3 py-2 text-[12px]"
                  style={{ borderColor: 'rgba(34,197,94,0.25)', background: 'rgba(34,197,94,0.05)', color: '#4ade80' }}>
                  {actionResult.message}
                  <span className="ml-2 opacity-60">{new Date(actionResult.executedAt).toLocaleTimeString()}</span>
                </div>
              )}
            </div>
          );
        })()}
      </Card>
    </div>
  );
}
