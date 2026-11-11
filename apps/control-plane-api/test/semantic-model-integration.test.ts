import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { FileDatasetRegistry } from '@koiforge/data-registry';
import type { SessionContext } from '@koiforge/security-core';
import type { ImportRow } from '../src/import-capability/isolated-executor.js';
import type { GenerationProvider } from '../src/import-capability/generation-provider.js';
import { createMissionEngine } from '../src/missions/engine.js';
import { createMissionService, type MissionService } from '../src/missions/service.js';
import type { AppRegistries } from '../src/registries.js';
import type { Relationship, RelationshipRow } from '../src/semantic-model/contracts.js';
import { createSemanticModelService } from '../src/semantic-model/service.js';

const owner: SessionContext = {
  user: { id: 'integration-owner', displayName: 'Integration owner' },
  tenant: { id: 'integration-firm', name: 'Integration firm', slug: 'integration-firm', status: 'active' },
  roleIds: ['owner'], permissions: ['datasets.read', 'datasets.manage'],
};
const authority = {
  async resolvePrincipal(reference: { userId: string; tenantId: string }) {
    return reference.userId === owner.user.id && reference.tenantId === owner.tenant.id ? structuredClone(owner) : null;
  },
  assertPermissions(session: SessionContext, permissions: string[]) {
    assert(permissions.every(permission => session.permissions.includes(permission)));
  },
};

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'koi-semantic-integration-'));
  const missions: MissionService[] = [];
  t.after(async () => {
    for (const service of [...missions].reverse()) { await service.close(); await service.whenIdle(); }
    await rm(root, { recursive: true, force: true });
  });
  const dataset = new FileDatasetRegistry({ filePath: join(root, 'datasets.json') });
  const options = { root, registries: { dataset }, ...authority };
  const semanticModel = createSemanticModelService(options);
  async function importSet(name: string, rows: ImportRow[]) {
    const imported = await dataset.registerInlineDataset({ name, namespace: 'integration', rows });
    const objectSet = await semanticModel.createObjectSet(owner, {
      name, datasetId: imported.id, keyField: 'id', confirmed: true, requestId: randomUUID(),
    });
    return { dataset: imported, objectSet };
  }
  return { root, dataset, options, semanticModel, missions, importSet };
}

// Deliberately use direct pairwise primitive equality, not production key tokens
// or indexes. This small oracle accepts a different implementation cost.
function independentStatus(row: ImportRow, source: ImportRow[], target: ImportRow[]): RelationshipRow['status'] {
  const missing = (value: unknown) => value === undefined || value === null
    || (typeof value === 'string' && value.trim() === '');
  const equal = (left: unknown, right: unknown) => typeof left === typeof right && left === right;
  if (missing(row.id) || source.filter(candidate => equal(candidate.id, row.id)).length !== 1) return 'invalid_source_key';
  if (missing(row.ref)) return 'missing_reference';
  const matches = target.filter(candidate => !missing(candidate.id) && equal(candidate.id, row.ref)).length;
  return matches === 0 ? 'unmatched_reference' : matches === 1 ? 'linked' : 'ambiguous_reference';
}

test('independent whole-source oracle agrees with every relationship page and retained snapshots after restart', async t => {
  const f = await fixture(t);
  const primitives = [0, '0', false, 'false', 1, '1', 'D', 'missing', null, '  ', true, 'true'];
  const target: ImportRow[] = [{ id: 0 }, { id: '0' }, { id: false }, { id: 'false' }, { id: 1 }, { id: '1' },
    { id: 'D' }, { id: 'D' }, { id: null }, { id: '  ' },
    ...Array.from({ length: 245 }, (_, index) => ({ id: `supplier-${index}` }))];
  const source: ImportRow[] = Array.from({ length: 375 }, (_, index) => ({
    ...(index % 41 === 0 ? {} : { id: index % 43 === 0 ? 'duplicate-order' : index }),
    ref: index % 7 === 0 ? `supplier-${index % 245}` : primitives[index % primitives.length]!,
  }));
  const from = await f.importSet('orders', source); const to = await f.importSet('suppliers', target);
  const relationship = await f.semanticModel.createRelationship(owner, {
    name: 'Supplier of order', fromSetId: from.objectSet.id, toSetId: to.objectSet.id,
    fromField: 'ref', confirmed: true, requestId: randomUUID(),
  });
  const expected = source.map(row => independentStatus(row, source, target));
  const expectedCounts: Relationship['counts'] = {
    sourceRows: source.length,
    linkedRows: expected.filter(status => status === 'linked').length,
    missingReferences: expected.filter(status => status === 'missing_reference').length,
    unmatchedReferences: expected.filter(status => status === 'unmatched_reference').length,
    ambiguousReferences: expected.filter(status => status === 'ambiguous_reference').length,
    invalidSourceRows: expected.filter(status => status === 'invalid_source_key').length,
  };
  assert.deepEqual(expectedCounts, { sourceRows: 375, linkedRows: 207, missingReferences: 49,
    unmatchedReferences: 76, ambiguousReferences: 25, invalidSourceRows: 18 });
  assert.deepEqual(relationship.counts, expectedCounts);
  const actual = new Map<number, RelationshipRow>();
  for (let offset = 0; offset < source.length; offset += 100) {
    const page = await f.semanticModel.getRelationship(owner, relationship.id, { offset, limit: 100 });
    assert.equal(page.totalRows, 375); assert.equal(page.offset, offset); assert.equal(page.truncated, true);
    for (const row of page.rows) {
      assert(!actual.has(row.sourceRow), `source row ${row.sourceRow} occurred on more than one page`);
      actual.set(row.sourceRow, row);
      assert.equal(row.status, expected[row.sourceRow - 1], `source row ${row.sourceRow}`);
      if (row.status === 'linked') {
        assert.equal(row.targetRowCount, 1);
        assert.equal(row.targetRows.length, 1);
        const matched = target[row.targetRows[0]! - 1]!;
        assert.equal(typeof matched.id, typeof row.reference);
        assert.equal(matched.id, row.reference);
      } else assert.equal(row.targetLabel, undefined, 'unresolved references must not identify a target object');
    }
  }
  assert.equal(actual.size, source.length);
  assert(actual.get(375), 'the final source row must remain visible beyond the old 200-row explorer limit');

  await f.dataset.deleteDataset(from.dataset.id); await f.dataset.deleteDataset(to.dataset.id);
  const replacement = await f.dataset.registerInlineDataset({ name: 'orders', namespace: 'integration', rows: [{ id: 'replacement', ref: 'changed' }] });
  assert.equal(replacement.id, from.dataset.id, 'the live dataset identifier is deliberately reused');
  const restarted = createSemanticModelService(f.options);
  const retained = await restarted.getRelationship(owner, relationship.id);
  assert.deepEqual(retained.relationship, relationship);
  assert.deepEqual(retained.from, from.objectSet); assert.deepEqual(retained.to, to.objectSet);
  assert.deepEqual(retained.relationship.counts, expectedCounts);
  const retainedObjects = await restarted.getObjectSet(owner, from.objectSet.id, { offset: 374, limit: 1 });
  assert.deepEqual(retainedObjects.rows[0]!.attributes, source[374]);
});

test('real semantic and mission services execute a fixed relationship after both live datasets are deleted', async t => {
  const f = await fixture(t);
  const from = await f.importSet('orders', [{ id: 'O1', supplier: 'S1' }, { id: 'O2', supplier: 'S2' }, { id: 'O3', supplier: null }]);
  const to = await f.importSet('suppliers', [{ id: 'S1' }]);
  const relationship = await f.semanticModel.createRelationship(owner, {
    name: 'Supplier of order', fromSetId: from.objectSet.id, toSetId: to.objectSet.id,
    fromField: 'supplier', confirmed: true, requestId: randomUUID(),
  });
  const metadata = { backend: 'codex' as const, model: 'fixture', reasoningEffort: 'xhigh' };
  const prompts: string[] = [];
  const generator: GenerationProvider = {
    ...metadata,
    async status() { return { ...metadata, available: true }; },
    async generate(_system, prompt) {
      prompts.push(prompt);
      return JSON.stringify({ capabilityId: 'relationship_integrity', summary: 'Die bestätigten Verweise prüfen.', suggestedBinding: {} });
    },
  };
  // The relationship path uses the real dataset/model stores; other registries
  // are not involved. The sole replacement is the local planner response.
  const registries = { dataset: f.dataset } as AppRegistries;
  function engine() {
    return createMissionEngine(f.root, registries, { semanticModel: createSemanticModelService(f.options), generator });
  }
  let service = await createMissionService({ root: f.root, engine: engine(), ...authority });
  f.missions.push(service);
  const input = { question: 'Welche Lieferantenverweise fehlen?', datasetId: from.dataset.id,
    relationshipId: relationship.id, requestId: randomUUID() };
  const created = await service.create(owner, input); await service.whenIdle();
  const planned = await service.get(owner, created.id);
  assert.equal(planned.status, 'awaiting_confirmation');
  assert.equal(planned.plan!.relationship!.fromSnapshotHash, from.objectSet.snapshotHash);
  assert.equal(planned.plan!.relationship!.toSnapshotHash, to.objectSet.snapshotHash);
  const run = { revision: planned.revision, requestId: randomUUID(), confirmed: true, binding: {} };
  await service.close();
  await f.dataset.deleteDataset(from.dataset.id); await f.dataset.deleteDataset(to.dataset.id);

  service = await createMissionService({ root: f.root, engine: engine(), ...authority });
  f.missions.push(service);
  await service.run(owner, created.id, run); await service.whenIdle();
  const completed = await service.get(owner, created.id);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.result!.counts, { sourceRows: 3, linkedRows: 1, missingReferences: 1,
    unmatchedReferences: 1, ambiguousReferences: 0, invalidSourceRows: 0, targetRows: 1 });
  assert.equal(completed.result!.evidence.fromSnapshotHash, from.objectSet.snapshotHash);
  assert.equal(completed.result!.evidence.toSnapshotHash, to.objectSet.snapshotHash);
  assert.equal(completed.result!.evidence.relationshipId, relationship.id);
  assert.equal(prompts.length, 1, 'resuming the confirmed plan must not ask the planner again');

  await service.close(); service = await createMissionService({ root: f.root, engine: engine(), ...authority });
  f.missions.push(service);
  assert.deepEqual((await service.get(owner, created.id)).result, completed.result);
  assert.equal((await service.create(owner, input)).id, created.id);
  assert.equal((await service.run(owner, created.id, run)).id, created.id);
  assert.equal(prompts.length, 1);
});
