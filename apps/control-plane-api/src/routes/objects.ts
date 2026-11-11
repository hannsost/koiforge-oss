import { buildOntologySnapshot } from '@koiforge/ontology-core';
import type { FastifyInstance, FastifyReply } from 'fastify';

import { getExplorerObjectDetail, listExplorerObjects, listLinkSuggestions } from '../object-explorer.js';
import type { AppRegistries } from '../registries.js';
import { createSessionGuard } from './_guard.js';
import { parseFilters } from './_utils.js';

interface ObjectListQuerystring {
  q?: string;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  filters?: string;
}

async function resolveObjectType(
  raw: string,
  registries: AppRegistries,
  reply: FastifyReply,
): Promise<string | null> {
  const manifests = await registries.module.listCurrentManifests();
  const snapshot = buildOntologySnapshot(manifests);
  const registeredTypes = new Set(snapshot.objects.map((o) => o.name));

  if (!registeredTypes.has(raw)) {
    reply.code(404);
    reply.send({
      error: `Object type '${raw}' is not registered in the ontology.`,
      registeredTypes: [...registeredTypes],
    });
    return null;
  }

  return raw;
}

export function registerObjectsRoutes(app: FastifyInstance, registries: AppRegistries): void {
  const { guard } = createSessionGuard(registries.security);

  app.get<{ Querystring: ObjectListQuerystring }>(
    '/api/objects/:objectType',
    async (request, reply) => {
      if (!(await guard(request, reply, ['datasets.read']))) return reply;
      const raw = (request.params as { objectType: string }).objectType;
      const objectType = await resolveObjectType(raw, registries, reply);
      if (!objectType) return reply;

      return {
        items: await listExplorerObjects(registries.dataset, objectType, {
          search: request.query.q,
          sortBy: request.query.sortBy,
          sortDir: request.query.sortDir,
          filters: parseFilters(request.query.filters),
        }),
      };
    },
  );

  app.get('/api/objects/:objectType/:objectId', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.read']))) return reply;
    const params = request.params as { objectType: string; objectId: string };
    const objectType = await resolveObjectType(params.objectType, registries, reply);
    if (!objectType) return reply;

    const detail = await getExplorerObjectDetail(registries.dataset, objectType, params.objectId);
    if (!detail) {
      reply.code(404);
      return { error: 'Object not found.' };
    }

    return detail;
  });

  app.get('/api/board/suggestions', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.read']))) return reply;
    return { items: await listLinkSuggestions(registries.dataset) };
  });
}
