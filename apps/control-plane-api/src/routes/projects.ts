import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ProjectError } from '../projects/contracts.js';
import type { ProjectService } from '../projects/service.js';
import './_guard.js';

export function registerProjectRoutes(app: FastifyInstance, service: ProjectService): void {
  async function respond(request: FastifyRequest, reply: FastifyReply, action: () => Promise<unknown>) {
    if (!request.koiforgeSession?.user?.id) return reply.code(401).send({ error: 'Bitte anmelden.' });
    try { return reply.code(200).send(await action()); }
    catch (error) {
      if (error instanceof ProjectError) return reply.code(error.statusCode).send({ error: error.message });
      request.log.error({ err: error }, 'Project request failed');
      return reply.code(503).send({ error: 'Die Projekte sind derzeit nicht verfügbar. Bestehende Daten bleiben erhalten.' });
    }
  }
  const id = (r: FastifyRequest) => (r.params as { id: string }).id;
  app.get('/api/projects', (r, reply) => respond(r, reply, async () => ({ items: await service.list(r.koiforgeSession) })));
  app.get('/api/projects/:id', (r, reply) => respond(r, reply, async () => ({ project: await service.get(r.koiforgeSession, id(r)) })));
  app.post('/api/projects', { bodyLimit: 128 * 1024 }, (r, reply) => respond(r, reply, async () => ({ project: await service.create(r.koiforgeSession, r.body) })));
  app.patch('/api/projects/:id', { bodyLimit: 128 * 1024 }, (r, reply) => respond(r, reply, async () => ({ project: await service.update(r.koiforgeSession, id(r), r.body) })));
}
