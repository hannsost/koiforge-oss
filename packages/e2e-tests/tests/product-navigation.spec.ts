import { expect, test } from './authenticated-fixture.js';

test('empty source welcome opens import directly and keeps source management reachable', async ({ page }, testInfo) => {
  await page.route('http://127.0.0.1:3191/api/datasets', (route) => route.request().method() === 'GET'
    ? route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [] }),
    })
    : route.continue());

  await page.goto('/#/freshness');
  await expect(page.getByRole('heading', { name: 'Quellenalter prüfen' })).toBeVisible();
  await expect(page.getByText('Keine importierte Quelle verfügbar.')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('navigation-desktop.png'), fullPage: true });

  await page.getByRole('button', { name: 'Datenquelle hinzufügen' }).click();
  await expect(page.getByRole('dialog', { name: 'Datenquelle hinzufügen' })).toBeVisible();
  await expect(page).toHaveURL(/#\/freshness$/);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Datenquelle hinzufügen', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Datenquellen verwalten' }).click();
  await expect(page).toHaveURL(/#\/data$/);
  await expect(page.locator('.kf-page-heading').getByRole('heading', { name: 'Datenquellen' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Datenvorschau/ })).toHaveCount(0);
  await expect(page.getByTestId('dataset-search')).toHaveCount(0);
  await expect(page.getByTestId('dataset-filter-field')).toHaveCount(0);
});

test('primary route survives reload and supports browser back and forward', async ({ page }) => {
  await page.goto('/#/freshness');

  await page.getByTestId('nav-data').click();
  await expect(page).toHaveURL(/#\/data$/);
  await expect(page.getByTestId('nav-data')).toHaveAttribute('aria-current', 'page');

  await page.reload();
  await expect(page).toHaveURL(/#\/data$/);
  await expect(page.getByTestId('nav-data')).toHaveAttribute('aria-current', 'page');

  await page.getByTestId('nav-freshness').click();
  await expect(page).toHaveURL(/#\/freshness$/);
  await page.goBack();
  await expect(page).toHaveURL(/#\/data$/);
  await page.goForward();
  await expect(page).toHaveURL(/#\/freshness$/);
});

test('extension examples describe their scope and fit a mobile viewport', async ({ page }, info) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/#/appstore');
  await expect(page.getByRole('button', { name: /^Alle Module/ })).toBeVisible();
  await expect(page.getByText('Installationsumfang:', { exact: true }).first()).toBeVisible();
  for (const label of [/^Alle Module/, /^Beispielmodule/, /^Sandbox-Module/]) {
    await page.getByRole('button', { name: label }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  }
  await page.getByRole('button', { name: /^Alle Module/ }).click();
  await expect(page.getByText(/vollständig Open.Source|ESG.Scoring/)).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('extensions-mobile.png'), fullPage: true });
});

test('tools disclosure is keyboard accessible and mobile navigation restores focus', async ({ page }, testInfo) => {
  const tools = page.locator('details.kf-nav-group').filter({ has: page.locator('summary', { hasText: 'Werkzeuge' }) });
  await page.goto('/#/freshness');
  await expect(tools).toHaveJSProperty('open', false);

  const toolsSummary = tools.locator('summary');
  await toolsSummary.focus();
  await expect(toolsSummary).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(tools).toHaveJSProperty('open', true);
  await page.keyboard.press('Enter');
  await expect(tools).toHaveJSProperty('open', false);

  await page.goto('/#/checks');
  await expect(page.getByTestId('nav-checks')).toBeVisible();
  await expect(tools).toHaveJSProperty('open', true);

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/#/freshness');
  const menuButton = page.getByRole('button', { name: /^(Menü|Schließen)$/ });
  const navigation = page.getByRole('navigation', { name: 'Hauptnavigation' });
  await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
  await expect(navigation.getByTestId('nav-data')).toBeHidden();

  await menuButton.focus();
  await page.keyboard.press('Enter');
  await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
  await expect(navigation.getByTestId('nav-data')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('navigation-mobile.png'), fullPage: true });

  await page.keyboard.press('Escape');
  await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
  await expect(menuButton).toBeFocused();

  await menuButton.focus();
  await page.keyboard.press('Enter');
  await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
  await navigation.getByTestId('nav-data').click();
  await expect(page).toHaveURL(/#\/data$/);
  await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('main')).toBeFocused();

  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(dimensions.document <= dimensions.viewport, JSON.stringify(dimensions)).toBeTruthy();
});

test('import dialog works with keyboard and imports a CSV on mobile', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/#/data');
  const open = page.getByRole('button', { name: 'Datenquelle hinzufügen', exact: true }).first();
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Datenquelle hinzufügen' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('button', { name: 'Dateien auswählen', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('import-mobile-empty.png'), fullPage: true });
  await dialog.locator('input[type=file]').setInputFiles({
    name: 'navigation-import.csv', mimeType: 'text/csv',
    buffer: Buffer.from('id,updated_at\nux-source,2026-09-23T10:00:00Z\n'),
  });
  await expect(dialog.getByRole('heading', { name: 'Datenquelle hinzufügen' })).toBeVisible();
  await expect(dialog.getByText('1 importierbar', { exact: true })).toBeVisible();
  const selection = dialog.getByRole('checkbox').last();
  await selection.check();
  await expect(selection).toBeChecked();
  await dialog.getByRole('button', { name: 'Auswahl importieren', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const previewTable = page.getByTestId('dataset-preview-table');
  await expect(previewTable).toContainText('ux-source');
  const previewBounds = await previewTable.boundingBox();
  expect(previewBounds?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(96);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('sources-mobile-imported.png'), fullPage: true });
});

test('mobile assistant fits the viewport and returns focus on Escape', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/#/freshness');
  const toggle = page.getByRole('button', { name: 'KI-Assistent öffnen oder schließen', exact: true });
  await toggle.click();
  await expect(page.getByRole('region', { name: 'KI-Assistent', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Nachricht an den KI-Assistenten' })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.keyboard.press('Escape');
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await page.getByRole('button', { name: 'KI-Assistent schließen', exact: true }).click();
  await expect(toggle).toBeFocused();
});

test('assistant dismisses after focus leaves and keeps an unsubmitted draft', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/#/freshness');
  const copilot = page.locator('.kf-copilot');
  const toggle = page.getByRole('button', { name: 'KI-Assistent öffnen oder schließen', exact: true });
  await toggle.click();
  const panel = page.getByRole('region', { name: 'KI-Assistent', exact: true });
  const draft = page.getByRole('textbox', { name: 'Nachricht an den KI-Assistenten' });
  await expect(draft).toBeFocused();
  await draft.fill('Entwurf für später');

  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Nachricht senden' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(toggle).toBeFocused();
  await expect(panel).toBeVisible();
  const triggerBounds = await toggle.boundingBox();
  const panelBounds = await panel.boundingBox();
  expect(panelBounds && triggerBounds && panelBounds.y >= triggerBounds.y + triggerBounds.height).toBeTruthy();

  await page.keyboard.press('Tab');
  await expect(panel).toHaveCount(0);
  expect(await copilot.evaluate((element) => element.contains(document.activeElement))).toBe(false);

  await toggle.click();
  await expect(page.getByRole('textbox', { name: 'Nachricht an den KI-Assistenten' })).toHaveValue('Entwurf für später');
});

test('assistant input and dismissal controls stay reachable at short viewport heights', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 400 });
  await page.goto('/#/freshness');
  const toggle = page.getByRole('button', { name: 'KI-Assistent öffnen oder schließen', exact: true });
  await toggle.click();
  const panel = page.getByRole('region', { name: 'KI-Assistent', exact: true });
  const input = page.getByRole('textbox', { name: 'Nachricht an den KI-Assistenten' });
  const send = page.getByRole('button', { name: 'Nachricht senden' });
  await expect(input).toBeFocused();
  await input.fill('Kurzer Entwurf');

  for (const height of [400, 320]) {
    await page.setViewportSize({ width: 320, height });
    await expect(input).toBeVisible();
    await expect(send).toBeVisible();
    const panelBounds = await panel.boundingBox();
    expect(panelBounds && panelBounds.y + panelBounds.height <= height).toBeTruthy();
  }

  await page.keyboard.press('Tab');
  await expect(send).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(toggle).toBeFocused();
  await expect(panel).toBeVisible();
  const panelBounds = await panel.boundingBox();
  const toggleBounds = await toggle.boundingBox();
  expect(panelBounds && toggleBounds && panelBounds.y >= toggleBounds.y + toggleBounds.height).toBeTruthy();
  await page.keyboard.press('Tab');
  await expect(panel).toHaveCount(0);
});

test('a source loading failure offers retry instead of pretending the workspace is empty', async ({ page }) => {
  let fail = true;
  await page.route('http://127.0.0.1:3191/api/datasets', route => {
    if (fail && route.request().method() === 'GET') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Test: Quelle vorübergehend nicht erreichbar' }) });
    return route.continue();
  });
  await page.goto('/#/data');
  await expect(page.getByRole('alert')).toContainText('Datenquellen konnten nicht geladen werden');
  await expect(page.getByText('Noch keine Datenquelle vorhanden.', { exact: true })).toHaveCount(0);
  fail = false;
  await page.getByRole('button', { name: 'Erneut laden', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText(/^\d+ Quellen?$/, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Datenquelle hinzufügen', exact: true })).toBeVisible();
});


test('sidebar account stays visible while long navigation scrolls', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/freshness");
  const sidebar = page.getByRole('complementary', { name: 'Arbeitsbereich', exact: true });
  const logout = sidebar.getByRole('button', { name: 'Abmelden', exact: true });
  const measurements = [];
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 600 }, { width: 320, height: 400 }]) {
    await page.setViewportSize(viewport);
    if (viewport.width === 320) {
      await expect(logout).toBeHidden();
      await page.locator('button[aria-controls="workspace-navigation"]').click();
    }
    await expect(logout).toBeInViewport();
    await sidebar.locator('nav details').evaluateAll(elements => elements.forEach(element => { (element as HTMLDetailsElement).open = true; }));
    const scroll = sidebar.locator('.nf-sidebar-scroll');
    const before = await logout.boundingBox();
    await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
    expect(await scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    const after = await logout.boundingBox();
    expect(after!.y).toBeCloseTo(before!.y, 0);
    expect(after!.x).toBe(18);
    expect(after!.height).toBe(44);
    expect(after!.y + after!.height).toBeLessThanOrEqual(viewport.height);
    if (viewport.width > 850) expect(viewport.height - after!.y - after!.height).toBe(18);
    expect(await logout.evaluate(element => { const r = element.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!hit && element.contains(hit); })).toBe(true);
    await logout.focus(); await expect(logout).toBeFocused();
    measurements.push({ viewport, bounds: after, styles: await logout.evaluate(element => { const css = getComputedStyle(element); const icon = element.querySelector('svg')!.getBoundingClientRect(); return { font: css.fontFamily, size: css.fontSize, weight: css.fontWeight, color: css.color, background: css.backgroundColor, padding: css.padding, gap: css.gap, iconWidth: icon.width, iconHeight: icon.height }; }) });
    await page.screenshot({ path: info.outputPath(`sidebar-${viewport.width}x${viewport.height}.png`) });
  }
  await (await import('node:fs/promises')).writeFile(info.outputPath('sidebar-comparison.json'), JSON.stringify(measurements, null, 2));
});
