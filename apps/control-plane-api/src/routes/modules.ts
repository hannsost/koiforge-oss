import { validateManifestDocument, validateManifestText } from '@koiforge/module-manifest';
import type { FastifyInstance } from 'fastify';

import type { AppRegistries } from '../registries.js';
import { createSessionGuard } from './_guard.js';

interface ValidateRequestBody {
  manifestRaw?: string;
  manifest?: unknown;
}

interface InstallRequestBody extends ValidateRequestBody {
  filePath?: string;
}

interface RollbackRequestBody {
  version?: string;
}

export function registerModulesRoutes(app: FastifyInstance, registries: AppRegistries): void {
  const { guard } = createSessionGuard(registries.security);

  app.get('/api/modules', async (request, reply) => {
    if (!(await guard(request, reply, ['modules.read']))) return reply;
    return { items: await registries.module.listModules() };
  });

  app.get('/api/modules/capabilities', async (request, reply) => {
    if (!(await guard(request, reply, ['modules.read']))) return reply;
    return { items: await registries.module.listCapabilities() };
  });

  app.get('/api/modules/ui', async (request, reply) => {
    if (!(await guard(request, reply, ['modules.read']))) return reply;
    return { items: await registries.module.listUiContributions() };
  });

  app.get('/api/audit', async (request, reply) => {
    if (!(await guard(request, reply, ['audit.read']))) return reply;
    return { items: await registries.module.getAuditTrail() };
  });

  app.post<{ Body: ValidateRequestBody }>('/api/modules/validate', async (request, reply) => {
    if (!(await guard(request, reply, ['modules.manage']))) return reply;
    const body = request.body ?? {};
    const result = body.manifestRaw
      ? validateManifestText(body.manifestRaw, 'request-body')
      : validateManifestDocument(body.manifest, 'request-body');
    reply.code(result.valid ? 200 : 422);
    return result;
  });

  app.post<{ Body: InstallRequestBody }>('/api/modules/install', async (request, reply) => {
    if (!(await guard(request, reply, ['modules.manage']))) return reply;
    try {
      const body = request.body ?? {};
      const result = body.filePath
        ? await registries.module.installFromFile(body.filePath)
        : body.manifestRaw
          ? await registries.module.installRawText(body.manifestRaw, 'request-body')
          : await registries.module.installDocument(body.manifest, 'request-body');
      reply.code(201);
      return result;
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : 'Installation fehlgeschlagen.' };
    }
  });

  app.post('/api/modules/:moduleId/enable', async (request, reply) => {
    if (!(await guard(request, reply, ['modules.manage']))) return reply;
    try {
      return await registries.module.enableModule((request.params as { moduleId: string }).moduleId);
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : 'Modul konnte nicht aktiviert werden.' };
    }
  });

  app.post('/api/modules/:moduleId/disable', async (request, reply) => {
    if (!(await guard(request, reply, ['modules.manage']))) return reply;
    try {
      return await registries.module.disableModule((request.params as { moduleId: string }).moduleId);
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : 'Modul konnte nicht deaktiviert werden.' };
    }
  });

  app.post<{ Body: RollbackRequestBody }>('/api/modules/:moduleId/rollback', async (request, reply) => {
    if (!(await guard(request, reply, ['modules.manage']))) return reply;
    try {
      return await registries.module.rollbackModule(
        (request.params as { moduleId: string }).moduleId,
        request.body?.version,
      );
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : 'Rollback fehlgeschlagen.' };
    }
  });
}
