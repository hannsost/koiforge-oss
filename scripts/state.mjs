import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
try {
  const apiRequire = createRequire(join(root, 'apps/control-plane-api/package.json'));
  const loader = pathToFileURL(apiRequire.resolve('tsx')).href;
  const child = spawn(process.execPath, ['--import', loader, join(root, 'apps/control-plane-api/src/operations/cli.ts'), ...process.argv.slice(2)], {
    cwd: root, stdio: 'inherit', shell: false,
  });
  const stop = signal => { if (!child.killed) child.kill(signal); };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
  child.once('error', () => { process.stderr.write('Lokale State-CLI konnte nicht gestartet werden.\n'); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
} catch {
  process.stderr.write('Lokaler API-tsx-Loader fehlt. Projektabhängigkeiten müssen installiert sein.\n');
  process.exitCode = 1;
}
