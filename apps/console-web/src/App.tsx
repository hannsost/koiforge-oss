import { AgentSettingsView } from './views/AgentSettingsView';
import { AuthGate } from './components/AuthGate';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  fetchSavedViews,
  saveView,
  type ExplorerLinkSuggestion,
  type ExplorerObjectSummary,
  type SavedViewRecord,
  type SessionContext,
} from './api';
import { AipMiniCopilot, type CopilotSkillBinding } from './components/AipMiniCopilot';
import { AppShell, type NavItem } from './components/AppShell';
import { UiIcon } from './components/ProductIdentity';
import { type BoardEdge, type BoardGrouping, type BoardNode } from './components/BoardViewer';
import { BoardsView } from './views/BoardsView';
import { DataView } from './views/DataView';
import { DiscoveryView } from './views/DiscoveryView';
import { ObjectsView } from './views/ObjectsView';
import { ObjectWorkspaceView } from './views/ObjectWorkspaceView';
import { ProjectsView } from './views/ProjectsView';
import { DataflowsView } from './views/DataflowsView';
import { OperationsView } from './views/OperationsView';
import { OverviewView } from './views/OverviewView';
import { AipView } from './views/AipView';
import { AppStoreView } from './views/AppStoreView';
import { ChecksView } from './views/ChecksView';
import { PipelinesView } from './views/PipelinesView';
import { PlatformView } from './views/PlatformView';
import { InsightsView } from './views/InsightsView';
import { WorkshopView } from './views/WorkshopView';
import { MonitoringView } from './views/MonitoringView';
import { FreshnessView, type FreshnessDraft } from './views/FreshnessView';
import { MissionsView } from './views/MissionsView';
import { SemanticModelView } from './views/SemanticModelView';

type AppView = 'dataflows' | 'projects' | 'model' | 'missions' | 'agents' | 'freshness' | 'overview' | 'data' | 'objects' | 'object-preview' | 'boards' | 'discovery' | 'operations' | 'insights' | 'platform' | 'appstore' | 'pipelines' | 'checks' | 'aip' | 'workshop' | 'monitoring';

const viewMeta: Record<AppView, { title: string; subtitle: string }> = {
  dataflows: { title: 'Datenflüsse', subtitle: 'Bestätigte Quellen verbinden, Ergebnisse prüfen und kontrolliert veröffentlichen.' },
  projects: { title: 'Projekte', subtitle: 'Bestätigte Modelle gezielt freigeben und gemeinsam nachvollziehen.' },
  missions: { title: 'Aufträge', subtitle: 'Ein Ziel, ein nachvollziehbarer Plan und ein belegtes Ergebnis.' },
  model: { title: 'Fachmodell', subtitle: 'Bedeutung, Identitäten und Beziehungen ausdrücklich bestätigen und nachvollziehen.' },
  agents: { title: 'Agenten & KI', subtitle: 'Anbieter, Modell und Arbeitsweise für deinen Arbeitsbereich.' },
  freshness: { title: 'Auswertungen', subtitle: 'Daten prüfen, Ergebnisse nachvollziehen und offene Fragen klären.' },
  overview: { title: 'Übersicht', subtitle: 'Quellen, Verknüpfungen und letzte Vorgänge im Überblick.' },
  data: { title: 'Datenquellen', subtitle: 'Quellen hinzufügen, Daten prüfen und gespeicherte Ansichten verwalten.' },
  objects: { title: 'Objekte', subtitle: 'Geschäftsobjekte durchsuchen, Beziehungen verfolgen und ihre Entwicklung nachvollziehen.' },
  'object-preview': { title: 'Quellvorschau', subtitle: 'Automatisch abgeleitete Vorschläge aus Quellenausschnitten prüfen und auf Boards sammeln.' },
  boards: { title: 'Boards', subtitle: 'Objekte auf Boards sammeln, verknüpfen und gemeinsam betrachten.' },
  discovery: { title: 'Verknüpfungen', subtitle: 'Beziehungen erkennen, Zuordnungen prüfen und Datenmodelle verstehen.' },
  operations: { title: 'Datenherkunft', subtitle: 'Herkunft, Verarbeitungsschritte und letzte Durchläufe nachvollziehen.' },
  insights: { title: 'Diagramme', subtitle: 'Daten mit passenden Diagrammen vergleichen und Zusammenhänge erkennen.' },
  platform: { title: 'Einstellungen', subtitle: 'Zugänge, Verbindungen und Einstellungen des Arbeitsbereichs verwalten.' },
  appstore: { title: 'Erweiterungen', subtitle: 'Erweiterungen entdecken, verwalten und eigene Apps bereitstellen.' },
  pipelines: { title: 'Daten aufbereiten', subtitle: 'Daten filtern, zusammenführen und für die nächste Auswertung vorbereiten.' },
  checks: { title: 'Datenqualität', subtitle: 'Prüfregeln definieren und Daten auf Vollständigkeit und Korrektheit prüfen.' },
  aip: { title: 'KI-Assistent', subtitle: 'Fragen zu deinen Daten stellen und Vorschläge mit einem eingerichteten KI-Modell erarbeiten.' },
  workshop: { title: 'Dashboards gestalten', subtitle: 'Datenansichten, Kennzahlen und Aktionen zu eigenen Dashboards zusammenstellen.' },
  monitoring: { title: 'Monitoring', subtitle: 'Plattformzustand, Sensoren, Verfügbarkeit und Zeitreihen im Überblick.' },
};

function viewFromLocation(projectOnly = false): AppView {
  const id = window.location.hash.replace(/^#\/?/, '').split('?')[0]!;
  if (projectOnly && !['projects', 'objects'].includes(id)) return 'projects';
  return Object.prototype.hasOwnProperty.call(viewMeta, id) ? id as AppView : 'freshness';
}

export default function App() {
  return <AuthGate>{(session, logout) => <Workspace key={session.user.id} session={session} logout={logout} />}</AuthGate>;
}
function Workspace({ session, logout }: { session: SessionContext; logout: () => Promise<void> }) {
  const projectOnly = session.roleIds.includes('project_reader');
  const [logoutError, setLogoutError] = useState('');
  const [activeView, setActiveView] = useState<AppView>(() => viewFromLocation(projectOnly));
  const navigate = useCallback((view: AppView) => {
    const next = projectOnly && !['projects', 'objects'].includes(view) ? 'projects' : view;
    window.location.hash = `/${next}`;
    setActiveView(next);
  }, [projectOnly]);
  useEffect(() => {
    const sync = () => {
      const next = viewFromLocation(projectOnly);
      if (projectOnly && !['projects', 'objects'].includes(window.location.hash.replace(/^#\/?/, '').split('?')[0]!)) {
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/projects`);
      }
      setActiveView(next);
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [projectOnly]);
  const [copilotSkillBinding, setCopilotSkillBinding] = useState<CopilotSkillBinding | null>(null);
  const [analysisDraft, setAnalysisDraft] = useState<FreshnessDraft>();

  // Board state is cross-view: ObjectsView adds to it, BoardsView displays it
  const [boardNodes, setBoardNodes] = useState<BoardNode[]>([]);
  const [boardEdges, setBoardEdges] = useState<BoardEdge[]>([]);
  const [boardGroupBy, setBoardGroupBy] = useState<BoardGrouping>('type');
  const [boardViews, setBoardViews] = useState<SavedViewRecord[]>([]);
  const [boardViewName, setBoardViewName] = useState('');
  const [linkSourceNodeId, setLinkSourceNodeId] = useState<string | null>(null);

  useEffect(() => {
    if (!projectOnly) fetchSavedViews('board-viewer').then(setBoardViews).catch(console.error);
  }, [projectOnly]);

  const addObjectToBoard = useCallback((object: ExplorerObjectSummary) => {
    setBoardNodes((current) => {
      const nodeId = `${object.type}:${object.id}`;
      if (current.some((n) => n.id === nodeId)) return current;
      const status = typeof object.attributes.status === 'string' ? object.attributes.status : undefined;
      const statusConflict = object.attributes.statusConflict === true;
      const riskScore = typeof object.attributes.riskScore === 'number' ? object.attributes.riskScore : null;
      const value = typeof object.attributes.value === 'number' ? object.attributes.value : null;
      const accentTone =
        statusConflict || status === 'delayed' || status === 'watchlist' ? 'danger' :
        status === 'review' || status === 'pending' ? 'warning' :
        riskScore !== null && riskScore >= 35 ? 'warning' :
        value !== null && value >= 40000 ? 'warning' : 'success';
      return [...current, { id: nodeId, objectId: object.id, objectType: object.type, title: object.title, subtitle: object.subtitle, status, accentTone, x: 24 + current.length * 24, y: 24 + current.length * 24 }];
    });
  }, []);

  const applyBoardSuggestion = useCallback((suggestion: ExplorerLinkSuggestion) => {
    setBoardNodes((current) => {
      const next = [...current];
      const sourceId = `${suggestion.fromType}:${suggestion.fromId}`;
      const targetId = `${suggestion.toType}:${suggestion.toId}`;
      const tone = (label: string) => label === 'high' ? 'success' : label === 'medium' ? 'warning' : 'danger';
      if (!next.some((n) => n.id === sourceId)) next.push({ id: sourceId, objectId: suggestion.fromId, objectType: suggestion.fromType, title: suggestion.fromTitle, subtitle: suggestion.fromSubtitle, status: suggestion.fromStatus, accentTone: tone(suggestion.confidenceLabel), x: 24 + next.length * 24, y: 24 + next.length * 24 });
      if (!next.some((n) => n.id === targetId)) next.push({ id: targetId, objectId: suggestion.toId, objectType: suggestion.toType, title: suggestion.toTitle, subtitle: suggestion.toSubtitle, status: suggestion.toStatus, accentTone: tone(suggestion.confidenceLabel), x: 24 + next.length * 24, y: 24 + next.length * 24 });
      return next;
    });
    setBoardEdges((current) => {
      const edgeId = `${suggestion.fromType}:${suggestion.fromId}->${suggestion.toType}:${suggestion.toId}`;
      if (current.some((e) => e.id === edgeId)) return current;
      return [...current, { id: edgeId, fromId: `${suggestion.fromType}:${suggestion.fromId}`, toId: `${suggestion.toType}:${suggestion.toId}` }];
    });
  }, []);

  const saveBoardView = useCallback(async () => {
    if (!boardViewName.trim()) return;
    await saveView({ type: 'board-viewer', name: boardViewName.trim(), state: { nodes: boardNodes, edges: boardEdges, groupBy: boardGroupBy } });
    setBoardViewName('');
    setBoardViews(await fetchSavedViews('board-viewer'));
  }, [boardEdges, boardGroupBy, boardNodes, boardViewName]);

  const applyBoardView = useCallback((view: SavedViewRecord) => {
    const state = view.state as { nodes?: BoardNode[]; edges?: BoardEdge[]; groupBy?: BoardGrouping };
    setBoardNodes(state.nodes ?? []);
    setBoardEdges(state.edges ?? []);
    setBoardGroupBy(state.groupBy ?? 'type');
    setLinkSourceNodeId(null);
  }, []);

  const navItems = useMemo<NavItem[]>(() => ([
    { id: 'projects', group: 'Arbeitsbereich', label: 'Projekte' },
    { id: 'missions', group: 'Arbeitsbereich', label: 'Aufträge' },
    { id: 'model', group: 'Arbeitsbereich', label: 'Fachmodell' },
    { id: 'dataflows', group: 'Arbeitsbereich', label: 'Datenflüsse' },
    { id: 'objects', group: 'Arbeitsbereich', label: 'Objekte' },
    { id: 'freshness', group: 'Arbeitsbereich', label: 'Auswertungen' },
    { id: 'data', group: 'Arbeitsbereich', label: 'Datenquellen' },
    { id: 'aip', group: 'Arbeitsbereich', label: 'KI-Assistent' },
    { id: 'overview', group: 'Werkzeuge', label: 'Übersicht' },
    { id: 'insights', group: 'Werkzeuge', label: 'Diagramme' },
    { id: 'pipelines', group: 'Werkzeuge', label: 'Quelltransformationen' },
    { id: 'checks', group: 'Werkzeuge', label: 'Datenqualität' },
    { id: 'object-preview', group: 'Werkzeuge', label: 'Quellvorschau' },
    { id: 'boards', group: 'Werkzeuge', label: 'Boards', value: boardNodes.length > 0 ? String(boardNodes.length) : undefined },
    { id: 'discovery', group: 'Werkzeuge', label: 'Verknüpfungen' },
    { id: 'operations', group: 'Werkzeuge', label: 'Datenherkunft' },
    { id: 'workshop', group: 'Werkzeuge', label: 'Dashboards gestalten' },
    { id: 'monitoring', group: 'Werkzeuge', label: 'Monitoring' },
    { id: 'appstore', group: 'Verwaltung', label: 'Erweiterungen' },
    { id: 'agents', group: 'Verwaltung', label: 'Agenten & KI' },
    { id: 'platform', group: 'Verwaltung', label: 'Einstellungen' },
  ] as NavItem[]).filter(item => !projectOnly || ['projects', 'objects'].includes(item.id)), [boardNodes.length, projectOnly]);

  const sidebarSession = <>
    <div className="nf-sidebar-user">
      <span className="nf-sidebar-avatar" aria-hidden="true">{session.user.displayName?.slice(0, 1) || 'K'}</span>
      <div className="nf-sidebar-user-copy"><span title={session.user.displayName}>{session.user.displayName}</span><small>{projectOnly ? 'Projektleser' : 'Inhaber'}</small></div>
    </div>
    <button type="button" className="nf-sidebar-logout" onClick={() => void logout().catch(() => setLogoutError('Abmelden fehlgeschlagen. Bitte erneut versuchen.'))}><UiIcon name="logout" size={20} /><span>Abmelden</span></button>
    {logoutError && <p className="nf-sidebar-session-error" role="alert">{logoutError}</p>}
  </>;

  const renderActiveView = () => {
    switch (activeView) {
      case 'dataflows': return <DataflowsView storageScope={`${session.tenant.id}:${session.user.id}`} />;
      case 'projects': return <ProjectsView storageScope={`${session.tenant.id}:${session.user.id}`} canManage={!projectOnly && session.permissions.includes('projects.manage')} />;
      case 'missions': return <MissionsView storageScope={`${session.tenant.id}:${session.user.id}`} />;
      case 'model': return <SemanticModelView storageScope={`${session.tenant.id}:${session.user.id}`} />;
      case 'freshness': return <FreshnessView draft={analysisDraft} onDraftChange={setAnalysisDraft} initialDatasetId={new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('dataset') ?? ''} onOpenSources={() => navigate('data')} />;
      case 'data': return <DataView onAnalyze={datasetId => { window.location.hash = `/freshness?dataset=${encodeURIComponent(datasetId)}`; setActiveView('freshness'); }} />;
      case 'objects': return <ObjectWorkspaceView projectOnly={projectOnly} storageScope={`${session.tenant.id}:${session.user.id}`} />;
      case 'object-preview': return <ObjectsView onAddObjectToBoard={addObjectToBoard} />;
      case 'boards': return (
        <BoardsView
          boardEdges={boardEdges}
          boardGroupBy={boardGroupBy}
          boardViewName={boardViewName}
          boardViews={boardViews}
          linkSourceNodeId={linkSourceNodeId}
          boardNodes={boardNodes}
          onApplyBoardSuggestion={applyBoardSuggestion}
          onApplyBoardView={applyBoardView}
          onBoardGroupByChange={setBoardGroupBy}
          onBoardViewNameChange={setBoardViewName}
          onChangeBoardEdges={setBoardEdges}
          onChangeBoardNodes={setBoardNodes}
          onChangeLinkSource={setLinkSourceNodeId}
          onSaveBoardView={() => void saveBoardView()}
        />
      );
      case 'discovery': return <DiscoveryView />;
      case 'operations': return <OperationsView />;
      case 'insights': return <InsightsView />;
      case 'platform': return <PlatformView session={session} />;
      case 'appstore': return <AppStoreView />;
      case 'pipelines': return <PipelinesView onCopilotBindingChange={setCopilotSkillBinding} />;
      case 'checks': return <ChecksView />;
      case 'agents': return <AgentSettingsView session={session} />;
      case 'aip': return <AipView />;
      case 'workshop': return <WorkshopView />;
      case 'monitoring': return <MonitoringView />;
      default: return <OverviewView />;
    }
  };

  return (
    <AppShell
      hideHeading={activeView === 'agents' || activeView === 'aip'}
      activeView={activeView}
      headerActions={!projectOnly && activeView !== 'dataflows' && activeView !== 'projects' && activeView !== 'missions' && activeView !== 'model' && activeView !== 'objects' && (
        <AipMiniCopilot
          activePageLabel={viewMeta[activeView].title}
          skillBinding={copilotSkillBinding}
        />
      )}
      sidebarSession={sidebarSession}
      navItems={navItems}
      onNavigate={(id) => navigate(id as AppView)}
      workspaceName={session?.tenant.name}
      subtitle={viewMeta[activeView].subtitle}
      title={viewMeta[activeView].title}
    >
      {renderActiveView()}
    </AppShell>
  );
}
