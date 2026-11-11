import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { MissionServiceError, type MissionService } from '../missions/service.js';
import './_guard.js';

export function registerMissionRoutes(app: FastifyInstance, service: MissionService): void {
  async function respond(request: FastifyRequest, reply: FastifyReply, action: () => Promise<unknown>, accepted = false) {
    if (!request.koiforgeSession?.user?.id) return reply.code(401).send({ error: 'Bitte anmelden.' });
    try { const value = await action(); return reply.code(accepted ? 202 : 200).send(value); }
    catch (error) {
      if (error instanceof MissionServiceError) return reply.code(error.statusCode).send({ error: error.message });
      request.log.error({ err: error }, 'Mission request failed');
      return reply.code(503).send({ error: 'Aufträge sind derzeit nicht verfügbar. Bestehende Angaben bleiben erhalten.' });
    }
  }
  app.get('/api/missions/capabilities', (request, reply) => respond(request, reply, async () => {
    // Use the same access check as mission reads; capabilities disclose no data.
    await service.list(request.koiforgeSession);
    return { items: service.capabilities };
  }));
  app.get('/api/missions', (request, reply) => respond(request, reply, async () => ({ items: await service.list(request.koiforgeSession) })));
  app.post('/api/missions', (request, reply) => respond(request, reply, async () => ({ mission: await service.create(request.koiforgeSession, request.body) }), true));
  app.get('/api/missions/:id', (request, reply) => respond(request, reply, async () => ({ mission: await service.get(request.koiforgeSession, (request.params as { id: string }).id) })));
  app.get('/api/missions/:id/order-statuses', (request, reply) => respond(request, reply, async () => {
    const query = request.query as Record<string, unknown>;
    if (!query || Object.keys(query).some(key => key !== 'field')) throw new MissionServiceError('Ungültige Statusabfrage.');
    return service.orderStatuses(request.koiforgeSession, (request.params as { id: string }).id, query.field);
  }));
  app.post('/api/missions/:id/run', (request, reply) => respond(request, reply, async () => ({ mission: await service.run(request.koiforgeSession, (request.params as { id: string }).id, request.body) }), true));
  app.post('/api/missions/:id/retry', (request, reply) => respond(request, reply, async () => ({ mission: await service.retry(request.koiforgeSession, (request.params as { id: string }).id, request.body) }), true));
}
