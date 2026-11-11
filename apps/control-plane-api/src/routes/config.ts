import type { ConfigScope, ConfigValueType } from '@koiforge/config-core';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { AppRegistries } from '../registries.js';
import { createSessionGuard } from './_guard.js';

interface SecretUpsertRequestBody {
  name: string;
  scope?: ConfigScope;
  tenantId?: string;
  description?: string;
  tags?: string[];
  value: string;
}

interface ConfigUpsertRequestBody {
  key: string;
  scope?: ConfigScope;
  tenantId?: string;
  valueType: ConfigValueType;
  value: string | number | boolean | Record<string, unknown> | string[];
  description?: string;
}

function resolveScopedTenantId(
  request: FastifyRequest,
  requestedScope?: ConfigScope,
  requestedTenantId?: string,
): string | undefined {
  const scope = requestedScope ?? 'global';
  if (scope === 'global') {
    return undefined;
  }

  return requestedTenantId ?? request.koiforgeSession.tenant.id;
}

export function registerConfigRoutes(app: FastifyInstance, registries: AppRegistries): void {
  const { guard } = createSessionGuard(registries.security);

  app.get('/api/secrets', async (request, reply) => {
    if (!(await guard(request, reply, ['secrets.read']))) return reply;
    return { items: await registries.config.listSecrets(request.koiforgeSession.tenant.id) };
  });

  app.post<{ Body: SecretUpsertRequestBody }>('/api/secrets/upsert', async (request, reply) => {
    if (!(await guard(request, reply, ['secrets.manage']))) return reply;
    try {
      const secret = await registries.config.upsertSecret({
        name: request.body.name,
        scope: request.body.scope ?? 'global',
        tenantId: resolveScopedTenantId(request, request.body.scope, request.body.tenantId),
        description: request.body.description,
        tags: request.body.tags,
        value: request.body.value,
      });
      reply.code(201);
      return secret;
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : 'Secret konnte nicht gespeichert werden.' };
    }
  });

  app.get('/api/config/entries', async (request, reply) => {
    if (!(await guard(request, reply, ['config.read']))) return reply;
    return { items: await registries.config.listEntries(request.koiforgeSession.tenant.id) };
  });

  app.get('/api/config/resolved', async (request, reply) => {
    if (!(await guard(request, reply, ['config.read']))) return reply;
    return { items: await registries.config.resolveEntries(request.koiforgeSession.tenant.id) };
  });

  app.post<{ Body: ConfigUpsertRequestBody }>('/api/config/entries/upsert', async (request, reply) => {
    if (!(await guard(request, reply, ['config.manage']))) return reply;
    try {
      const entry = await registries.config.upsertEntry({
        key: request.body.key,
        scope: request.body.scope ?? 'global',
        tenantId: resolveScopedTenantId(request, request.body.scope, request.body.tenantId),
        valueType: request.body.valueType,
        value: request.body.value,
        description: request.body.description,
      });
      reply.code(201);
      return entry;
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : 'Config-Eintrag konnte nicht gespeichert werden.' };
    }
  });
}
