import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './authenticated-fixture.js';

const api = 'http://127.0.0.1:3191';
async function importCsv(request: APIRequestContext, content: string): Promise<string> {
  const upload = await request.post(`${api}/api/import/sessions`, { multipart: { file: {
    name: `semantic-${randomUUID()}.csv`, mimeType: 'text/csv', buffer: Buffer.from(content),
  } } });
  expect(upload.ok(), await upload.text()).toBeTruthy();
  const session = (await upload.json()).session;
  const leaf = Object.values(session.nodes).find((node: any) => node.capabilityId === 'csv-file' && node.children.length === 0) as { id: string };
  expect(leaf).toBeTruthy();
  const response = await request.post(`${api}/api/import/sessions/${session.id}/run`, { data: { selectedNodeIds: [leaf.id] } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()).importedDatasets[0].id;
}
function selectedId(page: Page, key: string): string {
  return new URLSearchParams(page.url().split('?')[1]).get(key)!;
}
async function fillObject(page: Page, datasetId: string, name: string, labelField?: string) {
  await expect(page.getByTestId('semantic-source')).toBeEnabled();
  await page.getByTestId('semantic-source').selectOption(datasetId);
  await page.getByTestId('semantic-set-name').fill(name);
  await page.getByTestId('semantic-key-field').selectOption('id');
  if (labelField) await page.getByTestId('semantic-label-field').selectOption(labelField);
}
async function saveObject(page: Page): Promise<string> {
  await page.getByTestId('semantic-set-confirm').check();
  await page.getByTestId('semantic-save-set').click();
  await expect(page.getByTestId('semantic-object-detail')).toBeVisible();
  return selectedId(page, 'set');
}
async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(`${api}/api/model/${path}`, { data });
  expect(response.ok(), await response.text()).toBeTruthy(); return response.json();
}

test('confirmed source meanings become a relationship and a durable mission with two frozen sources', async ({ page, request }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const source = await importCsv(request, 'id,supplier\nA,S1\nB,\nC,U\nD,D\nK,S1\nK,S1\n,S1\n');
  const target = await importCsv(request, 'id,name\nS1,Lieferant Eins\nD,Doppelt Eins\nD,Doppelt Zwei\n');
  await page.goto('/#/model');
  await fillObject(page, source, 'Bestellungen');
  let creates = 0;
  page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/api/model/object-sets')) creates++; });
  await page.getByTestId('semantic-save-set').click();
  await expect(page.getByRole('alert')).toContainText('ausdrücklich bestätigen');
  expect(creates).toBe(0);
  const fromId = await saveObject(page);
  await expect(page.getByTestId('semantic-object-detail')).toContainText('Zeilen mit doppelter ID');
  await page.getByTestId('semantic-new-set').click();
  await fillObject(page, target, 'Lieferanten', 'name');
  const toId = await saveObject(page);
  await page.getByTestId('semantic-tab-relationships').click();
  await page.getByTestId('semantic-relationship-name').fill('Bestellung gehört zu Lieferant');
  await page.getByTestId('semantic-from-set').selectOption(fromId);
  await page.getByTestId('semantic-from-field').selectOption('supplier');
  await page.getByTestId('semantic-to-set').selectOption(toId);
  await page.getByTestId('semantic-relationship-confirm').check();
  await page.getByTestId('semantic-save-relationship').click();
  const detail = page.getByTestId('semantic-relationship-detail');
  await expect(detail).toBeVisible();
  await expect(detail).toContainText('Referenz fehlt'); await expect(detail).toContainText('Kein Ziel gefunden');
  await expect(detail).toContainText('Ziel ist mehrdeutig'); await expect(detail).toContainText('Quell-ID fehlt oder ist doppelt');
  const relationId = selectedId(page, 'relationship');
  const relation = await (await request.get(`${api}/api/model/relationships/${relationId}`)).json();
  expect(relation.relationship.counts).toEqual({ sourceRows: 7, linkedRows: 1, missingReferences: 1,
    unmatchedReferences: 1, ambiguousReferences: 1, invalidSourceRows: 3 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath('relationship-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  const findings = page.getByRole('region', { name: 'Zuordnungen und offene Fälle', exact: true });
  await findings.scrollIntoViewIfNeeded();
  await expect(findings.getByRole('columnheader', { name: 'Befund', exact: true })).toBeInViewport();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath('relationship-mobile.png'), fullPage: true });

  // The mission uses confirmed model sources even when neither is in the live picker.
  expect((await request.delete(`${api}/api/datasets/${source}`)).ok()).toBeTruthy();
  expect((await request.delete(`${api}/api/datasets/${target}`)).ok()).toBeTruthy();
  await page.getByTestId('semantic-check-relationship').click();
  await expect(page).toHaveURL(new RegExp(`#/missions\\?relationship=${relationId}`));
  await expect(page.getByTestId('mission-plan')).toBeEnabled();
  await page.getByTestId('mission-plan').click();
  await expect(page.getByTestId('mission-confirm')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('mission-key-field')).toHaveCount(0);
  await page.getByTestId('mission-confirm').check();
  await page.getByTestId('mission-run').click();
  await expect(page.getByTestId('mission-result')).toContainText('1 von 7 Quellzeilen eindeutig zugeordnet', { timeout: 15_000 });
  const missionId = selectedId(page, 'id');
  const mission = (await (await request.get(`${api}/api/missions/${missionId}`)).json()).mission;
  expect(mission.result.evidence).toMatchObject({ relationshipId: relationId, fromSetId: fromId, toSetId: toId,
    sourceHash: relation.from.source.hash, targetSourceHash: relation.to.source.hash,
    fromSnapshotHash: relation.from.snapshotHash, toSnapshotHash: relation.to.snapshotHash });
  await page.reload();
  await expect(page.getByTestId('mission-result')).toContainText('1 von 7 Quellzeilen eindeutig zugeordnet');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  const resultTable = page.getByTestId('mission-result').getByRole('region');
  await resultTable.scrollIntoViewIfNeeded();
  await expect(resultTable.getByRole('columnheader', { name: 'Befund', exact: true })).toBeInViewport();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath('relationship-mission-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('pagination covers more than 200 rows and a new object revision leaves existing relationships pinned', async ({ page, request }, info) => {
  const source = await importCsv(request, `id,supplier\n${Array.from({ length: 211 }, (_, i) => `O${i + 1},S1`).join('\n')}\n`);
  const target = await importCsv(request, 'id,name\nS1,Lieferant Eins\n');
  const from = (await post(request, 'object-sets', { name: 'Viele Bestellungen', datasetId: source, keyField: 'id', confirmed: true, requestId: randomUUID() })).objectSet;
  const to = (await post(request, 'object-sets', { name: 'Ein Lieferant', datasetId: target, keyField: 'id', confirmed: true, requestId: randomUUID() })).objectSet;
  const relationship = (await post(request, 'relationships', { name: 'Alle Bestellungen', fromSetId: from.id, toSetId: to.id,
    fromField: 'supplier', confirmed: true, requestId: randomUUID() })).relationship;
  expect(relationship.counts.linkedRows).toBe(211);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/#/model?set=${from.id}`);
  await expect(page.getByTestId('semantic-object-detail')).toContainText('Zeilen 1–50 von 211');
  await page.getByTestId('semantic-page-next').click();
  await expect(page.getByTestId('semantic-object-detail')).toContainText('Zeilen 51–100 von 211');
  await page.getByTestId('semantic-revise-set').click();
  await expect(page.getByTestId('semantic-set-confirm')).not.toBeChecked();
  await page.getByTestId('semantic-set-name').fill('Bestellungen neuer Modellstand');
  const revisedId = await saveObject(page);
  expect(revisedId).not.toBe(from.id);
  const revised = (await (await request.get(`${api}/api/model/object-sets/${revisedId}`)).json()).objectSet;
  expect(revised.revision).toBe(2); expect(revised.previousId).toBe(from.id);
  await page.goto(`/#/model?relationship=${relationship.id}`);
  await expect(page.getByTestId('semantic-relationship-detail')).toContainText('Viele Bestellungen · Revision 1');
  const pinned = await (await request.get(`${api}/api/model/relationships/${relationship.id}?offset=200&limit=50`)).json();
  expect(pinned.from.id).toBe(from.id); expect(pinned.rows).toHaveLength(11); expect(pinned.rows[10].sourceRow).toBe(211);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: info.outputPath('pinned-revision-mobile.png'), fullPage: true });
});

test('a lost save response retains its request ID across reload and does not create duplicate object sets', async ({ page, request }) => {
  const source = await importCsv(request, 'id,name\nA,Projekt A\n');
  const name = `Wiederholung ${randomUUID()}`;
  let firstId = ''; let loseResponse = true;
  await page.route('**/api/model/object-sets', async route => {
    if (route.request().method() === 'POST' && loseResponse) {
      loseResponse = false;
      const response = await route.fetch(); expect(response.ok()).toBeTruthy();
      firstId = (await response.json()).objectSet.id;
      await route.abort('connectionreset');
    } else await route.continue();
  });
  await page.goto('/#/model'); await fillObject(page, source, name);
  await page.getByTestId('semantic-set-confirm').check();
  await page.getByTestId('semantic-save-set').click();
  await expect(page.getByRole('alert')).toContainText('Speicherantwort ist ausgeblieben');
  await page.reload();
  await expect(page.getByTestId('semantic-set-name')).toHaveValue(name);
  await expect(page.getByTestId('semantic-save-set')).toBeEnabled();
  await expect(page.getByTestId('semantic-set-confirm')).not.toBeChecked();
  const savedId = await saveObject(page); expect(savedId).toBe(firstId);
  const sets = (await (await request.get(`${api}/api/model/object-sets`)).json()).items;
  expect(sets.filter((set: { name: string }) => set.name === name)).toHaveLength(1);
});

test('model loading failure is explicit and retry restores saved object sets', async ({ page, request }) => {
  const source = await importCsv(request, 'id\nA\n');
  const name = `Gespeichert ${randomUUID()}`;
  await post(request, 'object-sets', { name, datasetId: source, keyField: 'id', confirmed: true, requestId: randomUUID() });
  let fail = true;
  await page.route('**/api/model/object-sets', route => fail
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic storage outage' }) })
    : route.continue());
  await page.goto('/#/model');
  await expect(page.getByRole('alert')).toContainText('Objektmengen konnten nicht geladen werden');
  await expect(page.getByText('Noch keine bestätigte Objektmenge.', { exact: false })).toHaveCount(0);
  fail = false;
  await page.getByRole('button', { name: 'Fachmodell aktualisieren', exact: true }).click();
  await expect(page.getByRole('button', { name: new RegExp(name) })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
