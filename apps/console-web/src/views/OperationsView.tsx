import { useCallback, useEffect, useState } from 'react';

import {
  bootstrapAssets,
  fetchAssets,
  fetchAudit,
  fetchDataEvents,
  fetchLineageEdges,
  fetchLineageEvents,
  fetchRuns,
  type AssetRecord,
  type AuditEvent,
  type DataEvent,
  type LineageEdge,
  type LineageEvent,
  type RunRecord,
} from '../api';
import { ActionButton, Badge, Card, StatusDot } from '../components/ui';

const statusTone = (s: string): 'success' | 'warning' | 'danger' | 'neutral' => {
  if (s === 'success' || s === 'completed' || s === 'active') return 'success';
  if (s === 'running' || s === 'pending') return 'warning';
  if (s === 'failed' || s === 'error') return 'danger';
  return 'neutral';
};

export function OperationsView() {
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [lineageEdges, setLineageEdges] = useState<LineageEdge[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [lineageEvents, setLineageEvents] = useState<LineageEvent[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [dataEvents, setDataEvents] = useState<DataEvent[]>([]);
  const [bootstrapping, setBootstrapping] = useState(false);

  const load = useCallback(() => {
    Promise.all([fetchAssets(), fetchLineageEdges(), fetchRuns(), fetchLineageEvents(), fetchAudit(), fetchDataEvents()])
      .then(([a, edges, r, le, au, de]) => {
        setAssets(a); setLineageEdges(edges); setRuns(r);
        setLineageEvents(le); setAudit(au); setDataEvents(de);
      }).catch(console.error);
  }, []);

  useEffect(() => { load(); }, [load]);

  const bootstrap = useCallback(async () => {
    setBootstrapping(true);
    try { await bootstrapAssets(); load(); } catch (e) { console.error(e); } finally { setBootstrapping(false); }
  }, [load]);

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {/* Assets + Lineage */}
      <Card
        title="Assets & Lineage"
        action={<ActionButton onClick={() => void bootstrap()} busy={bootstrapping} busyLabel="Generating…" label="Bootstrap Lineage" />}
      >
        <div className="space-y-1.5">
          {assets.map((asset) => (
            <div key={asset.id} className="rounded border border-rim bg-ink/50 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <StatusDot tone="neutral" />
                <span className="text-[13px] font-medium text-white">{asset.name}</span>
              </div>
              <div className="mt-0.5 pl-4 text-[11px] text-[#3a4e6a]">{asset.kind} · {asset.domain ?? '—'}</div>
            </div>
          ))}

          {lineageEdges.length > 0 && (
            <div className="mt-3">
              <div className="mb-1.5 text-[10px] uppercase tracking-wide text-[#3a4e6a]">Lineage edges</div>
              {lineageEdges.map((edge) => (
                <div key={edge.id} className="flex items-center gap-2 rounded border border-rim/50 bg-ink/30 px-3 py-1.5 mb-1 text-[11px]">
                  <span className="text-[#6b82a0]">{edge.fromAssetId}</span>
                  <span className="text-[#2e415a]">→</span>
                  <span className="text-[#6b82a0]">{edge.toAssetId}</span>
                  <Badge>{edge.operation}</Badge>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      {/* Events + Audit */}
      <Card title="Events & Audit">
        <div className="space-y-1">
          {runs.map((run) => (
            <div key={run.id} className="flex items-center gap-2 rounded border border-rim/50 bg-ink/30 px-3 py-1.5 text-[11px]">
              <StatusDot tone={statusTone(run.status)} />
              <span className="text-[#6b82a0]">Run</span>
              <span className="text-[#c8d6ef]">{run.assetId}</span>
              <span className="ml-auto">
                <Badge tone={statusTone(run.status)}>{run.status}</Badge>
              </span>
            </div>
          ))}
          {lineageEvents.map((event) => (
            <div key={event.id} className="flex items-center gap-2 rounded border border-rim/50 bg-ink/30 px-3 py-1.5 text-[11px]">
              <span className="text-[10px] uppercase tracking-wide text-[#2e415a]">{event.type}</span>
              <span className="text-[#6b82a0]">{event.details ?? event.subjectId}</span>
            </div>
          ))}
          {audit.map((entry) => (
            <div key={`${entry.timestamp}-${entry.moduleId}-${entry.type}`} className="flex items-center gap-2 rounded border border-rim/50 bg-ink/30 px-3 py-1.5 text-[11px]">
              <span className="text-[10px] uppercase tracking-wide text-[#2e415a]">{entry.type}</span>
              <span className="text-[#6b82a0]">{entry.moduleId}</span>
              <Badge>{entry.version}</Badge>
            </div>
          ))}
          {dataEvents.map((entry) => (
            <div key={entry.id} className="flex items-center gap-2 rounded border border-rim/50 bg-ink/30 px-3 py-1.5 text-[11px]">
              <span className="text-[10px] uppercase tracking-wide text-[#2e415a]">{entry.type}</span>
              <span className="text-[#6b82a0]">{entry.datasetId}</span>
            </div>
          ))}
          {runs.length === 0 && lineageEvents.length === 0 && audit.length === 0 && dataEvents.length === 0 && (
            <div className="text-[12px] text-[#2e415a]">No events yet. Bootstrap lineage to populate.</div>
          )}
        </div>
      </Card>
    </div>
  );
}
