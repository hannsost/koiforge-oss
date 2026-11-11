import assert from 'node:assert/strict';
import test from 'node:test';
import { neurofunkenQueries, neurofunkenSensors } from '../src/monitoring/neurofunken.js';
import { createPrometheusMonitoringQueryService } from '../src/monitoring/prometheus.js';
import { monitoringSensorState, registeredMonitoringSensors } from '../src/routes/monitoring.js';

test('12 additional allowlisted NeuroFunken sensors use the same bounded current/range query', async () => {
  assert.equal(neurofunkenSensors.length,12);
  assert.equal(new Set(registeredMonitoringSensors().map(s=>s.id)).size,24);
  for (const sensor of neurofunkenSensors) {
    const seen:URL[]=[];
    const service=createPrometheusMonitoringQueryService('https://metrics.example.test',async input=>{
      const url=new URL(input);seen.push(url);
      return Response.json({status:'success',data:{resultType:url.pathname.endsWith('query_range')?'matrix':'vector',result:[]}});
    });
    assert.equal((await service.current(sensor)).value,null);
    assert.deepEqual((await service.series(sensor,'1h')).points,[]);
    assert.equal(seen[0]!.searchParams.get('query'),seen[1]!.searchParams.get('query'));
    assert.equal(seen[1]!.searchParams.get('step'),'60');
    assert.equal(monitoringSensorState(sensor,null),'unknown');
    assert.doesNotMatch(seen[0]!.searchParams.get('query')!,/or vector\(0\)/);
  }
});

test('new state rules distinguish capacity saturation from failure and informational job count',()=>{
  const state=(id:string,value:number)=>monitoringSensorState(neurofunkenSensors.find(s=>s.id===id)!,value);
  assert.equal(state('runner.jobs.active',20),'ok');
  assert.equal(state('runner.capacity.utilization',85),'ok');
  assert.equal(state('runner.capacity.utilization',100),'warning');
  assert.equal(state('runner.capacity.utilization',110),'critical');
  assert.equal(state('kubernetes.containers.restarts',1),'warning');
  assert.equal(state('kubernetes.containers.restarts',5),'critical');
  assert.equal(state('kubernetes.nodes.pressure',1),'critical');
  assert.equal(state('tls.certificates.not-ready',1),'warning');
  assert.equal(state('tls.cluster.expiry-days',10),'critical');
  for(const s of neurofunkenSensors.filter(s=>s.group==='application')) {
    assert.equal(monitoringSensorState(s,80),'warning');
    assert.equal(monitoringSensorState(s,90),'critical');
  }
});

test('namespace memory budgets match live container identities and require complete positive limits',()=>{
  for(const [key,q] of Object.entries(neurofunkenQueries).filter(([key])=>key.startsWith('memory_'))) {
    assert.match(q,/container!="POD"/);
    assert.match(q,/on\(namespace,pod,container\)/);
    assert.match(q,/count\(.+\) == count\(/);
    assert.match(q,/resource="memory"/);
    assert.match(q,/min\(up\{job="kubelet-cadvisor"\}\) == 1/);
    assert.match(q,/min\(up\{job="kube-state-metrics"\}\) == 1/);
    assert.ok(key);
  }
});
