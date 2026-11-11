import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { expect, test } from './authenticated-fixture.js';

const api = 'http://127.0.0.1:3191';
async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(`${api}/api/${path}`, { data });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function source(request: APIRequestContext, name: string, value: string, previousId?: string) {
  const dataset = await post(request, 'datasets/inline', { name: `${name}-${randomUUID()}`, rows: [{ id: 'C1', name: value }] });
  return (await post(request, 'model/object-sets', { name, datasetId: dataset.id, keyField: 'id', labelField: 'name', confirmed: true,
    requestId: randomUUID(), ...(previousId ? { previousId } : {}) })).objectSet;
}
async function flow(request: APIRequestContext, name: string, inputFamilyId: string) {
  const definition = (await post(request, 'dataflows', { spec: { name, description: '', inputFamilyId, keyField: 'id', labelField: 'name',
    joins: [], filters: [], minRows: 1 }, confirmed: true, requestId: randomUUID() })).definition;
  const run = (await post(request, `dataflows/${definition.flowId}/runs`, { definitionId: definition.id, confirmed: true, requestId: randomUUID() })).run;
  expect(run.status).toBe('ready');
  const output = (await post(request, `dataflows/${definition.flowId}/runs/${run.id}/publish`, { confirmed: true })).objectSet;
  return { definition, output };
}

test('dependency path updates a three-stage chain in source order and survives reload', async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const suffix = randomUUID().slice(0, 8);
  const original = await source(request, `Kunden ${suffix}`, 'Ada');
  const a = await flow(request, `Kundenbasis ${suffix}`, original.familyId);
  const b = await flow(request, `Arbeitsbestand ${suffix}`, a.definition.flowId);
  const c = await flow(request, `Bericht ${suffix}`, b.definition.flowId);
  await page.goto(`/#/dataflows?id=${c.definition.flowId}`);
  const graph = page.getByTestId('dependency-workspace');
  await expect(graph.getByTestId(`dependency-node-${c.definition.flowId}`)).toContainText('Aktuell');
  await source(request, original.name, 'Bea', original.id);
  await graph.getByTestId('dependency-refresh').click();
  await expect(graph.getByTestId(`dependency-node-${a.definition.flowId}`)).toContainText('Neu berechnen');
  await expect(graph.getByTestId(`dependency-node-${c.definition.flowId}`)).toContainText('Vorgänger aktualisieren');
  await page.getByTestId('flow-run-confirm').check();
  await page.getByTestId('flow-run').click();
  await expect(page.getByTestId('flow-run-detail')).toContainText('blockiert');
  await expect(page.getByTestId('flow-published-object')).toContainText('Revision 1');
  await page.reload();
  await expect(graph.getByTestId(`dependency-node-${c.definition.flowId}`)).toContainText('Vorgänger aktualisieren');
  await page.screenshot({ path: info.outputPath('dependency-desktop.png'), fullPage: true });

  for (const item of [a, b, c]) {
    await graph.getByTestId('dependency-next').click();
    await expect(page).toHaveURL(new RegExp(`id=${item.definition.flowId}`));
    await page.getByTestId('flow-run-confirm').check();
    await page.getByTestId('flow-run').click();
    await expect(page.getByTestId('flow-run-detail')).toContainText('Bereit');
    await expect(page.getByTestId('flow-output-row')).toContainText('Bea');
    await page.getByTestId('flow-publish-confirm').check();
    await page.getByTestId('flow-publish').click();
    await expect(graph.getByTestId(`dependency-node-${item.definition.flowId}`)).toContainText('Aktuell');
  }
  await expect(page.getByTestId('flow-published-object')).toContainText('Revision 2');
  await page.reload();
  for (const item of [a, b, c]) await expect(graph.getByTestId(`dependency-node-${item.definition.flowId}`)).toContainText('Aktuell');
  await expect(graph.getByTestId('dependency-next')).toBeDisabled();
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await graph.screenshot({ path: info.outputPath('dependency-mobile.png') });
});

test('a dependency loading failure is explicit and retry restores authoritative state', async ({ page }) => {
  let fail = true;
  await page.route('**/api/dataflows/dependencies', async route => {
    if (fail) { fail = false; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Abhängigkeiten im Test nicht verfügbar' }) }); }
    else await route.continue();
  });
  await page.goto('/#/dataflows');
  const graph = page.getByTestId('dependency-workspace');
  await expect(graph.getByRole('alert')).toContainText('Abhängigkeiten im Test nicht verfügbar');
  await graph.getByTestId('dependency-refresh').click();
  await expect(graph.getByRole('alert')).toHaveCount(0);
  await expect(graph.locator('[data-testid^="dependency-node-"]').first()).toBeVisible();
});
