import { useEffect, useState } from 'react';
import { fetchGitLabQueue, type GitLabQueueSnapshot } from '../api';
import { Badge, Card } from './ui';

export function GitLabQueueCard({ refreshKey, autoRefresh, now }: { refreshKey: number; autoRefresh: boolean; now: number }) {
  const [snapshot, setSnapshot] = useState<GitLabQueueSnapshot | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    async function load() {
      setLoading(true);
      try {
        const result = await fetchGitLabQueue(controller.signal);
        if (active) { setSnapshot(result); setError(''); }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : 'GitLab ist derzeit nicht verfügbar.');
      } finally {
        clearTimeout(timeout);
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; controller.abort(); clearTimeout(timeout); };
  }, [refresh, refreshKey]);

  const stale = !!snapshot && (!Number.isFinite(Date.parse(snapshot.observedAt)) || now - Date.parse(snapshot.observedAt) > 180_000);
  const counts = error || stale ? null : snapshot?.counts;
  const total = counts ? counts.running + counts.pending + counts.duoRunning + counts.duoPending
    + counts.upcoming + counts.resourceWaiting + counts.scheduled : null;
  const rows = snapshot?.projects.filter(row => !row.counts || Object.values(row.counts).some(n => n > 0)) ?? [];
  const status = stale ? 'Daten veraltet' : error || snapshot?.source === 'degraded' ? 'Daten unvollständig'
    : !snapshot ? 'Wird geladen…' : counts && counts.running > 0 ? 'Jobs laufen'
    : total === 0 ? 'Warteschlange leer' : 'Jobs warten';

  return (
    <Card title="GitLab-Warteschlange" action={<Badge>{status}</Badge>}>
      <section aria-label="GitLab-Warteschlange" aria-busy={loading} data-testid="gitlab-queue">
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-[color:var(--text-mid)]">
          <p>
            {snapshot ? `Stand ${new Date(snapshot.observedAt).toLocaleString('de-DE')} · ${snapshot.projects.length} Projekte` : 'GitLab wird abgefragt.'}
            {autoRefresh ? ' · Aktualisierung jede Minute' : ' · Automatik pausiert'}
          </p>
          <button type="button" disabled={loading} onClick={() => setRefresh(n => n + 1)}
            className="rounded border border-rim px-3 py-1.5 text-[color:var(--text-hi)] hover:border-brand-border disabled:opacity-50">
            {loading ? 'Lädt…' : 'Neu laden'}
          </button>
        </div>
        {error && <p role="alert" className="mt-3 text-sm text-[#805412]">{error} {snapshot ? 'Der letzte Messzeitpunkt ist oben angegeben.' : ''}</p>}
        {snapshot?.source === 'degraded' && !error && <p role="status" className="mt-3 text-sm text-[#805412]">
          Einige Projekte konnten nicht abgefragt werden. Die Gesamtsumme ist daher unbekannt.
        </p>}
        <dl className="my-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
          {([
            ['Offen gesamt', total], ['Laufen', counts?.running], ['Warten auf Runner', counts?.pending],
            ['Duo separat', counts ? counts.duoRunning + counts.duoPending : null], ['Folgeschritte', counts?.upcoming],
          ] as const).map(([label, value]) => <div key={label} className="rounded border border-rim p-3">
            <dt className="text-xs text-[color:var(--text-mid)]">{label}</dt>
            <dd className="mt-2 text-2xl font-semibold tabular-nums text-[color:var(--text-hi)]">{value ?? '—'}</dd>
          </div>)}
        </dl>
        <p className="text-xs leading-5 text-[color:var(--text-mid)]">
          Längste aktuelle Runner-Wartezeit: {counts && snapshot?.oldestPendingSeconds != null
            ? `${Math.ceil(snapshot.oldestPendingSeconds / 60)} Min.` : counts?.pending === 0 ? 'Keine wartenden Jobs' : 'Unbekannt'}.
          {' '}Wartende Jobs allein bedeuten keinen Stillstand. Manuell blockierte und abgeschlossene Pipelines zählen nicht als Folgeschritte.
        </p>
        {counts && <p className="mt-1 text-xs text-[color:var(--text-mid)]">
          Warten auf Ressourcen: {counts.resourceWaiting} · Zeitgesteuert: {counts.scheduled}
          {' · '}Abbruch läuft: {counts.canceling} (nicht in der offenen Summe)
          {' · '}Duo: {counts.duoRunning} laufen, {counts.duoPending} warten
        </p>}
        {!error && !stale && rows.length > 0 && <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-xs text-[color:var(--text-hi)]">
            <caption className="sr-only">Offene GitLab-Jobs nach Projekt</caption>
            <thead><tr className="border-b border-rim">
              {['Projekt', 'Laufen', 'Warten', 'Duo', 'Folgeschritte'].map(label => <th key={label} scope="col" className="p-2">{label}</th>)}
            </tr></thead>
            <tbody>{rows.map(row => <tr key={row.project} className="border-b border-rim/50">
              <th scope="row" className="p-2 font-normal"><a className="underline underline-offset-2" href={row.url} target="_blank" rel="noreferrer">{row.project}</a></th>
              <td className="p-2">{row.counts?.running ?? '—'}</td>
              <td className="p-2">{row.counts?.pending ?? '—'}</td>
              <td className="p-2">{row.counts ? row.counts.duoRunning + row.counts.duoPending : '—'}</td>
              <td className="p-2">{row.counts?.upcoming ?? '—'}</td>
            </tr>)}</tbody>
          </table>
        </div>}
      </section>
    </Card>
  );
}
