import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { relationshipStatusLabels } from '../semantic-model-api';
import {
  fetchObjectDetail,
  fetchObjectFamilies,
  fetchObjectLinks,
  fetchObjectPage,
  type ObjectFamily,
  type ObjectHistoryEntry,
  type ObjectLinkPage,
  type ObjectPage,
  type ObjectPresence,
  type ObjectRelationshipSummary,
  type WorkspaceObject,
  type WorkspaceObjectDetail,
} from '../object-workspace-api';
import { fetchProjects, type ProjectSummary } from '../projects-api';
import '../object-workspace.css';

const PAGE_SIZE = 25;
const MAX_ROUTE_PAGE = 1_000_000;
type FilterType = 'text' | 'number' | 'boolean' | 'null';
type IdentityFilter = '' | 'unique' | 'missing' | 'duplicate';

interface WorkspaceRoute {
  projectId: string;
  familyId: string;
  objectId: string;
  setId: string;
  q: string;
  identity: IdentityFilter;
  filterField: string;
  filterType: FilterType;
  filterValue: string;
  sortBy: string;
  sortDir: 'asc' | 'desc';
  page: number;
}

interface RouteRead {
  route: WorkspaceRoute;
  isObjectRoute: boolean;
  isBareObjectRoute: boolean;
}

interface LinkState {
  loading: boolean;
  error: string;
  data: ObjectLinkPage | null;
  page: number;
}

const EMPTY_ROUTE: WorkspaceRoute = {
  projectId: '',
  familyId: '', objectId: '', setId: '', q: '', identity: '', filterField: '', filterType: 'text',
  filterValue: '', sortBy: '', sortDir: 'asc', page: 1,
};

const presenceLabels: Record<ObjectPresence, string> = {
  present: 'Vorhanden',
  ambiguous: 'Mehrdeutig',
  absent: 'Nicht vorhanden',
  key_changed: 'Schlüssel geändert',
};

const presenceTones: Record<ObjectPresence, string> = {
  present: 'is-present',
  ambiguous: 'is-ambiguous',
  absent: 'is-absent',
  key_changed: 'is-key-changed',
};

function isFilterType(value: string | null): value is FilterType {
  return value === 'text' || value === 'number' || value === 'boolean' || value === 'null';
}

function isIdentity(value: string | null): value is Exclude<IdentityFilter, ''> {
  return value === 'unique' || value === 'missing' || value === 'duplicate';
}

function safePage(value: string | null): number {
  const parsed = Number(value ?? '1');
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_ROUTE_PAGE ? parsed : 1;
}

function safeStoredPage(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_ROUTE_PAGE ? value : 1;
}

function routeFromHash(): RouteRead {
  const hash = typeof window === 'undefined' ? '' : window.location.hash;
  const withoutMarker = hash.replace(/^#\/?/, '');
  const [path = '', query = ''] = withoutMarker.split('?');
  if (path !== 'objects') return { route: { ...EMPTY_ROUTE }, isObjectRoute: false, isBareObjectRoute: false };
  const params = new URLSearchParams(query);
  const identity = params.get('identity');
  const filterType = params.get('filterType');
  const route: WorkspaceRoute = {
    projectId: params.get('project') ?? '',
    familyId: params.get('family') ?? '',
    objectId: params.get('object') ?? '',
    setId: params.get('set') ?? '',
    q: params.get('q') ?? '',
    identity: isIdentity(identity) ? identity : '',
    filterField: params.get('filterField') ?? '',
    filterType: isFilterType(filterType) ? filterType : 'text',
    filterValue: params.get('filterValue') ?? '',
    sortBy: params.get('sortBy') ?? '',
    sortDir: params.get('sortDir') === 'desc' ? 'desc' : 'asc',
    page: safePage(params.get('page')),
  };
  return { route, isObjectRoute: true, isBareObjectRoute: query.length === 0 };
}

function readStoredRoute(storageScope: string): Partial<WorkspaceRoute> | null {
  try {
    const stored = sessionStorage.getItem(`koiforge:objects:${storageScope}:route`);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as Partial<WorkspaceRoute>;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function initialRoute(storageScope: string): WorkspaceRoute {
  const hashRoute = routeFromHash();
  if (!hashRoute.isBareObjectRoute) return hashRoute.route;
  const stored = readStoredRoute(storageScope);
  if (!stored) return hashRoute.route;
  return {
    ...EMPTY_ROUTE,
    projectId: typeof stored.projectId === 'string' ? stored.projectId : '',
    familyId: typeof stored.familyId === 'string' ? stored.familyId : '',
    objectId: typeof stored.objectId === 'string' ? stored.objectId : '',
    setId: typeof stored.setId === 'string' ? stored.setId : '',
    q: typeof stored.q === 'string' ? stored.q : '',
    identity: isIdentity(typeof stored.identity === 'string' ? stored.identity : null) ? stored.identity as Exclude<IdentityFilter, ''> : '',
    filterField: typeof stored.filterField === 'string' ? stored.filterField : '',
    filterType: isFilterType(typeof stored.filterType === 'string' ? stored.filterType : null) ? stored.filterType as FilterType : 'text',
    filterValue: typeof stored.filterValue === 'string' ? stored.filterValue : '',
    sortBy: typeof stored.sortBy === 'string' ? stored.sortBy : '',
    sortDir: stored.sortDir === 'desc' ? 'desc' : 'asc',
    page: safeStoredPage(stored.page),
  };
}

function routeHash(route: WorkspaceRoute): string {
  const params = new URLSearchParams();
  if (route.projectId) params.set('project', route.projectId);
  if (route.familyId) params.set('family', route.familyId);
  if (route.objectId) params.set('object', route.objectId);
  if (route.setId) params.set('set', route.setId);
  if (route.q) params.set('q', route.q);
  if (route.identity) params.set('identity', route.identity);
  if (route.filterField) params.set('filterField', route.filterField);
  if (route.filterField && route.filterType) params.set('filterType', route.filterType);
  if (route.filterField && (route.filterType === 'null' || route.filterValue !== '')) params.set('filterValue', route.filterType === 'null' ? 'null' : route.filterValue);
  if (route.sortBy) params.set('sortBy', route.sortBy);
  if (route.sortDir !== 'asc') params.set('sortDir', route.sortDir);
  if (route.page > 1) params.set('page', String(route.page));
  const query = params.toString();
  return `#/objects${query ? `?${query}` : ''}`;
}

function persistRoute(storageScope: string, route: WorkspaceRoute): void {
  try { sessionStorage.setItem(`koiforge:objects:${storageScope}:route`, JSON.stringify(route)); } catch { /* Optional browser state. */ }
}

function jsonLiteral(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  return String(value);
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function objectHref(route: WorkspaceRoute, familyId: string, objectId: string, setId: string, resetFilters = false): string {
  return routeHash({
    ...route,
    familyId,
    objectId,
    setId,
    page: resetFilters ? 1 : route.page,
    ...(resetFilters ? { q: '', identity: '', filterField: '', filterType: 'text' as FilterType, filterValue: '' } : {}),
    ...(resetFilters ? { sortBy: '', sortDir: 'asc' as const } : {}),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Die Daten konnten nicht geladen werden.';
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function statusClass(status: string): string {
  if (status === 'linked') return 'is-present';
  if (status === 'missing_reference' || status === 'invalid_source_key') return 'is-absent';
  return 'is-ambiguous';
}

function StatusPill({ state }: { state: ObjectPresence }) {
  return <span className={`object-status ${presenceTones[state]}`}>{presenceLabels[state]}</span>;
}

function RetryButton({ onClick }: { onClick: () => void }) {
  return <button data-testid="object-workspace-retry" className="object-secondary-button" type="button" onClick={onClick}>Erneut versuchen</button>;
}

function ObjectAttributes({ object }: { object: WorkspaceObject }) {
  const entries = Object.entries(object.attributes);
  if (entries.length === 0) return <p className="object-muted">Keine Eigenschaften für diesen Stand.</p>;
  return (
    <div className="object-attribute-grid">
      {entries.map(([key, value]) => (
        <div className="object-attribute" key={key}>
          <dt>{key}</dt>
          <dd className={value === null ? 'object-null' : undefined}>{displayValue(value)}</dd>
        </div>
      ))}
    </div>
  );
}

function CandidateList({ detail }: { detail: WorkspaceObjectDetail }) {
  const candidates = detail.candidates.slice(0, 20);
  return (
    <details className="object-collapsible">
      <summary>Herkunft und Kandidaten</summary>
      <div className="object-collapsible-content">
        <dl className="object-provenance">
          <div><dt>Quelle</dt><dd>{detail.objectSet.source.name}</dd></div>
          <div><dt>Quellhash</dt><dd><code>{detail.objectSet.source.hash}</code></dd></div>
          <div><dt>Snapshot-Hash</dt><dd><code>{detail.objectSet.snapshotHash}</code></dd></div>
          <div><dt>Erfasst</dt><dd>{detail.objectSet.source.capturedAt}</dd></div>
          <div><dt>Interne Objektadresse</dt><dd><code>{detail.objectId}</code></dd></div>
        </dl>
        <p className="object-muted">Quellschlüssel: <code>{detail.keyField}</code> · {detail.candidateCount} Kandidaten</p>
        {detail.candidateCount > 20 && <p className="object-notice">Es werden höchstens 20 Kandidaten angezeigt. Weitere Kandidaten bleiben ausgeblendet.</p>}
        {candidates.length > 0 ? (
          <div className="object-candidate-list">
            {candidates.map((candidate, index) => (
              <div className="object-candidate" key={`${candidate.sourceRow}-${index}`}>
                <div><strong>Quellzeile {candidate.sourceRow}</strong><span>{presenceLabels[candidate.identity === 'unique' ? 'present' : candidate.identity === 'duplicate' ? 'ambiguous' : 'absent']}</span></div>
                <div>Schlüssel: <code>{jsonLiteral(candidate.key)}</code> · {candidate.label || 'Ohne Bezeichnung'}</div>
                <details className="object-candidate-properties">
                  <summary>Eigenschaften der Quellzeile {candidate.sourceRow}</summary>
                  <ObjectAttributes object={candidate} />
                </details>
              </div>
            ))}
          </div>
        ) : <p className="object-muted">Keine Kandidaten für diesen Stand.</p>}
      </div>
    </details>
  );
}

function HistoryList({ history, route }: { history: ObjectHistoryEntry[]; route: WorkspaceRoute }) {
  if (history.length === 0) return <p className="object-muted">Keine weiteren Stände dokumentiert.</p>;
  return (
    <>
      {history.length > 20 && <p className="object-notice">Die Historie ist gekürzt; höchstens 20 Stände werden angezeigt.</p>}
      <ul className="object-history-list">
      {history.slice(0, 20).map((entry) => (
        <li key={entry.objectSetId}>
          <a href={objectHref(route, route.familyId, route.objectId, entry.objectSetId)}>
            <span>Revision {entry.revision}</span>
            <StatusPill state={entry.state} />
          </a>
          <small>{entry.totalMatches} Treffer · {entry.sourceRows.length > 0 ? `Quellzeilen ${entry.sourceRows.join(', ')}` : 'keine Quellzeile'}</small>
        </li>
      ))}
      </ul>
    </>
  );
}

function LinkGroup({
  summary,
  route,
  state,
  onLoad,
}: {
  summary: ObjectRelationshipSummary;
  route: WorkspaceRoute;
  state?: LinkState;
  onLoad: (summary: ObjectRelationshipSummary, page: number) => void;
}) {
  const page = state?.data;
  const currentPage = state?.page ?? 1;
  const totalPages = page ? Math.max(1, Math.ceil(page.totalRows / PAGE_SIZE)) : 1;
  return (
    <details
      className="object-related-group"
      data-testid="object-related-group"
      data-relationship-id={summary.relationship.id}
      data-direction={summary.direction}
      onToggle={(event) => {
        if ((event.currentTarget as HTMLDetailsElement).open && !state?.data && !state?.loading) onLoad(summary, 1);
      }}
    >
      <summary>
        <span>{summary.relationship.name}</span>
        <span className="object-related-summary">{summary.direction === 'outgoing' ? 'Ausgehend' : 'Eingehend'} · {summary.totalRows} Zeilen</span>
      </summary>
      <div className="object-related-content">
        <p className="object-muted">Angeheftete Revision: <strong>{summary.otherSet.name}</strong> · Revision {summary.otherSet.revision}</p>
        {state?.loading && <p className="object-muted" role="status">Beziehungen werden geladen …</p>}
        {state?.error && <div className="object-inline-error" role="alert"><p>{state.error}</p><RetryButton onClick={() => onLoad(summary, currentPage)} /></div>}
        {page && (
          <>
            <div data-testid="object-links" className="object-links-table-wrap">
              {page.items.length === 0 ? <p className="object-muted">Keine zugehörigen Zeilen.</p> : (
                <table className="object-compact-table">
                  <thead><tr><th>Status</th><th>Referenz</th><th>Zielobjekt</th><th>Quellzeile</th></tr></thead>
                  <tbody>
                    {page.items.map((item) => {
                      const relatedId = item.object?.objectId;
                      const clickable = Boolean(relatedId) && item.status === 'linked';
                      return (
                        <tr key={`${item.sourceRow}-${item.object?.sourceRow ?? 'none'}-${jsonLiteral(item.reference)}`}>
                          <td><span className={`object-status ${statusClass(item.status)}`}>{relationshipStatusLabels[item.status]}</span></td>
                          <td><code>{jsonLiteral(item.reference)}</code></td>
                          <td>
                            {clickable ? (
                              <a href={objectHref({ ...route, q: '', identity: '', filterField: '', filterType: 'text', filterValue: '' }, page.otherSet.familyId, relatedId!, page.otherSet.id, true)}>
                                {item.object?.label || jsonLiteral(item.object?.key)}
                              </a>
                            ) : <span className="object-muted">{item.object?.label || 'Kein eindeutiges Ziel'}</span>}
                          </td>
                          <td>{item.sourceRow}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
            <div className="object-pagination object-pagination-small">
              <button data-testid="object-links-previous" className="object-secondary-button" type="button" disabled={currentPage <= 1} onClick={() => onLoad(summary, currentPage - 1)}>Zurück</button>
              <span>Seite {currentPage} von {totalPages}</span>
              <button data-testid="object-links-next" className="object-secondary-button" type="button" disabled={currentPage >= totalPages} onClick={() => onLoad(summary, currentPage + 1)}>Weiter</button>
            </div>
          </>
        )}
        {!state && <p className="object-muted">Beziehungen öffnen, um zugehörige Zeilen zu laden.</p>}
      </div>
    </details>
  );
}

export function ObjectWorkspaceView({ storageScope, projectOnly = false }: { storageScope: string; projectOnly?: boolean }) {
  const [route, setRoute] = useState<WorkspaceRoute>(() => initialRoute(storageScope));
  const [families, setFamilies] = useState<ObjectFamily[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState('');
  const [projectRetry, setProjectRetry] = useState(0);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState('');
  const [catalogRetry, setCatalogRetry] = useState(0);
  const [objectPage, setObjectPage] = useState<ObjectPage | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [detail, setDetail] = useState<WorkspaceObjectDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [linkStates, setLinkStates] = useState<Record<string, LinkState>>({});
  const detailHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const listHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const focusListOnNextRender = useRef(false);
  const linkAborts = useRef<Map<string, AbortController>>(new Map());
  const linkGenerations = useRef<Map<string, number>>(new Map());
  const advancedRouteActive = Boolean(route.filterField || route.sortBy || route.sortDir === 'desc');
  const [advancedOpen, setAdvancedOpen] = useState(advancedRouteActive);
  const selectedProject = useMemo(() => projects.find((project) => project.id === route.projectId) ?? null, [projects, route.projectId]);

  const abortLinks = useCallback(() => {
    for (const controller of linkAborts.current.values()) controller.abort();
    linkAborts.current.clear();
    linkGenerations.current.clear();
  }, []);

  const updateRoute = useCallback((patch: Partial<WorkspaceRoute>, replace = false) => {
    setRoute((previous) => {
      const next = { ...previous, ...patch };
      persistRoute(storageScope, next);
      const nextHash = routeHash(next);
      if (typeof window !== 'undefined' && window.location.hash !== nextHash) {
        if (replace) window.history.replaceState(null, '', nextHash);
        else window.location.hash = nextHash.slice(1);
      }
      return next;
    });
  }, [storageScope]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setProjectsLoading(true);
    setProjectsError('');
    fetchProjects(controller.signal).then((items) => {
      if (!active) return;
      setProjects(items);
      setProjectsLoading(false);
    }).catch((error: unknown) => {
      if (!active || isAbort(error)) return;
      setProjectsLoading(false);
      setProjectsError(errorMessage(error));
      setProjects([]);
    });
    return () => { active = false; controller.abort(); };
  }, [projectRetry]);

  useEffect(() => {
    if (!projectOnly || projectsLoading || projectsError || route.projectId || projects.length === 0) return;
    updateRoute({ projectId: projects[0]!.id, familyId: '', objectId: '', setId: '', q: '', identity: '', filterField: '', filterType: 'text', filterValue: '', sortBy: '', sortDir: 'asc', page: 1 }, true);
  }, [projectOnly, projects, projectsError, projectsLoading, route.projectId, updateRoute]);

  useEffect(() => {
    const syncRoute = () => {
      const parsed = routeFromHash();
      if (!parsed.isObjectRoute) return;
      const next = parsed.isBareObjectRoute ? initialRoute(storageScope) : parsed.route;
      setRoute(next);
      persistRoute(storageScope, next);
    };
    window.addEventListener('hashchange', syncRoute);
    const parsed = routeFromHash();
    if (parsed.isBareObjectRoute && readStoredRoute(storageScope)) {
      const next = initialRoute(storageScope);
      setRoute(next);
      window.history.replaceState(null, '', routeHash(next));
    }
    return () => window.removeEventListener('hashchange', syncRoute);
  }, [storageScope]);

  useEffect(() => {
    if (advancedRouteActive) setAdvancedOpen(true);
  }, [advancedRouteActive]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    if (projectsLoading || (projectOnly && !route.projectId) || (route.projectId && !selectedProject && !projectsError)) {
      setCatalogLoading(false);
      setCatalogError('');
      setFamilies([]);
      setObjectPage(null);
      setDetail(null);
      abortLinks();
      return () => { active = false; controller.abort(); abortLinks(); };
    }
    if (projectOnly && projectsError) {
      setCatalogLoading(false);
      setCatalogError(projectsError);
      setFamilies([]);
      setObjectPage(null);
      setDetail(null);
      abortLinks();
      return () => { active = false; controller.abort(); abortLinks(); };
    }
    setCatalogLoading(true);
    setCatalogError('');
    fetchObjectFamilies(controller.signal, route.projectId || undefined).then((items) => {
      if (!active) return;
      setFamilies(items);
      setCatalogLoading(false);
    }).catch((error: unknown) => {
      if (!active || isAbort(error)) return;
      setCatalogLoading(false);
      setCatalogError(errorMessage(error));
      setFamilies([]);
      setObjectPage(null);
      setDetail(null);
      abortLinks();
    });
    return () => { active = false; controller.abort(); abortLinks(); };
  }, [abortLinks, catalogRetry, projectOnly, projectsError, projectsLoading, route.projectId, selectedProject]);

  const selectedFamily = useMemo(() => families.find((family) => family.id === route.familyId) ?? null, [families, route.familyId]);

  useEffect(() => {
    if (families.length === 0 || selectedFamily || route.familyId) return;
    updateRoute({ familyId: families[0]!.id, objectId: '', setId: '', page: 1 }, true);
  }, [families, route.familyId, selectedFamily, updateRoute]);

  const availableFields = useMemo(() => {
    const activeSet = route.setId
      ? selectedFamily?.revisions.find((revision) => revision.id === route.setId) ?? (selectedFamily?.latest.id === route.setId ? selectedFamily.latest : undefined)
      : selectedFamily?.latest;
    return [...(objectPage?.objectSet.source.columns ?? activeSet?.source.columns ?? [])].sort((a, b) => a.localeCompare(b));
  }, [objectPage?.objectSet.source.columns, route.setId, selectedFamily]);

  const filterValue = useMemo(() => {
    if (!route.filterField) return undefined;
    if (route.filterType === 'null') return null;
    if (route.filterType === 'number') {
      const number = Number(route.filterValue);
      return route.filterValue.trim() !== '' && Number.isFinite(number) ? number : undefined;
    }
    if (route.filterType === 'boolean') {
      return route.filterValue === 'true' ? true : route.filterValue === 'false' ? false : undefined;
    }
    return route.filterValue;
  }, [route.filterField, route.filterType, route.filterValue]);

  useEffect(() => {
    if (!selectedFamily) {
      setObjectPage(null);
      return;
    }
    if (route.filterField && filterValue === undefined) {
      setObjectPage(null);
      setListLoading(false);
      setListError('');
      return;
    }
    const controller = new AbortController();
    let active = true;
    setObjectPage(null);
    setListLoading(true);
    setListError('');
    fetchObjectPage(selectedFamily.id, {
      projectId: route.projectId || undefined,
      setId: route.setId || undefined,
      q: route.q || undefined,
      identity: route.identity || undefined,
      filterField: route.filterField || undefined,
      filterValue,
      sortBy: route.sortBy || undefined,
      sortDir: route.sortDir,
      offset: (route.page - 1) * PAGE_SIZE,
      limit: PAGE_SIZE,
    }, controller.signal).then((page) => {
      if (!active) return;
      setObjectPage(page);
      setListLoading(false);
      const lastPage = Math.max(1, Math.ceil(page.totalRows / PAGE_SIZE));
      if (route.page > lastPage) updateRoute({ page: lastPage }, true);
    }).catch((error: unknown) => {
      if (!active || isAbort(error)) return;
      setListLoading(false);
      setObjectPage(null);
      setListError(errorMessage(error));
    });
    return () => { active = false; controller.abort(); };
  }, [filterValue, route.filterField, route.identity, route.page, route.projectId, route.q, route.setId, route.sortBy, route.sortDir, selectedFamily, updateRoute]);

  useEffect(() => {
    setDetail(null);
    setDetailError('');
    setLinkStates({});
    abortLinks();
    if (!selectedFamily || !route.objectId) {
      setDetailLoading(false);
      return;
    }
    const controller = new AbortController();
    let active = true;
    setDetailLoading(true);
    fetchObjectDetail(selectedFamily.id, route.objectId, route.setId || undefined, controller.signal, route.projectId || undefined).then((value) => {
      if (!active) return;
      setDetail(value);
      setDetailLoading(false);
    }).catch((error: unknown) => {
      if (!active || isAbort(error)) return;
      setDetailLoading(false);
      setDetailError(errorMessage(error));
    });
    return () => { active = false; controller.abort(); abortLinks(); };
  }, [abortLinks, route.objectId, route.projectId, route.setId, selectedFamily]);

  useEffect(() => {
    const heading = detailHeadingRef.current;
    if (!heading) return;
    heading.focus({ preventScroll: true });
    if (window.innerWidth <= 1100) heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [detail?.objectId, detail?.objectSet.id]);

  useEffect(() => {
    if (route.objectId || !focusListOnNextRender.current) return;
    focusListOnNextRender.current = false;
    const heading = listHeadingRef.current;
    if (!heading) return;
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [route.objectId]);

  const loadLinks = useCallback((summary: ObjectRelationshipSummary, pageNumber: number) => {
    if (!selectedFamily || !route.objectId || pageNumber < 1) return;
    const key = `${summary.relationship.id}:${summary.direction}`;
    const previous = linkAborts.current.get(key);
    previous?.abort();
    const controller = new AbortController();
    linkAborts.current.set(key, controller);
    const generation = (linkGenerations.current.get(key) ?? 0) + 1;
    linkGenerations.current.set(key, generation);
    setLinkStates((previousState) => ({ ...previousState, [key]: { loading: true, error: '', data: null, page: pageNumber } }));
    fetchObjectLinks(selectedFamily.id, route.objectId, summary.relationship.id, {
      projectId: route.projectId || undefined,
      setId: (detail?.objectSet.id ?? route.setId) || undefined,
      direction: summary.direction,
      offset: (pageNumber - 1) * PAGE_SIZE,
      limit: PAGE_SIZE,
    }, controller.signal).then((value) => {
      if (controller.signal.aborted || generation !== linkGenerations.current.get(key) || linkAborts.current.get(key) !== controller) return;
      setLinkStates((previous) => ({ ...previous, [key]: { loading: false, error: '', data: value, page: pageNumber } }));
      linkAborts.current.delete(key);
    }).catch((error: unknown) => {
      if (controller.signal.aborted || generation !== linkGenerations.current.get(key) || linkAborts.current.get(key) !== controller || isAbort(error)) return;
      setLinkStates((previous) => ({ ...previous, [key]: { loading: false, error: errorMessage(error), data: null, page: pageNumber } }));
      linkAborts.current.delete(key);
    });
  }, [detail?.objectSet.id, route.objectId, route.projectId, route.setId, selectedFamily]);

  const revisions = useMemo(() => {
    if (!selectedFamily) return [];
    const all = [selectedFamily.latest, ...selectedFamily.revisions.filter((revision) => revision.id !== selectedFamily.latest.id)];
    return all.sort((a, b) => b.revision - a.revision);
  }, [selectedFamily]);
  const totalPages = objectPage ? Math.max(1, Math.ceil(objectPage.totalRows / PAGE_SIZE)) : 1;
  const openObjectFilteredOut = Boolean(route.objectId && objectPage && !objectPage.items.some((item) => item.objectId === route.objectId));
  const relationshipGroups = detail ? [
    { direction: 'outgoing' as const, items: detail.relationships.filter((item) => item.direction === 'outgoing') },
    { direction: 'incoming' as const, items: detail.relationships.filter((item) => item.direction === 'incoming') },
  ] : [];
  const scopedCatalog = projectOnly || Boolean(route.projectId);

  const chooseProject = (projectId: string) => updateRoute({ projectId, familyId: '', objectId: '', setId: '', q: '', identity: '', filterField: '', filterType: 'text', filterValue: '', sortBy: '', sortDir: 'asc', page: 1 });
  const chooseFamily = (familyId: string) => updateRoute({ familyId, objectId: '', setId: '', q: '', identity: '', filterField: '', filterType: 'text', filterValue: '', sortBy: '', sortDir: 'asc', page: 1 });
  const chooseSet = (setId: string) => updateRoute({ setId, page: 1 });
  const clearFilter = () => updateRoute({ q: '', identity: '', filterField: '', filterType: 'text', filterValue: '', sortBy: '', sortDir: 'asc', page: 1 });
  const returnToResults = () => {
    focusListOnNextRender.current = true;
    updateRoute({ objectId: '' });
  };
  const refreshAll = () => {
    setCatalogRetry((value) => value + 1);
    setProjectRetry((value) => value + 1);
    setListError('');
    setDetailError('');
  };

  return (
    <div className="kf-object-workspace" data-testid="object-workspace">
      <div className="object-workspace-toolbar">
        <div>
          <h2>Objektbereich</h2>
          <p>Bestätigte Objekte, Stände und Beziehungen nachvollziehen.</p>
        </div>
        {selectedFamily && <div className="object-family-context"><span>{selectedProject ? 'Projekt · Familie' : 'Familie'}</span><strong>{selectedProject ? `${selectedProject.name} · ${selectedFamily.name}` : selectedFamily.name}</strong></div>}
      </div>

      {catalogLoading && <p className="object-muted" role="status">Objektfamilien werden geladen …</p>}
      {catalogError && <div className="object-alert object-alert-error" role="alert"><p>{catalogError}</p><RetryButton onClick={refreshAll} /></div>}
      {!catalogLoading && !catalogError && projectOnly && !projectsLoading && projects.length === 0 && (
        <div className="object-empty-catalog"><h3>Noch kein Projekt freigegeben</h3><p>Dir ist aktuell kein Projekt zugewiesen. Öffne den Projektbereich, um den Status zu prüfen.</p><a className="object-primary-link" href="#/projects">Zum Projektbereich</a></div>
      )}
      {!catalogLoading && !catalogError && !projectsLoading && route.projectId && !selectedProject && (
        <div className="object-empty-catalog"><h3>Projekt nicht gefunden</h3><p>Dieses Projekt ist nicht verfügbar oder wurde entzogen. Es wurde kein anderes Projekt ausgewählt.</p><a className="object-primary-link" href="#/projects">Projektbereich öffnen</a></div>
      )}
      {!catalogLoading && !catalogError && families.length === 0 && !(projectOnly && projects.length === 0) && !(route.projectId && !selectedProject) && (
        <div className="object-empty-catalog"><h3>{scopedCatalog ? 'Keine freigegebenen Objektfamilien' : 'Noch keine Objektfamilien'}</h3><p>{scopedCatalog ? 'Für dieses Projekt sind derzeit keine bestätigten Objektfamilien freigegeben.' : 'Bestätige zuerst ein Fachmodell, damit hier Objekte erscheinen.'}</p><a className="object-primary-link" href={scopedCatalog ? '#/projects' : '#/model'}>{scopedCatalog ? 'Zum Projektbereich' : 'Zum Fachmodell'}</a></div>
      )}
      {!catalogLoading && !catalogError && route.familyId && !selectedFamily && (
        <div className="object-empty-catalog"><h3>Objektfamilie nicht gefunden</h3><p>Die angeforderte Familie ist in diesem Arbeitsbereich nicht vorhanden oder nicht zugänglich.</p><button className="object-primary-link" type="button" onClick={() => updateRoute({ ...EMPTY_ROUTE, familyId: families[0]?.id ?? '' }, true)}>Objektfamilien öffnen</button></div>
      )}
      {!catalogLoading && families.length > 0 && selectedFamily && (
        <>
          <div className="object-controls">
            <label data-testid="object-project"><span>Projekt</span><select value={route.projectId} onChange={(event) => chooseProject(event.target.value)} disabled={projectOnly && projects.length === 0}>
              {!projectOnly && <option value="">Alle eigenen Modelle</option>}
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select></label>
            <label data-testid="object-family"><span>Objektfamilie</span><select value={selectedFamily?.id ?? route.familyId} onChange={(event) => chooseFamily(event.target.value)}>
              {families.map((family) => <option key={family.id} value={family.id}>{family.name}</option>)}
            </select></label>
            <label data-testid="object-revision"><span>Datenstand</span><select value={route.setId} onChange={(event) => chooseSet(event.target.value)}>
              <option value="">Aktueller Stand (Revision {selectedFamily?.latest.revision})</option>
              {revisions.filter((revision) => revision.id !== selectedFamily?.latest.id || route.setId === revision.id).map((revision) => <option key={revision.id} value={revision.id}>{revision.id === selectedFamily?.latest.id ? `Revision ${revision.revision} · aktuell angeheftet` : `Revision ${revision.revision} · ${revision.name}`}</option>)}
            </select></label>
            <label className="object-search-control"><span>Suche</span><input data-testid="object-search" value={route.q} onChange={(event) => updateRoute({ q: event.target.value, page: 1 })} placeholder="In Schlüssel, Bezeichnung und Eigenschaften suchen" /></label>
            <label data-testid="object-identity"><span>Identität</span><select value={route.identity} onChange={(event) => updateRoute({ identity: event.target.value as IdentityFilter, page: 1 })}>
              <option value="">Alle Identitäten</option><option value="unique">Eindeutig</option><option value="missing">Fehlende Identität</option><option value="duplicate">Doppelte Identität</option>
            </select></label>
            <details className="object-advanced-controls" open={advancedOpen} onToggle={(event) => setAdvancedOpen((event.currentTarget as HTMLDetailsElement).open)}>
              <summary>Filtern und sortieren</summary>
              <div className="object-advanced-controls-grid">
                <label><span>Eigenschaft</span><select data-testid="object-filter-field" value={route.filterField} onChange={(event) => updateRoute({ filterField: event.target.value, filterValue: '', page: 1 })}>
                  <option value="">Keine Eigenschaft</option>{availableFields.map((field) => <option key={field} value={field}>{field}</option>)}
                </select></label>
                <label><span>Typ</span><select data-testid="object-filter-type" value={route.filterType} onChange={(event) => updateRoute({ filterType: event.target.value as FilterType, filterValue: event.target.value === 'null' ? 'null' : '', page: 1 })}>
                  <option value="text">Text</option><option value="number">Zahl</option><option value="boolean">Wahrheitswert</option><option value="null">Null</option>
                </select></label>
                <label className="object-filter-value-control"><span>Wert</span>{route.filterType === 'boolean' ? (
                  <select data-testid="object-filter-value" value={route.filterValue} onChange={(event) => updateRoute({ filterValue: event.target.value, page: 1 })}><option value="">Auswählen …</option><option value="true">true</option><option value="false">false</option></select>
                ) : route.filterType === 'null' ? (
                  <input data-testid="object-filter-value" value="null" readOnly aria-label="Nullwert" />
                ) : <input data-testid="object-filter-value" type={route.filterType === 'number' ? 'number' : 'text'} value={route.filterValue} onChange={(event) => updateRoute({ filterValue: event.target.value, page: 1 })} placeholder={route.filterType === 'number' ? 'z. B. 0' : 'Wert'} />}{route.filterField && filterValue === undefined && <small className="object-filter-hint">Bitte einen gültigen {route.filterType === 'number' ? 'Zahlenwert' : 'Wahrheitswert'} auswählen.</small>}</label>
                <label><span>Sortierung</span><select data-testid="object-sort" value={route.sortBy} onChange={(event) => updateRoute({ sortBy: event.target.value, page: 1 })}>
                  <option value="">Standard</option>{route.sortBy && !availableFields.includes(route.sortBy) && <option value={route.sortBy}>{route.sortBy}</option>}{availableFields.map((field) => <option key={`sort-${field}`} value={field}>{field}</option>)}
                </select></label>
                <label><span>Richtung</span><select data-testid="object-sort-dir" value={route.sortDir} onChange={(event) => updateRoute({ sortDir: event.target.value as 'asc' | 'desc', page: 1 })}><option value="asc">Aufsteigend</option><option value="desc">Absteigend</option></select></label>
              </div>
            </details>
            {(route.filterField || route.q || route.identity || route.sortBy || route.sortDir === 'desc') && <button className="object-secondary-button object-clear-button" type="button" onClick={clearFilter}>Filter leeren</button>}
          </div>

          <div className="object-workspace-grid">
            <section className="object-panel object-list-panel" data-testid="object-list">
              <div className="object-panel-heading"><div><h3 ref={listHeadingRef} tabIndex={-1}>{selectedFamily?.name}</h3><p>{objectPage ? `${objectPage.totalRows} Treffer · Revision ${objectPage.objectSet.revision}` : 'Objekte'}</p></div>{route.setId && <span className="object-pin">Angehefteter Stand</span>}</div>
              {openObjectFilteredOut && <p className="object-notice" role="status">Das geöffnete Objekt ist nicht auf dieser Ergebnisseite. Es bleibt rechts geöffnet.</p>}
              {listLoading && <p className="object-muted" role="status">Objekte werden geladen …</p>}
              {listError && <div className="object-alert object-alert-error" role="alert"><p>{listError}</p><RetryButton onClick={refreshAll} /></div>}
              {objectPage && !listLoading && (
                <div className="object-table-wrap" role="region" aria-label="Objektergebnisse" tabIndex={0}>
                  {objectPage.items.length === 0 ? <p className="object-muted object-list-empty">Keine Objekte für diese Auswahl.</p> : (
                    <table className="object-compact-table">
                      <thead><tr><th>Schlüssel</th><th>Bezeichnung</th><th>Identität</th><th>Quellzeile</th></tr></thead>
                      <tbody>{objectPage.items.map((item) => {
                        const clickable = Boolean(item.objectId) && item.identity !== 'missing';
                        return <tr data-testid="object-row" data-source-row={item.sourceRow} className={route.objectId === item.objectId ? 'is-current' : undefined} key={`${item.sourceRow}-${item.objectId ?? 'missing'}`}>
                          <td>{clickable ? <a href={objectHref(route, selectedFamily!.id, item.objectId!, objectPage.objectSet.id)}><code>{jsonLiteral(item.key)}</code></a> : <code>{jsonLiteral(item.key)}</code>}</td>
                          <td>{clickable ? <a href={objectHref(route, selectedFamily!.id, item.objectId!, objectPage.objectSet.id)}>{item.label || 'Ohne Bezeichnung'}</a> : <span>{item.label || 'Ohne Bezeichnung'}</span>}</td>
                          <td><span className={`object-status ${item.identity === 'unique' ? 'is-present' : item.identity === 'duplicate' ? 'is-ambiguous' : 'is-absent'}`}>{item.identity === 'unique' ? 'Eindeutig' : item.identity === 'duplicate' ? 'Doppelt' : 'Fehlend'}</span></td>
                          <td>{item.sourceRow}</td>
                        </tr>;
                      })}</tbody>
                    </table>
                  )}
                </div>
              )}
              <div className="object-pagination"><button data-testid="object-previous" className="object-secondary-button" type="button" disabled={route.page <= 1 || listLoading} onClick={() => updateRoute({ page: route.page - 1 })}>Zurück</button><span>Seite {route.page} von {totalPages}</span><button data-testid="object-next" className="object-secondary-button" type="button" disabled={route.page >= totalPages || listLoading} onClick={() => updateRoute({ page: route.page + 1 })}>Weiter</button></div>
            </section>

            <section className="object-panel object-detail-panel" data-testid="object-detail">
              {!route.objectId && <div className="object-detail-placeholder"><h3>Objekt auswählen</h3><p>Wähle ein Objekt aus der Liste, um Schlüssel, Eigenschaften, Stände und Beziehungen zu sehen.</p></div>}
              {route.objectId && detailLoading && <p className="object-muted" role="status">Objektdetail wird geladen …</p>}
              {route.objectId && detailError && <div className="object-alert object-alert-error" role="alert"><p>{detailError}</p><RetryButton onClick={() => { setDetailError(''); setCatalogRetry((value) => value + 1); }} /></div>}
              {detail && (
                <>
                  <button className="object-secondary-button object-back-list" type="button" onClick={returnToResults}>Zur Ergebnisliste</button>
                  <div className="object-panel-heading object-detail-heading"><div><p className="object-eyebrow">{detail.objectSet.name} · Revision {detail.objectSet.revision}</p><h3 ref={detailHeadingRef} tabIndex={-1}>{detail.object?.label || `Schlüssel ${jsonLiteral(detail.key)}`}</h3><p>Schlüssel <code>{jsonLiteral(detail.key)}</code> · Feld <code>{detail.keyField}</code></p></div><StatusPill state={detail.state} /></div>
                  {route.setId && <a className="object-primary-link object-latest-link" href={objectHref(route, route.familyId, route.objectId, '', false)}>Aktuellen Stand öffnen</a>}
                  <div className="object-detail-facts"><div><dt>Datenstand</dt><dd>Revision {detail.objectSet.revision}</dd></div><div><dt>Schlüsselfeld</dt><dd><code>{detail.keyField}</code></dd></div><div><dt>Identitätsstatus</dt><dd><StatusPill state={detail.state} /></dd></div></div>
                  {detail.object ? <section className="object-detail-section"><h4>Eigenschaften</h4><dl><ObjectAttributes object={detail.object} /></dl></section> : <p className="object-notice">Für diesen Stand liegt kein eindeutig vorhandenes Objekt vor.</p>}
                  <CandidateList detail={detail} />
                  <section className="object-detail-section"><h4>Historie</h4><HistoryList history={detail.history} route={route} /></section>
                  <section className="object-detail-section"><h4>Beziehungen</h4>{relationshipGroups.map((group) => <div className="object-related-direction" key={group.direction}><h5>{group.direction === 'outgoing' ? 'Ausgehend' : 'Eingehend'}</h5>{group.items.length === 0 ? <p className="object-muted">Keine {group.direction === 'outgoing' ? 'ausgehenden' : 'eingehenden'} Beziehungen.</p> : group.items.map((summary) => <LinkGroup key={`${summary.relationship.id}:${summary.direction}`} summary={summary} route={route} state={linkStates[`${summary.relationship.id}:${summary.direction}`]} onLoad={loadLinks} />)}</div>)}</section>
                </>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
