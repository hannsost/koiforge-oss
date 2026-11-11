import { useEffect, useRef, useState, type FormEvent } from 'react';
import { fetchDatasets, type DatasetRecord } from '../api';
import { ImportWorkspaceDialog } from '../components/ImportWorkspaceDialog';
import { Badge, Card, ghostBtnCls, inputCls, selectCls } from '../components/ui';
import { clearMissionRequest, missionRequestId } from '../mission-api';
import {
  createObjectSet, createRelationship, fetchObjectSet, fetchObjectSets, fetchRelationship, fetchRelationships,
  relationshipStatusLabels, SemanticModelApiError,
  type ObjectSet, type ObjectSetDetail, type Relationship, type RelationshipDetail,
} from '../semantic-model-api';
import '../semantic-model.css';

type ModelRoute = { kind: 'sets' | 'relationships'; id: string };
const EMPTY_SET = { name: '', datasetId: '', keyField: '', labelField: '', previousId: '', previousRevision: '' };
const EMPTY_RELATIONSHIP = { name: '', fromSetId: '', toSetId: '', fromField: '' };
const PAGE_SIZE = 50;
const countLabels: Record<string, string> = {
  totalRows: 'Quellzeilen', identifiedRows: 'Eindeutig identifizierte Zeilen', missingKeys: 'Zeilen ohne ID',
  duplicateRows: 'Zeilen mit doppelter ID', duplicateGroups: 'Doppelte ID-Gruppen', sourceRows: 'Geprüfte Quellzeilen',
  linkedRows: 'Eindeutig zugeordnet', missingReferences: 'Referenz fehlt', unmatchedReferences: 'Kein Ziel gefunden',
  ambiguousReferences: 'Ziel ist mehrdeutig', invalidSourceRows: 'Quell-ID fehlt oder ist doppelt',
};
const identityLabels = { unique: 'Eindeutige ID', missing: 'ID fehlt', duplicate: 'ID ist doppelt' };
const number = (value: number) => value.toLocaleString('de-DE');
const date = (value: string) => new Date(value).toLocaleString('de-DE');
const label = (labels: Record<string, string>, key: string) => Object.hasOwn(labels, key) ? labels[key] : key;
const cell = (value: unknown) => value == null ? 'Nicht vorhanden' : String(value);
function IdentityValue({ value }: { value: unknown }) {
  return <span className="kf-semantic-identity-value">{cell(value)}{value != null && <small>{typeof value === 'string' ? 'Text' : typeof value === 'number' ? 'Zahl' : 'Ja/Nein'}</small>}</span>;
}
function routeFromLocation(): ModelRoute {
  const query = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  if (query.has('relationship')) return { kind: 'relationships', id: query.get('relationship') ?? '' };
  return { kind: query.get('kind') === 'relationships' ? 'relationships' : 'sets', id: query.get('set') ?? '' };
}
function loadDraft<T extends Record<string, string>>(key: string, initial: T): T {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (!saved || typeof saved !== 'object') return initial;
    return { ...initial, ...Object.fromEntries(Object.keys(initial).filter(key => Object.hasOwn(saved, key) && typeof saved[key] === 'string').map(key => [key, saved[key]])) };
  } catch { return initial; }
}
function Counts({ values }: { values: Record<string, number> }) {
  return <dl className="kf-semantic-counts">{Object.entries(values).map(([key, value]) => <div key={key}><dt>{label(countLabels, key)}</dt><dd>{number(value)}</dd></div>)}</dl>;
}
function Pagination({ offset, size, total, loading, onChange }: { offset: number; size: number; total: number; loading: boolean; onChange: (offset: number) => void }) {
  return <nav className="kf-semantic-pagination" aria-label="Ergebnisseiten">
    <button type="button" className={ghostBtnCls} data-testid="semantic-page-previous" disabled={loading || offset === 0} onClick={() => onChange(Math.max(0, offset - PAGE_SIZE))}>Vorherige Seite</button>
    <span role="status">{total === 0 ? 'Keine Zeilen' : `Zeilen ${number(offset + 1)}–${number(offset + size)} von ${number(total)}`}{loading ? ' · lädt…' : ''}</span>
    <button type="button" className={ghostBtnCls} data-testid="semantic-page-next" disabled={loading || offset + size >= total} onClick={() => onChange(offset + PAGE_SIZE)}>Nächste Seite</button>
  </nav>;
}
function ObjectSetEvidence({ objectSet }: { objectSet: ObjectSet }) {
  return <dl className="kf-semantic-facts">
    <div><dt>Quelle</dt><dd>{objectSet.source.name}</dd></div><div><dt>Festgehalten am</dt><dd>{date(objectSet.source.capturedAt)}</dd></div>
    <div><dt>Bestätigtes ID-Feld</dt><dd>{objectSet.keyField}</dd></div><div><dt>Anzeigename</dt><dd>{objectSet.labelField || 'ID verwenden'}</dd></div>
    <div><dt>Quellen-Hash</dt><dd><code>{objectSet.source.hash}</code></dd></div><div><dt>Objektmengen-ID</dt><dd><code>{objectSet.id}</code></dd></div>
    <div><dt>Modellstand-Hash</dt><dd><code>{objectSet.snapshotHash}</code></dd></div>
    <div><dt>Bestätigt von</dt><dd><code>{objectSet.confirmedBy}</code> · {date(objectSet.createdAt)}</dd></div>
    {objectSet.previousId && <div><dt>Vorherige Revision</dt><dd><a href={`#/model?set=${encodeURIComponent(objectSet.previousId)}`}>Revision {objectSet.revision - 1} öffnen</a></dd></div>}
  </dl>;
}

export function SemanticModelView({ storageScope }: { storageScope: string }) {
  const prefix = `koiforge:model:${storageScope}:`;
  const [route, setRoute] = useState(routeFromLocation);
  const routeRef = useRef(route);
  const epoch = useRef(0);
  const [objectDraft, setObjectDraft] = useState(() => loadDraft(`${prefix}object-draft`, EMPTY_SET));
  const [relationshipDraft, setRelationshipDraft] = useState(() => loadDraft(`${prefix}relationship-draft`, EMPTY_RELATIONSHIP));
  const [objectConfirmed, setObjectConfirmed] = useState(false);
  const [relationshipConfirmed, setRelationshipConfirmed] = useState(false);
  const [datasets, setDatasets] = useState<DatasetRecord[]>([]);
  const [sets, setSets] = useState<ObjectSet[]>([]);
  const [relationships, setRelationships] = useState<Relationship[]>([]);
  const [sourceLoading, setSourceLoading] = useState(true);
  const [setsLoading, setSetsLoading] = useState(true);
  const [relationshipsLoading, setRelationshipsLoading] = useState(true);
  const [sourceError, setSourceError] = useState('');
  const [setsError, setSetsError] = useState('');
  const [relationshipsError, setRelationshipsError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [offset, setOffset] = useState(0);
  const [objectDetail, setObjectDetail] = useState<ObjectSetDetail | null>(null);
  const [relationshipDetail, setRelationshipDetail] = useState<RelationshipDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [detailAttempt, setDetailAttempt] = useState(0);
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const mutation = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const lastFocusedId = useRef('');
  const selectedDataset = datasets.find(item => item.id === objectDraft.datasetId);
  const objectColumns = selectedDataset?.schema.map(field => field.name) ?? [];
  const fromSet = sets.find(item => item.id === relationshipDraft.fromSetId);
  const toSet = sets.find(item => item.id === relationshipDraft.toSetId);

  const navigate = (kind: ModelRoute['kind'], id = '') => {
    const next = { kind, id };
    epoch.current++; routeRef.current = next; setRoute(next); setOffset(0); setSaveError('');
    window.location.hash = id ? `/model?${kind === 'sets' ? 'set' : 'relationship'}=${encodeURIComponent(id)}` : kind === 'sets' ? '/model' : '/model?kind=relationships';
  };
  useEffect(() => {
    const sync = () => {
      if (!window.location.hash.startsWith('#/model')) return;
      const next = routeFromLocation();
      if (next.kind !== routeRef.current.kind || next.id !== routeRef.current.id) {
        epoch.current++; routeRef.current = next; setRoute(next); setOffset(0); setSaveError('');
      }
    };
    window.addEventListener('hashchange', sync);
    return () => { window.removeEventListener('hashchange', sync); mutation.current?.abort(); };
  }, []);
  useEffect(() => {
    try {
      sessionStorage.setItem(`${prefix}object-draft`, JSON.stringify(objectDraft));
      sessionStorage.setItem(`${prefix}relationship-draft`, JSON.stringify(relationshipDraft));
    } catch { /* Draft storage is optional; saved models remain on the server. */ }
  }, [prefix, objectDraft, relationshipDraft]);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setSourceLoading(true); setSetsLoading(true); setRelationshipsLoading(true);
    setSourceError(''); setSetsError(''); setRelationshipsError('');
    void fetchDatasets().then(items => { if (active) setDatasets(items.filter(item => item.connectorId === 'inline')); })
      .catch(() => { if (active) setSourceError('Datenquellen konnten nicht geladen werden. Gespeicherte Fachmodelle bleiben separat verfügbar.'); })
      .finally(() => { if (active) setSourceLoading(false); });
    void fetchObjectSets(controller.signal).then(items => {
      if (active) setSets(current => [...new Map([...current, ...items].map(item => [item.id, item])).values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    }).catch(() => { if (active) setSetsError('Objektmengen konnten nicht geladen werden.'); }).finally(() => { if (active) setSetsLoading(false); });
    void fetchRelationships(controller.signal).then(items => {
      if (active) setRelationships(current => [...new Map([...current, ...items].map(item => [item.id, item])).values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    }).catch(() => { if (active) setRelationshipsError('Beziehungen konnten nicht geladen werden.'); }).finally(() => { if (active) setRelationshipsLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [loadAttempt]);
  useEffect(() => {
    const controller = new AbortController();
    setDetailError(''); setDetailLoading(Boolean(route.id));
    setObjectDetail(current => route.kind === 'sets' && current?.objectSet.id === route.id ? current : null);
    setRelationshipDetail(current => route.kind === 'relationships' && current?.relationship.id === route.id ? current : null);
    if (!route.id) return;
    const load = async () => {
      try {
        if (route.kind === 'sets') {
          const detail = await fetchObjectSet(route.id, offset, PAGE_SIZE, controller.signal);
          if (!controller.signal.aborted) setObjectDetail(detail);
        } else {
          const detail = await fetchRelationship(route.id, offset, PAGE_SIZE, controller.signal);
          if (!controller.signal.aborted) setRelationshipDetail(detail);
        }
      } catch (error) {
        if (!controller.signal.aborted) setDetailError(error instanceof SemanticModelApiError ? error.message : 'Der gespeicherte Stand konnte nicht geladen werden. Bitte erneut versuchen.');
      } finally { if (!controller.signal.aborted) setDetailLoading(false); }
    };
    void load();
    return () => controller.abort();
  }, [route.kind, route.id, offset, detailAttempt]);
  useEffect(() => {
    const id = objectDetail?.objectSet.id ?? relationshipDetail?.relationship.id ?? '';
    if (id && id !== lastFocusedId.current) { lastFocusedId.current = id; heading.current?.focus({ preventScroll: true }); }
  }, [objectDetail, relationshipDetail]);

  const save = async <T,>(kind: string, payload: unknown, send: (requestId: string, signal: AbortSignal) => Promise<T>, onSaved: (result: T, current: boolean) => void) => {
    if (mutation.current) return;
    const requestKey = `${prefix}request:${kind}`;
    const requestId = missionRequestId(requestKey, payload);
    const controller = new AbortController();
    mutation.current = controller;
    const requestEpoch = epoch.current;
    setSaving(true); setSaveError('');
    try {
      const result = await send(requestId, controller.signal);
      clearMissionRequest(requestKey);
      if (!controller.signal.aborted) onSaved(result, epoch.current === requestEpoch);
    } catch (error) {
      if (controller.signal.aborted || epoch.current !== requestEpoch) return;
      if (error instanceof SemanticModelApiError && error.status < 500 && ![408, 429].includes(error.status)) {
        clearMissionRequest(requestKey); setSaveError(error.message);
      } else setSaveError('Die Speicherantwort ist ausgeblieben. Der Stand kann bereits gespeichert sein. Erneutes Speichern verwendet dieselbe Anfrage-ID.');
    } finally {
      if (mutation.current === controller) mutation.current = null;
      if (!controller.signal.aborted) setSaving(false);
    }
  };
  const saveObject = (event: FormEvent) => {
    event.preventDefault();
    if (!objectConfirmed) return setSaveError('Bitte Fachname und Bedeutung des ID-Feldes ausdrücklich bestätigen.');
    if (!selectedDataset || !objectDraft.name.trim() || !objectColumns.includes(objectDraft.keyField) || (objectDraft.labelField && !objectColumns.includes(objectDraft.labelField))) return setSaveError('Bitte Fachname, Quelle und vorhandene Felder auswählen.');
    const payload = { name: objectDraft.name.trim(), datasetId: objectDraft.datasetId, keyField: objectDraft.keyField,
      ...(objectDraft.labelField ? { labelField: objectDraft.labelField } : {}), ...(objectDraft.previousId ? { previousId: objectDraft.previousId } : {}), confirmed: true as const };
    void save('object-set', payload, (requestId, signal) => createObjectSet({ ...payload, requestId }, signal), (created, current) => {
      setSets(items => [created, ...items.filter(item => item.id !== created.id)]);
      if (current) { setObjectConfirmed(false); setObjectDraft(EMPTY_SET); navigate('sets', created.id); }
    });
  };
  const saveRelation = (event: FormEvent) => {
    event.preventDefault();
    if (!relationshipConfirmed) return setSaveError('Bitte die Bedeutung der Beziehung ausdrücklich bestätigen.');
    if (!relationshipDraft.name.trim() || !fromSet || !toSet || !fromSet.source.columns.includes(relationshipDraft.fromField)) return setSaveError('Bitte einen Namen, zwei gespeicherte Objektmengen und das Referenzfeld auswählen.');
    const payload = { ...relationshipDraft, name: relationshipDraft.name.trim(), confirmed: true as const };
    void save('relationship', payload, (requestId, signal) => createRelationship({ ...payload, requestId }, signal), (created, current) => {
      setRelationships(items => [created, ...items.filter(item => item.id !== created.id)]);
      if (current) { setRelationshipConfirmed(false); setRelationshipDraft(EMPTY_RELATIONSHIP); navigate('relationships', created.id); }
    });
  };
  const changeObject = (key: keyof typeof EMPTY_SET, value: string) => {
    setObjectDraft(current => ({ ...current, [key]: value, ...(key === 'datasetId' ? { keyField: '', labelField: '' } : {}) }));
    setObjectConfirmed(false); setSaveError('');
  };
  const changeRelationship = (key: keyof typeof EMPTY_RELATIONSHIP, value: string) => {
    setRelationshipDraft(current => ({ ...current, [key]: value, ...(key === 'fromSetId' ? { fromField: '' } : {}) }));
    setRelationshipConfirmed(false); setSaveError('');
  };
  const revise = (objectSet: ObjectSet) => {
    setObjectDraft({ name: objectSet.name, datasetId: objectSet.source.datasetId, keyField: objectSet.keyField, labelField: objectSet.labelField ?? '', previousId: objectSet.id, previousRevision: String(objectSet.revision) });
    setObjectConfirmed(false); navigate('sets');
  };
  const latestObject = objectDetail ? sets.filter(item => item.familyId === objectDetail.objectSet.familyId).sort((a, b) => b.revision - a.revision)[0] : undefined;
  const visibleObject = route.kind === 'sets' && objectDetail?.objectSet.id === route.id ? objectDetail : null;
  const visibleRelationship = route.kind === 'relationships' && relationshipDetail?.relationship.id === route.id ? relationshipDetail : null;

  return <div className="kf-semantic">
    {showImport && <ImportWorkspaceDialog onClose={() => setShowImport(false)} onCompleted={items => {
      const imported = items.filter(item => item.connectorId === 'inline');
      setDatasets(current => [...imported, ...current.filter(item => !imported.some(next => next.id === item.id))]);
      if (imported[0]) { changeObject('datasetId', imported[0].id); setSourceError(''); }
      setShowImport(false);
    }} />}
    <div className="kf-semantic-toolbar"><p>Lege fest, welche fachlichen Dinge deine Quellen beschreiben und wie sie zusammengehören. Jeder gespeicherte Stand hält deine Bestätigung und seine Quellen fest.</p><button className={ghostBtnCls} type="button" onClick={() => setLoadAttempt(value => value + 1)}>Fachmodell aktualisieren</button></div>
    <nav className="kf-semantic-tabs" aria-label="Bereiche des Fachmodells"><button type="button" data-testid="semantic-tab-sets" aria-pressed={route.kind === 'sets'} onClick={() => navigate('sets')}>Objektmengen</button><button type="button" data-testid="semantic-tab-relationships" aria-pressed={route.kind === 'relationships'} onClick={() => navigate('relationships')}>Beziehungen</button></nav>
    <div className="kf-semantic-layout">
      <aside aria-label="Gespeicherte Fachmodelle"><Card title={route.kind === 'sets' ? 'Objektmengen und Revisionen' : 'Bestätigte Beziehungen'}>
        {route.kind === 'sets' ? <>
          <button type="button" className={ghostBtnCls} data-testid="semantic-new-set" onClick={() => { setObjectDraft(EMPTY_SET); setObjectConfirmed(false); navigate('sets'); }}>Neue Objektmenge</button>
          {setsLoading && <p role="status">Objektmengen werden geladen…</p>}{setsError && <p role="alert" className="kf-semantic-error">{setsError}</p>}
          {!setsLoading && !setsError && !sets.length && <p>Noch keine bestätigte Objektmenge. Wähle eine Quelle und benenne ihre fachliche Bedeutung.</p>}
          <ul className="kf-semantic-list">{sets.map(item => <li key={item.id}><button type="button" aria-current={route.id === item.id ? 'page' : undefined} onClick={() => navigate('sets', item.id)}><strong>{item.name}</strong><span>Revision {item.revision} · {number(item.source.rowCount)} Zeilen</span><small>{item.source.name}</small></button></li>)}</ul>
        </> : <>
          <button type="button" className={ghostBtnCls} data-testid="semantic-new-relationship" onClick={() => { setRelationshipDraft(EMPTY_RELATIONSHIP); setRelationshipConfirmed(false); navigate('relationships'); }}>Neue Beziehung</button>
          {relationshipsLoading && <p role="status">Beziehungen werden geladen…</p>}{relationshipsError && <p role="alert" className="kf-semantic-error">{relationshipsError}</p>}
          {!relationshipsLoading && !relationshipsError && !relationships.length && <p>Noch keine bestätigte Beziehung. Verbinde zwei gespeicherte Objektmengen.</p>}
          <ul className="kf-semantic-list">{relationships.map(item => <li key={item.id}><button type="button" aria-current={route.id === item.id ? 'page' : undefined} onClick={() => navigate('relationships', item.id)}><strong>{item.name}</strong><span>{number(item.counts.linkedRows)} von {number(item.counts.sourceRows)} Zeilen zugeordnet</span><small>{date(item.createdAt)}</small></button></li>)}</ul>
        </>}
      </Card></aside>
      <div className="kf-semantic-workspace">
        {saveError && <p className="kf-semantic-alert kf-semantic-error" role="alert">{saveError}</p>}
        {!route.id && route.kind === 'sets' && <Card title={objectDraft.previousId ? 'Neue Revision bestätigen' : 'Quelle fachlich beschreiben'}>
          <form className="kf-semantic-stack" onSubmit={saveObject}>
            {objectDraft.previousId && <p className="kf-semantic-alert">Du erstellst eine neue Revision von „{objectDraft.name}“ nach Revision {objectDraft.previousRevision}. Der alte Stand und bestehende Beziehungen bleiben unverändert. <a href={`#/model?set=${encodeURIComponent(objectDraft.previousId)}`}>Vorherigen Stand öffnen</a></p>}
            {sourceError && <p className="kf-semantic-error" role="alert">{sourceError}</p>}
            <fieldset className="kf-semantic-fields" disabled={saving || sourceLoading}>
              <label className="kf-semantic-field"><span>Importierte Quelle</span><select className={selectCls} data-testid="semantic-source" value={objectDraft.datasetId} onChange={event => changeObject('datasetId', event.target.value)} required><option value="">Quelle auswählen…</option>{datasets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <label className="kf-semantic-field"><span>Fachname der Objektmenge</span><input className={inputCls} data-testid="semantic-set-name" value={objectDraft.name} onChange={event => changeObject('name', event.target.value)} placeholder="Zum Beispiel: Projekte, Lieferanten oder Geräte" maxLength={120} required /></label>
              <label className="kf-semantic-field"><span>ID-Feld</span><select className={selectCls} data-testid="semantic-key-field" value={objectDraft.keyField} onChange={event => changeObject('keyField', event.target.value)} required><option value="">Feld ausdrücklich auswählen…</option>{objectColumns.map(column => <option key={column} value={column}>{column}</option>)}</select></label>
              <label className="kf-semantic-field"><span>Anzeigename (optional)</span><select className={selectCls} data-testid="semantic-label-field" value={objectDraft.labelField} onChange={event => changeObject('labelField', event.target.value)}><option value="">ID als Anzeigename verwenden</option>{objectColumns.map(column => <option key={column} value={column}>{column}</option>)}</select></label>
              <label className="kf-semantic-check"><input type="checkbox" data-testid="semantic-set-confirm" checked={objectConfirmed} onChange={event => setObjectConfirmed(event.target.checked)} /><span>Ich bestätige den Fachnamen und dass das ID-Feld diese Objekte identifizieren soll. Fehlende oder doppelte IDs bleiben als offene Fälle sichtbar.</span></label>
            </fieldset>
            {sourceLoading && <p role="status">Datenquellen werden geladen…</p>}
            {!sourceLoading && !sourceError && datasets.length === 0 && <p>Für eine Objektmenge wird zuerst eine vollständig importierte Quelle benötigt.</p>}
            <p className="kf-semantic-muted">Deine Angaben werden als fachliche Definition gespeichert. KoiForge leitet daraus keine automatisch bestätigte Bedeutung ab. Die Prüfung umfasst alle Zeilen des gespeicherten Quellenstands.</p>
            <div className="kf-semantic-actions"><button type="submit" className="kf-semantic-primary" data-testid="semantic-save-set" disabled={saving || sourceLoading}>{saving ? 'Stand wird gespeichert…' : objectDraft.previousId ? 'Neue Revision speichern' : 'Objektmenge bestätigen und speichern'}</button><button type="button" className={ghostBtnCls} disabled={saving} onClick={() => setShowImport(true)}>Datenquelle hinzufügen</button></div>
          </form>
        </Card>}
        {!route.id && route.kind === 'relationships' && <Card title="Beziehung fachlich bestätigen">
          <form className="kf-semantic-stack" onSubmit={saveRelation}>
            {setsLoading && <p role="status">Objektmengen werden geladen…</p>}{setsError && <p role="alert" className="kf-semantic-error">{setsError}</p>}
            {!setsLoading && !setsError && sets.length === 0 && <p>Bestätige zuerst deine Objektmengen. Danach kannst du ihre Zuordnung festlegen.</p>}
            <fieldset className="kf-semantic-fields" disabled={saving || setsLoading || Boolean(setsError)}>
              <label className="kf-semantic-field"><span>Name der Beziehung</span><input className={inputCls} data-testid="semantic-relationship-name" value={relationshipDraft.name} onChange={event => changeRelationship('name', event.target.value)} placeholder="Zum Beispiel: Projekt gehört zu Kunde" maxLength={120} required /></label>
              <label className="kf-semantic-field"><span>Ausgehende Objektmenge</span><select className={selectCls} data-testid="semantic-from-set" value={relationshipDraft.fromSetId} onChange={event => changeRelationship('fromSetId', event.target.value)} required><option value="">Gespeicherten Stand auswählen…</option>{sets.map(item => <option key={item.id} value={item.id}>{item.name} · Revision {item.revision}</option>)}</select></label>
              <label className="kf-semantic-field"><span>Referenzfeld der Ausgangsmenge</span><select className={selectCls} data-testid="semantic-from-field" value={relationshipDraft.fromField} onChange={event => changeRelationship('fromField', event.target.value)} required><option value="">Feld ausdrücklich auswählen…</option>{fromSet?.source.columns.map(column => <option key={column} value={column}>{column}</option>)}</select></label>
              <label className="kf-semantic-field"><span>Zielobjektmenge</span><select className={selectCls} data-testid="semantic-to-set" value={relationshipDraft.toSetId} onChange={event => changeRelationship('toSetId', event.target.value)} required><option value="">Gespeicherten Stand auswählen…</option>{sets.map(item => <option key={item.id} value={item.id}>{item.name} · Revision {item.revision}</option>)}</select></label>
              {fromSet && toSet && <p className="kf-semantic-binding" data-testid="semantic-binding">{fromSet.name} · {relationshipDraft.fromField || 'Referenzfeld noch auswählen'} → {toSet.name} · bestätigtes ID-Feld <strong>{toSet.keyField}</strong></p>}
              <label className="kf-semantic-check"><input type="checkbox" data-testid="semantic-relationship-confirm" checked={relationshipConfirmed} onChange={event => setRelationshipConfirmed(event.target.checked)} /><span>Ich bestätige: Jede Ausgangszeile soll über dieses Referenzfeld genau einem Zielobjekt zugeordnet sein (n:1). Mehrere Ausgangsobjekte dürfen dasselbe Ziel haben.</span></label>
            </fieldset>
            <p className="kf-semantic-muted">Die Beziehung hält beide ausgewählten Revisionen fest. Verglichen werden exakter Wert und Datentyp: Die Zahl 7 und der Text „7“ sind verschiedene IDs. Fehlende Referenzen, nicht gefundene Ziele, mehrdeutige Ziele und ungültige Quell-IDs bleiben getrennt sichtbar.</p>
            <div><button type="submit" className="kf-semantic-primary" data-testid="semantic-save-relationship" disabled={saving || setsLoading || Boolean(setsError)}>{saving ? 'Beziehung wird gespeichert…' : 'Beziehung bestätigen und speichern'}</button></div>
          </form>
        </Card>}
        {route.id && detailLoading && !visibleObject && !visibleRelationship && <p role="status">Gespeicherter Stand wird geladen…</p>}
        {detailError && <div className="kf-semantic-alert" role="alert"><p>{detailError}</p><button type="button" className={ghostBtnCls} onClick={() => setDetailAttempt(value => value + 1)}>Stand erneut laden</button></div>}
        {visibleObject && <div className="kf-semantic-stack" data-testid="semantic-object-detail" aria-busy={detailLoading}>
          <Card title="Bestätigte Objektmenge" action={<Badge>Revision {visibleObject.objectSet.revision}</Badge>}>
            <div className="kf-semantic-stack"><h3 ref={heading} tabIndex={-1} className="kf-semantic-name">{visibleObject.objectSet.name}</h3>
              <p>Die Kennzahlen beziehen sich auf den vollständigen, gespeicherten Quellenstand.</p><Counts values={visibleObject.objectSet.keyQuality} />
              <div className="kf-semantic-actions">{latestObject && latestObject.revision > visibleObject.objectSet.revision
                ? <button type="button" className={ghostBtnCls} onClick={() => navigate('sets', latestObject.id)}>Aktuelle Revision {latestObject.revision} öffnen</button>
                : <button type="button" className={ghostBtnCls} data-testid="semantic-revise-set" onClick={() => revise(visibleObject.objectSet)}>Felder korrigieren oder neuen Quellenstand übernehmen</button>}
                <button type="button" className={ghostBtnCls} onClick={() => { setRelationshipDraft({ ...EMPTY_RELATIONSHIP, fromSetId: visibleObject.objectSet.id }); setRelationshipConfirmed(false); navigate('relationships'); }}>Beziehung anlegen</button>
                <a className={ghostBtnCls} href={`#/objects?family=${encodeURIComponent(visibleObject.objectSet.familyId)}&set=${encodeURIComponent(visibleObject.objectSet.id)}`}>Objekte erkunden</a></div>
              <details className="kf-semantic-details"><summary>Definition und Quellenbelege</summary><ObjectSetEvidence objectSet={visibleObject.objectSet} /></details>
            </div>
          </Card>
          <Card title="Objekte und Quelldatensätze"><div className="kf-semantic-stack">
            <p className="kf-semantic-muted">Zeilen ohne eindeutige ID bleiben Quelldatensätze. Daraus wird keine gesicherte Objektidentität abgeleitet.</p>
            <div className="kf-semantic-table" role="region" aria-label="Objekte und Quelldatensätze" tabIndex={0}><table><thead><tr><th scope="col">Quellzeile</th><th scope="col">Objekt-ID</th><th scope="col">Anzeigename</th><th scope="col">Identität</th>{visibleObject.objectSet.source.columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
              <tbody>{visibleObject.rows.map(row => <tr key={row.sourceRow}><td>{row.sourceRow}</td><td><IdentityValue value={row.key} /></td><td>{row.label}</td><td><Badge tone={row.identity === 'unique' ? 'success' : 'warning'}>{label(identityLabels, row.identity)}</Badge></td>{visibleObject.objectSet.source.columns.map(column => <td key={column}>{cell(Object.hasOwn(row.attributes, column) ? row.attributes[column] : null)}</td>)}</tr>)}</tbody></table>
              {visibleObject.totalRows === 0 && <p>Dieser Quellenstand enthält keine Zeilen.</p>}
            </div><Pagination offset={visibleObject.offset} size={visibleObject.rows.length} total={visibleObject.totalRows} loading={detailLoading} onChange={setOffset} />
          </div></Card>
        </div>}
        {visibleRelationship && <div className="kf-semantic-stack" data-testid="semantic-relationship-detail" aria-busy={detailLoading}>
          <Card title="Bestätigte Beziehung" action={<Badge>n:1</Badge>}><div className="kf-semantic-stack">
            <h3 ref={heading} tabIndex={-1} className="kf-semantic-name">{visibleRelationship.relationship.name}</h3>
            <p className="kf-semantic-binding">{visibleRelationship.from.name} · Revision {visibleRelationship.from.revision} · {visibleRelationship.relationship.fromField} → {visibleRelationship.to.name} · Revision {visibleRelationship.to.revision} · {visibleRelationship.to.keyField}</p>
            <Counts values={visibleRelationship.relationship.counts} /><p className="kf-semantic-muted">Alle Ausgangszeilen wurden gegen den vollständigen Zielstand mit {number(visibleRelationship.to.source.rowCount)} Zeilen geprüft. Die Tabellenansicht ist seitenweise; die Kennzahlen gelten für den ganzen Stand.</p>
            <div><a className="kf-semantic-primary" data-testid="semantic-check-relationship" href={`#/missions?relationship=${encodeURIComponent(visibleRelationship.relationship.id)}`}>Beziehung als Auftrag prüfen</a></div>
            <div><a className="kf-semantic-primary" data-testid="semantic-check-orders" href={`#/missions?relationship=${encodeURIComponent(visibleRelationship.relationship.id)}&task=orders`}>Offene Bestellungen prüfen</a><p className="kf-semantic-muted">Für eine Beziehung von Bestellungen zu Lieferanten: Bestätige im Auftrag die Statusbedeutung und gegebenenfalls den zugesagten Liefertag.</p></div>
            <details className="kf-semantic-details"><summary>Bestätigte Revisionen und Quellenbelege</summary><div className="kf-semantic-stack">
              <p>Bestätigt am {date(visibleRelationship.relationship.createdAt)} · Vertrag {visibleRelationship.relationship.contractVersion}</p><p>Beziehungs-ID: <code>{visibleRelationship.relationship.id}</code></p>
              <h4>Ausgangsmenge: <a href={`#/model?set=${encodeURIComponent(visibleRelationship.from.id)}`}>{visibleRelationship.from.name} · Revision {visibleRelationship.from.revision}</a></h4><ObjectSetEvidence objectSet={visibleRelationship.from} />
              <h4>Zielmenge: <a href={`#/model?set=${encodeURIComponent(visibleRelationship.to.id)}`}>{visibleRelationship.to.name} · Revision {visibleRelationship.to.revision}</a></h4><ObjectSetEvidence objectSet={visibleRelationship.to} />
            </div></details>
          </div></Card>
          <Card title="Zuordnungen und offene Fälle"><div className="kf-semantic-stack">
            <p className="kf-semantic-muted">Offene Fälle stehen zuerst. Quell- und Zielzeilennummern beziehen sich auf die jeweiligen gespeicherten Quellenstände. Für eine Zuordnung müssen Wert und Datentyp übereinstimmen; Zahl 7 und Text „7“ sind verschieden.</p>
            <div className="kf-semantic-table" role="region" aria-label="Zuordnungen und offene Fälle" tabIndex={0}><table><thead><tr><th scope="col">Befund</th><th scope="col">Quellobjekt</th><th scope="col">Quellzeile</th><th scope="col">Quell-ID</th><th scope="col">Referenzwert</th><th scope="col">Zielobjekt</th><th scope="col">Zielzeilen</th></tr></thead>
              <tbody>{visibleRelationship.rows.map(row => <tr key={row.sourceRow}><td><Badge tone={row.status === 'linked' ? 'success' : 'warning'}>{label(relationshipStatusLabels, row.status)}</Badge></td><td>{row.sourceLabel}</td><td>{row.sourceRow}</td><td><IdentityValue value={row.sourceKey} /></td><td><IdentityValue value={row.reference} /></td><td>{row.targetLabel || 'Kein eindeutiges Ziel'}</td><td>{row.targetRows.length ? row.targetRows.join(', ') : 'Keine'}{row.targetRowsTruncated && <small> · erste {number(row.targetRows.length)} von {number(row.targetRowCount)} Zielzeilen</small>}</td></tr>)}</tbody></table>
              {visibleRelationship.totalRows === 0 && <p>Dieser Quellenstand enthält keine Ausgangszeilen.</p>}
            </div><Pagination offset={visibleRelationship.offset} size={visibleRelationship.rows.length} total={visibleRelationship.totalRows} loading={detailLoading} onChange={setOffset} />
          </div></Card>
        </div>}
      </div>
    </div>
  </div>;
}
