import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { BACKUP_LIMITS, createBackup, restoreBackup, verifyBackup, type BackupManifest } from '../src/operations/backup.js';
import { acquireStateLease } from '../src/operations/state-lease.js';

const execute = promisify(execFile);
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
async function fixture(t: TestContext) {
  const parent = await mkdtemp(join(tmpdir(), 'koi backup '));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'state'); const backup = join(parent, 'backup');
  await mkdir(join(root, 'nested', 'empty'), { recursive: true });
  await writeFile(join(root, 'auth.json'), '{"synthetic_secret":"never-print-this-value"}\n');
  await writeFile(join(root, '.hidden'), 'hidden data');
  await writeFile(join(root, 'nested', 'Grüße.txt'), 'Daten\n🌊\n');
  await writeFile(join(root, 'manifest.json'), 'a state file, not the backup manifest');
  await writeFile(join(root, 'zero'), '');
  return { parent, root, backup };
}
async function manifest(backup: string): Promise<BackupManifest> {
  return JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8')) as BackupManifest;
}
async function writeManifest(backup: string, value: unknown): Promise<void> {
  await writeFile(join(backup, 'manifest.json'), `${JSON.stringify(value, null, 2)}\n`);
}
async function noStages(parent: string) {
  assert.equal((await readdir(parent)).filter(name => name.startsWith('.koiforge-state-staging-')).length, 0);
}

test('complete offline backup and same-path restore preserve bytes, empty directories and restrictive permissions', async t => {
  const f = await fixture(t);
  await chmod(join(f.root, 'auth.json'), 0o644);
  const result = await createBackup({ root: f.root, output: f.backup });
  assert.equal(result.manifest.originalRoot, f.root);
  assert.equal(result.fileCount, 5); assert.equal(result.directoryCount, 2);
  assert.deepEqual(result.manifest.directories, ['nested', 'nested/empty']);
  assert.equal(result.manifest.files.find(file => file.path === '.hidden')!.sha256, digest('hidden data'));
  assert.equal((await lstat(f.backup)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(f.backup, 'manifest.json'))).mode & 0o777, 0o600);
  for (const file of result.manifest.files) {
    assert.deepEqual(await readFile(join(f.backup, 'data', file.path)), await readFile(join(f.root, file.path)));
    assert.equal((await lstat(join(f.backup, 'data', file.path))).mode & 0o777, 0o600);
  }
  for (const directory of ['data', 'data/nested', 'data/nested/empty']) assert.equal((await lstat(join(f.backup, directory))).mode & 0o777, 0o700);
  assert.equal((await lstat(join(f.root, 'auth.json'))).mode & 0o777, 0o644, 'source permissions stay unchanged');
  assert.deepEqual((await verifyBackup(f.backup)).manifest, result.manifest);
  const retained = join(f.parent, 'original-retained'); await rename(f.root, retained);
  await restoreBackup({ backup: f.backup, target: f.root });
  for (const file of result.manifest.files) assert.deepEqual(await readFile(join(f.root, file.path)), await readFile(join(retained, file.path)));
  assert.deepEqual(await readdir(join(f.root, 'nested', 'empty')), []);
  assert.equal((await lstat(f.root)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(f.root, 'auth.json'))).mode & 0o777, 0o600);
  await noStages(f.parent);
});

test('an entirely empty state directory roundtrips', async t => {
  const f = await fixture(t); const empty = join(f.parent, 'empty'); await mkdir(empty);
  const output = join(f.parent, 'empty-backup'); const result = await createBackup({ root: empty, output });
  assert.equal(result.totalBytes, 0); assert.equal(result.fileCount, 0);
  await rename(empty, join(f.parent, 'empty-retained'));
  await restoreBackup({ backup: output, target: empty }); assert.deepEqual(await readdir(empty), []);
});

test('backup rejects an internal or existing output without changing the source or output', async t => {
  const f = await fixture(t); const original = await readFile(join(f.root, 'auth.json'));
  await assert.rejects(createBackup({ root: f.root, output: join(f.root, 'child', 'backup') }), /außerhalb/);
  await assert.rejects(lstat(join(f.root, 'child')), { code: 'ENOENT' });
  await mkdir(f.backup); await writeFile(join(f.backup, 'keep'), 'untouched');
  await assert.rejects(createBackup({ root: f.root, output: f.backup }), /existiert/);
  assert.equal(await readFile(join(f.backup, 'keep'), 'utf8'), 'untouched');
  assert.deepEqual(await readFile(join(f.root, 'auth.json')), original); await noStages(f.parent);
});

test('backup and restore fail while the corresponding state lease is held', async t => {
  const f = await fixture(t);
  const lease = await acquireStateLease(f.root);
  try { await assert.rejects(createBackup({ root: f.root, output: f.backup })); } finally { await lease.release(); }
  await assert.rejects(lstat(f.backup), { code: 'ENOENT' });
  await createBackup({ root: f.root, output: f.backup }); await rename(f.root, join(f.parent, 'retained'));
  const restoreLease = await acquireStateLease(f.root);
  try { await assert.rejects(restoreBackup({ backup: f.backup, target: f.root })); } finally { await restoreLease.release(); }
  await assert.rejects(lstat(f.root), { code: 'ENOENT' }); await noStages(f.parent);
});

test('source symlinks and special files are rejected without following or silently excluding them', async t => {
  const f = await fixture(t); const outside = join(f.parent, 'external'); await writeFile(outside, 'external bytes');
  await symlink(outside, join(f.root, 'linked'));
  await assert.rejects(createBackup({ root: f.root, output: f.backup }));
  assert.equal(await readFile(outside, 'utf8'), 'external bytes'); await noStages(f.parent);
  await rm(join(f.root, 'linked')); await execute('/usr/bin/mkfifo', [join(f.root, 'pipe')]);
  await assert.rejects(createBackup({ root: f.root, output: f.backup }), /Spezialdateien/);
  await assert.rejects(lstat(f.backup), { code: 'ENOENT' }); await noStages(f.parent);
});

test('backup rejects dot segments before canonicalizing filesystem paths', async t => {
  const f = await fixture(t);
  const nested = join(f.parent, 'real', 'deep'); await mkdir(nested, { recursive: true });
  const alias = join(f.parent, 'alias'); await symlink(nested, alias);
  const ambiguous = `${alias}/../deep`;
  await assert.rejects(createBackup({ root: ambiguous, output: f.backup }), /Pfade mit \. oder \.\./);
  await assert.rejects(lstat(f.backup), { code: 'ENOENT' }); await noStages(f.parent);
});

test('backup rejects symlinked ancestors even when the final state directory is regular', async t => {
  const f = await fixture(t);
  const real = join(f.parent, 'real-state'); await rename(f.root, real);
  const alias = join(f.parent, 'state-alias'); await symlink(real, alias);
  await assert.rejects(createBackup({ root: `${alias}/nested`, output: f.backup }), /Symbolische Verknüpfungen/);
  await assert.rejects(lstat(f.backup), { code: 'ENOENT' }); await noStages(f.parent);
});

test('file and manifest byte bounds reject sparse oversized inputs before allocating their contents', async t => {
  const f = await fixture(t); const huge = join(f.root, 'huge'); await writeFile(huge, ''); await truncate(huge, BACKUP_LIMITS.bytes + 1);
  await assert.rejects(createBackup({ root: f.root, output: f.backup }), /Datenbegrenzung/); await noStages(f.parent);
  await rm(huge); await createBackup({ root: f.root, output: f.backup });
  await truncate(join(f.backup, 'manifest.json'), BACKUP_LIMITS.manifestBytes + 1);
  await assert.rejects(verifyBackup(f.backup), /zu groß/);
});

test('verification rejects mismatched bytes, missing entries, extra entries and changed kinds', async t => {
  const f = await fixture(t); await createBackup({ root: f.root, output: f.backup });
  const original = await readFile(join(f.backup, 'data', '.hidden'));
  await writeFile(join(f.backup, 'data', '.hidden'), 'hidden evil');
  await assert.rejects(verifyBackup(f.backup), /Hash/); await writeFile(join(f.backup, 'data', '.hidden'), original);
  await writeFile(join(f.backup, 'data', '.hidden'), 'wrong size');
  await assert.rejects(verifyBackup(f.backup), /Größe/); await writeFile(join(f.backup, 'data', '.hidden'), original);
  await rm(join(f.backup, 'data', 'zero')); await assert.rejects(verifyBackup(f.backup), /fehlen/); await writeFile(join(f.backup, 'data', 'zero'), '');
  await rm(join(f.backup, 'data', 'nested', 'empty'), { recursive: true }); await assert.rejects(verifyBackup(f.backup), /fehlen/);
  await mkdir(join(f.backup, 'data', 'nested', 'empty'));
  await writeFile(join(f.backup, 'data', 'extra'), 'extra'); await assert.rejects(verifyBackup(f.backup)); await rm(join(f.backup, 'data', 'extra'));
  await mkdir(join(f.backup, 'data', 'extra-dir')); await assert.rejects(verifyBackup(f.backup), /unerwartetes Verzeichnis/); await rm(join(f.backup, 'data', 'extra-dir'), { recursive: true });
  await writeFile(join(f.backup, 'extra-root'), 'extra'); await assert.rejects(verifyBackup(f.backup), /unerwartete Einträge/); await rm(join(f.backup, 'extra-root'));
  await rm(join(f.backup, 'data', 'zero')); await mkdir(join(f.backup, 'data', 'zero'));
  await assert.rejects(verifyBackup(f.backup));
});

test('strict manifests reject traversal, duplicates, collisions, absent parent directories and unknown fields', async t => {
  const f = await fixture(t); await createBackup({ root: f.root, output: f.backup }); const original = await manifest(f.backup);
  const mutations: Array<(value: BackupManifest) => unknown> = [
    value => { value.files[0]!.path = '../external'; return value; },
    value => { value.files[0]!.path = '/absolute'; return value; },
    value => { value.files[0]!.path = 'nested/../external'; return value; },
    value => { value.files[0]!.path = 'nested\\external'; return value; },
    value => { value.files.push({ ...value.files[0]! }); return value; },
    value => { value.directories.push(value.directories[0]!); return value; },
    value => { value.directories.push(value.files[0]!.path); return value; },
    value => { value.directories = value.directories.filter(path => path !== 'nested'); return value; },
    value => { value.files[0]!.size = -1; return value; },
    value => ({ ...value, version: 2 }),
    value => ({ ...value, unrecognized: true }),
    value => ({ ...value, originalRoot: 'relative/path' }),
  ];
  for (const change of mutations) { await writeManifest(f.backup, change(structuredClone(original))); await assert.rejects(verifyBackup(f.backup)); }
  await writeFile(join(f.backup, 'manifest.json'), JSON.stringify(original).replace('"version":1', '"version":1,"version":1'));
  await assert.rejects(verifyBackup(f.backup), /doppelte Felder/);
  await writeManifest(f.backup, { ...original, directories: Array(BACKUP_LIMITS.entries + 1).fill('a') });
  await assert.rejects(verifyBackup(f.backup), /Inventargrenze/);
});

test('verify and restore reject symlinked payloads and manifest files', async t => {
  const f = await fixture(t); await createBackup({ root: f.root, output: f.backup });
  await rm(join(f.backup, 'data', '.hidden')); await symlink(join(f.root, '.hidden'), join(f.backup, 'data', '.hidden'));
  await assert.rejects(verifyBackup(f.backup));
  await rm(join(f.backup, 'data', '.hidden')); await writeFile(join(f.backup, 'data', '.hidden'), 'hidden data');
  const original = join(f.parent, 'manifest-retained'); await rename(join(f.backup, 'manifest.json'), original); await symlink(original, join(f.backup, 'manifest.json'));
  await assert.rejects(verifyBackup(f.backup)); await assert.rejects(restoreBackup({ backup: f.backup, target: f.root }));
});

test('restore never relocates or replaces an existing directory, file or symlink', async t => {
  const f = await fixture(t); await createBackup({ root: f.root, output: f.backup });
  await assert.rejects(restoreBackup({ backup: f.backup, target: f.root }), /existiert/);
  await assert.rejects(restoreBackup({ backup: f.backup, target: join(f.parent, 'relocated') }), /ursprünglichen/);
  await assert.rejects(restoreBackup({ backup: f.backup, target: 'relative-target' }), /absoluten/);
  const retained = join(f.parent, 'retained'); await rename(f.root, retained); await writeFile(f.root, 'keep this file');
  await assert.rejects(restoreBackup({ backup: f.backup, target: f.root })); assert.equal(await readFile(f.root, 'utf8'), 'keep this file');
  await rm(f.root); await symlink(retained, f.root); await assert.rejects(restoreBackup({ backup: f.backup, target: f.root }));
  assert((await lstat(f.root)).isSymbolicLink()); await noStages(f.parent);
});

test('a corrupt backup cannot create a restore target or leave staging data behind', async t => {
  const f = await fixture(t); await createBackup({ root: f.root, output: f.backup });
  await rename(f.root, join(f.parent, 'retained')); await writeFile(join(f.backup, 'data', '.hidden'), 'broken');
  await assert.rejects(restoreBackup({ backup: f.backup, target: f.root }));
  await assert.rejects(lstat(f.root), { code: 'ENOENT' }); await noStages(f.parent);
});

test('the repository launcher handles paths as arguments and validates CLI flags without leaking contents', async t => {
  const f = await fixture(t); const output = join(f.parent, 'backup ; literal $(no-shell)');
  const result = await execute(process.execPath, ['scripts/state.mjs', 'backup', '--root', f.root, '--output', output], { cwd: repo });
  assert.match(result.stdout, /erstellt und verifiziert/); assert(!result.stdout.includes('never-print-this-value'));
  const verified = await execute(process.execPath, ['scripts/state.mjs', 'verify', '--backup', output], { cwd: repo });
  assert.match(verified.stdout, /keine Authentizität/);
  for (const args of [[], ['verify'], ['verify', '--backup', output, '--backup', output], ['backup', '--root', f.root, '--output', output, '--unknown', 'secret-marker']]) {
    await assert.rejects(execute(process.execPath, ['scripts/state.mjs', ...args], { cwd: repo }), error => {
      const result = error as Error & { code: number; stdout: string; stderr: string };
      assert.equal(result.code, 1); assert.match(result.stderr, /Aufruf:/); assert(!result.stderr.includes('secret-marker')); assert(!result.stdout.includes('never-print-this-value')); return true;
    });
  }
  assert.equal(resolve(output), output);
});
