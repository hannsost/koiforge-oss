import { fetchMonitoringEndpoints } from '../../api';
import { useMonitoringResource } from './MonitoringWidgets';

export function ApplicationsTable({ refresh, now }: { refresh: number; now: number }) {
  const resource = useMonitoringResource(fetchMonitoringEndpoints, refresh);
  const unavailable = !!resource.error || (!!resource.loadedAt && now - resource.loadedAt > 180_000);
  return <section className="monitoring-panel monitoring-endpoints" aria-label="Anwendungen im Einzelnen" aria-busy={resource.loading}>
    <div className="monitoring-panel-heading"><h3>Anwendungen im Einzelnen</h3><span className="monitoring-pill">HTTPS / TLS</span></div>
    <p className="monitoring-chart-caption">Je Ziel und Prüfer ein eigener Status. Fehlende oder zu alte Beobachtungen bleiben unbekannt.</p>
    {unavailable ? <p className="monitoring-notice" role="status">Einzelprüfungen derzeit nicht verfügbar. {resource.error}</p>
      : !resource.data ? <p className="monitoring-empty">Prüfziele werden geladen…</p>
      : <div className="monitoring-table-scroll"><table><caption className="sr-only">Erreichbarkeit und TLS-Restlaufzeit der Anwendungen</caption>
        <thead><tr>{['Anwendung', 'Prüfer', 'Erreichbarkeit', 'Letzte Prüfung', 'TLS-Restlaufzeit'].map(title => <th scope="col" key={title}>{title}</th>)}</tr></thead>
        <tbody>{resource.data.items.map(row => {
          const age = row.checkedAt ? (now - Date.parse(row.checkedAt)) / 1000 : Infinity;
          const fresh = age >= -30 && age <= row.maxAgeSeconds;
          const state = fresh ? row.state : 'unknown';
          return <tr key={`${row.id}:${row.observer}`}>
            <th scope="row">{row.name}</th><td>{row.observer ?? 'Keine Messdaten'}</td>
            <td><span className={`monitoring-pill monitoring-tone-${state}`}>{state === 'ok' ? 'Erreichbar' : state === 'critical' ? 'Nicht erreichbar' : row.reason === 'stale' || (row.checkedAt && !fresh) ? 'Veraltet' : 'Unbekannt'}</span></td>
            <td>{row.checkedAt ? new Date(row.checkedAt).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
            <td><span className={`monitoring-pill monitoring-tone-${!fresh || row.tlsDays == null ? 'unknown' : row.tlsDays <= 14 ? 'critical' : row.tlsDays <= 30 ? 'warning' : 'ok'}`}>
              {fresh && row.tlsDays != null ? `${row.tlsDays.toLocaleString('de-DE', { maximumFractionDigits: 1 })} Tage` : 'Unbekannt'}</span></td>
          </tr>;
        })}</tbody>
      </table></div>}
  </section>;
}
