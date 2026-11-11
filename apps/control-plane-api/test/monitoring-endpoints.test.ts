import assert from 'node:assert/strict';
import test from 'node:test';
import { ENDPOINT_QUERY, parseEndpoints } from '../src/monitoring/endpoints.js';
import { createPrometheusMonitoringQueryService, MonitoringUpstreamError } from '../src/monitoring/prometheus.js';

const now = Date.parse('2026-09-28T20:00:00Z');
function metrics(target = 'koiforge', job = 'external-probe-cx23', age = 60, up = '1') {
  return [
    ['neurofunken_external_https_up', up],
    ['neurofunken_external_probe_timestamp_seconds', String(now / 1000 - age)],
    ['neurofunken_external_tls_expiry_timestamp_seconds', String(now / 1000 + 20 * 86400)],
  ].map(([name, value]) => ({ metric: { __name__: name, target_id: target, job, secret: 'must-not-leak' }, value: [now / 1000, value] }));
}
const payload = (result: unknown[]) => ({ status: 'success', data: { resultType: 'vector', result } });

test('endpoint inventory keeps missing targets explicit and allowlists all output', () => {
  const rows = parseEndpoints(payload([...metrics(), ...metrics('untrusted'), ...metrics('login', 'untrusted')]), now);
  assert.equal(rows.length, 9);
  assert.equal(rows.find(row => row.id === 'koiforge')?.state, 'ok');
  assert.equal(rows.find(row => row.id === 'login')?.state, 'unknown');
  assert.equal(rows.find(row => row.id === 'koiforge')?.tlsDays, 20);
  assert.equal(JSON.stringify(rows).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(rows).includes('untrusted'), false);
});

test('endpoint observers cannot hide disagreements and have individual freshness budgets', () => {
  const rows = parseEndpoints(payload([...metrics('koiforge', 'external-probe-cx23', 901), ...metrics('koiforge', 'external-probe-receiver', 901, '0')]), now).filter(row => row.id === 'koiforge');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.state), ['critical', 'unknown']);
  assert.equal(rows[1]?.reason, 'stale');
  assert.equal(rows[1]?.tlsDays, null);
});

test('future, invalid and duplicate endpoint measurements fail closed', () => {
  for (const samples of [metrics('koiforge', 'external-probe-cx23', -60), metrics('koiforge', 'external-probe-cx23', 60, 'NaN'), [...metrics(), ...metrics()]]) {
    assert.equal(parseEndpoints(payload(samples), now).find(row => row.id === 'koiforge')?.state, 'unknown');
  }
  assert.equal(parseEndpoints(payload([...metrics(), ...metrics()]), now).find(row => row.id === 'koiforge')?.reason, 'ambiguous');
  assert.throws(() => parseEndpoints(payload(Array(257).fill({})), now));
  assert.throws(() => parseEndpoints({ status: 'error' }, now));
});

test('endpoint adapter uses a fixed query and normalizes upstream errors', async () => {
  const service = createPrometheusMonitoringQueryService('https://metrics.example.test', async input => {
    assert.equal(new URL(input).searchParams.get('query'), ENDPOINT_QUERY);
    return Response.json(payload([]));
  });
  assert.equal((await service.endpoints!()).length, 9);
  const broken = createPrometheusMonitoringQueryService('https://metrics.example.test', async () => Response.json({ status: 'error' }));
  await assert.rejects(broken.endpoints!(), MonitoringUpstreamError);
});

// Raw observers may still deliver historical/paused targets. They cannot change
// active monitoring or become missing/critical placeholders in the dashboard.
test('paused PalmScout targets are excluded while active failures remain visible', () => {
  const rows = parseEndpoints(payload([
    ...metrics('palmscout-web', 'external-probe-cx23', 60, '0'),
    ...metrics('palmscout-api', 'external-probe-receiver', 60, '0'),
    ...metrics('koiforge', 'external-probe-cx23', 60, '0'),
  ]), now);
  assert.equal(rows.length, 9);
  assert.equal(rows.some(row => row.id.startsWith('palmscout')), false);
  assert.equal(ENDPOINT_QUERY.includes('palmscout'), false);
  assert.equal(rows.find(row => row.id === 'koiforge')?.state, 'critical');
  assert.equal(rows.find(row => row.id === 'login')?.state, 'unknown');
});
