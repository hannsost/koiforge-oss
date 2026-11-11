import { DatasetStorageError, DatasetInputError, DatasetConflictError, type DatasetMode } from '@koiforge/data-registry';
import type { FastifyInstance } from 'fastify';

import type { AppRegistries } from '../registries.js';
import { createSessionGuard } from './_guard.js';

interface DatasetDiscoverRequestBody {
  connectorId: string;
  source: Record<string, unknown>;
}

interface DatasetRegisterRequestBody extends DatasetDiscoverRequestBody {
  name: string;
  namespace: string;
  description?: string;
  mode: DatasetMode;
  tags?: string[];
}

interface DatasetSnapshotRequestBody {
  reason?: string;
}

interface DatasetPreviewQuerystring {
  limit?: string;
  q?: string;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  filters?: string;
}

function parseFiltersLocal(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
        .map(([key, value]) => [key, value as string]),
    );
  } catch {
    return {};
  }
}

function comparePreviewValues(
  left: string | number | boolean | null | undefined,
  right: string | number | boolean | null | undefined,
): number {
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right;
  }

  return String(left ?? '').localeCompare(String(right ?? ''));
}

export function filterAndSortPreview(
  preview: {
    columns: string[];
    rows: Array<Record<string, string | number | boolean | null>>;
    rowCount: number;
    truncated: boolean;
    datasetId: string;
  },
  query: DatasetPreviewQuerystring,
) {
  const search = query.q?.trim().toLowerCase();
  const sortBy = query.sortBy;
  const sortDir = query.sortDir === 'desc' ? -1 : 1;
  const filters = parseFiltersLocal(query.filters);

  let rows = preview.rows;

  if (search) {
    rows = rows.filter((row) =>
      preview.columns.some((column) => String(row[column] ?? '').toLowerCase().includes(search)),
    );
  }

  if (Object.keys(filters).length > 0) {
    rows = rows.filter((row) =>
      Object.entries(filters).every(
        ([column, expected]) => String(row[column] ?? '').toLowerCase() === expected.toLowerCase(),
      ),
    );
  }

  if (sortBy && preview.columns.includes(sortBy)) {
    rows = [...rows].sort(
      (left, right) => comparePreviewValues(left[sortBy], right[sortBy]) * sortDir,
    );
  }

  return { ...preview, rows };
}

export function registerDatasetsRoutes(app: FastifyInstance, registries: AppRegistries): void {
  const { guard } = createSessionGuard(registries.security);

  app.get('/api/connectors', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.read']))) return reply;
    return { items: await registries.dataset.listConnectors() };
  });

  app.get('/api/datasets', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.read']))) return reply;
    return { items: await registries.dataset.listDatasets() };
  });

  app.get('/api/datasets/events', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.read']))) return reply;
    return { items: await registries.dataset.listEvents() };
  });

  app.get('/api/datasets/:datasetId', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.read']))) return reply;
    const dataset = await registries.dataset.getDataset(
      (request.params as { datasetId: string }).datasetId,
    );
    if (!dataset) {
      reply.code(404);
      return { error: 'Dataset wurde nicht gefunden.' };
    }
    return dataset;
  });

  app.get('/api/datasets/:datasetId/sql', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.read']))) return reply;
    try {
      return await registries.dataset.previewSql(
        (request.params as { datasetId: string }).datasetId,
      );
    } catch (error) {
      reply.code(error instanceof DatasetStorageError || error instanceof DatasetInputError ? error.statusCode : 404);
      return { error: error instanceof Error ? error.message : 'SQL-Vorschau nicht verfügbar.' };
    }
  });

  app.get<{ Querystring: DatasetPreviewQuerystring }>(
    '/api/datasets/:datasetId/preview',
    async (request, reply) => {
      if (!(await guard(request, reply, ['datasets.read']))) return reply;
      try {
        const limit = Number.parseInt(request.query.limit ?? '20', 10);
        const preview = await registries.dataset.previewRows(
          (request.params as { datasetId: string }).datasetId,
          Number.isNaN(limit) ? 20 : limit,
        );
        return filterAndSortPreview(preview, request.query);
      } catch (error) {
        reply.code(error instanceof DatasetStorageError || error instanceof DatasetInputError ? error.statusCode : 404);
        return { error: error instanceof Error ? error.message : 'Dataset-Preview nicht verfügbar.' };
      }
    },
  );

  app.post<{ Body: DatasetDiscoverRequestBody }>('/api/datasets/discover', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.manage']))) return reply;
    try {
      return registries.dataset.discoverSchema(request.body.connectorId, request.body.source);
    } catch (error) {
      reply.code(error instanceof DatasetStorageError || error instanceof DatasetConflictError ? error.statusCode : 400);
      return { error: error instanceof Error ? error.message : 'Schema Discovery fehlgeschlagen.' };
    }
  });

  app.post<{ Body: DatasetRegisterRequestBody }>('/api/datasets/register', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.manage']))) return reply;
    try {
      const dataset = await registries.dataset.registerDataset({
        name: request.body.name,
        namespace: request.body.namespace,
        description: request.body.description,
        connectorId: request.body.connectorId,
        mode: request.body.mode,
        source: request.body.source,
        tags: request.body.tags,
      });
      reply.code(201);
      return dataset;
    } catch (error) {
      reply.code(error instanceof DatasetStorageError || error instanceof DatasetConflictError ? error.statusCode : 400);
      return { error: error instanceof Error ? error.message : 'Dataset-Registrierung fehlgeschlagen.' };
    }
  });

  app.post<{ Body: DatasetSnapshotRequestBody }>(
    '/api/datasets/:datasetId/snapshot',
    async (request, reply) => {
      if (!(await guard(request, reply, ['datasets.snapshot']))) return reply;
      try {
        return await registries.dataset.snapshotDataset(
          (request.params as { datasetId: string }).datasetId,
          request.body?.reason ?? 'manual-snapshot',
        );
      } catch (error) {
        reply.code(error instanceof DatasetStorageError || error instanceof DatasetInputError ? error.statusCode : 404);
        return { error: error instanceof Error ? error.message : 'Snapshot fehlgeschlagen.' };
      }
    },
  );

  app.delete('/api/datasets/:datasetId', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.manage']))) return reply;
    try {
      await registries.dataset.deleteDataset((request.params as { datasetId: string }).datasetId);
      reply.code(204);
      return;
    } catch (error) {
      reply.code(error instanceof DatasetStorageError || error instanceof DatasetInputError ? error.statusCode : 404);
      return { error: error instanceof Error ? error.message : 'Dataset konnte nicht gelöscht werden.' };
    }
  });

  app.delete('/api/datasets', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.manage']))) return reply;
    const { namespace } = request.query as { namespace?: string };
    if (!namespace) {
      reply.code(400);
      return { error: 'namespace query parameter is required' };
    }
    const deleted = await registries.dataset.deleteDatasetsByNamespace(namespace);
    return { deleted, count: deleted.length };
  });

  app.post('/api/datasets/:datasetId/refresh-schema', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.manage']))) return reply;
    try {
      return await registries.dataset.refreshSchema(
        (request.params as { datasetId: string }).datasetId,
      );
    } catch (error) {
      reply.code(error instanceof DatasetStorageError || error instanceof DatasetInputError ? error.statusCode : 404);
      return { error: error instanceof Error ? error.message : 'Schema-Aktualisierung fehlgeschlagen.' };
    }
  });
}
