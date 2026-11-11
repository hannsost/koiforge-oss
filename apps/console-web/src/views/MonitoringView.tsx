import { useEffect, useState } from 'react';
import { Activity, ArrowUpRight, Boxes, GitBranch, LayoutDashboard, RefreshCw, Server, ShieldCheck } from 'lucide-react';
import { fetchMonitoringAlerts, fetchMonitoringSummary, type MonitoringWindow } from '../api';
import { GitLabQueueCard } from '../components/GitLabQueueCard';
import { MonitoringChart, MonitoringKpi, useMonitoringResource } from '../components/monitoring/MonitoringWidgets';
import { ApplicationsTable } from '../components/monitoring/ApplicationsTable';
import { dashboardViews, readDashboardLocation, stateLabels, type DashboardViewId } from '../components/monitoring/model';
import './monitoring.css';

const icons = { overview: LayoutDashboard, infrastructure: Server, applications: Boxes, ci: GitBranch, security: ShieldCheck };
const ranges: Array<[MonitoringWindow, string]> = [['15m', '15 Minuten'], ['1h', '1 Stunde'], ['6h', '6 Stunden'], ['24h', '24 Stunden'], ['7d', '7 Tage']];

export function MonitoringView() {
  const [location, setLocation] = useState(readDashboardLocation);
  const [refresh, setRefresh] = useState(0);
  const [automatic, setAutomatic] = useState(true);
  const [now, setNow] = useState(Date.now);
  const summary = useMonitoringResource(fetchMonitoringSummary, refresh);
  const alerts = useMonitoringResource(fetchMonitoringAlerts, refresh);
  const view = dashboardViews.find(candidate => candidate.id === location.view) ?? dashboardViews[0]!;
  const stale = !!summary.loadedAt && now - summary.loadedAt > 180_000;
  const unavailable = !!summary.error || stale;
  const sensors = summary.data?.items ?? [];
  const counts = Object.fromEntries(Object.keys(stateLabels).map(state => [state, sensors.filter(sensor => sensor.state === state).length]));
  const incomplete = unavailable || !summary.data || !sensors.length || summary.data.source !== 'ready' || !!counts.unknown || !!alerts.error || !alerts.data || (!!alerts.loadedAt && now - alerts.loadedAt > 180_000);
  const status = summary.loading && !summary.data ? 'Verbindung wird geprüft' : unavailable ? 'Messwerte nicht aktuell'
    : counts.critical ? 'Handlungsbedarf' : counts.warning ? 'Hinweise prüfen' : incomplete ? 'Daten unvollständig' : 'Erfasste Kennzahlen unauffällig';
  const statusTone = unavailable ? 'unknown' : counts.critical ? 'critical' : counts.warning ? 'warning' : incomplete ? 'unknown' : 'ok';

  useEffect(() => {
    const onHash = () => setLocation(readDashboardLocation());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!automatic) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') setRefresh(value => value + 1);
    }, 60_000);
    const onVisible = () => { if (document.visibilityState === 'visible') setRefresh(value => value + 1); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [automatic]);

  function navigate(viewId: DashboardViewId, range = location.range) {
    window.location.hash = `/monitoring?view=${viewId}&range=${range}`;
    setLocation({ view: viewId, range });
  }

  return <div className="monitoring-dashboard" data-testid="monitoring-view">
    <header className="monitoring-header">
      <div><p className="monitoring-eyebrow"><Activity size={15} aria-hidden="true" /> Betriebsübersicht</p>
        <h1>Alles Wichtige im Blick.</h1>
        <p className="monitoring-muted">Infrastruktur, Anwendungen und Auslieferung — an einem Ort.</p>
      </div>
      <div className="monitoring-controls">
        <label>Zeitraum<select aria-label="Monitoring-Zeitfenster" value={location.range}
          onChange={event => navigate(location.view, event.target.value as MonitoringWindow)}>
          {ranges.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <button className="monitoring-refresh" type="button" onClick={() => setRefresh(value => value + 1)}
          disabled={summary.loading || alerts.loading} aria-label="Alle Messwerte aktualisieren">
          <RefreshCw size={17} aria-hidden="true" className={summary.loading ? 'monitoring-spin' : ''} /> Aktualisieren
        </button>
      </div>
    </header>

    <nav className="monitoring-tabs" aria-label="Monitoring-Themen">
      {dashboardViews.map(item => { const Icon = icons[item.id]; return <a key={item.id}
        href={`#/monitoring?view=${item.id}&range=${location.range}`} aria-current={item.id === view.id ? 'page' : undefined}>
        <Icon size={17} aria-hidden="true" />{item.label}
      </a>; })}
    </nav>

    <section className={`monitoring-health monitoring-tone-${statusTone}`} aria-label="Datenstatus">
      <div className="monitoring-health-title"><span className="monitoring-status-dot" /><div>
        <strong>{status}</strong><p>{summary.loadedAt ? `Letzter erfolgreicher Abruf: ${new Date(summary.loadedAt).toLocaleTimeString('de-DE')}` : 'Noch kein erfolgreicher Abruf'}
          {' · '}Prometheus · {sensors.length} Kennzahlen</p>
      </div></div>
      <div className="monitoring-health-counts" aria-label="Zustände der erfassten Kennzahlen">
        {(['critical', 'warning', 'unknown'] as const).map(state => <span key={state}>
          <b>{unavailable || !summary.data ? '—' : counts[state]}</b> {stateLabels[state]}</span>)}
      </div>
      <label className="monitoring-auto"><input type="checkbox" checked={automatic} onChange={event => setAutomatic(event.target.checked)} /> Live · 60 s</label>
    </section>
    {summary.error && <p role="alert" className="monitoring-notice">Messwerte konnten nicht aktualisiert werden. {summary.error} Vorherige Werte gelten nicht als aktueller Status.</p>}
    {stale && !summary.error && <p role="status" className="monitoring-notice">Der letzte Abruf ist über 3 Minuten alt. Bitte aktualisieren; die Statusanzeige ist bis dahin unbekannt.</p>}

    <div className="monitoring-section-heading"><div><p className="monitoring-eyebrow">{view.kicker}</p><h2>{view.title}</h2><p className="monitoring-muted">{view.description}</p></div>
      <span className="monitoring-range-note">{ranges.find(([range]) => range === location.range)?.[1]} Verlauf</span>
    </div>
    <div className="monitoring-kpis">
      {view.sensors.map(id => <MonitoringKpi key={id} id={id} sensor={sensors.find(sensor => sensor.id === id)} unavailable={unavailable} loading={summary.loading && !summary.data} />)}
    </div>

    {view.id === 'ci' && <GitLabQueueCard refreshKey={refresh} autoRefresh={automatic} now={now} />}
    {view.id === 'applications' && <ApplicationsTable refresh={refresh} now={now} />}

    <section className="monitoring-charts" aria-label={`${view.label}: Verläufe`}>
      {view.charts.map(id => <MonitoringChart key={`${id}:${location.range}`} id={id} sensor={sensors.find(sensor => sensor.id === id)} range={location.range} refresh={refresh} now={now} />)}
    </section>
    <p className="monitoring-footnote">Zeitstempel in lokaler Zeit. Lücken werden nicht interpoliert. Der gewählte Zeitraum kann länger sein als die verfügbare Datenaufbewahrung.</p>

    <div className="monitoring-bottom-grid">
      <section className="monitoring-panel monitoring-alerts" aria-label="Aktive Alarme">
        <div className="monitoring-panel-heading"><h3>Aktive Alarme</h3><span className="monitoring-pill">{alerts.error || !alerts.data || (alerts.loadedAt && now - alerts.loadedAt > 180_000) ? 'Unbekannt' : alerts.data.items.length}</span></div>
        {alerts.error || (alerts.loadedAt && now - alerts.loadedAt > 180_000) ? <p role="alert" className="monitoring-notice">Alarmstatus nicht verfügbar. {alerts.error} Keine Entwarnung möglich.</p>
          : !alerts.data ? <p className="monitoring-empty">Alarme werden abgefragt…</p>
          : !alerts.data.items.length ? <p className="monitoring-empty">Keine aktiven Prometheus-Alarme gemeldet.<small>Das ersetzt keine Prüfung fehlender Messdaten.</small></p>
          : <ul>{alerts.data.items.map((alert, index) => <li key={`${alert.alertname}:${alert.namespace}:${index}`}>
            <span className={`monitoring-pill monitoring-tone-${alert.severity === 'critical' ? 'critical' : 'warning'}`}>{alert.state === 'firing' ? 'Aktiv' : 'Ausstehend'}</span>
            <div><strong>{alert.alertname}</strong><small>{alert.namespace ?? 'Plattform'}{alert.activeAt ? ` · seit ${new Date(alert.activeAt).toLocaleString('de-DE')}` : ''}</small></div>
          </li>)}</ul>}
      </section>
      <aside className="monitoring-panel monitoring-context"><p className="monitoring-eyebrow">Einordnung</p><h3>{view.noteTitle}</h3><p>{view.note}</p>
        {view.id === 'overview' && <a href={`#/monitoring?view=ci&range=${location.range}`}>GitLab-Warteschlange öffnen <ArrowUpRight size={16} aria-hidden="true" /></a>}
        <div className="monitoring-gap"><span className="monitoring-pill">Noch nicht erfasst</span><p>{view.gap}</p></div>
      </aside>
    </div>
  </div>;
}
