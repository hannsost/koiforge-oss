import { useEffect, useState } from 'react';

import {
  fetchDiscoveryReport,
  fetchIdentityReport,
  fetchOntologySnapshot,
  type DiscoveryReport,
  type IdentityLinkingReport,
  type OntologyValidationResult,
} from '../api';
import { Badge, Card, confidenceTone } from '../components/ui';

export function DiscoveryView() {
  const [discoveryReport, setDiscoveryReport] = useState<DiscoveryReport | null>(null);
  const [identityReport, setIdentityReport] = useState<IdentityLinkingReport | null>(null);
  const [ontology, setOntology] = useState<OntologyValidationResult | null>(null);

  useEffect(() => {
    Promise.all([fetchDiscoveryReport(), fetchIdentityReport(), fetchOntologySnapshot()])
      .then(([d, i, o]) => { setDiscoveryReport(d); setIdentityReport(i); setOntology(o); })
      .catch(console.error);
  }, []);

  return (
    <>
      {/* Discovery suggestions */}
      <Card
        title="Discovery Suggestions"
        action={discoveryReport ? <Badge>{discoveryReport.suggestions.length}</Badge> : undefined}
      >
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {(discoveryReport?.suggestions ?? []).map((s) => (
            <div
              key={`${s.fromDatasetId}-${s.fromColumn}-${s.toDatasetId}-${s.toColumn}`}
              className="rounded border border-rim bg-ink/50 px-3 py-3"
            >
              <div className="text-[13px] font-medium text-[#c8d6ef]">
                {s.fromDatasetId}.<span className="text-white">{s.fromColumn}</span>
              </div>
              <div className="mt-0.5 text-[11px] text-[#3a4e6a]">→ {s.toDatasetId}.{s.toColumn}</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Badge tone={confidenceTone(s.confidenceLabel)}>{s.confidence.toFixed(2)}</Badge>
                <Badge>{s.suggestionType}</Badge>
              </div>
              <div className="mt-1.5 text-[10px] text-[#2e415a]">{s.reasons.join(', ')}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* Links + Clusters */}
      <div className="grid gap-4 xl:grid-cols-2">
        <Card
          title="Identity Links"
          action={identityReport ? <Badge>{identityReport.links.length}</Badge> : undefined}
        >
          <div className="space-y-2">
            {identityReport && (
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded border border-rim bg-ink/50 px-3 py-3 text-[11px] text-[#6b82a0]">
                <div>Hints: <span className="text-[#c8d6ef]">{identityReport.candidateStats?.hintCount ?? 0}</span></div>
                <div>Buckets: <span className="text-[#c8d6ef]">{(identityReport.candidateStats?.bucketCount ?? 0).toLocaleString('de-DE')}</span></div>
                <div>Comparisons: <span className="text-[#c8d6ef]">{(identityReport.candidateStats?.rowComparisonsEstimated ?? 0).toLocaleString('de-DE')}</span></div>
                <div>Pairs: <span className="text-[#c8d6ef]">{(identityReport.candidateStats?.candidatePairsGenerated ?? 0).toLocaleString('de-DE')}</span></div>
              </div>
            )}
            {(identityReport?.links ?? []).slice(0, 12).map((link) => (
              <div key={`${link.fromRowKey}-${link.toRowKey}`} className="rounded border border-rim bg-ink/50 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 truncate text-[12px] text-[#c8d6ef]">
                    {link.fromDatasetId}.<span className="text-white">{link.fromValue}</span>
                    <span className="mx-1.5 text-[#2e415a]">→</span>
                    {link.toDatasetId}.<span className="text-white">{link.toValue}</span>
                  </div>
                  <Badge tone={confidenceTone(link.confidenceLabel)}>{link.confidence.toFixed(2)}</Badge>
                </div>
                <div className="mt-1 text-[10px] text-[#2e415a]">{link.reasons.join(', ')}</div>
              </div>
            ))}
          </div>
        </Card>

        <Card
          title="Canonical Clusters"
          action={identityReport ? <Badge>{identityReport.clusters.length}</Badge> : undefined}
        >
          <div className="space-y-2">
            {(identityReport?.clusters ?? []).slice(0, 12).map((cluster) => (
              <div key={cluster.clusterKey} className="rounded border border-rim bg-ink/50 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[13px] font-medium text-white">{cluster.datasetId}</div>
                  <Badge tone={confidenceTone(cluster.confidenceLabel)}>{cluster.confidence.toFixed(2)}</Badge>
                </div>
                <div className="mt-0.5 text-[11px] text-[#3a4e6a]">
                  {cluster.members.length} members
                  {cluster.conflicts.length > 0 && <span className="ml-2 text-[#f59e0b]">conflict: {cluster.conflicts.join(', ')}</span>}
                </div>
                <div className="mt-1 text-[10px] text-[#2e415a]">{cluster.members.map((m) => m.label).join(' · ')}</div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Ontology */}
      <Card title="Ontology Registry">
        <div className="space-y-1.5">
          {(ontology?.snapshot.objects ?? []).map((obj) => (
            <div key={obj.key} className="rounded border border-rim bg-ink/50 px-3 py-2.5">
              <div className="text-[13px] font-semibold text-white">{obj.key}</div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {obj.properties.map((prop) => (
                  <Badge key={`${obj.key}-${prop.name}`}>{prop.name}: {prop.type}</Badge>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
