// After building the API: node scripts/monitoring-promql-fixture.mjs | promtool test rules /dev/stdin
// Synthetic data only. JSON is valid YAML; no production data or credentials are used.
import { endpointAggregateQuery } from '../apps/control-plane-api/dist/monitoring/endpoints.js';
import { createPrometheusMonitoringQueryService } from '../apps/control-plane-api/dist/monitoring/prometheus.js';
import { registeredMonitoringSensors } from '../apps/control-plane-api/dist/routes/monitoring.js';
import { neurofunkenSensors } from '../apps/control-plane-api/dist/monitoring/neurofunken.js';

const queries = {};
for (const id of ['node.filesystem.free', 'flux.reconciliation.failed', 'endpoint.probe.age-hours', ...neurofunkenSensors.map(s=>s.id)]) {
  const service = createPrometheusMonitoringQueryService('https://example.test', async input => {
    queries[id] = new URL(input).searchParams.get('query');
    return Response.json({ status: 'success', data: { resultType: 'vector', result: [] } });
  });
  await service.current(registeredMonitoringSensors().find(sensor => sensor.id === id));
}
function queryCheck(name, id, series, value, labels = '{}') {
  return { name, interval: '1m', input_series: series.map(([series, value]) => ({ series, values: `${value}+0x10` })),
    promql_expr_test: [{ expr: queries[id], eval_time: '10m', exp_samples: value == null ? [] : [{ labels, value }] }] };
}

const targets = ['palmscout-web', 'palmscout-api', 'fireflint', 'koiforge', 'login', 'mcp', 'support', 'apex', 'www', 'mail-mx00', 'mail-mx01'];
function input({ omit = '', stale = '', future = '', down = '', job = 'external-probe-cx23' } = {}) {
  return targets.filter(target => target !== omit).flatMap(target => [
    ['neurofunken_external_https_up', target === down ? 0 : 1],
    ['neurofunken_external_probe_timestamp_seconds', target === stale ? 1 : target === future ? 700 : 590],
    ['neurofunken_external_tls_expiry_timestamp_seconds', 600 + 20 * 86400],
  ].map(([name, value]) => ({ series: `${name}{target_id="${target}",job="${job}"}`, values: `${value}+0x10` })));
}
function check(name, series, https, tls) {
  return { name, interval: '1m', input_series: series, promql_expr_test: [
    { expr: endpointAggregateQuery('https'), eval_time: '10m', exp_samples: https == null ? [] : [{ labels: '{}', value: https }] },
    { expr: endpointAggregateQuery('tls'), eval_time: '10m', exp_samples: tls == null ? [] : [{ labels: '{}', value: tls }] },
  ] };
}
const readyKsm = ['up{job="kube-state-metrics"}',1];
const readyCadvisor = ['up{job="kubelet-cadvisor"}',1];
const usage = ['container_memory_working_set_bytes{job="kubelet-cadvisor",namespace="koiforge",pod="api",container="api"}',50];
const limit = ['kube_pod_container_resource_limits{job="kube-state-metrics",namespace="koiforge",pod="api",container="api",resource="memory"}',100];
const memoryData=[readyKsm,readyCadvisor,usage,limit];
console.log(JSON.stringify({ evaluation_interval: '1m', tests: [
  ...neurofunkenSensors.map(s=>queryCheck(`${s.id}: absence is unknown`,s.id,[],null)),
  queryCheck('memory matches observed containers only','application.koiforge.memory',[...memoryData,
    ['kube_pod_container_resource_limits{job="kube-state-metrics",namespace="koiforge",pod="gone",container="old",resource="memory"}',1000]],50),
  queryCheck('missing limit cannot dilute memory usage','application.koiforge.memory',[readyKsm,readyCadvisor,usage],null),
  queryCheck('zero limit is unknown','application.koiforge.memory',[readyKsm,readyCadvisor,usage,[limit[0],0]],null),
  queryCheck('one unlimited container invalidates aggregate','application.koiforge.memory',[...memoryData,
    ['container_memory_working_set_bytes{job="kubelet-cadvisor",namespace="koiforge",pod="api",container="sidecar"}',10]],null),
  queryCheck('failed cAdvisor cannot show old memory as healthy','application.koiforge.memory',[readyKsm,[readyCadvisor[0],0],usage,limit],null),
  queryCheck('namespace boundaries exclude other applications','application.koiforge.memory',[...memoryData,
    ['container_memory_working_set_bytes{job="kubelet-cadvisor",namespace="solveit-support",pod="api",container="api"}',900]],50),
  queryCheck('full runner is 100 percent','runner.capacity.utilization',[
    ['up{job="gitlab-runner"}',1],['gitlab_runner_jobs{job="gitlab-runner"}',2],['gitlab_runner_concurrent{job="gitlab-runner"}',2]],100),
  queryCheck('zero runner capacity is unknown','runner.capacity.utilization',[
    ['up{job="gitlab-runner"}',1],['gitlab_runner_jobs{job="gitlab-runner"}',0],['gitlab_runner_concurrent{job="gitlab-runner"}',0]],null),
  queryCheck('failed runner scrape is unknown','runner.jobs.active',[
    ['up{job="gitlab-runner"}',0],['gitlab_runner_jobs{job="gitlab-runner"}',0]],null),
  queryCheck('failed certificate inventory is unknown','tls.certificates.not-ready',[
    ['up{job="cert-manager"}',0],['certmanager_certificate_ready_status{job="cert-manager",condition="True"}',1]],null),
  queryCheck('certificate not Ready is counted','tls.certificates.not-ready',[
    ['up{job="cert-manager"}',1],['certmanager_certificate_ready_status{job="cert-manager",condition="True"}',0]],1),
  queryCheck('scrape failure counted without inventing inventory','monitoring.scrapes.failed',[
    ['up{job="a"}',1],['up{job="b"}',0]],1),
  check('complete and fresh', input(), 1, 20),
  check('paused PalmScout failure is excluded', input({ down: 'palmscout-web' }), 1, 20),
  check('paused PalmScout absence is excluded', input().filter(row => !row.series.includes('palmscout-')), 1, 20),
  check('missing target is unknown', input({ omit: 'koiforge' }), null, null),
  check('future timestamp is unknown', input({ future: 'koiforge' }), null, null),
  check('failed target is down', input({ down: 'koiforge' }), 0, 20),
  check('mail failure does not erase web status', input({ down: 'mail-mx00', omit: 'mail-mx01' }), 1, 20),
  check('empty inventory is unknown', [], null, null),
  check('observer disagreement is not masked', [...input(), ...input({ job: 'external-probe-receiver', down: 'koiforge' })], 0, 20),
  { name: 'stale observations do not turn green', interval: '1m', input_series: input().map(row => ({ ...row, values: row.values.replace('x10', 'x30') })),
    promql_expr_test: ['https', 'tls'].map(kind => ({ expr: endpointAggregateQuery(kind), eval_time: '30m', exp_samples: [] })) },
  queryCheck('root excludes small tmpfs and EFI', 'node.filesystem.free', [
    ['container_fs_limit_bytes{id="/",device="/dev/sda1",instance="node"}', 1000],
    ['container_fs_usage_bytes{id="/",device="/dev/sda1",instance="node"}', 400],
    ['container_fs_limit_bytes{id="/",device="/run/lock",instance="node"}', 5],
    ['container_fs_usage_bytes{id="/",device="/run/lock",instance="node"}', 0],
    ['container_fs_limit_bytes{id="/",device="/dev/sda15",instance="node"}', 20],
    ['container_fs_usage_bytes{id="/",device="/dev/sda15",instance="node"}', 1],
  ], 600, '{instance="node"}'),
  queryCheck('absent root is unknown', 'node.filesystem.free', [], null),
  queryCheck('ready Flux inventory is zero', 'flux.reconciliation.failed', [
    ['gotk_resource_info{name="apps",ready="True"}', 1],
    ['gotk_resource_info{name="paused",ready="False",suspended="true"}', 1],
  ], 0),
  queryCheck('failed Flux is counted', 'flux.reconciliation.failed', [
    ['gotk_resource_info{name="apps",ready="False"}', 1],
    ['gotk_resource_info{name="other",ready="True"}', 1],
  ], 1),
  queryCheck('absent Flux inventory is unknown', 'flux.reconciliation.failed', [], null),
  queryCheck('zero observation is unknown', 'endpoint.probe.age-hours', [
    ['neurofunken_external_probe_timestamp_seconds{target_id="koiforge"}', 0],
  ], null),
  queryCheck('future observation is unknown', 'endpoint.probe.age-hours', [
    ['neurofunken_external_probe_timestamp_seconds{target_id="koiforge"}', 700],
  ], null),
  queryCheck('valid observation produces age', 'endpoint.probe.age-hours', [
    ['neurofunken_external_probe_timestamp_seconds{target_id="koiforge"}', 240],
  ], 0.1),
] }, null, 2));
