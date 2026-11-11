import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './authenticated-fixture.js';

const api = 'http://127.0.0.1:3191';
async function importCsv(request: APIRequestContext, content: string): Promise<string> {
  const uploaded = await request.post(`${api}/api/import/sessions`, { multipart: { file: {
    name: `mission-${randomUUID()}.csv`, mimeType: 'text/csv', buffer: Buffer.from(content),
  } } });
  expect(uploaded.ok(), await uploaded.text()).toBeTruthy();
  const session = (await uploaded.json()).session;
  const leaf = Object.values(session.nodes).find((node: any) => node.capabilityId === 'csv-file' && node.children.length === 0) as { id: string };
  expect(leaf).toBeTruthy();
  const imported = await request.post(`${api}/api/import/sessions/${session.id}/run`, { data: { selectedNodeIds: [leaf.id] } });
  expect(imported.ok(), await imported.text()).toBeTruthy();
  return (await imported.json()).importedDatasets[0].id;
}
async function plan(page: Page, datasetId: string, question: string): Promise<string> {
  await page.goto('/#/missions');
  await expect(page.getByTestId('mission-source')).toBeVisible();
  await page.getByTestId('mission-source').selectOption(datasetId);
  await page.getByTestId('mission-question').fill(question);
  await page.getByTestId('mission-plan').click();
  await expect(page).toHaveURL(/#\/missions\?id=[a-f0-9-]+/);
  return new URLSearchParams(page.url().split('?')[1]).get('id')!;
}

test('failed entry script shows recovery before React loads and manual reload keeps the mission route', async ({ page }) => {
  let blocked = true;
  await page.route(/\/(?:src\/main\.tsx|assets\/index-[^/]+\.js)(?:\?|$)/,
    route => blocked ? route.abort('failed') : route.continue());
  await page.goto('/#/missions');
  await expect(page.getByRole('alert')).toContainText('nicht geladen');
  await expect(page.getByRole('button', { name: 'Neu laden', exact: true })).toBeVisible();
  blocked = false;
  await page.getByRole('button', { name: 'Neu laden', exact: true }).click();
  await expect(page.getByTestId('mission-source')).toBeVisible();
  await expect(page).toHaveURL(/#\/missions$/);
  await expect(page.getByRole('button', { name: 'Neu laden', exact: true })).toHaveCount(0);
});

test('guided mission persists plan, explicit confirmation, complete-source findings and evidence across navigation and reload', async ({ page, request }, info) => {
  const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message));
  const datasetId = await importCsv(request, 'id,email,amount\nA,synthetic-a@example.test,0\nA,,10\nB, ,20\n');
  const id = await plan(page, datasetId, 'Welche Werte fehlen und welche IDs sind doppelt?');
  await expect(page.getByTestId('mission-confirm')).toBeVisible({ timeout: 15_000 });
  let startsWithoutConfirmation = 0;
  page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith(`/api/missions/${id}/run`)) startsWithoutConfirmation++; });
  await page.getByTestId('mission-run').click();
  await expect(page.getByRole('alert')).toContainText('Prüfumfang bestätigen');
  expect(startsWithoutConfirmation).toBe(0);
  await page.getByTestId('nav-data').click();
  await page.goto(`/#/missions?id=${id}`);
  await expect(page.getByTestId('mission-confirm')).toBeVisible();
  await page.getByTestId('mission-key-field').selectOption('id');
  await page.getByTestId('mission-confirm').check();
  await page.getByTestId('mission-run').click();
  await expect(page.getByTestId('mission-result')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('mission-result')).toContainText('3 Datensätze vollständig geprüft');
  await expect(page.getByTestId('mission-result')).toContainText('Doppelter Schlüssel');
  await expect(page.getByTestId('mission-result')).toContainText('1, 2');
  const saved = (await (await request.get(`${api}/api/missions/${id}`)).json()).mission;
  expect(saved.result.counts).toMatchObject({ sourceRows: 3, missingCells: 2, duplicateGroups: 1, duplicateRows: 2 });
  expect(saved.result.evidence.sourceHash).toBe(saved.source.hash);
  expect(saved.plan.generation).toEqual({ backend: 'codex', model: 'gpt-6-astra', reasoningEffort: 'xhigh' });
  await page.reload();
  await expect(page.getByTestId('mission-result')).toContainText('3 Datensätze vollständig geprüft');
  await page.screenshot({ path: info.outputPath('mission-quality-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: info.outputPath('mission-quality-mobile.png'), fullPage: true });
  expect(pageErrors).toEqual([]);
});

test('source freshness mission confirms time semantics and retains independently verified analysis evidence', async ({ page, request }, info) => {
  const datasetId = await importCsv(request, 'id,updated\ncurrent,2026-09-22T11:30:00Z\nstale,2026-09-22T10:00:00Z\nunknown,\n');
  const id = await plan(page, datasetId, 'Bitte das Quellenalter prüfen.');
  await expect(page.getByTestId('mission-confirm')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('mission-key-field').selectOption('id');
  await page.getByRole('combobox', { name: 'Aktualisierungszeitpunkt', exact: true }).selectOption('updated');
  await page.getByRole('combobox', { name: 'Zeitzone des Stichtags', exact: true }).selectOption('iso');
  await page.getByLabel('Stichtag mit explizitem Offset').fill('2026-09-22T12:00:00Z');
  await page.getByLabel('Maximales Quellenalter in Stunden').fill('1');
  await page.getByTestId('mission-confirm').check();
  await page.getByTestId('mission-run').click();
  await expect(page.getByTestId('mission-result')).toContainText('1 aktuell, 1 veraltet, 1 nicht beurteilbar.', { timeout: 15_000 });
  const saved = (await (await request.get(`${api}/api/missions/${id}`)).json()).mission;
  expect(saved.result.evidence.analysisRunId).toMatch(/^[a-f0-9-]+$/);
  expect(saved.result.evidence.moduleHash).toMatch(/^[a-f0-9]{64}$/);
  expect(saved.result.evidence.sourceHash).toBe(saved.source.hash);
  await page.getByText('Belege und Datenstand', { exact: true }).click();
  await expect(page.getByTestId('mission-result')).toContainText(saved.result.evidence.analysisRunId);
  await page.screenshot({ path: info.outputPath('mission-freshness-desktop.png'), fullPage: true });
});

test('unsupported question remains a visible capability gap and mobile layout stays within the viewport', async ({ page, request }, info) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const datasetId = await importCsv(request, 'id,email\nA,synthetic@example.test\n');
  const id = await plan(page, datasetId, 'Welche Lieferungen werden morgen verspätet sein?');
  await expect(page.getByText('Für Lieferprognosen fehlt eine ausführbare Fähigkeit.', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('mission-run')).toHaveCount(0);
  const saved = (await (await request.get(`${api}/api/missions/${id}`)).json()).mission;
  expect(saved.status).toBe('blocked'); expect(saved.plan.capabilityId).toBeNull(); expect(saved.result).toBeUndefined();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: info.outputPath('mission-capability-gap-mobile.png'), fullPage: true });
  await page.reload();
  await expect(page.getByText('Für Lieferprognosen fehlt eine ausführbare Fähigkeit.', { exact: true }).first()).toBeVisible();
});

test('mission route requires authentication and unknown source never becomes a successful result', async ({ page, request }) => {
  // The authenticated fixture's request context checks the actual API error path.
  const created = await request.post(`${api}/api/missions`, { data: { requestId: randomUUID(), question: 'Fehlende Werte prüfen', datasetId: 'source-does-not-exist' } });
  expect(created.status()).toBe(202);
  const id = (await created.json()).mission.id;
  await expect.poll(async () => (await (await request.get(`${api}/api/missions/${id}`)).json()).mission.status).toBe('blocked');
  const failed = (await (await request.get(`${api}/api/missions/${id}`)).json()).mission;
  expect(failed.result).toBeUndefined();
  await page.context().clearCookies();
  const denied = await page.request.get(`${api}/api/missions/${id}`);
  expect(denied.status()).toBe(401);
});
