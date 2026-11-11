import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const serverUrl = new URL('../src/server.ts', import.meta.url).href;
const importRouteUrl = new URL('../src/routes/import-sessions.ts', import.meta.url).href;

test('changing the configured import root after module load fails before creating state or leases', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'koi-backup-root-review-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const captured = join(directory, 'captured');
  const changed = join(directory, 'changed');
  // A fresh process recreates the reachable embedding scenario: import the
  // application, then configure a different root before buildServer(). Neither
  // root nor a lock sidecar may be published for a rejected configuration.
  const program = `
    import assert from 'node:assert/strict';
    import { buildServer } from ${JSON.stringify(serverUrl)};
    import { getImportSessionDataRoot } from ${JSON.stringify(importRouteUrl)};
    assert.equal(getImportSessionDataRoot(), process.env.KOIFORGE_IMPORT_DATA_ROOT);
    process.env.KOIFORGE_STATE_ROOT = ${JSON.stringify(changed)};
    process.env.KOIFORGE_IMPORT_DATA_ROOT = ${JSON.stringify(changed)};
    let app;
    try {
      await assert.rejects(async () => { app = await buildServer(); }, /import|Import/);
    } finally { if (app) await app.close(); }
    console.log('rejected-before-writing');
  `;
  const result = await execute(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, NODE_ENV: 'test', KOIFORGE_STATE_ROOT: captured, KOIFORGE_IMPORT_DATA_ROOT: captured,
      KOIFORGE_GENERATION_DISABLED: '1' },
    timeout: 15_000, maxBuffer: 64 * 1024,
  });
  assert.match(result.stdout, /rejected-before-writing/);
  assert.deepEqual(await readdir(directory), [], 'a rejected root change leaves both roots and sidecars absent');
});
