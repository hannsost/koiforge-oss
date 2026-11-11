import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ObjectWorkspaceError } from '../object-workspace/contracts.js';
import type { ObjectWorkspaceService } from '../object-workspace/service.js';
import './_guard.js';

export function registerObjectWorkspaceRoutes(app: FastifyInstance, service: ObjectWorkspaceService): void {
  async function respond(request: FastifyRequest, reply: FastifyReply, action: () => Promise<unknown>) {
    if (!request.koiforgeSession?.user?.id) return reply.code(401).send({ error: 'Bitte anmelden.' });
    try { return reply.code(200).send(await action()); }
    catch (error) {
      if (error instanceof ObjectWorkspaceError) return reply.code(error.statusCode).send({ error: error.message });
      request.log.error({ err: error }, 'Object workspace request failed');
      return reply.code(503).send({ error: 'Die Objekte sind derzeit nicht verfügbar. Bestehende Daten bleiben erhalten.' });
    }
  }
  const base = '/api/object-workspace/families';
  type Params = { familyId: string; objectId: string; relationshipId: string };
  app.get(base, (request, reply) => respond(request, reply, async () => ({ items: await service.listFamilies(request.koiforgeSession, request.query) })));
  app.get(`${base}/:familyId/objects`, (request, reply) => respond(request, reply, () => service.listObjects(request.koiforgeSession,
    (request.params as Params).familyId, request.query)));
  app.get(`${base}/:familyId/objects/:objectId`, (request, reply) => respond(request, reply, () => service.getObject(request.koiforgeSession,
    (request.params as Params).familyId, (request.params as Params).objectId, request.query)));
  app.get(`${base}/:familyId/objects/:objectId/links/:relationshipId`, (request, reply) => respond(request, reply, () => service.getObjectLinks(request.koiforgeSession,
    (request.params as Params).familyId, (request.params as Params).objectId, (request.params as Params).relationshipId, request.query)));
}
