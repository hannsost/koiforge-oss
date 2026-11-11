import { useCallback, useEffect, useState } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fetchMonitoringSeries, type MonitoringSensorSummary, type MonitoringWindow } from '../../api';
import { formatMonitoringValue, sensorLabels, stateLabels, visibleSensorState } from './model';
import { ApiError } from '../../http';

/** Each resource fails independently; superseded/unmounted requests cannot publish stale data. */
export function useMonitoringResource<T>(fetcher: (signal?: AbortSignal) => Promise<T>, refresh: number) {
  const [state, setState] = useState<{ data?: T; loading: boolean; error: string; loadedAt: number }>({ loading: true, error: '', loadedAt: 0 });
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    setState(previous => ({ ...previous, loading: true }));
    fetcher(controller.signal).then(data => {
      if (active) setState({ data, loading: false, error: '', loadedAt: Date.now() });
    }).catch(error => {
      const message = error instanceof ApiError && error.status === 403
        ? 'Zugriff verweigert (403). Dein angemeldetes Konto darf diese Messwerte nicht abrufen.'
        : error instanceof ApiError && error.status === 401
          ? 'Die Sitzung ist abgelaufen. Bitte erneut anmelden.'
          : 'Datenquelle nicht erreichbar oder nicht eingerichtet.';
      if (active) setState(previous => ({ ...previous, loading: false, error: message }));
    }).finally(() => window.clearTimeout(timeout));
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, [fetcher, refresh]);
  return state;
}

export function MonitoringKpi({ id, sensor, unavailable, loading }: { id: string; sensor?: MonitoringSensorSummary; unavailable: boolean; loading: boolean }) {
  const state = visibleSensorState(sensor, unavailable);
  return <article className={`monitoring-kpi monitoring-tone-${state}`} data-testid={`monitoring-sensor-${id}`}>
    <div className="monitoring-kpi-top"><h3>{sensorLabels[id] ?? sensor?.name ?? id}</h3><span className="monitoring-status-dot" title={stateLabels[state]} /></div>
    <div className="monitoring-value">{loading ? '…' : unavailable ? '—' : formatMonitoringValue(sensor?.value, sensor)}</div>
    <div className="monitoring-kpi-bottom"><span className="monitoring-pill">{loading ? 'Lädt' : state === 'ok' && sensor?.assessment === 'informational' ? 'Messwert' : stateLabels[state]}</span><span>{sensor?.group === 'node' ? 'Kubernetes-Node' : sensor?.group === 'flux' ? 'GitOps' : 'Prometheus'}</span></div>
    <p>{sensor?.description ?? 'Für diese Kennzahl sind noch keine Daten verfügbar.'}</p>
  </article>;
}

export function MonitoringChart({ id, sensor, range, refresh, now }: { id: string; sensor?: MonitoringSensorSummary; range: MonitoringWindow; refresh: number; now: number }) {
  const fetcher = useCallback((signal?: AbortSignal) => fetchMonitoringSeries(id, range, signal), [id, range]);
  const resource = useMonitoringResource(fetcher, refresh);
  const failed = !!resource.error || (!!resource.loadedAt && now - resource.loadedAt > 180_000);
  const points = resource.data?.points ?? [];
  const values = points.filter(point => point.value !== null && Number.isFinite(point.value));
  const label = sensorLabels[id] ?? sensor?.name ?? id;
  const isCount = sensor?.unit === 'count' || id === 'flux.reconciliation.failed';
  const isBoolean = sensor?.unit === 'boolean' && !isCount;
  const memoryThreshold = sensor?.unit === 'percent' && id !== 'runner.capacity.utilization';
  const step = ({ '15m': 15, '1h': 60, '6h': 300, '24h': 900, '7d': 3600 }[range]) * 1000;
  const chartData = points.flatMap((point, index) => {
    const time = Date.parse(point.timestamp);
    const previous = points[index - 1];
    // Prometheus omits absent samples rather than returning nulls for them.
    return previous && time - Date.parse(previous.timestamp) > step * 1.5
      ? [{ time: Date.parse(previous.timestamp) + step, value: null }, { ...point, time }]
      : [{ ...point, time }];
  });
  const last = values.at(-1);
  return <section className="monitoring-panel monitoring-chart" aria-label={`${label}: Verlauf`} aria-busy={resource.loading}>
    <div className="monitoring-panel-heading"><h3>{label}</h3><span className="monitoring-pill">{resource.loading ? 'Lädt…' : failed ? 'Nicht aktuell' : `${values.length} Messpunkte`}</span></div>
    <p className="monitoring-chart-caption">{sensor?.description ?? 'Messreihe aus Prometheus.'}</p>
    {failed ? <div className="monitoring-chart-empty" role="status">Verlauf nicht verfügbar. Bitte erneut aktualisieren.</div>
      : !values.length ? <div className="monitoring-chart-empty">{resource.loading ? 'Messreihe wird geladen…' : 'Keine Messpunkte für diesen Zeitraum vorhanden.'}</div>
      : <><div className="monitoring-chart-canvas">
        <ResponsiveContainer width="100%" height="100%"><LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }} accessibilityLayer>
          <CartesianGrid vertical={false} stroke="rgb(var(--rim))" strokeDasharray="3 4" />
          <XAxis dataKey="time" type="number" domain={['dataMin', 'dataMax']} scale="time" tickLine={false} axisLine={false} minTickGap={32} fontSize={11}
            tickFormatter={value => new Date(Number(value)).toLocaleString('de-DE', range === '7d' ? { day: '2-digit', month: '2-digit' } : { hour: '2-digit', minute: '2-digit' })} />
          <YAxis width={76} tickLine={false} axisLine={false} fontSize={11} allowDecimals={!isCount && !isBoolean}
            domain={isBoolean ? [0, 1] : sensor?.unit === 'percent' ? [0, 100] : sensor?.unit === 'days' ? ['auto', 'auto'] : [0, 'auto']}
            tickFormatter={value => isBoolean ? (Number(value) >= 1 ? 'Online' : 'Offline') : formatMonitoringValue(Number(value), sensor)} />
          {memoryThreshold && <ReferenceLine y={85} stroke="#a7661c" strokeDasharray="4 4" ifOverflow="extendDomain" />}
          <Tooltip labelFormatter={value => new Date(Number(value)).toLocaleString('de-DE')}
            formatter={value => [formatMonitoringValue(value == null ? null : Number(value), sensor), label]}
            contentStyle={{ borderRadius: 10, borderColor: 'rgb(var(--rim))', fontSize: 12 }} />
          <Line type={isBoolean || isCount ? 'stepAfter' : 'linear'} dataKey="value" stroke="#0f6b64" strokeWidth={2} dot={values.length === 1} connectNulls={false} isAnimationActive={false} />
        </LineChart></ResponsiveContainer>
      </div><div className="monitoring-chart-footer"><span>Zuletzt <b>{formatMonitoringValue(last?.value, sensor)}</b></span>
        <span>{last ? new Date(last.timestamp).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}{memoryThreshold ? ' · Linie: kritisch ab 85 %' : ''}</span></div></>}
  </section>;
}
