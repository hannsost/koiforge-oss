import assert from 'node:assert/strict';
import test from 'node:test';

import { createPrometheusMonitoringQueryService, MonitoringUpstreamError } from '../src/monitoring/prometheus.js';
import { registeredMonitoringSensors } from '../src/routes/monitoring.js';

const cpu = registeredMonitoringSensors().find(sensor => sensor.id === 'node.cpu.utilization')!;

test('live query regressions: root device, current Flux inventory and valid observation time', async () => {
  const queries: string[] = [];
  const service = createPrometheusMonitoringQueryService('https://metrics.example.test', async input => {
    queries.push(new URL(input).searchParams.get('query')!);
    return Response.json({ status: 'success', data: { resultType: new URL(input).pathname.endsWith('query_range') ? 'matrix' : 'vector', result: [] } });
  });
  for (const id of ['node.filesystem.free', 'flux.reconciliation.failed', 'endpoint.probe.age-hours']) {
    const sensor = registeredMonitoringSensors().find(item => item.id === id)!;
    assert.equal((await service.current(sensor)).value, null, 'missing data stays unknown');
    await service.series(sensor, '6h');
  }
  assert.match(queries[0]!, /device="\/dev\/sda1"/);
  assert.doesNotMatch(queries[0]!, /min by/);
  assert.match(queries[2]!, /gotk_resource_info/);
  assert.match(queries[2]!, /suspended!="true"/);
  assert.doesNotMatch(queries[2]!, /or vector\(0\)/);
  assert.match(queries[4]!, /timestamp_seconds > 0/);
  assert.match(queries[4]!, /timestamp_seconds <= time\(\) \+ 30/);
});

test('Prometheus rejects unbounded response bodies', async () => {
  const service = createPrometheusMonitoringQueryService('https://metrics.example.test', async () =>
    new Response(' '.repeat(1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }));
  await assert.rejects(service.current(cpu), MonitoringUpstreamError);
});

test('Prometheus client sends only the server-side registered query', async () => {
  let requested: URL | undefined;
  const service = createPrometheusMonitoringQueryService('http://prometheus.monitoring.svc.cluster.local:9090', async input => {
    requested = new URL(input);
    return new Response(JSON.stringify({
      status: 'success',
      data: { resultType: 'vector', result: [{ value: [1790416800, '12.5'] }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  const result = await service.current(cpu);
  assert.equal(result.sensorId, cpu.id);
  assert.equal(result.value, 12.5);
  assert.equal(requested?.pathname, '/api/v1/query');
  assert.equal(requested?.searchParams.has('query'), true);
  assert.match(requested?.searchParams.get('query') ?? '', /container_cpu_usage_seconds_total/);
});

test('Prometheus range query uses bounded server-side windows', async () => {
  let requested: URL | undefined;
  const service = createPrometheusMonitoringQueryService('https://metrics.example.test', async input => {
    requested = new URL(input);
    return new Response(JSON.stringify({
      status: 'success',
      data: { resultType: 'matrix', result: [{ values: [[1790416800, '10'], [1790416860, '11']] }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  const result = await service.series(cpu, '1h');
  assert.equal(result.points.length, 2);
  assert.equal(requested?.pathname, '/api/v1/query_range');
  assert.equal(requested?.searchParams.get('step'), '60');
  const start = Number(requested?.searchParams.get('start'));
  const end = Number(requested?.searchParams.get('end'));
  assert.equal(end - start, 3600);
});

test('Prometheus client rejects unsafe configuration and malformed upstream responses', async () => {
  assert.throws(() => createPrometheusMonitoringQueryService('https://user:secret@example.test'), /ohne Zugangsdaten/);
  assert.throws(() => createPrometheusMonitoringQueryService('file:///tmp/prometheus'), /HTTP\(S\)/);
  assert.throws(() => createPrometheusMonitoringQueryService('https://example.test/prometheus'), /Origin und Port/);

  const service = createPrometheusMonitoringQueryService('https://metrics.example.test', async () =>
    new Response('<html>nope</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
  await assert.rejects(service.current(cpu), MonitoringUpstreamError);
});


test('node sensors use restricted-compatible cAdvisor metrics rather than host exporters', async () => {
  const requested: string[] = [];
  const service = createPrometheusMonitoringQueryService('https://metrics.example.test', async input => {
    const url = new URL(input);
    requested.push(url.searchParams.get('query') ?? '');
    return new Response(JSON.stringify({
      status: 'success',
      data: { resultType: 'vector', result: [{ value: [1790416800, '1'] }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  for (const sensorId of ['node.cpu.utilization', 'node.memory.utilization', 'node.filesystem.free']) {
    const sensor = registeredMonitoringSensors().find(candidate => candidate.id === sensorId)!;
    await service.current(sensor);
  }

  assert.equal(requested.length, 3);
  assert(requested.every(query => !query.includes('node_cpu_seconds_total')));
  assert(requested.every(query => !query.includes('node_memory_')));
  assert(requested.every(query => !query.includes('node_filesystem_')));
  assert(requested.some(query => query.includes('container_cpu_usage_seconds_total')));
  assert(requested.some(query => query.includes('container_memory_working_set_bytes')));
  assert(requested.some(query => query.includes('container_fs_usage_bytes')));
});


test('external availability sensors depend only on the NeuroFunken external metric contract', async () => {
  const queries: Record<string, string> = {};
  const service = createPrometheusMonitoringQueryService('https://metrics.example.test', async input => {
    const url = new URL(input);
    const query = url.searchParams.get('query') ?? '';
    const id = query.includes('tls_expiry') ? 'tls' : 'https';
    queries[id] = query;
    return new Response(JSON.stringify({
      status: 'success',
      data: { resultType: 'vector', result: [{ value: [1790416800, '1'] }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  await service.current(registeredMonitoringSensors().find(sensor => sensor.id === 'tls.cert.expiry-days')!);
  await service.current(registeredMonitoringSensors().find(sensor => sensor.id === 'endpoint.https.up')!);

  assert.match(queries.tls, /neurofunken_external_tls_expiry_timestamp_seconds/);
  assert.match(queries.https, /neurofunken_external_https_up/);
  assert(Object.values(queries).every(query => query.includes('neurofunken_external_probe_timestamp_seconds')));
  assert(Object.values(queries).every(query => query.includes('== 7')));
  assert(Object.values(queries).every(query => !query.includes('mail-mx')));
});


test('external probe freshness sensors use only registered NeuroFunken metrics', async () => {
  const requested: Record<string, string> = {};
  const service = createPrometheusMonitoringQueryService('https://metrics.example.test', async input => {
    const url = new URL(input);
    const query = url.searchParams.get('query') ?? '';
    if (query.includes('probe_timestamp')) requested.age = query;
    if (query.includes('count(neurofunken_external_https_up)')) requested.targets = query;
    return new Response(JSON.stringify({
      status: 'success',
      data: { resultType: 'vector', result: [{ value: [1790416800, '1'] }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  await service.current(registeredMonitoringSensors().find(sensor => sensor.id === 'endpoint.probe.age-hours')!);
  await service.current(registeredMonitoringSensors().find(sensor => sensor.id === 'endpoint.probe.targets')!);

  assert.match(requested.age, /neurofunken_external_probe_timestamp_seconds/);
  assert.match(requested.targets, /count\(neurofunken_external_https_up\)/);
});

test('active alerts are allowlisted and arbitrary labels are never returned', async () => {
  const service = createPrometheusMonitoringQueryService('https://metrics.example.test', async input => {
    const url = new URL(input);
    assert.equal(url.pathname, '/api/v1/alerts');
    return new Response(JSON.stringify({
      status: 'success',
      data: {
        alerts: [
          {
            labels: {
              alertname: 'ExternalProbeTelemetryMissing',
              severity: 'warning',
              namespace: 'monitoring',
              secret: 'must-not-leak',
            },
            state: 'firing',
            activeAt: '2026-09-26T12:00:00Z',
            annotations: { summary: 'must-not-leak' },
          },
          {
            labels: { alertname: 'AgentQueueStalled' },
            state: 'pending',
          },
        ],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  const alerts = await service.alerts();
  assert.deepEqual(alerts, [
    {
      alertname: 'ExternalProbeTelemetryMissing',
      severity: 'warning',
      namespace: 'monitoring',
      state: 'firing',
      activeAt: '2026-09-26T12:00:00.000Z',
    },
    {
      alertname: 'AgentQueueStalled',
      severity: undefined,
      namespace: undefined,
      state: 'pending',
      activeAt: undefined,
    },
  ]);
  assert.equal(JSON.stringify(alerts).includes('must-not-leak'), false);
});
