import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { MissionServiceError, type MissionService } from '../missions/service.js';
import './_guard.js';

export function registerRoutineRoutes(app: FastifyInstance, service: MissionService): void {
  async function respond(request: FastifyRequest, reply: FastifyReply, action: () => Promise<unknown>, accepted = false) {
    if (!request.koiforgeSession?.user?.id) return reply.code(401).send({ error: 'Bitte anmelden.' });
    try { return reply.code(accepted ? 202 : 200).send(await action()); }
    catch (error) {
      if (error instanceof MissionServiceError) return reply.code(error.statusCode).send({ error: error.message });
      request.log.error({ err: error }, 'Routine request failed');
      return reply.code(503).send({ error: 'Routinen sind derzeit nicht verfügbar. Gespeicherte Regeln und Ergebnisse bleiben erhalten.' });
    }
  }
  app.get('/api/routines', (request, reply) => respond(request, reply, async () => ({ items: await service.listRoutines(request.koiforgeSession) })));
  app.post('/api/routines', (request, reply) => respond(request, reply, async () => ({ routine: await service.createRoutine(request.koiforgeSession, request.body) })));
  app.get('/api/routines/:id', (request, reply) => respond(request, reply, async () => ({ routine: await service.getRoutine(request.koiforgeSession, (request.params as { id: string }).id) })));
  app.get('/api/routines/:id/runs', (request, reply) => respond(request, reply, async () => ({ items: await service.listRoutineRuns(request.koiforgeSession, (request.params as { id: string }).id) })));
  app.get('/api/routines/:id/compare', (request, reply) => respond(request, reply, async () => service.compareRoutineRun(request.koiforgeSession, (request.params as { id: string }).id, request.query)));
  app.post('/api/routines/:id/preview', (request, reply) => respond(request, reply, async () => service.previewRoutine(request.koiforgeSession, (request.params as { id: string }).id, request.body)));
  app.post('/api/routines/:id/run', (request, reply) => respond(request, reply, async () => ({ mission: await service.runRoutine(request.koiforgeSession, (request.params as { id: string }).id, request.body) }), true));
}
