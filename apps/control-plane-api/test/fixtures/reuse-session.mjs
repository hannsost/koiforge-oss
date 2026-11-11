import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { FileDatasetRegistry } from '@koiforge/data-registry';
import { FileSecurityRegistry } from '@koiforge/security-core';
import { registerImportSessionRoutes } from '../../src/routes/import-sessions.js';
import { join } from 'node:path';

const root = process.env.KOIFORGE_IMPORT_DATA_ROOT;
if (!root) throw new Error('KOIFORGE_IMPORT_DATA_ROOT is required.');

const app = Fastify();
const dataset = new FileDatasetRegistry({ filePath: join(root, 'datasets.json') });
const security = new FileSecurityRegistry({ filePath: join(root, 'security.json') });
app.addHook('onRequest', async request => { request.koiforgeSession = await security.getSession(); });
const aip = {
  async getConfig() {
    return {
      provider: 'custom',
      model: 'fixture-parser',
      baseUrl: 'http://127.0.0.1:9/v1',
    };
  },
};

async function upload(name, contents) {
  const boundary = 'koi-ke1-restart-boundary';
  const result = await app.inject({
    method: 'POST',
    url: '/api/import/sessions',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      Buffer.from(contents),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
  if (result.statusCode !== 200) throw new Error(`Upload failed (${result.statusCode}): ${result.body}`);
  return result.json().session;
}

async function configure(sessionId, nodeId) {
  const result = await app.inject({
    method: 'POST',
    url: `/api/import/sessions/${sessionId}/nodes/${nodeId}/configure`,
    payload: {
      values: {
        datasetName: 'supply-second',
        namespace: 'imports',
        expectedRows: 3,
        requiredColumns: 'measurement_id,measurement_value',
      },
    },
  });
  if (result.statusCode !== 200) throw new Error(`Configure failed (${result.statusCode}): ${result.body}`);
  return result.json();
}

async function run(sessionId) {
  const result = await app.inject({
    method: 'POST',
    url: `/api/import/sessions/${sessionId}/run`,
    payload: {},
  });
  if (result.statusCode !== 200) throw new Error(`Run failed (${result.statusCode}): ${result.body}`);
  return result.json();
}

await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
await registerImportSessionRoutes(app, { dataset, security, aip });
await app.ready();

try {
  const uploaded = await upload(
    'restart.supply',
    'SUPPLY/1\nmeasurement_id|measurement_value\nm-001|10\nm-002|20\nm-003|30\n',
  );
  const node = Object.values(uploaded.nodes).find((entry) => entry.sourcePath?.endsWith('.supply'));
  if (!node) throw new Error('Restart fixture node was not discovered.');
  await configure(uploaded.id, node.id);
  const result = await run(uploaded.id);
  const finalNode = result.session.nodes[node.id];
  console.log(JSON.stringify({
    sessionId: uploaded.id,
    nodeId: node.id,
    uploadGeneration: uploaded.generation,
    resultGeneration: result.session.generation,
    resultStatus: result.session.status,
    resultNode: finalNode,
    importedDatasets: result.importedDatasets,
  }));
} finally {
  await app.close();
}
