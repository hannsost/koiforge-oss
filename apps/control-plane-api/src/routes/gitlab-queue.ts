import type { FastifyInstance } from 'fastify';
import type { AppRegistries } from '../registries.js';
import type { GitLabQueueService } from '../monitoring/gitlab-queue.js';
import { createSessionGuard } from './_guard.js';

export function registerGitLabQueueRoutes(app: FastifyInstance, registries: AppRegistries, service: GitLabQueueService) {
  const { guard } = createSessionGuard(registries.security);
  app.get('/api/monitoring/gitlab-queue', async (request, reply) => {
    if (!(await guard(request, reply, ['views.read', 'security.read']))) return reply;
    reply.header('Cache-Control', 'private, no-store');
    if (!service.configured) {
      return reply.code(503).send({ error: 'GitLab-Warteschlange ist noch nicht angebunden.' });
    }
    try { return await service.snapshot(); }
    catch { return reply.code(502).send({ error: 'GitLab-Warteschlange ist derzeit nicht verfügbar.' }); }
  });
}
