import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';

import type { AppRegistries } from '../registries.js';
import { createSessionGuard } from './_guard.js';

export interface AppManifest {
  id: string;
  name: string;
  description: string;
  category: 'legacy' | 'sandbox';
  icon: string;
  version: string;
  author: string;
  license: string;
  homepage: string;
  tags: string[];
  moduleFile: string;
  requires: string[];
}

export interface AppEntry extends AppManifest {
  installed: boolean;
  enabled: boolean;
  moduleFilePath: string;
}

const examplesDir = fileURLToPath(
  new URL('../../../../examples/modules', import.meta.url),
);

async function loadApps(registries: AppRegistries): Promise<AppEntry[]> {
  const entries: AppEntry[] = [];

  let dirs: string[] = [];
  try {
    dirs = await readdir(examplesDir);
  } catch {
    return entries;
  }

  const installedModules = await registries.module.listModules();

  for (const dir of dirs) {
    const appJsonPath = path.join(examplesDir, dir, 'app.json');
    try {
      const raw = await readFile(appJsonPath, 'utf-8');
      const manifest = JSON.parse(raw) as AppManifest;
      const installedModule = installedModules.find((m) => m.id === manifest.id);
      entries.push({
        ...manifest,
        installed: installedModule !== undefined,
        enabled: installedModule?.status === 'enabled',
        moduleFilePath: path.join(examplesDir, dir, manifest.moduleFile),
      });
    } catch {
      // No app.json or invalid — skip
    }
  }

  return entries;
}

export function registerAppStoreRoutes(app: FastifyInstance, registries: AppRegistries): void {
  const { guard } = createSessionGuard(registries.security);

  app.get('/api/appstore', async (request, reply) => {
    if (!(await guard(request, reply, ['modules.read']))) return reply;
    const apps = await loadApps(registries);
    return { items: apps };
  });

  app.post('/api/appstore/:appId/install', async (request, reply) => {
    if (!(await guard(request, reply, ['modules.manage']))) return reply;
    const { appId } = request.params as { appId: string };

    const apps = await loadApps(registries);
    const entry = apps.find((a) => a.id === appId);
    if (!entry) {
      reply.code(404);
      return { error: `App '${appId}' not found in store.` };
    }
    if (entry.installed) {
      // Already installed — just enable it
      try {
        await registries.module.enableModule(appId);
        return { items: await loadApps(registries) };
      } catch (error) {
        reply.code(400);
        return { error: error instanceof Error ? error.message : 'Enable failed.' };
      }
    }

    try {
      await registries.module.installFromFile(entry.moduleFilePath);
      await registries.module.enableModule(appId);
      return { items: await loadApps(registries) };
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : 'Install failed.' };
    }
  });

  app.post('/api/appstore/:appId/uninstall', async (request, reply) => {
    if (!(await guard(request, reply, ['modules.manage']))) return reply;
    const { appId } = request.params as { appId: string };

    try {
      await registries.module.disableModule(appId);
      return { items: await loadApps(registries) };
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : 'Uninstall failed.' };
    }
  });
}
