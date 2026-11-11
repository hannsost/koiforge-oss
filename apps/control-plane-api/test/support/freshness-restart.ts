// Separate API process for restart/reuse acceptance. Never configured with a model.
import Fastify from 'fastify';
import { join } from 'node:path';
import { FileDatasetRegistry } from '@koiforge/data-registry';
import { FileSecurityRegistry } from '@koiforge/security-core';
import { registerFreshnessRoutes } from '../../src/routes/freshness.js';
import type { AppRegistries } from '../../src/registries.js';

const root = process.env.KOIFORGE_IMPORT_DATA_ROOT!;
const app = Fastify();
const identityFixture = new FileSecurityRegistry({ filePath: join(root, 'security.json') });
app.addHook('onRequest', async request => { request.koiforgeSession = await identityFixture.getSession(); });
registerFreshnessRoutes(app, {
  dataset: new FileDatasetRegistry({ filePath: join(root, 'datasets.json') }),
  security: new FileSecurityRegistry({ filePath: join(root, 'security.json') }),
  aip: { getConfig() { throw new Error('Reuse attempted to access the model provider.'); } },
} as unknown as AppRegistries);
const response = await app.inject({ method: 'POST', url: '/api/analysis/freshness', payload: JSON.parse(process.argv[2]!) });
process.stdout.write(JSON.stringify({ statusCode: response.statusCode, body: response.json() }));
await app.close();
