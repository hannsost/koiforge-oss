import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Card, ghostBtnCls, inputCls, selectCls } from '../components/ui';
import { clearMissionRequest, missionRequestId, type MissionResult } from '../mission-api';
import { CaseApiError, createCase, fetchCase, fetchCaseFindings, fetchCases, previewCase, transitionCase,
  type CaseAction, type CaseEvidence, type CaseFindings, type CasePreview, type CaseRecord, type CaseStatus } from '../case-api';
import '../cases.css';

const statusLabels: Record<CaseStatus, string> = { open: 'Offen', in_progress: 'In Bearbeitung', resolved: 'Abgeschlossen' };
const eventLabels: Record<CaseRecord['events'][number]['kind'], string> = { created: 'Fall angelegt', claimed: 'Selbst übernommen', resolved: 'Als bearbeitet dokumentiert', reopened: 'Wieder geöffnet' };
const number = (value: number) => value.toLocaleString('de-DE');
const date = (value: string) => new Date(value).toLocaleString('de-DE');
const errorText = (reason: unknown) => reason instanceof Error ? reason.message : 'Die Anfrage ist fehlgeschlagen.';
const cell = (row: MissionResult['rows'][number], key: string) => Object.hasOwn(row, key) ? row[key] ?? null : null;
const settledFailure = (reason: unknown) => reason instanceof CaseApiError && reason.status >= 400 && reason.status < 500 && reason.status !== 408 && reason.status !== 429;
const lostResponse = 'Die Antwort ist ausgeblieben. Der Vorgang kann bereits gespeichert sein. Erneutes Senden mit denselben Angaben verwendet dieselbe Anfrage-ID.';
const statusOrder: Record<CaseStatus, number> = { open: 0, in_progress: 1, resolved: 2 };
function matchesSearch(item: CaseRecord, query: string): boolean {
  const text = [item.title, item.evidence.question, item.evidence.source.name, item.evidence.targetSource.name,
    ...['Bestellung', 'Bestellungs-ID', 'Lieferant', 'Lieferantenreferenz', 'Lieferantenbeziehung', 'Befund', 'Klärungsgrund',
      'Originalstatus', 'Terminbeurteilung', 'Liefertermin'].map(key => cell(item.evidence.finding, key))]
    .filter(value => value !== null).join(' ').toLocaleLowerCase('de-DE');
  return query.trim().toLocaleLowerCase('de-DE').split(/\s+/).every(word => text.includes(word));
}
function saveDraft(key: string, value: unknown) {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* Draft storage is optional. */ }
}
function readText(key: string): string {
  try { const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null'); return typeof value === 'string' ? value : ''; } catch { return ''; }
}
function Status({ value }: { value: CaseStatus }) {
  return <Badge tone={value === 'resolved' ? 'success' : value === 'in_progress' ? 'warning' : 'neutral'}>{statusLabels[value]}</Badge>;
}
function FindingValue({ name, value }: { name: string; value: string | number | boolean | null }) {
  if (name === 'Originalstatus') return <><code className="kf-case-literal">{JSON.stringify(value)}</code><small className="kf-case-muted">{value === null ? 'Kein Wert (null)' : typeof value === 'string' ? 'Text' : typeof value === 'number' ? 'Zahl' : 'Ja/Nein'}</small></>;
  return <>{value === null ? 'Nicht vorhanden' : typeof value === 'boolean' ? value ? 'Ja' : 'Nein' : String(value)}</>;
}
function Evidence({ value, evidenceHash }: { value: CaseEvidence; evidenceHash: string }) {
  const relationship = value.relationship;
  return <div className="kf-case-stack" data-testid="case-evidence">
    <dl className="kf-case-facts">{['Befund', 'Klärungsgrund', 'Bestellung', 'Bestellungs-ID', 'Originalstatus', 'Liefertermin', 'Terminbeurteilung', 'Lieferantenreferenz', 'Lieferantenbeziehung', 'Lieferant'].map(name => <div key={name}><dt>{name}</dt><dd><FindingValue name={name} value={cell(value.finding, name)} /></dd></div>)}</dl>
    <p className="kf-case-muted">Originale Quellzeile {number(value.sourceRow)} aus „{value.source.name}“. Die Zeilennummer bezeichnet den gespeicherten Datensatz, keine zusätzliche Objekt-ID.</p>
    <p><a href={`#/missions?id=${encodeURIComponent(value.missionId)}`}>Ausgangsauftrag öffnen</a> · {value.question}</p>
    <details className="kf-case-details"><summary>Gespeicherte Regeln und Quellenbelege</summary><div className="kf-case-stack">
      <dl className="kf-case-facts">
        <div><dt>Bestellungen</dt><dd>{value.source.name} · Revision {relationship.fromRevision} · {number(value.source.rowCount)} Quellzeilen</dd></div>
        <div><dt>Lieferanten</dt><dd>{value.targetSource.name} · Revision {relationship.toRevision} · {number(value.targetSource.rowCount)} Quellzeilen</dd></div>
        <div><dt>Bestätigte Beziehung</dt><dd><a href={`#/model?relationship=${encodeURIComponent(relationship.id)}`}>{relationship.name}</a> · {relationship.fromField} → {relationship.toField}</dd></div>
        <div><dt>Stichtag (Kalendertag)</dt><dd>{value.orderRule.asOf}</dd></div>
        <div><dt>Statusspalte</dt><dd>{value.binding.statusField}</dd></div>
        <div><dt>Bestätigte Bestellungs-ID</dt><dd>{value.orderKeyField}</dd></div>
        <div><dt>Fähigkeitsversion</dt><dd>{value.capabilityVersion}</dd></div>
        <div><dt>Terminbedeutung</dt><dd>{value.orderRule.dueDateMeaning === 'promised_delivery_day' ? `Zugesagter Lieferkalendertag · ${value.binding.dueDateField}` : 'Kein Liefertermin verfügbar'}</dd></div>
        <div><dt>Offene Statuswerte · Text</dt><dd>{value.orderRule.openStatuses.length ? value.orderRule.openStatuses.map(item => <code className="kf-case-literal" key={item}>{JSON.stringify(item)}</code>) : 'Keine als offen eingeordnet'}</dd></div>
        <div><dt>Abgeschlossene Statuswerte · Text</dt><dd>{value.orderRule.closedStatuses.length ? value.orderRule.closedStatuses.map(item => <code className="kf-case-literal" key={item}>{JSON.stringify(item)}</code>) : 'Keine als abgeschlossen eingeordnet'}</dd></div>
        <div><dt>Ausgeführt am</dt><dd>{date(value.executedAt)}</dd></div>
        <div><dt>Beleg-Hash dieses Falls</dt><dd><code>{evidenceHash}</code></dd></div>
        <div><dt>Quellen-Hash der Bestellungen</dt><dd><code>{value.source.hash}</code></dd></div>
        <div><dt>Quellen-Hash der Lieferanten</dt><dd><code>{value.targetSource.hash}</code></dd></div>
        <div><dt>Modellstand-Hash der Bestellungen</dt><dd><code>{relationship.fromSnapshotHash}</code></dd></div>
        <div><dt>Modellstand-Hash der Lieferanten</dt><dd><code>{relationship.toSnapshotHash}</code></dd></div>
        <div><dt>Regelhash</dt><dd><code>{value.orderRuleHash}</code></dd></div>
      </dl>
    </div></details>
  </div>;
}

interface FindingsDraft { offset: number; selectedRow: number | null }
function readFindingsDraft(key: string): FindingsDraft {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    return { offset: Number.isSafeInteger(value?.offset) && value.offset >= 0 ? value.offset : 0,
      selectedRow: Number.isSafeInteger(value?.selectedRow) && value.selectedRow > 0 ? value.selectedRow : null };
  } catch { return { offset: 0, selectedRow: null }; }
}
function FindingsWorkspace({ missionId, storageScope, onCase }: { missionId: string; storageScope: string; onCase: (value: CaseRecord) => void }) {
  const prefix = `koiforge:cases:${storageScope}:`;
  const draftKey = `${prefix}findings:${missionId}`;
  const [draft, setDraft] = useState(() => readFindingsDraft(draftKey));
  const [page, setPage] = useState<CaseFindings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [preview, setPreview] = useState<CasePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(Boolean(draft.selectedRow));
  const [previewError, setPreviewError] = useState('');
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const request = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const shownPage = page?.offset === draft.offset ? page : null;
  const shownPreview = preview?.evidence.sourceRow === draft.selectedRow ? preview : null;
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(''); setPage(null);
    void fetchCaseFindings(missionId, draft.offset, 25, controller.signal).then(value => { if (!controller.signal.aborted) setPage(value); })
      .catch(reason => { if (!controller.signal.aborted) setError(errorText(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [missionId, draft.offset, attempt]);
  useEffect(() => {
    const controller = new AbortController(); setPreview(null); setPreviewError('');
    if (draft.selectedRow === null) { setPreviewLoading(false); return; }
    setPreviewLoading(true);
    void previewCase({ missionId, sourceRow: draft.selectedRow }, controller.signal).then(value => { if (!controller.signal.aborted) setPreview(value); })
      .catch(reason => { if (!controller.signal.aborted) setPreviewError(errorText(reason)); })
      .finally(() => { if (!controller.signal.aborted) setPreviewLoading(false); });
    return () => controller.abort();
  }, [missionId, draft.selectedRow, previewAttempt]);
  useEffect(() => { if (shownPreview) previewHeading.current?.focus({ preventScroll: true }); }, [shownPreview]);
  useEffect(() => () => { epoch.current++; request.current?.abort(); }, []);
  const change = (value: FindingsDraft) => {
    epoch.current++; setDraft(value); saveDraft(draftKey, value); setPreview(null); setSaveError('');
  };
  const create = async () => {
    if (request.current || !shownPreview || shownPreview.existingCaseId || draft.selectedRow === null) return;
    const payload = { missionId, sourceRow: draft.selectedRow, previewHash: shownPreview.previewHash, confirmed: true as const };
    const requestKey = `${prefix}create:${missionId}:${draft.selectedRow}`;
    const requestId = missionRequestId(requestKey, payload);
    const controller = new AbortController(); request.current = controller; const generation = epoch.current;
    setBusy(true); setSaveError('');
    try {
      const value = await createCase({ ...payload, requestId }, controller.signal);
      clearMissionRequest(requestKey);
      if (controller.signal.aborted || epoch.current !== generation) return;
      onCase(value); window.location.hash = `/missions?case=${encodeURIComponent(value.id)}`;
    } catch (reason) {
      if (controller.signal.aborted || epoch.current !== generation) return;
      if (settledFailure(reason)) clearMissionRequest(requestKey);
      setSaveError(settledFailure(reason) ? errorText(reason) : lostResponse);
      if (reason instanceof CaseApiError && reason.status === 409) setPreviewAttempt(value => value + 1);
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return <div className="kf-case-stack">
    <Card title="Befunde bearbeiten"><div className="kf-case-stack" data-testid="case-findings">
      <p>Überfällige Bestellungen und Befunde mit Klärungsgrund aus dem <a href={`#/missions?id=${encodeURIComponent(missionId)}`}>gespeicherten Auftrag</a>. Die Seiten umfassen alle relevanten Quellzeilen, auch außerhalb der Ergebnisvorschau.</p>
      {loading && <p role="status">Befunde werden geladen…</p>}
      {error && <div className="kf-case-stack"><p className="kf-case-error" role="alert">{error}</p><div><button className={ghostBtnCls} type="button" data-testid="case-findings-retry" onClick={() => setAttempt(value => value + 1)}>Befunde erneut laden</button></div></div>}
      {shownPage && !loading && !error && <>
        <p>{number(shownPage.totalRows)} relevante Befunde insgesamt. Quellzeilennummern behalten ihre ursprüngliche Position.</p>
        {shownPage.totalRows === 0 && <p>In diesem Auftrag gibt es keine überfälligen Bestellungen und keine Befunde mit Klärungsgrund.</p>}
        <ul className="kf-case-findings">{shownPage.items.map((row, index) => {
          const sourceRow = cell(row, 'Quellzeile'); const validRow = typeof sourceRow === 'number' && Number.isSafeInteger(sourceRow) && sourceRow > 0;
          return <li key={index} aria-current={sourceRow === draft.selectedRow ? 'true' : undefined}>
            <h3>{String(cell(row, 'Befund') ?? 'Befund')}</h3><p>{String(cell(row, 'Klärungsgrund') ?? 'Kein zusätzlicher Klärungsgrund dokumentiert.')}</p>
            <p className="kf-case-muted">{String(cell(row, 'Bestellung') ?? 'Bestellung')} · Quellzeile {String(sourceRow ?? 'unbekannt')}</p>
            <button className={ghostBtnCls} type="button" data-testid="case-preview-finding" data-source-row={sourceRow ?? undefined} disabled={busy || !validRow} aria-label={`Befund aus Quellzeile ${sourceRow} ansehen`} onClick={() => { if (validRow) { change({ ...draft, selectedRow: sourceRow }); setPreviewAttempt(value => value + 1); } }}>Befund ansehen</button>
          </li>;
        })}</ul>
        <nav className="kf-case-pagination" aria-label="Befundseiten"><button className={ghostBtnCls} type="button" data-testid="case-findings-previous" disabled={busy || shownPage.offset === 0} onClick={() => change({ offset: Math.max(0, draft.offset - 25), selectedRow: null })}>Vorherige Seite</button><span>{shownPage.totalRows ? `Befunde ${number(shownPage.offset + 1)}–${number(shownPage.offset + shownPage.items.length)} von ${number(shownPage.totalRows)}` : 'Keine Befunde'}</span><button className={ghostBtnCls} type="button" data-testid="case-findings-next" disabled={busy || shownPage.offset + shownPage.items.length >= shownPage.totalRows} onClick={() => change({ offset: draft.offset + 25, selectedRow: null })}>Nächste Seite</button></nav>
      </>}
    </div></Card>
    {previewLoading && <p className="kf-case-callout" role="status">Fallvorschau wird aus den gespeicherten Belegen geladen…</p>}
    {previewError && <div className="kf-case-callout kf-case-stack"><p className="kf-case-error" role="alert">{previewError}</p><div><button className={ghostBtnCls} type="button" data-testid="case-preview-retry" onClick={() => setPreviewAttempt(value => value + 1)}>Vorschau erneut laden</button></div></div>}
    {shownPreview && !previewLoading && !previewError && <Card title="Klärungsfall vorbereiten"><div className="kf-case-stack" data-testid="case-preview">
      <h3 className="kf-case-name" ref={previewHeading} tabIndex={-1}>{shownPreview.title}</h3><Evidence value={shownPreview.evidence} evidenceHash={shownPreview.evidenceHash} />
      <p>Der Fall hält diesen Befund und seine Belege fest. Die spätere Bearbeitung dokumentiert deinen Arbeitsstand; der gespeicherte Quellenbefund bleibt unverändert.</p>
      {shownPreview.existingCaseId ? <p>Für diesen Befund besteht bereits ein Fall. <a data-testid="case-existing" href={`#/missions?case=${encodeURIComponent(shownPreview.existingCaseId)}`}>Vorhandenen Fall öffnen</a></p>
        : <div className="kf-case-actions"><button className="kf-case-primary" type="button" data-testid="case-create" disabled={busy} onClick={() => void create()}>{busy ? 'Fall wird gespeichert…' : 'Klärungsfall anlegen'}</button></div>}
      {saveError && <p className="kf-case-error" role="alert">{saveError}</p>}
    </div></Card>}
  </div>;
}

function CaseDetail({ id, storageScope, onCase }: { id: string; storageScope: string; onCase: (value: CaseRecord) => void }) {
  const prefix = `koiforge:cases:${storageScope}:`;
  const draftKey = `${prefix}note:${id}`;
  const [value, setValue] = useState<CaseRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [note, setNote] = useState(() => readText(draftKey));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const request = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const firstFocus = useRef(false);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setLoadError('');
    void fetchCase(id, controller.signal).then(next => { if (!controller.signal.aborted) { setValue(next); onCase(next); } })
      .catch(reason => { if (!controller.signal.aborted) setLoadError(errorText(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, attempt, onCase]);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => { if (value && !firstFocus.current) { heading.current?.focus({ preventScroll: true }); firstFocus.current = true; } }, [value]);
  const transition = async (action: CaseAction) => {
    if (!value || loading || request.current || loadError) return;
    if (action !== 'claim' && (!note.trim() || note.trim().length > 2000)) { setError('Bitte eine aussagekräftige Notiz mit 1 bis 2.000 Zeichen angeben.'); return; }
    const payload = { revision: value.revision, action, ...(action === 'claim' ? {} : { note: note.trim() }), confirmed: true as const };
    const requestKey = `${prefix}transition:${id}:${action}`;
    const requestId = missionRequestId(requestKey, payload);
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(''); setNotice('');
    try {
      const next = await transitionCase(id, { ...payload, requestId }, controller.signal);
      clearMissionRequest(requestKey);
      if (controller.signal.aborted) return;
      setValue(next); onCase(next);
      if (action !== 'claim') { setNote(''); saveDraft(draftKey, ''); }
      setNotice(action === 'resolve' ? 'Als bearbeitet dokumentiert; der gespeicherte Quellenbefund bleibt unverändert.' : action === 'reopen' ? 'Fall wieder geöffnet. Die vorherige Bearbeitung bleibt im Verlauf sichtbar.' : 'Fall übernommen. Die Zuordnung verwendet deine angemeldete Person.');
    } catch (reason) {
      if (controller.signal.aborted) return;
      if (settledFailure(reason)) clearMissionRequest(requestKey);
      if (reason instanceof CaseApiError && reason.status === 409) {
        setError('Der Fall wurde inzwischen geändert. Der aktuelle Stand wird geladen; deine Notiz bleibt erhalten. Prüfe den neuen Stand und bestätige die gewünschte Aktion erneut.');
        setLoading(true); setAttempt(current => current + 1);
      } else setError(settledFailure(reason) ? errorText(reason) : lostResponse);
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return <div className="kf-case-stack" data-testid="case-detail">
    {loading && <p className="kf-case-callout" role="status">Fall wird geladen…</p>}
    {loadError && <div className="kf-case-callout kf-case-stack"><p className="kf-case-error" role="alert">{loadError}</p><div><button className={ghostBtnCls} type="button" data-testid="case-detail-retry" onClick={() => setAttempt(current => current + 1)}>Fall erneut laden</button></div></div>}
    {value && <>
      <Card title="Klärungsfall" action={<span data-testid="case-status"><Status value={value.status} /></span>}><div className="kf-case-stack">
        <h3 className="kf-case-name" ref={heading} tabIndex={-1}>{value.title}</h3>
        <dl className="kf-case-facts"><div><dt>Bearbeitung</dt><dd>{value.assignee ? value.assignee.displayName : 'Noch nicht übernommen'}</dd></div><div><dt>Zuletzt aktualisiert</dt><dd>{date(value.updatedAt)} · Revision {value.revision}</dd></div></dl>
        {value.resolution && <div className="kf-case-callout"><h3>Dokumentierter Abschluss</h3><p className="kf-case-note">{value.resolution}</p></div>}
        <p className="kf-case-muted">Der Fall dokumentiert die Bearbeitung. Auch bei einem Abschluss bleibt der gespeicherte Quellenbefund unverändert.</p>
        {notice && <p className="kf-case-callout" role="status">{notice}</p>}
        {error && <p className="kf-case-error" role="alert">{error}</p>}
        {value.status === 'open' ? <div className="kf-case-actions"><button className="kf-case-primary" type="button" data-testid="case-claim" disabled={busy || loading || Boolean(loadError)} onClick={() => void transition('claim')}>Selbst übernehmen</button></div>
          : <form className="kf-case-stack" aria-label={value.status === 'resolved' ? 'Fall wieder öffnen' : 'Bearbeitung dokumentieren'} onSubmit={event => { event.preventDefault(); void transition(value.status === 'resolved' ? 'reopen' : 'resolve'); }}>
            <label className="kf-case-field"><span>{value.status === 'resolved' ? 'Grund für das Wiederöffnen' : 'Notiz zum Abschluss'}</span><textarea className={inputCls} data-testid="case-note" rows={4} maxLength={2000} value={note} disabled={busy || loading || Boolean(loadError)} onChange={event => { setNote(event.target.value); saveDraft(draftKey, event.target.value); clearMissionRequest(`${prefix}transition:${id}:resolve`); clearMissionRequest(`${prefix}transition:${id}:reopen`); setError(''); }} /></label>
            <p className="kf-case-muted">Pflichtangabe · höchstens 2.000 Zeichen. Mit dem folgenden Klick wird die Bearbeitung dokumentiert.</p>
            <div className="kf-case-actions"><button className="kf-case-primary" type="submit" data-testid={value.status === 'resolved' ? 'case-reopen' : 'case-resolve'} disabled={busy || loading || Boolean(loadError) || !note.trim()}>{busy ? 'Änderung wird gespeichert…' : value.status === 'resolved' ? 'Wieder öffnen' : 'Als bearbeitet dokumentieren'}</button></div>
          </form>}
      </div></Card>
      <Card title="Gespeicherter Quellenbefund"><Evidence value={value.evidence} evidenceHash={value.evidenceHash} /></Card>
      <Card title="Bearbeitungsverlauf"><ol className="kf-case-events" data-testid="case-events">{value.events.map((event, index) => <li key={`${event.at}:${index}`}><time dateTime={event.at}>{date(event.at)}</time><strong>{Object.hasOwn(eventLabels, event.kind) ? eventLabels[event.kind] : event.kind} · {event.actorName}</strong>{event.note && <p className="kf-case-note">{event.note}</p>}</li>)}</ol></Card>
    </>}
  </div>;
}

export function CaseWorkspace({ storageScope, caseId, missionId }: { storageScope: string; caseId: string; missionId: string }) {
  const filterKey = `koiforge:cases:${storageScope}:filter`;
  const searchKey = `koiforge:cases:${storageScope}:search`;
  const sortKey = `koiforge:cases:${storageScope}:sort`;
  const [items, setItems] = useState<CaseRecord[]>([]);
  const [filter, setFilter] = useState(() => { const saved = readText(filterKey); return ['open', 'in_progress', 'resolved'].includes(saved) ? saved : ''; });
  const [search, setSearch] = useState(() => readText(searchKey).slice(0, 200));
  const [sort, setSort] = useState(() => readText(sortKey) === 'updated' ? 'updated' : 'work');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const remember = useCallback((value: CaseRecord) => setItems(current => {
    const old = current.find(item => item.id === value.id);
    if (old && old.revision > value.revision) return current;
    return [value, ...current.filter(item => item.id !== value.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }), []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    void fetchCases(controller.signal).then(values => { if (!controller.signal.aborted) setItems(current => {
      const result = new Map(current.map(item => [item.id, item]));
      for (const value of values) if (!result.has(value.id) || result.get(value.id)!.revision <= value.revision) result.set(value.id, value);
      return [...result.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }); })
      .catch(reason => { if (!controller.signal.aborted) setError(errorText(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt]);
  const visible = items.filter(item => (!filter || item.status === filter) && matchesSearch(item, search))
    .sort((a, b) => (sort === 'work' ? statusOrder[a.status] - statusOrder[b.status] : 0)
      || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const overview = !caseId && !missionId;
  const ready = !loading && !error;
  const changeFilter = (value: string) => { setFilter(value); saveDraft(filterKey, value); };
  const resetSelection = () => { changeFilter(''); setSearch(''); saveDraft(searchKey, ''); };
  return <div className="kf-cases">
    <div className="kf-case-toolbar"><div><h2 className="kf-case-name">Deine Klärungsfälle</h2><p>Finde offene Arbeit und prüfe den gespeicherten Befund, bevor du einen Fall übernimmst.</p></div><div className="kf-case-actions">{!overview && <a href="#/missions?view=cases">Fallübersicht</a>}<a href="#/missions">Zu den Aufträgen</a></div></div>
    {ready && <div className="kf-case-counts" role="group" aria-label="Alle eigenen Fälle nach Bearbeitungsstatus">{(['', 'open', 'in_progress', 'resolved'] as const).map(status => <button key={status} type="button" data-testid={`case-count-${status || 'all'}`} aria-pressed={filter === status} onClick={() => changeFilter(status)}><strong>{number(status ? items.filter(item => item.status === status).length : items.length)}</strong><span>{status ? statusLabels[status] : 'Alle Fälle'}</span></button>)}</div>}
    <div className={`kf-case-layout${overview ? ' kf-case-overview' : ''}`}>
      <aside aria-label="Eigene Klärungsfälle"><Card title={overview ? 'Arbeitsübersicht' : 'Klärungsfälle'} action={<button className={ghostBtnCls} type="button" disabled={loading} onClick={() => setAttempt(value => value + 1)}>Aktualisieren</button>}><div className="kf-case-stack">
        <div className="kf-case-controls">
          <label className="kf-case-field kf-case-search"><span>Fälle durchsuchen</span><input className={inputCls} type="search" data-testid="case-search" placeholder="Bestellung, Lieferant, Quelle oder Befund" maxLength={200} value={search} onChange={event => { setSearch(event.target.value); saveDraft(searchKey, event.target.value); }} /></label>
          <label className="kf-case-field"><span>Bearbeitungsstatus filtern</span><select className={selectCls} data-testid="case-status-filter" value={filter} onChange={event => changeFilter(event.target.value)}><option value="">Alle Fälle</option><option value="open">Offen</option><option value="in_progress">In Bearbeitung</option><option value="resolved">Abgeschlossen</option></select></label>
          <label className="kf-case-field"><span>Reihenfolge</span><select className={selectCls} data-testid="case-sort" value={sort} onChange={event => { setSort(event.target.value); saveDraft(sortKey, event.target.value); }}><option value="work">Offene zuerst</option><option value="updated">Zuletzt aktualisiert</option></select></label>
        </div>
        {ready && <div className="kf-case-stack">
          <div className="kf-case-actions"><p className="kf-case-muted" data-testid="case-selection-count" role="status">{number(visible.length)} von {number(items.length)} Fällen in deiner Auswahl</p>{(filter || search) && <button className={ghostBtnCls} type="button" onClick={resetSelection}>Auswahl zurücksetzen</button>}</div>
          <p className="kf-case-muted">{sort === 'work' ? 'Offene Fälle stehen vor übernommenen und abgeschlossenen Fällen; innerhalb eines Status zuletzt aktualisierte zuerst.' : 'Zuletzt aktualisierte Fälle stehen zuerst, unabhängig vom Bearbeitungsstatus.'} Befunde beziehen sich auf den gespeicherten Stichtag.</p>
          {caseId && items.some(item => item.id === caseId) && !visible.some(item => item.id === caseId) && <p className="kf-case-callout" data-testid="case-outside-selection">Der geöffnete Fall liegt außerhalb deiner Auswahl. Seine Bearbeitung bleibt geöffnet.</p>}
        </div>}
        {loading && <p role="status">Klärungsfälle werden geladen…</p>}
        {error && <><p className="kf-case-error" role="alert">{error}</p><button className={ghostBtnCls} type="button" data-testid="case-list-retry" onClick={() => setAttempt(value => value + 1)}>Fälle erneut laden</button></>}
        {ready && visible.length === 0 && <div className="kf-case-callout"><p>{items.length ? 'Keine Fälle passen zu deiner Suche und dem gewählten Bearbeitungsstatus.' : 'Noch keine Klärungsfälle. Öffne eine abgeschlossene Bestellprüfung und wähle „Befunde bearbeiten“.'}</p>{items.length === 0 && <p><a href="#/missions">Aufträge öffnen</a></p>}</div>}
        <ul className="kf-case-list" data-testid="case-list">{ready && visible.map(item => <li key={item.id}><a href={`#/missions?case=${encodeURIComponent(item.id)}`} aria-current={item.id === caseId ? 'page' : undefined}>
          <div className="kf-case-card-heading"><strong>{item.title}</strong><Status value={item.status} /></div>
          <p>{String(cell(item.evidence.finding, 'Befund'))}{cell(item.evidence.finding, 'Klärungsgrund') ? ` · ${String(cell(item.evidence.finding, 'Klärungsgrund'))}` : ''}</p>
          <small>Bestellungs-ID: <code>{String(cell(item.evidence.finding, 'Bestellungs-ID') ?? 'Nicht vorhanden')}</code></small>
          <small>Lieferant: {String(cell(item.evidence.finding, 'Lieferant') ?? 'Kein Lieferantenname im Beleg')} · {String(cell(item.evidence.finding, 'Lieferantenbeziehung'))}</small>
          <small>{item.evidence.source.name} · Quellzeile {number(item.evidence.sourceRow)} · Stichtag {item.evidence.orderRule.asOf}</small>
          <small>{item.assignee?.displayName ?? 'Noch nicht übernommen'} · Aktualisiert {date(item.updatedAt)}</small>
        </a></li>)}</ul>
      </div></Card></aside>
      {caseId ? <CaseDetail key={`${storageScope}:${caseId}`} id={caseId} storageScope={storageScope} onCase={remember} />
        : missionId ? <FindingsWorkspace key={`${storageScope}:${missionId}`} missionId={missionId} storageScope={storageScope} onCase={remember} />
          : null}
    </div>
  </div>;
}
