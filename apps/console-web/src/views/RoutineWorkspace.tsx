import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Badge, Card, ghostBtnCls, inputCls, selectCls } from '../components/ui';
import { clearMissionRequest, missionRequestId, type Mission } from '../mission-api';
import { fetchRelationships, type Relationship } from '../semantic-model-api';
import {
  createRoutine, fetchRoutine, fetchRoutines, previewRoutine, runRoutine, RoutineApiError,
  type RoutineDefinition, type RoutinePreview,
} from '../routine-api';
import { RoutineRunComparison } from './RoutineRunComparison';
import '../routines.css';

const number = (value: number) => value.toLocaleString('de-DE');
const date = (value: string) => new Date(value).toLocaleString('de-DE');
const message = (reason: unknown) => reason instanceof Error ? reason.message : 'Die Anfrage ist fehlgeschlagen.';
const countFields = [
  ['sourceRows', 'Geprüfte Quellzeilen'], ['overdueRows', 'Offen und überfällig'], ['openRows', 'Offen'],
  ['closedRows', 'Abgeschlossen'], ['unassessableRows', 'Bestellung nicht beurteilbar'],
  ['clarificationRows', 'Zeilen mit Klärungsbedarf'], ['deadlineUnassessableRows', 'Offene Bestellungen ohne beurteilbaren Termin'],
] as const;
const count = (values: Record<string, number> | undefined, field: string) => values && Object.hasOwn(values, field) ? values[field] : undefined;
function calendarDay(value: string): boolean {
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
function saveDraft(key: string, value: unknown) {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* Draft storage is optional. */ }
}
function readName(key: string): string {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    return typeof value === 'string' ? value : '';
  } catch { return ''; }
}
function settledFailure(reason: unknown): boolean {
  return reason instanceof RoutineApiError && reason.status >= 400 && reason.status < 500 && reason.status !== 408 && reason.status !== 429;
}
const lostResponse = 'Die Antwort ist ausgeblieben. Der Vorgang kann bereits gespeichert sein. Erneutes Senden mit denselben Eingaben verwendet dieselbe Anfrage-ID.';

export function SaveRoutineAction({ mission, storageScope }: { mission: Mission; storageScope: string }) {
  const prefix = `koiforge:routines:${storageScope}:`;
  const draftKey = `${prefix}save-name:${mission.id}`;
  const requestKey = `${prefix}save:${mission.id}`;
  const [name, setName] = useState(() => readName(draftKey));
  const [open, setOpen] = useState(Boolean(name));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => { if (open) input.current?.focus({ preventScroll: true }); }, [open]);
  if (mission.status !== 'completed' || mission.result?.capabilityId !== 'order_review' || !mission.input?.orderRule) return null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (request.current) return;
    if (!name.trim() || name.trim().length > 120) { setError('Bitte einen Routinenamen mit 1 bis 120 Zeichen angeben.'); return; }
    const payload = { sourceMissionId: mission.id, name: name.trim(), confirmed: true as const };
    const requestId = missionRequestId(requestKey, payload);
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError('');
    try {
      const routine = await createRoutine({ ...payload, requestId }, controller.signal);
      clearMissionRequest(requestKey);
      if (controller.signal.aborted) return;
      saveDraft(draftKey, '');
      window.location.hash = `/missions?routine=${encodeURIComponent(routine.id)}`;
    } catch (reason) {
      if (controller.signal.aborted) return;
      if (settledFailure(reason)) clearMissionRequest(requestKey);
      setError(settledFailure(reason) ? message(reason) : lostResponse);
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return <div className="kf-routines kf-routine-save">
    {!open ? <button type="button" className={ghostBtnCls} data-testid="mission-save-routine" onClick={() => setOpen(true)}>Als Routine speichern</button>
      : <form className="kf-routine-stack" aria-label="Als Routine speichern" onSubmit={event => void submit(event)}>
        <h3>Als Routine speichern</h3>
        <p>Die Routine übernimmt die bestätigten Bestellregeln und diesen Ausgangsauftrag unverändert. Weitere Läufe startest du nach einem Vergleich der Datenstände ausdrücklich selbst.</p>
        <label className="kf-routine-field"><span>Name der Routine</span><input ref={input} className={inputCls} data-testid="routine-name" maxLength={120} value={name} disabled={busy} onChange={event => { setName(event.target.value); saveDraft(draftKey, event.target.value); clearMissionRequest(requestKey); setError(''); }} /></label>
        {error && <p className="kf-routine-error" role="alert">{error}</p>}
        <div className="kf-routine-actions"><button className="kf-routine-primary" data-testid="routine-save" type="submit" disabled={busy}>{busy ? 'Routine wird gespeichert…' : 'Routine speichern'}</button><button className={ghostBtnCls} type="button" disabled={busy} onClick={() => setOpen(false)}>Schließen</button></div>
      </form>}
  </div>;
}

function RoutineRules({ routine }: { routine: RoutineDefinition }) {
  return <div className="kf-routine-stack" data-testid="routine-rules">
    <p>{routine.question}</p>
    <dl className="kf-routine-facts">
      <div><dt>Statusspalte</dt><dd>{routine.binding.statusField}</dd></div>
      <div><dt>Bestätigte Bestellungs-ID</dt><dd>{routine.baseline.orderKeyField}</dd></div>
      <div><dt>Offene Statuswerte · Text</dt><dd>{routine.orderRule.openStatuses.length ? routine.orderRule.openStatuses.map(value => <code className="kf-routine-literal" key={value}>{JSON.stringify(value)}</code>) : 'Keine Werte als offen eingeordnet'}</dd></div>
      <div><dt>Abgeschlossene Statuswerte · Text</dt><dd>{routine.orderRule.closedStatuses.length ? routine.orderRule.closedStatuses.map(value => <code className="kf-routine-literal" key={value}>{JSON.stringify(value)}</code>) : 'Keine Werte als abgeschlossen eingeordnet'}</dd></div>
      <div><dt>Terminbedeutung</dt><dd>{routine.orderRule.dueDateMeaning === 'promised_delivery_day' ? `Zugesagter Lieferkalendertag · ${routine.binding.dueDateField}` : 'Kein Liefertermin verfügbar'}</dd></div>
      <div><dt>Stichtag des Ausgangsauftrags</dt><dd>{routine.orderRule.asOf}</dd></div>
      <div><dt>Ausgangsauftrag</dt><dd><a href={`#/missions?id=${encodeURIComponent(routine.sourceMissionId)}`}>Bestätigten Auftrag öffnen</a></dd></div>
      <div><dt>Gespeichert am</dt><dd>{date(routine.createdAt)}</dd></div>
    </dl>
    <p className="kf-routine-muted">Die Statuswerte werden exakt als Text verglichen. Andere Statuswerte bleiben ungeklärt. Für einen Lauf änderst du den Stichtag und wählst eine bestätigte Beziehung; die gespeicherten Fachregeln bleiben gleich.</p>
    <details className="kf-routine-details"><summary>Ausgangsstände und technische Belege</summary><dl className="kf-routine-facts">
      <div><dt>Bestellungen</dt><dd>{routine.baseline.source.name} · Revision {routine.baseline.relationship.fromRevision} · {number(routine.baseline.source.rowCount)} Zeilen</dd></div>
      <div><dt>Lieferanten</dt><dd>{routine.baseline.targetSource.name} · Revision {routine.baseline.relationship.toRevision} · {number(routine.baseline.targetSource.rowCount)} Zeilen</dd></div>
      <div><dt>Bestätigte Beziehung</dt><dd><a href={`#/model?relationship=${encodeURIComponent(routine.baseline.relationship.id)}`}>{routine.baseline.relationship.name}</a> · {routine.baseline.relationship.fromField} → {routine.baseline.relationship.toField}</dd></div>
      <div><dt>Fähigkeitsversion</dt><dd>{routine.capabilityVersion}</dd></div>
      <div><dt>Quellen-Hash der Bestellungen</dt><dd><code>{routine.baseline.source.hash}</code></dd></div>
      <div><dt>Quellen-Hash der Lieferanten</dt><dd><code>{routine.baseline.targetSource.hash}</code></dd></div>
      <div><dt>Hash der ursprünglichen Regeln</dt><dd><code>{routine.baseline.orderRuleHash}</code></dd></div>
      <div><dt>Routine-ID</dt><dd><code>{routine.id}</code></dd></div>
    </dl></details>
  </div>;
}

function RoutineComparison({ preview }: { preview: RoutinePreview }) {
  const profile = preview.statusProfile;
  return <div className="kf-routine-stack" data-testid="routine-preview">
    <div className="kf-routine-callout"><h3>{preview.ready ? 'Änderungen geprüft – Bestätigung erforderlich' : 'Dieser Stand passt nicht zur Routine'}</h3>
      {!preview.ready && <ul role="alert">{preview.blockingReasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
      {preview.ready && <p>Die gespeicherten Regeln lassen sich auf diesen Stand anwenden. Prüfe den Vergleich vor dem Start.</p>}
    </div>
    {preview.warnings.length > 0 && <div className="kf-routine-callout"><h3>Hinweise zum neuen Stand</h3><ul>{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
    <dl className="kf-routine-facts">
      <div><dt>Bestellungen · {preview.source.name}</dt><dd>Revision {preview.changes.from.previousRevision} → {preview.changes.from.revision}<br />{number(preview.changes.from.previousRows)} → {number(preview.changes.from.rows)} Zeilen</dd></div>
      <div><dt>Lieferanten · {preview.targetSource.name}</dt><dd>Revision {preview.changes.to.previousRevision} → {preview.changes.to.revision}<br />{number(preview.changes.to.previousRows)} → {number(preview.changes.to.rows)} Zeilen</dd></div>
      <div><dt>Stichtag (Kalendertag)</dt><dd>{preview.changes.asOf.previous} → {preview.changes.asOf.current}{!preview.changes.asOf.changed && ' · unverändert'}</dd></div>
      <div><dt>Ausgewählte Beziehung</dt><dd><a href={`#/model?relationship=${encodeURIComponent(preview.relationshipId)}`}>{preview.relationship.name}</a></dd></div>
    </dl>
    <div className="kf-routine-stack"><h3>Unterschiede zum Ausgangsauftrag</h3>
      <p className="kf-routine-muted">Die Kennzahlen umfassen alle Zeilen der jeweiligen Stände. Differenzen zeigen keine Ursache: Quelldaten und Stichtag können sich gleichzeitig ändern. „Offen“ umfasst auch offene Bestellungen ohne beurteilbaren Termin; Klärungsbedarf wird zusätzlich gezählt.</p>
      <div className="kf-routine-table" role="region" aria-label="Kennzahlenvergleich" tabIndex={0} data-testid="routine-count-comparison"><table>
        <thead><tr><th scope="col">Kennzahl</th><th scope="col">Ausgangsauftrag</th><th scope="col">Neuer Stand</th><th scope="col">Differenz</th></tr></thead>
        <tbody>{countFields.map(([key, label]) => {
          const before = count(preview.previousCounts, key); const after = count(preview.newCounts, key); const delta = count(preview.deltas, key);
          return <tr key={key}><th scope="row">{label}</th><td>{before === undefined ? 'Nicht vorhanden' : number(before)}</td><td>{after === undefined ? 'Nicht berechnet' : number(after)}</td><td>{delta === undefined ? '–' : `${delta > 0 ? '+' : ''}${number(delta)}`}</td></tr>;
        })}</tbody>
      </table></div>
    </div>
    <div className="kf-routine-stack" data-testid="routine-unknown-statuses"><h3>Statuswerte im ausgewählten Stand</h3>
      <p>{number(profile.totalRows)} Quellzeilen · {number(profile.knownOpenRows)} mit offenem Status · {number(profile.knownClosedRows)} mit abgeschlossenem Status · {number(profile.unknownRows)} mit unbestätigtem Textstatus · {number(profile.missingRows)} ohne Status · {number(profile.nonTextRows)} mit anderem Datentyp.</p>
      <p className="kf-routine-muted">Diese Häufigkeiten beschreiben die Statusspalte. Eine ungültige Bestellungs-ID kann die Beurteilung einer Zeile zusätzlich verhindern. Unbestätigte Werte werden nicht automatisch als offen oder abgeschlossen eingeordnet.</p>
      {profile.unassignableRows > 0 && <p className="kf-routine-callout">{number(profile.unassignableRows)} Zeilen enthalten Statuswerte mit mehr als 200 Zeichen. Diese bleiben ungeklärt und werden nicht als Einzelwerte angezeigt.</p>}
      {profile.unknownValues.length > 0 ? <ul className="kf-routine-status-list">{profile.unknownValues.map(item => <li key={item.value}><code className="kf-routine-literal">{JSON.stringify(item.value)}</code><span className="kf-routine-muted">Text · {number(item.count)} {item.count === 1 ? 'Zeile' : 'Zeilen'}</span></li>)}</ul> : <p>{profile.unknownRows > 0 ? 'Unbestätigte Statuswerte sind vorhanden; es liegen keine anzeigbaren Einzelwerte vor.' : 'Keine unbestätigten Textstatus vorhanden.'}</p>}
      {profile.truncated && <p className="kf-routine-callout">Die Liste zeigt {number(profile.unknownValues.length)} von {number(profile.unknownUniqueTotal)} unterschiedlichen unbestätigten Textwerten. Die Kennzahlen berücksichtigen alle Zeilen.</p>}
    </div>
    <details className="kf-routine-details"><summary>Spalten, Feldbedeutungen und Vorschau-Belege</summary><div className="kf-routine-stack">
      {(['from', 'to'] as const).map(side => <div key={side}><h3>{side === 'from' ? 'Bestellquelle' : 'Lieferantenquelle'}</h3><p>Hinzugefügte Spalten: {preview.changes[side].addedColumns.length ? preview.changes[side].addedColumns.join(', ') : 'keine'}.</p><p>Entfernte Spalten: {preview.changes[side].removedColumns.length ? preview.changes[side].removedColumns.join(', ') : 'keine'}.</p></div>)}
      <dl className="kf-routine-facts">
        {([['orderKey', 'Bestellungs-ID'], ['referenceField', 'Lieferantenreferenz'], ['targetKey', 'Lieferanten-ID']] as const).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{preview.changes[key].previous} → {preview.changes[key].current}{!preview.changes[key].changed && ' · unverändert'}</dd></div>)}
        <div><dt>Quellen-Hash der Bestellungen</dt><dd><code>{preview.source.hash}</code></dd></div>
        <div><dt>Quellen-Hash der Lieferanten</dt><dd><code>{preview.targetSource.hash}</code></dd></div>
        <div><dt>Regelhash mit neuem Stichtag</dt><dd><code>{preview.orderRuleHash}</code></dd></div>
        {preview.previewHash && <div><dt>Vorschau-Hash</dt><dd><code>{preview.previewHash}</code></dd></div>}
      </dl>
    </div></details>
  </div>;
}

interface RunDraft { relationshipId: string; asOf: string; previewRequested: boolean }
function readRunDraft(key: string): RunDraft {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (typeof value?.relationshipId === 'string' && typeof value?.asOf === 'string') return { relationshipId: value.relationshipId, asOf: value.asOf, previewRequested: value.previewRequested === true };
  } catch { /* A new run can start without stored input. */ }
  return { relationshipId: '', asOf: '', previewRequested: false };
}

function RoutineDetail({ id, storageScope }: { id: string; storageScope: string }) {
  const selectedSection = () => {
    const query = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
    return query.has('compare') || query.get('mode') === 'compare';
  };
  const [comparing, setComparing] = useState(selectedSection);
  useEffect(() => {
    const changed = () => setComparing(selectedSection());
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  const selectSection = (compare: boolean) => {
    const query = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
    if (compare) query.set('mode', 'compare');
    else { query.delete('mode'); query.delete('compare'); }
    window.history.replaceState(null, '', `#/missions?${query}`);
    setComparing(compare);
  };
  const prefix = `koiforge:routines:${storageScope}:`;
  const draftKey = `${prefix}run-draft:${id}`;
  const requestKey = `${prefix}run:${id}`;
  const [draft, setDraft] = useState(() => readRunDraft(draftKey));
  const resumePreview = useRef(draft.previewRequested);
  const [routine, setRoutine] = useState<RoutineDefinition | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [relationships, setRelationships] = useState<Relationship[]>([]);
  const [relationshipsLoading, setRelationshipsLoading] = useState(true);
  const [relationshipsError, setRelationshipsError] = useState('');
  const [relationshipsAttempt, setRelationshipsAttempt] = useState(0);
  const [preview, setPreview] = useState<RoutinePreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState('');
  const previewRequest = useRef<AbortController | null>(null);
  const runRequest = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setLoadError('');
    void fetchRoutine(id, controller.signal).then(value => { if (!controller.signal.aborted) setRoutine(value); })
      .catch(reason => { if (!controller.signal.aborted) setLoadError(message(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, loadAttempt]);
  useEffect(() => {
    const controller = new AbortController(); setRelationshipsLoading(true); setRelationshipsError('');
    void fetchRelationships(controller.signal).then(values => { if (!controller.signal.aborted) setRelationships(values); })
      .catch(reason => { if (!controller.signal.aborted) setRelationshipsError(message(reason)); })
      .finally(() => { if (!controller.signal.aborted) setRelationshipsLoading(false); });
    return () => controller.abort();
  }, [relationshipsAttempt]);
  useEffect(() => () => { epoch.current++; previewRequest.current?.abort(); runRequest.current?.abort(); }, []);
  useEffect(() => { if (routine) heading.current?.focus({ preventScroll: true }); }, [routine]);
  useEffect(() => { saveDraft(draftKey, draft); }, [draftKey, draft]);

  const inspect = useCallback(async () => {
    if (runRequest.current) return;
    setPreviewError(''); setRunError(''); setConfirmed(false); setPreview(null);
    if (!draft.relationshipId || !calendarDay(draft.asOf)) { setPreviewError('Bitte eine bestätigte Beziehung und einen gültigen Kalendertag im Format JJJJ-MM-TT (Jahre 1000 bis 9999) wählen.'); return; }
    previewRequest.current?.abort();
    const controller = new AbortController(); previewRequest.current = controller;
    const generation = ++epoch.current;
    setPreviewBusy(true); setDraft(current => ({ ...current, previewRequested: true }));
    try {
      const value = await previewRoutine(id, { relationshipId: draft.relationshipId, asOf: draft.asOf }, controller.signal);
      if (controller.signal.aborted || epoch.current !== generation) return;
      setPreview(value);
    } catch (reason) {
      if (!controller.signal.aborted && epoch.current === generation) setPreviewError(message(reason));
    } finally {
      if (previewRequest.current === controller) previewRequest.current = null;
      if (!controller.signal.aborted && epoch.current === generation) setPreviewBusy(false);
    }
  }, [id, draft.relationshipId, draft.asOf]);
  useEffect(() => {
    if (!routine || comparing || !resumePreview.current) return;
    resumePreview.current = false;
    void inspect();
  }, [routine, comparing, inspect]);
  useEffect(() => { if (preview && !comparing) previewHeading.current?.focus({ preventScroll: true }); }, [preview, comparing]);
  const change = (value: Partial<RunDraft>) => {
    epoch.current++; resumePreview.current = false;
    previewRequest.current?.abort(); previewRequest.current = null;
    setDraft(current => ({ ...current, ...value, previewRequested: false }));
    setPreview(null); setPreviewBusy(false); setConfirmed(false); setPreviewError(''); setRunError('');
    clearMissionRequest(requestKey);
  };
  const run = async () => {
    if (runRequest.current || !preview?.ready || !preview.previewHash) return;
    if (!confirmed) { setRunError('Bitte die gespeicherten Regeln für den neuen Stand und Stichtag ausdrücklich bestätigen.'); return; }
    if (preview.relationshipId !== draft.relationshipId || preview.asOf !== draft.asOf) { setRunError('Die Eingaben haben sich geändert. Bitte die Änderungen erneut prüfen.'); return; }
    const payload = { relationshipId: draft.relationshipId, asOf: draft.asOf, previewHash: preview.previewHash, confirmed: true as const };
    const requestId = missionRequestId(requestKey, payload);
    const controller = new AbortController(); runRequest.current = controller;
    const generation = epoch.current;
    setRunning(true); setRunError('');
    try {
      const mission = await runRoutine(id, { ...payload, requestId }, controller.signal);
      clearMissionRequest(requestKey);
      if (!controller.signal.aborted && generation === epoch.current) window.location.hash = `/missions?id=${encodeURIComponent(mission.id)}`;
    } catch (reason) {
      if (controller.signal.aborted || generation !== epoch.current) return;
      if (settledFailure(reason)) clearMissionRequest(requestKey);
      setRunError(settledFailure(reason) ? message(reason) : lostResponse);
      if (reason instanceof RoutineApiError && reason.status === 409) { setPreview(null); setConfirmed(false); }
    } finally {
      if (runRequest.current === controller) runRequest.current = null;
      if (!controller.signal.aborted) setRunning(false);
    }
  };

  return <div className="kf-routine-stack" data-testid="routine-detail">
    {loading && <p className="kf-routine-callout" role="status">Routine wird geladen…</p>}
    {loadError && <div className="kf-routine-callout kf-routine-stack"><p className="kf-routine-error" role="alert">{loadError}</p><div><button className={ghostBtnCls} type="button" onClick={() => setLoadAttempt(value => value + 1)}>Routine erneut laden</button></div></div>}
    {routine && <>
      <Card title="Gespeicherte Routine" action={<Badge>Bestellprüfung</Badge>}><div className="kf-routine-stack"><h3 className="kf-routine-name" ref={heading} tabIndex={-1}>{routine.name}</h3><RoutineRules routine={routine} /></div></Card>
      <div className="kf-routine-section-tabs" role="tablist" aria-label="Mit dieser Routine arbeiten" onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? false : event.key === 'End' ? true : !comparing;
        selectSection(next); document.getElementById(next ? 'routine-changes-tab' : 'routine-run-tab')?.focus();
      }}>
        <button id="routine-run-tab" type="button" role="tab" tabIndex={comparing ? -1 : 0} aria-selected={!comparing} aria-controls="routine-run-panel" onClick={() => selectSection(false)}>Neuen Stand prüfen</button>
        <button id="routine-changes-tab" type="button" role="tab" tabIndex={comparing ? 0 : -1} aria-selected={comparing} aria-controls="routine-changes-panel" onClick={() => selectSection(true)}>Befunde vergleichen</button>
      </div>
      <div id="routine-changes-panel" role="tabpanel" aria-labelledby="routine-changes-tab" hidden={!comparing}>
        {comparing && <RoutineRunComparison routine={routine} storageScope={storageScope} />}
      </div>
      <div id="routine-run-panel" role="tabpanel" aria-labelledby="routine-run-tab" hidden={comparing}>
      <div className="kf-routine-stack">
      <Card title="Neuen Stand prüfen"><div className="kf-routine-stack">
        <p>Wähle eine bestätigte Beziehung zwischen denselben Objektfamilien. Bestellungs-ID, Lieferanten-ID und Referenzbedeutung müssen erhalten bleiben. Neuere Revisionen legst du im <a href="#/model?kind=relationships">Fachmodell</a> an.</p>
        <form className="kf-routine-stack" aria-label="Änderungen prüfen" onSubmit={event => { event.preventDefault(); void inspect(); }}>
          {relationshipsLoading && <p role="status">Bestätigte Beziehungen werden geladen…</p>}
          {relationshipsError && <p className="kf-routine-error" role="alert">{relationshipsError}</p>}
          <fieldset className="kf-routine-fields" disabled={running}>
            <label className="kf-routine-field"><span>Bestätigte Beziehung für den neuen Lauf</span><select className={selectCls} data-testid="routine-relationship" value={draft.relationshipId} disabled={relationshipsLoading} onChange={event => change({ relationshipId: event.target.value })}>
              <option value="">Beziehung auswählen…</option>{draft.relationshipId && !relationships.some(item => item.id === draft.relationshipId) && <option value={draft.relationshipId}>Gespeicherte Auswahl · {draft.relationshipId}</option>}
              {relationships.map(item => <option key={item.id} value={item.id}>{item.name} · Ausgang R{item.evidence.fromRevision} → Ziel R{item.evidence.toRevision}</option>)}
            </select></label>
            <label className="kf-routine-field"><span>Neuer Stichtag (Kalendertag)</span><input className={inputCls} type="date" min="1000-01-01" max="9999-12-31" data-testid="routine-as-of" value={draft.asOf} onChange={event => change({ asOf: event.target.value })} /></label>
          </fieldset>
          {!relationshipsLoading && !relationshipsError && relationships.length === 0 && <p>Noch keine bestätigten Beziehungen vorhanden. Lege zuerst eine passende Beziehung im Fachmodell an.</p>}
          <div><button className={ghostBtnCls} type="button" disabled={running || relationshipsLoading} onClick={() => setRelationshipsAttempt(value => value + 1)}>{relationshipsError ? 'Beziehungen erneut laden' : 'Beziehungsliste aktualisieren'}</button></div>
          {previewError && <p className="kf-routine-error" role="alert">{previewError}</p>}
          <div className="kf-routine-actions"><button className="kf-routine-primary" data-testid="routine-preview-button" type="submit" disabled={running || previewBusy || !draft.relationshipId || !draft.asOf}>{previewBusy ? 'Änderungen werden geprüft…' : 'Änderungen prüfen'}</button></div>
          <p className="kf-routine-muted">Die Vorschau liest die gespeicherten Datenstände und verwendet die bestätigten Regeln. Sie startet keinen Auftrag und benötigt keine erneute KI-Planung.</p>
        </form>
      </div></Card>
      {previewBusy && <p className="kf-routine-callout" role="status">Vollständige Stände werden verglichen…</p>}
      {preview && <Card title="Vergleich vor dem Start"><div className="kf-routine-stack">
        <h3 ref={previewHeading} tabIndex={-1}>Prüfe den neuen Stand</h3><RoutineComparison preview={preview} />
        {preview.ready && preview.previewHash && <div className="kf-routine-stack">
          <label className="kf-routine-check"><input type="checkbox" data-testid="routine-confirm" checked={confirmed} disabled={running} onChange={event => { setConfirmed(event.target.checked); setRunError(''); }} /><span>Ich bestätige die gespeicherten Bestellregeln für diesen neuen Stand und den Stichtag {preview.asOf}. Nicht zugeordnete Statuswerte bleiben ungeklärt.</span></label>
          <div className="kf-routine-actions"><button className="kf-routine-primary" data-testid="routine-run" type="button" disabled={!confirmed || running} onClick={() => void run()}>{running ? 'Auftrag wird gespeichert…' : 'Routine für diesen Stand starten'}</button></div>
          <p className="kf-routine-muted">Der gespeicherte Plan wird wiederverwendet. Der neue Auftrag bleibt mit seinem Ergebnis unter „Aufträge“ auffindbar.</p>
        </div>}
      </div></Card>}
      {runError && <p className="kf-routine-error kf-routine-callout" role="alert">{runError}</p>}
      </div></div>
    </>}
  </div>;
}

export function RoutineWorkspace({ storageScope, routineId }: { storageScope: string; routineId: string }) {
  const [items, setItems] = useState<RoutineDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    void fetchRoutines(controller.signal).then(values => { if (!controller.signal.aborted) setItems(values); })
      .catch(reason => { if (!controller.signal.aborted) setError(message(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt]);
  return <div className="kf-routines">
    <div className="kf-routine-toolbar"><p>Routinen verwenden bestätigte Regeln für weitere Datenstände. Jeden Lauf startest du nach dem Vergleich selbst.</p><a href="#/missions">Zu den Aufträgen</a></div>
    <div className="kf-routine-layout">
      <aside aria-label="Gespeicherte Routinen"><Card title="Routinen" action={<button className={ghostBtnCls} type="button" onClick={() => setAttempt(value => value + 1)}>Aktualisieren</button>}>
        {loading && <p role="status">Routinen werden geladen…</p>}
        {error && <div className="kf-routine-stack"><p className="kf-routine-error" role="alert">{error}</p><button type="button" className={ghostBtnCls} onClick={() => setAttempt(value => value + 1)}>Routinen erneut laden</button></div>}
        {!loading && !error && items.length === 0 && <p>Noch keine gespeicherten Routinen. Öffne eine abgeschlossene Bestellprüfung und wähle „Als Routine speichern“.</p>}
        <ul className="kf-routine-list" data-testid="routine-list">{items.map(item => <li key={item.id}><a href={`#/missions?routine=${encodeURIComponent(item.id)}`} aria-current={item.id === routineId ? 'page' : undefined}><strong>{item.name}</strong><small>Gespeichert am {date(item.createdAt)}</small></a></li>)}</ul>
      </Card></aside>
      {routineId ? <RoutineDetail key={`${storageScope}:${routineId}`} id={routineId} storageScope={storageScope} />
        : <Card title="Bestellregeln wiederverwenden"><div className="kf-routine-stack"><p>Wähle eine gespeicherte Routine. Du siehst ihre bestätigten Regeln und den Ausgangsauftrag, bevor du einen neuen Stand prüfst.</p><p>Eine Routine entsteht aus einer abgeschlossenen Bestellprüfung. Ihre Regeln bleiben gespeichert; für einen neuen Lauf wählst du eine passende Beziehung und einen Stichtag.</p><a href="#/missions">Aufträge öffnen</a></div></Card>}
    </div>
  </div>;
}
