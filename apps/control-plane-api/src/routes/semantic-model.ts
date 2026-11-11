import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SemanticModelError, type SemanticModelService } from '../semantic-model/service.js';
import type { PageOptions } from '../semantic-model/contracts.js';
import './_guard.js';

function pageOptions(query: unknown): PageOptions {
  if (!query || typeof query !== 'object' || Array.isArray(query)
    || Object.keys(query).some(key => key !== 'offset' && key !== 'limit')) throw new SemanticModelError('Ungültige Seitenangaben.');
  const result: PageOptions = {};
  for (const [key, value] of Object.entries(query)) {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new SemanticModelError('Seitenangaben müssen ganze nichtnegative Zahlen sein.');
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new SemanticModelError('Seitenangabe überschreitet die Größenbegrenzung.');
    if (key === 'offset') result.offset = number;
    else result.limit = number;
  }
  return result;
}
export function registerSemanticModelRoutes(app: FastifyInstance, service: SemanticModelService): void {
  async function respond(request: FastifyRequest, reply: FastifyReply, action: () => Promise<unknown>) {
    if (!request.koiforgeSession?.user?.id) return reply.code(401).send({ error: 'Bitte anmelden.' });
    try { return reply.code(200).send(await action()); }
    catch (error) {
      if (error instanceof SemanticModelError) return reply.code(error.statusCode).send({ error: error.message });
      request.log.error({ err: error }, 'Semantic model request failed');
      return reply.code(503).send({ error: 'Die Fachmodelle sind derzeit nicht verfügbar. Bestehende Daten bleiben erhalten.' });
    }
  }
  app.get('/api/model/object-sets', (request, reply) => respond(request, reply, async () => ({ items: await service.listObjectSets(request.koiforgeSession) })));
  app.post('/api/model/object-sets', (request, reply) => respond(request, reply, async () => ({ objectSet: await service.createObjectSet(request.koiforgeSession, request.body) })));
  app.get('/api/model/object-sets/:id', (request, reply) => respond(request, reply, () => service.getObjectSet(request.koiforgeSession,
    (request.params as { id: string }).id, pageOptions(request.query))));
  app.get('/api/model/relationships', (request, reply) => respond(request, reply, async () => ({ items: await service.listRelationships(request.koiforgeSession) })));
  app.post('/api/model/relationships', (request, reply) => respond(request, reply, async () => ({ relationship: await service.createRelationship(request.koiforgeSession, request.body) })));
  app.get('/api/model/relationships/:id', (request, reply) => respond(request, reply, () => service.getRelationship(request.koiforgeSession,
    (request.params as { id: string }).id, pageOptions(request.query))));
}
