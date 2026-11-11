import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { TABULAR_LIMITS, validateTabularRows } from '@koiforge/data-registry';

export type ImportCell = string | number | boolean | null;
export type ImportRow = Record<string, ImportCell>;

// Versioned, fail-closed Linux profile. These values are not model-controlled.
export const EXECUTION_PROFILE = Object.freeze({
  id: 'linux-bwrap-systemd-v1',
  memoryBytes: 256 * 1024 * 1024,
  swapBytes: 0,
  tasks: 16,
  cpuQuota: '100%',
  cpuSeconds: 2,
  wallSeconds: 6,
  maxInputBytes: TABULAR_LIMITS.maxInputBytes,
  maxCodeBytes: 64 * 1024,
  maxOutputBytes: TABULAR_LIMITS.maxOutputBytes,
  maxRows: TABULAR_LIMITS.maxRows,
  maxConcurrentExecutions: 2,
});

const execFileAsync = promisify(execFile);
const worker = String.raw`
const fs = require('node:fs');
const vm = require('node:vm');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const context = { content: input.content, result: undefined };
try {
  // VM is only an evaluation adapter. OS namespaces/cgroups are the boundary.
  vm.runInNewContext(input.code, context, { timeout: 1500 });
  if (!Array.isArray(context.result)) throw new Error('Parser must return an array in result.');
  process.stdout.write(JSON.stringify({ result: context.result }));
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : 'Parser failed.');
  process.exitCode = 1;
}
`;

export function validateRows(value: unknown): ImportRow[] {
  return validateTabularRows(value);
}

export function rowsHash(rows: ImportRow[]): string {
  return createHash('sha256').update(JSON.stringify(rows.map((row) =>
    Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))),
  ))).digest('hex');
}

export interface ExecutionReceipt {
  executionId: string;
  profile: typeof EXECUTION_PROFILE;
  codeHash: string;
  inputHash: string;
  outputHash: string;
  rows: number;
  startedAt: string;
  completedAt: string;
}

let activeExecutions = 0;

/** Admission is bounded too: one API process cannot launch unlimited sandbox units. */
export async function executeImportParser(code: string, content: string): Promise<{
  rows: ImportRow[];
  receipt: ExecutionReceipt;
}> {
  if (activeExecutions >= EXECUTION_PROFILE.maxConcurrentExecutions) {
    throw new Error('Isolated execution capacity reached; retry later.');
  }
  activeExecutions += 1;
  try { return await execute(code, content); }
  finally { activeExecutions -= 1; }
}

/** Fresh execution component for each invocation; never falls back to in-process code. */
async function execute(code: string, content: string): Promise<{ rows: ImportRow[]; receipt: ExecutionReceipt }> {
  if (process.platform !== 'linux') throw new Error('Generated code requires the Linux execution profile.');
  if (Buffer.byteLength(code) > EXECUTION_PROFILE.maxCodeBytes) throw new Error('Generated code exceeds profile limit.');
  if (Buffer.byteLength(content) > EXECUTION_PROFILE.maxInputBytes) {
    throw new Error('Source exceeds 10 MiB; source was not truncated or executed.');
  }
  const executionId = `koiforge-import-${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const args = [
    '--user', '--quiet', '--wait', '--pipe', '--collect', `--unit=${executionId}`,
    '-p', `MemoryMax=${EXECUTION_PROFILE.memoryBytes}`,
    '-p', `MemorySwapMax=${EXECUTION_PROFILE.swapBytes}`,
    '-p', `TasksMax=${EXECUTION_PROFILE.tasks}`,
    '-p', `CPUQuota=${EXECUTION_PROFILE.cpuQuota}`,
    '-p', `RuntimeMaxSec=${EXECUTION_PROFILE.wallSeconds}s`,
    '-p', `LimitCPU=${EXECUTION_PROFILE.cpuSeconds}`, '-p', 'LimitCORE=0',
    '-p', 'TimeoutStopSec=1s', '-p', 'KillMode=control-group',
    '--', '/usr/bin/bwrap',
    '--unshare-all', '--unshare-user', '--disable-userns', '--new-session',
    '--die-with-parent', '--cap-drop', 'ALL', '--clearenv',
    '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib', '/lib64',
    '--proc', '/proc', '--dev', '/dev',
    '--ro-bind', process.execPath, '/runtime/node', '--chdir', '/',
    '/runtime/node', '--jitless', '--max-old-space-size=96', '--input-type=commonjs', '-e', worker,
  ];
  const payload = JSON.stringify({ code, content });
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn('/usr/bin/systemd-run', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderrSize = 0;
    let failure: Error | undefined;
    const stop = (message: string) => {
      if (failure) return;
      failure = new Error(message);
      // Killing systemd-run alone would leave its unit alive.
      void execFileAsync('/usr/bin/systemctl', ['--user', 'stop', `${executionId}.service`],
        { timeout: 3000, maxBuffer: 4096 }).catch(() => undefined);
      child.kill('SIGKILL');
    };
    const timeout = setTimeout(() => stop('Isolated parser exceeded its wall-clock budget.'),
      (EXECUTION_PROFILE.wallSeconds + 3) * 1000);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > EXECUTION_PROFILE.maxOutputBytes) stop('Isolated parser exceeded its output budget.');
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // Never surface arbitrary generated-code output or data as an API error.
      stderrSize += chunk.length;
      if (stderrSize > 64 * 1024) stop('Isolated parser exceeded its diagnostic budget.');
    });
    child.stdin.on('error', () => { /* close/error below carries the execution failure */ });
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('close', (status, signal) => {
      clearTimeout(timeout);
      if (failure) reject(failure);
      else if (status !== 0) reject(new Error(`Isolated parser failed (${signal ?? status}); no result accepted.`));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.end(payload);
  });
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { throw new Error('Isolated parser returned invalid output.'); }
  if (!parsed || typeof parsed !== 'object' || !('result' in parsed)) {
    throw new Error('Isolated parser returned no result.');
  }
  const rows = validateRows(parsed.result);
  return {
    rows,
    receipt: {
      executionId, profile: EXECUTION_PROFILE,
      codeHash: createHash('sha256').update(code).digest('hex'),
      inputHash: createHash('sha256').update(content).digest('hex'),
      outputHash: rowsHash(rows), rows: rows.length,
      startedAt, completedAt: new Date().toISOString(),
    },
  };
}
