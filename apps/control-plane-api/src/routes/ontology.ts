import { moduleSchema, validateManifestDocument, validateManifestText } from '@koiforge/module-manifest';
import { validateManifestMerge, validateOntologyModules } from '@koiforge/ontology-core';
import type { FastifyInstance } from 'fastify';

import type { AppRegistries } from '../registries.js';
import { createSessionGuard } from './_guard.js';

interface OntologyValidateRequestBody {
  manifestRaw?: string;
  manifest?: unknown;
}

export function registerOntologyRoutes(app: FastifyInstance, registries: AppRegistries): void {
  const { guard } = createSessionGuard(registries.security);

  app.get('/api/schema/module', async () => moduleSchema);

  app.get('/api/ontology/snapshot', async (request, reply) => {
    if (!(await guard(request, reply, ['modules.read']))) return reply;
    return validateOntologyModules(await registries.module.listCurrentManifests());
  });

  app.post<{ Body: OntologyValidateRequestBody }>('/api/ontology/validate-manifest', async (request, reply) => {
    if (!(await guard(request, reply, ['modules.manage']))) return reply;
    const body = request.body ?? {};
    const validation = body.manifestRaw
      ? validateManifestText(body.manifestRaw, 'request-body')
      : validateManifestDocument(body.manifest, 'request-body');

    if (!validation.valid || !validation.manifest) {
      reply.code(422);
      return validation;
    }

    return validateManifestMerge(await registries.module.listCurrentManifests(), {
      moduleId: validation.manifest.id,
      manifest: validation.manifest,
    });
  });
}
