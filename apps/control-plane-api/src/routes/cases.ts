import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CaseServiceError, type CaseService } from '../cases/service.js';
import './_guard.js';

export function registerCaseRoutes(app: FastifyInstance, service: CaseService): void {
  async function respond(request: FastifyRequest, reply: FastifyReply, action: () => Promise<unknown>, code = 200) {
    if (!request.koiforgeSession?.user?.id) return reply.code(401).send({ error: 'Bitte anmelden.' });
    try { return reply.code(code).send(await action()); }
    catch (error) {
      if (error instanceof CaseServiceError) return reply.code(error.statusCode).send({ error: error.message });
      request.log.error({ err: error }, 'Case request failed');
      return reply.code(503).send({ error: 'Klärungsfälle sind derzeit nicht verfügbar. Gespeicherte Fälle und Belege bleiben erhalten.' });
    }
  }
  app.get('/api/cases', (request, reply) => respond(request, reply, async () => ({ items: await service.list(request.koiforgeSession) })));
  app.get('/api/cases/findings', (request, reply) => respond(request, reply, () => service.findings(request.koiforgeSession, request.query)));
  app.post('/api/cases/preview', (request, reply) => respond(request, reply, () => service.preview(request.koiforgeSession, request.body)));
  app.post('/api/cases', (request, reply) => respond(request, reply, async () => ({ case: await service.create(request.koiforgeSession, request.body) }), 201));
  app.get('/api/cases/:id', (request, reply) => respond(request, reply, async () => ({ case: await service.get(request.koiforgeSession, (request.params as { id: string }).id) })));
  app.post('/api/cases/:id/transition', (request, reply) => respond(request, reply, async () => ({ case: await service.transition(request.koiforgeSession, (request.params as { id: string }).id, request.body) })));
}
