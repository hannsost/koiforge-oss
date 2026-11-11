import type { FastifyInstance } from 'fastify';
import type { CreateCheckInput } from '@koiforge/checks-core';

import type { AppRegistries } from '../registries.js';
import { createSessionGuard } from './_guard.js';

export function registerChecksRoutes(app: FastifyInstance, registries: AppRegistries): void {
  const { guard } = createSessionGuard(registries.security);

  // List checks (optionally by dataset)
  app.get('/api/checks', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.read']))) return reply;
    const { datasetId } = request.query as { datasetId?: string };
    const checks = await registries.checks.listChecks(datasetId);
    const latestRuns = await registries.checks.latestRunPerCheck(datasetId);
    return {
      items: checks.map((c) => ({ ...c, latestRun: latestRuns[c.id] ?? null })),
    };
  });

  // Get single check
  app.get('/api/checks/:id', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.read']))) return reply;
    const { id } = request.params as { id: string };
    const check = await registries.checks.getCheck(id);
    if (!check) { reply.code(404); return { error: 'Check not found.' }; }
    const runs = await registries.checks.listRuns(id);
    return { ...check, runs };
  });

  // Create check
  app.post<{ Body: CreateCheckInput }>('/api/checks', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.manage']))) return reply;
    try {
      const check = await registries.checks.createCheck(request.body);
      reply.code(201);
      return check;
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : 'Create failed.' };
    }
  });

  // Delete check
  app.delete('/api/checks/:id', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.manage']))) return reply;
    const { id } = request.params as { id: string };
    try {
      await registries.checks.deleteCheck(id);
      reply.code(204);
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : 'Delete failed.' };
    }
  });

  // Run check
  app.post('/api/checks/:id/run', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.manage']))) return reply;
    const { id } = request.params as { id: string };

    const check = await registries.checks.getCheck(id);
    if (!check) { reply.code(404); return { error: 'Check not found.' }; }

    try {
      const preview = await registries.dataset.previewRows(check.datasetId, 100_000);
      const run = await registries.checks.runCheck(id, preview.rows);
      return run;
    } catch (error) {
      reply.code(500);
      return { error: error instanceof Error ? error.message : 'Run failed.' };
    }
  });

  // List runs for a check
  app.get('/api/checks/:id/runs', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.read']))) return reply;
    const { id } = request.params as { id: string };
    return { items: await registries.checks.listRuns(id) };
  });
}
