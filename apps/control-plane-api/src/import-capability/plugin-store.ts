import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * A generated plugin's definition is stored by content hash.  Runtime usage
 * information intentionally lives in a separate sidecar and is never written
 * back into the definition artifact.
 */
export interface PluginStore<T extends { id: string }> {
  stage(plugin: T): Promise<{ hash: string; plugin: T }>;
  read(hash: string): Promise<T>;
  activate(id: string, hash: string): Promise<void>;
  deactivate(id: string, expectedHash: string): Promise<void>;
  listActive(): Promise<Array<{ hash: string; plugin: T }>>;
  rollback(id: string): Promise<void>;
  recordUse(id: string, hash: string): Promise<void>;
}

interface Pointer {
  id: string;
  hash: string;
}

interface UsageRecord {
  id: string;
  hash: string;
  successCount: number;
  lastUsedAt: string;
}

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/;

// A queue shared by stores rooted at the same path also serializes calls when
// two parts of the API construct their own store facade for one root.
const rootQueues = new Map<string, Promise<void>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown, path = '$'): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error(`Plugin definition contains a non-finite number at ${path}.`);
      }
      return JSON.stringify(value);
    case 'undefined':
      throw new Error(`Plugin definition contains undefined at ${path}.`);
    case 'bigint':
    case 'function':
    case 'symbol':
      throw new Error(`Plugin definition contains unsupported ${typeof value} at ${path}.`);
    case 'object':
      if (Array.isArray(value)) {
        return `[${value
          .map((entry, index) => (entry === undefined ? 'null' : stableJson(entry, `${path}[${index}]`)))
          .join(',')}]`;
      }

      // JSON.stringify only serializes own enumerable properties.  Mirroring
      // that rule keeps the on-disk representation predictable for ordinary
      // definition objects while sorting keys makes insertion order irrelevant.
      const objectValue = value as Record<string, unknown>;
      const entries = Object.keys(objectValue)
        .sort()
        .filter((key) => objectValue[key] !== undefined)
        .map((key) => `${JSON.stringify(key)}:${stableJson(objectValue[key], `${path}.${key}`)}`);
      return `{${entries.join(',')}}`;
  }

  throw new Error(`Plugin definition contains an unsupported value at ${path}.`);
}

function hashDefinition(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function validateId(id: string, context = 'plugin id'): void {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error(`Invalid ${context}; expected 1-128 letters, numbers, dots, dashes, or underscores.`);
  }
}

function validateHash(hash: string, context = 'plugin hash'): void {
  if (typeof hash !== 'string' || !HASH_PATTERN.test(hash)) {
    throw new Error(`Invalid ${context}; expected a lowercase SHA-256 hex digest.`);
  }
}

function parseJson(text: string, context: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Corrupt ${context}: ${detail}`);
  }
}

function pointerJson(pointer: Pointer): string {
  return `${JSON.stringify(pointer)}\n`;
}

function usageJson(record: UsageRecord): string {
  return `${JSON.stringify(record)}\n`;
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${path.split('/').pop() ?? 'store'}.${randomUUID()}.tmp`);

  try {
    await writeFile(temporaryPath, contents, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function operationQueue(root: string): <T>(operation: () => Promise<T>) => Promise<T> {
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = rootQueues.get(root) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    let settled!: Promise<void>;
    settled = current.then(
      () => {
        if (rootQueues.get(root) === settled) rootQueues.delete(root);
      },
      () => {
        if (rootQueues.get(root) === settled) rootQueues.delete(root);
      },
    );
    rootQueues.set(root, settled);
    return current;
  };
}

/**
 * Creates a filesystem-backed generated-plugin store.
 *
 * The store layout is deliberately small and private to the supplied root:
 * `artifacts/<sha256>.json` contains immutable definitions,
 * `active/<id>.json` and `previous/<id>.json` contain atomic pointers, and
 * `usage/<id>/<sha256>.json` contains mutable use telemetry.
 */
export function createPluginStore<T extends { id: string }>(rootPath: string): PluginStore<T> {
  if (typeof rootPath !== 'string' || rootPath.trim().length === 0) {
    throw new Error('Plugin store root path must be a non-empty string.');
  }

  const root = resolve(rootPath);
  const enqueue = operationQueue(root);
  const artifactsRoot = join(root, 'artifacts');
  const activeRoot = join(root, 'active');
  const previousRoot = join(root, 'previous');
  const usageRoot = join(root, 'usage');

  const artifactPath = (hash: string): string => join(artifactsRoot, `${hash}.json`);
  const activePath = (id: string): string => join(activeRoot, `${id}.json`);
  const previousPath = (id: string): string => join(previousRoot, `${id}.json`);
  const usagePath = (id: string, hash: string): string => join(usageRoot, id, `${hash}.json`);

  async function readArtifact(hash: string, expectedId?: string): Promise<T> {
    validateHash(hash);

    let text: string;
    try {
      text = await readFile(artifactPath(hash), 'utf8');
    } catch (error) {
      if (isNotFound(error)) {
        throw new Error(`Plugin artifact '${hash}' does not exist.`);
      }
      throw new Error(`Unable to read plugin artifact '${hash}': ${error instanceof Error ? error.message : String(error)}`);
    }

    const parsed = parseJson(text, `plugin artifact '${hash}'`);
    if (!isRecord(parsed) || typeof parsed.id !== 'string') {
      throw new Error(`Corrupt plugin artifact '${hash}': definition has no valid id.`);
    }

    try {
      validateId(parsed.id);
    } catch (error) {
      throw new Error(`Corrupt plugin artifact '${hash}': ${error instanceof Error ? error.message : String(error)}`);
    }

    const canonical = stableJson(parsed);
    const actualHash = hashDefinition(canonical);
    if (actualHash !== hash) {
      throw new Error(`Plugin artifact '${hash}' failed integrity check (content hashes to '${actualHash}').`);
    }

    if (expectedId !== undefined && parsed.id !== expectedId) {
      throw new Error(`Plugin artifact '${hash}' belongs to '${parsed.id}', not '${expectedId}'.`);
    }

    return parsed as T;
  }

  async function readPointer(path: string, expectedId: string, kind: string): Promise<Pointer> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if (isNotFound(error)) {
        throw new Error(`No ${kind} pointer exists for plugin '${expectedId}'.`);
      }
      throw new Error(`Unable to read ${kind} pointer for plugin '${expectedId}': ${error instanceof Error ? error.message : String(error)}`);
    }

    const parsed = parseJson(text, `${kind} pointer for plugin '${expectedId}'`);
    if (!isRecord(parsed) || typeof parsed.id !== 'string' || typeof parsed.hash !== 'string') {
      throw new Error(`Corrupt ${kind} pointer for plugin '${expectedId}': expected { id, hash }.`);
    }

    validateId(parsed.id, `${kind} pointer id`);
    validateHash(parsed.hash, `${kind} pointer hash`);
    if (parsed.id !== expectedId) {
      throw new Error(`Corrupt ${kind} pointer for plugin '${expectedId}': pointer belongs to '${parsed.id}'.`);
    }

    return { id: parsed.id, hash: parsed.hash };
  }

  async function readOptionalPointer(path: string, expectedId: string, kind: string): Promise<Pointer | null> {
    try {
      return await readPointer(path, expectedId, kind);
    } catch (error) {
      if (error instanceof Error && error.message === `No ${kind} pointer exists for plugin '${expectedId}'.`) {
        return null;
      }
      throw error;
    }
  }

  async function writeActivePointer(id: string, pointer: Pointer): Promise<void> {
    await atomicWrite(activePath(id), pointerJson(pointer));
  }

  async function stage(plugin: T): Promise<{ hash: string; plugin: T }> {
    return enqueue(async () => {
      if (!isRecord(plugin) || typeof plugin.id !== 'string') {
        throw new Error('Cannot stage plugin: definition must be an object with a string id.');
      }
      validateId(plugin.id);

      const canonical = stableJson(plugin);
      const hash = hashDefinition(canonical);
      const path = artifactPath(hash);
      await mkdir(artifactsRoot, { recursive: true });

      try {
        const handle = await open(path, 'wx');
        try {
          await handle.writeFile(`${canonical}\n`, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (!isRecord(error) || error.code !== 'EEXIST') {
          throw new Error(`Unable to stage plugin '${plugin.id}': ${error instanceof Error ? error.message : String(error)}`);
        }

        // A matching hash is idempotent.  Never overwrite an existing
        // artifact: read it back and verify its content before accepting it.
        await readArtifact(hash, plugin.id);
      }

      const stored = await readArtifact(hash, plugin.id);
      return { hash, plugin: stored };
    });
  }

  async function activate(id: string, hash: string): Promise<void> {
    return enqueue(async () => {
      validateId(id);
      validateHash(hash);

      // Validate the candidate before touching either pointer.  This is what
      // keeps a failed activation from displacing the last known-good version.
      await readArtifact(hash, id);
      const current = await readOptionalPointer(activePath(id), id, 'active');

      if (current?.hash === hash) return;

      if (current) {
        await atomicWrite(previousPath(id), pointerJson(current));
      }

      try {
        await writeActivePointer(id, { id, hash });
      } catch (error) {
        // If recording the previous pointer succeeded but activation did not,
        // remove that transient state so rollback still refers to the old one.
        if (current) {
          await atomicWrite(previousPath(id), pointerJson(current)).catch(() => undefined);
        }
        throw error;
      }
    });
  }

  async function read(hash: string): Promise<T> {
    return enqueue(() => readArtifact(hash));
  }

  async function deactivate(id: string, expectedHash: string): Promise<void> {
    return enqueue(async () => {
      validateId(id);
      validateHash(expectedHash, 'expected plugin hash');

      // Validate the pointer before changing state. This prevents a delayed
      // cleanup from removing a newer activation that replaced the expected
      // candidate.
      const current = await readPointer(activePath(id), id, 'active');
      if (current.hash !== expectedHash) {
        throw new Error(`Active plugin '${id}' has hash '${current.hash}', expected '${expectedHash}'.`);
      }

      await unlink(activePath(id));
      try {
        await unlink(previousPath(id));
      } catch (error) {
        if (isNotFound(error)) return;

        // Keep the active pointer usable if clearing its rollback pointer
        // fails. The immutable artifact remains untouched in all cases.
        await writeActivePointer(id, current).catch(() => undefined);
        throw error;
      }
    });
  }

  async function listActive(): Promise<Array<{ hash: string; plugin: T }>> {
    return enqueue(async () => {
      let entries;
      try {
        entries = await readdir(activeRoot, { withFileTypes: true });
      } catch (error) {
        if (isNotFound(error)) return [];
        throw new Error(`Unable to list active plugins: ${error instanceof Error ? error.message : String(error)}`);
      }

      const active: Array<{ hash: string; plugin: T }> = [];
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) {
          throw new Error(`Corrupt active plugin store: unexpected entry '${entry.name}'.`);
        }

        const id = entry.name.slice(0, -'.json'.length);
        validateId(id, 'active plugin id');
        const pointer = await readPointer(activePath(id), id, 'active');
        const plugin = await readArtifact(pointer.hash, id);
        active.push({ hash: pointer.hash, plugin });
      }

      return active;
    });
  }

  async function rollback(id: string): Promise<void> {
    return enqueue(async () => {
      validateId(id);
      const current = await readPointer(activePath(id), id, 'active');
      const previous = await readPointer(previousPath(id), id, 'previous');
      await readArtifact(previous.hash, id);

      // Validate both pointers and the artifact before changing state.  If the
      // second write fails, restore the active pointer to keep the pair usable.
      await writeActivePointer(id, previous);
      try {
        await atomicWrite(previousPath(id), pointerJson(current));
      } catch (error) {
        await writeActivePointer(id, current).catch(() => undefined);
        throw error;
      }
    });
  }

  async function recordUse(id: string, hash: string): Promise<void> {
    return enqueue(async () => {
      validateId(id);
      validateHash(hash);
      await readArtifact(hash, id);

      let record: UsageRecord = {
        id,
        hash,
        successCount: 0,
        lastUsedAt: new Date(0).toISOString(),
      };

      try {
        const text = await readFile(usagePath(id, hash), 'utf8');
        const parsed = parseJson(text, `usage sidecar for plugin '${id}' at '${hash}'`);
        if (
          !isRecord(parsed) ||
          parsed.id !== id ||
          parsed.hash !== hash ||
          typeof parsed.successCount !== 'number' ||
          !Number.isSafeInteger(parsed.successCount) ||
          parsed.successCount < 0 ||
          typeof parsed.lastUsedAt !== 'string'
        ) {
          throw new Error(`Corrupt usage sidecar for plugin '${id}' at '${hash}'.`);
        }
        record = parsed as unknown as UsageRecord;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }

      record.successCount += 1;
      record.lastUsedAt = new Date().toISOString();
      await atomicWrite(usagePath(id, hash), usageJson(record));
    });
  }

  return { stage, read, activate, deactivate, listActive, rollback, recordUse };
}
