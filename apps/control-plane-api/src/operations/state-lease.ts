import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, readdir, readFile, stat, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';

export interface StateLease {
  root: string;
  release(): Promise<void>;
}
export class StateLeaseError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'StateLeaseError'; }
}
const activeLeases = new Map<string, FileHandle>();
// A process-group cleanup failure is fail-closed for the rest of this API
// process. Keeping the error by canonical root prevents a later writer or
// app shutdown from closing the only known lease while an old writer may live.
const leaseFailures = new Map<string, StateLeaseError>();

/** Resolve existing ancestors without creating the state directory itself. */
export async function canonicalStateRoot(root: string): Promise<string> {
  if (typeof root !== 'string' || !root.trim() || root.includes('\0')) throw new StateLeaseError('Ein gültiger Datenordner ist erforderlich.');
  // Keep .. until realpath resolves existing symlink components. path.resolve
  // would normalize them before the filesystem can establish their meaning.
  let candidate = isAbsolute(root) ? root : `${process.cwd()}/${root}`;
  const suffix: string[] = [];
  while (true) {
    try { return join(await realpath(candidate), ...suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A dangling symlink is not an absent restore target: treating it as an
      // ordinary missing component would give its target a different lock.
      const entry = await lstat(candidate).catch(failure => {
        if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw failure;
      });
      if (entry?.isSymbolicLink()) throw new StateLeaseError('Ein nicht auflösbarer symbolischer Link kann kein Datenordner sein.');
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      suffix.unshift(basename(candidate)); candidate = parent;
    }
  }
}

function flock(descriptor: number, root: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Linux flock associates this lock with the open file description shared
    // with the parent, not with the short-lived flock process's PID.
    const child = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '73', '3'], {
      stdio: ['ignore', 'ignore', 'pipe', descriptor],
    });
    let diagnostic = ''; let timedOut = false;
    child.stderr?.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(0, 2000); });
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 5000);
    timeout.unref();
    child.once('error', error => {
      clearTimeout(timeout);
      reject(new StateLeaseError('Die exklusive Datensperre benötigt /usr/bin/flock aus util-linux.', { cause: error }));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0 && !timedOut) resolve();
      else if (code === 73) reject(new StateLeaseError(`Der Datenordner „${root}“ wird bereits verwendet. API, Importprozess oder andere Datensicherung zuerst beenden.`));
      else reject(new StateLeaseError(`Die exklusive Datensperre konnte nicht gesetzt werden${timedOut ? ' (Zeitlimit)' : signal ? ` (${signal})` : ''}.${diagnostic ? ` ${diagnostic.trim()}` : ''}`));
    });
  });
}

interface ProcStat {
  pid: number;
  state: string;
  pgrp: number;
}

function parseProcStat(raw: string, pid: number): ProcStat {
  const closing = raw.lastIndexOf(')');
  if (closing < 0) throw new StateLeaseError('Ein Prozessstatus konnte nicht sicher gelesen werden.');
  const fields = raw.slice(closing + 1).trim().split(/\s+/);
  const state = fields[0];
  const pgrp = Number(fields[2]);
  if (!state || !Number.isSafeInteger(pgrp)) throw new StateLeaseError('Eine Prozessgruppe konnte nicht sicher gelesen werden.');
  return { pid, state, pgrp };
}

async function readProcStat(pid: number): Promise<ProcStat | undefined> {
  try {
    return parseProcStat(await readFile(`/proc/${pid}/stat`, 'utf8'), pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function processGroupMembers(pgrp: number): Promise<number[]> {
  const entries = await readdir('/proc');
  const members: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const parsed = await readProcStat(Number(entry));
    if (parsed && parsed.pgrp === pgrp && !['Z', 'z'].includes(parsed.state)) members.push(parsed.pid);
  }
  return members;
}

const delay = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

/** Kill all live members of a verified detached process group, excluding the caller. */
async function killProcessGroup(pgrp: number): Promise<boolean> {
  const own = await readProcStat(process.pid);
  if (!own || own.pgrp === pgrp) throw new StateLeaseError('Die isolierte Prozessgruppe des Imports konnte nicht verifiziert werden.');
  const leader = await readProcStat(pgrp);
  if (leader && (leader.pid !== pgrp || leader.pgrp !== pgrp)) {
    throw new StateLeaseError('Die Prozessgruppe des Importprozesses konnte nicht eindeutig verifiziert werden.');
  }

  let stopped = false;
  while (true) {
    const members = (await processGroupMembers(pgrp)).filter(pid => pid !== process.pid);
    if (members.length === 0) return stopped;
    stopped = true;
    for (const pid of members) {
      try { process.kill(pid, 'SIGKILL'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    await delay(20);
  }
}

/** Nonblocking OS lease. Its persistent sidecar must never be unlinked. */
export async function acquireStateLease(root: string): Promise<StateLease> {
  if (process.platform !== 'linux') throw new StateLeaseError('Die sichere lokale Datensperre wird derzeit nur unter Linux unterstützt.');
  const canonicalRoot = await canonicalStateRoot(root);
  const blocked = leaseFailures.get(canonicalRoot);
  if (blocked) throw blocked;
  const parent = dirname(canonicalRoot);
  if (parent === canonicalRoot) throw new StateLeaseError('Das Dateisystem-Wurzelverzeichnis darf kein KoiForge-Datenordner sein.');
  const existing = await stat(canonicalRoot).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing && !existing.isDirectory()) throw new StateLeaseError('Der Datenordner ist kein Verzeichnis.');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const lockPath = join(parent, `.koiforge-state-${createHash('sha256').update(canonicalRoot).digest('hex')}.lock`);
  const handle = await open(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
    .catch(error => { throw new StateLeaseError('Die Datensperre muss eine eigene reguläre Datei außerhalb des Datenordners sein; symbolische Links sind nicht zulässig.', { cause: error }); });
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.uid !== process.getuid?.() || (opened.mode & 0o777) !== 0o600) {
      throw new StateLeaseError('Die Datensperre muss eine eigene reguläre Datei mit Dateirechten 0600 sein.');
    }
    await flock(handle.fd, canonicalRoot);
    const current = await lstat(lockPath);
    if (!current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino
      || await canonicalStateRoot(root) !== canonicalRoot) throw new StateLeaseError('Der Pfad der Datensperre wurde während der Übernahme verändert.');
    let release: Promise<void> | undefined;
    activeLeases.set(canonicalRoot, handle);
    return { root: canonicalRoot, release: () => {
      const blocked = leaseFailures.get(canonicalRoot);
      if (blocked && activeLeases.get(canonicalRoot) === handle) return Promise.reject(blocked);
      if (!release) {
        if (activeLeases.get(canonicalRoot) === handle) activeLeases.delete(canonicalRoot);
        release = handle.close();
      }
      return release;
    } };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

// The guard is a separate Node process so its lease and timeout survive API
// death. It buffers bounded output until the native writer has exited: a broken
// pipe back to a dead API can then never release the lock ahead of that writer.
// It also retains descriptor 3 if the native executable closes inherited FDs.
// The guard has its own process group. A timeout, signal, or normal child exit
// cleans up every live member before the guard can release descriptor 3.
const writerGuard = String.raw`
const { spawn } = require('node:child_process');
const { fstatSync, readFileSync, readdirSync } = require('node:fs');
const spec = JSON.parse(process.argv[1]);
fstatSync(3);
const selfPid = process.pid;
const stat = pid => {
  try {
    const raw = readFileSync('/proc/' + pid + '/stat', 'utf8');
    const closing = raw.lastIndexOf(')');
    if (closing < 0) throw new Error('Ein Prozessstatus konnte nicht sicher gelesen werden.');
    const fields = raw.slice(closing + 1).trim().split(/\s+/);
    const state = fields[0]; const pgrp = Number(fields[2]);
    if (!state || !Number.isSafeInteger(pgrp)) throw new Error('Eine Prozessgruppe konnte nicht sicher gelesen werden.');
    return { pid, state, pgrp };
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
};
const members = () => readdirSync('/proc').filter(entry => /^\d+$/.test(entry)).map(Number)
  .map(stat).filter(entry => entry && entry.pgrp === selfPid && !['Z', 'z'].includes(entry.state)).map(entry => entry.pid);
const waitForGroupCleanup = async () => {
  const own = stat(selfPid);
  if (!own || own.pgrp !== selfPid) throw new Error('Die isolierte Prozessgruppe des Importprozesses konnte nicht gesetzt werden.');
  let stopped = false;
  while (true) {
    const victims = members().filter(pid => pid !== selfPid);
    if (victims.length === 0) return stopped;
    stopped = true;
    for (const pid of victims) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const child = spawn(spec.file, spec.args, { stdio: ['ignore', 'pipe', 'pipe', 3], shell: false, detached: false });
const stdout = [], stderr = []; let bytes = 0, failure;
let finishPromise;
let childStarted = false;
let childExit;
let resolveExited;
const exited = new Promise(resolve => { resolveExited = resolve; });
const closed = new Promise(resolve => child.once('close', () => resolve()));
// Node's pipe descriptors may be nonblocking. Let streams handle partial
// writes/backpressure; writeSync can fail with EAGAIN on large valid output.
process.stdout.on('error', () => {}); process.stderr.on('error', () => {});
const writeOutput = (stream, data) => new Promise((resolve, reject) => {
  stream.write(data, error => {
    if (!error || error.code === 'EPIPE') resolve();
    else reject(error);
  });
});
const finish = message => finishPromise ??= (async () => {
  if (message) failure ??= message;
  if (message && childStarted && !childExit) { try { child.kill('SIGKILL'); } catch {} }
  if (childStarted && !childExit) await exited;
  let cleanupFailed = false;
  try { if (await waitForGroupCleanup()) failure ??= 'Der Importprozess hat noch laufende Nachkommen hinterlassen.'; }
  catch (error) {
    cleanupFailed = true;
    failure ??= error?.message || 'Die Nachkommen des Importprozesses konnten nicht beendet werden.';
  }
  if (cleanupFailed) {
    // Keep descriptor 3 open when group verification failed. Releasing it
    // here could let another API mutate state while an unobserved writer is
    // still alive. The parent can terminate this isolated guard if needed.
    setInterval(() => {}, 60_000);
    try { await writeOutput(process.stderr, Buffer.from(failure + '\n')); } catch { /* Keep the lease even if the diagnostic pipe failed. */ }
    return;
  }
  await closed;
  clearTimeout(timer);
  if (failure) { await writeOutput(process.stderr, Buffer.from(failure + '\n')); process.exitCode = 1; }
  else {
    await writeOutput(process.stdout, Buffer.concat(stdout)); await writeOutput(process.stderr, Buffer.concat(stderr));
    process.exitCode = childExit?.code === 0 && !childExit?.signal ? 0 : 1;
  }
})();
const timer = setTimeout(() => stop('Der Importprozess hat sein Zeitlimit überschritten.'), spec.timeout);
child.once('spawn', () => { childStarted = true; });
child.once('exit', (code, signal) => { childExit = { code, signal }; resolveExited(); void finish(); });
const capture = chunks => chunk => {
  if (failure) return;
  bytes += chunk.length;
  if (bytes > spec.maxBuffer) stop('Der Importprozess hat seine Ausgabegrenze überschritten.');
  else chunks.push(chunk);
};
child.stdout.on('data', capture(stdout)); child.stderr.on('data', capture(stderr));
const stop = message => { void finish(message); };
child.once('error', () => {
  failure ??= 'Das lokale Importprogramm konnte nicht gestartet werden.';
  void finish();
});
process.on('SIGTERM', () => stop('Der Importprozess wurde beendet.'));
process.on('SIGINT', () => stop('Der Importprozess wurde unterbrochen.'));
`;

/** Keep the state locked through native writer completion, even after API death. */
export async function execStateWriter(root: string, file: string, args: readonly string[],
  options: { timeout: number; maxBuffer?: number }): Promise<{ stdout: string; stderr: string }> {
  const maxBuffer = options.maxBuffer ?? 1024 * 1024;
  if (!Number.isSafeInteger(options.timeout) || options.timeout <= 0 || options.timeout > 300_000
    || !Number.isSafeInteger(maxBuffer) || maxBuffer <= 0 || maxBuffer > 16 * 1024 * 1024) {
    throw new StateLeaseError('Ungültige Ausführungsgrenzen für den Importprozess.');
  }
  const canonicalRoot = await canonicalStateRoot(root);
  const blocked = leaseFailures.get(canonicalRoot);
  if (blocked) throw blocked;
  let temporary: StateLease | undefined;
  if (!activeLeases.has(canonicalRoot)) temporary = await acquireStateLease(canonicalRoot);
  let releaseTemporary = false;
  try {
    const handle = activeLeases.get(canonicalRoot);
    if (!handle || handle.fd < 0) throw new StateLeaseError('Der Importprozess benötigt eine aktive Datensperre.');
    // No await between selecting the descriptor and spawn: release cannot
    // close/reuse it in this process before the child inherits its own reference.
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', writerGuard, JSON.stringify({ file, args, timeout: options.timeout, maxBuffer })], {
        stdio: ['ignore', 'pipe', 'pipe', handle.fd], shell: false, detached: true,
      });
      const stdout: Buffer[] = []; const stderr: Buffer[] = []; let bytes = 0;
      let failure: Error | undefined;
      const retainLeaseOnCleanupFailure = (error: unknown): StateLeaseError => {
        const retained = error instanceof StateLeaseError
          ? error
          : new StateLeaseError('Die Nachkommen des Importprozesses konnten nicht sicher beendet werden.', { cause: error });
        leaseFailures.set(canonicalRoot, retained);
        return retained;
      };
      const capture = (chunks: Buffer[]) => (chunk: Buffer) => {
        if (failure) return;
        bytes += chunk.length;
        if (bytes > maxBuffer + 1024) {
          failure = new StateLeaseError('Der Importprozess hat seine Ausgabegrenze überschritten.');
          child.kill('SIGTERM'); // Guard kills and waits for its writer before exiting.
        }
        else chunks.push(chunk);
      };
      child.stdout?.on('data', capture(stdout)); child.stderr?.on('data', capture(stderr));
      let settled = false;
      const settle = async (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        try {
          if (await cleanupGroup()) failure ??= new StateLeaseError('Der Importwächter hat noch laufende Schreibprozesse hinterlassen.');
          releaseTemporary = true;
          if (failure) reject(failure);
          else if (code !== 0) reject(new StateLeaseError(`Der Importprozess wurde nicht erfolgreich beendet (${signal ?? `Exit ${code}`}).`));
          else resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
        } catch (error) { reject(retainLeaseOnCleanupFailure(error)); }
      };
      child.once('error', error => { failure ??= error; });
      // `close` follows the guard's exit and closure of all stdio streams.
      // Waiting for it prevents a successful result from truncating buffered
      // bytes still waiting in the guard's output pipe.
      let groupCleanup: Promise<boolean> | undefined;
      const cleanupGroup = () => groupCleanup ??= child.pid ? killProcessGroup(child.pid) : Promise.resolve(false);
      child.once('exit', () => {
        // A SIGKILLed guard cannot run its own group cleanup. Kill its
        // descendants as soon as the exit is observed so inherited pipes do
        // not keep `close` (and the lock) open forever.
        void cleanupGroup().catch(error => { failure ??= retainLeaseOnCleanupFailure(error); });
      });
      child.once('close', (code, signal) => {
        void (async () => {
          await cleanupGroup();
          await settle(code, signal);
        })().catch(error => { reject(retainLeaseOnCleanupFailure(error)); });
      });
    });
  } finally {
    // A failed group verification/cleanup is fail-closed: releasing our OFD
    // while a writer may still live could let another API mutate the state.
    if (releaseTemporary) await temporary?.release();
  }
}
