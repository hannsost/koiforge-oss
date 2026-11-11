import type { MonitoringSensorDefinition, MonitoringWindow } from '../routes/monitoring.js';
import { ENDPOINT_QUERY, endpointAggregateQuery, parseEndpoints, type MonitoringEndpoint } from './endpoints.js';
import { neurofunkenQueries } from './neurofunken.js';

export interface MonitoringPoint {
  timestamp: string;
  value: number | null;
}

export interface MonitoringCurrentValue extends MonitoringPoint {
  sensorId: string;
}

export interface MonitoringSeries {
  sensorId: string;
  window: MonitoringWindow;
  points: MonitoringPoint[];
}

export interface MonitoringAlert {
  alertname: string;
  severity?: 'info' | 'warning' | 'critical';
  namespace?: string;
  state: 'pending' | 'firing';
  activeAt?: string;
}

export interface MonitoringQueryService {
  configured: boolean;
  current(sensor: MonitoringSensorDefinition): Promise<MonitoringCurrentValue>;
  series(sensor: MonitoringSensorDefinition, window: MonitoringWindow): Promise<MonitoringSeries>;
  alerts(): Promise<MonitoringAlert[]>;
  endpoints?(): Promise<MonitoringEndpoint[]>;
}

export class MonitoringUpstreamError extends Error {
  constructor(message = 'Monitoring upstream unavailable') {
    super(message);
    this.name = 'MonitoringUpstreamError';
  }
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const QUERY_BY_KEY: Record<MonitoringSensorDefinition['queryKey'], string> = {
  ...neurofunkenQueries,
  node_cpu_utilization:
    '100 * sum by(instance) (rate(container_cpu_usage_seconds_total{id="/"}[5m])) / max by(instance) (machine_cpu_cores)',
  node_memory_utilization:
    '100 * max by(instance) (container_memory_working_set_bytes{id="/"}) / max by(instance) (machine_memory_bytes)',
  node_root_filesystem_free:
    // Verified root mount on the monitored K3s node. Never choose a tmpfs/EFI
    // minimum; if the device changes, return unknown until inventory is updated.
    'max by(instance) (container_fs_limit_bytes{id="/",device="/dev/sda1"} - container_fs_usage_bytes{id="/",device="/dev/sda1"})',
  kubernetes_pods_not_ready:
    'sum((kube_pod_status_ready{condition="true"} == bool 0) and on(namespace,pod) (kube_pod_status_phase{phase=~"Pending|Running"} == 1))',
  kubernetes_deployments_unavailable:
    'sum(kube_deployment_status_replicas_unavailable)',
  flux_reconciliation_failed:
    // Current Flux exports state through kube-state-metrics, not controller
    // reconcile_condition. An absent inventory must not become a healthy zero.
    'sum(gotk_resource_info{suspended!="true",ready!="True"}) or (0 * count(gotk_resource_info{suspended!="true"}))',
  tls_certificate_expiry_days:
    endpointAggregateQuery('tls'),
  backup_age_hours:
    '(time() - max(neurofunken_backup_last_success_timestamp_seconds)) / 3600',
  endpoint_https_up:
    endpointAggregateQuery('https'),
  external_probe_age_hours:
    '(time() - min((neurofunken_external_probe_timestamp_seconds > 0) and (neurofunken_external_probe_timestamp_seconds <= time() + 30))) / 3600',
  external_probe_targets:
    'count(neurofunken_external_https_up) or vector(0)',
  alerts_active:
    'sum(ALERTS{alertstate="firing"}) or vector(0)',
};

const WINDOW_SECONDS: Record<MonitoringWindow, number> = {
  '15m': 15 * 60,
  '1h': 60 * 60,
  '6h': 6 * 60 * 60,
  '24h': 24 * 60 * 60,
  '7d': 7 * 24 * 60 * 60,
};

const STEP_SECONDS: Record<MonitoringWindow, number> = {
  '15m': 15,
  '1h': 60,
  '6h': 5 * 60,
  '24h': 15 * 60,
  '7d': 60 * 60,
};

interface PrometheusVectorResponse {
  status?: string;
  data?: {
    resultType?: string;
    result?: Array<{ value?: [number | string, string] }>;
  };
}

interface PrometheusMatrixResponse {
  status?: string;
  data?: {
    resultType?: string;
    result?: Array<{ values?: Array<[number | string, string]> }>;
  };
}

interface PrometheusAlertsResponse {
  status?: string;
  data?: {
    alerts?: Array<{
      labels?: Record<string, string>;
      state?: string;
      activeAt?: string;
    }>;
  };
}

function prometheusBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('KOIFORGE_PROMETHEUS_URL ist keine gültige URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('KOIFORGE_PROMETHEUS_URL muss eine HTTP(S)-Basis-URL ohne Zugangsdaten, Query oder Fragment sein.');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('KOIFORGE_PROMETHEUS_URL muss nur Origin und Port enthalten.');
  }
  return url.origin;
}

function numericValue(raw: string): number | null {
  if (raw === 'NaN' || raw === '+Inf' || raw === '-Inf') return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new MonitoringUpstreamError();
  return value;
}

function point(tuple: [number | string, string]): MonitoringPoint {
  const seconds = Number(tuple[0]);
  if (!Number.isFinite(seconds)) throw new MonitoringUpstreamError();
  return {
    timestamp: new Date(seconds * 1000).toISOString(),
    value: numericValue(tuple[1]),
  };
}

async function jsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) throw new MonitoringUpstreamError();
  const type = response.headers.get('content-type') ?? '';
  if (!type.toLowerCase().includes('application/json')) throw new MonitoringUpstreamError();
  try {
    if (!response.body) throw new MonitoringUpstreamError();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) { await reader.cancel(); throw new MonitoringUpstreamError(); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new MonitoringUpstreamError();
  }
}

export function createPrometheusMonitoringQueryService(
  baseUrl: string | undefined,
  fetchImpl: FetchLike = fetch,
): MonitoringQueryService {
  if (!baseUrl) {
    return {
      configured: false,
      async current() { throw new MonitoringUpstreamError('Monitoring not configured'); },
      async series() { throw new MonitoringUpstreamError('Monitoring not configured'); },
      async alerts() { throw new MonitoringUpstreamError('Monitoring not configured'); },
    };
  }

  const origin = prometheusBaseUrl(baseUrl);

  async function request<T>(path: '/api/v1/query' | '/api/v1/query_range' | '/api/v1/alerts', params = new URLSearchParams()): Promise<T> {
    const url = new URL(path, origin);
    url.search = params.toString();
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
        headers: { accept: 'application/json' },
      });
    } catch {
      throw new MonitoringUpstreamError();
    }
    return jsonResponse<T>(response);
  }

  return {
    configured: true,

    async current(sensor) {
      const payload = await request<PrometheusVectorResponse>(
        '/api/v1/query',
        new URLSearchParams({ query: QUERY_BY_KEY[sensor.queryKey] }),
      );
      if (payload.status !== 'success' || payload.data?.resultType !== 'vector' || !Array.isArray(payload.data.result)) {
        throw new MonitoringUpstreamError();
      }
      if (payload.data.result.length > 1) throw new MonitoringUpstreamError();
      const tuple = payload.data.result[0]?.value;
      const measured = tuple ? point(tuple) : { timestamp: new Date().toISOString(), value: null };
      return { sensorId: sensor.id, ...measured };
    },

    async endpoints() {
      const payload = await request<unknown>('/api/v1/query', new URLSearchParams({ query: ENDPOINT_QUERY }));
      try { return parseEndpoints(payload); } catch { throw new MonitoringUpstreamError(); }
    },

    async alerts() {
      const payload = await request<PrometheusAlertsResponse>('/api/v1/alerts');
      if (payload.status !== 'success' || !Array.isArray(payload.data?.alerts)) {
        throw new MonitoringUpstreamError();
      }
      const severities = new Set(['info', 'warning', 'critical']);
      const states = new Set(['pending', 'firing']);
      return payload.data.alerts.flatMap((alert) => {
        const labels = alert.labels ?? {};
        const alertname = labels.alertname;
        const state = alert.state;
        if (
          typeof alertname !== 'string'
          || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(alertname)
          || typeof state !== 'string'
          || !states.has(state)
        ) {
          return [];
        }
        const rawSeverity = labels.severity === 'page' ? 'critical' : labels.severity;
        const severity = typeof rawSeverity === 'string' && severities.has(rawSeverity)
          ? rawSeverity as 'info' | 'warning' | 'critical'
          : undefined;
        const namespace = typeof labels.namespace === 'string' && /^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/.test(labels.namespace)
          ? labels.namespace
          : undefined;
        const activeAt = typeof alert.activeAt === 'string' && !Number.isNaN(Date.parse(alert.activeAt))
          ? new Date(alert.activeAt).toISOString()
          : undefined;
        return [{ alertname, severity, namespace, state: state as 'pending' | 'firing', activeAt }];
      }).sort((a, b) => {
        const rank = (value?: string) => value === 'critical' ? 0 : value === 'warning' ? 1 : 2;
        return rank(a.severity) - rank(b.severity) || a.alertname.localeCompare(b.alertname);
      });
    },

    async series(sensor, window) {
      const end = Math.floor(Date.now() / 1000);
      const start = end - WINDOW_SECONDS[window];
      const payload = await request<PrometheusMatrixResponse>(
        '/api/v1/query_range',
        new URLSearchParams({
          query: QUERY_BY_KEY[sensor.queryKey],
          start: String(start),
          end: String(end),
          step: String(STEP_SECONDS[window]),
        }),
      );
      if (payload.status !== 'success' || payload.data?.resultType !== 'matrix' || !Array.isArray(payload.data.result)) {
        throw new MonitoringUpstreamError();
      }
      if (payload.data.result.length > 1) throw new MonitoringUpstreamError();
      const values = payload.data.result[0]?.values ?? [];
      return { sensorId: sensor.id, window, points: values.map(point) };
    },
  };
}
