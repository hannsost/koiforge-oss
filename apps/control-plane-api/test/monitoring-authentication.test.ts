import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { AuthStore } from '../src/auth-store.js';
import { installAuthentication } from '../src/routes/auth.js';
import { registerMonitoringRoutes } from '../src/routes/monitoring.js';
import { registerGitLabQueueRoutes } from '../src/routes/gitlab-queue.js';
import type { AppRegistries } from '../src/registries.js';
import { FileSecurityRegistry } from '@koiforge/security-core';

test('SSO platform admin reaches real monitoring HTTP handlers; reader and anonymous stay denied', async t => {
  const root = await mkdtemp(join(tmpdir(), 'koi-monitoring-auth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new AuthStore(join(root, 'auth.json'));
  const owner = await store.setup({ email:'owner@example.test', password:'synthetic owner password only', displayName:'Owner', workspaceName:'Test' });
  const admin = await store.loginOidc({ issuer:'https://id.example.test/realm', subject:'synthetic-admin', email:'sso@example.test', displayName:'Synthetic SSO' });
  assert.deepEqual(admin.session.roleIds, ['platform_admin']);
  const invitation = await store.invite(owner.session, { email:'reader@example.test', displayName:'Reader' });
  const reader = await store.acceptInvitation({ token:invitation.token, password:'synthetic reader password only' });
  const app = Fastify(); t.after(() => app.close());
  installAuthentication(app, store, ['http://localhost:5173']);
  const registries = { security:new FileSecurityRegistry({filePath:join(root,'security.json')}) } as AppRegistries;
  registerMonitoringRoutes(app, registries, { configured:true,
    async current(sensor) { return { sensorId:sensor.id, value:1, timestamp:new Date().toISOString() }; },
    async series(sensor, window) { return { sensorId:sensor.id, window, points:[{value:1,timestamp:new Date().toISOString()}] }; },
    async alerts() { return []; }, async endpoints() { return []; },
  });
  registerGitLabQueueRoutes(app, registries, {configured:true, async snapshot() {
    return {source:'ready', observedAt:new Date().toISOString(), counts:null, oldestPendingSeconds:null, projects:[]};
  }});
  const paths = ['/api/monitoring/summary','/api/monitoring/alerts','/api/monitoring/endpoints',
    '/api/monitoring/sensors/node.cpu.utilization/series?window=1h','/api/monitoring/gitlab-queue'];
  for (const path of paths) {
    assert.equal((await app.inject({url:path,headers:{cookie:`koiforge_session=${admin.token}`}})).statusCode,200,path);
    assert.equal((await app.inject({url:path,headers:{cookie:`koiforge_session=${owner.token}`}})).statusCode,200,path);
    assert.equal((await app.inject({url:path,headers:{cookie:`koiforge_session=${reader.token}`}})).statusCode,403,path);
    assert.equal((await app.inject(path)).statusCode,401,path);
  }
  assert.equal((await app.inject({url:paths[0],headers:{cookie:`koiforge_session=${admin.token}`,origin:'https://untrusted.test'}})).statusCode,403);
  await store.logout(admin.token);
  assert.equal((await app.inject({url:paths[0],headers:{cookie:`koiforge_session=${admin.token}`}})).statusCode,401);
});
