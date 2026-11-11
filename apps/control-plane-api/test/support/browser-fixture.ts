import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validCode } from './freshness-provider-fixture.js';

const fixtureDirectory = await mkdtemp(join(tmpdir(), 'koi-browser-fixture-'));
const root = join(fixtureDirectory, 'state');
await mkdir(root, { mode: 0o700 });
process.env.KOIFORGE_STATE_ROOT = root;
process.env.KOIFORGE_PUBLIC_ORIGIN = 'http://127.0.0.1:5191';
process.env.KOIFORGE_IMPORT_DATA_ROOT = root;
process.env.KOIFORGE_EXTENSION_BACKEND = 'api';
// Missions use a local CLI even when legacy analysis tests opt into the API double.
const missionCli = join(root, 'mission-codex-fixture.mjs');
await writeFile(missionCli, await readFile(new URL('./mission-codex-fixture.mjs', import.meta.url)), { mode: 0o700 });
process.env.KOIFORGE_CODEX_BIN = missionCli;
const provider = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  const chat = body.includes('Was lässt sich mit einer Datenquelle klären?');
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ choices: [{ message: { content: chat ? 'Mit einer Datenquelle kannst du beispielsweise offene Bestellungen oder veraltete Einträge prüfen. Entscheidend sind eine konkrete Frage, passende Felder und nachvollziehbare Belege.' : JSON.stringify({ code: validCode }) } }] }));
});
await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
const { getConfig } = await import('../../src/config.js');
const { createRegistries } = await import('../../src/registries.js');
const { buildServer } = await import('../../src/server.js');
await createRegistries(getConfig()).aip.setConfig({ provider: 'custom', model: 'browser-fixture',
  baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1` });
const { AuthStore } = await import('../../src/auth-store.js');
const login = await new AuthStore(join(root, 'auth.json')).setup({ email: 'owner@example.test', password: 'browser fixture passphrase only', displayName: 'Fixture owner', workspaceName: 'Neurofunken Testbereich' });
const authPath = join(tmpdir(), `koi-browser-auth-${process.getuid?.() ?? 0}.json`);
await writeFile(authPath, JSON.stringify({ cookies: [{ name: 'koiforge_session', value: login.token, domain: '127.0.0.1', path: '/', httpOnly: true, secure: false, sameSite: 'Lax', expires: Date.now() / 1000 + 3600 }], origins: [] }), { mode: 0o600 });
process.env.KOIFORGE_AI_BASE_URLS = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
const app = await buildServer();
await app.listen({ host: '127.0.0.1', port: 3191 });
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  await app.close();
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await rm(authPath, { force: true });
  await rm(fixtureDirectory, { recursive: true, force: true });
}
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
