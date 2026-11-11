import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppRegistries } from '../registries.js';
import { createFreshnessService } from '../analysis/freshness-service.js';
import { createSessionGuard } from './_guard.js';

export function registerFreshnessRoutes(app: FastifyInstance, registries: AppRegistries,
  service = createFreshnessService(process.env.KOIFORGE_IMPORT_DATA_ROOT ?? join(process.cwd(), '.koiforge'), registries)) {
  const { guard } = createSessionGuard(registries.security);
  app.get('/api/analysis/freshness/readiness', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.read']))) return reply;
    try { return await service.readiness(request.koiforgeSession.tenant.id); }
    catch { return reply.code(503).send({ error: 'Bereitschaft konnte nicht geprüft werden. Bitte später erneut prüfen.' }); }
  });
  app.post('/api/analysis/freshness', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.read', 'datasets.manage']))) return reply;
    try { return { run: await service.run(request.koiforgeSession.tenant.id, request.body) }; }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid analysis input.' }); }
  });
  app.get('/api/analysis/freshness', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.read']))) return reply;
    return { runs: await service.list(request.koiforgeSession.tenant.id) };
  });
  app.get('/api/analysis/freshness/:id', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.read']))) return reply;
    try { return { run: await service.get(request.koiforgeSession.tenant.id, (request.params as { id: string }).id) }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reply.code(404).send({ error: 'Analysis run not found.' });
      throw error;
    }
  });
}
