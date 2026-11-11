import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { executeImportParser, EXECUTION_PROFILE, validateRows } from '../src/import-capability/isolated-executor.js';
import { parseCsvRowsStrict } from '../src/import-capability/csv-rows.js';

const escape = `const p = this.constructor.constructor('return process')();`;
const execFileAsync = promisify(execFile);

test('profile v1 reads input and records distinct execution receipts', async () => {
  const code = 'result = JSON.parse(content)';
  const input = JSON.stringify([{ id: '001', value: 42 }]);
  const first = await executeImportParser(code, input);
  const second = await executeImportParser(code, input);
  assert.deepEqual(first.rows, [{ id: '001', value: 42 }]);
  assert.equal(first.receipt.codeHash, second.receipt.codeHash);
  assert.equal(first.receipt.outputHash, second.receipt.outputHash);
  assert.notEqual(first.receipt.executionId, second.receipt.executionId);
  assert.equal(first.receipt.profile.id, 'linux-bwrap-systemd-v1');
});

test('VM escape still cannot read host files, write /usr, or inherit secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'koi-host-fixture-'));
  const marker = join(dir, 'marker.txt');
  await writeFile(marker, 'synthetic-host-marker');
  process.env.KOIFORGE_TEST_SECRET = 'synthetic-not-a-real-secret';
  try {
    const result = await executeImportParser(`${escape}
      const fs = p.getBuiltinModule('node:fs');
      let hostRead = false, systemWrite = false;
      try { fs.readFileSync(${JSON.stringify(marker)}, 'utf8'); hostRead = true; } catch {}
      try { fs.writeFileSync('/usr/koiforge-forbidden-probe', 'test'); systemWrite = true; } catch {}
      result = [{ hostRead, systemWrite, inherited: p.env.KOIFORGE_TEST_SECRET !== undefined }];`, '');
    assert.deepEqual(result.rows, [{ hostRead: false, systemWrite: false, inherited: false }]);
    const after = await executeImportParser('result = [{ alive: true }]', '');
    assert.equal(after.rows[0]?.alive, true);
  } finally {
    delete process.env.KOIFORGE_TEST_SECRET;
    await rm(dir, { recursive: true, force: true });
  }
});

test('network namespace prevents connecting to a host listener', async () => {
  let connections = 0;
  const server = createServer((socket) => { connections += 1; socket.end(); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  try {
    const probe = `require('node:net').connect(${address.port}, '127.0.0.1')
      .on('connect', () => process.exit(9)).on('error', () => process.exit(0));`;
    const result = await executeImportParser(`${escape}
      const child = p.getBuiltinModule('node:child_process').spawnSync('/runtime/node', ['-e', ${JSON.stringify(probe)}], { timeout: 1000 });
      result = [{ denied: child.status === 0 }];`, '');
    assert.equal(result.rows[0]?.denied, true);
    assert.equal(connections, 0);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('effective cgroup settings enforce the profile and admission is bounded', async () => {
  const code = 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100); result = [];';
  const first = executeImportParser(code, '');
  const second = executeImportParser(code, '');
  try {
    await assert.rejects(executeImportParser('result = []', ''), /capacity/);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const { stdout } = await execFileAsync('/usr/bin/systemctl', ['--user', 'list-units', '--plain', '--no-legend', 'koiforge-import-*.service']);
    const unit = stdout.match(/koiforge-import-[a-f0-9-]+\.service/)?.[0];
    assert(unit, 'The actual execution unit must exist during evaluation.');
    const { stdout: settings } = await execFileAsync('/usr/bin/systemctl', ['--user', 'show', unit,
      '-p', 'MemoryMax', '-p', 'MemorySwapMax', '-p', 'TasksMax', '-p', 'CPUQuotaPerSecUSec', '-p', 'RuntimeMaxUSec']);
    assert.match(settings, /^MemoryMax=268435456$/m);
    assert.match(settings, /^MemorySwapMax=0$/m);
    assert.match(settings, /^TasksMax=16$/m);
    assert.match(settings, /^CPUQuotaPerSecUSec=1s$/m);
    assert.match(settings, /^RuntimeMaxUSec=6s$/m);
  } finally { await Promise.all([first, second]); }
});

test('process budget prevents an unbounded child process tree', async () => {
  const result = await executeImportParser(`${escape}
    const cp = p.getBuiltinModule('node:child_process');
    const children = [];
    let failures = 0;
    for (let i = 0; i < 30; i++) {
      const child = cp.spawn('/usr/bin/sleep', ['3']);
      child.on('error', () => {});
      if (child.pid) children.push(child); else failures++;
    }
    for (const child of children) child.kill('SIGKILL');
    result = [{ launched: children.length, failures }];`, '');
  assert(Number(result.rows[0]?.launched) < 16);
  assert(Number(result.rows[0]?.failures) > 0);
});

test('infinite computation, memory excess and excess output fail without affecting next invocation', async () => {
  await assert.rejects(executeImportParser('while (true) {}', ''), /failed|budget/);
  await assert.rejects(executeImportParser(`${escape}
    const allocations = []; for (let i = 0; i < 1024; i++) allocations.push(p.getBuiltinModule('node:buffer').Buffer.alloc(1024 * 1024, 1));
    result = [];`, ''), /failed|budget/);
  await assert.rejects(executeImportParser(`result = [{ value: 'x'.repeat(${EXECUTION_PROFILE.maxOutputBytes + 1000}) }];`, ''), /output budget|failed/);
  assert.deepEqual((await executeImportParser('result = []', '')).rows, []);
});

test('input and row limits reject rather than truncate', async () => {
  await assert.rejects(executeImportParser('result = []', 'x'.repeat(EXECUTION_PROFILE.maxInputBytes + 1)), /not truncated/);
  assert.throws(() => validateRows(Array.from({ length: EXECUTION_PROFILE.maxRows + 1 }, () => ({ id: 1 }))), /no partial/);
  const rows = Array.from({ length: 10_001 }, (_, id) => ({ id }));
  const result = await executeImportParser('result = JSON.parse(content)', JSON.stringify(rows));
  assert.equal(result.rows.length, 10_001);
  assert.equal(result.rows.at(-1)?.id, 10_000);
});

test('invalid values and malformed CSV do not silently change the input', () => {
  assert.throws(() => validateRows([{ value: Infinity }]), /Invalid cell/);
  assert.throws(() => validateRows([{ value: { nested: true } }]), /Invalid cell/);
  assert.deepEqual(parseCsvRowsStrict('id,description\r\n001,"a\nline"\r\n002,"two ""quotes"""\r\n', ','),
    [{ id: '001', description: 'a\nline' }, { id: '002', description: 'two "quotes"' }]);
  assert.throws(() => parseCsvRowsStrict('id,id\n1,2', ','), /unique/);
  assert.throws(() => parseCsvRowsStrict('id,value\n1', ','), /field count/);
  assert.throws(() => parseCsvRowsStrict('id,value\n1,"unterminated', ','), /quoted field/);
});
