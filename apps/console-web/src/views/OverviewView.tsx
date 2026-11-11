import { useEffect, useState } from 'react';

import {
  fetchDiscoveryReport,
  fetchIdentityReport,
  fetchLineageEdges,
  fetchObjects,
  fetchOntologySnapshot,
  fetchRuns,
  type DiscoveryReport,
  type IdentityLinkingReport,
  type OntologyValidationResult,
} from '../api';
import { Badge, Card, StatusDot, confidenceTone } from '../components/ui';

function Stat(props: { label: string; value: number | string }) {
  return (
    <div className="flex flex-col gap-1 rounded border border-rim bg-ink/60 px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#3a4e6a]">{props.label}</div>
      <div className="text-[22px] font-semibold tabular-nums leading-none text-white">{props.value}</div>
    </div>
  );
}

export function OverviewView() {
  const [discoveryReport, setDiscoveryReport] = useState<DiscoveryReport | null>(null);
  const [identityReport, setIdentityReport] = useState<IdentityLinkingReport | null>(null);
  const [ontology, setOntology] = useState<OntologyValidationResult | null>(null);
  const [lineagesCount, setLineagesCount] = useState(0);
  const [objectCount, setObjectCount] = useState(0);
  const [runsCount, setRunsCount] = useState(0);

  useEffect(() => {
    Promise.allSettled([
      fetchDiscoveryReport().then(setDiscoveryReport),
      fetchIdentityReport().then(setIdentityReport),
      fetchOntologySnapshot().then(setOntology),
      fetchLineageEdges().then((edges) => setLineagesCount(edges.length)),
      fetchObjects('supplier').then((items) => setObjectCount(items.length)),
      fetchRuns().then((runs) => setRunsCount(runs.length)),
    ]).catch(console.error);
  }, []);

  return (
    <>
      {/* KPIs */}
      <div className="grid grid-cols-5 gap-3">
        <Stat label="Objects" value={objectCount} />
        <Stat label="Ontology" value={ontology?.snapshot.objects.length ?? 0} />
        <Stat label="Lineage" value={lineagesCount} />
        <Stat label="Runs" value={runsCount} />
        <Stat label="Links" value={identityReport?.links.length ?? 0} />
      </div>

      {/* Discovery */}
      <Card
        title="Discovery Suggestions"
        action={discoveryReport ? <Badge>{discoveryReport.suggestions.length}</Badge> : undefined}
      >
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {(discoveryReport?.suggestions ?? []).slice(0, 9).map((s) => (
            <div
              key={`${s.fromDatasetId}-${s.fromColumn}-${s.toDatasetId}-${s.toColumn}`}
              className="rounded border border-rim bg-ink/50 px-3 py-3"
            >
              <div className="font-medium text-[#c8d6ef]">
                {s.fromDatasetId}.<span className="text-white">{s.fromColumn}</span>
              </div>
              <div className="mt-0.5 text-[11px] text-[#3a4e6a]">
                → {s.toDatasetId}.{s.toColumn}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Badge tone={confidenceTone(s.confidenceLabel)}>{s.confidence.toFixed(2)}</Badge>
                <Badge>{s.suggestionType}</Badge>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Identity + Clusters */}
      <div className="grid gap-4 xl:grid-cols-2">
        <Card
          title="Identity Links"
          action={identityReport ? <Badge>{identityReport.links.length}</Badge> : undefined}
        >
          <div className="space-y-2">
            {identityReport && (
              <div className="grid grid-cols-2 gap-2 rounded border border-rim bg-ink/50 px-3 py-3 text-[11px] text-[#6b82a0]">
                <div>Hints: <span className="text-[#c8d6ef]">{identityReport.candidateStats?.hintCount ?? 0}</span></div>
                <div>Buckets: <span className="text-[#c8d6ef]">{(identityReport.candidateStats?.bucketCount ?? 0).toLocaleString('de-DE')}</span></div>
                <div>Comparisons: <span className="text-[#c8d6ef]">{(identityReport.candidateStats?.rowComparisonsEstimated ?? 0).toLocaleString('de-DE')}</span></div>
                <div>Pairs: <span className="text-[#c8d6ef]">{(identityReport.candidateStats?.candidatePairsGenerated ?? 0).toLocaleString('de-DE')}</span></div>
              </div>
            )}
            {(identityReport?.links ?? []).slice(0, 8).map((link) => (
              <div key={`${link.fromRowKey}-${link.toRowKey}`} className="flex items-center justify-between gap-3 rounded border border-rim bg-ink/50 px-3 py-2">
                <div className="min-w-0 truncate text-[12px] text-[#c8d6ef]">
                  {link.fromDatasetId}.<span className="text-white">{link.fromValue}</span>
                  <span className="mx-1.5 text-[#2e415a]">→</span>
                  {link.toDatasetId}.<span className="text-white">{link.toValue}</span>
                </div>
                <Badge tone={confidenceTone(link.confidenceLabel)}>{link.confidence.toFixed(2)}</Badge>
              </div>
            ))}
          </div>
        </Card>

        <Card
          title="Canonical Clusters"
          action={identityReport ? <Badge>{identityReport.clusters.length}</Badge> : undefined}
        >
          <div className="space-y-2">
            {(identityReport?.clusters ?? []).slice(0, 8).map((cluster) => (
              <div key={cluster.clusterKey} className="flex items-center justify-between gap-3 rounded border border-rim bg-ink/50 px-3 py-2">
                <div>
                  <div className="text-[12px] font-medium text-white">{cluster.datasetId}</div>
                  <div className="mt-0.5 text-[11px] text-[#3a4e6a]">
                    {cluster.members.length} members
                    {cluster.conflicts.length > 0 && (
                      <span className="ml-2 text-[#f59e0b]">conflict: {cluster.conflicts.join(', ')}</span>
                    )}
                  </div>
                </div>
                <Badge tone={confidenceTone(cluster.confidenceLabel)}>{cluster.confidence.toFixed(2)}</Badge>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
