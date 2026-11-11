import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createServer } from 'node:net';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--built')) throw new Error('Supported option: --built');
const built = args.includes('--built');
const webRoot = join(root, 'apps/console-web');
const vite = join(webRoot, 'node_modules/.bin/vite');
const buildDir = join(root, '.koiforge/local-console');
const apiPort = Number(process.env.KOIFORGE_API_PORT ?? 3100);
const webPort = Number(process.env.KOIFORGE_WEB_PORT ?? 5173);
for (const port of [apiPort, webPort]) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid development port.');
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
}
if (apiPort === webPort) throw new Error('API and UI need different ports.');
if (built) {
  await new Promise((resolve, reject) => {
    const build = spawn(vite, ['build', '--outDir', buildDir, '--emptyOutDir'], {
      cwd: webRoot, env: { ...process.env, VITE_API_BASE_URL: '' }, stdio: 'inherit',
    });
    build.once('error', reject);
    build.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`UI build failed: ${signal ?? code}`)));
  });
}
const state = process.env.KOIFORGE_STATE_ROOT ?? join(root, '.koiforge');
const children = [];
function start(name, command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit' });
  children.push(child);
  child.once('error', (error) => { console.error(`${name} konnte nicht starten: ${error.message}`); stop(1); });
  child.once('exit', (code, signal) => {
    if (stopping) return;
    console.error(`${name} wurde beendet (${signal ? `Signal ${signal}` : `Exit ${code}`}). Die lokale Vorschau wird geschlossen.`);
    stop(signal ? 1 : code ?? 1);
  });
}
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
process.once('SIGINT', () => stop(0));
process.once('SIGTERM', () => stop(0));
start('KoiForge API', join(root, 'apps/control-plane-api/node_modules/.bin/tsx'), ['src/index.ts'], join(root, 'apps/control-plane-api'), {
  HOST: '127.0.0.1', PORT: String(apiPort), KOIFORGE_STATE_ROOT: state, KOIFORGE_IMPORT_DATA_ROOT: state,
});
start('KoiForge Oberfläche', vite, [...(built ? ['preview', '--outDir', buildDir] : []), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], webRoot, {
  VITE_API_BASE_URL: '', KOIFORGE_API_PROXY: `http://127.0.0.1:${apiPort}`,
});
console.log(`KoiForge ${built ? 'local preview' : 'development'}: http://127.0.0.1:${webPort} — state: ${state}`);
