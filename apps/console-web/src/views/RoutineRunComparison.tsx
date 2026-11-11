import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchCases, type CaseRecord, type CaseStatus } from '../case-api';
import { Badge, Card, ghostBtnCls, selectCls } from '../components/ui';
import type { MissionResult } from '../mission-api';
import {
  fetchRoutineRunComparison,
  fetchRoutineRuns,
  type RoutineComparisonCategory,
  type RoutineComparisonItem,
  type RoutineDefinition,
  type RoutineRunComparison as RoutineRunComparisonResult,
  type RoutineRunSummary,
} from '../routine-api';

const pageSize = 25;
const categories: Array<{ value: RoutineComparisonCategory | ''; label: string; description: string }> = [
  { value: '', label: 'Alle Kategorien', description: 'Alle fachlich vergleichbaren Befunde' },
  { value: 'new', label: 'Neu auffällig', description: 'Im neuen Stand jetzt auffällig; bedeutet nicht neue Bestellung' },
  { value: 'persisting', label: 'Fortbestehend auffällig', description: 'In beiden Ständen auffällig' },
  { value: 'cleared', label: 'Im neuen Stand unauffällig', description: 'Vorher auffällig, jetzt ohne Auffälligkeit' },
  { value: 'missing', label: 'Fehlt im neuen Stand', description: 'Vorher auffällig, im neuen Stand nicht vorhanden' },
  { value: 'uncomparable', label: 'Nicht vergleichbar', description: 'Identität fehlt oder ist nicht eindeutig' },
];
const categoryLabels: Record<RoutineComparisonCategory, string> = Object.fromEntries(
  categories.filter(item => item.value).map(item => [item.value, item.label]),
) as Record<RoutineComparisonCategory, string>;
const caseStatusLabels: Record<CaseStatus, string> = { open: 'Offen', in_progress: 'In Bearbeitung', resolved: 'Abgeschlossen' };
const fieldLabels: Record<string, string> = {
  Befund: 'Befund',
  'Klärungsgrund': 'Klärungsgrund',
  Originalstatus: 'Status',
  Liefertermin: 'Liefertermin',
  Terminbeurteilung: 'Terminbeurteilung',
  'Tage überfällig': 'Tage überfällig',
  Lieferantenreferenz: 'Lieferantenreferenz',
  Lieferantenbeziehung: 'Lieferantenbeziehung',
  Lieferant: 'Lieferant',
  Bestellung: 'Bestellung',
  'Bestellungs-ID': 'Bestellungs-ID',
};

type Finding = MissionResult['rows'][number];
type CaseMap = Map<string, CaseRecord>;
type ComparisonDraft = { missionId: string; category: RoutineComparisonCategory | ''; offset: number };

function number(value: number): string { return value.toLocaleString('de-DE'); }
function date(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('de-DE');
}
function literal(value: unknown): string { return JSON.stringify(value); }
function findingValue(finding: Finding, field: string): string | number | boolean | null {
  if (!Object.hasOwn(finding, field)) return null;
  return finding[field] ?? null;
}
function displayValue(value: string | number | boolean | null): string {
  if (value === null) return 'Nicht vorhanden';
  if (typeof value === 'boolean') return value ? 'Ja' : 'Nein';
  return String(value);
}
function displayStatus(value: string | number | boolean | null): string {
  return value === null ? 'Nicht vorhanden' : literal(value);
}
function locationKey(missionId: string, sourceRow: number): string { return `${missionId}:${sourceRow}`; }
function readDraft(key: string): { missionId: string; category: RoutineComparisonCategory | ''; offset: number } {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Record<string, unknown> | null;
    const category = typeof value?.category === 'string' && categories.some(item => item.value === value.category)
      ? value.category as RoutineComparisonCategory : '';
    const offset = typeof value?.offset === 'number' && Number.isSafeInteger(value.offset) && value.offset >= 0 ? value.offset : 0;
    return { missionId: typeof value?.missionId === 'string' ? value.missionId : '', category, offset };
  } catch { return { missionId: '', category: '', offset: 0 }; }
}
function queryMissionId(): string {
  try { return new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('compare') ?? ''; } catch { return ''; }
}
function replaceCompareQuery(missionId: string): void {
  try {
    const [route] = window.location.hash.split('?');
    const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
    if (missionId) params.set('compare', missionId); else params.delete('compare');
    const query = params.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${route}${query ? `?${query}` : ''}`);
  } catch { /* URL state is optional; sessionStorage remains the fallback. */ }
}
function saveDraft(key: string, value: unknown): void {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* Optional browser state. */ }
}
function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : 'Die Anfrage ist fehlgeschlagen.';
}
function latestFirst(left: RoutineRunSummary, right: RoutineRunSummary): number {
  return right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id);
}
function caseTone(status: CaseStatus): 'neutral' | 'warning' | 'success' {
  return status === 'resolved' ? 'success' : status === 'in_progress' ? 'warning' : 'neutral';
}

function FindingSide(props: {
  label: string;
  missionId: string;
  value: RoutineComparisonItem['before'];
  cases: CaseMap;
  casesReady: boolean;
  emptyMessage: string;
}) {
  const { label, missionId, value, cases, casesReady, emptyMessage } = props;
  if (!value) return <div className="kf-routine-change-side kf-routine-change-side-empty"><h4>{label}</h4><p>{emptyMessage}</p></div>;
  const caseRecord = cases.get(locationKey(missionId, value.sourceRow));
  return <div className="kf-routine-change-side">
    <h4>{label} · Quellzeile {number(value.sourceRow)}</h4>
    <dl className="kf-routine-change-facts">
      {(['Befund', 'Klärungsgrund', 'Originalstatus', 'Liefertermin', 'Terminbeurteilung', 'Tage überfällig', 'Lieferantenreferenz', 'Lieferantenbeziehung', 'Lieferant'] as const).map(field => {
        const cell = findingValue(value.finding, field);
        return <div key={field}><dt>{fieldLabels[field]}</dt><dd className={field === 'Originalstatus' ? 'kf-routine-change-literal' : undefined}>{field === 'Originalstatus' ? displayStatus(cell) : displayValue(cell)}</dd></div>;
      })}
    </dl>
    <div className="kf-routine-change-links">
      <a href={`#/missions?id=${encodeURIComponent(missionId)}`}>Auftrag öffnen</a>
      {caseRecord ? <a href={`#/missions?case=${encodeURIComponent(caseRecord.id)}`}>Klärungsfall öffnen <Badge tone={caseTone(caseRecord.status)}>{caseStatusLabels[caseRecord.status]}</Badge></a>
        : casesReady && value.actionable ? <a href={`#/missions?view=cases&mission=${encodeURIComponent(missionId)}`}>Befunde öffnen</a> : null}
    </div>
  </div>;
}

function Provenance({ comparison }: { comparison: RoutineRunComparisonResult }) {
  const side = (label: string, missionId: string, value: RoutineRunComparisonResult['before']) => <div className="kf-routine-change-provenance-side">
    <h4>{label}</h4>
    <p><a href={`#/missions?id=${encodeURIComponent(missionId)}`}>Auftrag öffnen</a></p>
    <dl className="kf-routine-change-facts">
      <div><dt>Bestellquelle</dt><dd>{value.source.name} · Revision {value.relationship.fromRevision} · {number(value.source.rowCount)} Zeilen</dd></div>
      <div><dt>Lieferantenquelle</dt><dd>{value.targetSource.name} · Revision {value.relationship.toRevision} · {number(value.targetSource.rowCount)} Zeilen</dd></div>
      <div><dt>Beziehung</dt><dd>{value.relationship.name} · {value.relationship.fromField} → {value.relationship.toField}</dd></div>
      <div><dt>Stichtag</dt><dd>{value.asOf}</dd></div>
      <div><dt>Ausgeführt am</dt><dd>{date(value.executedAt)}</dd></div>
      <div><dt>Quellen-Hashes</dt><dd><code>{value.source.hash}</code><br /><code>{value.targetSource.hash}</code></dd></div>
      <div><dt>Modellstand-Hashes</dt><dd><code>{value.relationship.fromSnapshotHash}</code><br /><code>{value.relationship.toSnapshotHash}</code></dd></div>
      <div><dt>Regelhash</dt><dd><code>{value.orderRuleHash}</code></dd></div>
    </dl>
  </div>;
  return <details className="kf-routine-details kf-routine-change-provenance"><summary>Belege und Datenstände</summary><div className="kf-routine-change-provenance-grid">
    {side('Herkunftsauftrag', comparison.baselineMissionId, comparison.before)}
    {side('Ausgewählter Routinelauf', comparison.missionId, comparison.after)}
    <div><dt>Vergleichsbeleg</dt><dd><code>{comparison.comparisonHash}</code></dd></div>
  </div></details>;
}

function ChangeItem({ item, comparison, cases, casesReady }: { item: RoutineComparisonItem; comparison: RoutineRunComparisonResult; cases: CaseMap; casesReady: boolean }) {
  const keyLabel = item.key === null ? 'Bestellungs-ID fehlt' : literal(item.key);
  const emptyMessage = item.category === 'uncomparable' ? 'Keine eindeutige Zuordnung möglich.' : 'Nicht vorhanden.';
  return <li className="kf-routine-change-item" data-testid="change-item">
    <div className="kf-routine-change-item-heading"><div><Badge tone={item.category === 'cleared' ? 'success' : item.category === 'uncomparable' ? 'warning' : 'danger'}>{categoryLabels[item.category]}</Badge><h3>Bestellungs-ID <code>{keyLabel}</code></h3></div></div>
    {item.reason && <p className="kf-routine-muted">{item.reason}</p>}
    <div className="kf-routine-change-sides">
      <FindingSide label="Herkunftsauftrag" missionId={comparison.baselineMissionId} value={item.before} cases={cases} casesReady={casesReady} emptyMessage={emptyMessage} />
      <FindingSide label="Ausgewählter Routinelauf" missionId={comparison.missionId} value={item.after} cases={cases} casesReady={casesReady} emptyMessage={emptyMessage} />
    </div>
    <p className="kf-routine-change-fields"><strong>Geänderte Befundfelder:</strong> {item.before && item.after ? (item.changedFields.length ? item.changedFields.map(field => fieldLabels[field] ?? field).join(', ') : 'keine sichtbaren') : 'Kein eindeutiger Feldvergleich möglich'}</p>
  </li>;
}

export function RoutineRunComparison({ routine, storageScope }: { routine: RoutineDefinition; storageScope: string }) {
  const storageKey = `koiforge:routines:${storageScope}:comparison:${routine.id}`;
  const initialQueryRun = queryMissionId();
  const initialSavedDraft = readDraft(storageKey);
  const requestedQueryRun = useRef(initialQueryRun);
  const savedRunId = useRef(initialSavedDraft.missionId);
  const [draft, setDraft] = useState<ComparisonDraft>(() => {
    return initialQueryRun && initialQueryRun !== initialSavedDraft.missionId
      ? { ...initialSavedDraft, missionId: initialQueryRun, category: '', offset: 0 }
      : { ...initialSavedDraft, missionId: initialQueryRun || initialSavedDraft.missionId };
  });
  const [runs, setRuns] = useState<RoutineRunSummary[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [runsError, setRunsError] = useState('');
  const [runsNotice, setRunsNotice] = useState('');
  const [runsAttempt, setRunsAttempt] = useState(0);
  const [comparison, setComparison] = useState<RoutineRunComparisonResult | null>(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [comparisonError, setComparisonError] = useState('');
  const [comparisonAttempt, setComparisonAttempt] = useState(0);
  const [comparisonRequest, setComparisonRequest] = useState<{ missionId: string; category: RoutineComparisonCategory | ''; offset: number } | null>(null);
  const [cases, setCases] = useState<CaseMap>(new Map());
  const [casesReady, setCasesReady] = useState(false);
  const [casesLoading, setCasesLoading] = useState(false);
  const [casesError, setCasesError] = useState('');
  const [casesAttempt, setCasesAttempt] = useState(0);
  const compareRequest = useRef<AbortController | null>(null);
  const caseRequest = useRef<AbortController | null>(null);
  const compareGeneration = useRef(0);
  const caseGeneration = useRef(0);

  const completedRuns = useMemo(() => runs.filter(item => item.status === 'completed' && item.id !== routine.sourceMissionId).sort(latestFirst), [routine.sourceMissionId, runs]);
  const selectedRun = completedRuns.find(item => item.id === draft.missionId) ?? null;

  useEffect(() => {
    saveDraft(storageKey, draft);
  }, [draft, storageKey]);

  useEffect(() => {
    const onHashChange = () => {
      const next = queryMissionId();
      if (next === draft.missionId) return;
      requestedQueryRun.current = next;
      setRunsError(''); setRunsNotice('');
      setDraft(current => ({ ...current, missionId: next, category: '', offset: 0 }));
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [draft.missionId]);

  useEffect(() => {
    const controller = new AbortController();
    setRunsLoading(true); setRunsError('');
    void fetchRoutineRuns(routine.id, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setRuns(value);
      const completed = value.filter(item => item.status === 'completed' && item.id !== routine.sourceMissionId).sort(latestFirst);
      if (requestedQueryRun.current) {
        if (completed.some(item => item.id === requestedQueryRun.current)) {
          setRunsNotice('');
          setDraft(current => current.missionId === requestedQueryRun.current ? current : { ...current, missionId: requestedQueryRun.current });
        } else {
          setRunsError('Der angeforderte Vergleichslauf ist nicht vorhanden oder noch nicht abgeschlossen. Bitte einen abgeschlossenen Lauf auswählen.');
          setRunsNotice('');
          setDraft(current => ({ ...current, missionId: '', offset: 0 }));
        }
      } else if (savedRunId.current && !completed.some(item => item.id === savedRunId.current)) {
        setRunsNotice('Der zuvor ausgewählte Routinelauf ist in der aktuellen Liste nicht mehr vorhanden. Bitte einen neuen abgeschlossenen Lauf auswählen.');
        setDraft(current => ({ ...current, missionId: completed[0]?.id ?? '', offset: 0 }));
        savedRunId.current = completed[0]?.id ?? '';
      } else {
        setRunsNotice('');
        setDraft(current => current.missionId && completed.some(item => item.id === current.missionId)
          ? current : { ...current, missionId: completed[0]?.id ?? '', offset: 0 });
      }
    }).catch(reason => { if (!controller.signal.aborted) setRunsError(errorText(reason)); })
      .finally(() => { if (!controller.signal.aborted) setRunsLoading(false); });
    return () => controller.abort();
  }, [routine.id, routine.sourceMissionId, runsAttempt]);

  useEffect(() => {
    compareRequest.current?.abort();
    const generation = ++compareGeneration.current;
    setComparisonRequest(null);
    if (!draft.missionId) { setComparison(null); setComparisonError(''); setComparisonLoading(false); return; }
    const controller = new AbortController(); compareRequest.current = controller;
    setComparison(null); setComparisonError(''); setComparisonLoading(true);
    void fetchRoutineRunComparison(routine.id, { missionId: draft.missionId, category: draft.category || undefined, offset: draft.offset, limit: pageSize }, controller.signal)
      .then(value => { if (!controller.signal.aborted && compareGeneration.current === generation) { setComparison(value); setComparisonRequest({ missionId: draft.missionId, category: draft.category, offset: draft.offset }); } })
      .catch(reason => { if (!controller.signal.aborted && compareGeneration.current === generation) setComparisonError(errorText(reason)); })
      .finally(() => {
        if (compareRequest.current === controller) compareRequest.current = null;
        if (!controller.signal.aborted && compareGeneration.current === generation) setComparisonLoading(false);
      });
    return () => controller.abort();
  }, [draft.category, draft.missionId, draft.offset, routine.id, comparisonAttempt]);

  useEffect(() => {
    caseRequest.current?.abort();
    const generation = ++caseGeneration.current;
    if (!draft.missionId) { setCases(new Map()); setCasesReady(false); setCasesError(''); setCasesLoading(false); return; }
    const controller = new AbortController(); caseRequest.current = controller;
    setCases(new Map()); setCasesReady(false); setCasesError(''); setCasesLoading(true);
    void fetchCases(controller.signal).then(value => {
      if (controller.signal.aborted || caseGeneration.current !== generation) return;
      const map: CaseMap = new Map();
      for (const item of value) {
        if (item.evidence.missionId === routine.sourceMissionId || item.evidence.missionId === draft.missionId) {
          map.set(locationKey(item.evidence.missionId, item.evidence.sourceRow), item);
        }
      }
      setCases(map); setCasesReady(true);
    }).catch(reason => { if (!controller.signal.aborted && caseGeneration.current === generation) setCasesError(errorText(reason)); })
      .finally(() => {
        if (caseRequest.current === controller) caseRequest.current = null;
        if (!controller.signal.aborted && caseGeneration.current === generation) setCasesLoading(false);
      });
    return () => controller.abort();
  }, [casesAttempt, draft.missionId, routine.id, routine.sourceMissionId]);

  const changeRun = (missionId: string) => {
    requestedQueryRun.current = '';
    savedRunId.current = missionId;
    setRunsError(''); setRunsNotice('');
    replaceCompareQuery(missionId);
    setDraft(current => ({ ...current, missionId, offset: 0 }));
  };
  const changeCategory = (category: RoutineComparisonCategory | '') => setDraft(current => ({ ...current, category, offset: 0 }));
  const retryComparison = () => setComparisonAttempt(value => value + 1);
  const shownComparison = comparison && comparisonRequest
    && comparisonRequest.missionId === draft.missionId
    && comparisonRequest.category === draft.category
    && comparisonRequest.offset === draft.offset ? comparison : null;
  const previousDisabled = !shownComparison || shownComparison.offset === 0 || comparisonLoading;
  const nextDisabled = !shownComparison || shownComparison.offset + shownComparison.items.length >= shownComparison.totalRows || comparisonLoading;

  return <Card title="Befunde zwischen Läufen vergleichen" action={<button className={ghostBtnCls} type="button" data-testid="change-run-refresh" disabled={runsLoading} onClick={() => setRunsAttempt(value => value + 1)}>Läufe aktualisieren</button>}>
    <div className="kf-routine-run-comparison" data-testid="routine-run-comparison">
      <p>Der Herkunftsauftrag bleibt fest. Wähle einen abgeschlossenen Routinelauf, um auffällige Befunde anhand typgenauer Bestellungs-IDs zu vergleichen.</p>
      <div className="kf-routine-change-controls">
        <label className="kf-routine-field"><span>Abgeschlossener Routinelauf</span><select className={selectCls} data-testid="change-run" value={draft.missionId} disabled={runsLoading || completedRuns.length === 0} onChange={event => changeRun(event.target.value)}>
          <option value="">Lauf auswählen…</option>
          {completedRuns.map(item => <option value={item.id} key={item.id}>{item.sourceName} · {item.asOf ?? 'ohne Stichtag'} · {date(item.createdAt)}</option>)}
        </select></label>
        <label className="kf-routine-field"><span>Befundkategorie</span><select className={selectCls} data-testid="change-filter" value={draft.category} disabled={!selectedRun} onChange={event => changeCategory(event.target.value as RoutineComparisonCategory | '')}>
          {categories.map(item => <option key={item.value || 'all'} value={item.value}>{item.label}</option>)}
        </select></label>
      </div>
      <p className="kf-routine-muted">„Neu auffällig“ bedeutet, dass ein Befund im ausgewählten Lauf auffällig ist und im Herkunftsauftrag nicht war. Es bedeutet keine neue Bestellung und belegt keine Ursache. „Alle Kategorien“ umfasst auch nicht vergleichbare Befunde mit fehlender oder doppelter Identität.</p>
      {runsLoading && <p className="kf-routine-callout" role="status">Abgeschlossene Routineläufe werden geladen…</p>}
      {runsError && <div className="kf-routine-callout kf-routine-stack"><p className="kf-routine-error" role="alert">{runsError}</p><button className={ghostBtnCls} type="button" data-testid="change-run-retry" onClick={() => setRunsAttempt(value => value + 1)}>Läufe erneut laden</button></div>}
      {runsNotice && !runsError && <p className="kf-routine-callout" role="status">{runsNotice}</p>}
      {!runsLoading && !runsError && completedRuns.length === 0 && <div className="kf-routine-callout"><p>Noch kein abgeschlossener Routinelauf zum Vergleichen vorhanden.</p><p className="kf-routine-muted">Starte zuerst einen neuen Lauf und öffne diese Ansicht danach erneut.</p></div>}
      {selectedRun && <>
        <p className="kf-routine-muted">Herkunft: <a href={`#/missions?id=${encodeURIComponent(routine.sourceMissionId)}`}>Ausgangsauftrag öffnen</a> · ausgewählter Lauf: <a href={`#/missions?id=${encodeURIComponent(selectedRun.id)}`}>{selectedRun.sourceName}</a>.</p>
        <div className="kf-routine-change-stands" data-testid="change-stands"><div><strong>Herkunftsstand</strong><span>{routine.baseline.source.name} · Stichtag {routine.orderRule.asOf}</span></div><div><strong>Ausgewählter Stand</strong><span>{selectedRun.sourceName} · Stichtag {selectedRun.asOf ?? 'nicht angegeben'}</span></div></div>
      </>}
      {comparisonLoading && <p className="kf-routine-callout" role="status">Befundvergleich wird geladen…</p>}
      {comparisonError && <div className="kf-routine-callout kf-routine-stack"><p className="kf-routine-error" role="alert">{comparisonError}</p><button className={ghostBtnCls} type="button" data-testid="change-compare-retry" onClick={retryComparison}>Vergleich erneut laden</button></div>}
      {selectedRun && <div className="kf-routine-actions"><span className="kf-routine-muted" role={casesReady ? 'status' : undefined}>{casesLoading ? 'Verknüpfte Klärungsfälle werden geladen…' : casesReady ? `${number(cases.size)} bestehende Klärungsfälle für diese beiden Aufträge geladen.` : ''}</span><button className={ghostBtnCls} type="button" data-testid="change-cases-refresh" disabled={casesLoading} onClick={() => setCasesAttempt(value => value + 1)}>Klärungsfälle aktualisieren</button></div>}
      {casesError && <div className="kf-routine-callout"><p className="kf-routine-error" role="alert">Klärungsfall-Verknüpfungen sind derzeit nicht verfügbar: {casesError}</p><button className={ghostBtnCls} type="button" data-testid="change-cases-retry" onClick={() => setCasesAttempt(value => value + 1)}>Klärungsfälle erneut laden</button></div>}
      {shownComparison && <>
        {shownComparison.before.asOf !== shownComparison.after.asOf && <div className="kf-routine-change-caveat" role="note" data-testid="change-as-of-caveat"><strong>Stichtag geändert: {shownComparison.before.asOf} → {shownComparison.after.asOf}.</strong> Terminbefunde werden an unterschiedlichen Kalendertagen eingeordnet. Die Differenz belegt keine Ursache oder Wirksamkeit.</div>}
        <div className="kf-routine-change-counts" role="group" aria-label="Globale Befundzahlen">
          {categories.filter(item => item.value).map(item => <div key={item.value} className="kf-routine-change-count"><span>{item.label}</span><strong>{number(shownComparison.counts[item.value as RoutineComparisonCategory] ?? 0)}</strong></div>)}
        </div>
        <p className="kf-routine-muted">{number(shownComparison.totalRows)} Einträge in dieser Auswahl · Seite {shownComparison.totalRows ? `${number(shownComparison.offset + 1)}–${number(shownComparison.offset + shownComparison.items.length)}` : '0'} von {number(shownComparison.totalRows)}. Die globalen Kategorien zählen Befunde; bei mehrdeutigen IDs können mehrere Zeilen dazugehören.</p>
        {shownComparison.items.length === 0 && <div className="kf-routine-callout"><p>Keine Befunde in dieser Kategorie.</p></div>}
        {shownComparison.items.length > 0 && <ul className="kf-routine-change-list">{shownComparison.items.map((item, index) => <ChangeItem key={`${item.category}:${literal(item.key)}:${item.before?.sourceRow ?? 'none'}:${item.after?.sourceRow ?? 'none'}:${index}`} item={item} comparison={shownComparison} cases={cases} casesReady={casesReady} />)}</ul>}
        <nav className="kf-routine-change-pagination" aria-label="Befundvergleichseiten"><button className={ghostBtnCls} type="button" data-testid="change-previous" disabled={previousDisabled} onClick={() => setDraft(current => ({ ...current, offset: Math.max(0, current.offset - pageSize) }))}>Vorherige Seite</button><span>{shownComparison.totalRows ? `Befunde ${number(shownComparison.offset + 1)}–${number(shownComparison.offset + shownComparison.items.length)} von ${number(shownComparison.totalRows)}` : 'Keine Befunde'}</span><button className={ghostBtnCls} type="button" data-testid="change-next" disabled={nextDisabled} onClick={() => setDraft(current => ({ ...current, offset: current.offset + pageSize }))}>Nächste Seite</button></nav>
        <Provenance comparison={shownComparison} />
      </>}
    </div>
  </Card>;
}
