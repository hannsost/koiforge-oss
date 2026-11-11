import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';

const authInput = {
  email: 'ingest-safety-owner@example.test',
  password: 'a unique ingest safety passphrase 2026',
  displayName: 'Ingest safety owner',
  workspaceName: 'Ingest safety workspace',
};

let root: string;
let app: FastifyInstance;
let cookie: string;
let provider: Server;
let providerUrl: string;
let providerCalls = 0;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'koiforge-ingest-safety-'));
  process.env.KOIFORGE_STATE_ROOT = root;
  // This must be set before the dynamic server import: import-session modules
  // capture the source root during module evaluation.
  process.env.KOIFORGE_IMPORT_DATA_ROOT = join(root, 'import-data');
  provider = createServer(async (request, response) => {
    providerCalls += 1;
    for await (const _chunk of request) {
      // Consume the body so a legacy call behaves like a real provider request.
    }
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: JSON.stringify({ impossible: true, reason: 'fixture' }) } }],
    }));
  });
  await new Promise<void>((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', () => resolve());
  });
  const address = provider.address();
  assert(address && typeof address === 'object');
  providerUrl = `http://127.0.0.1:${address.port}/v1`;
  process.env.KOIFORGE_AI_BASE_URLS = providerUrl;

  const { buildServer } = await import('../src/server.js');
  app = await buildServer();

  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { 'x-koiforge-request': '1', origin: 'http://localhost:5173' },
    payload: authInput,
  });
  assert.equal(setup.statusCode, 200, setup.body);
  cookie = String(setup.headers['set-cookie']).split(';')[0]!;

  const currentConfig = await app.inject({
    method: 'GET',
    url: '/api/aip/config',
    headers: { cookie },
  });
  assert.equal(currentConfig.statusCode, 200, currentConfig.body);
  const configured = await app.inject({
    method: 'PUT',
    url: '/api/aip/config',
    headers: protectedHeaders({ 'content-type': 'application/json' }),
    payload: {
      provider: 'custom',
      model: 'ingest-safety-fixture',
      baseUrl: providerUrl,
      revision: currentConfig.json().revision,
    },
  });
  assert.equal(configured.statusCode, 200, configured.body);
});

after(async () => {
  await app?.close();
  if (provider?.listening) {
    await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
  }
  delete process.env.KOIFORGE_STATE_ROOT;
  delete process.env.KOIFORGE_IMPORT_DATA_ROOT;
  delete process.env.KOIFORGE_AI_BASE_URLS;
  await rm(root, { recursive: true, force: true });
});

function protectedHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-koiforge-request': '1', cookie, ...extra };
}

function multipart(
  files: Array<{ name: string; contents: string | Buffer }>,
  fields: Record<string, string> = {},
): { headers: Record<string, string>; payload: Buffer } {
  const boundary = `koi-ingest-safety-${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ));
  }
  for (const file of files) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: text/csv\r\n\r\n`,
    ));
    chunks.push(Buffer.isBuffer(file.contents) ? file.contents : Buffer.from(file.contents));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    headers: {
      ...protectedHeaders({ 'content-type': `multipart/form-data; boundary=${boundary}` }),
    },
    payload: Buffer.concat(chunks),
  };
}

async function csvUpload(
  name: string,
  contents: string | Buffer,
  options: { files?: Array<{ name: string; contents: string | Buffer }>; delimiter?: string } = {},
) {
  const files = options.files ?? [{ name: `${name}.csv`, contents }];
  return app.inject({
    method: 'POST',
    url: '/api/datasets/upload',
    ...multipart(files, { name, namespace: 'ingest-safety', ...(options.delimiter ? { delimiter: options.delimiter } : {}) }),
  });
}

async function datasets() {
  const response = await app.inject({ method: 'GET', url: '/api/datasets', headers: { cookie } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().items as Array<{ id: string; name: string; namespace: string }>;
}

test('legacy AI import is authenticated first, then retired', async () => {
  const unauthorized = await app.inject({
    method: 'POST',
    url: '/api/datasets/ai-import',
    headers: { 'x-koiforge-request': '1' },
    payload: {},
  });
  assert.equal(unauthorized.statusCode, 401, unauthorized.body);

  const retired = await app.inject({
    method: 'POST',
    url: '/api/datasets/ai-import',
    ...multipart([{ name: 'legacy.csv', contents: 'id\n1\n' }]),
  });
  assert.equal(retired.statusCode, 410, retired.body);
  assert.equal(retired.json().code, 'IMPORT_WORKSPACE_REQUIRED');
  assert.equal(retired.json().replacement, '/api/import/sessions');
  assert.equal(providerCalls, 0, 'retired AI import must not call the configured provider');
});

test('legacy archive extraction is authenticated first, then retired', async () => {
  const unauthorized = await app.inject({
    method: 'POST',
    url: '/api/datasets/extract-archive',
    headers: { 'x-koiforge-request': '1' },
    payload: {},
  });
  assert.equal(unauthorized.statusCode, 401, unauthorized.body);

  const retired = await app.inject({
    method: 'POST',
    url: '/api/datasets/extract-archive',
    ...multipart([{ name: 'legacy.zip', contents: 'not an archive' }]),
  });
  assert.equal(retired.statusCode, 410, retired.body);
  assert.equal(retired.json().code, 'IMPORT_WORKSPACE_REQUIRED');
  assert.equal(retired.json().replacement, '/api/import/sessions');
});

test('legacy CSV upload preserves strings, BOM and quoted multiline fields', async () => {
  const response = await csvUpload(
    'strict-csv-fixture',
    '\uFEFFid,amount,note\r\n00123,12.50,"line one\r\nline ""two"""\r\n',
  );
  assert.equal(response.statusCode, 201, response.body);
  const dataset = response.json();
  assert.equal(dataset.id, 'ingest_safety_strict_csv_fixture');

  const preview = await app.inject({
    method: 'GET',
    url: `/api/datasets/${dataset.id}/preview?limit=10`,
    headers: { cookie },
  });
  assert.equal(preview.statusCode, 200, preview.body);
  assert.deepEqual(preview.json().rows, [{
    id: '00123',
    amount: '12.50',
    note: 'line one\r\nline "two"',
  }]);
});

test('malformed, duplicate, unsafe-header and invalid-UTF8 CSV files fail without registration', async () => {
  const fixtures: Array<{ name: string; contents: string | Buffer }> = [
    { name: 'malformed-csv', contents: 'id,note\n1,"unterminated\n' },
    { name: 'duplicate-header-csv', contents: 'id,id\n1,2\n' },
    { name: 'unsafe-header-csv', contents: '__proto__,value\nok,1\n' },
    { name: 'invalid-utf8-csv', contents: Buffer.from([0x69, 0x64, 0x2c, 0x76, 0x61, 0x6c, 0x75, 0x65, 0x0a, 0xff, 0x0a]) },
  ];

  for (const fixture of fixtures) {
    const response = await csvUpload(fixture.name, fixture.contents);
    assert.equal(response.statusCode, 400, `${fixture.name}: ${response.body}`);
    assert.equal((await datasets()).some((item) => item.name === fixture.name), false, fixture.name);
  }
});

test('CSV upload rejects multiple files, overlarge files and more than 100000 rows atomically', async () => {
  const multiple = await csvUpload(
    'multiple-file-csv',
    'id\n1\n',
    { files: [{ name: 'one.csv', contents: 'id\n1\n' }, { name: 'two.csv', contents: 'id\n2\n' }] },
  );
  assert.ok([400, 413].includes(multiple.statusCode), multiple.body);

  const oversized = await csvUpload(
    'oversized-csv',
    Buffer.concat([Buffer.from('id\n'), Buffer.alloc(10 * 1024 * 1024, 0x61)]),
  );
  assert.ok([400, 413].includes(oversized.statusCode), oversized.body);

  const tooManyRows = await csvUpload(
    'too-many-rows-csv',
    `id\n${Array.from({ length: 100_001 }, (_, index) => String(index)).join('\n')}\n`,
  );
  assert.ok([400, 413].includes(tooManyRows.statusCode), tooManyRows.body);

  const names = await datasets();
  assert.equal(names.some((item) => item.name === 'multiple-file-csv'), false);
  assert.equal(names.some((item) => item.name === 'oversized-csv'), false);
  assert.equal(names.some((item) => item.name === 'too-many-rows-csv'), false);
});

test('CSV upload retains all 10001 rows in the registered dataset', async () => {
  const response = await csvUpload(
    'complete-10001-csv',
    `id,value\n${Array.from({ length: 10_001 }, (_, index) => `${String(index).padStart(6, '0')},${index}.50`).join('\n')}\n`,
  );
  assert.equal(response.statusCode, 201, response.body);
  const dataset = response.json();

  const preview = await app.inject({
    method: 'GET',
    url: `/api/datasets/${dataset.id}/preview?limit=20000`,
    headers: { cookie },
  });
  assert.equal(preview.statusCode, 200, preview.body);
  const body = preview.json();
  assert.equal(body.rowCount, 10_001);
  assert.equal(body.rows.length, 10_001);
  assert.equal(body.truncated, false);
  assert.deepEqual(body.rows[0], { id: '000000', value: '0.50' });
  assert.deepEqual(body.rows.at(-1), { id: '010000', value: '10000.50' });
});

test('inline import rejects invalid rows, values and unsafe keys without partial registration', async () => {
  const invalidBodies: Array<{ name: string; rows: unknown }> = [
    { name: 'inline-row-type', rows: [{ id: 'ok' }, 'not-a-row'] },
    { name: 'inline-value-type', rows: [{ id: { nested: true } }] },
    { name: 'inline-unsafe-proto-key', rows: [{ ['__proto__']: 'unsafe', id: 'ok' }] },
    { name: 'inline-unsafe-constructor-key', rows: [{ constructor: 'unsafe', id: 'ok' }] },
    { name: 'inline-unsafe-prototype-key', rows: [{ prototype: 'unsafe', id: 'ok' }] },
  ];

  for (const body of invalidBodies) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/datasets/inline',
      headers: protectedHeaders({ 'content-type': 'application/json' }),
      payload: { name: body.name, namespace: 'ingest-safety', rows: body.rows },
    });
    assert.equal(response.statusCode, 400, `${body.name}: ${response.body}`);
    assert.equal((await datasets()).some((item) => item.name === body.name), false, body.name);
  }
});

test('inline import rejects duplicate dataset names with 409', async () => {
  const payload = {
    name: 'inline-duplicate-name',
    namespace: 'ingest-safety',
    rows: [{ id: '00123', amount: '12.50' }],
  };
  const first = await app.inject({
    method: 'POST',
    url: '/api/datasets/inline',
    headers: protectedHeaders({ 'content-type': 'application/json' }),
    payload,
  });
  assert.equal(first.statusCode, 201, first.body);

  const second = await app.inject({
    method: 'POST',
    url: '/api/datasets/inline',
    headers: protectedHeaders({ 'content-type': 'application/json' }),
    payload,
  });
  assert.equal(second.statusCode, 409, second.body);
  assert.equal((await datasets()).filter((item) => item.name === payload.name).length, 1);
});

test('inline import rejects rows exceeding the shared 16 MiB output budget atomically', async () => {
  const name = 'inline-output-budget';
  const response = await app.inject({
    method: 'POST',
    url: '/api/datasets/inline',
    headers: protectedHeaders({ 'content-type': 'application/json' }),
    payload: {
      name,
      namespace: 'ingest-safety',
      rows: [{ payload: 'x'.repeat(16 * 1024 * 1024 + 1024) }],
    },
  });
  assert.equal(response.statusCode, 400, 'inline output budget must be rejected');
  assert.equal((await datasets()).some((item) => item.name === name), false);
});

test('corrupt dataset registry returns 503 for reads and writes without changing bytes', async () => {
  const statePath = join(root, 'dataset-registry.json');
  const original = await readFile(statePath);
  const corrupt = Buffer.from('{"datasets": broken\n', 'utf8');

  try {
    await writeFile(statePath, corrupt);

    const get = await app.inject({
      method: 'GET',
      url: '/api/datasets',
      headers: { cookie },
    });
    assert.equal(get.statusCode, 503, get.body);
    assert.deepEqual(await readFile(statePath), corrupt);

    const csv = await csvUpload('corrupt-registry-csv', 'id\n1\n');
    assert.equal(csv.statusCode, 503, csv.body);
    assert.deepEqual(await readFile(statePath), corrupt);

    const inline = await app.inject({
      method: 'POST',
      url: '/api/datasets/inline',
      headers: protectedHeaders({ 'content-type': 'application/json' }),
      payload: {
        name: 'corrupt-registry-inline',
        namespace: 'ingest-safety',
        rows: [{ id: 'safe' }],
      },
    });
    assert.equal(inline.statusCode, 503, inline.body);
    assert.deepEqual(await readFile(statePath), corrupt);
  } finally {
    await writeFile(statePath, original);
  }
});
