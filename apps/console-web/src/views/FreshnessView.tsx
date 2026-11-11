import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  fetchDatasetPreview,
  fetchDatasets,
  type DatasetPreviewResult,
  type DatasetRecord,
} from '../api';
import {
  createFreshnessRun,
  fetchFreshnessRun,
  fetchFreshnessRuns,
  fetchFreshnessReadiness,
  type FreshnessReadiness,
  type FreshnessResult,
  type FreshnessRun,
  type FreshnessRunStatus,
} from '../freshness-api';
import { Badge, Card, ghostBtnCls, inputCls, selectCls } from '../components/ui';
import { ImportWorkspaceDialog } from '../components/ImportWorkspaceDialog';
import { AnalysisDateTime } from '../components/AnalysisDateTime';

const DEFAULT_QUESTION = 'Welche Quellen müssen aktualisiert oder geklärt werden?';

function localIsoWithOffset(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function hasExplicitOffset(value: string): boolean {
  return /T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.trim()) && !Number.isNaN(Date.parse(value));
}

function statusLabel(status: FreshnessResult['status']): string {
  if (status === 'current') return 'aktuell';
  if (status === 'stale') return 'veraltet';
  return 'nicht beurteilbar';
}

function statusTone(status: FreshnessResult['status']): 'success' | 'warning' | 'danger' {
  if (status === 'current') return 'success';
  if (status === 'stale') return 'warning';
  return 'danger';
}

function runStatusLabel(status: FreshnessRunStatus): string {
  if (status === 'completed') return 'abgeschlossen';
  if (status === 'completed_with_gaps') return 'mit Lücken abgeschlossen';
  return 'blockiert';
}

function formatAge(ageSeconds: number | null): string {
  if (ageSeconds === null) return '—';
  if (ageSeconds < 60) return `${Math.round(ageSeconds)} s`;
  if (ageSeconds < 3600) return `${Math.round(ageSeconds / 60)} min`;
  return `${(ageSeconds / 3600).toFixed(1)} h`;
}

function formatMaxAge(seconds: number | undefined): string {
  if (!Number.isFinite(seconds) || !seconds || seconds <= 0) return '—';
  const value = seconds % 3600 === 0 ? `${seconds / 3600} h` : `${seconds.toLocaleString('de-DE')} s`;
  return `${value} · ${seconds.toLocaleString('de-DE')} s`;
}

function reasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    within_interval: 'Innerhalb des Intervalls',
    interval_exceeded: 'Intervall überschritten',
    missing_timestamp: 'Zeitstempel fehlt',
    invalid_timestamp: 'Zeitstempel ist ungültig',
    future_timestamp: 'Zeitstempel liegt in der Zukunft',
  };
  return labels[reason] ?? reason;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('de-DE');
}

function inferredColumn(columns: string[], kind: 'id' | 'timestamp'): string {
  const pattern = kind === 'id'
    ? /^(source[_ ]?id|id|key|source)$/i
    : /(^updated$|source[_ ]?updated|updated[_ ]?at|timestamp|last[_ ]?updated|modified)/i;
  return columns.find((column) => pattern.test(column)) ?? '';
}

function sourceRef(result: FreshnessResult): string {
  return result.sourceUpdatedAt
    ? `${result.sourceId} · ${result.sourceUpdatedAt}`
    : `${result.sourceId} · Zeitstempel fehlt`;
}

function generationLabel(readiness: FreshnessReadiness): string | null {
  const generation = readiness.generation;
  if (!generation) return null;
  if (generation.backend === 'codex') {
    // Keep the local CLI setup understandable without exposing implementation
    // paths or turning the local backend into an API-key configuration.
    const model = generation.model.toLowerCase().includes('astra') ? 'Astra' : generation.model;
    return `Codex · ${model || 'Astra'} · ${generation.reasoningEffort || 'xhigh'}`;
  }
  return `API · ${generation.model || 'Modell'} · ${generation.reasoningEffort || 'Modellstandard'}`;
}

export interface FreshnessDraft {
  datasetId: string;
  question: string;
  sourceId: string;
  sourceUpdatedAt: string;
  asOf: string;
  maxAgeValue: string;
  maxAgeUnit: 'hours' | 'seconds';
}

export function FreshnessView({ onOpenSources, initialDatasetId = '', draft, onDraftChange }: {
  onOpenSources?: () => void;
  initialDatasetId?: string;
  draft?: FreshnessDraft;
  onDraftChange?: (draft: FreshnessDraft) => void;
} = {}) {
  const [datasets, setDatasets] = useState<DatasetRecord[]>([]);
  const [datasetId, setDatasetId] = useState(initialDatasetId || draft?.datasetId || '');
  const [preview, setPreview] = useState<DatasetPreviewResult | null>(null);
  const [runs, setRuns] = useState<Array<{ id: string; question: string; status: FreshnessRunStatus; createdAt: string; datasetId: string; moduleHash?: string; error?: string }>>([]);
  const [selectedRun, setSelectedRun] = useState<FreshnessRun | null>(null);
  const [question, setQuestion] = useState(draft?.question ?? DEFAULT_QUESTION);
  const [sourceId, setSourceId] = useState(draft?.sourceId ?? '');
  const [sourceUpdatedAt, setSourceUpdatedAt] = useState(draft?.sourceUpdatedAt ?? '');
  const [asOf, setAsOf] = useState(draft?.asOf ?? localIsoWithOffset());
  const [maxAgeValue, setMaxAgeValue] = useState(draft?.maxAgeValue ?? '24');
  const [maxAgeUnit, setMaxAgeUnit] = useState<'hours' | 'seconds'>(draft?.maxAgeUnit ?? 'hours');
  const [confirmedTimestampMeaning, setConfirmedTimestampMeaning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [loadingRun, setLoadingRun] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [showImport, setShowImport] = useState(false);
  const [importNotice, setImportNotice] = useState('');
  const [readiness, setReadiness] = useState<FreshnessReadiness | null>(null);
  const [readinessError, setReadinessError] = useState('');
  const [readinessAttempt, setReadinessAttempt] = useState(0);
  const resultHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!selectedRun) return;
    resultHeading.current?.focus({ preventScroll: true });
    resultHeading.current?.scrollIntoView({ block: 'start' });
  }, [selectedRun]);

  useEffect(() => {
    onDraftChange?.({ datasetId, question, sourceId, sourceUpdatedAt, asOf, maxAgeValue, maxAgeUnit });
  }, [onDraftChange, datasetId, question, sourceId, sourceUpdatedAt, asOf, maxAgeValue, maxAgeUnit]);

  const selectedDataset = useMemo(
    () => datasets.find((dataset) => dataset.id === datasetId) ?? null,
    [datasets, datasetId],
  );
  const columns = useMemo(
    () => preview?.columns ?? selectedDataset?.schema.map((field) => field.name) ?? [],
    [preview, selectedDataset],
  );

  const loadRuns = useCallback(async () => {
    const nextRuns = await fetchFreshnessRuns();
    setRuns(nextRuns);
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError('');
    setHistoryError('');
    Promise.allSettled([fetchDatasets(), fetchFreshnessRuns()])
      .then(([sources, history]) => {
        if (!active) return;
        if (sources.status === 'fulfilled') {
          const importedDatasets = sources.value.filter(dataset => dataset.connectorId === 'inline');
          setDatasets(importedDatasets);
          setDatasetId(current => importedDatasets.some(dataset => dataset.id === current) ? current : importedDatasets[0]?.id ?? '');
        } else setLoadError('Datenquellen konnten nicht geladen werden. Deine bisherigen Auswertungen bleiben separat verfügbar.');
        if (history.status === 'fulfilled') setRuns(history.value);
        else setHistoryError('Bisherige Auswertungen konnten nicht geladen werden.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [loadAttempt]);

  useEffect(() => {
    let active = true;
    setReadiness(null);
    setReadinessError('');
    fetchFreshnessReadiness().then(value => { if (active) setReadiness(value); })
      .catch(() => { if (active) setReadinessError('Bereitschaft konnte nicht geprüft werden.'); });
    return () => { active = false; };
  }, [readinessAttempt]);

  useEffect(() => {
    if (!datasetId) {
      setPreview(null);
      return;
    }
    let active = true;
    setLoadingPreview(true);
    setPreview(null);
    setPreviewError('');
    fetchDatasetPreview(datasetId, { limit: 100 })
      .then((nextPreview) => {
        if (active) setPreview(nextPreview);
      })
      .catch((reason: unknown) => {
        if (active) setPreviewError(reason instanceof Error ? reason.message : 'Datenvorschau konnte nicht geladen werden.');
      })
      .finally(() => {
        if (active) setLoadingPreview(false);
      });
    return () => { active = false; };
  }, [datasetId, previewAttempt]);

  useEffect(() => {
    if (!columns.length) {
      if (!loading && !loadingPreview) { setSourceId(''); setSourceUpdatedAt(''); }
      return;
    }
    setSourceId((current) => columns.includes(current) ? current : inferredColumn(columns, 'id'));
    setSourceUpdatedAt((current) => columns.includes(current) ? current : inferredColumn(columns, 'timestamp'));
    setConfirmedTimestampMeaning(false);
  }, [columns, loading, loadingPreview]);

  const selectRun = useCallback(async (id: string) => {
    setLoadingRun(true);
    setError(null);
    try {
      setSelectedRun(await fetchFreshnessRun(id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Auswertung konnte nicht geladen werden.');
    } finally {
      setLoadingRun(false);
    }
  }, []);

  const submit = useCallback(async () => {
    setFormError(null);
    if (!question.trim()) return setFormError('Bitte eine Bezeichnung für diese Auswertung angeben.');
    if (!datasetId || !selectedDataset) return setFormError('Bitte eine importierte Quelle auswählen.');
    if (!preview) return setFormError('Bitte zuerst die Datenvorschau laden.');
    if (!sourceId || !sourceUpdatedAt) return setFormError('Bitte Quellschlüssel und Aktualisierungsfeld auswählen.');
    if (sourceId === sourceUpdatedAt) return setFormError('Quellschlüssel und Aktualisierungsfeld müssen zwei verschiedene Felder sein.');
    if (!hasExplicitOffset(asOf)) return setFormError('Bitte einen gültigen Stichtag mit eindeutiger Zeitzone wählen.');
    const numericAge = Number(maxAgeValue);
    const maxAgeSeconds = maxAgeUnit === 'hours' ? Math.round(numericAge * 3600) : numericAge;
    if (!Number.isFinite(numericAge) || numericAge <= 0 || !Number.isInteger(maxAgeSeconds) || maxAgeSeconds <= 0 || maxAgeSeconds > 315_360_000) return setFormError('Die maximale Aktualität muss zwischen 1 und 315.360.000 Sekunden liegen.');
    if (!confirmedTimestampMeaning) return setFormError('Bitte bestätige, dass das gewählte Feld die Aktualisierung der Quelle beschreibt.');
    if (!readiness?.ready) return setFormError('Die Auswertung ist noch nicht bereit. Bitte die Einrichtung oben prüfen.');

    setRunning(true);
    setError(null);
    try {
      const run = await createFreshnessRun({
        question: question.trim(),
        datasetId,
        mapping: { sourceId, sourceUpdatedAt },
        rule: {
          asOf: asOf.trim(),
          maxAgeSeconds,
          timestampMeaning: 'source_updated_at',
          timezone: 'explicit-offset',
        },
      });
      setSelectedRun(run);
      setReadinessAttempt(attempt => attempt + 1);
      try { await loadRuns(); setHistoryError(''); }
      catch { setHistoryError('Das Ergebnis ist gespeichert. Die Liste der Auswertungen konnte nicht aktualisiert werden.'); }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Auswertung konnte nicht gestartet werden.');
    } finally {
      setRunning(false);
    }
  }, [asOf, confirmedTimestampMeaning, datasetId, loadRuns, maxAgeValue, maxAgeUnit, preview, question, selectedDataset, sourceId, sourceUpdatedAt, readiness]);

  if (loading) {
    return <div className="rounded border border-rim px-5 py-8 text-sm text-[color:var(--text-mid)]" role="status">Datenquellen und Auswertungen werden geladen…</div>;
  }

  return (
    <div className="space-y-5">
      {showImport && <ImportWorkspaceDialog onClose={() => setShowImport(false)} onCompleted={imported => {
        const available = imported.filter(dataset => dataset.connectorId === 'inline');
        setDatasets(current => [...current.filter(dataset => !available.some(item => item.id === dataset.id)), ...available]);
        if (available[0]) {
          setDatasetId(available[0].id);
          setImportNotice(`${available.length === 1 ? 'Quelle übernommen' : `${available.length} Quellen übernommen`}. Prüfe jetzt die Feldzuordnung und den Stichtag.`);
        } else setImportNotice('Quelle hinzugefügt. Für diese Prüfung wird ein vollständig importierter Datenstand benötigt.');
        setShowImport(false);
      }} />}
      {error && <div className="rounded border border-[rgba(239,68,68,0.35)] bg-[rgba(239,68,68,0.08)] px-4 py-3 text-sm text-[#9c332a]" role="alert">{error}</div>}
      {loadError && <div className="space-y-2 rounded border border-rim p-4 text-sm" role="alert"><p>{loadError}</p><button className={ghostBtnCls} type="button" onClick={() => setLoadAttempt(attempt => attempt + 1)}>Datenquellen erneut laden</button></div>}
      {importNotice && <p className="rounded border border-brand-border bg-brand-muted p-3 text-sm text-brand" role="status">{importNotice}</p>}

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-3xl space-y-1.5">
          <h2 className="text-[length:var(--nf-text-heading)] font-semibold leading-[var(--nf-leading-heading)] tracking-tight text-[color:var(--text-hi)]">Quellenalter prüfen</h2>
          <p className="text-sm leading-6 text-[color:var(--text-mid)]">Welche Quellen sind aktuell, veraltet oder noch zu klären? Wähle einen Datenstand und lege fest, wie alt eine Quelle sein darf.</p>
          <p className="text-xs leading-5 text-[color:var(--text-lo)]">Verfügbare Analyse: Quellenalter anhand von Aktualisierungszeitpunkten. Das Ergebnis enthält den Datenstand und eine Begründung je Quelle.</p>
        </div>
        {datasets.length > 0 && <Badge tone="neutral">Importierte Quelle</Badge>}
      </header>

      <section aria-label="Bereitschaft der Auswertung" className="rounded border border-rim bg-white p-4 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <strong className="text-[color:var(--text-hi)]">{readiness?.ready ? 'Bereit für deine Auswertung' : readiness || readinessError ? 'Einrichtung prüfen' : 'Bereitschaft wird geprüft…'}</strong>
          <button className={ghostBtnCls} type="button" disabled={!readiness && !readinessError} onClick={() => setReadinessAttempt(attempt => attempt + 1)}>Erneut prüfen</button>
        </div>
        {readinessError ? <p className="mt-2 text-[#9c332a]" role="alert">{readinessError} Quellen und gespeicherte Ergebnisse bleiben zugänglich.</p> : readiness ? <div className="mt-2 space-y-2 text-[color:var(--text-mid)]">
          <p>{readiness.capability === 'available'
            ? 'Eine geprüfte Fähigkeit ist gespeichert und wird wiederverwendet.'
            : readiness.provider === 'disabled'
              ? 'Für diese Analyse fehlt eine geprüfte Fähigkeit. Das Erzeugen neuer Fähigkeiten ist vom Betreiber deaktiviert.'
              : readiness.generation?.backend === 'codex'
                ? readiness.generation.available
                  ? 'Beim ersten Start ergänzt die lokale Codex-CLI die Analysefähigkeit. KoiForge prüft sie vor der Übernahme.'
                  : readiness.generation.reason ?? 'Die lokale Codex-CLI ist noch nicht verfügbar. Prüfe Installation und Login und starte danach eine neue Prüfung.'
                : readiness.provider === 'configured'
                  ? 'Beim ersten Start ergänzt das eingerichtete Modell die Analysefähigkeit. KoiForge prüft sie vor der Übernahme. Die Modellverbindung wird beim Start geprüft.'
                  : 'Für die erste Auswertung fehlt ein eingerichtetes KI-Modell.'}</p>
          {generationLabel(readiness) && readiness.provider !== 'disabled' && <p>Ausführungsweg: <strong className="font-semibold text-[color:var(--text-hi)]">{generationLabel(readiness)}</strong>.</p>}
          {readiness.generation?.backend !== 'codex' && readiness.provider === 'missing' && <a className="font-medium text-brand underline" href="#/agents">KI-Modell einrichten</a>}
          <p>{readiness.runtime === 'ready' ? 'Geschützte Ausführung erfolgreich geprüft.' : 'Geschützte Ausführung ist gerade nicht verfügbar. Bitte erneut prüfen oder den Betreiber kontaktieren.'}</p>
        </div> : <p className="mt-2 text-[color:var(--text-mid)]" role="status">Gespeicherte Fähigkeit und geschützte Ausführung werden geprüft. Dabei wird kein KI-Modell aufgerufen.</p>}
      </section>

      {datasets.length === 0 && !loadError ? (
        <Card title="01 · Quelle wählen">
          <div className="flex flex-col items-start gap-4 rounded border px-4 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-5" style={{ borderColor: 'rgb(var(--brand-rgb, 23 63 49) / 0.28)', backgroundColor: 'rgb(var(--brand-rgb, 23 63 49) / 0.06)' }}>
            <div className="max-w-2xl space-y-1.5">
              <h2 className="text-base font-semibold text-[color:var(--text-hi)]">Keine importierte Quelle verfügbar.</h2>
              <p className="text-sm leading-6 text-[color:var(--text-mid)]">Füge zuerst eine Datenquelle hinzu. Danach legst du die Prüfregel fest und kannst Status und Begründungen nachvollziehen.</p>
            </div>
            <button type="button" onClick={() => setShowImport(true)} className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold text-white transition hover:brightness-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" style={{ backgroundColor: 'rgb(var(--brand-rgb, 23 63 49))', outlineColor: 'rgb(var(--brand-rgb, 23 63 49))' }}>
              Datenquelle hinzufügen
            </button>
          </div>
        </Card>
      ) : datasets.length > 0 ? (
        <>
          <Card title="01 · Quelle wählen" action={<button className={ghostBtnCls} type="button" onClick={() => setShowImport(true)}>Datenquelle hinzufügen</button>}>
            <div className="grid gap-4 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
              <label className="block text-[length:var(--nf-text-label)] leading-[var(--nf-leading-body)] text-[color:var(--text-hi)]">
                <span className="mb-1.5 block font-medium">Importierte Quelle</span>
                <select className={selectCls} value={datasetId} onChange={(event) => setDatasetId(event.target.value)} aria-label="Importierte Quelle">
                  {datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name} · {dataset.id}</option>)}
                </select>
                <span className="mt-1.5 block text-xs text-[color:var(--text-lo)]">{selectedDataset?.description ?? 'Die Prüfung verwendet alle importierten Zeilen dieser Quelle.'}</span>
              </label>

              <label className="block text-[length:var(--nf-text-label)] leading-[var(--nf-leading-body)] text-[color:var(--text-hi)]">
                <span className="mb-1.5 block font-medium">Bezeichnung der Auswertung</span>
                <textarea className={`${inputCls} min-h-[88px] resize-y`} maxLength={1000} value={question} onChange={(event) => setQuestion(event.target.value)} aria-label="Bezeichnung der Auswertung" />
                <span className="mt-1.5 block text-xs text-[color:var(--text-lo)]">Unter diesem Namen findest du den Quellenalter-Vergleich später wieder.</span>
              </label>
            </div>
          </Card>

          {previewError && <div className="space-y-2 rounded border border-rim p-4 text-sm" role="alert"><p>Datenvorschau konnte nicht geladen werden. {previewError}</p><button className={ghostBtnCls} type="button" onClick={() => setPreviewAttempt(attempt => attempt + 1)}>Vorschau erneut laden</button></div>}

          <Card title="02 · Prüfregel festlegen">
            <div className="space-y-4">
              <p className="text-sm leading-6 text-[color:var(--text-mid)]">Ordne die Felder zu und bestätige, was der Zeitstempel bedeutet. Die Regel nutzt den angegebenen Stichtag und das maximale Quellenalter.</p>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="block text-[length:var(--nf-text-label)] leading-[var(--nf-leading-body)] text-[color:var(--text-hi)]">
                  <span className="mb-1.5 block font-medium">Quellschlüssel</span>
                  <select className={selectCls} value={sourceId} onChange={(event) => setSourceId(event.target.value)} disabled={columns.length === 0} aria-label="Quellschlüssel">
                    <option value="">Feld auswählen…</option>
                    {columns.map((column) => <option key={column} value={column}>{column}</option>)}
                  </select>
                </label>
                <label className="block text-[length:var(--nf-text-label)] leading-[var(--nf-leading-body)] text-[color:var(--text-hi)]">
                  <span className="mb-1.5 block font-medium">Aktualisierungszeitpunkt</span>
                  <select className={selectCls} value={sourceUpdatedAt} onChange={(event) => setSourceUpdatedAt(event.target.value)} disabled={columns.length === 0} aria-label="Aktualisierungszeitpunkt">
                    <option value="">Feld auswählen…</option>
                    {columns.map((column) => <option key={column} value={column}>{column}</option>)}
                  </select>
                </label>
              </div>

              <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <AnalysisDateTime value={asOf} onChange={setAsOf} />
                <div>
                  <span className="mb-1.5 block text-[length:var(--nf-text-label)] font-medium leading-[var(--nf-leading-body)] text-[color:var(--text-hi)]">Maximales Quellenalter</span>
                  <div className="grid grid-cols-[minmax(0,1fr)_130px] gap-2">
                    <input className={inputCls} type="number" min={maxAgeUnit === 'hours' ? '0.01' : '1'} step={maxAgeUnit === 'hours' ? '0.1' : '1'} value={maxAgeValue} onChange={(event) => setMaxAgeValue(event.target.value)} aria-label="Maximales Quellenalter" />
                    <select className={selectCls} value={maxAgeUnit} onChange={(event) => setMaxAgeUnit(event.target.value as 'hours' | 'seconds')} aria-label="Einheit für maximales Quellenalter">
                      <option value="hours">Stunden</option>
                      <option value="seconds">Sekunden</option>
                    </select>
                  </div>
                  <span className="mt-1.5 block text-xs text-[color:var(--text-lo)]">Beispiel: Bei 24 Stunden gelten ältere Quellen als veraltet.</span>
                </div>
              </div>

              <label className="flex items-start gap-2 rounded border border-rim bg-ink/30 px-3 py-3 text-sm text-[color:var(--text-hi)]">
                <input className="mt-1" type="checkbox" checked={confirmedTimestampMeaning} onChange={(event) => setConfirmedTimestampMeaning(event.target.checked)} />
                <span><strong className="font-semibold">Aktualisierungszeitpunkt bestätigen:</strong> Das ausgewählte Feld enthält den Zeitpunkt, an dem die Quelle aktualisiert wurde. Die Werte enthalten eine Zeitzone, zum Beispiel +02:00 oder Z. Fehlende oder ungültige Werte bleiben als Klärungsfälle sichtbar.</span>
              </label>

              <div className="flex flex-wrap items-center gap-3">
                <button className="kf-button rounded bg-brand px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50" type="button" disabled={running || loadingPreview || !preview || !readiness?.ready} onClick={() => void submit()}>{running ? 'Auswertung läuft…' : 'Quellenalter prüfen'}</button>
                {loadingPreview ? <span className="text-xs text-[color:var(--text-lo)]" role="status">Vorschau laden…</span> : preview ? <span className="text-xs text-[color:var(--text-lo)]">Vorschau: {preview.rows.length.toLocaleString('de-DE')} von {preview.rowCount.toLocaleString('de-DE')} Zeilen</span> : null}
              </div>
              {running && <p className="text-sm text-[color:var(--text-mid)]" role="status">KoiForge prüft den vollständigen Datenstand, führt die Analyse aus und speichert das Ergebnis mit Belegen. {readiness?.capability === 'missing' && readiness.generation?.backend === 'codex' ? 'Die erste lokale Generierung kann einige Minuten dauern; es wird kein künstlicher Fortschritt angezeigt.' : 'Eine neue Fähigkeit wird vorher unabhängig geprüft.'}</p>}
              {formError && <div className="text-sm text-[#9c332a]" role="alert">{formError}</div>}
            </div>
          </Card>
        </>
      ) : null}

      {onOpenSources && <button className={ghostBtnCls} type="button" onClick={onOpenSources}>Datenquellen verwalten</button>}
      {historyError && <div className="space-y-2 rounded border border-rim p-4 text-sm" role="alert"><p>{historyError}</p><button className={ghostBtnCls} type="button" onClick={() => { void loadRuns().then(() => setHistoryError('')).catch(() => setHistoryError('Bisherige Auswertungen konnten nicht geladen werden.')); }}>Auswertungen erneut laden</button></div>}

      {(datasets.length > 0 || runs.length > 0) && <Card title={datasets.length > 0 ? "03 · Ergebnis nachvollziehen" : "Bisherige Auswertungen"}>
        <div className="grid gap-5 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.5fr)]">
          <section className="min-w-0 space-y-3" aria-labelledby="freshness-history-heading">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="freshness-history-heading" className="text-[length:var(--nf-text-section)] font-semibold leading-[var(--nf-leading-section)] text-[color:var(--text-hi)]">Bisherige Auswertungen</h2>
              <Badge>{runs.length}</Badge>
            </div>
            {runs.length === 0 ? (
              <div className="text-sm text-[color:var(--text-mid)]">Noch keine Auswertung vorhanden.</div>
            ) : (
              <div className="space-y-2" aria-label="Bisherige Auswertungen">
                {runs.map((run) => (
                  <button key={run.id} className={`w-full rounded border px-3 py-2 text-left transition ${selectedRun?.id === run.id ? '' : 'border-rim hover:border-dim'}`} style={selectedRun?.id === run.id ? { borderColor: 'rgb(var(--brand-rgb, 23 63 49) / 0.45)', backgroundColor: 'rgb(var(--brand-rgb, 23 63 49) / 0.08)' } : undefined} onClick={() => void selectRun(run.id)} type="button">
                    <div className="flex flex-col items-start gap-2">
                      <span className="w-full break-words whitespace-normal text-sm font-medium text-[color:var(--text-hi)]">{run.question}</span>
                      <Badge tone={run.status === 'completed' ? 'success' : run.status === 'blocked' ? 'danger' : 'warning'}>{runStatusLabel(run.status)}</Badge>
                    </div>
                    <div className="mt-1 text-xs [overflow-wrap:anywhere] text-[color:var(--text-lo)]">{run.datasetId} · {formatDate(run.createdAt)}</div>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="order-first min-w-0 space-y-3 xl:order-none" aria-labelledby="freshness-result-heading">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="freshness-result-heading" ref={resultHeading} tabIndex={-1} className="scroll-mt-28 text-[length:var(--nf-text-section)] font-semibold leading-[var(--nf-leading-section)] text-[color:var(--text-hi)]">Ergebnis</h2>
              {loadingRun ? <Badge tone="warning">lädt…</Badge> : selectedRun ? <Badge tone={selectedRun.status === 'completed' ? 'success' : selectedRun.status === 'blocked' ? 'danger' : 'warning'}>{runStatusLabel(selectedRun.status)}</Badge> : null}
            </div>
            {!selectedRun ? (
              <div className="text-sm text-[color:var(--text-mid)]">Wähle eine Auswertung aus, um Ergebnisse und Begründungen zu sehen.</div>
            ) : (
              <div className="space-y-4">
                <div className="rounded border border-rim bg-brand-muted px-4 py-3 text-sm leading-6 text-[color:var(--text-hi)]" aria-label="Zusammenfassung der Auswertung">
                  {selectedRun.results ? <>
                    <p className="font-semibold">{selectedRun.results.filter(result => result.status === 'current').length.toLocaleString('de-DE')} von {selectedRun.results.length.toLocaleString('de-DE')} Quellen liegen innerhalb des erlaubten Alters.</p>
                    <p>{selectedRun.results.filter(result => result.status === 'stale').length.toLocaleString('de-DE')} veraltet · {selectedRun.results.filter(result => result.status === 'unassessable').length.toLocaleString('de-DE')} nicht beurteilbar.</p>
                    <p className="mt-1 text-[color:var(--text-mid)]">{selectedRun.results.some(result => result.status !== 'current') ? 'Kläre veraltete Quellen beim Verantwortlichen und prüfe fehlende oder ungültige Zeitstempel. Der gespeicherte Befund bleibt unverändert; für neue Daten startest du eine neue Auswertung.' : 'Für diesen Stichtag ergibt sich aus dem Quellenalter kein Klärungsbedarf. Die inhaltliche Richtigkeit der Quelldaten wird dabei nicht bewertet.'}</p>
                  </> : <p>Es liegt kein belastbares Ergebnis vor. Prüfe den angegebenen Fehler, die Quelle und die Einrichtung, bevor du erneut startest.</p>}
                </div>
                <div className="grid gap-2 text-sm text-[color:var(--text-mid)] md:grid-cols-4">
                  <div><span className="block text-xs text-[color:var(--text-lo)]">Bezeichnung</span><span className="text-[color:var(--text-hi)]">{selectedRun.question}</span></div>
                  <div><span className="block text-xs text-[color:var(--text-lo)]">Dataset</span><span className="text-[color:var(--text-hi)]">{selectedRun.datasetId}</span></div>
                  <div><span className="block text-xs text-[color:var(--text-lo)]">Stichtag</span><span className="text-[color:var(--text-hi)]">{selectedRun.rule?.asOf ?? '—'}</span></div>
                  <div><span className="block text-xs text-[color:var(--text-lo)]">Datenstand</span><span className="text-[color:var(--text-hi)]">{selectedRun.snapshot?.coverage === 'complete' ? 'vollständig' : '—'}</span></div>
                </div>
                <div className="grid gap-2 text-sm text-[color:var(--text-mid)] md:grid-cols-2">
                  <div><span className="block text-xs text-[color:var(--text-lo)]">Erlaubtes Quellenalter</span><span className="text-[color:var(--text-hi)]">{formatMaxAge(selectedRun.rule?.maxAgeSeconds)}</span></div>
                  <div><span className="block text-xs text-[color:var(--text-lo)]">Bestätigte Felder</span><span className="break-words text-[color:var(--text-hi)]">{selectedRun.mapping?.sourceId ?? '—'} · {selectedRun.mapping?.sourceUpdatedAt ?? '—'}</span></div>
                </div>

                <div className="grid gap-2 rounded border border-rim bg-ink/30 px-3 py-3 text-sm md:grid-cols-3">
                  <div><span className="block text-xs text-[color:var(--text-lo)]">Quellen geprüft</span><span className="text-lg font-semibold tabular-nums text-[color:var(--text-hi)]">{selectedRun.results?.length ?? '—'}</span></div>
                  <div><span className="block text-xs text-[color:var(--text-lo)]">Aktuell</span><span className="text-lg font-semibold tabular-nums text-[#24684a]">{selectedRun.results?.filter((result) => result.status === 'current').length ?? '—'}</span></div>
                  <div><span className="block text-xs text-[color:var(--text-lo)]">Klärung nötig</span><span className="text-lg font-semibold tabular-nums text-[#8a5b12]">{selectedRun.results?.filter((result) => result.status !== 'current').length ?? '—'}</span></div>
                </div>

                {selectedRun.error && <div className="rounded border border-[rgba(239,68,68,0.35)] bg-[rgba(239,68,68,0.08)] px-3 py-2 text-sm text-[#9c332a]">{selectedRun.error}</div>}

                {selectedRun.results && selectedRun.results.length > 0 ? (
                  <div className="overflow-auto rounded border border-rim">
                    <table className="min-w-full border-collapse text-sm">
                      <thead><tr className="border-b border-rim text-left text-xs uppercase tracking-wide text-[color:var(--text-lo)]"><th className="px-3 py-2">Quelle</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Alter</th><th className="px-3 py-2">Begründung</th></tr></thead>
                      <tbody>
                        {selectedRun.results.map((result, index) => <tr key={`${result.sourceId}-${index}`} className="border-b border-rim/60 last:border-0"><td className="px-3 py-2 align-top text-[color:var(--text-hi)]">{sourceRef(result)}</td><td className="px-3 py-2 align-top"><Badge tone={statusTone(result.status)}>{statusLabel(result.status)}</Badge></td><td className="px-3 py-2 align-top tabular-nums text-[color:var(--text-mid)]">{formatAge(result.ageSeconds)}</td><td className="px-3 py-2 align-top text-[color:var(--text-mid)]">{reasonLabel(result.reason)}</td></tr>)}
                      </tbody>
                    </table>
                  </div>
                ) : selectedRun.status === 'blocked' ? (
                  <div className="rounded border border-[rgba(239,68,68,0.35)] bg-[rgba(239,68,68,0.08)] px-3 py-3 text-sm text-[#9c332a]">Diese Auswertung wurde blockiert. Prüfe die Fehlermeldung und die ausgewählten Felder.</div>
                ) : <div className="text-sm text-[color:var(--text-mid)]">Keine Ergebniszeilen vorhanden.</div>}

                {selectedRun.snapshot && (
                  <details className="rounded border border-rim px-3 py-2 text-sm text-[color:var(--text-mid)]">
                    <summary className="cursor-pointer font-medium text-[color:var(--text-hi)]">Snapshot und Wiederverwendung</summary>
                    <div className="mt-2 grid gap-1 text-xs"><span>Snapshot-Hash: <code className="break-all text-[color:var(--text-mid)]">{selectedRun.snapshot.hash}</code></span><span>Abdeckung: {selectedRun.snapshot.coverage} · {selectedRun.snapshot.rows.length.toLocaleString('de-DE')} Zeilen</span>{selectedRun.moduleHash && <span>Modul-Hash: <code className="break-all text-[color:var(--text-mid)]">{selectedRun.moduleHash}</code></span>}<span>Generierung: {selectedRun.generation?.attempts ?? 0} Versuche, {selectedRun.generation?.calls ?? 0} Aufrufe, {selectedRun.generation?.denied ?? 0} abgelehnt</span></div>
                    {(Boolean(selectedRun.executionReceipt || selectedRun.reloadReceipt)) && <pre className="mt-2 max-h-40 overflow-auto rounded bg-ink/50 p-2 text-[11px] text-[color:var(--text-lo)]">{String(JSON.stringify({ executionReceipt: selectedRun.executionReceipt, reloadReceipt: selectedRun.reloadReceipt }, null, 2) ?? '')}</pre>}
                  </details>
                )}
              </div>
            )}
          </section>
        </div>

        <details className="mt-5 rounded border border-rim px-3 py-2 text-sm text-[color:var(--text-mid)]">
          <summary className="cursor-pointer font-medium text-[color:var(--text-hi)]">Wie die Prüfung bewertet wird</summary>
          <div className="mt-2 grid gap-2 leading-6 md:grid-cols-3">
            <p>Geprüft wird nur die gewählte importierte Quelle mit dem ausgewählten Quellschlüssel und Aktualisierungszeitpunkt.</p>
            <p>Ein fehlender oder nicht parsebarer Aktualisierungszeitpunkt wird als nicht beurteilbar ausgewiesen und bleibt als Klärungsfall sichtbar.</p>
            <p>Der Stichtag braucht Offset oder Z. Das maximale Quellenalter wird in Sekunden an die Auswertungsregel übergeben.</p>
          </div>
        </details>
      </Card>}
    </div>
  );
}
