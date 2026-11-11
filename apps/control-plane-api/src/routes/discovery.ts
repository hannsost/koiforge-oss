import { buildIdentityLinkingReport } from '@koiforge/identity-linking-core';
import { buildDiscoveryReport } from '@koiforge/semantic-discovery-core';
import type { FastifyInstance } from 'fastify';

import type { AppRegistries } from '../registries.js';
import { createSessionGuard } from './_guard.js';

export function registerDiscoveryRoutes(app: FastifyInstance, registries: AppRegistries): void {
  const { guard } = createSessionGuard(registries.security);

  app.get('/api/discovery/report', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.read']))) return reply;

    const datasets = await registries.dataset.listDatasets();
    const inputs = await Promise.all(
      datasets.slice(0, 12).map(async (dataset) => ({
        datasetId: dataset.id,
        datasetName: dataset.name,
        namespace: dataset.namespace,
        columns: dataset.schema.map((field) => field.name),
        rows: (await registries.dataset.previewRows(dataset.id, 50)).rows,
      })),
    );

    return buildDiscoveryReport(inputs);
  });

  app.get('/api/identity/report', async (request, reply) => {
    if (!(await guard(request, reply, ['datasets.read']))) return reply;

    const datasets = await registries.dataset.listDatasets();
    const sliced = datasets.slice(0, 12);

    const [inputs, discoveryInputs] = await Promise.all([
      Promise.all(
        sliced.map(async (dataset) => ({
          datasetId: dataset.id,
          datasetName: dataset.name,
          rows: (await registries.dataset.previewRows(dataset.id, 50)).rows,
        })),
      ),
      Promise.all(
        sliced.map(async (dataset) => ({
          datasetId: dataset.id,
          datasetName: dataset.name,
          namespace: dataset.namespace,
          columns: dataset.schema.map((field) => field.name),
          rows: (await registries.dataset.previewRows(dataset.id, 50)).rows,
        })),
      ),
    ]);

    const discovery = buildDiscoveryReport(discoveryInputs);
    return buildIdentityLinkingReport(inputs, discovery.suggestions);
  });
}
