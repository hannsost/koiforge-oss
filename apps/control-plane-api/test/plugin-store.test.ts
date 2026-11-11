import { deepStrictEqual, equal, match, notEqual, rejects } from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { createPluginStore } from '../src/import-capability/plugin-store.js';

interface TestPlugin {
  id: string;
  label: string;
  strategy: { type: string; options: Record<string, unknown> };
  unusedOptionalField?: undefined;
}

const temporaryRoots: string[] = [];

async function makeStore() {
  const root = await mkdtemp(join(tmpdir(), 'koiforge-plugin-store-'));
  temporaryRoots.push(root);
  return { root, store: createPluginStore<TestPlugin>(root) };
}

function plugin(label: string, id = 'generated_csv'): TestPlugin {
  return {
    id,
    label,
    strategy: { type: 'csv', options: { delimiter: ',', quote: '"' } },
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('generated plugin store', () => {
  it('uses stable canonical JSON and stores one immutable artifact per hash', async () => {
    const { root, store } = await makeStore();
    const first = await store.stage(plugin('CSV parser'));
    const second = await store.stage({
      strategy: { options: { quote: '"', delimiter: ',' }, type: 'csv' },
      label: 'CSV parser',
      id: 'generated_csv',
      // Optional fields absent from a definition are canonicalized like JSON.
      unusedOptionalField: undefined,
    });

    equal(first.hash, second.hash);
    deepStrictEqual(first.plugin, second.plugin);
    deepStrictEqual(await readdir(join(root, 'artifacts')), [`${first.hash}.json`]);
  });

  it('reads a staged version even when it is not active', async () => {
    const { store } = await makeStore();
    const staged = await store.stage(plugin('Staged but inactive'));

    deepStrictEqual(await store.read(staged.hash), staged.plugin);
  });

  it('switches active versions and rolls back while preserving both definitions', async () => {
    const { store } = await makeStore();
    const oldVersion = await store.stage(plugin('CSV parser v1'));
    const newVersion = await store.stage(plugin('CSV parser v2'));

    await store.activate('generated_csv', oldVersion.hash);
    await store.activate('generated_csv', newVersion.hash);
    deepStrictEqual(await store.listActive(), [{ hash: newVersion.hash, plugin: newVersion.plugin }]);
    deepStrictEqual(await store.read(oldVersion.hash), oldVersion.plugin);

    await store.rollback('generated_csv');
    deepStrictEqual(await store.listActive(), [{ hash: oldVersion.hash, plugin: oldVersion.plugin }]);

    // Rollback swaps the pointers, so a second rollback can restore the newer
    // version without rewriting either immutable artifact.
    await store.rollback('generated_csv');
    deepStrictEqual(await store.listActive(), [{ hash: newVersion.hash, plugin: newVersion.plugin }]);
    deepStrictEqual(await store.read(oldVersion.hash), oldVersion.plugin);
  });

  it('deactivates a first activation without deleting its immutable artifact', async () => {
    const { root, store } = await makeStore();
    const staged = await store.stage(plugin('First activation'));

    await store.activate(staged.plugin.id, staged.hash);
    await store.deactivate(staged.plugin.id, staged.hash);

    deepStrictEqual(await store.listActive(), []);
    deepStrictEqual(await store.read(staged.hash), staged.plugin);
    deepStrictEqual(await readdir(join(root, 'active')), []);
  });

  it('does not deactivate a current version when the expected hash is stale', async () => {
    const { store } = await makeStore();
    const oldVersion = await store.stage(plugin('Old version'));
    const currentVersion = await store.stage(plugin('Current version'));
    const unrelatedVersion = await store.stage(plugin('Unrelated version'));

    await store.activate(oldVersion.plugin.id, oldVersion.hash);
    await store.activate(currentVersion.plugin.id, currentVersion.hash);
    await rejects(
      store.deactivate(currentVersion.plugin.id, unrelatedVersion.hash),
      /has hash.*expected/i,
    );

    deepStrictEqual(await store.listActive(), [{ hash: currentVersion.hash, plugin: currentVersion.plugin }]);
    await store.rollback(currentVersion.plugin.id);
    deepStrictEqual(await store.listActive(), [{ hash: oldVersion.hash, plugin: oldVersion.plugin }]);
  });

  it('clears the old rollback pointer before a later first activation', async () => {
    const { store } = await makeStore();
    const oldVersion = await store.stage(plugin('Old version'));
    const currentVersion = await store.stage(plugin('Current version'));
    const laterVersion = await store.stage(plugin('Later first activation'));

    await store.activate(oldVersion.plugin.id, oldVersion.hash);
    await store.activate(currentVersion.plugin.id, currentVersion.hash);
    await store.deactivate(currentVersion.plugin.id, currentVersion.hash);
    await store.activate(laterVersion.plugin.id, laterVersion.hash);

    await rejects(store.rollback(laterVersion.plugin.id), /No previous pointer/i);
    deepStrictEqual(await store.listActive(), [{ hash: laterVersion.hash, plugin: laterVersion.plugin }]);
    deepStrictEqual(await store.read(oldVersion.hash), oldVersion.plugin);
  });

  it('validates candidates before activation and leaves the last good version active', async () => {
    const { store } = await makeStore();
    const good = await store.stage(plugin('Known good'));
    await store.activate(good.plugin.id, good.hash);

    await rejects(store.activate(good.plugin.id, 'a'.repeat(64)), /does not exist|artifact/i);
    await rejects(store.activate('../escape', good.hash), /Invalid plugin id/i);
    await rejects(store.activate(good.plugin.id, 'not-a-hash'), /Invalid plugin hash/i);

    deepStrictEqual(await store.listActive(), [{ hash: good.hash, plugin: good.plugin }]);
  });

  it('keeps usage telemetry in a sidecar without changing the artifact or hash', async () => {
    const { root, store } = await makeStore();
    const staged = await store.stage(plugin('Telemetry-safe'));
    const artifactPath = join(root, 'artifacts', `${staged.hash}.json`);
    const before = await readFile(artifactPath, 'utf8');

    await Promise.all(Array.from({ length: 32 }, () => store.recordUse(staged.plugin.id, staged.hash)));

    const after = await readFile(artifactPath, 'utf8');
    equal(after, before);
    equal((await store.stage(staged.plugin)).hash, staged.hash);
    const usage = JSON.parse(await readFile(join(root, 'usage', staged.plugin.id, `${staged.hash}.json`), 'utf8')) as {
      successCount: number;
      id: string;
      hash: string;
    };
    deepStrictEqual(usage, {
      id: staged.plugin.id,
      hash: staged.hash,
      successCount: 32,
      lastUsedAt: usage.lastUsedAt,
    });
    match(usage.lastUsedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('rejects traversal and malformed identifiers', async () => {
    const { store } = await makeStore();

    await rejects(store.stage({ ...plugin('unsafe'), id: '../escape' }), /Invalid plugin id/i);
    await rejects(store.stage({ ...plugin('unsafe'), id: 'nested/path' }), /Invalid plugin id/i);
    await rejects(store.stage({ ...plugin('unsafe'), id: '' }), /Invalid plugin id/i);
    await rejects(store.activate('nested/path', 'a'.repeat(64)), /Invalid plugin id/i);
    await rejects(store.recordUse('generated_csv', '../escape'), /Invalid plugin hash/i);
  });

  it('rejects invalid or corrupt historical artifact reads', async () => {
    const { root, store } = await makeStore();
    const staged = await store.stage(plugin('Historical integrity check'));

    await rejects(store.read('not-a-hash'), /Invalid plugin hash/i);
    await writeFile(
      join(root, 'artifacts', `${staged.hash}.json`),
      `${JSON.stringify({ ...staged.plugin, label: 'tampered' })}\n`,
      'utf8',
    );
    await rejects(store.read(staged.hash), /failed integrity check/i);
  });

  it('reports corrupt active pointers and referenced artifacts instead of skipping them', async () => {
    const { root, store } = await makeStore();
    const staged = await store.stage(plugin('Corruption check'));
    await store.activate(staged.plugin.id, staged.hash);

    await writeFile(join(root, 'active', `${staged.plugin.id}.json`), '{not-json\n', 'utf8');
    await rejects(store.listActive(), /Corrupt active pointer/i);

    await writeFile(
      join(root, 'active', `${staged.plugin.id}.json`),
      `${JSON.stringify({ id: staged.plugin.id, hash: staged.hash })}\n`,
      'utf8',
    );
    await writeFile(join(root, 'artifacts', `${staged.hash}.json`), `${JSON.stringify({ ...staged.plugin, label: 'tampered' })}\n`, 'utf8');
    await rejects(store.listActive(), /failed integrity check/i);
  });

  it('surfaces a corrupt active pointer during deactivation', async () => {
    const { root, store } = await makeStore();
    const staged = await store.stage(plugin('Deactivate corruption check'));
    await store.activate(staged.plugin.id, staged.hash);

    await writeFile(join(root, 'active', `${staged.plugin.id}.json`), '{not-json\n', 'utf8');
    await rejects(store.deactivate(staged.plugin.id, staged.hash), /Corrupt active pointer/i);
  });

  it('does not mutate a good active pointer when a candidate definition has the wrong id', async () => {
    const { store } = await makeStore();
    const good = await store.stage(plugin('Good', 'plugin_one'));
    const other = await store.stage(plugin('Other', 'plugin_two'));
    await store.activate(good.plugin.id, good.hash);

    await rejects(store.activate(good.plugin.id, other.hash), /belongs to 'plugin_two'/i);
    const active = await store.listActive();
    equal(active[0]?.hash, good.hash);
    notEqual(active[0]?.hash, other.hash);
  });
});
