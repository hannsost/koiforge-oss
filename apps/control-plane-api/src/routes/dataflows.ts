import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DataflowError } from '../dataflows/contracts.js';
import type { DataflowService } from '../dataflows/service.js';
import { SemanticModelError } from '../semantic-model/service.js';
import './_guard.js';

export function registerDataflowRoutes(app: FastifyInstance, service: DataflowService) {
  async function respond(r: FastifyRequest, reply: FastifyReply, action: () => Promise<unknown>) {
    if (!r.koiforgeSession?.user?.id) return reply.code(401).send({ error: 'Bitte anmelden.' });
    try { return reply.code(200).send(await action()); }
    catch (error) {
      if (error instanceof DataflowError || error instanceof SemanticModelError) return reply.code(error.statusCode).send({ error: error.message });
      r.log.error({ err: error }, 'Dataflow request failed');
      return reply.code(503).send({ error: 'Die Datenflüsse sind derzeit nicht verfügbar. Bestehende Ergebnisse bleiben erhalten.' });
    }
  }
  const params = (r: FastifyRequest) => r.params as { id: string; runId: string };
  app.get('/api/dataflows', (r, reply) => respond(r, reply, async () => ({ items: await service.list(r.koiforgeSession) })));
  app.get('/api/dataflows/dependencies', (r, reply) => respond(r, reply, () => service.dependencies(r.koiforgeSession)));
  app.get('/api/dataflows/:id', (r, reply) => respond(r, reply, () => service.get(r.koiforgeSession, params(r).id)));
  app.post('/api/dataflows', { bodyLimit: 128 * 1024 }, (r, reply) => respond(r, reply, async () => ({ definition: await service.save(r.koiforgeSession, r.body) })));
  app.post('/api/dataflows/:id/runs', { bodyLimit: 8192 }, (r, reply) => respond(r, reply, async () => ({ run: await service.run(r.koiforgeSession, params(r).id, r.body) })));
  app.get('/api/dataflows/:id/runs/:runId', (r, reply) => respond(r, reply, () => service.getRun(r.koiforgeSession, params(r).id, params(r).runId, r.query)));
  app.post('/api/dataflows/:id/runs/:runId/publish', { bodyLimit: 1024 }, (r, reply) => respond(r, reply, async () => ({ objectSet: await service.publish(r.koiforgeSession, params(r).id, params(r).runId, r.body) })));
}
