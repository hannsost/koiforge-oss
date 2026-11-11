import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import Fastify from 'fastify';
import type { SessionContext } from '@koiforge/security-core';

import type { AppRegistries } from '../src/registries.js';
import { registerActionsRoutes } from '../src/routes/actions.js';

const actionPermissions = ['orders.read', 'orders.review'];
const allPermissions = ['modules.read', ...actionPermissions];
const validBody = { objectId: 'order-123', objectType: 'procurement-order' };

function fixture(t: TestContext, permissions = allPermissions, authenticated = true) {
  const app = Fastify();
  const permissionChecks: string[][] = [];
  const lineageRuns: unknown[] = [];
  let moduleReads = 0;
  const session: SessionContext = {
    user: { id: 'owner', displayName: 'Owner' },
    tenant: { id: 'company', name: 'Company', slug: 'company', status: 'active' },
    roleIds: ['owner'],
    permissions,
  };
  if (authenticated) {
    app.addHook('onRequest', async request => { request.koiforgeSession = session; });
  }
  const action = {
    name: 'review-order',
    'contract-version': 1,
    input: 'procurement-order@^3',
    permissions: actionPermissions,
    'side-effects': ['external.erp-write'],
  };
  const registries = {
    security: {
      assertPermissions(current: SessionContext, required: string[]) {
        permissionChecks.push([...required]);
        if (required.some(permission => !current.permissions.includes(permission))) {
          throw new Error('Zugriff verweigert.');
        }
      },
    },
    module: {
      async getState() {
        moduleReads++;
        return { modules: {
          procurement: {
            status: 'enabled',
            versions: [{ manifest: { contributes: { actions: [action] } } }],
          },
          disabled: {
            status: 'disabled',
            versions: [{ manifest: { contributes: { actions: [{ ...action, name: 'disabled-action' }] } } }],
          },
        } };
      },
    },
    assetLineage: {
      async recordRun(run: unknown) { lineageRuns.push(run); },
    },
  } as unknown as AppRegistries;
  registerActionsRoutes(app, registries);
  t.after(async () => {
    await app.close();
    assert.deepEqual(lineageRuns, [], 'A declaration or rejected request must not record an executed action.');
  });
  return { app, permissionChecks, moduleReads: () => moduleReads };
}

test('action catalog describes declarations as unavailable and omits disabled modules', async t => {
  const { app } = fixture(t);
  const response = await app.inject('/api/actions');
  assert.equal(response.statusCode, 200, response.body);
  const items = response.json().items;
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'review-order');
  assert.equal(items[0].executable, false);
  assert.match(items[0].unavailableReason, /keine Ausführung eingerichtet/);
  assert.deepEqual(items[0].permissions, actionPermissions);
});

test('unauthenticated requests cannot list or invoke action declarations', async t => {
  const { app, moduleReads } = fixture(t, allPermissions, false);
  assert.equal((await app.inject('/api/actions')).statusCode, 401);
  assert.equal((await app.inject({
    method: 'POST', url: '/api/actions/review-order/execute', payload: validBody,
  })).statusCode, 401);
  assert.equal(moduleReads(), 0);
});

test('catalog and execution still require the base module permission', async t => {
  const { app, moduleReads } = fixture(t, actionPermissions);
  assert.equal((await app.inject('/api/actions')).statusCode, 403);
  assert.equal((await app.inject({
    method: 'POST', url: '/api/actions/review-order/execute', payload: validBody,
  })).statusCode, 403);
  assert.equal(moduleReads(), 0);
});

test('module access alone does not authorize an action', async t => {
  const { app, permissionChecks } = fixture(t, ['modules.read']);
  const response = await app.inject({
    method: 'POST', url: '/api/actions/review-order/execute', payload: validBody,
  });
  assert.equal(response.statusCode, 403, response.body);
  assert.deepEqual(permissionChecks, [['modules.read'], actionPermissions]);
  assert.equal(response.json().status, undefined);
});

test('every declared action permission is required', async t => {
  const { app } = fixture(t, ['modules.read', 'orders.read']);
  const response = await app.inject({
    method: 'POST', url: '/api/actions/review-order/execute', payload: validBody,
  });
  assert.equal(response.statusCode, 403, response.body);
});

test('unknown and disabled actions return 404 without claiming effects', async t => {
  const { app } = fixture(t);
  for (const name of ['unknown-action', 'disabled-action']) {
    const response = await app.inject({
      method: 'POST', url: `/api/actions/${name}/execute`, payload: validBody,
    });
    assert.equal(response.statusCode, 404, response.body);
    assert.equal(response.json().executedAt, undefined);
  }
});

test('an authorized request with the wrong object type returns 400', async t => {
  const { app } = fixture(t);
  const response = await app.inject({
    method: 'POST', url: '/api/actions/review-order/execute',
    payload: { ...validBody, objectType: 'supplier' },
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.match(response.json().error, /procurement-order/);
});

test('a valid authorized declaration returns 501 without fabricated execution or lineage', async t => {
  const { app, permissionChecks } = fixture(t);
  const response = await app.inject({
    method: 'POST', url: '/api/actions/review-order/execute',
    payload: { ...validBody, params: { reviewed: true } },
  });
  assert.equal(response.statusCode, 501, response.body);
  assert.deepEqual(response.json(), {
    code: 'ACTION_NOT_IMPLEMENTED',
    error: 'Für diese Aktion ist noch keine Ausführung eingerichtet. Es wurden keine Änderungen vorgenommen.',
    action: 'review-order', moduleId: 'procurement', executable: false,
  });
  assert.deepEqual(permissionChecks, [['modules.read'], actionPermissions]);
});

test('null, malformed objects and invalid optional parameters return 400', async t => {
  const { app, moduleReads } = fixture(t);
  const invalidBodies = [
    null, [], 'invalid', {},
    { objectType: 'procurement-order' },
    { ...validBody, objectId: ' ' },
    { ...validBody, objectId: 123 },
    { ...validBody, objectType: null },
    { ...validBody, objectType: ' ' },
    { ...validBody, params: null },
    { ...validBody, params: [] },
    { ...validBody, params: 'invalid' },
  ];
  for (const body of invalidBodies) {
    const response = await app.inject({
      method: 'POST', url: '/api/actions/review-order/execute',
      headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body),
    });
    assert.equal(response.statusCode, 400, `${JSON.stringify(body)}: ${response.body}`);
    assert.equal(response.json().executedAt, undefined);
  }
  assert.equal(moduleReads(), 0);
});
