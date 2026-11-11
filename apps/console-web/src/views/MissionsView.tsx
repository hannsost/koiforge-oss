import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import { fetchDatasetPreview, fetchDatasets, type DatasetPreviewResult, type DatasetRecord } from '../api';
import { AnalysisDateTime } from '../components/AnalysisDateTime';
import { ImportWorkspaceDialog } from '../components/ImportWorkspaceDialog';
import { Badge, Card, ghostBtnCls, inputCls, selectCls } from '../components/ui';
import {
  clearMissionRequest, createMission, fetchMission, fetchMissionCapabilities, fetchMissions, fetchOrderStatuses,
  MissionApiError, missionRequestId, retryMission, runMission,
  type Mission, type MissionCapability, type MissionRelationship, type MissionResult, type MissionRunInput, type MissionStatus, type OrderReviewRule, type OrderStatusValues,
} from '../mission-api';
import { fetchRelationship, type RelationshipDetail } from '../semantic-model-api';
import { RoutineWorkspace, SaveRoutineAction } from './RoutineWorkspace';
import { CaseWorkspace } from './CaseWorkspace';
import '../missions.css';

const statusLabels: Record<MissionStatus, string> = {
  queued: 'Eingereiht', planning: 'Auftrag wird geplant', awaiting_confirmation: 'Bestätigung nötig',
  running: 'Prüfung läuft', completed: 'Abgeschlossen', blocked: 'Blockiert', interrupted: 'Unterbrochen',
};
const countLabels: Record<string, string> = {
  sourceRows: 'Geprüfte Quellzeilen', sourceColumns: 'Geprüfte Spalten', missingCells: 'Fehlende Werte',
  missingKeys: 'Fehlende Schlüssel', duplicateGroups: 'Doppelte Schlüsselgruppen',
  duplicateRows: 'Zeilen mit doppeltem Schlüssel', duplicateExcessRows: 'Zusätzliche Schlüsselvorkommen',
  current: 'Aktuell', stale: 'Veraltet', unassessable: 'Nicht beurteilbar',
  linkedRows: 'Eindeutig zugeordnet', missingReferences: 'Referenz fehlt', unmatchedReferences: 'Kein Ziel gefunden',
  ambiguousReferences: 'Ziel ist mehrdeutig', invalidSourceRows: 'Quell-ID fehlt oder ist doppelt', targetRows: 'Zeilen im Zielstand',
  openRows: 'Offen', overdueRows: 'Offen und überfällig', closedRows: 'Abgeschlossen',
  unassessableRows: 'Bestellung nicht beurteilbar', clarificationRows: 'Zeilen mit Klärungsbedarf', deadlineUnassessableRows: 'Offene Bestellungen ohne beurteilbaren Termin',
};
const columnLabels: Record<string, string> = {
  sourceId: 'Quellschlüssel', sourceUpdatedAt: 'Aktualisiert am', status: 'Status', ageSeconds: 'Alter in Sekunden', reason: 'Begründung',
};
const valueLabels: Record<string, string> = {
  current: 'Aktuell', stale: 'Veraltet', unassessable: 'Nicht beurteilbar', within_interval: 'Innerhalb des erlaubten Alters',
  interval_exceeded: 'Erlaubtes Alter überschritten', missing_timestamp: 'Zeitstempel fehlt',
  invalid_timestamp: 'Ungültiger Zeitstempel', future_timestamp: 'Zeitstempel liegt in der Zukunft',
};
const activeStatus = (status: MissionStatus) => status === 'queued' || status === 'planning' || status === 'running';
const formatNumber = (value: number) => value.toLocaleString('de-DE');
const displayLabel = (labels: Record<string, string>, value: string) => Object.hasOwn(labels, value) ? labels[value] : value;
function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('de-DE');
}
function selectedFromHash(): string {
  return new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('id') ?? '';
}
const DEFAULT_RELATIONSHIP_QUESTION = 'Welche Zuordnungen fehlen oder sind mehrdeutig?';
const DEFAULT_ORDER_QUESTION = 'Welche Bestellungen sind offen oder überfällig, und welche Lieferantenzuordnungen müssen geklärt werden?';
function relationshipFromHash(): string {
  return new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('relationship') ?? '';
}
function orderTaskFromHash(): boolean {
  return Boolean(relationshipFromHash()) && new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('task') === 'orders';
}
function draftKey(relationshipId: string, orderTask: boolean): string {
  return relationshipId ? `${orderTask ? 'order' : 'relationship'}-draft:${relationshipId}` : 'draft';
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Die Anfrage ist fehlgeschlagen.';
}
function readDraft(key: string): { question: string; datasetId: string } {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (typeof value?.question === 'string' && typeof value?.datasetId === 'string') return value;
  } catch { /* Draft storage is optional. */ }
  return { question: '', datasetId: '' };
}
function mergeMissions(current: Mission[], incoming: Mission[]): Mission[] {
  const merged = new Map(current.map(item => [item.id, item]));
  for (const item of incoming) {
    const previous = merged.get(item.id);
    if (!previous || item.revision > previous.revision) merged.set(item.id, item);
  }
  return [...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
function MissionBadge({ mission }: { mission: Mission }) {
  const label = mission.plan?.unsupportedReason ? 'Fähigkeit fehlt' : statusLabels[mission.status];
  return <Badge tone={mission.status === 'completed' ? 'success' : mission.status === 'blocked' || mission.status === 'interrupted' ? 'warning' : 'neutral'}>{label}</Badge>;
}
function RelationshipContext({ relationship }: { relationship: MissionRelationship }) {
  return <div className="kf-mission-stack" data-testid="mission-relationship-context">
    <p><strong>{relationship.name}</strong> · bestätigte Beziehung n:1</p>
    <dl className="kf-mission-facts">
      <div><dt>Ausgangsmenge</dt><dd><a className="text-brand underline" href={`#/model?set=${encodeURIComponent(relationship.fromSetId)}`}>{relationship.fromName} · Revision {relationship.fromRevision}</a></dd></div>
      <div><dt>Zielmenge</dt><dd><a className="text-brand underline" href={`#/model?set=${encodeURIComponent(relationship.toSetId)}`}>{relationship.toName} · Revision {relationship.toRevision}</a> · {formatNumber(relationship.targetRows)} Zeilen</dd></div>
      <div><dt>Bestätigte Zuordnung</dt><dd>{relationship.fromField} → {relationship.toField}</dd></div>
    </dl>
    <p className="kf-mission-muted">Die Prüfung verwendet diese gespeicherten Revisionen. Neuere Quelldaten oder Fachdefinitionen verändern diesen Auftrag nicht.</p>
  </div>;
}

function PreviewTable({ columns, rows, label, translate = false, showOrderStatus = false }: { columns: string[]; rows: MissionResult['rows']; label: string; translate?: boolean; showOrderStatus?: boolean }) {
  return <div className="kf-mission-table" role="region" aria-label={label} tabIndex={0}>
    <table>
      <caption className="sr-only">{label}</caption>
      <thead><tr>{columns.map(column => <th scope="col" key={column}>{translate ? displayLabel(columnLabels, column) : column}</th>)}</tr></thead>
      <tbody>{rows.map((row, index) => <tr key={index}>{columns.map(column => {
        const value = Object.hasOwn(row, column) ? row[column] : null;
        if (showOrderStatus && column === 'Originalstatus') return <td key={column}>
          <code className="kf-mission-status-value">{JSON.stringify(value ?? null)}</code>
          <span className="kf-mission-muted">{value == null ? 'Kein Wert (null)' : typeof value === 'string' ? 'Text' : typeof value === 'number' ? 'Zahl' : 'Ja/Nein'}</span>
        </td>;
        return <td key={column}>{value == null ? <span className="kf-mission-muted">Nicht vorhanden</span>
          : translate && (column === 'status' || column === 'reason') && typeof value === 'string' ? displayLabel(valueLabels, value)
            : typeof value === 'boolean' ? value ? 'Ja' : 'Nein' : String(value)}</td>;
      })}</tr>)}</tbody>
    </table>
    {rows.length === 0 && <p className="kf-mission-table-empty">Keine Zeilen vorhanden.</p>}
  </div>;
}

function MissionResultView({ mission, storageScope }: { mission: Mission & { result: MissionResult }; storageScope: string }) {
  const [query, setQuery] = useState('');
  const result = mission.result;
  const leadingColumns = result.capabilityId === 'order_review' ? ['Befund', 'Klärungsgrund'] : result.capabilityId === 'relationship_integrity' ? ['Befund'] : [];
  const columns = [...leadingColumns.filter(column => result.columns.includes(column)), ...result.columns.filter(column => !leadingColumns.includes(column))];
  const preview = result.rows.slice(0, 100);
  const visible = preview.filter(row => Object.values(row).some(value => String(value ?? '').toLocaleLowerCase('de-DE').includes(query.toLocaleLowerCase('de-DE'))));
  return <div data-testid="mission-result"><Card title="Ergebnis">
    <div className="kf-mission-stack">
      <p className="kf-mission-answer">{result.summary}</p>
      <dl className="kf-mission-counts">{Object.entries(result.counts).map(([name, value]) => <div key={name}>
        <dt>{displayLabel(countLabels, name)}</dt><dd>{formatNumber(value)}</dd>
      </div>)}</dl>
      {result.capabilityId === 'order_review' && <p className="kf-mission-muted">Jede Quellzeile gehört genau einer Bestellklasse an: offen, überfällig, abgeschlossen oder nicht beurteilbar. „Offen“ umfasst auch Bestellungen ohne beurteilbaren Termin. Klärungsbedarf wird zusätzlich gezählt, etwa bei einer fehlenden Lieferantenzuordnung.</p>}
      <p className="kf-mission-muted">{result.capabilityId === 'relationship_integrity' || result.capabilityId === 'order_review' ? 'Die Kennzahlen beziehen sich auf die vollständige Ausgangsmenge und den vollständigen festgehaltenen Zielstand.' : 'Die Kennzahlen beziehen sich auf die gesamte eingefrorene Quelle.'}
        {' '}Ergebnisvorschau: {formatNumber(preview.length)} von {formatNumber(result.totalRows)} Ergebniszeilen.
        {result.truncated && ' Die Tabelle ist gekürzt; die Kennzahlen sind vollständig.'}</p>
      <label className="kf-mission-field"><span>Ergebnisvorschau durchsuchen</span>
        <input className={inputCls} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Innerhalb der angezeigten Ergebniszeilen suchen" />
      </label>
      {query && <p className="kf-mission-muted" role="status">{formatNumber(visible.length)} Treffer in der Vorschau. Die Kennzahlen bleiben unverändert.</p>}
      <PreviewTable columns={columns} rows={visible} label="Ergebnisvorschau" translate showOrderStatus={result.capabilityId === 'order_review'} />
      {mission.status === 'completed' && result.capabilityId === 'order_review' && <p><a className="text-brand underline" data-testid="mission-edit-findings" href={`#/missions?view=cases&mission=${encodeURIComponent(mission.id)}`}>Befunde bearbeiten</a> · Alle überfälligen Bestellungen und Befunde mit Klärungsgrund öffnen.</p>}
      {mission.input?.orderRule && <div className="kf-mission-alert kf-mission-stack" data-testid="mission-order-rules">
        <h3>Bestätigte Bestellregeln</h3>
        <dl className="kf-mission-facts">
          <div><dt>Statusspalte</dt><dd>{mission.input.binding.statusField}</dd></div>
          <div><dt>Stichtag (Kalendertag)</dt><dd>{mission.input.orderRule.asOf}</dd></div>
          <div><dt>Offene Statuswerte · Text</dt><dd>{mission.input.orderRule.openStatuses.length ? mission.input.orderRule.openStatuses.map(value => <code className="kf-mission-status-value" key={value}>{JSON.stringify(value)}</code>) : 'Keine Werte als offen eingeordnet'}</dd></div>
          <div><dt>Abgeschlossene Statuswerte · Text</dt><dd>{mission.input.orderRule.closedStatuses.length ? mission.input.orderRule.closedStatuses.map(value => <code className="kf-mission-status-value" key={value}>{JSON.stringify(value)}</code>) : 'Keine Werte als abgeschlossen eingeordnet'}</dd></div>
          <div><dt>Terminbedeutung</dt><dd>{mission.input.orderRule.dueDateMeaning === 'promised_delivery_day' ? `Zugesagter Lieferkalendertag · ${mission.input.binding.dueDateField}` : 'Kein Liefertermin verfügbar; Überfälligkeit bleibt nicht beurteilbar'}</dd></div>
        </dl>
        <p className="kf-mission-muted">Statuswerte werden als exakte Texte verglichen. Nicht zugeordnete, fehlende oder nicht als Text vorliegende Werte bleiben ungeklärt. Eine eindeutig identifizierte, als offen bestätigte Bestellung ist überfällig, wenn ihr zugesagter Liefertag vor dem Stichtag liegt. Uhrzeiten werden nicht als Kalendertag interpretiert.</p>
      </div>}
      {mission.routine && <p>Routine: <a className="text-brand underline" href={`#/missions?routine=${encodeURIComponent(mission.routine.id)}`}>{mission.routine.name}</a>. Dieses Ergebnis verwendet den gespeicherten Plan und die Regeln mit dem bestätigten Stichtag dieses Laufs.</p>}
      {mission.routine && mission.status === 'completed' && <p><a className="text-brand underline" data-testid="mission-compare-findings" href={`#/missions?routine=${encodeURIComponent(mission.routine.id)}&compare=${encodeURIComponent(mission.id)}`}>Befunde mit dem Ausgangsauftrag vergleichen</a></p>}
      <details className="kf-mission-details">
        <summary>Belege und Datenstand</summary>
        <dl className="kf-mission-facts">
          <div><dt>Quelle</dt><dd>{mission.source?.name ?? mission.datasetId}</dd></div>
          <div><dt>Auftrags-ID</dt><dd><code>{mission.id}</code></dd></div>
          <div><dt>Quellen-Hash</dt><dd><code>{result.evidence.sourceHash}</code></dd></div>
          <div><dt>Fähigkeitsversion</dt><dd>{result.evidence.capabilityVersion}</dd></div>
          <div><dt>Ausgeführt am</dt><dd>{formatDate(result.evidence.executedAt)}</dd></div>
          {result.evidence.analysisRunId && <div><dt>Analyse-ID</dt><dd><code>{result.evidence.analysisRunId}</code></dd></div>}
          {result.evidence.moduleHash && <div><dt>Modul-Hash</dt><dd><code>{result.evidence.moduleHash}</code></dd></div>}
          {result.evidence.relationshipId && <div><dt>Bestätigte Beziehung</dt><dd><a className="text-brand underline" href={`#/model?relationship=${encodeURIComponent(result.evidence.relationshipId)}`}>{mission.plan?.relationship?.name ?? result.evidence.relationshipId}</a></dd></div>}
          {result.evidence.targetSourceHash && <div><dt>Quellen-Hash des Zielstands</dt><dd><code>{result.evidence.targetSourceHash}</code></dd></div>}
          {result.evidence.fromSetId && <div><dt>Ausgangsmenge / Revision</dt><dd><code>{result.evidence.fromSetId}</code> · {mission.plan?.relationship?.fromRevision}</dd></div>}
          {result.evidence.toSetId && <div><dt>Zielmenge / Revision</dt><dd><code>{result.evidence.toSetId}</code> · {mission.plan?.relationship?.toRevision}</dd></div>}
          {result.evidence.fromSnapshotHash && <div><dt>Modellstand-Hash der Ausgangsmenge</dt><dd><code>{result.evidence.fromSnapshotHash}</code></dd></div>}
          {result.evidence.toSnapshotHash && <div><dt>Modellstand-Hash der Zielmenge</dt><dd><code>{result.evidence.toSnapshotHash}</code></dd></div>}
          {result.evidence.orderRuleHash && <div><dt>Hash der bestätigten Bestellregeln</dt><dd><code>{result.evidence.orderRuleHash}</code></dd></div>}
          {mission.routine && <>
            <div><dt>Routine-Vorschau</dt><dd><code>{mission.routine.previewHash}</code></dd></div>
            <div><dt>Regelhash des Routine-Ausgangsauftrags</dt><dd><code>{mission.routine.baselineRuleHash}</code></dd></div>
            <div><dt>Bestätigter Regelhash dieses Laufs</dt><dd><code>{mission.routine.confirmedRuleHash}</code></dd></div>
          </>}
          {result.capabilityId !== 'relationship_integrity' && result.capabilityId !== 'order_review' && <div><dt>Bestätigte Schlüsselspalte</dt><dd>{mission.input?.binding.keyField || 'Keine Schlüsselprüfung'}</dd></div>}
          {mission.input?.binding.timestampField && <div><dt>Bestätigter Aktualisierungszeitpunkt</dt><dd>{mission.input.binding.timestampField}</dd></div>}
          {mission.input?.rule && <><div><dt>Stichtag</dt><dd>{formatDate(mission.input.rule.asOf)}</dd></div>
            <div><dt>Maximales Quellenalter</dt><dd>{formatNumber(mission.input.rule.maxAgeSeconds)} Sekunden</dd></div></>}
        </dl>
      </details>
      <SaveRoutineAction mission={mission} storageScope={storageScope} />
    </div>
  </Card></div>;
}

interface OrderDraft {
  statusField: string;
  dueDateField: string;
  dueDateMeaning: OrderReviewRule['dueDateMeaning'] | '';
  asOf: string;
  openStatuses: string[];
  closedStatuses: string[];
}
function readOrderDraft(key: string, mission: Mission): OrderDraft {
  const initial: OrderDraft = {
    statusField: mission.input?.binding.statusField ?? mission.plan?.suggestedBinding.statusField ?? '',
    dueDateField: mission.input?.binding.dueDateField ?? mission.plan?.suggestedBinding.dueDateField ?? '',
    dueDateMeaning: mission.input?.orderRule?.dueDateMeaning ?? '',
    asOf: mission.input?.orderRule?.asOf ?? '',
    openStatuses: mission.input?.orderRule?.openStatuses ?? [],
    closedStatuses: mission.input?.orderRule?.closedStatuses ?? [],
  };
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Record<string, unknown> | null;
    if (!saved || typeof saved !== 'object') return initial;
    for (const field of ['statusField', 'dueDateField', 'asOf'] as const) {
      if (Object.hasOwn(saved, field) && typeof saved[field] === 'string') initial[field] = saved[field];
    }
    if (saved.dueDateMeaning === '' || saved.dueDateMeaning === 'not_available' || saved.dueDateMeaning === 'promised_delivery_day') initial.dueDateMeaning = saved.dueDateMeaning;
    for (const field of ['openStatuses', 'closedStatuses'] as const) {
      const values = Object.hasOwn(saved, field) ? saved[field] : null;
      if (Array.isArray(values) && values.every(value => typeof value === 'string')) initial[field] = [...new Set(values)];
    }
  } catch { /* The stored form is optional; saved server input remains available. */ }
  return initial;
}
function isCalendarDay(value: string): boolean {
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
function OrderConfirmation({ mission, storagePrefix, busy, onRun }: { mission: Mission; storagePrefix: string; busy: boolean; onRun: (input: MissionRunInput) => void }) {
  const storageKey = `${storagePrefix}order-run-draft:${mission.id}:${mission.revision}`;
  const [draft, setDraft] = useState(() => readOrderDraft(storageKey, mission));
  const [catalogue, setCatalogue] = useState<OrderStatusValues | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const columns = mission.source?.columns ?? [];
  const currentCatalogue = catalogue?.field === draft.statusField ? catalogue : null;
  useEffect(() => {
    try { sessionStorage.setItem(storageKey, JSON.stringify(draft)); } catch { /* Optional owner-scoped draft. */ }
  }, [storageKey, draft]);
  useEffect(() => {
    const controller = new AbortController();
    setCatalogue(null); setLoadError('');
    if (!draft.statusField || !mission.source?.columns.includes(draft.statusField)) { setLoading(false); return; }
    setLoading(true);
    void fetchOrderStatuses(mission.id, draft.statusField, controller.signal).then(values => {
      if (!controller.signal.aborted) setCatalogue(values);
    }).catch(reason => {
      if (!controller.signal.aborted) setLoadError(errorMessage(reason));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [mission.id, mission.source, draft.statusField, attempt]);
  const change = (values: Partial<OrderDraft>) => {
    setDraft(current => ({ ...current, ...values })); setConfirmed(false); setError('');
  };
  const classify = (value: string, category: string) => {
    change({
      openStatuses: [...draft.openStatuses.filter(item => item !== value), ...(category === 'open' ? [value] : [])].sort(),
      closedStatuses: [...draft.closedStatuses.filter(item => item !== value), ...(category === 'closed' ? [value] : [])].sort(),
    });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault(); setError('');
    if (busy) return;
    if (!columns.includes(draft.statusField) || draft.statusField === mission.plan?.orderKeyField || !currentCatalogue || loading || loadError) return setError('Bitte eine von der Bestellungs-ID verschiedene Statusspalte auswählen und ihre Werte laden.');
    const assigned = [...draft.openStatuses, ...draft.closedStatuses];
    if (!assigned.length) return setError('Bitte mindestens einen vorhandenen Statuswert als offen oder abgeschlossen einordnen.');
    if (draft.openStatuses.length > 50 || draft.closedStatuses.length > 50) return setError('Pro Gruppe können höchstens 50 unterschiedliche Statuswerte bestätigt werden.');
    if (new Set(assigned).size !== assigned.length || assigned.some(value => !currentCatalogue.values.some(item => item.value === value))) return setError('Bitte die Statuszuordnungen anhand der angezeigten Werte erneut prüfen.');
    if (!isCalendarDay(draft.asOf)) return setError('Bitte einen gültigen Stichtag als Kalendertag im Format JJJJ-MM-TT zwischen den Jahren 1000 und 9999 angeben.');
    if (!draft.dueDateMeaning) return setError('Bitte bestätigen, ob ein zugesagter Lieferkalendertag verfügbar ist.');
    if (draft.dueDateMeaning === 'promised_delivery_day' && (!draft.dueDateField || !columns.includes(draft.dueDateField) || draft.dueDateField === draft.statusField || draft.dueDateField === mission.plan?.orderKeyField)) return setError('Bitte eine von ID und Status verschiedene Spalte für den zugesagten Lieferkalendertag auswählen.');
    if (!confirmed) return setError('Bitte die Statuszuordnungen, den Stichtag und die Terminbedeutung ausdrücklich bestätigen.');
    onRun({ confirmed: true, binding: { statusField: draft.statusField, ...(draft.dueDateMeaning === 'promised_delivery_day' ? { dueDateField: draft.dueDateField } : {}) },
      orderRule: { openStatuses: [...draft.openStatuses].sort(), closedStatuses: [...draft.closedStatuses].sort(), asOf: draft.asOf, dueDateMeaning: draft.dueDateMeaning } });
  };
  return <form className="kf-mission-stack" aria-label="Bestellregeln bestätigen" onSubmit={submit}>
    <h3>Bestellregeln bestätigen</h3>
    <p>Bestätige, welche Statuswerte offene beziehungsweise abgeschlossene Bestellungen bedeuten. Die Lieferantenzuordnung stammt aus der gespeicherten Beziehung; ihre Feldzuordnung wird beibehalten.</p>
    <fieldset className="kf-mission-stack kf-mission-order-fields" disabled={busy}>
      <label className="kf-mission-field"><span>Statusspalte</span><select data-testid="mission-order-status-field" className={selectCls} value={draft.statusField} onChange={event => change({ statusField: event.target.value, openStatuses: [], closedStatuses: [] })}>
        <option value="">Statusspalte auswählen…</option>{columns.filter(column => column !== mission.plan?.orderKeyField).map(column => <option key={column} value={column}>{column}</option>)}
      </select></label>
      {loading && <p role="status">Statuswerte des gespeicherten Quellenstands werden geladen…</p>}
      {loadError && <div className="kf-mission-stack"><p className="kf-mission-error" role="alert">{loadError}</p><div><button type="button" className={ghostBtnCls} onClick={() => setAttempt(value => value + 1)}>Statuswerte erneut laden</button></div></div>}
      {currentCatalogue && !loading && !loadError && <div className="kf-mission-stack" data-testid="mission-order-status-values">
        <p>{formatNumber(currentCatalogue.totalRows)} Quellzeilen vollständig berücksichtigt · {formatNumber(currentCatalogue.uniqueTotal)} unterschiedliche Textwerte · {formatNumber(currentCatalogue.missingRows)} fehlende Statuswerte · {formatNumber(currentCatalogue.nonTextRows)} Werte mit anderem Datentyp.</p>
        <p className="kf-mission-muted">Werte werden exakt einschließlich Groß-/Kleinschreibung und Leerzeichen verglichen. Anführungszeichen kennzeichnen Text und gehören nicht zum Wert. Nicht zugeordnete, fehlende und nicht als Text vorliegende Werte bleiben ungeklärt.</p>
        {currentCatalogue.truncated && <p className="kf-mission-alert" role="status">Angezeigt werden {formatNumber(currentCatalogue.values.length)} von {formatNumber(currentCatalogue.uniqueTotal)} Textwerten. Nicht angezeigte Werte bleiben ungeklärt; die Prüfung umfasst trotzdem alle Quellzeilen.</p>}
        {currentCatalogue.unassignableRows > 0 && <p className="kf-mission-alert">{formatNumber(currentCatalogue.unassignableRows)} Quellzeilen enthalten Statuswerte mit mehr als 200 Zeichen. Diese Werte können nicht eingeordnet werden und bleiben ungeklärt.</p>}
        {currentCatalogue.values.length === 0 ? <p>Dieser Stand enthält in der gewählten Spalte keine zuordenbaren Textwerte. Wähle eine andere Statusspalte.</p>
          : <ul className="kf-mission-status-values">{currentCatalogue.values.map(item => <li key={item.value}>
            <div><code className="kf-mission-status-value">{JSON.stringify(item.value)}</code><span className="kf-mission-muted">Text · {formatNumber(item.count)} {item.count === 1 ? 'Zeile' : 'Zeilen'}</span></div>
            <label className="kf-mission-field"><span className="sr-only">Einordnung für Status {JSON.stringify(item.value)}</span><select className={selectCls} data-testid="mission-order-status-choice" data-status-value={item.value} value={draft.openStatuses.includes(item.value) ? 'open' : draft.closedStatuses.includes(item.value) ? 'closed' : ''} onChange={event => classify(item.value, event.target.value)}>
              <option value="">Nicht zugeordnet</option><option value="open">Offen</option><option value="closed">Abgeschlossen</option>
            </select></label>
          </li>)}</ul>}
        <p className="kf-mission-muted">{draft.openStatuses.length} Werte als offen · {draft.closedStatuses.length} als abgeschlossen. Mindestens ein Wert insgesamt muss eingeordnet sein, höchstens 50 pro Gruppe.</p>
      </div>}
      <div className="kf-mission-fields">
        <label className="kf-mission-field"><span>Stichtag (Kalendertag)</span><input className={inputCls} type="date" min="1000-01-01" max="9999-12-31" data-testid="mission-order-as-of" value={draft.asOf} onChange={event => change({ asOf: event.target.value })} /></label>
        <label className="kf-mission-field"><span>Bedeutung des Liefertermins</span><select className={selectCls} data-testid="mission-order-date-meaning" value={draft.dueDateMeaning} onChange={event => change({ dueDateMeaning: event.target.value as OrderDraft['dueDateMeaning'] })}>
          <option value="">Terminbedeutung auswählen…</option><option value="promised_delivery_day">Zugesagter Lieferkalendertag ist vorhanden</option><option value="not_available">Kein Liefertermin verfügbar</option>
        </select></label>
        {draft.dueDateMeaning === 'promised_delivery_day' && <label className="kf-mission-field"><span>Spalte für zugesagten Lieferkalendertag</span><select className={selectCls} data-testid="mission-order-due-date-field" value={draft.dueDateField} onChange={event => change({ dueDateField: event.target.value })}>
          <option value="">Spalte auswählen…</option>{columns.filter(column => column !== draft.statusField && column !== mission.plan?.orderKeyField).map(column => <option key={column} value={column}>{column}</option>)}
        </select></label>}
      </div>
      {draft.dueDateMeaning === 'promised_delivery_day' && <p className="kf-mission-muted">Die gewählte Spalte muss den zugesagten Liefertag im Format JJJJ-MM-TT enthalten. Eine eindeutig identifizierte, als offen bestätigte Bestellung ist überfällig, wenn ihr zugesagter Liefertag vor dem Stichtag liegt. Fehlende Daten, Uhrzeiten und andere Formate bleiben nicht beurteilbar; es erfolgt keine Zeitzonenumrechnung.</p>}
      {draft.dueDateMeaning === 'not_available' && <p className="kf-mission-alert">Der Bestellstatus und die Lieferantenzuordnung werden geprüft. Ohne zugesagten Liefertag ist Überfälligkeit nicht beurteilbar.</p>}
      <label className="kf-mission-check"><input type="checkbox" data-testid="mission-confirm" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>Die Ausgangsmenge enthält Bestellungen, die Zielmenge Lieferanten. Ich bestätige die eingeordneten Statuswerte, den Stichtag und die Terminbedeutung für diese gespeicherte Beziehung.</span></label>
    </fieldset>
    {error && <p className="kf-mission-error" role="alert">{error}</p>}
    <div className="kf-mission-actions"><button className="kf-mission-primary" data-testid="mission-run" type="submit" disabled={busy || loading || !currentCatalogue || Boolean(loadError)}>{busy ? 'Start wird gespeichert…' : 'Bestellregeln bestätigen und starten'}</button></div>
    <p className="kf-mission-muted">Die Prüfung verwendet beide festgehaltenen Quellenstände. Die bestätigten Regeln werden mit dem Ergebnis gespeichert; Änderungen an den Feldern oder Regeln erfordern eine neue Bestätigung.</p>
  </form>;
}

function MissionConfirmation({ mission, busy, onRun }: { mission: Mission; busy: boolean; onRun: (input: MissionRunInput) => void }) {
  const columns = mission.source?.columns ?? [];
  const freshness = mission.plan?.capabilityId === 'source_freshness';
  const relationship = mission.plan?.capabilityId === 'relationship_integrity';
  const [keyField, setKeyField] = useState(mission.input?.binding.keyField ?? mission.plan?.suggestedBinding.keyField ?? '');
  const [timestampField, setTimestampField] = useState(mission.input?.binding.timestampField ?? mission.plan?.suggestedBinding.timestampField ?? '');
  const [asOf, setAsOf] = useState(mission.input?.rule?.asOf ?? new Date().toISOString());
  const [maxAgeHours, setMaxAgeHours] = useState(String((mission.input?.rule?.maxAgeSeconds ?? 86400) / 3600));
  const [confirmedMeaning, setConfirmedMeaning] = useState(false);
  const [error, setError] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (!relationship && keyField && !columns.includes(keyField)) return setError('Bitte eine vorhandene Schlüsselspalte auswählen.');
    if (!confirmedMeaning) return setError(freshness ? 'Bitte die Bedeutung des Aktualisierungszeitpunkts bestätigen.' : 'Bitte den vorgeschlagenen Prüfumfang bestätigen.');
    if (relationship) return onRun({ confirmed: true, binding: {} });
    if (!freshness) return onRun({ confirmed: true, binding: keyField ? { keyField } : {} });
    if (!keyField || !timestampField || !columns.includes(timestampField) || keyField === timestampField) return setError('Bitte zwei unterschiedliche Spalten für Quellschlüssel und Aktualisierungszeitpunkt auswählen.');
    if (!/T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(asOf) || Number.isNaN(Date.parse(asOf))) return setError('Bitte einen gültigen Stichtag mit eindeutiger Zeitzone angeben.');
    const maxAgeSeconds = Math.round(Number(maxAgeHours) * 3600);
    if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > 315360000) return setError('Bitte ein maximales Quellenalter zwischen einer Sekunde und zehn Jahren angeben.');
    onRun({ confirmed: true, binding: { keyField, timestampField }, rule: { asOf, maxAgeSeconds, timestampMeaning: 'source_updated_at', timezone: 'explicit-offset' } });
  };
  return <form className="kf-mission-stack" onSubmit={submit} aria-label="Prüfumfang bestätigen">
    <h3>Prüfumfang bestätigen</h3>
    <p>{relationship ? 'Geprüft wird die bereits bestätigte Beziehung mit ihren beiden gespeicherten Quellenständen. Feldzuordnungen werden aus dem Fachmodell übernommen.' : freshness ? 'Prüfe die vorgeschlagenen Felder und die fachliche Bedeutung, bevor die Quelle ausgewertet wird.'
      : 'Alle Spalten werden auf fehlende Werte geprüft. Mit einer Schlüsselspalte werden zusätzlich doppelte und fehlende Schlüssel gezählt.'}</p>
    <fieldset disabled={busy} className="kf-mission-fields">
      {!relationship && <label className="kf-mission-field"><span>{freshness ? 'Quellschlüssel' : 'Schlüsselspalte (optional)'}</span>
        <select data-testid="mission-key-field" className={selectCls} value={keyField} onChange={event => { setKeyField(event.target.value); setConfirmedMeaning(false); setError(''); }}>
          <option value="">{freshness ? 'Spalte auswählen…' : 'Keine Schlüsselprüfung'}</option>
          {columns.map(column => <option key={column} value={column}>{column}</option>)}
        </select>
      </label>}
      {freshness && <>
        <label className="kf-mission-field"><span>Aktualisierungszeitpunkt</span>
          <select className={selectCls} value={timestampField} onChange={event => { setTimestampField(event.target.value); setConfirmedMeaning(false); setError(''); }}>
            <option value="">Spalte auswählen…</option>{columns.map(column => <option key={column} value={column}>{column}</option>)}
          </select>
        </label>
        <AnalysisDateTime value={asOf} onChange={setAsOf} />
        <label className="kf-mission-field"><span>Maximales Quellenalter in Stunden</span>
          <input className={inputCls} type="number" min="0.000278" max="87600" step="any" value={maxAgeHours} onChange={event => setMaxAgeHours(event.target.value)} />
        </label>
        <label className="kf-mission-check"><input data-testid="mission-confirm" type="checkbox" checked={confirmedMeaning} onChange={event => setConfirmedMeaning(event.target.checked)} />
          <span>Das gewählte Feld beschreibt die letzte Aktualisierung der Quelle. Die Zeitwerte enthalten eine Zeitzone; fehlende oder ungültige Werte bleiben als nicht beurteilbar sichtbar.</span>
        </label>
      </>}
      {!freshness && <label className="kf-mission-check"><input data-testid="mission-confirm" type="checkbox" checked={confirmedMeaning} onChange={event => setConfirmedMeaning(event.target.checked)} /><span>{relationship ? 'Ich bestätige die Prüfung dieser gespeicherten Beziehung und beider Quellenstände.' : 'Ich bestätige den vorgeschlagenen Prüfumfang und die Auswahl zur Schlüsselprüfung.'}</span></label>}
    </fieldset>
    {error && <p className="kf-mission-error" role="alert">{error}</p>}
    <div className="kf-mission-actions"><button data-testid="mission-run" className="kf-mission-primary" type="submit" disabled={busy}>{busy ? 'Start wird gespeichert…' : 'Prüfumfang bestätigen und starten'}</button></div>
    <p className="kf-mission-muted">{relationship ? 'Mit dem Start bestätigst du diesen Plan für die festgehaltene Beziehung.' : 'Die Prüfung verwendet den oben gespeicherten vollständigen Datenstand. Mit dem Start bestätigst du diesen Plan und die ausgewählten Felder.'}</p>
  </form>;
}

function workspaceRouteFromHash() {
  const query = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  return { routines: !query.has('id') && (query.has('routine') || query.get('view') === 'routines'), routineId: query.get('routine') ?? '',
    cases: !query.has('id') && (query.has('case') || query.get('view') === 'cases'), caseId: query.get('case') ?? '', missionId: query.get('mission') ?? '' };
}
export function MissionsView({ storageScope }: { storageScope: string }) {
  const [route, setRoute] = useState(workspaceRouteFromHash);
  useEffect(() => {
    const sync = () => setRoute(workspaceRouteFromHash());
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  if (route.cases) return <CaseWorkspace key={storageScope} storageScope={storageScope} caseId={route.caseId} missionId={route.missionId} />;
  return route.routines ? <RoutineWorkspace key={storageScope} storageScope={storageScope} routineId={route.routineId} /> : <MissionWorkspace key={storageScope} storageScope={storageScope} />;
}

function MissionWorkspace({ storageScope }: { storageScope: string }) {
  const storagePrefix = `koiforge:missions:${storageScope}:`;
  const [relationshipId, setRelationshipId] = useState(relationshipFromHash);
  const relationshipIdRef = useRef(relationshipId);
  const [orderTask, setOrderTask] = useState(orderTaskFromHash);
  const orderTaskRef = useRef(orderTask);
  const [relationshipDetail, setRelationshipDetail] = useState<RelationshipDetail | null>(null);
  const [relationshipLoading, setRelationshipLoading] = useState(Boolean(relationshipId));
  const [relationshipError, setRelationshipError] = useState('');
  const [relationshipAttempt, setRelationshipAttempt] = useState(0);
  const initialDraft = useRef(readDraft(`${storagePrefix}${draftKey(relationshipId, orderTask)}`));
  const [question, setQuestion] = useState(initialDraft.current.question || (orderTask ? DEFAULT_ORDER_QUESTION : relationshipId ? DEFAULT_RELATIONSHIP_QUESTION : ''));
  const [datasetId, setDatasetId] = useState(initialDraft.current.datasetId);
  const [datasets, setDatasets] = useState<DatasetRecord[]>([]);
  const [capabilities, setCapabilities] = useState<MissionCapability[]>([]);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [selectedId, setSelectedId] = useState(selectedFromHash);
  const selectedIdRef = useRef(selectedId);
  const navigationEpoch = useRef(0);
  const [mission, setMission] = useState<Mission | null>(null);
  const [preview, setPreview] = useState<DatasetPreviewResult | null>(null);
  const [sourceLoading, setSourceLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [sourceError, setSourceError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [capabilityError, setCapabilityError] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [commandError, setCommandError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [notice, setNotice] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [detailAttempt, setDetailAttempt] = useState(0);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const mutation = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const previousStatus = useRef('');
  const draftHeading = useRef<HTMLHeadingElement>(null);
  const effectiveDatasetId = relationshipId ? relationshipDetail?.from.source.datasetId ?? '' : datasetId;

  const remember = useCallback((next: Mission) => {
    setMissions(current => mergeMissions(current, [next]));
  }, []);
  const select = useCallback((id: string) => {
    navigationEpoch.current++;
    selectedIdRef.current = id;
    setSelectedId(id);
    relationshipIdRef.current = '';
    setRelationshipId('');
    orderTaskRef.current = false;
    setOrderTask(false);
    setRelationshipDetail(null);
    if (!id) {
      const draft = readDraft(`${storagePrefix}draft`);
      setQuestion(draft.question); setDatasetId(draft.datasetId);
    }
    setCommandError('');
    window.location.hash = id ? `/missions?id=${encodeURIComponent(id)}` : '/missions';
  }, [storagePrefix]);
  useEffect(() => {
    const sync = () => {
      if (!window.location.hash.startsWith('#/missions')) return;
      const next = selectedFromHash();
      const nextRelationship = relationshipFromHash();
      const nextOrderTask = orderTaskFromHash();
      if (nextRelationship !== relationshipIdRef.current || nextOrderTask !== orderTaskRef.current) {
        navigationEpoch.current++;
        if (nextRelationship !== relationshipIdRef.current) setRelationshipDetail(null);
        relationshipIdRef.current = nextRelationship;
        setRelationshipId(nextRelationship);
        orderTaskRef.current = nextOrderTask;
        setOrderTask(nextOrderTask);
        const draft = readDraft(`${storagePrefix}${draftKey(nextRelationship, nextOrderTask)}`);
        setQuestion(draft.question || (nextOrderTask ? DEFAULT_ORDER_QUESTION : nextRelationship ? DEFAULT_RELATIONSHIP_QUESTION : ''));
        setDatasetId(draft.datasetId);
        setCommandError('');
      }
      if (next !== selectedIdRef.current) {
        navigationEpoch.current++;
        selectedIdRef.current = next;
        setSelectedId(next);
        setCommandError('');
      }
    };
    window.addEventListener('hashchange', sync);
    return () => { window.removeEventListener('hashchange', sync); mutation.current?.abort(); };
  }, [storagePrefix]);
  useEffect(() => {
    if (selectedId) return;
    try { sessionStorage.setItem(`${storagePrefix}${draftKey(relationshipId, orderTask)}`, JSON.stringify({ question, datasetId })); } catch { /* Optional tab draft. */ }
  }, [storagePrefix, question, datasetId, relationshipId, orderTask, selectedId]);

  useEffect(() => {
    const controller = new AbortController();
    setRelationshipError(''); setRelationshipLoading(Boolean(relationshipId && !selectedId));
    if (!relationshipId || selectedId) return;
    void fetchRelationship(relationshipId, 0, 1, controller.signal).then(detail => {
      if (!controller.signal.aborted) setRelationshipDetail(detail);
    }).catch(error => {
      if (!controller.signal.aborted) setRelationshipError(error instanceof Error ? error.message : 'Die bestätigte Beziehung konnte nicht geladen werden.');
    }).finally(() => { if (!controller.signal.aborted) setRelationshipLoading(false); });
    return () => controller.abort();
  }, [relationshipId, selectedId, relationshipAttempt]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setSourceLoading(true); setHistoryLoading(true);
    setSourceError(''); setHistoryError(''); setCapabilityError('');
    void fetchDatasets().then(items => {
      if (!active) return;
      const imported = items.filter(item => item.connectorId === 'inline');
      setDatasets(imported);
      setDatasetId(current => imported.some(item => item.id === current) ? current : imported[0]?.id ?? '');
    }).catch(() => { if (active) setSourceError('Datenquellen konnten nicht geladen werden. Gespeicherte Aufträge bleiben separat zugänglich.'); })
      .finally(() => { if (active) setSourceLoading(false); });
    void fetchMissions(controller.signal).then(items => { if (active) setMissions(current => mergeMissions(current, items)); })
      .catch(() => { if (active) setHistoryError('Gespeicherte Aufträge konnten nicht geladen werden.'); })
      .finally(() => { if (active) setHistoryLoading(false); });
    void fetchMissionCapabilities(controller.signal).then(items => { if (active) setCapabilities(items); })
      .catch(() => { if (active) setCapabilityError('Die verfügbaren Fähigkeiten konnten nicht geladen werden.'); });
    return () => { active = false; controller.abort(); };
  }, [loadAttempt]);

  useEffect(() => {
    let active = true;
    setPreview(null); setPreviewError('');
    if (!datasetId || selectedId || relationshipId) { setPreviewLoading(false); return; }
    setPreviewLoading(true);
    void fetchDatasetPreview(datasetId, { limit: 100 }).then(value => { if (active) setPreview(value); })
      .catch(() => { if (active) setPreviewError('Die aktuelle Quellenvorschau konnte nicht geladen werden.'); })
      .finally(() => { if (active) setPreviewLoading(false); });
    return () => { active = false; };
  }, [datasetId, selectedId, relationshipId, previewAttempt]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setMission(null); setDetailError(''); setDetailLoading(Boolean(selectedId));
    previousStatus.current = '';
    if (!selectedId) { draftHeading.current?.focus({ preventScroll: true }); return; }
    const update = async () => {
      try {
        const next = await fetchMission(selectedId, controller.signal);
        if (controller.signal.aborted || selectedIdRef.current !== selectedId) return;
        setMission(next); remember(next); setDetailError(''); setDetailLoading(false);
        if (activeStatus(next.status)) timer = setTimeout(() => void update(), 1500);
      } catch (error) {
        if (controller.signal.aborted) return;
        setDetailLoading(false);
        setDetailError(error instanceof MissionApiError && error.status === 404
          ? 'Dieser Auftrag wurde nicht gefunden oder ist nicht zugänglich.'
          : 'Der Auftragsstatus konnte nicht geladen werden. Eine begonnene Prüfung kann weiterlaufen; lade den Status erneut.');
      }
    };
    void update();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [selectedId, detailAttempt, remember]);

  useEffect(() => {
    if (!mission) return;
    const key = `${mission.id}:${mission.status}`;
    if (previousStatus.current !== key && (!previousStatus.current || mission.status === 'awaiting_confirmation' || mission.status === 'completed')) heading.current?.focus({ preventScroll: true });
    previousStatus.current = key;
  }, [mission]);

  const perform = async (operation: 'create' | 'run' | 'retry', input?: MissionRunInput) => {
    if (mutation.current) return;
    const current = mission;
    if (operation !== 'create' && !current) return;
    if (operation === 'create' && (!question.trim() || !effectiveDatasetId || (relationshipId && (!relationshipDetail || relationshipLoading || relationshipError)))) {
      setCommandError('Bitte einen Auftrag formulieren und eine importierte Quelle auswählen.'); return;
    }
    const createInput = { question: question.trim(), datasetId: effectiveDatasetId, ...(relationshipId ? { relationshipId } : {}) };
    const payload = operation === 'create' ? createInput
      : operation === 'run' ? { ...input!, revision: current!.revision }
        : { revision: current!.revision };
    const requestKey = `${storagePrefix}${operation}:${current && operation !== 'create' ? current.id : orderTask && relationshipId ? `order:${relationshipId}` : 'new'}`;
    const requestId = missionRequestId(requestKey, payload);
    const controller = new AbortController();
    mutation.current = controller;
    const epoch = navigationEpoch.current;
    setBusy(true); setCommandError('');
    try {
      const next = operation === 'create'
        ? await createMission({ ...createInput, requestId }, controller.signal)
        : operation === 'run'
          ? await runMission(current!.id, { ...input!, revision: current!.revision, requestId }, controller.signal)
          : await retryMission(current!.id, { revision: current!.revision, requestId }, controller.signal);
      clearMissionRequest(requestKey);
      if (controller.signal.aborted) return;
      remember(next);
      if (epoch === navigationEpoch.current) {
        if (operation === 'create') select(next.id);
        else { setMission(next); setDetailAttempt(value => value + 1); }
      }
    } catch (error) {
      if (controller.signal.aborted || epoch !== navigationEpoch.current) return;
      if (error instanceof MissionApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) clearMissionRequest(requestKey);
      setCommandError(error instanceof MissionApiError && error.status < 500
        ? errorMessage(error)
        : 'Die Antwort auf die Anfrage ist ausgeblieben. Der Auftrag kann bereits gespeichert sein. Erneutes Senden verwendet dieselbe Anfrage-ID.');
      if (error instanceof MissionApiError && error.status === 409 && current) setDetailAttempt(value => value + 1);
    } finally {
      if (mutation.current === controller) mutation.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const capability = capabilities.find(item => item.id === mission?.plan?.capabilityId);
  return <div className="kf-missions">
    {showImport && <ImportWorkspaceDialog onClose={() => setShowImport(false)} onCompleted={items => {
      const imported = items.filter(item => item.connectorId === 'inline');
      if (imported.length > 0) setSourceError('');
      setDatasets(current => [...imported, ...current.filter(item => !imported.some(next => next.id === item.id))]);
      if (imported[0]) { setDatasetId(imported[0].id); setNotice('Quelle übernommen. Formuliere jetzt den Auftrag für diesen Datenstand.'); }
      else setNotice('Die Quelle wurde hinzugefügt. Für Aufträge ist ein vollständig importierter Datenstand erforderlich.');
      setShowImport(false);
    }} />}
    <div className="kf-mission-toolbar"><p>Beschreibe dein Ziel. KoiForge schlägt eine verfügbare Prüfung vor; du bestätigst den fachlichen Umfang.</p>
      <div className="kf-mission-actions"><a className="text-brand underline" data-testid="mission-routines" href="#/missions?view=routines">Routinen</a><a className="text-brand underline" data-testid="mission-cases" href="#/missions?view=cases">Klärungsfälle</a>{selectedId && <button type="button" className={ghostBtnCls} onClick={() => select('')}>Neuer Auftrag</button>}</div>
    </div>
    <div className="kf-mission-layout">
      <aside className="kf-mission-history" aria-label="Gespeicherte Aufträge">
        <Card title="Deine Aufträge" action={<button type="button" className={ghostBtnCls} onClick={() => setLoadAttempt(value => value + 1)} aria-label="Auftragsliste aktualisieren">Aktualisieren</button>}>
          {historyLoading && <p role="status">Aufträge werden geladen…</p>}
          {historyError && <p className="kf-mission-error" role="alert">{historyError}</p>}
          {!historyLoading && !historyError && missions.length === 0 && <p className="kf-mission-muted">Noch keine gespeicherten Aufträge. Beginne mit einer Quelle und deiner Frage.</p>}
          <ul className="kf-mission-list">{missions.map(item => <li key={item.id}><button type="button" onClick={() => select(item.id)} aria-current={selectedId === item.id ? 'page' : undefined}>
            <strong>{item.question}</strong><MissionBadge mission={item} /><small>{formatDate(item.updatedAt)}</small>
          </button></li>)}</ul>
        </Card>
      </aside>
      <div className="kf-mission-workspace">
        {commandError && <div className="kf-mission-error kf-mission-alert" role="alert">{commandError}</div>}
        {!selectedId ? <>
          <Card title="Neuer Auftrag">
            <form className="kf-mission-stack" onSubmit={event => { event.preventDefault(); void perform('create'); }}>
              <h3 ref={draftHeading} tabIndex={-1}>Was möchtest du mit deinen Daten klären?</h3>
              {notice && <p role="status">{notice}</p>}
              {relationshipId ? <div className="kf-mission-stack" data-testid="mission-attached-relationship">
                {relationshipLoading && <p role="status">Bestätigte Beziehung wird geladen…</p>}
                {relationshipError && <div className="kf-mission-stack" role="alert"><p>{relationshipError}</p><button type="button" className={ghostBtnCls} onClick={() => setRelationshipAttempt(value => value + 1)}>Beziehung erneut laden</button></div>}
                {relationshipDetail && <>
                  <RelationshipContext relationship={{ id: relationshipDetail.relationship.id, name: relationshipDetail.relationship.name,
                    fromSetId: relationshipDetail.from.id, toSetId: relationshipDetail.to.id, fromName: relationshipDetail.from.name, toName: relationshipDetail.to.name,
                    fromField: relationshipDetail.relationship.fromField, toField: relationshipDetail.to.keyField,
                    fromRevision: relationshipDetail.from.revision, toRevision: relationshipDetail.to.revision,
                    sourceHash: relationshipDetail.from.source.hash, targetHash: relationshipDetail.to.source.hash,
                    fromSnapshotHash: relationshipDetail.from.snapshotHash, toSnapshotHash: relationshipDetail.to.snapshotHash, targetRows: relationshipDetail.to.source.rowCount }} />
                  <p>Festgehaltene Ausgangsquelle: <strong>{relationshipDetail.from.source.name}</strong> · {formatNumber(relationshipDetail.from.source.rowCount)} Zeilen. Zielquelle: <strong>{relationshipDetail.to.source.name}</strong>.</p>
                  <a className="text-brand underline" href={`#/model?relationship=${encodeURIComponent(relationshipId)}`}>Beziehung und Quellenbelege öffnen</a>
                </>}
              </div> : <>
              {sourceError && <p className="kf-mission-error" role="alert">{sourceError} <button type="button" className={ghostBtnCls} onClick={() => setLoadAttempt(value => value + 1)}>Quellen erneut laden</button></p>}
              <label className="kf-mission-field"><span>Importierte Quelle</span><select data-testid="mission-source" className={selectCls} value={datasetId} disabled={busy || sourceLoading} onChange={event => { setDatasetId(event.target.value); setCommandError(''); }}>
                <option value="">Quelle auswählen…</option>{datasets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select></label>
              {!sourceLoading && !sourceError && datasets.length === 0 && <p>Füge zuerst eine Quelle hinzu. CSV-Dateien können direkt importiert werden.</p>}
              <div><button className={ghostBtnCls} type="button" disabled={busy} onClick={() => setShowImport(true)}>Datenquelle hinzufügen</button></div>
              </>}
              <label className="kf-mission-field"><span>Dein Auftrag</span><textarea data-testid="mission-question" className={inputCls} rows={3} maxLength={1000} value={question} disabled={busy} onChange={event => { setQuestion(event.target.value); setCommandError(''); }} placeholder="Zum Beispiel: Welche Werte fehlen in meinen Daten?" required /></label>
              <p className="kf-mission-muted">Für den Planungsvorschlag werden dein Auftrag, Spaltennamen und Zeilenzahl an den eingerichteten Modelldienst übermittelt. Die Datenzeilen werden nicht zur Planung übermittelt.</p>
              <div className="kf-mission-actions"><button data-testid="mission-plan" type="submit" className="kf-mission-primary" disabled={busy || !effectiveDatasetId || !question.trim() || (relationshipId ? relationshipLoading || !relationshipDetail || Boolean(relationshipError) : sourceLoading)}>{busy ? 'Auftrag wird gespeichert…' : 'Auftrag planen'}</button></div>
              <p className="kf-mission-muted">Nach dem Start bleibt dein Auftrag hier und über seinen Link wieder auffindbar.</p>
            </form>
          </Card>
          <Card title="Verfügbare Prüfungen">
            {capabilityError ? <div className="kf-mission-stack"><p role="alert">{capabilityError}</p><button className={ghostBtnCls} type="button" onClick={() => setLoadAttempt(value => value + 1)}>Fähigkeiten erneut laden</button></div>
              : capabilities.length === 0 ? <p role="status">Fähigkeiten werden geladen…</p>
                : <div className="kf-mission-capabilities">{capabilities.map(item => <div key={item.id}><h3>{item.title}</h3><p>{item.description}</p><ul>{item.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul>{(item.id === 'relationship_integrity' || item.id === 'order_review') && <p><a className="text-brand underline" href="#/model?kind=relationships">Beziehung im Fachmodell auswählen</a></p>}</div>)}</div>}
          </Card>
          {datasetId && !relationshipId && <Card title="Aktuelle Quellenvorschau">
            {previewLoading && <p role="status">Quellenvorschau wird geladen…</p>}
            {previewError && <div className="kf-mission-stack"><p role="alert">{previewError}</p><button type="button" className={ghostBtnCls} onClick={() => setPreviewAttempt(value => value + 1)}>Vorschau erneut laden</button></div>}
            {preview && <div className="kf-mission-stack"><p>Vorschau: {formatNumber(Math.min(100, preview.rows.length))} von {formatNumber(preview.rowCount)} Quellzeilen. Der Plan hält den vollständigen Datenstand fest.</p>
              <PreviewTable columns={preview.columns} rows={preview.rows.slice(0, 100)} label="Aktuelle Quellenvorschau" /></div>}
          </Card>}
        </> : <>
          {detailLoading && <p className="kf-mission-alert" role="status">Auftrag wird geladen…</p>}
          {detailError && <div className="kf-mission-alert kf-mission-stack" role="alert"><p>{detailError}</p><button type="button" className={ghostBtnCls} onClick={() => setDetailAttempt(value => value + 1)}>Auftragsstatus erneut laden</button></div>}
          {mission && mission.id === selectedId && <>
            <Card title="Auftrag" action={<span data-testid="mission-status"><MissionBadge mission={mission} /></span>}>
              <div className="kf-mission-stack"><h3 className="kf-mission-question" ref={heading} tabIndex={-1}>{mission.question}</h3>
                <p className="kf-mission-muted">Gespeichert am {formatDate(mission.createdAt)} · Zuletzt aktualisiert {formatDate(mission.updatedAt)}</p>
                {activeStatus(mission.status) && <div className="kf-mission-progress" role="status"><strong>{statusLabels[mission.status]}</strong><p>{mission.events.at(-1)?.message ?? 'Der gespeicherte Auftrag wird bearbeitet.'}</p><p>Du kannst diese Seite verlassen und den Auftrag später wieder öffnen.</p></div>}
                {mission.source && <dl className="kf-mission-facts"><div><dt>Festgehaltene Quelle</dt><dd>{mission.source.name}</dd></div><div><dt>Vollständiger Datenstand</dt><dd>{formatNumber(mission.source.rowCount)} Quellzeilen · {formatNumber(mission.source.columns.length)} Spalten</dd></div><div><dt>Erfasst am</dt><dd>{formatDate(mission.source.capturedAt)}</dd></div></dl>}
                {mission.plan?.relationship && <RelationshipContext relationship={mission.plan.relationship} />}
                {mission.routine && <div className="kf-mission-alert" data-testid="mission-routine-origin"><p>Aus Routine <a className="text-brand underline" href={`#/missions?routine=${encodeURIComponent(mission.routine.id)}`}>{mission.routine.name}</a>. Der gespeicherte Plan wird wiederverwendet; die Ausführung wurde für diesen Quellenstand und Stichtag bestätigt.</p></div>}
                {mission.status === 'interrupted' && <p className="kf-mission-alert">Die Bearbeitung wurde unterbrochen. Eine Wiederholung verwendet denselben festgehaltenen Datenstand und wird als neuer Versuch protokolliert.</p>}
                {mission.plan?.unsupportedReason && <div className="kf-mission-alert"><h3>Für diesen Auftrag fehlt eine passende Fähigkeit</h3><p>{mission.plan.unsupportedReason}</p><p>Der Auftrag bleibt gespeichert. Du kannst einen neuen Auftrag für eine verfügbare Prüfung beginnen.</p></div>}
                {mission.error && <p className="kf-mission-error" role="alert">{mission.error}</p>}
                {(mission.status === 'blocked' || mission.status === 'interrupted') && !mission.plan?.unsupportedReason && <div><button type="button" className={ghostBtnCls} disabled={busy} onClick={() => void perform('retry')}>{busy ? 'Wiederholung wird gespeichert…' : 'Erneut versuchen'}</button></div>}
              </div>
            </Card>
            {mission.result && <MissionResultView key={mission.id} mission={mission as Mission & { result: MissionResult }} storageScope={storageScope} />}
            {mission.plan && <Card title="Plan und Grenzen">
              <div className="kf-mission-stack"><h3>{capability?.title ?? (mission.plan.capabilityId === 'source_freshness' ? 'Quellenalter prüfen' : mission.plan.capabilityId === 'data_quality' ? 'Datenvollständigkeit prüfen' : mission.plan.capabilityId === 'relationship_integrity' ? 'Bestätigte Beziehung prüfen' : mission.plan.capabilityId === 'order_review' ? 'Offene Bestellungen prüfen' : 'Keine passende Prüfung verfügbar')}</h3>
                <p>{mission.plan.summary}</p>
                {mission.plan.reusedFromMissionId && <p className="kf-mission-muted">Gespeicherter Plan wiederverwendet aus <a className="text-brand underline" href={`#/missions?id=${encodeURIComponent(mission.plan.reusedFromMissionId)}`}>dem Ausgangsauftrag</a>. Ursprüngliche Planung: {mission.plan.generation.model} · {mission.plan.generation.reasoningEffort}.</p>}
                {mission.plan.steps.length > 0 && <ol className="kf-mission-steps">{mission.plan.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>}
                {mission.plan.limitations.length > 0 && <div><h3>Was diese Prüfung abdeckt</h3><ul className="kf-mission-limits">{mission.plan.limitations.map((limit, index) => <li key={index}>{limit}</li>)}</ul></div>}
                {!mission.routine && (mission.status === 'awaiting_confirmation' || (mission.phase === 'execute' && (mission.status === 'blocked' || mission.status === 'interrupted'))) && mission.plan.capabilityId && !mission.plan.unsupportedReason && (mission.plan.capabilityId === 'order_review'
                  ? <OrderConfirmation key={`${mission.id}:${mission.revision}`} mission={mission} storagePrefix={storagePrefix} busy={busy} onRun={input => void perform('run', input)} />
                  : <MissionConfirmation key={`${mission.id}:${mission.revision}`} mission={mission} busy={busy} onRun={input => void perform('run', input)} />)}
              </div>
            </Card>}
            <Card title="Verlauf"><ol className="kf-mission-events">{mission.events.map((event, index) => <li key={`${event.at}:${index}`}><time dateTime={event.at}>{formatDate(event.at)}</time><strong>{statusLabels[event.status]}</strong><p>{event.message}</p></li>)}</ol></Card>
          </>}
        </>}
      </div>
    </div>
  </div>;
}
