import assert from 'node:assert/strict';
import test from 'node:test';

import Fastify from 'fastify';
import type { SessionContext } from '@koiforge/security-core';

import type { AppRegistries } from '../src/registries.js';
import type { MonitoringQueryService } from '../src/monitoring/prometheus.js';
import {
  monitoringSensorState,
  registerMonitoringRoutes,
  registeredMonitoringSensors,
} from '../src/routes/monitoring.js';

const owner: SessionContext = {
  user: { id: 'owner', email: 'owner@example.test', displayName: 'Owner' },
  tenant: { id: 'demo', name: 'Demo', slug: 'demo', status: 'active' },
  roleIds: ['owner'],
  permissions: ['views.read'],
};

function appFixture(allow = true, monitoring?: MonitoringQueryService) {
  const app = Fastify();
  app.addHook('onRequest', async request => { request.koiforgeSession = owner; });
  const security = {
    assertPermissions(_session: SessionContext, permissions: string[]) {
      if (!allow || !permissions.every(permission => owner.permissions.includes(permission))) {
        throw new Error('Zugriff verweigert.');
      }
    },
  };
  registerMonitoringRoutes(app, { security } as unknown as AppRegistries, monitoring);
  return app;
}

test('monitoring catalog exposes stable sensor IDs without upstream query details', async t => {
  const app = appFixture(); t.after(() => app.close());
  const response = await app.inject('/api/monitoring/sensors');
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as { items: Array<Record<string, unknown>> };
  assert.equal(body.items.length, registeredMonitoringSensors().length);
  assert(body.items.some(sensor => sensor.id === 'node.cpu.utilization'));
  assert(body.items.some(sensor => sensor.id === 'endpoint.https.up'));
  for (const sensor of body.items) {
    assert.equal('queryKey' in sensor, false);
    assert.equal('url' in sensor, false);
    assert.equal('token' in sensor, false);
    assert.equal('promql' in sensor, false);
  }
});

test('monitoring sensor lookup is allowlisted and returns 404 for unknown IDs', async t => {
  const app = appFixture(); t.after(() => app.close());
  const known = await app.inject('/api/monitoring/sensors/tls.cert.expiry-days');
  assert.equal(known.statusCode, 200, known.body);
  assert.equal(known.json().id, 'tls.cert.expiry-days');

  const unknown = await app.inject('/api/monitoring/sensors/arbitrary.promql');
  assert.equal(unknown.statusCode, 404, unknown.body);
});

test('monitoring routes require view permission', async t => {
  const app = appFixture(false); t.after(() => app.close());
  assert.equal((await app.inject('/api/monitoring/sensors')).statusCode, 403);
  assert.equal((await app.inject('/api/monitoring/endpoints')).statusCode, 403);
});

test('endpoint route returns explicit partial coverage without bypassing permission checks', async t => {
  const monitoring: MonitoringQueryService = {
    configured: true,
    async current(sensor) { return { sensorId: sensor.id, timestamp: new Date().toISOString(), value: null }; },
    async series(sensor, window) { return { sensorId: sensor.id, window, points: [] }; },
    async alerts() { return []; },
    async endpoints() { return [{ id: 'koiforge', name: 'KoiForge', observer: null, state: 'unknown', checkedAt: null, maxAgeSeconds: 0, tlsDays: null, reason: 'missing' }]; },
  };
  const app = appFixture(true, monitoring); t.after(() => app.close());
  const response = await app.inject('/api/monitoring/endpoints');
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().source, 'degraded');
  assert.equal(response.json().items[0].state, 'unknown');
  assert.equal((await app.inject('/api/monitoring/summary')).json().source, 'degraded');
});


test('monitoring values stay unavailable until a metrics source is configured', async t => {
  const app = appFixture(); t.after(() => app.close());
  const current = await app.inject('/api/monitoring/sensors/node.cpu.utilization/value');
  assert.equal(current.statusCode, 503, current.body);
  const series = await app.inject('/api/monitoring/sensors/node.cpu.utilization/series?window=1h');
  assert.equal(series.statusCode, 503, series.body);
  assert.equal((await app.inject('/api/monitoring/endpoints')).statusCode, 503);
});

test('monitoring routes accept only registered windows and sensor IDs', async t => {
  const monitoring: MonitoringQueryService = {
    configured: true,
    async current(sensor) { return { sensorId: sensor.id, timestamp: '2026-09-26T12:00:00.000Z', value: 12.5 }; },
    async series(sensor, window) {
      return { sensorId: sensor.id, window, points: [{ timestamp: '2026-09-26T12:00:00.000Z', value: 12.5 }] };
    },
    async alerts() { return []; },
  };
  const app = appFixture(true, monitoring); t.after(() => app.close());

  const current = await app.inject('/api/monitoring/sensors/node.cpu.utilization/value');
  assert.equal(current.statusCode, 200, current.body);
  assert.equal(current.json().sensorId, 'node.cpu.utilization');

  const series = await app.inject('/api/monitoring/sensors/node.cpu.utilization/series?window=15m');
  assert.equal(series.statusCode, 200, series.body);
  assert.equal(series.json().window, '15m');

  assert.equal((await app.inject('/api/monitoring/sensors/node.cpu.utilization/series?window=90d')).statusCode, 400);
  assert.equal((await app.inject('/api/monitoring/sensors/free.promql/value')).statusCode, 404);
});


test('sensor state evaluation is server-side and explicit', () => {
  const sensors = new Map(registeredMonitoringSensors().map(sensor => [sensor.id, sensor]));
  assert.equal(monitoringSensorState(sensors.get('node.cpu.utilization')!, 20), 'ok');
  assert.equal(monitoringSensorState(sensors.get('node.cpu.utilization')!, 80), 'warning');
  assert.equal(monitoringSensorState(sensors.get('node.cpu.utilization')!, 90), 'critical');
  assert.equal(monitoringSensorState(sensors.get('node.filesystem.free')!, 4 * 1024 ** 3), 'critical');
  assert.equal(monitoringSensorState(sensors.get('kubernetes.deployments.unavailable')!, 1), 'critical');
  assert.equal(monitoringSensorState(sensors.get('endpoint.https.up')!, 1), 'ok');
  assert.equal(monitoringSensorState(sensors.get('endpoint.https.up')!, 0), 'critical');
  assert.equal(monitoringSensorState(sensors.get('tls.cert.expiry-days')!, null), 'unknown');
});

test('monitoring summary returns server-evaluated states and degrades individual upstream failures', async t => {
  const monitoring: MonitoringQueryService = {
    configured: true,
    async current(sensor) {
      if (sensor.id === 'backup.age-hours') {
        const { MonitoringUpstreamError } = await import('../src/monitoring/prometheus.js');
        throw new MonitoringUpstreamError();
      }
      const values: Record<string, number> = {
        'node.cpu.utilization': 80,
        'kubernetes.deployments.unavailable': 1,
        'endpoint.https.up': 1,
      };
      return {
        sensorId: sensor.id,
        timestamp: '2026-09-26T12:00:00.000Z',
        value: values[sensor.id] ?? 0,
      };
    },
    async series(sensor, window) { return { sensorId: sensor.id, window, points: [] }; },
    async alerts() {
      return [{
        alertname: 'ExternalProbeTelemetryMissing',
        severity: 'warning',
        state: 'firing',
        activeAt: '2026-09-26T12:00:00.000Z',
      }];
    },
  };
  const app = appFixture(true, monitoring); t.after(() => app.close());

  const response = await app.inject('/api/monitoring/summary');
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.source, 'degraded');
  const byId = new Map(body.items.map((item: any) => [item.id, item]));
  assert.equal((byId.get('node.cpu.utilization') as any).state, 'warning');
  assert.equal((byId.get('kubernetes.deployments.unavailable') as any).state, 'critical');
  assert.equal((byId.get('endpoint.https.up') as any).state, 'ok');
  assert.equal((byId.get('backup.age-hours') as any).state, 'unknown');
  for (const item of body.items) {
    assert.equal('queryKey' in item, false);
    assert.equal('statusRule' in item, false);
  }
});


test('monitoring alerts route exposes only filtered alert fields', async t => {
  const monitoring: MonitoringQueryService = {
    configured: true,
    async current(sensor) { return { sensorId: sensor.id, timestamp: '2026-09-26T12:00:00.000Z', value: 0 }; },
    async series(sensor, window) { return { sensorId: sensor.id, window, points: [] }; },
    async alerts() {
      return [{
        alertname: 'MonitoringTargetDown',
        severity: 'critical',
        namespace: 'flux-system',
        state: 'firing',
        activeAt: '2026-09-26T12:00:00.000Z',
      }];
    },
  };
  const app = appFixture(true, monitoring); t.after(() => app.close());
  const response = await app.inject('/api/monitoring/alerts');
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), {
    items: [{
      alertname: 'MonitoringTargetDown',
      severity: 'critical',
      namespace: 'flux-system',
      state: 'firing',
      activeAt: '2026-09-26T12:00:00.000Z',
    }],
  });
});
