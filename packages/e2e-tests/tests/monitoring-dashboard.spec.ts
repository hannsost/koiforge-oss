import { test, expect, type Page } from '@playwright/test';

const definitions = [
  ['node.cpu.utilization', 'node', 'percent', 24], ['node.memory.utilization', 'node', 'percent', 48],
  ['node.filesystem.free', 'node', 'bytes', 25 * 1024 ** 3], ['kubernetes.pods.not-ready', 'kubernetes', 'count', 0],
  ['kubernetes.deployments.unavailable', 'kubernetes', 'count', 0], ['flux.reconciliation.failed', 'flux', 'count', 0],
  ['tls.cert.expiry-days', 'tls', 'days', 65], ['backup.age-hours', 'backup', 'hours', 8],
  ['endpoint.https.up', 'endpoint', 'boolean', 1], ['endpoint.probe.age-hours', 'endpoint', 'hours', .1],
  ['endpoint.probe.targets', 'endpoint', 'count', 11], ['alerts.active', 'alerts', 'count', 0],
  ['kubernetes.containers.restarts', 'kubernetes', 'count', 0], ['kubernetes.nodes.pressure', 'kubernetes', 'count', 0],
  ['monitoring.scrapes.failed', 'monitoring', 'count', 0], ['tls.certificates.not-ready', 'tls', 'count', 0],
  ['tls.cluster.expiry-days', 'tls', 'days', 65], ['runner.jobs.active', 'runner', 'count', 2],
  ['runner.capacity.utilization', 'runner', 'percent', 100],
  ['application.koiforge.memory', 'application', 'percent', 8], ['application.solveit.memory', 'application', 'percent', 30],
  ['application.keycloak.memory', 'application', 'percent', 40], ['application.symphony.memory', 'application', 'percent', 5],
  ['application.mcp.memory', 'application', 'percent', 28],
] as const;

async function mockApi(page: Page, options: { summaryError?: boolean; alertError?: boolean; seriesError?: boolean; empty?: boolean; partial?: boolean } = {}) {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/auth/status') return json({ initialized: true, setupAllowed: false, tokenRequired: false });
    if (path === '/api/auth/session') return json({ user: { id: 'test', displayName: 'Dashboard Test', email: 'test@example.test' }, tenant: { id: 'test', name: 'Test' }, roleIds: ['owner'], permissions: ['views.read'] });
    if (path === '/api/monitoring/summary') return options.summaryError ? json({ error: 'Unavailable' }, 502) : json({ source: options.partial ? 'degraded' : 'ready', items: definitions.map(([id, group, unit, value]) => ({ id, name: id, description: 'Überwachter Messwert aus Prometheus.', group, unit, value: options.partial && id === 'backup.age-hours' ? null : value, timestamp: new Date().toISOString(), state: options.partial && id === 'backup.age-hours' ? 'unknown' : 'ok', defaultWindow: '1h', kind: 'gauge' })) });
    if (path === '/api/monitoring/alerts') return options.alertError ? json({ error: 'Unavailable' }, 502) : json({ items: [] });
    if (path.endsWith('/series')) {
      if (options.seriesError && path.includes('node.cpu')) return json({ error: 'Unavailable' }, 502);
      const id = path.split('/').at(-2)!;
      const definition = definitions.find(row => row[0] === id);
      const base = Number(definition?.[3] ?? 0);
      const window = url.searchParams.get('window');
      const duration = window === '24h' ? 86400_000 : window === '1h' ? 3600_000 : 21600_000;
      const step = window === '24h' ? 900_000 : window === '1h' ? 60_000 : 300_000;
      return json({ sensorId: id, window, points: options.empty ? [] : Array.from({ length: duration / step + 1 }, (_, i) => ({ timestamp: new Date(Date.now() - duration + i * step).toISOString(), value: definition?.[2] === 'percent' ? base + Math.sin(i / 12) * 8 : base })) });
    }
    if (path === '/api/monitoring/endpoints') return json({ source: 'degraded', observedAt: new Date().toISOString(), items: [
      { id: 'koiforge', name: 'KoiForge', observer: 'Server-Prüfer', state: 'ok', checkedAt: new Date(Date.now() - 60_000).toISOString(), maxAgeSeconds: 900, tlsDays: 65, reason: 'fresh' },
      { id: 'login', name: 'Login / Keycloak', observer: 'Externer Prüfer', state: 'unknown', checkedAt: new Date(Date.now() - 7200_000).toISOString(), maxAgeSeconds: 2700, tlsDays: null, reason: 'stale' },
    ] });
    if (path === '/api/monitoring/gitlab-queue') {
      const counts = { running: 1, pending: 3, duoRunning: 0, duoPending: 0, upcoming: 5, resourceWaiting: 0, scheduled: 0, canceling: 0 };
      return json({ source: 'ready', observedAt: new Date().toISOString(), oldestPendingSeconds: 360,
        projects: [{ project: 'Beispiel / koiforge', url: 'https://gitlab.example.test/demo/koiforge', counts, oldestPendingSeconds: 360 }], counts });
    }
    return json({ items: [] });
  });
}

test('five thematic views, multiple charts, deep links and shared time window', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await mockApi(page);
  await page.goto('/#/monitoring');
  await expect(page.getByRole('heading', { name: 'Alles Wichtige im Blick.' })).toBeVisible();
  await expect(page.locator('.monitoring-chart')).toHaveCount(4);
  await expect(page.locator('.monitoring-chart .recharts-surface').first()).toBeVisible();
  await page.getByLabel('Monitoring-Zeitfenster').selectOption('24h');
  const tabs = page.getByRole('navigation', { name: 'Monitoring-Themen' });
  await expect(tabs.getByRole('link')).toHaveCount(5);
  await tabs.getByRole('link', { name: 'Server & Cluster' }).click();
  await expect(page).toHaveURL(/view=infrastructure&range=24h/);
  await expect(page.locator('.monitoring-kpi')).toHaveCount(8);
  await tabs.getByRole('link', { name: 'Anwendungen' }).click();
  await expect(page.getByRole('row', { name: /Login \/ Keycloak/ })).toContainText('Veraltet');
  await tabs.getByRole('link', { name: 'GitLab & CI' }).click();
  await expect(page.getByTestId('gitlab-queue')).toContainText('6 Min.');
  await expect(page.getByTestId('monitoring-sensor-flux.reconciliation.failed')).toContainText('0');
  await expect(page.getByTestId('monitoring-sensor-flux.reconciliation.failed')).not.toContainText('Offline');
  await tabs.getByRole('link', { name: 'Backups & Sicherheit' }).click();
  await expect(page.locator('.monitoring-chart')).toHaveCount(4);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Backups & Zertifikate' })).toBeVisible();
  await expect(page.getByLabel('Monitoring-Zeitfenster')).toHaveValue('24h');
  await page.goBack();
  expect(errors).toEqual([]);
});

test('NeuroFunken resource, certificate and runner sensors have values and charts', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#/monitoring?view=applications');
  for (const app of ['koiforge','solveit','keycloak','symphony','mcp']) {
    await expect(page.getByTestId(`monitoring-sensor-application.${app}.memory`)).toContainText('%');
  }
  await expect(page.getByRole('region', {name:'SolveIT RAM-Budget: Verlauf'}).locator('.recharts-surface')).toBeVisible();
  await page.getByRole('link', {name:'GitLab & CI',exact:true}).click();
  await expect(page.getByTestId('monitoring-sensor-runner.jobs.active')).toContainText('2');
  await expect(page.getByTestId('monitoring-sensor-runner.capacity.utilization')).toContainText('100 %');
  await expect(page.getByRole('region', {name:'Runner-Belegung: Verlauf'})).not.toContainText('kritisch ab 85');
  await page.getByRole('link', {name:'Backups & Sicherheit',exact:true}).click();
  await expect(page.getByTestId('monitoring-sensor-tls.cluster.expiry-days')).toContainText('65 Tage');
  await expect(page.getByTestId('monitoring-sensor-tls.certificates.not-ready')).toContainText('0');
});

test('alarm failures do not hide KPIs or claim no active alarms', async ({ page }) => {
  await mockApi(page, { alertError: true }); await page.goto('/#/monitoring');
  await expect(page.getByTestId('monitoring-sensor-node.cpu.utilization')).toContainText('24 %');
  await expect(page.getByRole('region', { name: 'Aktive Alarme', exact: true })).toContainText('Keine Entwarnung möglich');
  await expect(page.getByText('Keine aktiven Prometheus-Alarme gemeldet.')).toHaveCount(0);
});

test('missing data and failed charts are isolated, not zero or healthy', async ({ page }) => {
  await mockApi(page, { partial: true, seriesError: true }); await page.goto('/#/monitoring');
  await expect(page.getByTestId('monitoring-sensor-backup.age-hours')).toContainText('Unbekannt');
  await expect(page.getByTestId('monitoring-sensor-backup.age-hours')).toContainText('—');
  await expect(page.getByRole('region', { name: 'CPU-Auslastung: Verlauf' })).toContainText('Verlauf nicht verfügbar');
  await expect(page.getByRole('region', { name: 'Arbeitsspeicher: Verlauf' }).locator('.recharts-surface')).toBeVisible();
});

test('failed refresh invalidates previously healthy values', async ({ page }) => {
  await mockApi(page); await page.goto('/#/monitoring');
  await expect(page.getByTestId('monitoring-sensor-node.cpu.utilization')).toContainText('24 %');
  await page.route('**/api/monitoring/summary', route => route.fulfill({ status: 502, contentType: 'application/json', body: '{}' }));
  await page.getByRole('button', { name: 'Alle Messwerte aktualisieren' }).click();
  await expect(page.getByTestId('monitoring-sensor-node.cpu.utilization')).toContainText('Unbekannt');
  await expect(page.getByTestId('monitoring-sensor-node.cpu.utilization')).not.toContainText('24 %');
  await expect(page.getByRole('region', { name: 'Datenstatus' })).toContainText('Messwerte nicht aktuell');
});

test('forbidden monitoring requests are not mislabeled as a data-source outage', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/monitoring/summary', route => route.fulfill({ status:403, contentType:'application/json', body:JSON.stringify({error:'Für diese Anfrage fehlt die Berechtigung.'}) }));
  await page.goto('/#/monitoring');
  await expect(page.getByRole('alert').filter({hasText:'Zugriff verweigert (403)'})).toBeVisible();
  await expect(page.getByText(/Datenquelle nicht erreichbar oder nicht eingerichtet/)).toHaveCount(0);
  await expect(page.getByTestId('monitoring-sensor-node.cpu.utilization')).toContainText('—');
});

test('paused refresh expires data, resuming refresh restores it', async ({ page }) => {
  await page.clock.install(); await mockApi(page); await page.goto('/#/monitoring');
  await expect(page.getByTestId('monitoring-sensor-node.cpu.utilization')).toContainText('24 %');
  await page.getByLabel('Live · 60 s').uncheck();
  await page.clock.fastForward(195_000);
  await expect(page.getByTestId('monitoring-sensor-node.cpu.utilization')).toContainText('Unbekannt');
  await page.getByRole('button', { name: 'Alle Messwerte aktualisieren' }).click();
  await expect(page.getByTestId('monitoring-sensor-node.cpu.utilization')).toContainText('24 %');
});

test('empty series and unavailable source remain explicit', async ({ page }) => {
  await mockApi(page, { empty: true, summaryError: true }); await page.goto('/#/monitoring?view=invalid&range=invalid');
  await expect(page.getByRole('heading', { name: 'Wie steht es um die Plattform?' })).toBeVisible();
  await expect(page.getByText('Keine Messpunkte für diesen Zeitraum vorhanden.')).toHaveCount(4);
  await expect(page.getByTestId('monitoring-sensor-node.cpu.utilization')).toContainText('Unbekannt');
});

test('desktop and mobile layouts stay within the viewport', async ({ page }, testInfo) => {
  await mockApi(page); await page.goto('/#/monitoring');
  await expect(page.locator('.monitoring-chart .recharts-surface').first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('overview-desktop.png'), fullPage: true });
  for (const [label, name] of [['Anwendungen', 'applications'], ['GitLab & CI', 'ci'], ['Backups & Sicherheit', 'security']] as const) {
    await page.getByRole('navigation', { name: 'Monitoring-Themen' }).getByRole('link', { name: label }).click();
    await expect(page.locator('.monitoring-chart .recharts-surface').first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${name}-desktop.png`), fullPage: true });
  }
  await page.getByRole('navigation', { name: 'Monitoring-Themen' }).getByRole('link', { name: 'Überblick' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('navigation', { name: 'Monitoring-Themen' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('overview-mobile.png'), fullPage: true });
  await page.getByRole('navigation', { name: 'Monitoring-Themen' }).getByRole('link', { name: 'Anwendungen' }).click();
  await expect(page.getByRole('table')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('superseded time-window requests cannot replace the new charts', async ({ page }) => {
  await mockApi(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/monitoring/sensors/*/series?window=1h', async route => {
    await held;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ sensorId: 'node.cpu.utilization', window: '1h', points: [{ timestamp: new Date().toISOString(), value: 999 }] }) }).catch(() => {});
  });
  await page.goto('/#/monitoring?range=1h');
  await expect(page.getByRole('heading', { name: 'Alles Wichtige im Blick.' })).toBeVisible();
  await page.getByLabel('Monitoring-Zeitfenster').selectOption('24h');
  await expect(page.getByRole('region', { name: 'CPU-Auslastung: Verlauf' }).locator('.recharts-surface')).toBeVisible();
  release();
  await expect(page.getByLabel('Monitoring-Zeitfenster')).toHaveValue('24h');
  await expect(page.getByRole('region', { name: 'CPU-Auslastung: Verlauf' })).not.toContainText('999');
});
