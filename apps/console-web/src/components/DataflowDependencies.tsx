import { useEffect, useRef, useState } from 'react';

import {
  DataflowApiError,
  fetchDataflowDependencies,
  type FlowDependencyGraph,
  type FlowDependencyInput,
  type FlowDependencyNode,
  type FlowDependencyStatus,
} from '../dataflows-api';

import '../dataflow-dependencies.css';

export interface DataflowDependenciesProps {
  selectedFlowId: string;
  refreshKey: number;
  onSelect: (flowId: string) => void;
}

export const flowDependencyStatusLabels: Record<FlowDependencyStatus, string> = {
  current: 'Aktuell',
  needs_run: 'Neu berechnen',
  needs_definition: 'Definition prüfen',
  waiting: 'Vorgänger aktualisieren',
  unpublished: 'Noch nicht veröffentlicht',
  unavailable: 'Quelle prüfen',
};

const statusTone: Record<FlowDependencyStatus, string> = {
  current: 'current',
  needs_run: 'needs-run',
  needs_definition: 'needs-definition',
  waiting: 'waiting',
  unpublished: 'unpublished',
  unavailable: 'unavailable',
};

function errorMessage(error: unknown): string {
  if (error instanceof DataflowApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return 'Die Abhängigkeiten konnten nicht geladen werden.';
}

function objectLink(input: FlowDependencyInput): string {
  const family = encodeURIComponent(input.familyId);
  const set = input.setId ? `&set=${encodeURIComponent(input.setId)}` : '';
  return `#/objects?family=${family}${set}`;
}

function statusLabel(status: FlowDependencyStatus): string {
  return flowDependencyStatusLabels[status] ?? 'Quelle prüfen';
}

function StatusBadge({ status }: { status: FlowDependencyStatus }) {
  return <span className={`dependency-status dependency-status-${statusTone[status] ?? 'unavailable'}`}>{statusLabel(status)}</span>;
}

function FlowSelectButton({
  flowId,
  name,
  onSelect,
  className = 'dependency-flow-link',
}: {
  flowId: string;
  name: string;
  onSelect: (flowId: string) => void;
  className?: string;
}) {
  return <button className={className} type="button" onClick={() => onSelect(flowId)}>{name}</button>;
}

function InputRow({ input, producerName, onSelect }: { input: FlowDependencyInput; producerName?: string; onSelect: (flowId: string) => void }) {
  return (
    <li className="dependency-input">
      <a className="dependency-object-link" href={objectLink(input)}>
        <span>{input.name}</span>
        {input.revision !== undefined && <small>Revision {input.revision}</small>}
      </a>
      <span className="dependency-input-state">
        {input.missing && <span className="dependency-inline-warning">Fehlt</span>}
        {input.schemaChanged && <span className="dependency-inline-warning">Schema geändert</span>}
        {input.producerFlowId && <FlowSelectButton flowId={input.producerFlowId} name={`Erzeuger: ${producerName ?? input.producerFlowId}`} onSelect={onSelect} />}
      </span>
    </li>
  );
}

function DependencyNodeCard({ node, expanded, nodeById, onSelect }: { node: FlowDependencyNode; expanded: boolean; nodeById: Map<string, FlowDependencyNode>; onSelect: (flowId: string) => void }) {
  return (
    <article className={`dependency-node dependency-node-${statusTone[node.status] ?? 'unavailable'}`} data-testid={`dependency-node-${node.flowId}`}>
      <div className="dependency-node-heading">
        <div className="dependency-node-title">
          <FlowSelectButton flowId={node.flowId} name={node.name} onSelect={onSelect} />
          <span>Revision {node.revision}</span>
        </div>
        <StatusBadge status={node.status} />
      </div>
      <p className="dependency-node-summary">{node.dependsOn.length > 0 ? <>Vorgänger: {node.dependsOn.map((flowId, index) => <span key={flowId}>{index > 0 && ', '}<FlowSelectButton flowId={flowId} name={nodeById.get(flowId)?.name ?? flowId} onSelect={onSelect} /></span>)}</> : 'Direkte Quellen werden verwendet.'}</p>
      {expanded && node.issues.length > 0 && (
        <div className="dependency-issues" role="status">
          <strong>Hinweise</strong>
          <ul>{node.issues.map((issue, index) => <li key={`${node.flowId}-issue-${index}`}>{issue}</li>)}</ul>
        </div>
      )}
      {expanded && <div className="dependency-node-columns">
        <div>
          <h4>Eingaben</h4>
          {node.inputs.length > 0 ? <ul className="dependency-input-list">{node.inputs.map((input) => <InputRow key={`${input.familyId}-${input.setId ?? 'missing'}`} input={input} producerName={input.producerFlowId ? nodeById.get(input.producerFlowId)?.name : undefined} onSelect={onSelect} />)}</ul> : <p className="dependency-muted">Keine Eingaben bekannt.</p>}
        </div>
        {node.dependsOn.length > 0 && (
          <div>
            <h4>Vorgänger</h4>
            <div className="dependency-flow-list">{node.dependsOn.map((flowId) => <FlowSelectButton key={flowId} flowId={flowId} name={nodeById.get(flowId)?.name ?? flowId} onSelect={onSelect} />)}</div>
          </div>
        )}
      </div>}
    </article>
  );
}

export function DataflowDependencies({ selectedFlowId, refreshKey, onSelect }: DataflowDependenciesProps) {
  const [graph, setGraph] = useState<FlowDependencyGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const requestSequence = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError(null);

    void fetchDataflowDependencies(controller.signal).then((nextGraph) => {
      if (controller.signal.aborted || requestSequence.current !== sequence) return;
      setGraph(nextGraph);
      setLoading(false);
    }).catch((reason: unknown) => {
      if (controller.signal.aborted || requestSequence.current !== sequence) return;
      // Keep a previously verified graph visible, but mark it as stale below. An
      // empty initial state never invents a current node after a failed request.
      setError(errorMessage(reason));
      setLoading(false);
    });

    return () => controller.abort();
  }, [refreshKey, retryKey, selectedFlowId]);

  const refresh = () => setRetryKey((value) => value + 1);
  const nodes = graph?.nodes ?? [];
  const currentCount = nodes.filter((node) => node.status === 'current').length;
  const needsAttentionCount = nodes.length - currentCount;
  const selected = nodes.find((node) => node.flowId === selectedFlowId);
  const nodeById = new Map(nodes.map((node) => [node.flowId, node]));
  const orderedNodes = (graph?.updateOrder ?? []).map((flowId) => nodeById.get(flowId)).filter((node): node is FlowDependencyNode => Boolean(node));
  const downstream = selected?.affectedFlowIds.map((flowId) => nodeById.get(flowId) ?? { flowId, name: flowId, status: 'unavailable' as const }).filter((node, index, all) => all.findIndex((candidate) => candidate.flowId === node.flowId) === index) ?? [];

  return (
    <section className="dependency-workspace" data-testid="dependency-workspace" aria-busy={loading}>
      <div className="dependency-topbar">
        <div>
          <p className="dependency-eyebrow">Quellen und Ergebnisse</p>
          <h2>Datenflüsse sicher aktualisieren</h2>
          <p className="dependency-intro">Quellenänderungen erkennen und betroffene Ergebnisse in der richtigen Reihenfolge aktualisieren.</p>
          <p className="dependency-guidance">Führe jeden betroffenen Datenfluss aus, prüfe das Ergebnis und bestätige seine Veröffentlichung.</p>
        </div>
        <div className="dependency-topbar-actions">
          {graph && <div className="dependency-counts" aria-label="Datenflussstatus"><span data-testid="dependency-current-count"><strong>{currentCount}</strong> Aktuell</span><span data-testid="dependency-attention-count"><strong>{needsAttentionCount}</strong> Benötigt Aufmerksamkeit</span></div>}
          <button className="dependency-refresh" data-testid="dependency-refresh" type="button" onClick={refresh} disabled={loading}>{loading ? 'Lädt …' : 'Aktualisieren'}</button>
        </div>
      </div>

      {error && <div className="dependency-alert" role="alert"><span>{error}{graph ? ' Der letzte erfolgreiche Stand bleibt sichtbar.' : ''}</span><button type="button" onClick={refresh}>Erneut laden</button></div>}
      {loading && !graph && <p className="dependency-muted" role="status">Abhängigkeiten werden geladen …</p>}
      {!loading && !graph && !error && <p className="dependency-muted" role="status">Noch kein Abhängigkeitsstand verfügbar.</p>}

      {graph && (
        <>
          {(error || loading) && <p className="dependency-stale" role="status">Die Statuswerte stammen aus dem letzten erfolgreichen Abruf.</p>}
          <div className="dependency-layout">
            <div className="dependency-main-column">
              <section className="dependency-card" aria-labelledby="dependency-order-heading">
                <div className="dependency-card-heading"><div><h3 id="dependency-order-heading">Aktualisierungsreihenfolge</h3><p>Prüfe und bestätige jeden Datenfluss einzeln in dieser Reihenfolge.</p></div><button className="dependency-next" data-testid="dependency-next" type="button" onClick={() => graph.nextFlowId && onSelect(graph.nextFlowId)} disabled={loading || Boolean(error) || !graph.nextFlowId}>Nächsten Datenfluss prüfen</button></div>
                {orderedNodes.length > 0 ? <ol className="dependency-order-list">{orderedNodes.map((node, index) => <li key={node.flowId} className={node.flowId === selectedFlowId ? 'is-selected' : undefined}><span className="dependency-order-number">{index + 1}</span><FlowSelectButton flowId={node.flowId} name={node.name} onSelect={onSelect} /><StatusBadge status={node.status} /></li>)}</ol> : <p className="dependency-muted">Keine Aktualisierung erforderlich.</p>}
              </section>
              <section className="dependency-card" aria-labelledby="dependency-nodes-heading">
                <div className="dependency-card-heading"><div><h3 id="dependency-nodes-heading">Datenflussabhängigkeiten</h3><p>Direkte Quellen und vorgelagerte Ergebnisse bleiben nachvollziehbar.</p></div></div>
                <div className="dependency-node-list">{nodes.length > 0 ? nodes.map((node) => <DependencyNodeCard key={node.flowId} node={node} expanded={node.flowId === selectedFlowId} nodeById={nodeById} onSelect={onSelect} />) : <p className="dependency-muted">Keine Datenflüsse vorhanden.</p>}</div>
              </section>
            </div>
            <aside className="dependency-card dependency-selection" aria-labelledby="dependency-selection-heading">
              <div className="dependency-card-heading"><div><p className="dependency-eyebrow">Ausgewählter Datenfluss</p><h3 id="dependency-selection-heading">{selected?.name ?? 'Keinen Datenfluss ausgewählt'}</h3></div>{selected && <StatusBadge status={selected.status} />}</div>
              {selected ? <div className="dependency-selection-body">
                <p>Revision {selected.revision}</p>
                <div className="dependency-selection-section"><h4>Hinweise und Prüfstatus</h4>{selected.issues.length > 0 ? <ul>{selected.issues.map((issue, index) => <li key={`selected-issue-${index}`}>{issue}</li>)}</ul> : <p className="dependency-muted">Keine offenen Hinweise.</p>}</div>
                <div className="dependency-selection-section"><h4>Nachgelagerte Auswirkungen</h4>{downstream.length > 0 ? <ul className="dependency-impact-list">{downstream.map((node) => <li key={node.flowId}><FlowSelectButton flowId={node.flowId} name={node.name} onSelect={onSelect} />{node.status !== 'unavailable' && <StatusBadge status={node.status} />}</li>)}</ul> : <p className="dependency-muted">Keine nachgelagerten Datenflüsse bekannt.</p>}</div>
                <p className="dependency-confirmation-note">Ein Lauf und die Veröffentlichung bleiben jeweils ein eigener, ausdrücklich zu bestätigender Schritt.</p>
              </div> : <p className="dependency-muted dependency-selection-empty">Wähle einen Datenfluss im Aktualisierungspfad oder in der Liste.</p>}
            </aside>
          </div>
        </>
      )}
    </section>
  );
}

export default DataflowDependencies;
