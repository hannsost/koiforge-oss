import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import {
  createDataflow,
  DataflowApiError,
  fetchDataflow,
  fetchDataflowRun,
  fetchDataflows,
  publishDataflow,
  runDataflow,
  type FlowDetail,
  type FlowFilterOperator,
  type FlowJoin,
  type FlowRunDetail,
  type FlowRunSummary,
  type FlowSpec,
  type FlowSummary,
  type ImportCell,
} from '../dataflows-api';
import { fetchObjectFamilies, type ObjectFamily } from '../object-workspace-api';
import { DataflowDependencies } from '../components/DataflowDependencies';
import '../dataflows.css';

const PAGE_SIZE = 25;
type DraftFilterValueKind = 'text' | 'number' | 'boolean' | 'null' | 'none';
type OperatorValueKind = DraftFilterValueKind | 'typed';
const FILTER_OPERATORS: Array<{ value: FlowFilterOperator; label: string; valueKind: OperatorValueKind }> = [
  { value: 'eq', label: 'ist gleich', valueKind: 'typed' },
  { value: 'neq', label: 'ist nicht gleich', valueKind: 'typed' },
  { value: 'gt', label: 'ist größer als', valueKind: 'number' },
  { value: 'gte', label: 'ist mindestens', valueKind: 'number' },
  { value: 'lt', label: 'ist kleiner als', valueKind: 'number' },
  { value: 'lte', label: 'ist höchstens', valueKind: 'number' },
  { value: 'contains', label: 'enthält', valueKind: 'text' },
  { value: 'is_null', label: 'ist nicht vorhanden', valueKind: 'none' },
  { value: 'not_null', label: 'ist vorhanden', valueKind: 'none' },
];
const DEFAULT_FILTER_OPERATOR = FILTER_OPERATORS[0]!;

type DraftField = { source: string; target: string; selected: boolean };
type DraftJoin = Omit<FlowJoin, 'fields'> & { fields: DraftField[] };
type DraftFilter = { field: string; operator: FlowFilterOperator; value: string; valueKind: DraftFilterValueKind };
type Draft = {
  name: string;
  description: string;
  inputFamilyId: string;
  keyField: string;
  labelField: string;
  joins: DraftJoin[];
  filters: DraftFilter[];
  minRows: string;
};
type Route = { flowId: string; runId: string };

const EMPTY_DRAFT: Draft = {
  name: '', description: '', inputFamilyId: '', keyField: '', labelField: '', joins: [], filters: [], minRows: '1',
};

function storedDraft(storageScope: string): Draft {
  try {
    const value = JSON.parse(sessionStorage.getItem(`koiforge:dataflows:${storageScope}:draft`) ?? 'null') as Partial<Draft> | null;
    if (!value || typeof value !== 'object') return EMPTY_DRAFT;
    return {
      ...EMPTY_DRAFT,
      ...value,
      joins: Array.isArray(value.joins) ? value.joins : [],
      filters: Array.isArray(value.filters) ? value.filters : [],
    };
  } catch { return EMPTY_DRAFT; }
}

type PendingRequest = { signature: string; id: string };

function storedRequestIds(storageScope: string): Map<string, PendingRequest> {
  try {
    const value = JSON.parse(sessionStorage.getItem(`koiforge:dataflows:${storageScope}:requests`) ?? 'null') as unknown;
    if (!Array.isArray(value)) return new Map();
    const entries = value.filter((entry): entry is [string, PendingRequest] => Array.isArray(entry)
      && entry.length === 2 && typeof entry[0] === 'string' && !!entry[1] && typeof entry[1] === 'object'
      && typeof (entry[1] as PendingRequest).signature === 'string' && typeof (entry[1] as PendingRequest).id === 'string');
    return new Map(entries);
  } catch { return new Map(); }
}

function persistRequestIds(storageScope: string, requests: Map<string, PendingRequest>): void {
  try { sessionStorage.setItem(`koiforge:dataflows:${storageScope}:requests`, JSON.stringify([...requests.entries()])); }
  catch { /* Safe retry state is a best-effort browser convenience. */ }
}

function routeFromHash(): Route {
  if (typeof window === 'undefined') return { flowId: '', runId: '' };
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (hash.split('?')[0] !== 'dataflows') return { flowId: '', runId: '' };
  const params = new URLSearchParams(hash.split('?')[1] ?? '');
  return { flowId: params.get('id') ?? '', runId: params.get('run') ?? '' };
}

function requestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `dataflow-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function messageFor(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Der Datenfluss konnte nicht verarbeitet werden.';
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function familyColumns(family: ObjectFamily | undefined): string[] {
  return family?.latest?.source?.columns ?? [];
}

function editableJoinFields(join: DraftJoin, family: ObjectFamily | undefined): DraftField[] {
  const selectedSources = new Set(join.fields.map(field => field.source));
  const prefix = family?.name.toLowerCase().replace(/[^a-z0-9]+/gi, '_') ?? 'quelle';
  return [...join.fields, ...familyColumns(family)
    .filter(column => column !== family?.latest.keyField && !selectedSources.has(column))
    .map(column => ({ source: column, target: `${prefix}_${column}`, selected: false }))];
}

function valueKindFromCell(value: ImportCell | undefined): DraftFilterValueKind {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'text';
}

function valueKindForOperator(operator: { valueKind: OperatorValueKind }, current: DraftFilterValueKind = 'text'): DraftFilterValueKind {
  return operator.valueKind === 'typed' ? (current === 'none' ? 'text' : current) : operator.valueKind;
}

function draftFromSpec(spec: FlowSpec): Draft {
  return {
    name: spec.name,
    description: spec.description,
    inputFamilyId: spec.inputFamilyId,
    keyField: spec.keyField,
    labelField: spec.labelField ?? '',
    joins: spec.joins.map(join => ({ ...join, fields: join.fields.map(field => ({ ...field, selected: true })) })),
    filters: spec.filters.map(filter => {
      const operator = FILTER_OPERATORS.find(item => item.value === filter.operator) ?? DEFAULT_FILTER_OPERATOR;
      return {
        field: filter.field,
        operator: filter.operator,
        value: filter.value == null ? '' : String(filter.value),
        valueKind: valueKindForOperator(operator, valueKindFromCell(filter.value)),
      };
    }),
    minRows: String(spec.minRows),
  };
}

function specFromDraft(draft: Draft): FlowSpec {
  const minRows = Number(draft.minRows);
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    inputFamilyId: draft.inputFamilyId,
    keyField: draft.keyField,
    ...(draft.labelField ? { labelField: draft.labelField } : {}),
    joins: draft.joins.map(join => ({
      familyId: join.familyId,
      leftField: join.leftField,
      rightField: join.rightField,
      required: join.required,
      fields: join.fields.filter(field => field.selected && field.source && field.target.trim()).map(field => ({ source: field.source, target: field.target.trim() })),
    })),
    filters: draft.filters.map(filter => ({
      field: filter.field,
      operator: filter.operator,
      ...(['is_null', 'not_null'].includes(filter.operator) ? {} : { value: parseFilterValue(filter.value, filter.valueKind) }),
    })),
    minRows: Number.isFinite(minRows) && minRows >= 0 ? Math.floor(minRows) : 0,
  };
}

function parseFilterValue(value: string, kind: DraftFilter['valueKind']): ImportCell {
  if (kind === 'number') return value.trim() === '' ? null : Number(value);
  if (kind === 'boolean') return value === 'true';
  if (kind === 'null') return null;
  return value;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('de-DE');
}

function number(value: number): string { return value.toLocaleString('de-DE'); }

function objectLink(familyId: string, setId: string): string {
  return `#/objects?family=${encodeURIComponent(familyId)}&set=${encodeURIComponent(setId)}`;
}

function isStale(detail: FlowDetail | null): boolean {
  // The API calculates freshness from the exact frozen source set used by the
  // latest run. A definition binding only contains a schema fingerprint, so it
  // cannot be compared with an object snapshot or row hash in the browser.
  return detail?.runs[0]?.sourcesChanged ?? false;
}

function StatusPill({ status }: { status: 'ready' | 'blocked' }) {
  return <span className={`dataflow-status dataflow-status-${status}`}>{status === 'ready' ? 'Bereit' : 'Blockiert'}</span>;
}

function RunSummary({ run, onSelect }: { run: FlowRunSummary; onSelect: () => void }) {
  return <button className="dataflow-run-item" type="button" onClick={onSelect}>
    <span><strong>{formatDate(run.createdAt)}</strong><small>{number(run.rowCount)} Ergebniszeilen</small></span>
    <span><StatusPill status={run.status} />{run.sourcesChanged && <em>Quelle geändert</em>}</span>
  </button>;
}

function Pagination({ offset, size, rowCount, loading, onChange }: { offset: number; size: number; rowCount: number; loading: boolean; onChange: (offset: number) => void }) {
  return <nav className="dataflow-pagination" aria-label="Ergebnisseiten">
    <button type="button" disabled={loading || offset === 0} onClick={() => onChange(Math.max(0, offset - PAGE_SIZE))}>Vorherige Seite</button>
    <span role="status">{size === 0 ? 'Keine Zeilen' : `Zeilen ${number(offset + 1)}–${number(offset + size)}`}{loading ? ' · lädt …' : ''}</span>
    <button type="button" disabled={loading || offset + size >= rowCount} onClick={() => onChange(offset + PAGE_SIZE)}>Nächste Seite</button>
  </nav>;
}

export function DataflowsView({ storageScope }: { storageScope: string }) {
  const prefix = `koiforge:dataflows:${storageScope}:draft`;
  const [route, setRouteState] = useState<Route>(routeFromHash);
  const routeRef = useRef(route);
  const generation = useRef(0);
  const mounted = useRef(false);
  const [families, setFamilies] = useState<ObjectFamily[]>([]);
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [detail, setDetail] = useState<FlowDetail | null>(null);
  const [runDetail, setRunDetail] = useState<FlowRunDetail | null>(null);
  const [draft, setDraft] = useState<Draft>(() => storedDraft(storageScope));
  const [confirmed, setConfirmed] = useState(false);
  const [runConfirmed, setRunConfirmed] = useState(false);
  const [publishConfirmed, setPublishConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [runLoading, setRunLoading] = useState(false);
  const [familiesError, setFamiliesError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'save' | 'run' | 'publish' | ''>('');
  const [runOffset, setRunOffset] = useState(0);
  const [published, setPublished] = useState<FlowSummary['published']>();
  const [attempt, setAttempt] = useState(0);
  const [dependencyRefresh, setDependencyRefresh] = useState(0);
  const [runAttempt, setRunAttempt] = useState(0);
  const requestIds = useRef(storedRequestIds(storageScope));
  const aborts = useRef(new Set<AbortController>());

  const inputFamily = families.find(family => family.id === draft.inputFamilyId);
  const inputColumns = familyColumns(inputFamily);
  const joinedColumns = draft.joins.flatMap(join => join.fields.filter(field => field.selected && field.target.trim()).map(field => field.target.trim()));
  const outputColumnsForDraft = [...new Set([...inputColumns, ...joinedColumns])];
  const selectedLatestRun = detail?.runs.find(run => run.id === route.runId) ?? detail?.runs[0];
  const stale = isStale(detail);
  const hasUnconfirmedChanges = useMemo(() => detail
    ? JSON.stringify(specFromDraft(draft)) !== JSON.stringify(specFromDraft(draftFromSpec(detail.definition.spec)))
    : false, [detail, draft]);

  const updateRoute = useCallback((next: Route) => {
    generation.current += 1;
    routeRef.current = next;
    setRouteState(next);
    const params = new URLSearchParams();
    if (next.flowId) params.set('id', next.flowId);
    if (next.runId) params.set('run', next.runId);
    const query = params.toString();
    if (typeof window !== 'undefined') {
      const hash = `/dataflows${query ? `?${query}` : ''}`;
      if (window.location.hash !== `#${hash}`) window.location.hash = hash;
    }
    setError('');
    setRunOffset(0);
    setRunDetail(null);
    setRunConfirmed(false);
    setPublishConfirmed(false);
    setBusy('');
  }, []);

  useEffect(() => {
    mounted.current = true;
    const onHashChange = () => {
      if (window.location.hash.replace(/^#\/?/, '').split('?')[0] !== 'dataflows') return;
      const next = routeFromHash();
      const current = routeRef.current;
      if (next.flowId !== current.flowId || next.runId !== current.runId) updateRoute(next);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => {
      mounted.current = false;
      window.removeEventListener('hashchange', onHashChange);
      aborts.current.forEach(controller => controller.abort());
    };
  }, [updateRoute]);

  useEffect(() => {
    const controller = new AbortController();
    aborts.current.add(controller);
    setFamiliesError('');
    void fetchObjectFamilies(controller.signal).then(items => {
      if (controller.signal.aborted) return;
      setFamilies(items);
    }).catch(reason => { if (!isAbort(reason)) setFamiliesError(messageFor(reason)); }).finally(() => aborts.current.delete(controller));
    return () => { controller.abort(); aborts.current.delete(controller); };
  }, [attempt]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    aborts.current.add(controller);
    setLoading(true);
    setError('');
    void fetchDataflows(controller.signal).then(items => {
      if (!active) return;
      setFlows(items);
    }).catch(reason => { if (active && !isAbort(reason)) setError(messageFor(reason)); }).finally(() => {
      if (active) setLoading(false);
      aborts.current.delete(controller);
    });
    return () => { active = false; controller.abort(); aborts.current.delete(controller); };
  }, [attempt]);

  useEffect(() => {
    if (!route.flowId) {
      setDetail(null);
      setDetailLoading(false);
      setPublished(undefined);
      setDraft(previous => previous.name || previous.inputFamilyId ? previous : EMPTY_DRAFT);
      return;
    }
    const controller = new AbortController();
    aborts.current.add(controller);
    const requestGeneration = generation.current;
    if (detail?.definition.flowId !== route.flowId) {
      setDetail(null);
      setRunDetail(null);
    }
    setDetailLoading(true);
    setPublished(undefined);
    setError('');
    void fetchDataflow(route.flowId, controller.signal).then(value => {
      if (controller.signal.aborted || requestGeneration !== generation.current) return;
      setDetail(value);
      setDraft(draftFromSpec(value.definition.spec));
      setConfirmed(false);
      setPublished(value.published ?? value.runs.find(run => run.published)?.published);
      setDetailLoading(false);
    }).catch(reason => {
      if (controller.signal.aborted || !mounted.current || requestGeneration !== generation.current) return;
      setDetailLoading(false);
      setError(messageFor(reason));
    });
    return () => { controller.abort(); aborts.current.delete(controller); };
  }, [route.flowId, attempt]);

  useEffect(() => {
    if (!route.flowId || !route.runId) {
      setRunDetail(null);
      setRunLoading(false);
      return;
    }
    const controller = new AbortController();
    aborts.current.add(controller);
    const requestGeneration = generation.current;
    setRunLoading(true);
    void fetchDataflowRun(route.flowId, route.runId, runOffset, PAGE_SIZE, controller.signal).then(value => {
      if (controller.signal.aborted || requestGeneration !== generation.current) return;
      setRunDetail(value);
      setRunLoading(false);
    }).catch(reason => {
      if (controller.signal.aborted || !mounted.current || requestGeneration !== generation.current) return;
      setRunLoading(false);
      setError(messageFor(reason));
    });
    return () => { controller.abort(); aborts.current.delete(controller); };
  }, [route.flowId, route.runId, runOffset, runAttempt, attempt]);

  useEffect(() => {
    try {
      if (!route.flowId) sessionStorage.setItem(prefix, JSON.stringify(draft));
    } catch { /* Browser draft storage is optional. */ }
  }, [draft, prefix, route.flowId]);

  const selectFlow = (id: string) => updateRoute({ flowId: id, runId: '' });
  const startCreate = () => {
    generation.current += 1;
    routeRef.current = { flowId: '', runId: '' };
    setRouteState({ flowId: '', runId: '' });
    if (typeof window !== 'undefined' && window.location.hash !== '#/dataflows') window.location.hash = '/dataflows';
    setDetail(null);
    setDetailLoading(false);
    setRunDetail(null);
    setRunLoading(false);
    setDraft(EMPTY_DRAFT);
    setConfirmed(false);
    setRunConfirmed(false);
    setPublishConfirmed(false);
    setPublished(undefined);
    setRunOffset(0);
    setBusy('');
    setError('');
  };

  const reloadAfterConflict = async (expectedGeneration: number) => {
    if (!route.flowId) return;
    try {
      const current = await fetchDataflow(route.flowId);
      if (!mounted.current || generation.current !== expectedGeneration || routeRef.current.flowId !== route.flowId) return;
      setDetail(current);
      setDraft(draftFromSpec(current.definition.spec));
      setPublished(current.published ?? current.runs.find(run => run.published)?.published);
    } catch { /* Keep the conflict message actionable. */ }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const invalidValue = draft.filters.some(filter => {
      if (['is_null', 'not_null'].includes(filter.operator)) return false;
      return filter.valueKind === 'number' ? !filter.value.trim() || !Number.isFinite(Number(filter.value))
        : filter.valueKind === 'boolean' && !['true', 'false'].includes(filter.value);
    });
    if (invalidValue) { setError('Bitte für jeden Zahlen- oder Ja/Nein-Filter einen gültigen Wert wählen.'); return; }
    const spec = specFromDraft(draft);
    if (!confirmed) { setError('Bitte bestätige den Datenfluss ausdrücklich, bevor du ihn speicherst.'); return; }
    if (!spec.name || !spec.inputFamilyId || !spec.keyField || !Number.isFinite(spec.minRows) || spec.minRows < 0) {
      setError('Bitte Name, Eingangsobjekt, Schlüssel und eine gültige Mindestzeilenanzahl auswählen.'); return;
    }
    if (spec.joins.some(join => !join.familyId || !join.leftField || !join.rightField || join.fields.length === 0)) {
      setError('Jede Verknüpfung braucht zwei Schlüssel und mindestens ein ausgewähltes Feld.'); return;
    }
    const payload = { spec, confirmed: true as const, ...(detail ? { previousId: detail.definition.id } : {}) };
    const key = `save:${route.flowId || 'new'}`;
    const signature = JSON.stringify(payload);
    const previous = requestIds.current.get(key);
    const stableId = previous?.signature === signature ? previous.id : requestId();
    requestIds.current.set(key, { signature, id: stableId });
    persistRequestIds(storageScope, requestIds.current);
    setBusy('save'); setError('');
    const actionGeneration = generation.current;
    try {
      const result = await createDataflow({ ...payload, requestId: stableId }, undefined);
      if (actionGeneration !== generation.current || !mounted.current) return;
      requestIds.current.delete(key);
      persistRequestIds(storageScope, requestIds.current);
      setFlows(current => current.some(item => item.id === result.definition.flowId)
        ? current.map(item => item.id === result.definition.flowId ? { ...item, name: result.definition.spec.name, description: result.definition.spec.description, revision: result.definition.revision, definitionId: result.definition.id, updatedAt: result.definition.createdAt, inputFamilyIds: [result.definition.spec.inputFamilyId] } : item)
        : [{ id: result.definition.flowId, name: result.definition.spec.name, description: result.definition.spec.description, revision: result.definition.revision, definitionId: result.definition.id, updatedAt: result.definition.createdAt, inputFamilyIds: [result.definition.spec.inputFamilyId] }, ...current]);
      setConfirmed(false);
      updateRoute({ flowId: result.definition.flowId, runId: '' });
      setAttempt(value => value + 1);
    } catch (reason) {
      if (actionGeneration !== generation.current || !mounted.current) return;
      if (reason instanceof DataflowApiError && reason.status === 409) {
        requestIds.current.delete(key);
        persistRequestIds(storageScope, requestIds.current);
        setConfirmed(false);
        setError('Der Datenfluss wurde inzwischen geändert. Die aktuelle Fassung wurde geladen. Bitte prüfe sie erneut und bestätige das Speichern.');
        await reloadAfterConflict(actionGeneration);
        if (actionGeneration !== generation.current || !mounted.current) return;
      } else setError(messageFor(reason));
    } finally { if (actionGeneration === generation.current) setBusy(''); }
  };

  const run = async () => {
    if (!detail || !runConfirmed) { setError('Bitte bestätige den aktuellen Eingabestand, bevor du den Datenfluss ausführst.'); return; }
    if (hasUnconfirmedChanges) { setError('Bitte speichere die Änderungen als neue bestätigte Revision, bevor du den Datenfluss ausführst.'); return; }
    const payload = { definitionId: detail.definition.id, confirmed: true as const };
    const flowId = detail.definition.flowId;
    const key = `run:${flowId}:${detail.definition.id}`;
    const signature = JSON.stringify(payload);
    const previous = requestIds.current.get(key);
    const stableId = previous?.signature === signature ? previous.id : requestId();
    requestIds.current.set(key, { signature, id: stableId });
    persistRequestIds(storageScope, requestIds.current);
    setBusy('run'); setError('');
    const actionGeneration = generation.current;
    try {
      const result = await runDataflow(flowId, { ...payload, requestId: stableId });
      if (actionGeneration !== generation.current || !mounted.current) return;
      requestIds.current.delete(key);
      persistRequestIds(storageScope, requestIds.current);
      setRunConfirmed(false);
      setFlows(current => current.map(item => item.id === flowId ? { ...item, latestRun: result.run } : item));
      updateRoute({ flowId, runId: result.run.id });
      setAttempt(value => value + 1);
    } catch (reason) {
      if (actionGeneration !== generation.current || !mounted.current) return;
      if (reason instanceof DataflowApiError && reason.status === 409) {
        requestIds.current.delete(key);
        persistRequestIds(storageScope, requestIds.current);
        setRunConfirmed(false);
        setError('Die Quelle oder Definition hat sich geändert. Die aktuelle Fassung wurde neu geladen. Bitte bestätige den Eingabestand erneut.');
        await reloadAfterConflict(actionGeneration);
        if (actionGeneration !== generation.current || !mounted.current) return;
      } else setError(messageFor(reason));
    } finally { if (actionGeneration === generation.current) setBusy(''); }
  };

  const publish = async () => {
    const currentRun = runDetail?.run ?? selectedLatestRun;
    if (!detail || !currentRun || currentRun.status !== 'ready' || !publishConfirmed) {
      setError('Bitte einen bereiten Durchlauf auswählen und die Veröffentlichung ausdrücklich bestätigen.'); return;
    }
    setBusy('publish'); setError('');
    const actionGeneration = generation.current;
    try {
      const flowId = detail.definition.flowId;
      const result = await publishDataflow(flowId, currentRun.id);
      if (actionGeneration !== generation.current || !mounted.current) return;
      setPublished(result.objectSet);
      setDependencyRefresh(value => value + 1);
      setPublishConfirmed(false);
      setFlows(current => current.map(item => item.id === flowId ? { ...item, published: result.objectSet } : item));
      setDetail(current => current ? { ...current, published: result.objectSet, runs: current.runs.map(runItem => runItem.id === currentRun.id ? { ...runItem, published: result.objectSet } : runItem) } : current);
    } catch (reason) { if (actionGeneration === generation.current) setError(messageFor(reason)); }
    finally { if (actionGeneration === generation.current) setBusy(''); }
  };

  const updateDraft = (patch: Partial<Draft>) => { setDraft(current => ({ ...current, ...patch })); setConfirmed(false); setError(''); };
  const inputFamilyChange = (familyId: string) => {
    const family = families.find(item => item.id === familyId);
    updateDraft({ inputFamilyId: familyId, keyField: family?.latest.keyField ?? '', labelField: family?.latest.labelField ?? '', joins: [], filters: [] });
  };
  const addJoin = () => {
    if (draft.joins.length >= 2) return;
    const family = families.find(item => item.id !== draft.inputFamilyId);
    if (!family) return;
    const columns = familyColumns(family);
    setDraft(current => ({ ...current, joins: [...current.joins, { familyId: family.id, leftField: current.keyField, rightField: family.latest.keyField, required: false, fields: columns.filter(column => column !== family.latest.keyField).map(column => ({ source: column, target: `${family.name.toLowerCase().replace(/[^a-z0-9]+/gi, '_')}_${column}`, selected: false })) }] }));
    setConfirmed(false);
  };
  const changeJoin = (index: number, patch: Partial<DraftJoin>) => updateDraft({ joins: draft.joins.map((join, itemIndex) => itemIndex === index ? { ...join, ...patch } : join) });
  const changeJoinFamily = (index: number, familyId: string) => {
    const family = families.find(item => item.id === familyId);
    const fields = familyColumns(family).filter(column => column !== family?.latest.keyField).map(column => ({ source: column, target: `${family?.name.toLowerCase().replace(/[^a-z0-9]+/gi, '_') ?? 'quelle'}_${column}`, selected: false }));
    changeJoin(index, { familyId, rightField: family?.latest.keyField ?? '', fields });
  };
  const changeFilter = (index: number, patch: Partial<DraftFilter>) => updateDraft({ filters: draft.filters.map((filter, itemIndex) => itemIndex === index ? { ...filter, ...patch } : filter) });
  const addFilter = () => { updateDraft({ filters: [...draft.filters, { field: outputColumnsForDraft[0] ?? '', operator: 'eq', value: '', valueKind: 'text' }] }); };

  const renderedRows = runDetail?.rows ?? [];
  const outputColumns = runDetail?.run.schema.map(field => field.name) ?? Object.keys(renderedRows[0] ?? {});
  const revisions = detail?.revisions ?? [];

  return <div className="kf-dataflow-workspace" data-testid="flow-workspace">
    <div className="dataflow-toolbar">
      <div><h2>Datenflüsse</h2><p>Bereite bestätigte Objektfamilien nachvollziehbar für Auswertungen auf.</p></div>
      <button data-testid="flow-create" className="dataflow-primary-button" type="button" onClick={startCreate}>Neuen Datenfluss anlegen</button>
    </div>
    <DataflowDependencies selectedFlowId={route.flowId} refreshKey={attempt + dependencyRefresh}
      onSelect={id => { selectFlow(id); setAttempt(value => value + 1); }} />
    {error && <div className="dataflow-alert dataflow-alert-error" role="alert">{error}</div>}
    {familiesError && <div className="dataflow-alert dataflow-alert-warning" role="alert">{familiesError} <button type="button" onClick={() => setAttempt(value => value + 1)}>Erneut laden</button></div>}
    <div className="dataflow-layout">
      <aside className="dataflow-catalog" aria-label="Datenflusskatalog">
        <div className="dataflow-card-heading"><h3>Gespeicherte Datenflüsse</h3><span>{flows.length}</span></div>
        {loading && <p className="dataflow-muted" role="status">Datenflüsse werden geladen …</p>}
        {!loading && flows.length === 0 && <p className="dataflow-muted">Noch kein Datenfluss gespeichert.</p>}
        <div className="dataflow-list">{flows.map(flow => <button key={flow.id} type="button" className={`dataflow-list-item ${route.flowId === flow.id ? 'is-selected' : ''}`} onClick={() => selectFlow(flow.id)}><strong>{flow.name}</strong><span>Revision {flow.revision}{flow.latestRun ? ` · ${flow.latestRun.status === 'ready' ? 'bereit' : 'blockiert'}` : ''}</span></button>)}</div>
      </aside>
      <main className="dataflow-main">
        {detailLoading && <p className="dataflow-muted" role="status">Datenfluss wird geladen …</p>}
        {!detailLoading && <>
          {detail && <div className="dataflow-detail-heading"><div><span className="dataflow-eyebrow">Datenfluss</span><h3>{detail.definition.spec.name}</h3><p>Revision {detail.definition.revision} · gespeichert am {formatDate(detail.definition.createdAt)}</p></div>{runDetail?.run.status || selectedLatestRun?.status ? <StatusPill status={runDetail?.run.status ?? selectedLatestRun!.status} /> : <span className="dataflow-status">Noch nicht ausgeführt</span>}</div>}
          {stale && <div className="dataflow-alert dataflow-alert-warning"><strong>Eine Eingangsquelle hat eine neue Revision.</strong> Der gespeicherte Stand bleibt sichtbar. Der nächste Lauf prüft den neuen Quellenstand; eine Schemaänderung wird dort als konkreter Blockierungsgrund angezeigt.</div>}
          <form className="dataflow-editor" onSubmit={save}>
            <div className="dataflow-card-heading"><div><h3>{detail ? 'Definition bearbeiten' : 'Neuen Datenfluss anlegen'}</h3><p>Speichern legt eine neue nachvollziehbare Revision an und führt sie noch nicht aus.</p></div></div>
            <div className="dataflow-form-grid">
              <label><span>Name</span><input data-testid="flow-name" value={draft.name} onChange={event => updateDraft({ name: event.target.value })} required /></label>
              <label><span>Eingangsfamilie</span><select data-testid="flow-input" value={draft.inputFamilyId} onChange={event => inputFamilyChange(event.target.value)} required><option value="">Objektfamilie auswählen …</option>{families.map(family => <option key={family.id} value={family.id}>{family.name} · Revision {family.latest.revision}</option>)}</select></label>
              <label><span>Schlüsselfeld</span><select data-testid="flow-key" value={draft.keyField} onChange={event => updateDraft({ keyField: event.target.value })} disabled={!inputFamily} required><option value="">Schlüssel auswählen …</option>{outputColumnsForDraft.map(column => <option key={column} value={column}>{column}</option>)}</select></label>
              <label><span>Anzeigename <small>(optional)</small></span><select value={draft.labelField} onChange={event => updateDraft({ labelField: event.target.value })} disabled={!inputFamily}><option value="">Kein Anzeigename</option>{outputColumnsForDraft.map(column => <option key={column} value={column}>{column}</option>)}</select></label>
              <label className="dataflow-wide"><span>Beschreibung <small>(optional)</small></span><textarea value={draft.description} onChange={event => updateDraft({ description: event.target.value })} rows={2} /></label>
              <label><span>Mindestanzahl Ergebniszeilen</span><input type="number" min="0" step="1" value={draft.minRows} onChange={event => updateDraft({ minRows: event.target.value })} /></label>
            </div>

            <section className="dataflow-section" aria-labelledby="flow-joins-heading"><div className="dataflow-section-heading"><div><h4 id="flow-joins-heading">Verknüpfungen</h4><p>Ergänze bis zu zwei optionale oder erforderliche Familien über exakt gleiche Schlüsselwerte.</p></div><button type="button" onClick={addJoin} disabled={draft.joins.length >= 2 || !draft.inputFamilyId}>Verknüpfung hinzufügen</button></div>
              {draft.joins.length === 0 && <p className="dataflow-muted">Keine Verknüpfung. Der Datenfluss verwendet nur die Eingangsobjekte.</p>}
              {draft.joins.map((join, index) => { const family = families.find(item => item.id === join.familyId); const fields = editableJoinFields(join, family); const leftColumns = [...new Set([...inputColumns, ...draft.joins.slice(0, index).flatMap(previous => previous.fields.filter(field => field.selected && field.target.trim()).map(field => field.target.trim()))])]; return <div className="dataflow-join" key={`${index}-${join.familyId}`}><div className="dataflow-join-heading"><strong>Verknüpfung {index + 1}</strong><button type="button" className="dataflow-link-button" onClick={() => updateDraft({ joins: draft.joins.filter((_, itemIndex) => itemIndex !== index) })}>Entfernen</button></div><div className="dataflow-form-grid"><label><span>Rechte Objektfamilie</span><select value={join.familyId} onChange={event => changeJoinFamily(index, event.target.value)}><option value="">Familie auswählen …</option>{families.filter(item => item.id !== draft.inputFamilyId).map(item => <option key={item.id} value={item.id}>{item.name} · Revision {item.latest.revision}</option>)}</select></label><label><span>Linkes Feld</span><select value={join.leftField} onChange={event => changeJoin(index, { leftField: event.target.value })}>{leftColumns.map(column => <option key={column} value={column}>{column}</option>)}</select></label><label><span>Rechtes Feld</span><select value={join.rightField} onChange={event => changeJoin(index, { rightField: event.target.value })}>{familyColumns(family).map(column => <option key={column} value={column}>{column}</option>)}</select></label><label className="dataflow-checkbox"><input type="checkbox" checked={join.required} onChange={event => changeJoin(index, { required: event.target.checked })} /><span>Erforderlich: fehlende Zuordnung blockiert den Lauf</span></label></div><div className="dataflow-field-picker"><strong>Ausgabefelder aus {family?.name ?? 'der Familie'}</strong><p>Wähle Felder aus und prüfe den vorgeschlagenen Namen.</p>{fields.map((field, fieldIndex) => <div className="dataflow-field-row" key={field.source}><label className="dataflow-checkbox"><input type="checkbox" checked={field.selected} onChange={event => changeJoin(index, { fields: fields.map((item, itemIndex) => itemIndex === fieldIndex ? { ...item, selected: event.target.checked } : item) })} /><span>{field.source}</span></label><input aria-label={`Ausgabename für ${field.source}`} value={field.target} onChange={event => changeJoin(index, { fields: fields.map((item, itemIndex) => itemIndex === fieldIndex ? { ...item, target: event.target.value } : item) })} /></div>)}</div></div>; })}
            </section>

            <section className="dataflow-section" aria-labelledby="flow-filters-heading"><div className="dataflow-section-heading"><div><h4 id="flow-filters-heading">Filter</h4><p>Filter werden typisiert gespeichert; leere oder ungültige Werte blockieren den Lauf.</p></div><button type="button" onClick={addFilter} disabled={!inputFamily}>Filter hinzufügen</button></div>{draft.filters.length === 0 && <p className="dataflow-muted">Keine Filter.</p>}{draft.filters.map((filter, index) => { const operator = FILTER_OPERATORS.find(item => item.value === filter.operator) ?? DEFAULT_FILTER_OPERATOR; const valueKind = valueKindForOperator(operator, filter.valueKind); return <div className="dataflow-filter-row" key={index}><select aria-label="Filterfeld" value={filter.field} onChange={event => changeFilter(index, { field: event.target.value })}>{outputColumnsForDraft.map(column => <option key={column} value={column}>{column}</option>)}</select><select aria-label="Filteroperator" value={filter.operator} onChange={event => { const next = FILTER_OPERATORS.find(item => item.value === event.target.value) ?? DEFAULT_FILTER_OPERATOR; const nextKind = valueKindForOperator(next, filter.valueKind); changeFilter(index, { operator: next.value, valueKind: nextKind, value: nextKind === 'boolean' ? 'true' : '' }); }}>{FILTER_OPERATORS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select><div className="dataflow-filter-value">{operator.valueKind === 'typed' && <select aria-label="Filterwerttyp" value={valueKind} onChange={event => changeFilter(index, { valueKind: event.target.value as DraftFilterValueKind, value: event.target.value === 'boolean' ? 'true' : '' })}><option value="text">Text</option><option value="number">Zahl</option><option value="boolean">Ja/Nein</option><option value="null">Null</option></select>}{valueKind === 'none' ? <span className="dataflow-filter-no-value">kein Wert nötig</span> : valueKind === 'null' ? <span className="dataflow-filter-no-value">null</span> : valueKind === 'boolean' ? <select aria-label="Filterwert" value={filter.value} onChange={event => changeFilter(index, { value: event.target.value })}><option value="true">Ja</option><option value="false">Nein</option></select> : <input aria-label="Filterwert" type={valueKind === 'number' ? 'number' : 'text'} value={filter.value} onChange={event => changeFilter(index, { value: event.target.value })} placeholder="Wert" />}</div><button type="button" className="dataflow-link-button" onClick={() => updateDraft({ filters: draft.filters.filter((_, itemIndex) => itemIndex !== index) })}>Entfernen</button></div>; })}</section>

            <label className="dataflow-confirm"><input data-testid="flow-confirm" type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>Ich bestätige die Bedeutung der Eingangsobjekte, Schlüssel, Verknüpfungen und Filter für diese neue Revision.</span></label>
            <div className="dataflow-actions"><button data-testid="flow-save" className="dataflow-primary-button" type="submit" disabled={busy !== '' || !confirmed}>{busy === 'save' ? 'Speichert …' : detail ? 'Neue Revision speichern' : 'Datenfluss speichern'}</button></div>
          </form>

          {detail && <>
            <section className="dataflow-card" aria-labelledby="flow-run-heading"><div className="dataflow-card-heading"><div><h3 id="flow-run-heading">Ausführen</h3><p>Der Lauf verwendet die zuletzt gespeicherte Revision und friert die Eingaben für die Auswertung ein.</p></div><button data-testid="flow-run" className="dataflow-primary-button" type="button" onClick={() => void run()} disabled={busy !== '' || !runConfirmed || hasUnconfirmedChanges}>{busy === 'run' ? 'Läuft …' : 'Letzte Revision ausführen'}</button></div><label className="dataflow-confirm"><input data-testid="flow-run-confirm" type="checkbox" checked={runConfirmed} onChange={event => setRunConfirmed(event.target.checked)} /><span>Ich bestätige, dass die gespeicherte Revision mit den aktuell angezeigten Quellen ausgeführt werden darf.</span></label>{hasUnconfirmedChanges && <p className="dataflow-inline-warning">Die Bearbeitung enthält unbestätigte Änderungen. Speichere sie zuerst als neue bestätigte Revision.</p>}</section>
            <section className="dataflow-card" aria-labelledby="flow-runs-heading"><div className="dataflow-card-heading"><div><h3 id="flow-runs-heading">Durchläufe</h3><p>Bereite und blockierte Ergebnisse bleiben mit ihren Quellen nachvollziehbar.</p></div></div>{detail.runs.length === 0 && <p className="dataflow-muted">Noch kein Durchlauf.</p>}<div className="dataflow-run-list">{detail.runs.map(runItem => <RunSummary key={runItem.id} run={runItem} onSelect={() => updateRoute({ flowId: detail.definition.flowId, runId: runItem.id })} />)}</div></section>
            {runDetail && <section className="dataflow-card" data-testid="flow-run-detail" aria-labelledby="flow-result-heading"><div className="dataflow-card-heading"><div><h3 id="flow-result-heading">Ergebnis vom {formatDate(runDetail.run.createdAt)}</h3><p><StatusPill status={runDetail.run.status} /> · {number(runDetail.run.rowCount)} Zeilen</p></div></div>{runDetail.run.issues.length > 0 && <div className="dataflow-issues" role="status"><strong>{runDetail.run.status === 'blocked' ? 'Der Lauf wurde blockiert.' : 'Hinweise zur Auswertung'}</strong><ul>{runDetail.run.issues.map(issue => <li key={issue}>{issue}</li>)}</ul></div>}<div className="dataflow-lineage"><strong>Eingaben dieses Laufs</strong>{runDetail.run.sources.map(source => <a key={`${source.familyId}-${source.setId}`} href={objectLink(source.familyId, source.setId)}>Objekte: {source.name} · Revision {source.revision} · {number(source.rowCount)} Zeilen</a>)}</div>{runDetail.run.status === 'ready' && <div className="dataflow-publish"><p><strong>Ergebnis veröffentlichen</strong><br />Veröffentlichen legt eine neue Objektfamilienrevision an. Das bestehende Objekt bleibt erhalten; bestätigte neue Revisionen können in derselben Objektfamilie weitergegeben werden. Bestehende Projektfreigaben dieser Familie umfassen auch diese neue Revision.</p><label className="dataflow-confirm"><input data-testid="flow-publish-confirm" type="checkbox" checked={publishConfirmed} onChange={event => setPublishConfirmed(event.target.checked)} /><span>Ich bestätige, dass dieses Ergebnis als Objektfamilie sichtbar werden darf.</span></label><button data-testid="flow-publish" className="dataflow-primary-button" type="button" onClick={() => void publish()} disabled={busy !== '' || !publishConfirmed}>{busy === 'publish' ? 'Veröffentlicht …' : 'Ergebnis veröffentlichen'}</button></div>}<div className="dataflow-table-wrap" role="region" aria-label="Ergebniszeilen" tabIndex={0}>{renderedRows.length === 0 ? <p className="dataflow-muted">Keine Ergebniszeilen auf dieser Seite.</p> : <table><thead><tr>{outputColumns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead><tbody>{renderedRows.map((row, rowIndex) => <tr data-testid="flow-output-row" key={rowIndex}>{outputColumns.map(column => <td key={column}>{row[column] == null ? <span className="dataflow-null">Nicht vorhanden</span> : String(row[column])}</td>)}</tr>)}</tbody></table>}</div><Pagination offset={runDetail.offset} size={renderedRows.length} rowCount={runDetail.run.rowCount} loading={runLoading} onChange={offset => { setRunOffset(offset); setRunAttempt(value => value + 1); }} /></section>}
            {published && <section className="dataflow-card dataflow-published" aria-labelledby="flow-published-heading"><div><h3 id="flow-published-heading">Zuletzt veröffentlichtes Ergebnis</h3><p>Dieses Ergebnis bleibt sichtbar, auch wenn ein neuer Lauf wegen geänderter Eingaben blockiert wurde.</p></div><a data-testid="flow-published-object" href={objectLink(published.familyId, published.id)}>{published.name} öffnen · Revision {published.revision}</a></section>}
            {revisions.length > 1 && <details className="dataflow-card dataflow-revisions"><summary>Definitionshistorie ({revisions.length} Revisionen)</summary><ul>{revisions.map(revision => <li key={revision.id}>Revision {revision.revision} · {formatDate(revision.createdAt)} · <code>{revision.definitionHash.slice(0, 12)}</code></li>)}</ul></details>}
          </>}
        </>}
      </main>
    </div>
  </div>;
}
