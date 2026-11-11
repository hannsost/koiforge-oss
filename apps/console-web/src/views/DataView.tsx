import { useCallback, useEffect, useState } from 'react';

import {
  bootstrapDatasets,
  deleteDataset,
  deleteDatasetsByNamespace,
  fetchDatasetPreview,
  fetchDatasets,
  fetchSavedViews,
  saveView,
  type DatasetPreviewResult,
  type DatasetRecord,
  type SavedViewRecord,
} from '../api';
import { ImportWorkspaceDialog } from '../components/ImportWorkspaceDialog';
import { UiIcon } from '../components/ProductIdentity';
import {
  ActionButton,
  Badge,
  Card,
  DataTable,
  filterChipCls,
  ghostBtnCls,
  inputCls,
  saveViewBtnCls,
  selectCls,
  viewChipCls,
} from '../components/ui';
import '../data-view.css';

interface FilterChip {
  field: string;
  value: string;
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

export function DataView({ onAnalyze }: { onAnalyze?: (datasetId: string) => void } = {}) {
  const [datasets, setDatasets] = useState<DatasetRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [savingView, setSavingView] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(null);
  const [datasetPreview, setDatasetPreview] = useState<DatasetPreviewResult | null>(null);
  const [datasetViews, setDatasetViews] = useState<SavedViewRecord[]>([]);
  const [viewName, setViewName] = useState('');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [filterField, setFilterField] = useState('');
  const [filterValue, setFilterValue] = useState('');
  const [filters, setFilters] = useState<FilterChip[]>([]);

  const selectedDataset = datasets.find((d) => d.id === selectedDatasetId) ?? null;

  const reloadDatasets = useCallback(async () => {
    const [ds, views] = await Promise.all([fetchDatasets(), fetchSavedViews('dataset-preview')]);
    setDatasets(ds);
    setDatasetViews(views);
    setLoadError(null);
    return ds;
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);
    Promise.all([fetchDatasets(), fetchSavedViews('dataset-preview')])
      .then(([ds, views]) => {
        if (!active) return;
        setDatasets(ds);
        setDatasetViews(views);
        setSelectedDatasetId((current) => current || ds[0]?.id || null);
      })
      .catch((reason: unknown) => {
        if (active) setLoadError(errorMessage(reason, 'Bitte versuche es erneut.'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [loadAttempt]);

  useEffect(() => {
    if (!selectedDataset) {
      setDatasetPreview(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }
    let active = true;
    setDatasetPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);
    fetchDatasetPreview(selectedDataset.id, {
      limit: 20,
      q: search,
      filters: filters.length > 0 ? Object.fromEntries(filters.map((f) => [f.field, f.value])) : undefined,
      sortBy: sortBy || undefined,
      sortDir,
    })
      .then((preview) => { if (active) setDatasetPreview(preview); })
      .catch((reason: unknown) => {
        if (active) setPreviewError(errorMessage(reason, 'Bitte versuche es erneut.'));
      })
      .finally(() => { if (active) setPreviewLoading(false); });
    return () => { active = false; };
  }, [selectedDataset, search, filters, sortBy, sortDir, previewAttempt]);

  const addFilter = useCallback(() => {
    if (!filterField || !filterValue.trim()) return;
    setFilters((c) => [...c.filter((f) => f.field !== filterField), { field: filterField, value: filterValue.trim() }]);
    setFilterValue('');
  }, [filterField, filterValue]);

  const resetFilters = useCallback(() => { setFilters([]); setFilterField(''); setFilterValue(''); }, []);

  const saveCurrentView = useCallback(async () => {
    if (!selectedDataset || !viewName.trim()) return;
    setActionError(null);
    setSavingView(true);
    try {
      await saveView({ type: 'dataset-preview', name: viewName.trim(), state: { datasetId: selectedDataset.id, q: search, filters, sortBy, sortDir } });
      setViewName('');
      setDatasetViews(await fetchSavedViews('dataset-preview'));
    } catch (reason) {
      setActionError(errorMessage(reason, 'Die Ansicht konnte nicht gespeichert werden.'));
    } finally {
      setSavingView(false);
    }
  }, [selectedDataset, viewName, search, filters, sortBy, sortDir]);

  const applyView = useCallback((view: SavedViewRecord) => {
    const s = view.state as { datasetId?: string; q?: string; filters?: FilterChip[]; sortBy?: string; sortDir?: 'asc' | 'desc' };
    setSelectedDatasetId(s.datasetId ?? null);
    setSearch(s.q ?? '');
    setFilters(s.filters ?? []);
    setSortBy(s.sortBy ?? '');
    setSortDir(s.sortDir ?? 'asc');
  }, []);

  const removeDataset = useCallback(async (id: string) => {
    if (!window.confirm(`Datenquelle „${id}“ wirklich entfernen?`)) return;
    setActionError(null);
    try {
      await deleteDataset(id);
      setDatasets((prev) => prev.filter((d) => d.id !== id));
      if (selectedDatasetId === id) { setSelectedDatasetId(null); setDatasetPreview(null); }
    } catch (reason) { setActionError(errorMessage(reason, 'Die Datenquelle konnte nicht entfernt werden.')); }
  }, [selectedDatasetId]);

  const removeNamespace = useCallback(async (namespace: string) => {
    if (!window.confirm(`Alle Datenquellen im Bereich „${namespace}“ entfernen?`)) return;
    setActionError(null);
    try {
      const { deleted } = await deleteDatasetsByNamespace(namespace);
      setDatasets((prev) => prev.filter((d) => !deleted.includes(d.id)));
      if (selectedDatasetId && deleted.includes(selectedDatasetId)) { setSelectedDatasetId(null); setDatasetPreview(null); }
    } catch (reason) { setActionError(errorMessage(reason, 'Die Datenquellen konnten nicht entfernt werden.')); }
  }, [selectedDatasetId]);

  const bootstrap = useCallback(async () => {
    setBootstrapping(true);
    setActionError(null);
    try {
      await bootstrapDatasets();
      const [ds, views] = await Promise.all([fetchDatasets(), fetchSavedViews('dataset-preview')]);
      setDatasets(ds);
      setDatasetViews(views);
      setLoadError(null);
      setSelectedDatasetId((current) => current || ds[0]?.id || null);
    } catch (reason) {
      setActionError(errorMessage(reason, 'Beispieldaten konnten nicht geladen werden.'));
    } finally {
      setBootstrapping(false);
    }
  }, []);

  const retryInitialLoad = useCallback(() => setLoadAttempt((attempt) => attempt + 1), []);

  return (
    <>
      {showImport && (
        <ImportWorkspaceDialog
          onClose={() => setShowImport(false)}
          onCompleted={(imported) => {
            void reloadDatasets().then((ds) => {
              const firstImported = imported[0];
              if (firstImported) {
                const refreshed = ds.find((entry) => entry.id === firstImported.id);
                setSelectedDatasetId(refreshed?.id ?? firstImported.id);
              }
            }).catch((reason: unknown) => {
              setActionError(errorMessage(reason, 'Die importierten Datenquellen konnten nicht geladen werden.'));
            }).finally(() => {
              if (imported.length > 0) setShowImport(false);
            });
          }}
        />
      )}

      <div className="kf-data-view space-y-4">
        {actionError && <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-[rgba(239,68,68,0.35)] bg-[rgba(239,68,68,0.06)] px-4 py-3 text-sm text-[#9c332a]" role="alert"><span>{actionError}</span><button className={ghostBtnCls} onClick={() => setActionError(null)} type="button">Schließen</button></div>}

        <div className={`grid gap-4 ${selectedDataset ? 'xl:grid-cols-[280px_minmax(0,1fr)]' : ''}`}>
          <Card
            title="Deine Quellen"
            action={
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={loading ? 'warning' : loadError ? 'danger' : datasets.length === 0 ? 'neutral' : 'success'}>
                  {loading ? 'Lädt…' : loadError ? 'Laden fehlgeschlagen' : `${datasets.length} ${datasets.length === 1 ? 'Quelle' : 'Quellen'}`}
                </Badge>
                <ActionButton onClick={() => { setActionError(null); setShowImport(true); }} busy={false} busyLabel="Importdialog wird geöffnet…" label="Datenquelle hinzufügen" />
                <details className="relative">
                  <summary className="kf-button cursor-pointer rounded border border-rim px-3 py-1.5 text-sm font-medium text-[color:var(--text-mid)] hover:border-dim hover:text-[color:var(--text-hi)]">Beispieldaten</summary>
                  <div className="mt-2 w-72 max-w-full space-y-3 rounded border border-rim bg-white p-4 shadow-lg sm:absolute sm:right-0 sm:z-10">
                    <p className="text-sm leading-5 text-[color:var(--text-mid)]">Ergänzt Beispieldatasets zu Ereignissen, Kennzahlen und Lieferanten. Bereits registrierte Beispiele werden nicht dupliziert.</p>
                    <ActionButton onClick={() => void bootstrap()} busy={bootstrapping} busyLabel="Beispieldaten werden geladen…" label="Beispieldaten laden" variant="ghost" />
                  </div>
                </details>
              </div>
            }
          >
            <div className="space-y-3">
              {loading && <div className="text-sm text-[color:var(--text-mid)]" role="status">Datenquellen werden geladen…</div>}
              {loadError && (
                <div className="space-y-3 rounded border border-[rgba(239,68,68,0.35)] bg-[rgba(239,68,68,0.06)] p-4 text-sm text-[#9c332a]" role="alert">
                  <p>Datenquellen konnten nicht geladen werden. {loadError}</p>
                  <button className={ghostBtnCls} onClick={retryInitialLoad} type="button">Erneut laden</button>
                </div>
              )}
              {!loading && !loadError && datasets.length === 0 && (
                <div className="space-y-2 rounded border border-rim bg-[color:var(--nf-soft)] p-4">
                  <p className="text-sm font-semibold text-[color:var(--text-hi)]">Noch keine Datenquelle vorhanden.</p>
                  <p className="text-sm leading-6 text-[color:var(--text-mid)]">Füge eine Datenquelle hinzu. Danach kannst du sie auswählen und ihre Zeilen ansehen.</p>
                </div>
              )}
              {[...new Set(datasets.map((d) => d.namespace))].sort().map((ns) => (
                <div key={ns}>
                  <div className="group mb-1 flex items-center justify-between px-2">
                    <span style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-lo)' }}>{ns}</span>
                    <button
                      className="rounded px-1 py-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                      style={{ color: 'var(--text-lo)' }}
                      onClick={() => void removeNamespace(ns)}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ef4444'; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--text-lo)'; }}
                      type="button"
                      aria-label={`Alle Datenquellen im Bereich ${ns} entfernen`}
                      title={`Alle Datenquellen im Bereich ${ns} entfernen`}
                    >
                      Alle entfernen
                    </button>
                  </div>
                  {datasets.filter((d) => d.namespace === ns).map((ds) => {
                    const active = selectedDatasetId === ds.id;
                    return (
                      <div key={ds.id} className={`group relative flex items-center rounded border transition ${active ? 'border-brand-border bg-brand-muted' : 'border-transparent hover:border-rim'}`}>
                        {active && <span className="absolute inset-y-0 left-0 w-[2px] rounded-r bg-brand" />}
                        <button
                          data-testid={`dataset-item-${ds.id}`}
                          className="min-w-0 flex-1 text-left"
                          style={{ padding: '6px 4px 6px 14px' }}
                          onClick={() => setSelectedDatasetId(ds.id)}
                          type="button"
                          aria-pressed={active}
                          aria-label={`${ds.name} als Datenquelle auswählen`}
                        >
                          <div className="truncate text-[13px] font-medium leading-5" style={{ color: active ? undefined : 'var(--text-hi)' }}>{ds.name}</div>
                          <div className="text-[11px]" style={{ color: 'var(--text-lo)' }}>{ds.connectorId}</div>
                        </button>
                        <button
                          className="mr-2 flex-shrink-0 rounded px-1.5 py-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                          style={{ color: 'var(--text-lo)', background: 'transparent' }}
                          onClick={(e) => { e.stopPropagation(); void removeDataset(ds.id); }}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ef4444'; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--text-lo)'; }}
                          type="button"
                          aria-label={`Datenquelle ${ds.name} entfernen`}
                          title="Datenquelle entfernen"
                        >
                          Entfernen
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </Card>

          {selectedDataset && (
            <Card
              title={`Datenvorschau · ${selectedDataset.name}`}
              action={<><Badge><span title={selectedDataset.id}>{selectedDataset.id}</span></Badge>{selectedDataset.connectorId === 'inline' && onAnalyze && <button type="button" className={ghostBtnCls} onClick={() => onAnalyze(selectedDataset.id)}>Quellenalter auswerten</button>}</>}
            >
              <div>
                {previewLoading && <div className="py-6 text-sm text-[color:var(--text-mid)]" role="status">Datenvorschau wird geladen…</div>}
                {previewError && (
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded border border-[rgba(239,68,68,0.35)] bg-[rgba(239,68,68,0.06)] px-4 py-3 text-sm text-[#9c332a]" role="alert">
                    <span>Datenvorschau konnte nicht geladen werden. {previewError}</span>
                    <button className={ghostBtnCls} onClick={() => setPreviewAttempt((attempt) => attempt + 1)} type="button">Erneut versuchen</button>
                  </div>
                )}
                {!previewLoading && !previewError && datasetPreview && <DataTable preview={datasetPreview} />}

                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <input aria-label="Gespeicherte Ansicht benennen" className={`${inputCls} max-w-[240px]`} placeholder="Ansicht benennen…" value={viewName} onChange={(e) => setViewName(e.target.value)} />
                  <button data-testid="save-dataset-view" className={saveViewBtnCls} onClick={() => void saveCurrentView()} disabled={savingView || !viewName.trim()} type="button">{savingView ? 'Speichert…' : 'Ansicht speichern'}</button>
                  {datasetViews.map((v) => (
                    <button data-testid={`dataset-view-${v.id}`} key={v.id} className={viewChipCls} onClick={() => applyView(v)} type="button" aria-label={`Gespeicherte Ansicht ${v.name} laden`}>{v.name}</button>
                  ))}
                </div>

                <div className="mb-3 grid gap-2 md:grid-cols-[1fr_160px_140px]">
                  <input data-testid="dataset-search" aria-label="Datenzeilen suchen" className={inputCls} placeholder="Datenzeilen suchen…" value={search} onChange={(e) => setSearch(e.target.value)} />
                  <select data-testid="dataset-sort-by" aria-label="Sortieren nach" className={selectCls} value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                    <option value="">Keine Sortierung</option>
                    {selectedDataset.schema.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
                  </select>
                  <select data-testid="dataset-sort-dir" aria-label="Sortierreihenfolge" className={selectCls} value={sortDir} onChange={(e) => setSortDir(e.target.value as 'asc' | 'desc')}>
                    <option value="asc">Aufsteigend</option>
                    <option value="desc">Absteigend</option>
                  </select>
                </div>

                <div className="mb-3 grid gap-2 md:grid-cols-[160px_1fr_auto]">
                  <select data-testid="dataset-filter-field" aria-label="Filterfeld" className={selectCls} value={filterField} onChange={(e) => setFilterField(e.target.value)}>
                    <option value="">Kein Filterfeld</option>
                    {selectedDataset.schema.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
                  </select>
                  <input data-testid="dataset-filter-value" aria-label="Exakten Filterwert eingeben" className={inputCls} placeholder="Exakter Wert" value={filterValue} onChange={(e) => setFilterValue(e.target.value)} />
                  <div className="flex flex-wrap gap-1.5">
                    <button data-testid="add-dataset-filter" className={ghostBtnCls} onClick={addFilter} disabled={!filterField || !filterValue.trim()} type="button">Filter hinzufügen</button>
                    <button className={ghostBtnCls} onClick={resetFilters} disabled={filters.length === 0 && !filterField && !filterValue} type="button">Filter zurücksetzen</button>
                  </div>
                </div>

                {filters.length > 0 && (
                  <div className="mb-3 flex flex-wrap gap-1.5" aria-label="Aktive Filter">
                    {filters.map((f) => (
                      <button key={`${f.field}-${f.value}`} className={filterChipCls} onClick={() => setFilters((current) => current.filter((item) => !(item.field === f.field && item.value === f.value)))} type="button" aria-label={`Filter ${f.field} mit Wert ${f.value} entfernen`}>
                        {f.field}={f.value} <UiIcon name="close" size={16} />
                      </button>
                    ))}
                  </div>
                )}

              </div>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
