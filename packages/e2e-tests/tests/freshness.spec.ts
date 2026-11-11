import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './authenticated-fixture.js';

test.describe.configure({ mode: 'serial' });
test.use({ timezoneId: 'Europe/Berlin' });

const apiUrl = 'http://127.0.0.1:3191';
const question = 'Welche Quellen müssen aktualisiert oder geklärt werden?';
const asOf = '2026-09-22T12:00:00Z';

function watchBrowserErrors(page: Page): { pageErrors: string[]; consoleErrors: string[] } {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  return { pageErrors, consoleErrors };
}

async function importFreshnessCsv(request: APIRequestContext, name = 'freshness.csv'): Promise<string> {
  const csv = [
    'id,updated',
    'source-current,2026-09-22T11:30:00Z',
    'source-stale,2026-09-22T10:00:00Z',
    'source-missing,',
    'source-invalid,not-a-timestamp',
  ].join('\n');

  const upload = await request.post(`${apiUrl}/api/import/sessions`, {
    multipart: {
      file: {
        name,
        mimeType: 'text/csv',
        buffer: Buffer.from(csv),
      },
    },
  });
  expect(upload.ok(), await upload.text()).toBeTruthy();
  const session = (await upload.json()).session as {
    id: string;
    nodes: Record<string, { id: string; capabilityId?: string; children: string[]; status: string }>;
  };
  const sourceNode = Object.values(session.nodes).find((node) => node.capabilityId === 'csv-file' && node.children.length === 0);
  expect(sourceNode, 'CSV source node should be importable').toBeTruthy();

  const run = await request.post(`${apiUrl}/api/import/sessions/${session.id}/run`, {
    data: { selectedNodeIds: [sourceNode!.id] },
  });
  expect(run.ok(), await run.text()).toBeTruthy();
  const importedDatasets = (await run.json()).importedDatasets as Array<{ id: string; connectorId: string }>;
  expect(importedDatasets).toHaveLength(1);
  expect(importedDatasets[0]?.connectorId).toBe('inline');
  return importedDatasets[0]!.id;
}

test('starts empty and exposes the Quellenalter prüfen entry', async ({ page }) => {
  const browserErrors = watchBrowserErrors(page);
  await page.goto('/');

  await expect(page.locator('#root > div').first()).toHaveCSS('display', 'flex');
  await expect(page.getByTestId('nav-freshness')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Quellenalter prüfen' })).toBeVisible();
  await expect(page.getByText('Keine importierte Quelle verfügbar.')).toBeVisible();
  expect(browserErrors.pageErrors).toEqual([]);
  expect(browserErrors.consoleErrors).toEqual([]);
});

test('imports a complete source, runs the comparison, and keeps evidence in browser history', async ({ page, request }) => {
  const browserErrors = watchBrowserErrors(page);
  const datasetId = await importFreshnessCsv(request);

  await page.goto('/');
  await expect(page.getByLabel('Importierte Quelle')).toBeVisible();
  await expect(page.getByLabel('Importierte Quelle')).toHaveValue(datasetId);
  await page.getByLabel('Quellschlüssel').selectOption('id');
  await page.getByLabel('Aktualisierungszeitpunkt', { exact: true }).selectOption('updated');

  const execute = page.getByRole('button', { name: 'Quellenalter prüfen' });
  await expect(execute).toBeEnabled();
  await execute.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toContainText('bestätige');

  // A normal local date/time entry must produce the correct UTC instant.
  await page.getByLabel('Stichtag', { exact: true }).fill('2026-09-22T14:00');
  await page.getByLabel('Maximales Quellenalter', { exact: true }).fill('3600');
  await page.getByLabel('Einheit für maximales Quellenalter').selectOption('seconds');
  await page.getByRole('checkbox').check();
  const creation = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/analysis/freshness'));
  await execute.click();
  expect(new Date((await creation).postDataJSON().rule.asOf).toISOString()).toBe(new Date(asOf).toISOString());

  await expect(page.getByText('mit Lücken abgeschlossen', { exact: true }).last()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('aktuell', { exact: true })).toBeVisible();
  await expect(page.getByText('veraltet', { exact: true })).toBeVisible();
  await expect(page.getByText('nicht beurteilbar', { exact: true })).toHaveCount(2);
  await expect(page.getByText('source-current · 2026-09-22T11:30:00Z')).toBeVisible();
  await expect(page.getByText('Zeitstempel fehlt', { exact: true })).toBeVisible();
  await expect(page.getByText('Zeitstempel ist ungültig', { exact: true })).toBeVisible();
  await expect(page.getByText('Quellen geprüft').locator('..')).toContainText('4');
  await expect(page.getByText('Datenstand', { exact: true }).last().locator('..')).toContainText('vollständig');

  await page.getByText('Snapshot und Wiederverwendung', { exact: true }).click();
  await expect(page.getByText('Snapshot-Hash:')).toBeVisible();
  await expect(page.getByText('Modul-Hash:')).toBeVisible();
  await expect(page.getByText('Generierung:')).toBeVisible();
  await page.screenshot({ path: 'test-results-freshness/freshness-desktop.png', fullPage: true });

  await page.reload();
  await expect(page.getByRole('button', { name: new RegExp(question) })).toBeVisible();
  await page.getByRole('button', { name: new RegExp(question) }).click();
  await expect(page.getByText('Quellen geprüft').locator('..')).toContainText('4');
  await expect(page.getByText('Erlaubtes Quellenalter', { exact: true }).locator('..')).toContainText('1 h');
  await expect(page.getByText('Erlaubtes Quellenalter', { exact: true }).locator('..')).toContainText('3.600 s');
  await expect(page.getByText('aktuell', { exact: true })).toBeVisible();
  expect(browserErrors.pageErrors).toEqual([]);
  expect(browserErrors.consoleErrors).toEqual([]);
});

test('supports keyboard operation and remains usable at 375px without horizontal overflow', async ({ page }) => {
  const browserErrors = watchBrowserErrors(page);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/');

  await expect(page.locator('#root > div').first()).toHaveCSS('display', 'flex');
  await expect(page.getByTestId('nav-freshness')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Menü', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Quellenalter prüfen' })).toBeVisible();
  const formHeading = await page.getByRole('heading', { name: 'Quellenalter prüfen' }).boundingBox();
  expect(formHeading?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(800);
  const historyRun = page.getByRole('button', { name: new RegExp(question) });
  await expect(historyRun).toBeVisible();
  await historyRun.click();
  await page.getByText('Snapshot und Wiederverwendung', { exact: true }).click();
  const mobileDimensions = await page.evaluate(() => {
    const viewport = window.innerWidth;
    const offenders = [...document.querySelectorAll<HTMLElement>('*')]
      .map((element) => ({ element: element.tagName.toLowerCase(), text: (element.innerText ?? '').slice(0, 80), className: element.className, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right }))
      .filter((entry) => entry.right > viewport + 1 || entry.left < -1)
      .sort((a, b) => (b.right - viewport) - (a.right - viewport))
      .slice(0, 8);
    return { viewport, scrollWidth: document.documentElement.scrollWidth, offenders };
  });
  expect(mobileDimensions.scrollWidth <= mobileDimensions.viewport, JSON.stringify(mobileDimensions)).toBeTruthy();
  await page.getByRole('button', { name: 'Menü', exact: true }).click();
  await page.getByTestId('nav-freshness').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Quellenalter prüfen' })).toBeVisible();
  await page.screenshot({ path: 'test-results-freshness/freshness-mobile.png', fullPage: true });
  expect(browserErrors.pageErrors).toEqual([]);
  expect(browserErrors.consoleErrors).toEqual([]);
});

test('imports from the analysis form and continues with the new source and existing draft on mobile', async ({ page }, info) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/#/freshness');
  await page.getByLabel('Bezeichnung der Auswertung').fill('Wöchentliche Prüfung meiner Quellen');
  await page.getByRole('button', { name: 'Datenquelle hinzufügen', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Datenquelle hinzufügen' });
  await dialog.locator('input[type=file]').setInputFiles({
    name: 'journey-source.csv', mimeType: 'text/csv',
    buffer: Buffer.from('id,updated_at\n00123,2026-09-23T10:00:00Z\n'),
  });
  await expect(dialog.getByText('1 importierbar', { exact: true })).toBeVisible();
  await dialog.getByRole('checkbox').last().check();
  await dialog.getByRole('button', { name: 'Auswahl importieren', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/#\/freshness$/);
  await expect(page.getByLabel('Importierte Quelle').locator('option:checked')).toContainText('journey');
  await expect(page.getByLabel('Bezeichnung der Auswertung')).toHaveValue('Wöchentliche Prüfung meiner Quellen');
  await page.getByLabel('Stichtag', { exact: true }).fill('2026-09-23T14:00');
  await page.getByRole('checkbox').check();
  const execute = page.getByRole('button', { name: 'Quellenalter prüfen', exact: true });
  await expect(execute).toBeEnabled();
  await execute.click();
  await expect(page.getByLabel('Zusammenfassung der Auswertung')).toContainText('1 von 1 Quellen');
  await expect(page.getByText('00123 · 2026-09-23T10:00:00Z')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: info.outputPath('analysis-import-result-mobile.png'), fullPage: true });
});

test('missing model blocks new analysis and readiness can recover without losing input or history', async ({ page }) => {
  let ready = false;
  await page.route(`${apiUrl}/api/analysis/freshness/readiness`, route => ready ? route.continue() : route.fulfill({
    contentType: 'application/json', body: JSON.stringify({
      ready: false, capability: 'missing', provider: 'missing', runtime: 'ready', checkedAt: new Date().toISOString(),
    }),
  }));
  await page.goto('/#/freshness');
  const execute = page.getByRole('button', { name: 'Quellenalter prüfen', exact: true });
  await expect(page.getByRole('link', { name: 'KI-Modell einrichten' })).toBeVisible();
  await expect(execute).toBeDisabled();
  await page.getByLabel('Bezeichnung der Auswertung').fill('Entwurf trotz fehlender Einrichtung');
  await page.getByRole('button', { name: new RegExp(question) }).click();
  await expect(page.getByLabel('Zusammenfassung der Auswertung')).toContainText('1 von 4 Quellen');
  ready = true;
  await page.getByRole('button', { name: 'Erneut prüfen', exact: true }).click();
  await expect(execute).toBeEnabled();
  await expect(page.getByLabel('Bezeichnung der Auswertung')).toHaveValue('Entwurf trotz fehlender Einrichtung');
  await page.getByLabel('Maximales Quellenalter', { exact: true }).fill('48');
  await page.getByTestId('nav-data').click();
  await page.getByTestId('nav-freshness').click();
  await expect(page.getByLabel('Bezeichnung der Auswertung')).toHaveValue('Entwurf trotz fehlender Einrichtung');
  await expect(page.getByLabel('Maximales Quellenalter', { exact: true })).toHaveValue('48');
});

test('dataset failure keeps saved evidence accessible and offers retry', async ({ page }) => {
  let fail = true;
  await page.route(`${apiUrl}/api/datasets`, route => fail ? route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Test: storage unavailable' }),
  }) : route.continue());
  await page.goto('/#/freshness');
  await expect(page.getByRole('alert')).toContainText('Datenquellen konnten nicht geladen werden');
  await expect(page.getByText('Keine importierte Quelle verfügbar.')).toHaveCount(0);
  await page.getByRole('button', { name: new RegExp(question) }).click();
  await expect(page.getByLabel('Zusammenfassung der Auswertung')).toContainText('1 von 4 Quellen');
  fail = false;
  await page.getByRole('button', { name: 'Datenquellen erneut laden', exact: true }).click();
  await expect(page.getByLabel('Importierte Quelle')).toBeVisible();
  await expect(page.getByLabel('Zusammenfassung der Auswertung')).toContainText('1 von 4 Quellen');
});

test('nonexistent or ambiguous local clock times require an explicit timezone', async ({ page }) => {
  await page.goto('/#/freshness');
  const execute = page.getByRole('button', { name: 'Quellenalter prüfen', exact: true });
  await expect(execute).toBeEnabled();
  for (const value of ['2026-03-29T02:30', '2026-10-25T02:30']) {
    await page.getByLabel('Stichtag', { exact: true }).fill(value);
    await execute.click();
    await expect(page.getByRole('alert')).toContainText('eindeutiger Zeitzone');
  }
  await page.getByLabel('Zeitzone des Stichtags').selectOption('iso');
  await page.getByLabel('Stichtag mit explizitem Offset').fill('2026-10-25T02:30:00+02:00');
  await execute.click();
  await expect(page.getByRole('alert')).toContainText('bestätige');
});

test('partial imports stay open and retry returns every successfully imported source', async ({ page, request }) => {
  await page.goto('/#/freshness');
  await page.getByRole('button', { name: 'Datenquelle hinzufügen', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Datenquelle hinzufügen' });
  let uploads = 0;
  page.on('request', event => {
    if (event.method() === 'POST' && event.url() === `${apiUrl}/api/import/sessions`) uploads += 1;
  });
  await dialog.locator('input[type=file]').setInputFiles([
    { name: 'empty.csv', mimeType: 'text/csv', buffer: Buffer.alloc(0) },
    { name: 'valid.csv', mimeType: 'text/csv', buffer: Buffer.from('id,updated_at\nkeep,2026-09-23T10:00:00Z\n') },
  ]);
  await expect(dialog.getByRole('alert')).toContainText('Leere Dateien');
  expect(uploads).toBe(0);

  const discovery = page.waitForResponse(response => response.request().method() === 'POST' && response.url() === `${apiUrl}/api/import/sessions`);
  await dialog.locator('input[type=file]').setInputFiles(['partial-a.csv', 'partial-b.csv'].map(name => ({
    name, mimeType: 'text/csv', buffer: Buffer.from(`id,updated_at\n${name},2026-09-23T10:00:00Z\n`),
  })));
  const session = (await (await discovery).json()).session;
  const conflict = Object.values(session.nodes).find((node: any) => node.label === 'partial-b.csv') as any;
  expect(conflict).toBeTruthy();
  await dialog.getByRole('checkbox', { name: 'partial-a.csv importieren', exact: true }).check();
  await dialog.getByRole('checkbox', { name: 'partial-b.csv importieren', exact: true }).check();
  const seed = await request.post(`${apiUrl}/api/datasets/inline`, { data: {
    name: conflict.config.datasetName, namespace: conflict.config.namespace,
    rows: [{ id: 'existing-source', updated_at: '2026-09-23T10:00:00Z' }],
  } });
  expect(seed.ok(), await seed.text()).toBeTruthy();
  const firstRun = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/api/import/sessions/${session.id}/run`));
  await dialog.getByRole('button', { name: 'Auswahl importieren', exact: true }).click();
  const firstId = (await (await firstRun).json()).importedDatasets[0].id;
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('alert')).toContainText('1 fehlgeschlagen');
  await dialog.getByRole('button', { name: /partial-b\.csv/ }).click();
  await dialog.getByLabel('Name der Datenquelle', { exact: false }).fill('partial-b-retry');
  await dialog.getByRole('button', { name: 'Angaben speichern', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Angaben speichern', exact: true })).toBeEnabled();
  const secondRun = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/api/import/sessions/${session.id}/run`));
  await dialog.getByRole('button', { name: 'Auswahl importieren', exact: true }).click();
  const secondId = (await (await secondRun).json()).importedDatasets[0].id;
  await expect(dialog).toHaveCount(0);
  const source = page.getByLabel('Importierte Quelle');
  await expect(source.locator(`option[value="${firstId}"]`)).toHaveCount(1);
  await expect(source.locator(`option[value="${secondId}"]`)).toHaveCount(1);
});

test('shows local Codex readiness without asking for an API key', async ({ page, request }) => {
  // Own the required source so this readiness case can run independently.
  const datasetId = await importFreshnessCsv(request, 'codex-readiness.csv');
  type ReadinessState = 'missing' | 'ready' | 'disabled';
  let state: ReadinessState = 'missing';
  const readinessUrl = `${apiUrl}/api/analysis/freshness/readiness`;
  await page.route(readinessUrl, async (route) => {
    const response = state === 'missing'
      ? {
        ready: false,
        capability: 'missing',
        provider: 'missing',
        runtime: 'ready',
        checkedAt: '2026-09-23T12:00:00Z',
        generation: {
          backend: 'codex',
          model: 'gpt-6-astra',
          reasoningEffort: 'xhigh',
          available: false,
          reason: 'Codex benötigt die lokale ChatGPT-Anmeldung.',
        },
      }
      : state === 'ready'
        ? {
          ready: true,
          capability: 'missing',
          provider: 'configured',
          runtime: 'ready',
          checkedAt: '2026-09-23T12:00:00Z',
          generation: {
            backend: 'codex',
            model: 'gpt-6-astra',
            reasoningEffort: 'xhigh',
            available: true,
          },
        }
        : {
          ready: false,
          capability: 'missing',
          provider: 'disabled',
          runtime: 'ready',
          checkedAt: '2026-09-23T12:00:00Z',
          generation: {
            backend: 'codex',
            model: 'gpt-6-astra',
            reasoningEffort: 'xhigh',
            available: true,
          },
        };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(response) });
  });

  await page.goto('/#/freshness');
  await page.getByLabel('Importierte Quelle').selectOption(datasetId);
  const readiness = page.locator('section[aria-label="Bereitschaft der Auswertung"]');
  const execute = page.getByRole('button', { name: 'Quellenalter prüfen', exact: true });
  await expect(readiness).toContainText('Codex benötigt die lokale ChatGPT-Anmeldung.');
  await expect(execute).toBeDisabled();
  await expect(readiness.getByRole('link', { name: 'KI-Modell einrichten' })).toHaveCount(0);

  await page.getByLabel('Bezeichnung der Auswertung').fill('Lokale Codex-Prüfung');
  state = 'ready';
  await readiness.getByRole('button', { name: 'Erneut prüfen', exact: true }).click();
  await expect(execute).toBeEnabled();
  await expect(readiness).toContainText('Codex · Astra · xhigh');
  await expect(page.getByLabel('Bezeichnung der Auswertung')).toHaveValue('Lokale Codex-Prüfung');

  state = 'disabled';
  await readiness.getByRole('button', { name: 'Erneut prüfen', exact: true }).click();
  await expect(execute).toBeDisabled();
  await expect(readiness).toContainText('Das Erzeugen neuer Fähigkeiten ist vom Betreiber deaktiviert.');
});
