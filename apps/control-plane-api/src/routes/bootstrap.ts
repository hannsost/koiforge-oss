import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';
import { getSqliteSchema, listSqliteTables, getPostgresSchema, listPostgresTables, type PgConnectionConfig } from '@koiforge/data-registry';

import type { AppRegistries } from '../registries.js';
import { createSessionGuard } from './_guard.js';

const exampleManifests = {
  platform: fileURLToPath(
    new URL('../../../../examples/modules/platform-core/module.yaml', import.meta.url),
  ),
  procurement: fileURLToPath(
    new URL('../../../../examples/modules/procurement-core/module.yaml', import.meta.url),
  ),
  supplierRisk: fileURLToPath(
    new URL('../../../../examples/modules/supplier-risk-pack/module.yaml', import.meta.url),
  ),
};

export function registerBootstrapRoutes(app: FastifyInstance, registries: AppRegistries): void {
  const { guard } = createSessionGuard(registries.security);

  app.post('/api/bootstrap/examples', async (request, reply) => {
    if (!(await guard(request, reply, ['modules.manage']))) return reply;

    if (!await registries.module.getModule('platform-core')) {
      await registries.module.installFromFile(exampleManifests.platform);
    }
    await registries.module.enableModule('platform-core');

    if (!await registries.module.getModule('procurement-core-pack')) {
      await registries.module.installFromFile(exampleManifests.procurement);
    }
    await registries.module.enableModule('procurement-core-pack');

    if (!await registries.module.getModule('supplier-risk-pack')) {
      await registries.module.installFromFile(exampleManifests.supplierRisk);
    }
    await registries.module.enableModule('supplier-risk-pack');

    return {
      modules: await registries.module.listModules(),
      capabilities: await registries.module.listCapabilities(),
      ui: await registries.module.listUiContributions(),
      audit: await registries.module.getAuditTrail(),
    };
  });

  app.post('/api/bootstrap/datasets', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.manage']))) return reply;
    const existing = await registries.dataset.listDatasets();
    const hasDataset = (namespace: string, name: string) =>
      existing.some((entry) => entry.namespace === namespace && entry.name === name);

    // Dataset IDs are slugify(namespace + '-' + name).
    // To match object type 'platform-event' → dataset 'platform_event',
    // we register name='event' in namespace='platform'.
    if (!hasDataset('platform', 'event')) {
      await registries.dataset.registerDataset({
        name: 'event',
        namespace: 'platform',
        description: 'Generic platform event stream for demo purposes.',
        connectorId: 'csv',
        mode: 'materialized',
        tags: ['platform', 'events', 'demo'],
        source: {
          path: './examples/data/sample-events.csv',
          delimiter: ',',
          columns: [
            { name: 'eventId', type: 'string', nullable: false },
            { name: 'eventType', type: 'string' },
            { name: 'source', type: 'string' },
            { name: 'severity', type: 'string' },
            { name: 'message', type: 'string' },
            { name: 'timestamp', type: 'datetime', nullable: false },
          ],
        },
      });
    }

    // Procurement datasets: supplier → object type 'supplier', procurement-order → 'procurement-order'
    if (!hasDataset('procurement', 'supplier')) {
      await registries.dataset.registerDataset({
        name: 'supplier',
        namespace: 'procurement',
        description: 'Supplier master data for procurement objects.',
        connectorId: 'csv',
        mode: 'materialized',
        tags: ['procurement', 'suppliers', 'demo'],
        source: {
          path: './examples/data/supplier-master.csv',
          delimiter: ',',
          columns: [
            { name: 'supplierId', type: 'string', nullable: false },
            { name: 'name', type: 'string' },
            { name: 'country', type: 'string' },
            { name: 'riskScore', type: 'number' },
            { name: 'status', type: 'string' },
          ],
        },
      });
    }

    if (!hasDataset('platform', 'metric')) {
      await registries.dataset.registerDataset({
        name: 'metric',
        namespace: 'platform',
        description: 'Generic time-series metric snapshots for demo purposes.',
        connectorId: 'csv',
        mode: 'materialized',
        tags: ['platform', 'metrics', 'demo'],
        source: {
          path: './examples/data/sample-metrics.csv',
          delimiter: ',',
          columns: [
            { name: 'metricId', type: 'string', nullable: false },
            { name: 'name', type: 'string' },
            { name: 'value', type: 'number' },
            { name: 'unit', type: 'string' },
            { name: 'timestamp', type: 'datetime', nullable: false },
          ],
        },
      });
    }

    return {
      connectors: await registries.dataset.listConnectors(),
      datasets: await registries.dataset.listDatasets(),
      events: await registries.dataset.listEvents(),
    };
  });

  app.post('/api/bootstrap/assets', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.manage']))) return reply;
    const datasets = await registries.dataset.listDatasets();
    const seededAssets = await registries.assetLineage.seedFromDatasets(
      request.koiforgeSession.tenant.id,
      datasets.map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        tags: entry.tags,
      })),
    );

    if (seededAssets.length >= 2) {
      const sourceAsset = seededAssets[0];
      const targetAsset = seededAssets[1];

      if (sourceAsset && targetAsset) {
        await registries.assetLineage.recordEdge({
          fromAssetId: sourceAsset.id,
          toAssetId: targetAsset.id,
          operation: 'join-enrichment',
        });
        await registries.assetLineage.recordRun({
          assetId: sourceAsset.id,
          status: 'succeeded',
          triggeredBy: request.koiforgeSession.user.id,
          summary: 'Initial asset ingestion',
        });
      }
    }

    return {
      assets: await registries.assetLineage.listAssets(request.koiforgeSession.tenant.id),
      edges: await registries.assetLineage.listEdges(),
      runs: await registries.assetLineage.listRuns(),
      events: await registries.assetLineage.listEvents(),
    };
  });

  // Auto-discover and register all tables from a SQLite database file
  app.post<{ Body: { filePath: string; namespace?: string } }>(
    '/api/bootstrap/sqlite',
    async (request, reply) => {
      if (!(await guard(request, reply, ['datasets.manage']))) return reply;
      const { filePath, namespace = 'sqlite' } = request.body ?? {};
      if (!filePath) {
        reply.code(400);
        return { error: 'filePath is required' };
      }

      const tables = listSqliteTables(filePath);
      const existing = await registries.dataset.listDatasets();
      const registered: string[] = [];
      const skipped: string[] = [];

      for (const table of tables) {
        const id = `${namespace}_${table}`;
        if (existing.some((d) => d.id === id)) {
          skipped.push(table);
          continue;
        }
        const schema = getSqliteSchema(filePath, table);
        await registries.dataset.registerDataset({
          name: table,
          namespace,
          description: `SQLite table '${table}' from ${filePath}`,
          connectorId: 'sqlite',
          mode: 'materialized',
          tags: ['sqlite', namespace],
          source: { filePath, table, columns: schema },
        });
        registered.push(table);
      }

      return {
        filePath,
        namespace,
        tables,
        registered,
        skipped,
        datasets: await registries.dataset.listDatasets(),
      };
    },
  );

  // Auto-discover and register all tables from a Postgres database
  app.post<{
    Body: {
      host?: string;
      port?: number;
      database: string;
      user?: string;
      password?: string;
      schema?: string;
      namespace?: string;
    };
  }>(
    '/api/bootstrap/postgres',
    async (request, reply) => {
      if (!(await guard(request, reply, ['datasets.manage']))) return reply;
      const {
        host = 'localhost',
        port = 5432,
        database,
        user = 'postgres',
        password = '',
        schema = 'public',
        namespace,
      } = request.body ?? {};

      if (!database) {
        reply.code(400);
        return { error: 'database is required' };
      }

      const ns = namespace ?? database;
      const conn: PgConnectionConfig = { host, port, database, user, password, schema };

      let tables: string[];
      try {
        tables = await listPostgresTables(conn);
      } catch (err) {
        reply.code(502);
        return { error: `Cannot connect to Postgres: ${err instanceof Error ? err.message : String(err)}` };
      }

      const existing = await registries.dataset.listDatasets();
      const registered: string[] = [];
      const skipped: string[] = [];

      for (const table of tables) {
        const id = `${ns}_${table}`;
        if (existing.some((d) => d.id === id)) {
          skipped.push(table);
          continue;
        }
        const fields = await getPostgresSchema(conn, table);
        await registries.dataset.registerDataset({
          name: table,
          namespace: ns,
          description: `Postgres table '${schema}.${table}' from ${host}/${database}`,
          connectorId: 'postgres',
          mode: 'materialized',
          tags: ['postgres', ns],
          source: { host, port, database, user, password, schema, table, columns: fields },
        });
        registered.push(table);
      }

      return {
        host,
        database,
        schema,
        namespace: ns,
        tables,
        registered,
        skipped,
        datasets: await registries.dataset.listDatasets(),
      };
    },
  );
}
