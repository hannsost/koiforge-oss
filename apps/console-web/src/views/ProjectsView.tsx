import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import {
  createProject,
  fetchProject,
  fetchProjectFamilies,
  fetchProjects,
  fetchTeam,
  inviteTeamMember,
  regenerateTeamInvitation,
  setTeamMemberStatus,
  updateProject,
  type InvitationResult,
  type ProjectDetail,
  type ProjectFamily,
  type ProjectSummary,
  type TeamMember,
  type ProjectsApiError,
} from '../projects-api';
import '../projects.css';

interface Draft {
  name: string;
  description: string;
  familyIds: string[];
  memberIds: string[];
}

const EMPTY_DRAFT: Draft = { name: '', description: '', familyIds: [], memberIds: [] };

function projectIdFromHash(): string {
  if (typeof window === 'undefined') return '';
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (hash.split('?')[0] !== 'projects') return '';
  return new URLSearchParams(hash.split('?')[1] ?? '').get('id') ?? '';
}

function setProjectHash(id?: string): void {
  const next = id ? `#/projects?id=${encodeURIComponent(id)}` : '#/projects';
  if (typeof window !== 'undefined' && window.location.hash !== next) window.location.hash = next.slice(1);
}

function requestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `project-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function messageFor(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Die Projekte konnten nicht geladen werden.';
}

function isApiConflict(error: unknown): error is ProjectsApiError {
  return error instanceof Error && 'status' in error && (error as ProjectsApiError).status === 409;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function statusLabel(status: TeamMember['status']): string {
  return status === 'active' ? 'Aktiv' : status === 'invited' ? 'Eingeladen' : 'Deaktiviert';
}

export function ProjectsView({ storageScope: _storageScope, canManage }: { storageScope: string; canManage: boolean }) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedId, setSelectedId] = useState(projectIdFromHash);
  const [selected, setSelected] = useState<ProjectDetail | null>(null);
  const [families, setFamilies] = useState<ProjectFamily[]>([]);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [creating, setCreating] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [teamError, setTeamError] = useState('');
  const [invitation, setInvitation] = useState<InvitationResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [teamBusyId, setTeamBusyId] = useState('');
  const requestIds = useRef(new Map<string, { signature: string; id: string }>());
  const teamAbort = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const viewGeneration = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      viewGeneration.current += 1;
      teamAbort.current?.abort();
    };
  }, []);

  const reloadProjects = useCallback((signal?: AbortSignal) => {
    setLoading(true);
    return fetchProjects(signal).then((items) => {
      setProjects(items);
      setLoading(false);
      return items;
    }).catch((reason: unknown) => {
      if (isAbort(reason)) throw reason;
      setLoading(false);
      setProjects([]);
      setSelected(null);
      setSelectedId(projectIdFromHash());
      setCreating(false);
      setDraft(EMPTY_DRAFT);
      setConfirm(false);
      throw reason;
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void reloadProjects(controller.signal).catch((reason: unknown) => {
      if (!isAbort(reason)) setError(messageFor(reason));
    });
    const sync = () => {
      viewGeneration.current += 1;
      setBusy(false);
      setSelectedId(projectIdFromHash());
    };
    window.addEventListener('hashchange', sync);
    return () => { controller.abort(); window.removeEventListener('hashchange', sync); };
  }, [reloadProjects]);

  useEffect(() => {
    if (!canManage) return;
    const controller = new AbortController();
    void Promise.all([fetchProjectFamilies(controller.signal), fetchTeam(controller.signal)]).then(([availableFamilies, members]) => {
      setFamilies(availableFamilies);
      setTeam(members);
    }).catch((reason: unknown) => {
      if (!isAbort(reason)) setTeamError(messageFor(reason));
    });
    return () => controller.abort();
  }, [canManage]);

  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      setDetailLoading(false);
      if (!creating) {
        setDraft(EMPTY_DRAFT);
        setConfirm(false);
      }
      return;
    }
    const controller = new AbortController();
    setSelected(null);
    setDraft(EMPTY_DRAFT);
    setConfirm(false);
    setDetailLoading(true);
    setError('');
    void fetchProject(selectedId, controller.signal).then((project) => {
      setSelected(project);
      setCreating(false);
      setDraft({ name: project.name, description: project.description, familyIds: project.familyIds, memberIds: project.memberIds ?? [] });
      setConfirm(false);
      setDetailLoading(false);
    }).catch((reason: unknown) => {
      if (isAbort(reason)) return;
      setSelected(null);
      setDraft(EMPTY_DRAFT);
      setConfirm(false);
      setDetailLoading(false);
      setError(messageFor(reason));
    });
    return () => controller.abort();
  }, [creating, selectedId]);

  const selectProject = (id: string) => {
    setError('');
    viewGeneration.current += 1;
    setBusy(false);
    setCreating(false);
    setProjectHash(id);
    setSelectedId(id);
  };
  const startCreate = () => {
    viewGeneration.current += 1;
    setBusy(false);
    setProjectHash();
    setSelectedId('');
    setSelected(null);
    setCreating(true);
    setDraft(EMPTY_DRAFT);
    setConfirm(false);
    setError('');
  };
  const updateDraft = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setConfirm(false);
  };
  const toggleDraftItem = (field: 'familyIds' | 'memberIds', id: string) => {
    const next = draft[field].includes(id) ? draft[field].filter((item) => item !== id) : [...draft[field], id];
    updateDraft({ [field]: next });
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!canManage || !confirm || !draft.name.trim()) return;
    setBusy(true);
    setError('');
    const generation = viewGeneration.current;
    const isCurrent = () => mounted.current && generation === viewGeneration.current;
    const key = selected?.id ?? 'new';
    const signature = JSON.stringify({
      name: draft.name.trim(),
      description: draft.description.trim(),
      familyIds: draft.familyIds,
      memberIds: draft.memberIds,
      revision: selected?.revision ?? null,
    });
    const previousRequest = requestIds.current.get(key);
    const stableRequestId = previousRequest?.signature === signature ? previousRequest.id : requestId();
    requestIds.current.set(key, { signature, id: stableRequestId });
    try {
      const payload = { name: draft.name.trim(), description: draft.description.trim(), familyIds: draft.familyIds, memberIds: draft.memberIds, confirmed: true as const, requestId: stableRequestId };
      const project = selected
        ? await updateProject(selected.id, { ...payload, revision: selected.revision })
        : await createProject(payload);
      requestIds.current.delete(key);
      if (!isCurrent()) return;
      setProjects((current) => current.some((item) => item.id === project.id)
        ? current.map((item) => item.id === project.id ? { ...item, ...project, familyCount: project.familyIds.length, memberCount: project.memberIds?.length ?? 0, canManage: true } : item)
        : [...current, { id: project.id, name: project.name, description: project.description, revision: project.revision, updatedAt: project.updatedAt, familyCount: project.familyIds.length, memberCount: project.memberIds?.length ?? 0, canManage: true }]);
      setProjectHash(project.id);
      setSelectedId(project.id);
      setSelected(project);
      setCreating(false);
      setConfirm(false);
    } catch (reason: unknown) {
      if (isApiConflict(reason)) {
        requestIds.current.delete(key);
        if (!isCurrent()) return;
        setError('Das Projekt wurde inzwischen geändert. Die aktuelle Fassung wurde neu geladen. Prüfe die Freigaben erneut und speichere danach bewusst.');
        try {
          if (selected?.id) {
            const current = await fetchProject(selected.id);
            if (!isCurrent()) return;
            setSelected(current);
            setDraft({ name: current.name, description: current.description, familyIds: current.familyIds, memberIds: current.memberIds ?? [] });
          } else await reloadProjects();
        } catch { /* The original conflict message remains actionable. */ }
        if (isCurrent()) setConfirm(false);
      } else if (isCurrent()) setError(messageFor(reason));
    } finally { if (isCurrent()) setBusy(false); }
  };

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    if (!inviteEmail.trim() || !inviteName.trim()) return;
    setTeamBusyId('invite');
    setTeamError('');
    teamAbort.current?.abort();
    const controller = new AbortController();
    teamAbort.current = controller;
    try {
      const result = await inviteTeamMember(inviteEmail.trim(), inviteName.trim(), controller.signal);
      setInvitation(result);
      setInviteEmail('');
      setInviteName('');
      setCopied(false);
      setCopyError('');
      setTeam(await fetchTeam(controller.signal));
    } catch (reason: unknown) { if (!isAbort(reason)) setTeamError(messageFor(reason)); }
    finally { if (teamAbort.current === controller) setTeamBusyId(''); }
  };
  const refreshTeam = async () => {
    teamAbort.current?.abort();
    const controller = new AbortController();
    teamAbort.current = controller;
    setTeamBusyId('refresh');
    setTeamError('');
    try { setTeam(await fetchTeam(controller.signal)); }
    catch (reason: unknown) { if (!isAbort(reason)) setTeamError(messageFor(reason)); }
    finally { if (teamAbort.current === controller) setTeamBusyId(''); }
  };
  const renew = async (memberId: string) => {
    setTeamBusyId(memberId); setTeamError('');
    teamAbort.current?.abort();
    const controller = new AbortController();
    teamAbort.current = controller;
    try { setInvitation(await regenerateTeamInvitation(memberId, controller.signal)); setCopied(false); setCopyError(''); }
    catch (reason: unknown) { if (!isAbort(reason)) setTeamError(messageFor(reason)); }
    finally { if (teamAbort.current === controller) setTeamBusyId(''); }
  };
  const changeStatus = async (member: TeamMember) => {
    if (member.status === 'invited') return;
    const next = member.status === 'active' ? 'disabled' : 'active';
    setTeamBusyId(member.id); setTeamError('');
    teamAbort.current?.abort();
    const controller = new AbortController();
    teamAbort.current = controller;
    try {
      const changed = await setTeamMemberStatus(member.id, next, controller.signal);
      setTeam((current) => current.map((item) => item.id === changed.id ? changed : item));
    } catch (reason: unknown) { if (!isAbort(reason)) setTeamError(messageFor(reason)); }
    finally { if (teamAbort.current === controller) setTeamBusyId(''); }
  };

  const invitationUrl = useMemo(() => {
    if (!invitation || typeof window === 'undefined') return '';
    return `${window.location.origin}${window.location.pathname}#/join?token=${encodeURIComponent(invitation.token)}`;
  }, [invitation]);
  const copyInvitation = async () => {
    if (!invitationUrl) return;
    setCopyError('');
    try { await navigator.clipboard.writeText(invitationUrl); setCopied(true); }
    catch { setCopied(false); setCopyError('Automatisches Kopieren ist nicht verfügbar. Markiere den Link und kopiere ihn manuell.'); }
  };
  return (
    <div className="kf-project-workspace" data-testid="project-workspace">
      <div className="project-toolbar">
        <div><h2>Projekte</h2><p>Ordne bestätigte Objektfamilien einem klar begrenzten Arbeitsbereich zu.</p></div>
        {canManage && <button data-testid="project-create" className="project-primary-button" type="button" onClick={startCreate}>Projekt anlegen</button>}
      </div>
      {error && <div className="project-alert project-alert-error" role="alert">{error}</div>}
      <div className="project-layout">
        <aside className="project-catalog" aria-label="Projektkatalog">
          <div className="project-card-heading"><h3>Projektkatalog</h3><span>{projects.length}</span></div>
          {loading && <p className="project-muted" role="status">Projekte werden geladen …</p>}
          {!loading && projects.length === 0 && <p className="project-muted">Noch kein Projekt angelegt.</p>}
          <div className="project-list">{projects.map((project) => <button type="button" className={`project-list-item ${selectedId === project.id ? 'is-selected' : ''}`} key={project.id} onClick={() => selectProject(project.id)}><strong>{project.name}</strong><span>{project.familyCount} Familien · Revision {project.revision}</span></button>)}</div>
        </aside>
        <main className="project-main" data-testid={selected && !creating ? 'project-detail' : undefined}>
          {detailLoading && <p className="project-muted" role="status">Projekt wird geladen …</p>}
          {!detailLoading && creating && canManage && <ProjectEditor draft={draft} families={families} team={team} confirm={confirm} busy={busy} onDraft={updateDraft} onToggle={toggleDraftItem} onConfirm={setConfirm} onSave={save} />}
          {!detailLoading && !creating && selected && <>
            {canManage ? <ProjectEditor project={selected} draft={draft} families={families} team={team} confirm={confirm} busy={busy} onDraft={updateDraft} onToggle={toggleDraftItem} onConfirm={setConfirm} onSave={save} /> : <ProjectReaderDetail project={selected} />}
            <ProjectAccessDetails project={selected} />
          </>}
          {!detailLoading && !creating && !selected && <div className="project-empty"><h3>Projekt auswählen</h3><p>{canManage ? 'Wähle ein Projekt aus dem Katalog oder lege eines an, um die freigegebenen Objektfamilien zu sehen.' : 'Dir wurde noch kein Projekt freigegeben. Sobald ein Projekt zugewiesen ist, erscheint es hier.'}</p></div>}
        </main>
      </div>
      {canManage && <section className="project-team-card" aria-labelledby="project-team-title">
        <div className="project-card-heading"><div><h3 id="project-team-title">Teamzugänge</h3><p>Einladungen werden als einmaliger Link manuell weitergegeben.</p></div><button type="button" className="project-secondary-button" disabled={teamBusyId === 'refresh'} onClick={() => void refreshTeam()}>{teamBusyId === 'refresh' ? 'Wird aktualisiert …' : 'Team aktualisieren'}</button></div>
        {teamError && <div className="project-alert project-alert-error" role="alert">{teamError}</div>}
        <form className="project-invite-form" onSubmit={invite}><label><span>E-Mail</span><input data-testid="team-email" type="email" autoComplete="off" maxLength={254} value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} required /></label><label><span>Name</span><input data-testid="team-name" maxLength={100} value={inviteName} onChange={(event) => setInviteName(event.target.value)} required /></label><button data-testid="team-invite" className="project-secondary-button" disabled={teamBusyId === 'invite'}>{teamBusyId === 'invite' ? 'Wird eingeladen …' : 'Einladung erzeugen'}</button></form>
        {invitation && <div className="project-invitation" role="status"><strong>Link für {invitation.member.displayName}</strong><p>Gültig bis {new Date(invitation.expiresAt).toLocaleString('de-DE')}, einmal nutzbar. Bitte persönlich weitergeben; KoiForge versendet keine E-Mail.</p><div className="project-link-row"><code data-testid="team-invitation-link">{invitationUrl}</code><button type="button" className="project-secondary-button" onClick={() => void copyInvitation()}>{copied ? 'Kopiert' : 'Link kopieren'}</button></div>{copyError && <p className="project-copy-error" role="alert">{copyError}</p>}</div>}
        <div className="project-team-list">{team.map((member) => <div className="project-team-row" key={member.id}><div><strong>{member.displayName}</strong><span>{member.email}</span></div><span className={`project-status is-${member.status}`}>{statusLabel(member.status)}</span><div className="project-team-actions">{member.status === 'invited' && <button data-testid={`team-member-${member.id}`} type="button" className="project-secondary-button" disabled={teamBusyId === member.id} onClick={() => void renew(member.id)}>Link erneuern</button>}{member.status !== 'invited' && <button data-testid={`team-status-${member.id}`} type="button" className="project-secondary-button" disabled={teamBusyId === member.id} onClick={() => void changeStatus(member)}>{member.status === 'active' ? 'Deaktivieren' : 'Reaktivieren'}</button>}</div></div>)}</div>
      </section>}
    </div>
  );
}

function ProjectEditor({ project, draft, families, team, confirm, busy, onDraft, onToggle, onConfirm, onSave }: { project?: ProjectDetail; draft: Draft; families: ProjectFamily[]; team: TeamMember[]; confirm: boolean; busy: boolean; onDraft: (patch: Partial<Draft>) => void; onToggle: (field: 'familyIds' | 'memberIds', id: string) => void; onConfirm: (value: boolean) => void; onSave: (event: FormEvent) => Promise<void> }) {
  return <form className="project-editor" onSubmit={(event) => void onSave(event)}>
    <div className="project-card-heading"><div><p className="project-eyebrow">{project ? `Revision ${project.revision}` : 'Neues Projekt'}</p><h3>{project ? project.name : 'Projekt anlegen'}</h3></div></div>
    <label><span>Name</span><input data-testid="project-name" maxLength={120} value={draft.name} onChange={(event) => onDraft({ name: event.target.value })} required /></label>
    <label><span>Beschreibung</span><textarea data-testid="project-description" maxLength={1000} rows={3} value={draft.description} onChange={(event) => onDraft({ description: event.target.value })} /></label>
    <fieldset><legend>Objektfamilien</legend><p className="project-help">Eine Freigabe umfasst die gesamte bestätigte Objektfamilie: alle Eigenschaften, die bisher bestätigten Stände und zukünftige bestätigte Revisionen.</p><div className="project-check-list">{families.length === 0 ? <p className="project-muted">Keine bestätigten Objektfamilien verfügbar.</p> : families.map((family) => <label key={family.id}><input data-testid={`project-family-${family.id}`} type="checkbox" checked={draft.familyIds.includes(family.id)} onChange={() => onToggle('familyIds', family.id)} /><span><strong>{family.name}</strong><small>{family.latest ? `Aktuelle Revision ${family.latest.revision}` : 'Noch ohne Revision'}</small></span></label>)}</div></fieldset>
    <fieldset><legend>Lesende Mitglieder</legend><p className="project-help">Mitglieder sehen nur dieses Projekt und die ausgewählten Objektfamilien. Eine Einladung allein erteilt noch keinen Projektzugang.</p><div className="project-check-list">{team.length === 0 ? <p className="project-muted">Noch keine zusätzlichen Teammitglieder.</p> : team.map((member) => <label key={member.id}><input data-testid={`project-member-${member.id}`} type="checkbox" checked={draft.memberIds.includes(member.id)} disabled={member.status === 'disabled' && !draft.memberIds.includes(member.id)} onChange={() => onToggle('memberIds', member.id)} /><span><strong>{member.displayName}</strong><small>{member.email} · {statusLabel(member.status)}{member.status === 'disabled' ? (draft.memberIds.includes(member.id) ? ' · Auswahl aufheben, um die Freigabe zu entfernen' : ' · Nicht neu freigebbar') : ''}</small></span></label>)}</div></fieldset>
    <label className="project-confirm"><input data-testid="project-confirm" type="checkbox" checked={confirm} onChange={(event) => onConfirm(event.target.checked)} /><span>Ich bestätige, dass diese Auswahl die vollständige Objektfamilie inklusive bisheriger und zukünftiger bestätigter Revisionen freigibt.</span></label>
    <button data-testid="project-save" className="project-primary-button" type="submit" disabled={busy || !confirm || !draft.name.trim()}>{busy ? 'Wird gespeichert …' : project ? 'Projekt speichern' : 'Projekt anlegen'}</button>
  </form>;
}

function ProjectReaderDetail({ project }: { project: ProjectDetail }) {
  return <div className="project-reader-detail"><div className="project-card-heading"><div><p className="project-eyebrow">Lesender Zugriff · Revision {project.revision}</p><h3>{project.name}</h3></div></div><p>{project.description || 'Keine Beschreibung hinterlegt.'}</p></div>;
}

function ProjectAccessDetails({ project }: { project: ProjectDetail }) {
  return <section className="project-access-card"><h4>Freigabeumfang</h4><p>{project.familyIds.length} Objektfamilien · alle Eigenschaften · bestätigte Vergangenheit und Zukunft</p><a data-testid="project-open-objects" className="project-primary-link" href={`#/objects?project=${encodeURIComponent(project.id)}`}>Objekte öffnen</a>{project.events && project.events.length > 0 && <details><summary>Änderungsverlauf ({project.events.length})</summary><ul>{project.events.slice().reverse().map((event) => <li key={`${event.revision}-${event.at}`}>Revision {event.revision} · {event.kind === 'created' ? 'angelegt' : 'aktualisiert'} · {new Date(event.at).toLocaleString('de-DE')}</li>)}</ul></details>}</section>;
}
