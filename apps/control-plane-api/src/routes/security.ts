import type { FastifyInstance } from 'fastify';

import type { AppRegistries } from '../registries.js';
import { createSessionGuard } from './_guard.js';

export function registerSecurityRoutes(app: FastifyInstance, registries: AppRegistries): void {
  const { guard } = createSessionGuard(registries.security);

  app.get('/api/security/tenants', async (request, reply) => {
    if (!(await guard(request, reply, ['security.read']))) return reply;
    return { items: [request.koiforgeSession.tenant] };
  });

  app.get('/api/security/roles', async (request, reply) => {
    if (!(await guard(request, reply, ['security.read']))) return reply;
    return { items: [{ id: 'owner', name: 'Inhaber', permissions: request.koiforgeSession.permissions }] };
  });

  app.get('/api/security/users', async (request, reply) => {
    if (!(await guard(request, reply, ['security.read']))) return reply;
    return { items: [{ ...request.koiforgeSession.user, memberships: [{ tenantId: request.koiforgeSession.tenant.id, roleIds: request.koiforgeSession.roleIds }] }] };
  });
}
