import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './authenticated-fixture.js';

const api = 'http://127.0.0.1:3191';
async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(`${api}/api/${path}`, { data });
  expect(response.ok(), await response.text()).toBeTruthy(); return response.json();
}
async function source(request: APIRequestContext, rows: Array<Record<string, string | null>>) {
  return post(request, 'datasets/inline', { name: `orders-${randomUUID()}`, namespace: 'order-browser', rows });
}
async function fixture(request: APIRequestContext) {
  const fromSource = await source(request, [
    { id: 'late', supplier: 'S', status: 'teilgeliefert', due: '2026-09-20' },
    { id: 'today', supplier: 'S', status: 'offen', due: '2026-09-23' },
    { id: 'unknown', supplier: 'S', status: 'ungekannt', due: '2026-01-01' },
    { id: 'no-date', supplier: 'U', status: 'offen', due: null },
    { id: 'closed', supplier: 'U', status: 'erledigt', due: '2026-01-01' },
    { id: null, supplier: 'S', status: 'offen', due: '2026-01-01' },
  ]);
  const toSource = await source(request, [{ id: 'S', name: 'Synthetischer Lieferant' }]);
  const from = (await post(request, 'model/object-sets', { name: 'Bestellungen', datasetId: fromSource.id,
    keyField: 'id', confirmed: true, requestId: randomUUID() })).objectSet;
  const to = (await post(request, 'model/object-sets', { name: 'Lieferanten', datasetId: toSource.id,
    keyField: 'id', labelField: 'name', confirmed: true, requestId: randomUUID() })).objectSet;
  const relation = (await post(request, 'model/relationships', { name: 'Bestellung gehört zu Lieferant', fromSetId: from.id,
    toSetId: to.id, fromField: 'supplier', confirmed: true, requestId: randomUUID() })).relationship;
  return { fromSource, toSource, from, to, relation };
}
const choice = (page: Page, value: string) => page.getByTestId('mission-order-status-choice').and(page.locator(`[data-status-value="${value}"]`));
async function plan(page: Page, relationId: string) {
  await page.goto(`/#/model?relationship=${relationId}`);
  await page.getByTestId('semantic-check-orders').click();
  await expect(page).toHaveURL(/task=orders/);
  await page.getByTestId('mission-plan').click();
  await expect(page.getByTestId('mission-order-status-values')).toBeVisible({ timeout: 15_000 });
  return new URLSearchParams(page.url().split('?')[1]).get('id')!;
}
async function fillRules(page: Page, due = true) {
  await choice(page, 'offen').selectOption('open');
  await choice(page, 'teilgeliefert').selectOption('open');
  await choice(page, 'erledigt').selectOption('closed');
  await page.getByTestId('mission-order-as-of').fill('2026-09-23');
  await page.getByTestId('mission-order-date-meaning').selectOption(due ? 'promised_delivery_day' : 'not_available');
  if (due) await page.getByTestId('mission-order-due-date-field').selectOption('due');
}

test('confirmed business rules prioritize orders, keep missing dates visible and survive removed live sources and reload', async ({ page, request }, info) => {
  const f = await fixture(request);
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const id = await plan(page, f.relation.id);
  for (const value of ['offen', 'teilgeliefert', 'erledigt', 'ungekannt']) await expect(choice(page, value)).toHaveValue('');
  let runs = 0; page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith(`/missions/${id}/run`)) runs++; });
  await page.getByTestId('mission-run').click();
  await expect(page.getByRole('alert')).toContainText('mindestens einen'); expect(runs).toBe(0);
  await fillRules(page);
  await page.getByTestId('mission-run').click();
  await expect(page.getByRole('alert')).toContainText('ausdrücklich bestätigen'); expect(runs).toBe(0);
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: info.outputPath('order-confirmation-mobile.png'), fullPage: true });
  // The catalogue and confirmation must still refer to exactly the frozen plan.
  expect((await request.delete(`${api}/api/datasets/${f.fromSource.id}`)).ok()).toBeTruthy();
  expect((await request.delete(`${api}/api/datasets/${f.toSource.id}`)).ok()).toBeTruthy();
  await page.reload();
  await expect(choice(page, 'offen')).toHaveValue('open');
  await expect(choice(page, 'ungekannt')).toHaveValue('');
  await expect(page.getByTestId('mission-confirm')).not.toBeChecked();
  await page.getByTestId('mission-confirm').check();
  await page.getByTestId('mission-order-as-of').fill('2026-09-24');
  await expect(page.getByTestId('mission-confirm')).not.toBeChecked();
  await page.getByTestId('mission-order-as-of').fill('2026-09-23');
  await page.getByTestId('mission-confirm').check();
  await page.getByTestId('mission-run').click();
  const result = page.getByTestId('mission-result');
  await expect(result).toContainText('6 Quellzeilen', { timeout: 15_000 });
  const m = (await (await request.get(`${api}/api/missions/${id}`)).json()).mission;
  expect(m.result.counts).toEqual({ sourceRows: 6, overdueRows: 1, openRows: 2, closedRows: 1,
    unassessableRows: 2, clarificationRows: 4, deadlineUnassessableRows: 1 });
  expect(m.result.rows[0]).toMatchObject({ Befund: 'Überfällig', Quellzeile: 1, 'Tage überfällig': 3 });
  expect(m.result.rows.find((row: any) => row.Quellzeile === 4)).toMatchObject({ Befund: 'Offen', Terminbeurteilung: 'Nicht beurteilbar' });
  expect(m.result.evidence).toMatchObject({ sourceHash: f.from.source.hash, targetSourceHash: f.to.source.hash,
    fromSnapshotHash: f.from.snapshotHash, toSnapshotHash: f.to.snapshotHash });
  expect(m.result.evidence.orderRuleHash).toMatch(/^[a-f0-9]{64}$/);
  await page.reload();
  await expect(page.getByTestId('mission-order-rules')).toContainText('teilgeliefert');
  await expect(page.getByTestId('mission-order-rules')).toContainText('2026-09-23');
  await expect(result).toContainText('Zugesagter Liefertag fehlt');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  const findings = result.getByRole('region'); await findings.scrollIntoViewIfNeeded();
  await expect(findings.getByRole('columnheader', { name: 'Befund', exact: true })).toBeInViewport();
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath('order-result-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: info.outputPath('order-result-desktop.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('without an available promised day, open orders never become overdue and saved rules remain explicit', async ({ page, request }) => {
  const f = await fixture(request); const id = await plan(page, f.relation.id);
  await fillRules(page, false);
  await page.getByTestId('mission-confirm').check(); await page.getByTestId('mission-run').click();
  await expect(page.getByTestId('mission-result')).toContainText('6 Quellzeilen', { timeout: 15_000 });
  const m = (await (await request.get(`${api}/api/missions/${id}`)).json()).mission;
  expect(m.result.counts).toMatchObject({ overdueRows: 0, openRows: 3, deadlineUnassessableRows: 3 });
  expect(m.input.binding).toEqual({ statusField: 'status' });
  await expect(page.getByTestId('mission-order-rules')).toContainText('Kein Liefertermin verfügbar');
});

test('status lookup failure blocks confirmation and a changed field clears earlier classifications', async ({ page, request }) => {
  const f = await fixture(request); let fail = true;
  await page.route('**/api/missions/*/order-statuses?**', route => fail
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Statuswerte vorübergehend nicht verfügbar.' }) }) : route.continue());
  await page.goto(`/#/missions?relationship=${f.relation.id}&task=orders`);
  await page.getByTestId('mission-plan').click();
  await expect(page.getByRole('alert')).toContainText('Statuswerte vorübergehend');
  await expect(page.getByTestId('mission-run')).toBeDisabled();
  await expect(page.getByTestId('mission-order-status-values')).toHaveCount(0);
  fail = false; await page.getByRole('button', { name: 'Statuswerte erneut laden' }).click();
  await expect(choice(page, 'offen')).toHaveValue('');
  await choice(page, 'offen').selectOption('open');
  await page.getByTestId('mission-confirm').check();
  await page.getByTestId('mission-order-status-field').selectOption('supplier');
  await expect(choice(page, 'S')).toHaveValue('');
  await expect(page.getByTestId('mission-confirm')).not.toBeChecked();
  await page.getByTestId('mission-order-status-field').selectOption('status');
  await expect(choice(page, 'offen')).toHaveValue('');
});
