import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';

import { acquireStateLease, StateLeaseError } from '../src/operations/state-lease.js';

const apiCwd = fileURLToPath(new URL('../', import.meta.url));
const entrypoint = 'src/index.ts';
const wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

interface RunningApi {
  child: ChildProcess;
  output: string[];
}

interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function ownTestEnvironment(root: string, port: number | '0'): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (/OPENAI|CODEX|API_KEY|AUTH.*SEED|SEED.*AUTH|TOKEN|SECRET|PASSWORD/i.test(key)) delete environment[key];
  }
  delete environment.KOIFORGE_PUBLIC_ORIGIN;
  return {
    ...environment,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: String(port),
    KOIFORGE_STATE_ROOT: root,
    KOIFORGE_IMPORT_DATA_ROOT: root,
    KOIFORGE_GENERATION_DISABLED: '1',
    KOIFORGE_SEEDED_CONTRACTS: '',
  };
}

function startApi(root: string, port: number | '0'): RunningApi {
  const output: string[] = [];
  const child = spawn(process.execPath, ['--import', 'tsx', entrypoint], {
    cwd: apiCwd,
    env: ownTestEnvironment(root, port),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', chunk => output.push(String(chunk)));
  child.stderr?.on('data', chunk => output.push(String(chunk)));
  return { child, output };
}

function diagnostic(api: RunningApi): string {
  return api.output.join('');
}

async function waitForExit(child: ChildProcess, timeout = 12_000): Promise<ExitResult> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise<ExitResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      reject(new Error(`Kindprozess ${child.pid ?? 'unbekannt'} beendet sich nicht rechtzeitig.`));
    }, timeout);
    timer.unref();
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    child.once('exit', onExit);
  });
}

async function stopApi(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): Promise<ExitResult> {
  const exited = waitForExit(child);
  if (child.exitCode === null && child.signalCode === null) {
    assert.ok(child.pid && child.pid > 0, 'Der Testkindprozess muss eine eigene PID haben.');
    child.kill(signal);
  }
  return exited;
}

async function waitForHealth(api: RunningApi, timeout = 12_000): Promise<number> {
  const deadline = Date.now() + timeout;
  let port: number | undefined;
  while (Date.now() < deadline) {
    const listening = diagnostic(api).match(/Server listening at http:\/\/127\.0\.0\.1:(\d+)/);
    if (listening) port = Number(listening[1]);
    if (port !== undefined) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        const body = await response.json() as { status?: string; service?: string };
        if (response.ok && body.status === 'ok' && body.service === 'koiforge-control-plane-api') return port;
      } catch {
        // The listener can be logged a few milliseconds before it accepts requests.
      }
    }
    if (api.child.exitCode !== null || api.child.signalCode !== null) {
      throw new Error(`API-Kindprozess beendet vor /health: ${diagnostic(api)}`);
    }
    await wait(30);
  }
  throw new Error(`API-Health wurde nicht erreichbar: ${diagnostic(api)}`);
}

async function cleanupChildren(children: ChildProcess[]): Promise<void> {
  for (const child of [...children].reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const pid = child.pid;
    if (!pid || pid <= 0) continue;
    try { child.kill('SIGTERM'); } catch { /* the owned child may have exited between the checks */ }
    try {
      await waitForExit(child, 5_000);
    } catch {
      if (child.exitCode === null && child.signalCode === null && child.pid === pid) {
        try { child.kill('SIGKILL'); } catch { /* cleanup is best effort for this owned PID */ }
      }
      try { await waitForExit(child, 5_000); } catch { /* leave no unrelated process targeted */ }
    }
  }
}

async function harness(t: TestContext): Promise<{ directory: string; root: string; children: ChildProcess[] }> {
  const directory = await mkdtemp(join(tmpdir(), 'koiforge-api-lifecycle-'));
  const root = join(directory, 'state');
  const children: ChildProcess[] = [];
  t.after(async () => {
    await cleanupChildren(children);
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, root, children };
}

async function reservePort(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert(address && typeof address === 'object', 'Der Test-Port muss eine TCP-Adresse haben.');
  return { server, port: address.port };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test('real entrypoint serves health, releases its lease on SIGTERM, and can restart', async t => {
  const { root, children } = await harness(t);

  const first = startApi(root, '0');
  children.push(first.child);
  const firstPort = await waitForHealth(first);
  assert.match(`http://127.0.0.1:${firstPort}`, /^http:\/\/127\.0\.0\.1:\d+$/);
  await assert.rejects(acquireStateLease(root), StateLeaseError);

  const firstExit = await stopApi(first.child, 'SIGTERM');
  assert.deepEqual(firstExit, { code: 0, signal: null });

  const recovered = await acquireStateLease(root);
  assert.equal(recovered.root, root);
  await recovered.release();

  const restarted = startApi(root, '0');
  children.push(restarted.child);
  await waitForHealth(restarted);
  await assert.rejects(acquireStateLease(root), StateLeaseError);
  const restartExit = await stopApi(restarted.child, 'SIGTERM');
  assert.deepEqual(restartExit, { code: 0, signal: null });

  const finalLease = await acquireStateLease(root);
  await finalLease.release();
});

test('real entrypoint exits 1 on an occupied listen port and releases its lease', async t => {
  const { root, children } = await harness(t);
  const occupied = await reservePort();
  try {
    const failed = startApi(root, occupied.port);
    children.push(failed.child);
    const exit = await waitForExit(failed.child);
    assert.deepEqual(exit, { code: 1, signal: null });
    assert.match(diagnostic(failed), /API-Start fehlgeschlagen|EADDRINUSE|listen/i);

    const recovered = await acquireStateLease(root);
    assert.equal(recovered.root, root);
    await recovered.release();
  } finally {
    await closeServer(occupied.server);
  }
});
