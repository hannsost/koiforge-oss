import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatasetRecord } from '@koiforge/data-registry';
import { createMissionEngine } from '../src/missions/engine.js';
import type { Mission } from '../src/missions/contracts.js';
import type { AppRegistries } from '../src/registries.js';
import type { ImportRow } from '../src/import-capability/isolated-executor.js';
import { rowsHash } from '../src/import-capability/isolated-executor.js';

async function fixture(t: { after(fn: () => Promise<void>): void }, rows: ImportRow[] = [
  { id: 1, value: 0 }, { id: '1', value: false }, { id: 'D', value: '' }, { id: 'D', value: ' \t ' }, { id: null }, { value: null },
]) {
  const root = await mkdtemp(join(tmpdir(), 'koi-mission-engine-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataset = { id: 'example', name: 'Testdaten', connectorId: 'inline', source: { coverage: 'complete', previewRows: rows },
    schema: [{ name: 'id', type: 'string' }, { name: 'value', type: 'string' }] } as DatasetRecord;
  const preview = { datasetId: dataset.id, columns: ['id', 'value'], rows, rowCount: rows.length, truncated: false };
  const registries = { dataset: { getDataset: async () => dataset, previewRows: async () => preview } } as unknown as AppRegistries;
  const proposed: Record<string, unknown> = { capabilityId: 'data_quality', summary: 'Vollständigkeit und Schlüssel prüfen.', suggestedBinding: { keyField: 'id' }, unsupportedReason: null };
  const prompts: string[] = [];
  const generator = { backend: 'codex' as const, model: 'gpt-6-astra', reasoningEffort: 'xhigh',
    async status() { return { backend: 'codex' as const, model: 'gpt-6-astra', reasoningEffort: 'xhigh', available: true }; },
    async generate(_system: string, prompt: string) { prompts.push(prompt); return JSON.stringify(proposed); } };
  const mission: Mission = { id: randomUUID(), tenantId: 'tenant-a', ownerId: 'owner-a', datasetId: dataset.id,
    question: 'Wo fehlen Werte und welche IDs sind doppelt?', revision: 1, status: 'planning', phase: 'plan',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events: [] };
  const engine = createMissionEngine(root, registries, { generator });
  async function plan() { Object.assign(mission, await engine.plan(mission)); return mission; }
  return { root, registries, dataset, preview, mission, engine, proposed, prompts, generator, plan };
}

test('full-source quality distinguishes missing values, typed keys and duplicate groups with row evidence', async t => {
  const f = await fixture(t); await f.plan();
  const result = await f.engine.execute(f.mission, { confirmed: true, binding: { keyField: 'id' } });
  assert.deepEqual(result.counts, { sourceRows: 6, sourceColumns: 2, missingCells: 6, missingKeys: 2,
    duplicateGroups: 1, duplicateRows: 2, duplicateExcessRows: 1 });
  assert.equal(result.rows[0]!.Befund, '"D"');
  assert.equal(result.rows[0]!['Beispiel-Quellzeilen (1-basiert, höchstens 20)'], '3, 4');
  assert.equal(result.totalRows, 3); assert.equal(result.truncated, false);
  assert.equal(result.evidence.sourceHash, rowsHash(f.preview.rows));
  assert.equal(result.evidence.capabilityVersion, 'data-quality-v1');
});

test('no key choice means duplicates remain unassessed; empty source makes no positive quality claim', async t => {
  const f = await fixture(t, []); await f.plan();
  const result = await f.engine.execute(f.mission, { confirmed: true, binding: {} });
  assert.equal(result.counts.sourceRows, 0);
  assert.equal(result.counts.duplicateGroups, undefined);
  assert.match(result.summary, /keine Datensätze/);
  assert.doesNotMatch(result.summary, /100%/);
});

test('planning receives schema and row count without customer rows; proposed code and tools are rejected', async t => {
  const f = await fixture(t, [{ id: 'SECRET-CUSTOMER', value: 'PRIVATE-ADDRESS' }]);
  await f.plan();
  assert.equal(f.prompts.length, 1);
  assert.doesNotMatch(f.prompts[0]!, /SECRET-CUSTOMER|PRIVATE-ADDRESS/);
  assert.equal(JSON.parse(f.prompts[0]!).source.rowCount, 1);
  f.proposed.tool = 'execute_action';
  await assert.rejects(f.engine.plan(f.mission), /gültigen, begrenzten Plan/);
});

test('unsupported requests remain unsupported and cannot run a nearby capability', async t => {
  const f = await fixture(t);
  Object.assign(f.proposed, { capabilityId: null, unsupportedReason: 'Lieferverzug ist noch nicht verfügbar.', suggestedBinding: {} });
  await f.plan();
  assert.equal(f.mission.plan?.capabilityId, null);
  assert.throws(() => f.engine.validateRun(f.mission, { confirmed: true, binding: {} }), /Kein bestätigbarer Plan/);
  await assert.rejects(f.engine.execute(f.mission, { confirmed: true, binding: {} }), /Kein bestätigbarer Plan/);
});

test('partial source and invented field suggestions fail before execution', async t => {
  const f = await fixture(t); f.dataset.source.coverage = 'partial';
  await assert.rejects(f.plan(), /vollständig importierte/); assert.equal(f.prompts.length, 0);
  f.dataset.source.coverage = 'complete'; f.proposed.suggestedBinding = { keyField: 'invented' };
  await assert.rejects(f.plan(), /nicht vorhandene Quellenspalte/);
  f.proposed.suggestedBinding = {}; f.proposed.capabilityId = 'send_email';
  await assert.rejects(f.plan(), /nicht verfügbare Fähigkeit/);
});

test('execution and replanning use immutable stored rows across registry changes and process recreation', async t => {
  const f = await fixture(t); await f.plan();
  const expected = await f.engine.execute(f.mission, { confirmed: true, binding: {} });
  f.preview.rows = [{ id: 'different', value: 'complete' }]; f.preview.rowCount = 1;
  f.dataset.source.previewRows = f.preview.rows;
  const restarted = createMissionEngine(f.root, f.registries, { generator: f.generator });
  assert.equal((await restarted.plan(f.mission)).source.hash, f.mission.source!.hash);
  const result = await restarted.execute(f.mission, { confirmed: true, binding: {} });
  assert.deepEqual(result.counts, expected.counts); assert.deepEqual(result.rows, expected.rows);
  assert.equal(result.evidence.sourceHash, expected.evidence.sourceHash);
});

test('freezing obtains rows and metadata from one registry read, without a second preview lookup', async t => {
  const f = await fixture(t);
  f.registries.dataset.previewRows = async () => { throw new Error('A second read could race a reimport'); };
  await f.plan();
  const result = await f.engine.execute(f.mission, { confirmed: true, binding: {} });
  assert.equal(result.counts.sourceRows, 6);
  assert.equal(result.evidence.sourceHash, rowsHash(f.preview.rows));
});

test('snapshot corruption, stale bindings and unconfirmed inputs fail closed', async t => {
  const f = await fixture(t); await f.plan();
  assert.throws(() => f.engine.validateRun(f.mission, { confirmed: false, binding: {} }), /ausdrücklich bestätigen/);
  assert.throws(() => f.engine.validateRun(f.mission, { confirmed: true, binding: { keyField: 'missing' } }), /vorhandene Quellenspalten/);
  const path = join(f.root, 'mission-snapshots', createHash('sha256').update(f.mission.tenantId).digest('hex'), `${f.mission.id}.json`);
  const saved = JSON.parse(await readFile(path, 'utf8')); saved.preview.rows[0].value = 'tampered';
  await writeFile(path, JSON.stringify(saved));
  await assert.rejects(f.engine.execute(f.mission, { confirmed: true, binding: {} }), /Quellenstand stimmt nicht/);
});

test('large result previews preserve whole-source counts and bounded row-position examples', async t => {
  const f = await fixture(t, Array.from({ length: 250 }, (_, i) => ({ id: `key-${Math.floor(i / 2)}`, value: '' })));
  await f.plan(); const result = await f.engine.execute(f.mission, { confirmed: true, binding: { keyField: 'id' } });
  assert.equal(result.counts.duplicateGroups, 125); assert.equal(result.counts.sourceRows, 250);
  assert.equal(result.counts.missingCells, 250); assert.equal(result.totalRows, 127);
  assert.equal(result.rows.length, 100); assert.equal(result.truncated, true);
});

test('column names matching Object.prototype never invent cell values or duplicate keys', async t => {
  const f = await fixture(t, [{ id: 'a', toString: 'present' }, { id: 'b' }, { id: 'c' }]);
  f.preview.columns = ['id', 'toString'];
  f.dataset.schema = [{ name: 'id', type: 'string' }, { name: 'toString', type: 'string' }];
  f.proposed.suggestedBinding = { keyField: 'toString' };
  await f.plan();
  const result = await f.engine.execute(f.mission, { confirmed: true, binding: { keyField: 'toString' } });
  assert.equal(result.counts.missingCells, 2); assert.equal(result.counts.missingKeys, 2);
  assert.equal(result.counts.duplicateGroups, 0); assert.equal(result.rows.length, 2);
});

test('unsupported stored capability versions and IDs fail before any execution', async t => {
  const f = await fixture(t); await f.plan();
  f.mission.plan!.capabilityVersion = 'data-quality-v999';
  await assert.rejects(f.engine.execute(f.mission, { confirmed: true, binding: {} }), /Fähigkeitsversion ist nicht ausführbar/);
  f.mission.plan!.capabilityId = 'unregistered_capability' as never;
  assert.throws(() => f.engine.validateRun(f.mission, { confirmed: true, binding: {} }), /Fähigkeitsversion ist nicht ausführbar/);
});
