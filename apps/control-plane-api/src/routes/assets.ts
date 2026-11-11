import type { AssetKind, AssetStatus, RunStatus } from '@koiforge/asset-lineage-core';
import type { FastifyInstance } from 'fastify';

import type { AppRegistries } from '../registries.js';
import { createSessionGuard } from './_guard.js';

interface AssetUpsertRequestBody {
  id?: string;
  name: string;
  kind: AssetKind;
  datasetId?: string;
  owner?: string;
  domain?: string;
  description?: string;
  status?: AssetStatus;
  tags?: string[];
}

interface LineageEdgeRequestBody {
  fromAssetId: string;
  toAssetId: string;
  operation: string;
}

interface RunRecordRequestBody {
  assetId: string;
  status: RunStatus;
  summary?: string;
}

export function registerAssetsRoutes(app: FastifyInstance, registries: AppRegistries): void {
  const { guard } = createSessionGuard(registries.security);

  app.get('/api/assets', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.read']))) return reply;
    return { items: await registries.assetLineage.listAssets(request.koiforgeSession.tenant.id) };
  });

  app.get('/api/lineage/edges', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.read']))) return reply;
    return { items: await registries.assetLineage.listEdges() };
  });

  app.get('/api/lineage/runs', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.read']))) return reply;
    return { items: await registries.assetLineage.listRuns() };
  });

  app.get('/api/lineage/events', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.read']))) return reply;
    return { items: await registries.assetLineage.listEvents() };
  });

  app.post<{ Body: AssetUpsertRequestBody }>('/api/assets/upsert', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.manage']))) return reply;
    try {
      const asset = await registries.assetLineage.upsertAsset({
        ...request.body,
        tenantId: request.koiforgeSession.tenant.id,
      });
      reply.code(201);
      return asset;
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : 'Asset konnte nicht gespeichert werden.' };
    }
  });

  app.post<{ Body: LineageEdgeRequestBody }>('/api/lineage/edges/record', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.manage']))) return reply;
    try {
      const edge = await registries.assetLineage.recordEdge(request.body);
      reply.code(201);
      return edge;
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : 'Lineage Edge konnte nicht gespeichert werden.' };
    }
  });

  app.post<{ Body: RunRecordRequestBody }>('/api/lineage/runs/record', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.manage']))) return reply;
    try {
      const run = await registries.assetLineage.recordRun({
        assetId: request.body.assetId,
        status: request.body.status,
        summary: request.body.summary,
        triggeredBy: request.koiforgeSession.user.id,
      });
      reply.code(201);
      return run;
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : 'Run konnte nicht gespeichert werden.' };
    }
  });
}
