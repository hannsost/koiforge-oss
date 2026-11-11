import type { FastifyInstance } from 'fastify';

import type { AppRegistries } from '../registries.js';
import type { MonitoringQueryService } from '../monitoring/prometheus.js';
import { MonitoringUpstreamError } from '../monitoring/prometheus.js';
import { createSessionGuard } from './_guard.js';
import { neurofunkenSensors } from '../monitoring/neurofunken.js';

export type MonitoringSensorKind =
  | 'gauge'
  | 'status'
  | 'duration'
  | 'count';

export type MonitoringWindow = '15m' | '1h' | '6h' | '24h' | '7d';

export type MonitoringSensorState = 'ok' | 'warning' | 'critical' | 'unknown';

type MonitoringStatusRule =
  | { mode: 'informational' }
  | { mode: 'max'; warning: number; critical: number }
  | { mode: 'min'; warning: number; critical: number }
  | { mode: 'nonzero'; level: 'warning' | 'critical' }
  | { mode: 'binary-up' };

export type MonitoringQueryKey =
  | 'node_cpu_utilization'
  | 'node_memory_utilization'
  | 'node_root_filesystem_free'
  | 'kubernetes_pods_not_ready'
  | 'kubernetes_deployments_unavailable'
  | 'flux_reconciliation_failed'
  | 'tls_certificate_expiry_days'
  | 'backup_age_hours'
  | 'endpoint_https_up'
  | 'external_probe_age_hours'
  | 'external_probe_targets'
  | 'alerts_active'
  | 'cluster_restarts' | 'cluster_pressure' | 'scrape_failures'
  | 'certificates_not_ready' | 'cluster_certificate_expiry'
  | 'runner_jobs' | 'runner_utilization'
  | 'memory_koiforge' | 'memory_solveit' | 'memory_keycloak' | 'memory_symphony' | 'memory_mcp';

export interface MonitoringSensorDefinition {
  id: string;
  name: string;
  group: 'node' | 'kubernetes' | 'flux' | 'tls' | 'backup' | 'endpoint' | 'alerts' | 'runner' | 'application' | 'monitoring';
  kind: MonitoringSensorKind;
  unit?: 'percent' | 'bytes' | 'count' | 'days' | 'hours' | 'boolean';
  description: string;
  defaultWindow: MonitoringWindow;
  /** Internal lookup key. Never serialize this field to clients. */
  queryKey: MonitoringQueryKey;
  /** Internal state rule. Never serialize raw thresholds to clients. */
  statusRule: MonitoringStatusRule;
}

const WINDOWS = new Set<MonitoringWindow>(['15m', '1h', '6h', '24h', '7d']);

const SENSOR_CATALOG: readonly MonitoringSensorDefinition[] = [
  {
    id: 'node.cpu.utilization',
    name: 'Node CPU',
    group: 'node',
    kind: 'gauge',
    unit: 'percent',
    description: 'CPU-Auslastung des Kubernetes-Nodes.',
    defaultWindow: '1h',
    queryKey: 'node_cpu_utilization',
    statusRule: { mode: 'max', warning: 75, critical: 85 },
  },
  {
    id: 'node.memory.utilization',
    name: 'Node Arbeitsspeicher',
    group: 'node',
    kind: 'gauge',
    unit: 'percent',
    description: 'Arbeitsspeicher-Auslastung des Kubernetes-Nodes.',
    defaultWindow: '1h',
    queryKey: 'node_memory_utilization',
    statusRule: { mode: 'max', warning: 75, critical: 85 },
  },
  {
    id: 'node.filesystem.free',
    name: 'Freier Root-Speicher',
    group: 'node',
    kind: 'gauge',
    unit: 'bytes',
    description: 'Freier Speicher auf dem verifizierten Root-Gerät /dev/sda1 des Kubernetes-Nodes, einschließlich reservierter Blöcke.',
    defaultWindow: '6h',
    queryKey: 'node_root_filesystem_free',
    statusRule: { mode: 'min', warning: 10 * 1024 ** 3, critical: 5 * 1024 ** 3 },
  },
  {
    id: 'kubernetes.pods.not-ready',
    name: 'Pods nicht Ready',
    group: 'kubernetes',
    kind: 'count',
    unit: 'count',
    description: 'Anzahl der Pods, die aktuell nicht Ready sind.',
    defaultWindow: '1h',
    queryKey: 'kubernetes_pods_not_ready',
    statusRule: { mode: 'nonzero', level: 'warning' },
  },
  {
    id: 'kubernetes.deployments.unavailable',
    name: 'Deployments nicht verfügbar',
    group: 'kubernetes',
    kind: 'count',
    unit: 'count',
    description: 'Summe der aktuell nicht verfügbaren Deployment-Replikas.',
    defaultWindow: '1h',
    queryKey: 'kubernetes_deployments_unavailable',
    statusRule: { mode: 'nonzero', level: 'critical' },
  },
  {
    id: 'flux.reconciliation.failed',
    name: 'Flux Reconciliation',
    group: 'flux',
    kind: 'count',
    unit: 'count',
    description: 'Zeigt fehlgeschlagene Flux-Reconciliations an.',
    defaultWindow: '1h',
    queryKey: 'flux_reconciliation_failed',
    statusRule: { mode: 'nonzero', level: 'critical' },
  },
  {
    id: 'tls.cert.expiry-days',
    name: 'Web-TLS Restlaufzeit',
    group: 'tls',
    kind: 'duration',
    unit: 'days',
    description: 'Kürzeste TLS-Restlaufzeit der aktiven HTTPS-Dienste. SMTP-/Mail-Zertifikate stehen separat in der Anwendungstabelle.',
    defaultWindow: '24h',
    queryKey: 'tls_certificate_expiry_days',
    statusRule: { mode: 'min', warning: 30, critical: 14 },
  },
  {
    id: 'backup.age-hours',
    name: 'Backup-Alter',
    group: 'backup',
    kind: 'duration',
    unit: 'hours',
    description: 'Alter des letzten erfolgreich bestätigten Backups.',
    defaultWindow: '24h',
    queryKey: 'backup_age_hours',
    statusRule: { mode: 'max', warning: 24, critical: 48 },
  },
  {
    id: 'endpoint.https.up',
    name: 'Öffentliche HTTPS-Endpunkte',
    group: 'endpoint',
    kind: 'status',
    unit: 'boolean',
    description: 'Erreichbarkeit der aktiven öffentlichen HTTPS-/Health-Ziele. Mailprüfungen stehen separat in der Anwendungstabelle.',
    defaultWindow: '1h',
    queryKey: 'endpoint_https_up',
    statusRule: { mode: 'binary-up' },
  },
  {
    id: 'endpoint.probe.age-hours',
    name: 'External Probe Alter',
    group: 'endpoint',
    kind: 'duration',
    unit: 'hours',
    description: 'Alter der letzten externen HTTPS-/TLS-Beobachtung.',
    defaultWindow: '6h',
    queryKey: 'external_probe_age_hours',
    statusRule: { mode: 'max', warning: 0.75, critical: 1.5 },
  },
  {
    id: 'endpoint.probe.targets',
    name: 'External Probe Ziele',
    group: 'endpoint',
    kind: 'count',
    unit: 'count',
    description: 'Anzahl aktuell gelieferter externer Zielserien.',
    defaultWindow: '1h',
    queryKey: 'external_probe_targets',
    statusRule: { mode: 'min', warning: 1, critical: 0 },
  },
  {
    id: 'alerts.active',
    name: 'Aktive Alarme',
    group: 'alerts',
    kind: 'count',
    unit: 'count',
    description: 'Anzahl aktuell aktiver, nicht entwarnter Alarme.',
    defaultWindow: '1h',
    queryKey: 'alerts_active',
    statusRule: { mode: 'nonzero', level: 'warning' },
  },
  ...neurofunkenSensors,
] as const;

function publicSensor(sensor: MonitoringSensorDefinition) {
  const { queryKey: _queryKey, statusRule: _statusRule, ...publicDefinition } = sensor;
  return { ...publicDefinition, assessment: _statusRule.mode === 'informational' ? 'informational' : 'threshold' };
}

export function monitoringSensorState(
  sensor: MonitoringSensorDefinition,
  value: number | null,
): MonitoringSensorState {
  if (value === null || !Number.isFinite(value)) return 'unknown';
  const rule = sensor.statusRule;
  if (rule.mode === 'informational') return 'ok';
  if (rule.mode === 'max') {
    if (value >= rule.critical) return 'critical';
    if (value >= rule.warning) return 'warning';
    return 'ok';
  }
  if (rule.mode === 'min') {
    if (value <= rule.critical) return 'critical';
    if (value <= rule.warning) return 'warning';
    return 'ok';
  }
  if (rule.mode === 'nonzero') return value > 0 ? rule.level : 'ok';
  return value >= 1 ? 'ok' : 'critical';
}

function sensorById(sensorId: string): MonitoringSensorDefinition | undefined {
  return SENSOR_CATALOG.find((candidate) => candidate.id === sensorId);
}

function unavailable(reply: { code(statusCode: number): unknown }) {
  reply.code(503);
  return { error: 'Monitoring-Datenquelle ist nicht konfiguriert.' };
}

function upstreamFailure(reply: { code(statusCode: number): unknown }) {
  reply.code(502);
  return { error: 'Monitoring-Datenquelle ist vorübergehend nicht verfügbar.' };
}

export function registeredMonitoringSensors(): readonly MonitoringSensorDefinition[] {
  return SENSOR_CATALOG;
}

export function registerMonitoringRoutes(
  app: FastifyInstance,
  registries: AppRegistries,
  monitoring?: MonitoringQueryService,
): void {
  const { guard } = createSessionGuard(registries.security);

  app.get('/api/monitoring/sensors', async (request, reply) => {
    if (!(await guard(request, reply, ['views.read']))) return reply;
    return { items: SENSOR_CATALOG.map(publicSensor) };
  });

  app.get('/api/monitoring/sensors/:sensorId', async (request, reply) => {
    if (!(await guard(request, reply, ['views.read']))) return reply;
    const sensor = sensorById((request.params as { sensorId: string }).sensorId);
    if (!sensor) {
      reply.code(404);
      return { error: 'Monitoring-Sensor wurde nicht gefunden.' };
    }
    return publicSensor(sensor);
  });

  app.get('/api/monitoring/sensors/:sensorId/value', async (request, reply) => {
    if (!(await guard(request, reply, ['views.read']))) return reply;
    const sensor = sensorById((request.params as { sensorId: string }).sensorId);
    if (!sensor) {
      reply.code(404);
      return { error: 'Monitoring-Sensor wurde nicht gefunden.' };
    }
    if (!monitoring?.configured) return unavailable(reply);
    try {
      const current = await monitoring.current(sensor);
      return { ...current, state: monitoringSensorState(sensor, current.value) };
    } catch (error) {
      if (error instanceof MonitoringUpstreamError) return upstreamFailure(reply);
      throw error;
    }
  });

  app.get('/api/monitoring/alerts', async (request, reply) => {
    if (!(await guard(request, reply, ['views.read']))) return reply;
    if (!monitoring?.configured) return unavailable(reply);
    try {
      return { items: await monitoring.alerts() };
    } catch (error) {
      if (error instanceof MonitoringUpstreamError) return upstreamFailure(reply);
      throw error;
    }
  });

  app.get('/api/monitoring/summary', async (request, reply) => {
    if (!(await guard(request, reply, ['views.read']))) return reply;
    if (!monitoring?.configured) return unavailable(reply);

    let upstreamFailures = 0;
    const items = await Promise.all(SENSOR_CATALOG.map(async (sensor) => {
      try {
        const current = await monitoring.current(sensor);
        return {
          ...publicSensor(sensor),
          timestamp: current.timestamp,
          value: current.value,
          state: monitoringSensorState(sensor, current.value),
        };
      } catch (error) {
        if (!(error instanceof MonitoringUpstreamError)) throw error;
        upstreamFailures += 1;
        return {
          ...publicSensor(sensor),
          timestamp: new Date().toISOString(),
          value: null,
          state: 'unknown' as const,
        };
      }
    }));

    return {
      source: upstreamFailures > 0 || items.some(item => item.state === 'unknown') ? 'degraded' : 'ready',
      items,
    };
  });

  app.get('/api/monitoring/endpoints', async (request, reply) => {
    if (!(await guard(request, reply, ['views.read']))) return reply;
    if (!monitoring?.configured || !monitoring.endpoints) return unavailable(reply);
    try {
      const items = await monitoring.endpoints();
      return { source: items.some(item => item.state === 'unknown') ? 'degraded' : 'ready', observedAt: new Date().toISOString(), items };
    } catch (error) {
      if (error instanceof MonitoringUpstreamError) return upstreamFailure(reply);
      throw error;
    }
  });

  app.get<{ Querystring: { window?: string } }>('/api/monitoring/sensors/:sensorId/series', async (request, reply) => {
    if (!(await guard(request, reply, ['views.read']))) return reply;
    const sensor = sensorById((request.params as { sensorId: string }).sensorId);
    if (!sensor) {
      reply.code(404);
      return { error: 'Monitoring-Sensor wurde nicht gefunden.' };
    }
    const requestedWindow = request.query.window ?? sensor.defaultWindow;
    if (!WINDOWS.has(requestedWindow as MonitoringWindow)) {
      reply.code(400);
      return { error: 'Unbekanntes Monitoring-Zeitfenster.' };
    }
    if (!monitoring?.configured) return unavailable(reply);
    try {
      return await monitoring.series(sensor, requestedWindow as MonitoringWindow);
    } catch (error) {
      if (error instanceof MonitoringUpstreamError) return upstreamFailure(reply);
      throw error;
    }
  });
}
