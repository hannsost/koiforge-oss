import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  configureImportNode,
  createImportSession,
  fetchImportSession,
  repairImportSession,
  runImportSession,
  type DatasetRecord,
  type ImportSessionRecord,
  type ImportTreeNode,
  updateImportSessionSelection,
} from '../api';
import { ActionButton, Badge, DataTable, ghostBtnCls, inputCls, selectCls } from './ui';

const MAX_IMPORT_FILES = 8;
const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;

const sessionStatusLabels: Record<ImportSessionRecord['status'], string> = {
  staged: 'Dateien empfangen',
  discovered: 'Quellen erkannt',
  running: 'Import läuft',
  completed: 'Import abgeschlossen',
  needs_review: 'Prüfung erforderlich',
  failed: 'Import fehlgeschlagen',
};

const nodeStatusLabels: Record<ImportTreeNode['status'], string> = {
  group: 'Gruppe',
  ready: 'Bereit',
  needs_input: 'Angaben erforderlich',
  gap: 'Import nicht verfügbar',
  importing: 'Import läuft',
  imported: 'Importiert',
  failed: 'Import fehlgeschlagen',
};

const gapActionLabels: Record<string, string> = {
  apply_existing: 'Vorhandenen Importweg anwenden',
  collect_input: 'Angaben sammeln',
  blocked: 'Blockiert',
  reuse_existing: 'Vorhandenen Importweg verwenden',
  ask_user_input: 'Angaben ergänzen',
  compose_existing: 'Vorhandene Importwege kombinieren',
  extend_existing: 'Importweg erweitern',
  acquire_runtime: 'Laufzeitumgebung bereitstellen',
  generate_adapter: 'Adapter erzeugen',
  reload_runtime: 'Laufzeit neu laden',
  resume_discovery: 'Erkennung fortsetzen',
};

const gapDimensionLabels: Record<string, string> = {
  classify_source: 'Quelle einordnen',
  inspect_source: 'Quelle untersuchen',
  ask_input: 'Angaben abfragen',
  runtime_strategy: 'Laufzeitstrategie',
  tool_acquisition: 'Werkzeug beschaffen',
  adapter_generation: 'Adapter erzeugen',
  discover_entities: 'Datenobjekte erkennen',
  preview_rows: 'Datenzeilen anzeigen',
  import_entity: 'Datenobjekt importieren',
  runtime_reload: 'Laufzeit neu laden',
};

const sourceClassLabels: Record<string, string> = {
  archive_or_bundle: 'Archiv oder Paket',
  connection_config: 'Verbindungsdaten',
  structured_text: 'Strukturierter Text',
  tabular_text: 'Tabellarischer Text',
  binary_structured: 'Binärformat mit Struktur',
  binary_runtime_candidate: 'Binärformat mit Laufzeitbedarf',
  database_entity: 'Datenbankobjekt',
  mixed_source: 'Gemischte Quelle',
  unknown_source: 'Unbekannte Quelle',
};

const kindLabels: Record<ImportTreeNode['kind'], string> = {
  folder: 'Ordner',
  archive: 'Archiv',
  file: 'Datei',
  'excel-workbook': 'Excel-Arbeitsmappe',
  sheet: 'Tabellenblatt',
  'json-array': 'JSON-Liste',
  'xml-table': 'XML-Tabelle',
  'sqlite-database': 'SQLite-Datenbank',
  'db-table': 'Datenbanktabelle',
  'db-connection': 'Datenbankverbindung',
};

const repairStatusLabels: Record<string, string> = {
  planned: 'Geplant',
  running: 'Läuft',
  implemented: 'Umsetzung abgeschlossen',
  verified: 'Geprüft',
  failed: 'Fehlgeschlagen',
  blocked: 'Blockiert',
};

const executionStatusLabels: Record<string, string> = {
  running: 'Läuft',
  completed: 'Abgeschlossen',
  blocked: 'Blockiert',
  failed: 'Fehlgeschlagen',
};

const planTypeLabels: Record<string, string> = {
  reuse_existing: 'Vorhandenen Importweg verwenden',
  reuse_with_input: 'Vorhandenen Importweg mit Angaben verwenden',
  compose_existing: 'Vorhandene Importwege kombinieren',
  extend_existing: 'Importweg erweitern',
  acquire_runtime: 'Laufzeitumgebung bereitstellen',
  generate_adapter: 'Adapter erzeugen',
  reload_runtime: 'Laufzeit neu laden',
  resume_discovery: 'Erkennung fortsetzen',
  blocked: 'Blockiert',
};

const runtimeFamilyLabels: Record<string, string> = {
  direct_parser: 'Direkter Parser',
  embedded_runtime: 'Eingebettete Laufzeit',
  connection_runtime: 'Verbindungslaufzeit',
  driver_bridge: 'Treiberschnittstelle',
  external_tool_bridge: 'Schnittstelle zu externem Werkzeug',
  adapter_layer: 'Adapterebene',
  none: 'Keine',
};

const acquisitionPathLabels: Record<string, string> = {
  builtin_capability: 'Vorhandene KoiForge-Funktion',
  existing_runtime: 'Vorhandene Laufzeit',
  dependency_install: 'Abhängigkeit installieren',
  system_driver: 'Systemtreiber',
  service_binding: 'Dienstanbindung',
  tool_bridge: 'Werkzeugschnittstelle',
  generated_adapter: 'Erzeugter Adapter',
  manual_input: 'Manuelle Angaben',
  none: 'Keine',
};

const executionGoalLabels: Record<string, string> = {
  open_source: 'Quelle öffnen',
  enumerate_entities: 'Datenobjekte auflisten',
  describe_schema: 'Schema beschreiben',
  preview_rows: 'Datenzeilen anzeigen',
  stream_rows_for_import: 'Datenzeilen für Import lesen',
  register_import_path: 'Importweg registrieren',
};

const importLevelLabels: Record<string, string> = {
  info: 'Info',
  warning: 'Hinweis',
  error: 'Fehler',
};

const capabilityKindLabels: Record<string, string> = {
  connector: 'Verbindung',
  plugin: 'Erweiterung',
  parser: 'Parser',
  discovery: 'Erkennung',
  repair: 'Reparatur',
};

const formFieldLabels: Record<string, string> = {
  connectorId: 'Verbindungstyp',
  datasetName: 'Name der Datenquelle',
  namespace: 'Datenbereich',
  mode: 'Speichermodus',
  delimiter: 'Trennzeichen',
  host: 'Server',
  port: 'Port',
  database: 'Datenbank',
  user: 'Benutzername',
  password: 'Passwort',
  schema: 'Schema',
  table: 'Tabelle',
  uri: 'Verbindungsadresse',
  collection: 'Sammlung',
  formatDescription: 'Formatbeschreibung',
  validationFixtures: 'Prüfbeispiele (JSON)',
};

const formOptionLabels: Record<string, string> = {
  materialized: 'Gespeicherte Daten',
  virtual: 'Virtuelle Daten',
  ',': 'Komma (,)',
  ';': 'Semikolon (;)',
  '\t': 'Tabulator',
  '|': 'Senkrechter Strich (|)',
};

function translatedLabel(labels: Record<string, string>, value: string, fallback = 'Unbekannt'): string {
  return labels[value] ?? fallback;
}

function formTitle(title: string): string {
  if (title === 'CSV Import') return 'CSV-Import';
  if (title.startsWith('Configure ')) return 'Datenbankverbindung einrichten';
  if (title.includes('SQL INSERT') || title.includes('SQL Dump')) return 'SQL-Tabellenimport';
  if (title.includes('Generated Plugin Table')) return 'Tabellenimport über erkannte Erweiterung';
  if (title.includes('Generated Plugin')) return 'Import über erkannte Erweiterung';
  return title;
}

function formDescription(title: string, description?: string): string | undefined {
  if (title === 'CSV Import') return 'Prüfe die erkannte CSV-Struktur und ergänze Name und Datenbereich.';
  if (title.startsWith('Configure ')) return 'Ergänze oder korrigiere die fehlenden Verbindungsangaben vor dem Import.';
  if (title.includes('Generated Plugin Table')) return 'Prüfe die aus der Quelle erkannten Tabellen und ergänze die Importangaben.';
  if (title.includes('Generated Plugin')) return 'Prüfe die erkannte Struktur und ergänze die Importangaben.';
  if (title.includes('SQL INSERT') || title.includes('SQL Dump')) return 'Prüfe die aus dem SQL-Dump erkannten Tabellen und ergänze die Importangaben.';
  return description;
}

function formFieldLabel(key: string, fallback: string): string {
  return formFieldLabels[key] ?? fallback;
}

function formPlaceholder(value?: string): string | undefined {
  if (value === 'Required') return 'Erforderlich';
  if (value === 'Optional') return 'Optional';
  if (value === 'leave empty for discovery only') return 'Für die Erkennung leer lassen';
  return value;
}

function formFieldDescription(key: string, description?: string): string | undefined {
  if (key === 'validationFixtures') return 'Mindestens zwei synthetische Prüfbeispiele mit Ergebnis und ein Beispiel, das abgewiesen werden soll.';
  if (key === 'table' || key === 'collection') return 'Optional; für die reine Erkennung leer lassen.';
  return description;
}

interface ImportWorkspaceDialogProps {
  onClose: () => void;
  onCompleted: (datasets: DatasetRecord[]) => void;
}

function statusTone(status: ImportTreeNode['status'] | 'running' | 'completed' | 'blocked'): 'neutral' | 'success' | 'warning' | 'danger' {
  if (status === 'imported' || status === 'ready') return 'success';
  if (status === 'needs_input' || status === 'group' || status === 'running') return 'warning';
  if (status === 'completed') return 'success';
  if (status === 'blocked') return 'danger';
  if (status === 'gap' || status === 'failed') return 'danger';
  return 'neutral';
}

function gapTone(action: string): 'neutral' | 'success' | 'warning' | 'danger' {
  if (action === 'reuse_existing') return 'success';
  if (action === 'ask_user_input' || action === 'compose_existing') return 'warning';
  if (action === 'extend_existing' || action === 'acquire_runtime' || action === 'generate_adapter' || action === 'reload_runtime' || action === 'resume_discovery') return 'danger';
  return 'neutral';
}

function firstInterestingNode(session: ImportSessionRecord | null): string | null {
  if (!session) return null;
  const preferred = Object.values(session.nodes).find((node) => node.capabilityId);
  return preferred?.id ?? session.rootNodeIds[0] ?? null;
}

export function ImportWorkspaceDialog(props: ImportWorkspaceDialogProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog?.showModal();
    // Close before React removes the dialog; passive cleanup is too late for
    // the browser to restore focus after a successful import or Escape.
    return () => {
      dialog?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  const [dragOver, setDragOver] = useState(false);
  const [session, setSession] = useState<ImportSessionRecord | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [uploadBusy, setUploadBusy] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [repairBusy, setRepairBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [importedDatasets, setImportedDatasets] = useState<DatasetRecord[]>([]);
  const [error, setError] = useState('');
  const [draftConfig, setDraftConfig] = useState<Record<string, string | number | boolean>>({});

  const selectedNode = session && selectedNodeId ? session.nodes[selectedNodeId] ?? null : null;
  const selectedGap = useMemo(
    () => (session && selectedNode ? session.gaps.find((gap) => gap.nodeId === selectedNode.id && gap.status === 'open') ?? null : null),
    [selectedNode, session],
  );
  const selectedRepairTrace = useMemo(
    () => (session && selectedNode ? session.repairHistory.find((trace) => trace.nodeId === selectedNode.id) ?? null : null),
    [selectedNode, session],
  );
  const selectedExecutionTask = useMemo(
    () => (session && selectedNode ? session.executionTasks.find((task) => task.nodeId === selectedNode.id) ?? null : null),
    [selectedNode, session],
  );
  const openGaps = useMemo(() => (session?.gaps ?? []).filter((gap) => gap.status === 'open'), [session]);
  const selectedLeafNodes = useMemo(
    () => (session?.selectedNodeIds ?? [])
      .map((nodeId) => session?.nodes[nodeId])
      .filter((node): node is ImportTreeNode => node !== undefined && node.children.length === 0),
    [session],
  );

  useEffect(() => {
    if (!selectedNode) {
      setDraftConfig({});
      return;
    }
    setDraftConfig(selectedNode.config ?? {});
  }, [selectedNodeId, selectedNode]);

  useEffect(() => {
    if (!session || (session.status !== 'running' && !session.executionTasks.some((task) => task.status === 'running'))) {
      return undefined;
    }

    let cancelled = false;
    const handle = window.setInterval(() => {
      void fetchImportSession(session.id)
        .then((fresh) => {
          if (cancelled) return;
          setSession(fresh);
          if (!selectedNodeId) {
            setSelectedNodeId(firstInterestingNode(fresh));
          }
        })
        .catch(() => {
          // Keep the last good session in the UI if a poll fails.
        });
    }, 4000);

    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [selectedNodeId, session]);

  const selectedIds = useMemo(() => new Set(session?.selectedNodeIds ?? []), [session]);

  const descendantsOf = useCallback((nodeId: string, current: ImportSessionRecord | null): string[] => {
    if (!current) return [];
    const collected: string[] = [];
    const walk = (id: string) => {
      collected.push(id);
      const node = current.nodes[id];
      if (!node) return;
      for (const childId of node.children) {
        walk(childId);
      }
    };
    walk(nodeId);
    return collected;
  }, []);

  const expandDefaults = useCallback((current: ImportSessionRecord) => {
    const next: Record<string, boolean> = {};
    for (const node of Object.values(current.nodes)) {
      if (node.children.length > 0) {
        next[node.id] = node.parentId == null;
      }
    }
    setExpanded(next);
  }, []);

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    const all = Array.from(files);
    if (all.length === 0) return;

    const errors: string[] = [];
    if (all.length > MAX_IMPORT_FILES) {
      errors.push(`Bitte höchstens ${MAX_IMPORT_FILES} Dateien auswählen (ausgewählt: ${all.length}).`);
    }
    const emptyFiles = all.filter((file) => file.size === 0).map((file) => file.name || 'Unbenannte Datei');
    if (emptyFiles.length > 0) {
      errors.push(`Leere Dateien können nicht importiert werden: ${emptyFiles.join(', ')}.`);
    }
    const oversizedFiles = all
      .filter((file) => file.size > MAX_IMPORT_FILE_BYTES)
      .map((file) => file.name || 'Unbenannte Datei');
    if (oversizedFiles.length > 0) {
      errors.push(`Diese Dateien überschreiten die Grenze von 10 MiB: ${oversizedFiles.join(', ')}.`);
    }
    if (errors.length > 0) {
      setError(errors.join(' '));
      return;
    }

    setUploadBusy(true);
    setError('');
    try {
      const created = await createImportSession(all);
      setSession(created);
      setSelectedNodeId(firstInterestingNode(created));
      expandDefaults(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Die Importprüfung konnte nicht gestartet werden.');
    } finally {
      setUploadBusy(false);
    }
  }, [expandDefaults]);

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setDragOver(false);
    if (event.dataTransfer.files.length > 0) {
      void handleFiles(event.dataTransfer.files);
    }
  }, [handleFiles]);

  const toggleExpanded = useCallback((nodeId: string) => {
    setExpanded((prev) => ({ ...prev, [nodeId]: !prev[nodeId] }));
  }, []);

  const toggleSelection = useCallback(async (nodeId: string, checked: boolean) => {
    if (!session) return;
    const affected = descendantsOf(nodeId, session);
    const next = new Set(session.selectedNodeIds);
    if (checked) {
      for (const id of affected) next.add(id);
    } else {
      for (const id of affected) next.delete(id);
    }
    try {
      const updated = await updateImportSessionSelection(session.id, [...next]);
      setSession(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Die Auswahl konnte nicht gespeichert werden.');
    }
  }, [descendantsOf, session]);

  const saveConfig = useCallback(async () => {
    if (!session || !selectedNode) return;
    setSaveBusy(true);
    setError('');
    try {
      const updated = await configureImportNode(session.id, selectedNode.id, draftConfig);
      setSession(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Die Angaben konnten nicht gespeichert werden.');
    } finally {
      setSaveBusy(false);
    }
  }, [draftConfig, selectedNode, session]);

  const runImport = useCallback(async () => {
    if (!session) return;
    setRunBusy(true);
    setError('');
    try {
      const result = await runImportSession(session.id, session.selectedNodeIds);
      setSession(result.session);
      if (result.importedDatasets.length > 0) {
        const byId = new Map(importedDatasets.map(dataset => [dataset.id, dataset]));
        for (const dataset of result.importedDatasets) byId.set(dataset.id, dataset);
        const allImported = [...byId.values()];
        setImportedDatasets(allImported);
        const incompleteSelectedNodes = result.session.selectedNodeIds
          .map((nodeId) => result.session.nodes[nodeId])
          .filter((node): node is ImportTreeNode => node !== undefined && node.children.length === 0 && node.status !== 'imported');
        if (incompleteSelectedNodes.length === 0) {
          props.onCompleted(allImported);
        } else {
          const failedCount = incompleteSelectedNodes.filter((node) => node.status === 'failed').length;
          const pendingCount = incompleteSelectedNodes.length - failedCount;
          const details = [
            `${result.importedDatasets.length} Quelle${result.importedDatasets.length === 1 ? '' : 'n'} importiert.`,
            failedCount > 0 ? `${failedCount} fehlgeschlagen` : '',
            pendingCount > 0 ? `${pendingCount} weitere${pendingCount === 1 ? ' Quelle benötigt' : ' Quellen benötigen'} noch Angaben oder einen Importweg` : '',
          ].filter(Boolean).join(' ');
          setError(`${details} Der Dialog bleibt geöffnet, damit du die Auswahl prüfen und erneut importieren kannst.`);
        }
      } else {
        setError('Es wurde keine weitere Quelle übernommen. Prüfe die markierten Quellen und ihre Hinweise; deine bisherigen Importe bleiben erhalten.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Der Import konnte nicht ausgeführt werden.');
    } finally {
      setRunBusy(false);
    }
  }, [props, session, importedDatasets]);

  const finishImport = useCallback(() => {
    if (importedDatasets.length > 0) {
      props.onCompleted(importedDatasets);
    } else {
      props.onClose();
    }
  }, [importedDatasets, props]);

  const requestImport = useCallback(() => {
    if (!session) return;
    if (session.selectedNodeIds.length === 0) {
      setError('Bitte mindestens eine erkannte Quelle für den Import auswählen.');
      return;
    }
    if (selectedLeafNodes.length === 0) {
      setError('Die Auswahl enthält keine importierbare Quelle.');
      return;
    }
    setError('');
    void runImport();
  }, [selectedLeafNodes, session, runImport]);

  const runRepair = useCallback(async () => {
    if (!session) return;
    setRepairBusy(true);
    setError('');
    try {
      const result = await repairImportSession(session.id);
      setSession(result.session);
      if (result.repairedNodeIds.length > 0) {
        setSelectedNodeId(result.repairedNodeIds[0] ?? firstInterestingNode(result.session));
      } else if (result.unresolvedNodeIds.length > 0) {
        const firstUnresolvedId = result.unresolvedNodeIds[0] ?? null;
        if (firstUnresolvedId) {
          setSelectedNodeId(firstUnresolvedId);
          const gap = result.session.gaps.find((entry) => entry.nodeId === firstUnresolvedId);
          const trace = result.session.repairHistory.find((entry) => entry.nodeId === firstUnresolvedId);
          if (trace?.status === 'running') {
            setError('');
          } else if (trace?.status === 'planned' && trace.verifier?.summary) {
            setError(trace.verifier.summary);
          } else {
            setError(
              trace?.verifier?.summary
              ?? gap?.message
              ?? 'Für diese Importprüfung konnte kein weiterer Schritt ausgeführt werden.',
            );
          }
        }
      } else if (!selectedNodeId) {
        setSelectedNodeId(firstInterestingNode(result.session));
      } else {
        const inputOnlyGap = result.session.gaps.find((gap) => gap.status === 'open' && gap.bestKnownNextAction === 'ask_user_input');
        if (inputOnlyGap) {
          setSelectedNodeId(inputOnlyGap.nodeId);
          setError(`Die Prüfung wurde übersprungen. Ergänze zuerst die fehlenden Angaben: ${inputOnlyGap.message}`);
        } else {
          setError('Keine offenen Importprüfungen können derzeit bearbeitet werden.');
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Die Importprüfung konnte nicht bearbeitet werden.');
    } finally {
      setRepairBusy(false);
    }
  }, [selectedNodeId, session]);

  const renderTree = useCallback((nodeId: string, depth = 0): React.ReactNode => {
    if (!session) return null;
    const node = session.nodes[nodeId];
    if (!node) return null;
    const isOpen = expanded[node.id] ?? false;
    const isSelected = selectedIds.has(node.id);
    const hasChildren = node.children.length > 0;
    return (
      <div key={node.id}>
        <div
          className={`flex items-center gap-2 rounded px-2 py-1.5 transition ${selectedNodeId === node.id ? 'bg-brand-muted' : 'hover:bg-ink/40'}`}
          style={{ paddingLeft: `${8 + depth * 16}px` }}
        >
          {hasChildren ? (
            <button className="w-4 text-[11px] text-[color:var(--text-lo)]" type="button" aria-label={`${node.label}: Unterquellen ${isOpen ? "schließen" : "öffnen"}`} aria-expanded={isOpen} onClick={() => toggleExpanded(node.id)}>
              {isOpen ? 'v' : '>'}
            </button>
          ) : (
            <span className="inline-block w-4" />
          )}
          <input
            type="checkbox"
            aria-label={`${node.label} importieren`}
            checked={isSelected}
            onChange={(event) => { void toggleSelection(node.id, event.target.checked); }}
          />
          <button className="min-w-0 flex-1 text-left" type="button" onClick={() => setSelectedNodeId(node.id)}>
            <div className="truncate text-[13px] text-[color:var(--text-hi)]">{node.label}</div>
            <div className="text-[11px] text-[color:var(--text-lo)]">{translatedLabel(kindLabels, node.kind)}{node.detectedFormat ? ` · ${node.detectedFormat}` : ''}</div>
          </button>
          <Badge tone={statusTone(node.status)}>{translatedLabel(nodeStatusLabels, node.status)}</Badge>
        </div>
        {hasChildren && isOpen && (
          <div>{node.children.map((childId) => renderTree(childId, depth + 1))}</div>
        )}
      </div>
    );
  }, [expanded, selectedIds, selectedNodeId, session, toggleExpanded, toggleSelection]);

  return (
    <dialog ref={dialogRef} aria-labelledby="import-title" className="kf-import-dialog" onCancel={(event) => { event.preventDefault(); if (!runBusy && !repairBusy) finishImport(); }}>
      <div className="kf-import-content flex h-full min-w-0 flex-col bg-panel">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rim px-5 py-4">
          <div>
            <h2 id="import-title" className="text-lg font-semibold text-[color:var(--text-hi)]">Datenquelle hinzufügen</h2>
            <div className="text-[11px] text-[color:var(--text-lo)]">
              Dateien auswählen, erkannte Quellen prüfen und den Import bestätigen.
            </div>
          </div>
          <div className="flex items-center gap-2">
            {session && <Badge tone={statusTone(session.status === 'running' ? 'ready' : session.status === 'completed' ? 'imported' : session.status === 'failed' ? 'failed' : session.status === 'needs_review' ? 'needs_input' : 'group')}>{translatedLabel(sessionStatusLabels, session.status)}</Badge>}
            <button className={ghostBtnCls} type="button" disabled={runBusy || repairBusy} onClick={finishImport}>Schließen</button>
          </div>
        </div>

        <div className="kf-import-body grid min-h-0 flex-1 gap-4 overflow-auto p-5 xl:grid-cols-[380px_minmax(0,1fr)]">
          <div className="flex min-h-0 flex-col gap-3">
            <div
              className={`rounded border-2 border-dashed px-4 py-8 text-center transition ${dragOver ? 'border-brand-border bg-brand-muted' : 'border-rim bg-ink/30 hover:border-brand-border'}`}
              onDrop={onDrop}
              onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
            >
              <h3 className="text-lg font-semibold text-[color:var(--text-hi)]">Dateien hier ablegen</h3>
              <div className="mt-2 text-[13px] text-[color:var(--text-mid)]">Eine oder mehrere Dateien, Archive oder Konfigurationen auswählen.</div>
              <div className="mt-1 text-[11px] text-[color:var(--text-lo)]">Bis zu 8 Dateien, jeweils höchstens 10 MiB. Leere Dateien werden abgelehnt.</div>
              <div className="mt-1 text-[11px] text-[color:var(--text-lo)]">KoiForge prüft die Struktur und zeigt vor dem Import, was erkannt wurde. Der Server prüft diese Grenzen ebenfalls.</div>
              <button type="button" className={`${ghostBtnCls} mt-4`} disabled={uploadBusy} onClick={() => fileInputRef.current?.click()}>Dateien auswählen</button>
              <input
                aria-label="Dateien für den Import"
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => {
                  if (event.target.files && event.target.files.length > 0) {
                    void handleFiles(event.target.files);
                  }
                  event.target.value = '';
                }}
              />
            </div>

            {session && (
              <div className="rounded border border-rim p-3">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-[12px] font-semibold uppercase tracking-[0.1em] text-[color:var(--text-lo)]">Erkannte Quellen</div>
                  <Badge>{session.summary.importableNodes} importierbar</Badge>
                </div>
                <div className="max-h-[52vh] overflow-auto pr-1">
                  {session.rootNodeIds.map((nodeId) => renderTree(nodeId))}
                </div>
              </div>
            )}
          </div>

          <div className="grid min-h-0 gap-4 content-start">
            <div className="min-w-0 rounded-lg border border-rim p-4">
              {!session && (
                <div className="space-y-4 p-2 text-sm text-[color:var(--text-mid)]">
                  <h3 className="font-semibold text-[color:var(--text-hi)]">So kommt deine Quelle in KoiForge</h3>
                  <ol className="space-y-4">
                    <li><strong>01 · Quelle auswählen</strong><p className="mt-1">Lade beispielsweise eine CSV-Datei hoch. Deine Auswahl wird zunächst untersucht.</p></li>
                    <li><strong>02 · Vorschau prüfen</strong><p className="mt-1">Wähle die erkannten Daten aus und ergänze fehlende Angaben.</p></li>
                    <li><strong>03 · Import bestätigen</strong><p className="mt-1">Die importierten Daten stehen anschließend für Auswertungen bereit.</p></li>
                  </ol>
                </div>
              )}

              {session && selectedNode && (
                <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto pr-2">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-[16px] font-semibold text-[color:var(--text-hi)]">{selectedNode.label}</div>
                      <div className="text-[12px] text-[color:var(--text-lo)]">{translatedLabel(kindLabels, selectedNode.kind)}{selectedNode.detectedFormat ? ` · ${selectedNode.detectedFormat}` : ''}</div>
                    </div>
                    <Badge tone={statusTone(selectedNode.status)}>{translatedLabel(nodeStatusLabels, selectedNode.status)}</Badge>
                  </div>

                  {selectedNode.diagnostics.length > 0 && (
                    <details className="break-words rounded border border-[rgba(245,158,11,0.30)] bg-[rgba(245,158,11,0.08)] px-3 py-2 text-[12px] text-[#fbbf24]">
                      <summary className="cursor-pointer">Hinweise zur Quelle ({selectedNode.diagnostics.length})</summary>
                      <div className="mt-2">{selectedNode.diagnostics.join(' · ')}</div>
                    </details>
                  )}

                  {selectedGap && (
                    <div className="min-w-0 rounded border border-rim p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <div className="text-[12px] font-semibold text-[color:var(--text-hi)]">Importprüfung</div>
                        <Badge tone={gapTone(selectedGap.bestKnownNextAction)}>{translatedLabel(gapActionLabels, selectedGap.bestKnownNextAction)}</Badge>
                      </div>
                      <div className="break-words text-[12px] text-[color:var(--text-mid)]">{selectedGap.message}</div>
                      <details className="mt-3 text-[12px] text-[color:var(--text-lo)]">
                        <summary className="cursor-pointer text-[color:var(--text-mid)]">Technische Details</summary>
                        <div className="mt-2 grid gap-2 md:grid-cols-2">
                          <div>Quellenart: <span className="text-[color:var(--text-hi)]">{translatedLabel(sourceClassLabels, selectedGap.lastInspector?.sourceClass ?? 'unknown_source')}</span></div>
                          <div>Fehlender Schritt: <span className="text-[color:var(--text-hi)]">{translatedLabel(gapDimensionLabels, selectedGap.missingDimension)}</span></div>
                          <div>Prüfversuche: <span className="text-[color:var(--text-hi)]">{selectedGap.attemptCount}</span></div>
                        </div>
                      </details>
                      {selectedGap.reuseCandidateIds.length > 0 && (
                        <div className="mt-3">
                          <div className="mb-1 text-[11px] uppercase tracking-[0.1em] text-[color:var(--text-lo)]">Vorhandene Importwege</div>
                          <div className="flex flex-wrap gap-2">
                            {selectedGap.reuseCandidateIds.map((entry) => (
                              <Badge key={entry}>{entry}</Badge>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {selectedRepairTrace && (
                    <details className="min-w-0 rounded border border-rim p-3">
                      <summary className="mb-2 flex cursor-pointer items-center justify-between gap-2 text-[12px] font-semibold text-[color:var(--text-hi)]">
                        <span>Letzte Prüfdetails</span>
                        <Badge tone={statusTone(selectedRepairTrace.status === 'verified' ? 'ready' : selectedRepairTrace.status === 'blocked' ? 'blocked' : selectedRepairTrace.status === 'failed' ? 'failed' : selectedRepairTrace.status === 'running' ? 'running' : 'group')}>
                          {translatedLabel(repairStatusLabels, selectedRepairTrace.status)}
                        </Badge>
                      </summary>
                      <div className="space-y-2 break-words text-[12px] text-[color:var(--text-lo)]">
                        <div>Prüfung: {selectedRepairTrace.inspector.capabilityGap}</div>
                        {selectedRepairTrace.planner && (
                          <div>
                            Plan: {translatedLabel(planTypeLabels, selectedRepairTrace.planner.planType)} {selectedRepairTrace.planner.targetCapabilityId ? `→ ${selectedRepairTrace.planner.targetCapabilityId}` : ''}
                            {selectedRepairTrace.planner.runtimeFamily ? ` · ${translatedLabel(runtimeFamilyLabels, selectedRepairTrace.planner.runtimeFamily)}` : ''}
                            {selectedRepairTrace.planner.acquisitionPath ? ` · ${translatedLabel(acquisitionPathLabels, selectedRepairTrace.planner.acquisitionPath)}` : ''}
                          </div>
                        )}
                        {selectedRepairTrace.implementer && (
                          <div>
                            Umsetzung: {selectedRepairTrace.implementer.summary}
                            {selectedRepairTrace.implementer.runtimeFamily ? ` · ${translatedLabel(runtimeFamilyLabels, selectedRepairTrace.implementer.runtimeFamily)}` : ''}
                            {selectedRepairTrace.implementer.acquisitionPath ? ` · ${translatedLabel(acquisitionPathLabels, selectedRepairTrace.implementer.acquisitionPath)}` : ''}
                          </div>
                        )}
                        {selectedRepairTrace.verifier && (
                          <div>Ergebnis: {selectedRepairTrace.verifier.summary}</div>
                        )}
                      </div>
                      {selectedRepairTrace.implementer && selectedRepairTrace.implementer.steps.length > 0 && (
                        <div className="mt-3 rounded border border-rim/70 p-3">
                          <div className="mb-2 text-[11px] uppercase tracking-[0.1em] text-[color:var(--text-lo)]">Umsetzungsschritte</div>
                          <div className="max-h-40 space-y-1 overflow-y-auto break-words pr-1 text-[12px] text-[color:var(--text-mid)]">
                            {selectedRepairTrace.implementer.steps.map((step, index) => (
                              <div key={`${step}-${index}`}>{index + 1}. {step}</div>
                            ))}
                          </div>
                          {selectedRepairTrace.implementer.dependencies.length > 0 && (
                            <div className="mt-3">
                              <div className="mb-1 text-[11px] uppercase tracking-[0.1em] text-[color:var(--text-lo)]">Abhängigkeiten</div>
                              <div className="max-h-28 space-y-2 overflow-y-auto pr-1">
                                {selectedRepairTrace.implementer.dependencies.map((entry) => (
                                  <div key={entry} className="rounded border border-rim/70 px-2 py-1 text-[11px] break-words text-[color:var(--text-mid)]">
                                    {entry}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {selectedRepairTrace.implementer.targetFiles.length > 0 && (
                            <div className="mt-3">
                              <div className="mb-1 text-[11px] uppercase tracking-[0.1em] text-[color:var(--text-lo)]">Zieldateien</div>
                              <div className="max-h-24 space-y-1 overflow-y-auto pr-1 text-[12px] break-all text-[color:var(--text-mid)]">
                                {selectedRepairTrace.implementer.targetFiles.map((entry) => (
                                  <div key={entry}>{entry}</div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                      {selectedRepairTrace.notes.length > 0 && (
                        <div className="mt-3 rounded border border-rim/70 p-3">
                          <div className="mb-2 text-[11px] uppercase tracking-[0.1em] text-[color:var(--text-lo)]">Notizen zur Prüfung</div>
                          <div className="max-h-24 space-y-1 overflow-y-auto break-words pr-1 text-[12px] text-[color:var(--text-mid)]">
                            {selectedRepairTrace.notes.map((note, index) => (
                              <div key={`${note}-${index}`}>{note}</div>
                            ))}
                          </div>
                        </div>
                      )}
                    </details>
                  )}

                  {selectedExecutionTask && (
                    <details className="min-w-0 rounded border border-rim p-3">
                      <summary className="mb-2 flex cursor-pointer items-center justify-between gap-2 text-[12px] font-semibold text-[color:var(--text-hi)]">
                        <span>Importausführung</span>
                        <Badge tone={statusTone(selectedExecutionTask.status)}>{translatedLabel(executionStatusLabels, selectedExecutionTask.status)}</Badge>
                      </summary>
                      <div className="space-y-2 break-words text-[12px] text-[color:var(--text-lo)]">
                        <div>Schritt: {translatedLabel(gapActionLabels, selectedExecutionTask.action)}</div>
                        {selectedExecutionTask.planType && (
                          <div>Plan: {translatedLabel(planTypeLabels, selectedExecutionTask.planType)}</div>
                        )}
                        {selectedExecutionTask.runtimeFamily && (
                          <div>Laufzeit: {translatedLabel(runtimeFamilyLabels, selectedExecutionTask.runtimeFamily)}</div>
                        )}
                        {selectedExecutionTask.acquisitionPath && (
                          <div>Bereitstellung: {translatedLabel(acquisitionPathLabels, selectedExecutionTask.acquisitionPath)}</div>
                        )}
                        {selectedExecutionTask.executionGoals && selectedExecutionTask.executionGoals.length > 0 && (
                          <div>Ziele: {selectedExecutionTask.executionGoals.map((goal) => translatedLabel(executionGoalLabels, goal)).join(', ')}</div>
                        )}
                        <div>{selectedExecutionTask.summary}</div>
                        {selectedExecutionTask.artifactPath && (
                          <div className="break-all">Technisches Artefakt: {selectedExecutionTask.artifactPath}</div>
                        )}
                      </div>
                      {selectedExecutionTask.steps.length > 0 && (
                        <div className="mt-3 rounded border border-rim/70 p-3">
                          <div className="mb-2 text-[11px] uppercase tracking-[0.1em] text-[color:var(--text-lo)]">Ausgeführte Schritte</div>
                          <div className="max-h-40 space-y-1 overflow-y-auto break-words pr-1 text-[12px] text-[color:var(--text-mid)]">
                            {selectedExecutionTask.steps.map((step, index) => (
                              <div key={`${step}-${index}`}>{index + 1}. {step}</div>
                            ))}
                          </div>
                        </div>
                      )}
                      {selectedExecutionTask.diagnostics && selectedExecutionTask.diagnostics.length > 0 && (
                        <div className="mt-3 rounded border border-rim/70 p-3">
                          <div className="mb-2 text-[11px] uppercase tracking-[0.1em] text-[color:var(--text-lo)]">Technische Hinweise</div>
                          <div className="max-h-32 space-y-1 overflow-y-auto break-words pr-1 text-[12px] text-[color:var(--text-mid)]">
                            {selectedExecutionTask.diagnostics.map((entry, index) => (
                              <div key={`${entry}-${index}`}>{entry}</div>
                            ))}
                          </div>
                        </div>
                      )}
                      {selectedExecutionTask.notes && selectedExecutionTask.notes.length > 0 && (
                        <div className="mt-3 rounded border border-rim/70 p-3">
                          <div className="mb-2 text-[11px] uppercase tracking-[0.1em] text-[color:var(--text-lo)]">Notizen</div>
                          <div className="max-h-24 space-y-1 overflow-y-auto break-words pr-1 text-[12px] text-[color:var(--text-mid)]">
                            {selectedExecutionTask.notes.map((entry, index) => (
                              <div key={`${entry}-${index}`}>{entry}</div>
                            ))}
                          </div>
                        </div>
                      )}
                    </details>
                  )}

                  {selectedNode.inputForm && (
                    <div className="rounded border border-rim p-3">
                      <div className="mb-3 text-[12px] font-semibold text-[color:var(--text-hi)]">{formTitle(selectedNode.inputForm.title)}</div>
                      {formDescription(selectedNode.inputForm.title, selectedNode.inputForm.description) && (
                        <div className="mb-3 text-[12px] text-[color:var(--text-lo)]">{formDescription(selectedNode.inputForm.title, selectedNode.inputForm.description)}</div>
                      )}
                      <div className="grid gap-3 md:grid-cols-2">
                        {selectedNode.inputForm.fields.map((field) => (
                          <label key={field.key} className="space-y-1">
                            <div className="text-[11px] font-medium uppercase tracking-[0.1em] text-[color:var(--text-lo)]">
                              {formFieldLabel(field.key, field.label)}{field.required ? ' *' : ''}
                            </div>
                            {field.kind === 'select' ? (
                              <select
                                className={selectCls}
                                value={String(draftConfig[field.key] ?? '')}
                                onChange={(event) => setDraftConfig((prev) => ({ ...prev, [field.key]: event.target.value }))}
                              >
                                <option value="">Bitte auswählen</option>
                                {(field.options ?? []).map((option) => (
                                  <option key={option.value} value={option.value}>{formOptionLabels[option.value] ?? option.label}</option>
                                ))}
                              </select>
                            ) : field.key === 'validationFixtures' || field.key === 'formatDescription' ? (
                              <textarea
                                className={`${inputCls} min-h-28 font-mono text-xs`}
                                value={String(draftConfig[field.key] ?? '')}
                                placeholder={formPlaceholder(field.placeholder)}
                                onChange={(event) => setDraftConfig((prev) => ({ ...prev, [field.key]: event.target.value }))}
                              />
                            ) : field.kind === 'checkbox' ? (
                              <input
                                type="checkbox"
                                checked={Boolean(draftConfig[field.key])}
                                onChange={(event) => setDraftConfig((prev) => ({ ...prev, [field.key]: event.target.checked }))}
                              />
                            ) : (
                              <input
                                className={inputCls}
                                type={field.kind === 'number' ? 'number' : field.kind === 'password' ? 'password' : 'text'}
                                value={String(draftConfig[field.key] ?? '')}
                                placeholder={formPlaceholder(field.placeholder)}
                                onChange={(event) => setDraftConfig((prev) => ({ ...prev, [field.key]: field.kind === 'number' ? Number(event.target.value) : event.target.value }))}
                              />
                            )}
                            {formFieldDescription(field.key, field.description) && <div className="text-xs text-[color:var(--text-lo)]">{formFieldDescription(field.key, field.description)}</div>}
                          </label>
                        ))}
                      </div>
                      <div className="mt-3 flex justify-end">
                        <ActionButton onClick={() => void saveConfig()} busy={saveBusy} label="Angaben speichern" busyLabel="Wird gespeichert…" />
                      </div>
                    </div>
                  )}

                  {selectedNode.preview && (
                    <div className="min-h-0">
                      <div className="mb-2 text-[12px] font-semibold text-[color:var(--text-hi)]">Datenvorschau</div>
                      <DataTable preview={{
                        datasetId: selectedNode.id,
                        columns: selectedNode.preview.columns,
                        rows: selectedNode.preview.rows,
                        rowCount: selectedNode.preview.rowCount,
                        truncated: selectedNode.preview.rowCount > selectedNode.preview.rows.length,
                      }} fixedRows={10} />
                    </div>
                  )}
                </div>
              )}
            </div>

            {session && <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_220px]">
              <details className="rounded border border-rim p-3">
                <summary className="cursor-pointer text-[12px] font-semibold uppercase tracking-[0.1em] text-[color:var(--text-lo)]">Importprotokoll</summary>
                <div className="max-h-[180px] overflow-auto space-y-2 pr-1">
                  {(session?.log ?? []).slice(0, 30).map((entry) => (
                    <div key={entry.id} className="rounded border border-rim/60 px-3 py-2 text-[12px]">
                      <div className="flex items-center justify-between gap-2">
                        <span className="break-words font-medium text-[color:var(--text-hi)]">{entry.message}</span>
                        <span className="text-[10px] uppercase tracking-[0.1em] text-[color:var(--text-lo)]">{translatedLabel(importLevelLabels, entry.level)}</span>
                      </div>
                      <div className="mt-1 text-[11px] text-[color:var(--text-lo)]">{entry.timestamp}</div>
                    </div>
                  ))}
                </div>
              </details>

              <div className="rounded border border-rim p-3">
                <div className="space-y-2 text-[12px] text-[color:var(--text-lo)]">
                  <div>Erkannte Quellen: {session?.summary.totalNodes ?? 0}</div>
                  <div>Importierbare Quellen: {session?.summary.importableNodes ?? 0}</div>
                  <div>Importierte Quellen: {session?.summary.importedNodes ?? 0}</div>
                  <div>Fehlgeschlagene Quellen: {session?.summary.failedNodes ?? 0}</div>
                  <div>Ausgewählte Quellen: {selectedLeafNodes.length}</div>
                  <div>Offene Importprüfungen: {openGaps.length}</div>
                </div>
                <div className="mt-4 space-y-2">
                  {repairBusy && <p role="status">KoiForge prüft die Importlücken und ergänzt bei Bedarf einen Importweg. Das kann einige Minuten dauern.</p>}
                  <ActionButton onClick={() => void runRepair()} busy={repairBusy} disabled={runBusy} label="Importlücken bearbeiten" busyLabel="Wird geprüft…" variant="ghost" />
                  <ActionButton onClick={requestImport} busy={runBusy} disabled={repairBusy} label="Auswahl importieren" busyLabel="Wird importiert…" />
                </div>
              </div>
            </div>}
          </div>
        </div>

        {error && (
          <div role="alert" className="border-t border-rim px-5 py-3 text-[12px] break-words text-[#9c332a]">
            {error}
          </div>
        )}
        {importedDatasets.length > 0 && session && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-rim px-5 py-3 text-[12px] text-[color:var(--text-mid)]">
            <span>{importedDatasets.length} Quelle{importedDatasets.length === 1 ? '' : 'n'} wurden bereits übernommen. Du kannst weitere Quellen prüfen oder den Import jetzt abschließen.</span>
            <button className={ghostBtnCls} type="button" disabled={runBusy || repairBusy} onClick={finishImport}>Import abschließen</button>
          </div>
        )}
        {session && openGaps.length > 0 && (
          <div className="border-t border-rim px-5 py-3 text-[12px] break-words text-[color:var(--text-lo)]">
            Offene Importprüfungen: {openGaps.map((gap) => `${session.nodes[gap.nodeId]?.label ?? gap.nodeId}: ${translatedLabel(gapDimensionLabels, gap.missingDimension)} → ${translatedLabel(gapActionLabels, gap.bestKnownNextAction)}`).join(' · ')}
          </div>
        )}
        {session && session.capabilityCatalog.length > 0 && (
          <details className="border-t border-rim px-5 py-3 text-[12px] break-words text-[color:var(--text-lo)]">
            <summary className="cursor-pointer">Technische Importwege ({session.capabilityCatalog.length})</summary>
            <div className="mt-2">{session.capabilityCatalog.slice(0, 8).map((entry) => `${entry.id} (${translatedLabel(capabilityKindLabels, entry.kind)}, Priorität ${entry.reusePriority})`).join(' · ')}</div>
          </details>
        )}
        {uploadBusy && (
          <div className="border-t border-rim px-5 py-3 text-[12px] text-[color:var(--text-lo)]">
            Quelle wird untersucht…
          </div>
        )}
      </div>
    </dialog>
  );
}
