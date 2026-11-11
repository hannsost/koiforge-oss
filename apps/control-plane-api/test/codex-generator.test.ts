import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { AppRegistries } from '../src/registries.js';
import { CODEX_GENERATION, createCodexGenerator } from '../src/import-capability/codex-generator.js';
import { generationProvider } from '../src/import-capability/generation-provider.js';

const secretNames = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'KOIFORGE_API_KEY',
  'API_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'DATABASE_URL',
  'GITHUB_TOKEN',
];

const fakeCliSource = `#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
stdin_file="$root/stdin-$$"
printf '%s' "$$" > "$root/pid"
pwd > "$root/cwd"
cat > "$stdin_file"
exec node "$root/fake-codex-runtime.mjs" "$stdin_file" "$@"
`;

const fakeCliRuntimeSource = `#!/usr/bin/env node
import { existsSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const modePath = join(root, 'mode');
const mode = existsSync(modePath) ? readFileSync(modePath, 'utf8').trim() : 'success';
const stdinPath = process.argv[2];
const stdin = readFileSync(stdinPath, 'utf8');
const args = process.argv.slice(3);
try { unlinkSync(stdinPath); } catch {}
const outputIndex = args.indexOf('--output-last-message');
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;

function writeJson(name, value) {
  writeFileSync(join(root, name), JSON.stringify(value));
}
function emit(value) {
  writeSync(1, value);
}

if (args[0] === 'login') {
  writeJson('status-observed.json', { args });
  if (mode === 'status-chatgpt') emit('Logged in using ChatGPT\\n');
  else if (mode === 'status-api') emit('Logged in using API key\\n');
  else if (mode === 'status-unavailable') emit('Not logged in\\n');
  else if (mode === 'status-nonzero') process.exitCode = 7;
} else {
  const run = () => {
    writeJson('observed.json', {
      args,
      stdin,
      cwd: process.cwd(),
      secrets: ${JSON.stringify(secretNames)}.filter((key) => process.env[key] !== undefined),
    });

    if (mode === 'timeout') {
      writeFileSync(join(root, 'pid'), String(process.pid));
      writeFileSync(join(root, 'cwd'), process.cwd());
      setInterval(() => {}, 1000);
      return;
    }
    if (mode === 'oversized-stream') {
      emit('x'.repeat(8192));
      return;
    }
    if (mode === 'failed-turn') {
      emit(JSON.stringify({ type: 'turn.failed' }) + '\\n');
      return;
    }
    if (mode === 'tool-action') {
      emit(JSON.stringify({ type: 'item.completed', item: { type: 'shell_command' } }) + '\\n');
      return;
    }
    if (mode === 'nonfatal-error') {
      emit(JSON.stringify({ type: 'item.completed', item: { type: 'error' } }) + '\\n');
      const output = outputPath;
      if (output) writeFileSync(output, JSON.stringify({ artifact: JSON.stringify({ mode, args, stdin }) }));
      emit(JSON.stringify({ type: 'turn.completed' }) + '\\n');
      return;
    }
    if (mode === 'nonzero') {
      process.exitCode = 7;
      return;
    }

    const payload = { mode, args, stdin, cwd: process.cwd(), secrets: ${JSON.stringify(secretNames)}.filter((key) => process.env[key] !== undefined) };
    if (mode === 'oversized-file') payload.padding = 'x'.repeat(4096);
    if (outputPath && mode !== 'missing-output') {
      if (mode === 'invalid-envelope') writeFileSync(outputPath, '{not-json');
      else if (mode === 'invalid-artifact') writeFileSync(outputPath, JSON.stringify({ artifact: 'not-json' }));
      else writeFileSync(outputPath, JSON.stringify({ artifact: JSON.stringify(payload) }));
    }
    const finish = () => emit(JSON.stringify({ type: 'turn.completed' }) + '\\n');
    if (mode === 'delay') setTimeout(finish, 300);
    else finish();
  };
  run();
}
`;

interface FakeCli {
  command: string;
  root: string;
  setMode(mode: string): Promise<void>;
  readObserved(): Promise<{ args: string[]; stdin: string; cwd: string; secrets: string[] }>;
  dispose(): Promise<void>;
}

async function makeFakeCli(): Promise<FakeCli> {
  const root = await mkdtemp(join(tmpdir(), 'koiforge-codex-cli-'));
  const command = join(root, 'fake-codex.mjs');
  await writeFile(command, fakeCliSource, { mode: 0o700 });
  await writeFile(join(root, 'fake-codex-runtime.mjs'), fakeCliRuntimeSource, { mode: 0o700 });
  await chmod(command, 0o700);
  const setMode = async (mode: string) => writeFile(join(root, 'mode'), mode);
  const readObserved = async () => JSON.parse(await readFile(join(root, 'observed.json'), 'utf8')) as {
    args: string[];
    stdin: string;
    cwd: string;
    secrets: string[];
  };
  return {
    command,
    root,
    setMode,
    readObserved,
    async dispose() { await rm(root, { recursive: true, force: true }); },
  };
}

async function withEnvironment<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withFakeCli<T>(fn: (fake: FakeCli) => Promise<T>): Promise<T> {
  const fake = await makeFakeCli();
  try { return await fn(fake); }
  finally { await fake.dispose(); }
}

test('reports ChatGPT login, rejects API-key login, and reports unavailable login', async () => {
  await withFakeCli(async (fake) => {
    await fake.setMode('status-chatgpt');
    const chatgpt = await createCodexGenerator({ command: fake.command }).status();
    assert.deepEqual(chatgpt, { ...CODEX_GENERATION, available: true });

    await fake.setMode('status-api');
    const api = await createCodexGenerator({ command: fake.command }).status();
    assert.equal(api.available, false);
    assert.match(api.reason ?? '', /ChatGPT-Anmeldung/);

    await fake.setMode('status-unavailable');
    const unavailable = await createCodexGenerator({ command: fake.command }).status();
    assert.equal(unavailable.available, false);
    assert.match(unavailable.reason ?? '', /ChatGPT-Anmeldung/);
  });
});

test('status remains unavailable when the CLI cannot be spawned', async () => {
  const status = await createCodexGenerator({ command: join(tmpdir(), 'does-not-exist-koiforge-codex') }).status();
  assert.equal(status.available, false);
  assert.match(status.reason ?? '', /nicht verfügbar|Installation/i);
});

test('passes the fixed model, xhigh effort, read-only/no-approval and ephemeral flags', async () => {
  await withFakeCli(async (fake) => {
    const system = 'SYSTEM-INSTRUCTION-9c42';
    const prompt = 'PROMPT-ONLY-ON-STDIN-51b7';
    const artifact = JSON.parse(await createCodexGenerator({ command: fake.command }).generate(system, prompt));
    const observed = await fake.readObserved();
    assert.ok(artifact.stdin.includes(prompt));
    assert.ok(observed.stdin.includes(system));
    assert.ok(observed.stdin.includes(prompt));
    assert.equal(observed.args.includes(prompt), false);
    assert.equal(observed.args.includes(system), false);
    assert.deepEqual(artifact.secrets, []);

    const args = observed.args;
    assert.ok(args.includes('--ephemeral'));
    assert.ok(args.includes('--sandbox') && args[args.indexOf('--sandbox') + 1] === 'read-only');
    assert.ok(args.includes('--model') && args[args.indexOf('--model') + 1] === 'gpt-6-astra');
    assert.ok(args.includes('-c') && args.includes('model_reasoning_effort="xhigh"'));
    assert.ok(args.includes('approval_policy="never"'));
    assert.ok(args.includes('--output-schema'));
    assert.ok(args.includes('--output-last-message'));
  });
});

test('ignores a nonfatal error item when the CLI completes the turn successfully', async () => {
  await withFakeCli(async (fake) => {
    await fake.setMode('nonfatal-error');
    const artifact = JSON.parse(await createCodexGenerator({ command: fake.command }).generate('system', 'code-mode unavailable')) as {
      mode: string;
      stdin: string;
    };
    assert.equal(artifact.mode, 'nonfatal-error');
    assert.match(artifact.stdin, /code-mode unavailable/);
  });
});

test('returns the JSON artifact and removes the generated workspace', async () => {
  await withFakeCli(async (fake) => {
    const result = await createCodexGenerator({ command: fake.command }).generate('system', 'task');
    const artifact = JSON.parse(result) as { mode: string; cwd: string };
    assert.equal(artifact.mode, 'success');
    await assert.rejects(stat(artifact.cwd), { code: 'ENOENT' });
  });
});

test('does not succeed for nonzero exit, missing output, invalid JSON, failed turns, or tool actions', async () => {
  await withFakeCli(async (fake) => {
    for (const [mode, expected] of [
      ['nonzero', /fehlgeschlagen/],
      ['missing-output', /ENOENT|Erweiterungsartefakt|no such file/i],
      ['invalid-envelope', /JSON|Unexpected token|ungültig/i],
      ['invalid-artifact', /JSON|Unexpected token|ungültig/i],
      ['failed-turn', /nicht erzeugen|fehlgeschlagen/i],
      ['tool-action', /Werkzeugaktion/],
    ] as const) {
      await fake.setMode(mode);
      await assert.rejects(
        createCodexGenerator({ command: fake.command, timeoutMs: 1_000 }).generate('system', `task-${mode}`),
        expected,
      );
    }
  });
});

test('kills a timed-out CLI process and removes its generated workspace', async () => {
  await withFakeCli(async (fake) => {
    await fake.setMode('timeout');
    await assert.rejects(
      createCodexGenerator({ command: fake.command, timeoutMs: 50 }).generate('system', 'timeout task'),
      /Zeitlimit/,
    );
    const pid = Number(await readFile(join(fake.root, 'pid'), 'utf8'));
    const cwd = await readFile(join(fake.root, 'cwd'), 'utf8');
    await assert.rejects(stat(cwd), { code: 'ENOENT' });
    assert.throws(() => process.kill(pid, 0), /ESRCH|not found/i);
  });
});

test('enforces the configured output limit for streamed CLI output and output artifacts', async () => {
  await withFakeCli(async (fake) => {
    await fake.setMode('oversized-stream');
    await assert.rejects(
      createCodexGenerator({ command: fake.command, timeoutMs: 1_000, maxOutputBytes: 128 }).generate('system', 'large stream'),
      /Größenlimit/,
    );

    await fake.setMode('oversized-file');
    await assert.rejects(
      createCodexGenerator({ command: fake.command, timeoutMs: 1_000, maxOutputBytes: 128 }).generate('system', 'large artifact'),
      /Größenlimit/,
    );
  });
});

test('rejects concurrent generation while busy and recovers afterwards', async () => {
  await withFakeCli(async (fake) => {
    await fake.setMode('delay');
    const generator = createCodexGenerator({ command: fake.command, timeoutMs: 2_000 });
    const first = generator.generate('system', 'first');
    await assert.rejects(generator.generate('system', 'second'), /andere Erweiterung/);
    const firstArtifact = JSON.parse(await first) as { stdin: string };
    assert.match(firstArtifact.stdin, /first/);

    await fake.setMode('success');
    const recovered = JSON.parse(await generator.generate('system', 'after recovery')) as { stdin: string };
    assert.match(recovered.stdin, /after recovery/);
  });
});

test('honors the disabled generation gate without starting the CLI', async () => {
  await withFakeCli(async (fake) => {
    await withEnvironment({ KOIFORGE_GENERATION_DISABLED: '1' }, async () => {
      await assert.rejects(
        createCodexGenerator({ command: fake.command }).generate('system', 'disabled'),
        /Generation is disabled/,
      );
    });
    await assert.rejects(readFile(join(fake.root, 'observed.json')), { code: 'ENOENT' });
  });
});

test('does not pass API or unrelated application secrets to the CLI child process', async () => {
  await withFakeCli(async (fake) => {
    const values = Object.fromEntries(secretNames.map((key) => [key, `synthetic-${key}`]));
    const result = await withEnvironment(values, () =>
      createCodexGenerator({ command: fake.command }).generate('system', 'secret probe'));
    const artifact = JSON.parse(result) as { secrets: string[] };
    assert.deepEqual(artifact.secrets, []);
  });
});

test('uses the local codex backend only when explicitly selected without reading the API registry', async () => {
  let read = false;
  const registries = {
    aip: {
      async getConfig() {
        read = true;
        throw new Error('API registry must not be read for the explicit Codex backend');
      },
    },
  } as unknown as AppRegistries;
  await withEnvironment({ KOIFORGE_EXTENSION_BACKEND: 'codex' }, async () => {
    const provider = await generationProvider(registries);
    assert.equal(provider.backend, 'codex');
    assert.equal(provider.model, 'gpt-6-astra');
    assert.equal(read, false);
  });
});

test('uses the API generation provider when explicitly selected', async () => {
  let reads = 0;
  const registries = {
    aip: {
      async getConfig() {
        reads += 1;
        return { provider: 'custom', baseUrl: 'http://example.test', model: 'fixture-model', reasoningEffort: 'high' };
      },
    },
  } as unknown as AppRegistries;
  await withEnvironment({ KOIFORGE_EXTENSION_BACKEND: 'api' }, async () => {
    const provider = await generationProvider(registries);
    assert.equal(provider.backend, 'api');
    assert.equal(provider.model, 'fixture-model');
    assert.equal((await provider.status()).available, true);
    assert.equal(reads, 1);
  });
});

test('uses the API generation provider by default and reads the AIP registry', async () => {
  let reads = 0;
  const registries = {
    aip: {
      async getConfig() {
        reads += 1;
        return { provider: 'custom', baseUrl: 'http://example.test', model: 'fixture-model', reasoningEffort: 'high' };
      },
    },
  } as unknown as AppRegistries;
  await withEnvironment({ KOIFORGE_EXTENSION_BACKEND: undefined }, async () => {
    const provider = await generationProvider(registries);
    assert.equal(provider.backend, 'api');
    assert.equal(provider.model, 'fixture-model');
    assert.equal((await provider.status()).available, true);
    assert.equal(reads, 1);
  });
});
