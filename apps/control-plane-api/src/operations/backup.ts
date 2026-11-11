import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, opendir, realpath, rm, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acquireStateLease } from './state-lease.js';

const execute = promisify(execFile);
export const BACKUP_LIMITS = Object.freeze({ entries: 100_000, bytes: 20 * 1024 ** 3, manifestBytes: 16 * 1024 ** 2, pathBytes: 4096, depth: 128 });
export interface BackupManifest {
  version: 1;
  originalRoot: string;
  createdAt: string;
  directories: string[];
  files: Array<{ path: string; size: number; sha256: string }>;
}
export interface VerifiedBackup {
  backup: string;
  manifest: BackupManifest;
  fileCount: number;
  directoryCount: number;
  totalBytes: number;
}
export class BackupError extends Error {}
function fail(message: string): never { throw new BackupError(message); }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const inside = (parent: string, child: string) => { const path = relative(parent, child); return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)); };

function checkPath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !path || Buffer.byteLength(path) > BACKUP_LIMITS.pathBytes
    || /[\\\x00-\x1f\x7f]/.test(path) || /^[A-Za-z]:/.test(path) || posix.isAbsolute(path)
    || posix.normalize(path) !== path || path.split('/').some(part => !part || part === '.' || part === '..')
    || path.split('/').length > BACKUP_LIMITS.depth) fail('Ungültiger relativer Pfad in der Sicherung.');
}
async function absent(path: string): Promise<void> {
  try { await lstat(path); } catch (error) { if (missing(error)) return; throw error; }
  fail('Das Ziel existiert bereits und wird nicht ersetzt.');
}
async function directory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('Es sind ausschließlich normale Verzeichnisse und Dateien zulässig.');
}
async function canonicalCandidate(path: string): Promise<string> {
  if (typeof path !== 'string' || !path.trim() || path.includes('\0')) fail('Ein gültiger Pfad ist erforderlich.');
  // Keep filesystem semantics visible until the existing prefix has been
  // resolved.  In particular, resolve(path) would turn a symlink/.. path into
  // a different pathname before the kernel gets to resolve the symlink.
  const absolute = isAbsolute(path) ? path : `${process.cwd()}/${path}`;
  if (absolute.split('/').some(part => part === '.' || part === '..')) {
    fail('Pfade mit . oder .. sind für Sicherungspfade nicht zulässig.');
  }
  // Reject symlinks in any existing ancestor, not only when the final entry is
  // itself a symlink.  This keeps the path we validate identical to the path
  // whose lease is acquired later.
  let inspected = '/';
  const parts = absolute.split('/').filter(Boolean);
  for (const [index, part] of parts.entries()) {
    const next = join(inspected, part);
    try {
      const info = await lstat(next);
      if (info.isSymbolicLink()) fail('Symbolische Verknüpfungen sind für Sicherungspfade nicht zulässig.');
      if (index < parts.length - 1 && !info.isDirectory()) fail('Das Ziel benötigt ein Verzeichnis als Elternpfad.');
      inspected = next;
    } catch (error) {
      if (missing(error)) break;
      throw error;
    }
  }
  const suffix: string[] = [];
  let cursor = absolute;
  for (;;) {
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) fail('Symbolische Verknüpfungen sind für Sicherungspfade nicht zulässig.');
      const canonical = await realpath(cursor);
      if (suffix.length && !info.isDirectory()) fail('Das Ziel benötigt ein Verzeichnis als Elternpfad.');
      return join(canonical, ...suffix.reverse());
    } catch (error) {
      if (!missing(error)) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(basename(cursor)); cursor = parent;
    }
  }
}

// JSON.parse checks syntax; this bounded second pass also rejects repeated JSON keys.
function rejectDuplicateKeys(raw: string): void {
  let cursor = 0;
  const whitespace = () => { while (/\s/.test(raw[cursor] ?? '') && cursor < raw.length) cursor++; };
  const string = () => {
    const start = cursor++;
    while (cursor < raw.length) {
      if (raw[cursor] === '\\') { cursor += 2; continue; }
      if (raw[cursor++] === '"') return JSON.parse(raw.slice(start, cursor)) as string;
    }
    return fail('Ungültiges Sicherungsmanifest.');
  };
  const value = (depth: number): void => {
    if (depth > 8) fail('Das Sicherungsmanifest ist zu tief verschachtelt.');
    whitespace();
    if (raw[cursor] === '"') { string(); return; }
    if (raw[cursor] === '{') {
      cursor++; whitespace(); const keys = new Set<string>();
      if (raw[cursor] === '}') { cursor++; return; }
      for (;;) {
        whitespace(); const key = string();
        if (keys.has(key)) fail('Das Sicherungsmanifest enthält doppelte Felder.');
        keys.add(key); whitespace(); cursor++; value(depth + 1); whitespace();
        if (raw[cursor++] === '}') return;
      }
    }
    if (raw[cursor] === '[') {
      cursor++; whitespace(); if (raw[cursor] === ']') { cursor++; return; }
      for (;;) { value(depth + 1); whitespace(); if (raw[cursor++] === ']') return; }
    }
    while (cursor < raw.length && !/[\s,}\]]/.test(raw[cursor]!)) cursor++;
  };
  value(0);
}
function parseManifest(raw: string): BackupManifest {
  if (Buffer.byteLength(raw) > BACKUP_LIMITS.manifestBytes) fail('Das Sicherungsmanifest überschreitet die Größenbegrenzung.');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return fail('Ungültiges Sicherungsmanifest.'); }
  rejectDuplicateKeys(raw);
  if (!record(value) || !exactKeys(value, ['version', 'originalRoot', 'createdAt', 'directories', 'files'])
    || value.version !== 1 || typeof value.originalRoot !== 'string' || !isAbsolute(value.originalRoot)
    || resolve(value.originalRoot) !== value.originalRoot || value.originalRoot.includes('\0')
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || new Date(value.createdAt).toISOString() !== value.createdAt || !Array.isArray(value.files) || !Array.isArray(value.directories)
    || value.files.length + value.directories.length > BACKUP_LIMITS.entries) fail('Ungültiger Sicherungsvertrag oder überschrittene Inventargrenze.');
  const paths = new Set<string>(); const directories = new Set<string>(); let bytes = 0;
  for (const path of value.directories) {
    checkPath(path); if (paths.has(path)) fail('Die Sicherung enthält doppelte oder kollidierende Pfade.');
    paths.add(path); directories.add(path);
  }
  for (const file of value.files) {
    if (!record(file) || !exactKeys(file, ['path', 'size', 'sha256']) || !Number.isSafeInteger(file.size)
      || (file.size as number) < 0 || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) fail('Ungültiger Dateibeleg in der Sicherung.');
    checkPath(file.path); if (paths.has(file.path)) fail('Die Sicherung enthält doppelte oder kollidierende Pfade.');
    paths.add(file.path); bytes += file.size as number;
    if (!Number.isSafeInteger(bytes) || bytes > BACKUP_LIMITS.bytes) fail('Die Sicherung überschreitet die Datenbegrenzung.');
  }
  for (const path of paths) {
    const parent = posix.dirname(path);
    if (parent !== '.' && !directories.has(parent)) fail('Im Manifest fehlt ein Elternverzeichnis oder ein Pfad kollidiert mit einer Datei.');
  }
  return value as unknown as BackupManifest;
}

type FileStamp = Awaited<ReturnType<FileHandle['stat']>>;
const sameFile = (a: FileStamp, b: FileStamp) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
async function fileDigest(path: string, expectedSize: number, destination?: string): Promise<string> {
  const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output: FileHandle | undefined;
  try {
    const before = await source.stat();
    if (!before.isFile() || before.size !== expectedSize) fail('Eine Datei wurde verändert oder ist keine normale Datei.');
    if (destination) output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const hash = createHash('sha256'); const buffer = Buffer.allocUnsafe(256 * 1024); let total = 0;
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > expectedSize || total > BACKUP_LIMITS.bytes) fail('Eine Datei wurde während der Sicherung verändert oder ist zu groß.');
      const chunk = buffer.subarray(0, bytesRead); hash.update(chunk);
      if (output) {
        let written = 0;
        while (written < bytesRead) {
          const result = await output.write(chunk, written, bytesRead - written, null);
          if (!result.bytesWritten) fail('Eine Sicherungsdatei konnte nicht vollständig geschrieben werden.');
          written += result.bytesWritten;
        }
      }
    }
    if (total !== expectedSize || !sameFile(before, await source.stat())) fail('Eine Datei wurde während der Sicherung verändert.');
    if (output) { await output.chmod(0o600); await output.sync(); }
    return hash.digest('hex');
  } finally { await output?.close(); await source.close(); }
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function inventory(root: string, consume: (path: string, kind: 'directory' | 'file', size: number) => Promise<void>): Promise<void> {
  await directory(root); let entries = 0; let bytes = 0;
  const visit = async (folder: string) => {
    const absolute = folder ? join(root, ...folder.split('/')) : root;
    await directory(absolute);
    const handle = await opendir(absolute);
    for await (const item of handle) {
      const path = folder ? `${folder}/${item.name}` : item.name; checkPath(path);
      if (++entries > BACKUP_LIMITS.entries) fail('Die Sicherung überschreitet die Inventargrenze.');
      const info = await lstat(join(root, ...path.split('/')));
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) fail('Symbolische Verknüpfungen und Spezialdateien werden nicht gesichert.');
      if (info.isDirectory()) { await consume(path, 'directory', 0); await visit(path); }
      else {
        if (!Number.isSafeInteger(info.size) || info.size < 0 || (bytes += info.size) > BACKUP_LIMITS.bytes) fail('Die Sicherung überschreitet die Datenbegrenzung.');
        await consume(path, 'file', info.size);
      }
    }
  };
  await visit('');
}
async function verifyData(root: string, manifest: BackupManifest): Promise<void> {
  const files = new Map(manifest.files.map(file => [file.path, file]));
  const directories = new Set(manifest.directories);
  await inventory(root, async (path, kind, size) => {
    if (kind === 'directory') {
      if (!directories.delete(path)) fail('Die Sicherung enthält ein unerwartetes Verzeichnis.');
    } else {
      const expected = files.get(path);
      if (!expected) fail('Eine Sicherungsdatei fehlt im Manifest oder besitzt eine falsche Größe.');
      if (expected.size !== size) fail('Eine Sicherungsdatei fehlt im Manifest oder besitzt eine falsche Größe.');
      if (await fileDigest(join(root, ...path.split('/')), size) !== expected.sha256) fail('Der Datei-Hash stimmt nicht mit dem Sicherungsmanifest überein.');
      files.delete(path);
    }
  });
  if (files.size || directories.size) fail('Im Sicherungsverzeichnis fehlen Dateien oder Verzeichnisse.');
}
async function loadManifest(backup: string): Promise<BackupManifest> {
  await directory(backup);
  const expected = new Set(['manifest.json', 'data']);
  for await (const item of await opendir(backup)) if (!expected.delete(item.name)) fail('Das Sicherungsverzeichnis enthält unerwartete Einträge.');
  if (expected.size) fail('Das Sicherungsverzeichnis ist unvollständig.');
  const handle = await open(join(backup, 'manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > BACKUP_LIMITS.manifestBytes) fail('Das Sicherungsmanifest ist keine normale Datei oder zu groß.');
    // Fixed-size read prevents an external writer from growing this bounded input into an unbounded readFile.
    const bytes = Buffer.alloc(info.size + 1); let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length !== info.size || !sameFile(info, await handle.stat())) fail('Das Sicherungsmanifest wurde beim Lesen verändert.');
    const raw = bytes.subarray(0, length).toString('utf8');
    if (!Buffer.from(raw, 'utf8').equals(bytes.subarray(0, length))) fail('Das Sicherungsmanifest enthält ungültiges UTF-8.');
    return parseManifest(raw);
  } finally { await handle.close(); }
}
export async function verifyBackup(path: string): Promise<VerifiedBackup> {
  const backup = await canonicalCandidate(path); await directory(backup);
  const manifest = await loadManifest(backup);
  await verifyData(join(backup, 'data'), manifest);
  return { backup, manifest, fileCount: manifest.files.length, directoryCount: manifest.directories.length,
    totalBytes: manifest.files.reduce((total, file) => total + file.size, 0) };
}
async function staging(target: string): Promise<string> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const path = await mkdtemp(join(dirname(target), '.koiforge-state-staging-')); await chmod(path, 0o700); return path;
}
async function publish(stage: string, target: string): Promise<void> {
  await absent(target); await syncDirectory(stage);
  // Linux/GNU mv uses a no-replace rename. Plain fs.rename could replace a newly created empty target.
  // No shell, no cross-filesystem copy fallback, no deletion of an existing destination.
  try { await execute('/usr/bin/mv', ['--no-copy', '--no-clobber', '-T', '--', stage, target], { timeout: 30_000, maxBuffer: 4096 }); }
  catch { fail('Die Sicherung konnte nicht atomar und ohne Überschreiben veröffentlicht werden.'); }
  try { await lstat(stage); } catch (error) { if (missing(error)) { await syncDirectory(dirname(target)); return; } throw error; }
  fail('Das Ziel wurde inzwischen angelegt und wird nicht ersetzt.');
}

export async function createBackup(input: { root: string; output: string }): Promise<VerifiedBackup> {
  const source = await canonicalCandidate(input.root); await directory(source);
  const output = await canonicalCandidate(input.output);
  if (inside(source, output)) fail('Die Sicherung muss außerhalb des ursprünglichen State-Verzeichnisses liegen.');
  await absent(output);
  const lease = await acquireStateLease(source); let stage: string | undefined;
  try {
    if (lease.root !== source) fail('Der State-Pfad wurde vor der Sicherung verändert.');
    await directory(source); await absent(output); stage = await staging(output);
    const data = join(stage, 'data'); await mkdir(data, { mode: 0o700 });
    const manifest: BackupManifest = { version: 1, originalRoot: source, createdAt: new Date().toISOString(), directories: [], files: [] };
    await inventory(source, async (path, kind, size) => {
      const destination = join(data, ...path.split('/'));
      if (kind === 'directory') { manifest.directories.push(path); await mkdir(destination, { mode: 0o700 }); }
      else manifest.files.push({ path, size, sha256: await fileDigest(join(source, ...path.split('/')), size, destination) });
    });
    manifest.directories.sort(); manifest.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const raw = `${JSON.stringify(manifest, null, 2)}\n`; parseManifest(raw);
    const file = await open(join(stage, 'manifest.json'), 'wx', 0o600);
    try { await file.writeFile(raw); await file.chmod(0o600); await file.sync(); } finally { await file.close(); }
    for (const folder of [...manifest.directories].sort((a, b) => b.split('/').length - a.split('/').length)) await syncDirectory(join(data, ...folder.split('/')));
    await syncDirectory(data);
    const verified = await verifyBackup(stage);
    // The lease excludes cooperating writers; a second complete read also detects accidental outside changes.
    await verifyData(source, manifest);
    await publish(stage, output); stage = undefined;
    return { ...verified, backup: output };
  } finally { try { if (stage) await rm(stage, { recursive: true, force: true }); } finally { await lease.release(); } }
}
export async function restoreBackup(input: { backup: string; target: string }): Promise<VerifiedBackup> {
  const verified = await verifyBackup(input.backup);
  if (!isAbsolute(input.target)) fail('Die Wiederherstellung benötigt den ursprünglichen absoluten State-Pfad.');
  const target = await canonicalCandidate(input.target);
  if (target !== verified.manifest.originalRoot || resolve(input.target) !== verified.manifest.originalRoot) fail('Wiederherstellung ist ausschließlich am ursprünglichen absoluten State-Pfad möglich.');
  await absent(target);
  const lease = await acquireStateLease(target); let stage: string | undefined;
  try {
    if (lease.root !== target) fail('Der Zielpfad wurde vor der Wiederherstellung verändert.');
    await absent(target); stage = await staging(target);
    const manifest = verified.manifest;
    for (const folder of [...manifest.directories].sort((a, b) => a.split('/').length - b.split('/').length)) await mkdir(join(stage, ...folder.split('/')), { mode: 0o700 });
    for (const file of manifest.files) {
      const actual = await fileDigest(join(verified.backup, 'data', ...file.path.split('/')), file.size, join(stage, ...file.path.split('/')));
      if (actual !== file.sha256) fail('Eine Sicherungsdatei wurde vor der Wiederherstellung verändert.');
    }
    await verifyData(stage, manifest);
    // Recheck the exact backup inventory and manifest after copying; additions or replacements must not be ignored.
    const repeated = await verifyBackup(verified.backup);
    if (JSON.stringify(repeated.manifest) !== JSON.stringify(manifest)) fail('Das Sicherungsmanifest wurde vor der Veröffentlichung verändert.');
    for (const folder of [...manifest.directories].sort((a, b) => b.split('/').length - a.split('/').length)) await syncDirectory(join(stage, ...folder.split('/')));
    await publish(stage, target); stage = undefined;
    return { ...verified, backup: verified.backup };
  } finally { try { if (stage) await rm(stage, { recursive: true, force: true }); } finally { await lease.release(); } }
}
