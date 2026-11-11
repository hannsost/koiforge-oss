import type { SavedViewType } from '@koiforge/saved-view-core';
import type { FastifyInstance } from 'fastify';

import type { AppRegistries } from '../registries.js';
import { createSessionGuard } from './_guard.js';

interface SavedViewUpsertRequestBody {
  id?: string;
  type: SavedViewType;
  name: string;
  description?: string;
  state: Record<string, unknown>;
}

interface SavedViewListQuerystring {
  type?: SavedViewType;
}

export function registerViewsRoutes(app: FastifyInstance, registries: AppRegistries): void {
  const { guard } = createSessionGuard(registries.security);

  app.get<{ Querystring: SavedViewListQuerystring }>('/api/views', async (request, reply) => {
    if (!(await guard(request, reply, ['views.read']))) return reply;
    return { items: await registries.savedView.listViews(request.koiforgeSession.tenant.id, request.query.type) };
  });

  app.get('/api/views/:viewId', async (request, reply) => {
    if (!(await guard(request, reply, ['views.read']))) return reply;
    const view = await registries.savedView.getView(
      request.koiforgeSession.tenant.id,
      (request.params as { viewId: string }).viewId,
    );
    if (!view) {
      reply.code(404);
      return { error: 'View wurde nicht gefunden.' };
    }
    return view;
  });

  app.post<{ Body: SavedViewUpsertRequestBody }>('/api/views/upsert', async (request, reply) => {
    if (!(await guard(request, reply, ['views.manage']))) return reply;
    try {
      const view = await registries.savedView.upsertView({
        id: request.body.id,
        tenantId: request.koiforgeSession.tenant.id,
        type: request.body.type,
        name: request.body.name,
        description: request.body.description,
        createdBy: request.koiforgeSession.user.id,
        state: request.body.state,
      });
      reply.code(201);
      return view;
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : 'View konnte nicht gespeichert werden.' };
    }
  });
}
