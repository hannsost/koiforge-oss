import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { acquireStateLease, canonicalStateRoot, execStateWriter, StateLeaseError } from '../src/operations/state-lease.js';

const execute = promisify(execFile);
const leaseUrl = new URL('../src/operations/state-lease.ts', import.meta.url).href;
const serverUrl = new URL('../src/server.ts', import.meta.url).href;
const cwd = new URL('../', import.meta.url);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function workspace(t: { after(fn: () => Promise<unknown>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'koi-lease-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, root: join(directory, 'state') };
}
function kill(pid: number | undefined) {
  if (!pid) return;
  try { process.kill(pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}
async function until<T>(read: () => Promise<T | undefined>, timeout = 8000): Promise<T> {
  const deadline = Date.now() + timeout;
  do { const value = await read(); if (value !== undefined) return value; await delay(30); } while (Date.now() < deadline);
  throw new Error('Timed out waiting for isolated fixture');
}
async function readyFile(path: string) {
  return until(async () => {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  });
}

test('leases are nonreentrant, survive the flock subprocess, and release idempotently without removing the sidecar', async t => {
  const { directory, root } = await workspace(t);
  const first = await acquireStateLease(root);
  assert.equal(first.root, root);
  await assert.rejects(lstat(root), { code: 'ENOENT' });
  await assert.rejects(acquireStateLease(root), StateLeaseError);
  const probe = `import {writeSync} from 'node:fs';import {acquireStateLease} from ${JSON.stringify(leaseUrl)};
    try {const l=await acquireStateLease(${JSON.stringify(root)});await l.release();process.exitCode=8;} catch {writeSync(1,'blocked\\n');}`;
  assert.match((await execute(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', probe], { cwd })).stdout, /blocked/);
  await first.release(); await first.release();
  const next = await acquireStateLease(root); await next.release();
  const lock = join(directory, `.koiforge-state-${createHash('sha256').update(root).digest('hex')}.lock`);
  assert.equal((await lstat(lock)).mode & 0o777, 0o600);
});

test('filesystem aliases including symlink followed by .. resolve to the same exclusive state', async t => {
  const { directory } = await workspace(t);
  const actual = join(directory, 'actual'); await mkdir(join(actual, 'child'), { recursive: true });
  await symlink(join(actual, 'child'), join(directory, 'alias'));
  const path = `${directory}/alias/../state`;
  assert.equal(await canonicalStateRoot(path), join(actual, 'state'));
  const lease = await acquireStateLease(path);
  try { await assert.rejects(acquireStateLease(join(actual, 'state')), StateLeaseError); }
  finally { await lease.release(); }
});

test('symlinked or incorrectly permissioned lock files fail closed', async t => {
  const { directory, root } = await workspace(t);
  const lock = join(directory, `.koiforge-state-${createHash('sha256').update(root).digest('hex')}.lock`);
  const target = join(directory, 'unrelated'); await writeFile(target, 'preserve', { mode: 0o600 });
  await symlink(target, lock);
  await assert.rejects(acquireStateLease(root), StateLeaseError);
  assert.equal(await readFile(target, 'utf8'), 'preserve');
  await rm(lock); await writeFile(lock, '', { mode: 0o600 }); await chmod(lock, 0o644);
  await assert.rejects(acquireStateLease(root), StateLeaseError);
});

test('kernel releases a crashed owner lease without deleting or repairing its persistent lock file', async t => {
  const { directory, root } = await workspace(t); const ready = join(directory, 'ready.json');
  const program = `import {writeFile} from 'node:fs/promises';import {acquireStateLease} from ${JSON.stringify(leaseUrl)};
    const l=await acquireStateLease(${JSON.stringify(root)});await writeFile(${JSON.stringify(ready)},'{}');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], { cwd, stdio: 'ignore' });
  t.after(async () => { kill(child.pid); });
  await readyFile(ready); await assert.rejects(acquireStateLease(root), StateLeaseError);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const lease = await acquireStateLease(root); await lease.release();
});

test('native writer guard retains the lease after API death even if the writer closes inherited descriptors', async t => {
  const { directory, root } = await workspace(t); await mkdir(root);
  const ready = join(directory, 'writer-ready.json'); const stop = join(directory, 'stop');
  const output = join(root, 'writes');
  const writer = `const fs=require('node:fs');fs.closeSync(3);
    fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,guard:process.ppid}));
    setInterval(()=>{if(fs.existsSync(${JSON.stringify(stop)}))process.exit(0);fs.appendFileSync(${JSON.stringify(output)},'.');},40);`;
  const program = `import {acquireStateLease,execStateWriter} from ${JSON.stringify(leaseUrl)};
    const l=await acquireStateLease(${JSON.stringify(root)});
    await execStateWriter(${JSON.stringify(root)},process.execPath,['-e',${JSON.stringify(writer)}],{timeout:10000});await l.release();`;
  const parent = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], { cwd, stdio: 'ignore' });
  let ids: { pid: number; guard: number } | undefined;
  t.after(async () => { kill(parent.pid); kill(ids?.pid); kill(ids?.guard); });
  ids = await readyFile(ready);
  await until(async () => { try { return (await lstat(output)).size > 0 ? true : undefined; } catch { return undefined; } });
  const exited = once(parent, 'exit'); parent.kill('SIGKILL'); await exited;
  await assert.rejects(acquireStateLease(root), StateLeaseError);
  const size = (await lstat(output)).size; await delay(100);
  assert((await lstat(output)).size > size, 'the orphan writer really continues writing while the API is dead');
  await writeFile(stop, '');
  const recovered = await until(async () => { try { return await acquireStateLease(root); } catch (error) { if (error instanceof StateLeaseError) return undefined; throw error; } });
  await recovered.release();
});

test('native writer success, failure, missing binary, output bounds and timeout all preserve lease ownership', async t => {
  const { root } = await workspace(t);
  const owned = await acquireStateLease(root);
  try {
    assert.equal((await execStateWriter(root, process.execPath, ['-e', "require('node:fs').writeSync(1,'ok')"], { timeout: 2000 })).stdout, 'ok');
    await assert.rejects(execStateWriter(root, process.execPath, ['-e', 'process.exit(9)'], { timeout: 2000 }));
    await assert.rejects(execStateWriter(root, '/nonexistent-koi-writer', [], { timeout: 2000 }));
    await assert.rejects(execStateWriter(root, process.execPath, ['-e', "process.stdout.write('x'.repeat(10000));setInterval(()=>{},1000)"], { timeout: 2000, maxBuffer: 1000 }));
    await assert.rejects(execStateWriter(root, process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 150 }));
    await assert.rejects(acquireStateLease(root), StateLeaseError);
  } finally { await owned.release(); }
  assert.equal((await execStateWriter(root, process.execPath, ['-e', "require('node:fs').writeSync(1,'standalone')"], { timeout: 2000 })).stdout, 'standalone');
  const next = await acquireStateLease(root); await next.release();
});

test('server startup failure releases leases; failed second writer cannot release the running server lease', async t => {
  const { root } = await workspace(t);
  const program = `
    import assert from 'node:assert/strict';import {writeSync} from 'node:fs';
    import {buildServer} from ${JSON.stringify(serverUrl)};
    import {acquireStateLease} from ${JSON.stringify(leaseUrl)};
    const root=process.env.KOIFORGE_STATE_ROOT;
    process.env.KOIFORGE_PUBLIC_ORIGIN='invalid'; await assert.rejects(buildServer());
    const first=await acquireStateLease(root);await first.release();
    process.env.KOIFORGE_PUBLIC_ORIGIN='http://127.0.0.1:5173';
    const app=await buildServer();await app.ready();
    try {await assert.rejects(buildServer());await assert.rejects(acquireStateLease(root));}finally{await app.close();}
    const second=await acquireStateLease(root);await second.release();writeSync(1,'lifecycle-passed\\n');`;
  const result = await execute(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], {
    cwd, env: { ...process.env, NODE_ENV: 'test', KOIFORGE_STATE_ROOT: root, KOIFORGE_IMPORT_DATA_ROOT: root, KOIFORGE_GENERATION_DISABLED: '1' }, timeout: 20_000,
  });
  assert.match(result.stdout, /lifecycle-passed/);
});

async function isLive(pid: number): Promise<boolean> {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
    return !['Z', 'z', 'X', 'x'].includes(raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\s+/)[0]!);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

for (const owned of [false, true]) test(`guardian SIGKILL stops a descriptor-closing writer before ${owned ? 'API-owned' : 'temporary'} lease release`, { timeout: 15000 }, async t => {
  const { directory, root } = await workspace(t); await mkdir(root);
  const ready = join(directory, 'guardian-killed.json'); const output = join(directory, 'guardian-killed.out');
  const writer = `const fs=require('node:fs');fs.closeSync(3);fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,guard:process.ppid}));setInterval(()=>fs.appendFileSync(${JSON.stringify(output)},'.'),30);`;
  const lease = owned ? await acquireStateLease(root) : undefined;
  let ids: { pid: number; guard: number } | undefined;
  t.after(async () => { kill(ids?.pid); kill(ids?.guard); await lease?.release(); });
  const pending = execStateWriter(root, process.execPath, ['-e', writer], { timeout: 10000 });
  const rejected = assert.rejects(pending, StateLeaseError);
  ids = await readyFile(ready);
  await until(async () => {
    try { return (await readFile(output)).length > 0 ? true : undefined; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  });
  await assert.rejects(acquireStateLease(root), StateLeaseError);
  assert(ids.guard > 1 && ids.guard !== process.pid);
  kill(ids.guard);
  await rejected;
  assert.equal(await isLive(ids.pid), false, 'writer must be dead when the import promise rejects');
  const stoppedOutput = await readFile(output);
  if (lease) { await assert.rejects(acquireStateLease(root), StateLeaseError); await lease.release(); }
  const recovered = await acquireStateLease(root);
  await delay(100);
  assert((await readFile(output)).equals(stoppedOutput), 'old writer must not mutate the new owner state');
  await recovered.release();
});

test('timeout kills a writer descendant that keeps stdout, stderr, and descriptor 3 open', { timeout: 15000 }, async t => {
  const { directory, root } = await workspace(t); const ready = join(directory, 'descendant-ready');
  const descendant = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`;
  const writer = `const {spawn}=require('node:child_process');spawn(${JSON.stringify(process.execPath)},['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit',3]});setInterval(()=>{},1000);`;
  const pending = execStateWriter(root, process.execPath, ['-e', writer], { timeout: 1500 });
  const rejected = assert.rejects(pending, StateLeaseError);
  const descendantPid = Number(await readFile(ready, 'utf8').catch(async () => await until(async () => {
    try { return await readFile(ready, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  })));
  t.after(() => kill(descendantPid));
  await rejected;
  assert.equal(await isLive(descendantPid), false, 'timeout must settle only after the descendant stops');
  const recovered = await acquireStateLease(root); await recovered.release();
});

test('successful direct exit with a live descendant is rejected after stopping that descendant', { timeout: 15000 }, async t => {
  const { directory, root } = await workspace(t); const ready = join(directory, 'leftover-ready');
  const descendant = `const fs=require('node:fs');fs.closeSync(3);fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`;
  const writer = `const {spawn}=require('node:child_process');const fs=require('node:fs');spawn(${JSON.stringify(process.execPath)},['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit',3]});const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(timer);process.exit(0);}},20);`;
  await assert.rejects(execStateWriter(root, process.execPath, ['-e', writer], { timeout: 5000 }), StateLeaseError);
  const descendantPid = Number(await readFile(ready, 'utf8'));
  t.after(() => kill(descendantPid));
  assert.equal(await isLive(descendantPid), false);
  const recovered = await acquireStateLease(root); await recovered.release();
});

test('returns complete larger stdout and stderr after the writer and all pipes close', async t => {
  const { root } = await workspace(t); const size = 512 * 1024;
  const writer = `process.stdout.write(Buffer.alloc(${size},65));process.stderr.write(Buffer.alloc(${size},66));`;
  const result = await execStateWriter(root, process.execPath, ['-e', writer], { timeout: 5000, maxBuffer: size * 2 + 1024 });
  assert.equal(result.stdout.length, size); assert.equal(result.stderr.length, size);
  assert.equal(result.stdout, 'A'.repeat(size)); assert.equal(result.stderr, 'B'.repeat(size));
});
