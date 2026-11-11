import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './authenticated-fixture.js';

// The Foundry fixture isolates data, authentication and its planning CLI double.
const api = 'http://127.0.0.1:3191';
const createdDatasets = new WeakMap<APIRequestContext, Set<string>>();
function trackDataset(request: APIRequestContext, id: string): void {
  const ids = createdDatasets.get(request) ?? new Set<string>();
  ids.add(id); createdDatasets.set(request, ids);
}
test.afterEach(async ({ request }) => {
  const failures: string[] = [];
  for (const id of createdDatasets.get(request) ?? []) {
    try {
      const response = await request.delete(`${api}/api/datasets/${encodeURIComponent(id)}`);
      if (!response.ok() && response.status() !== 404) failures.push(`${id}: ${response.status()} ${await response.text()}`);
    } catch (error) { failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  createdDatasets.delete(request);
  expect(failures, 'Only datasets created by this case test are removed after its assertions.').toEqual([]);
});
type Row = Record<string, string | number | boolean | null>;
interface Mission {
  id: string;
  status: string;
  revision: number;
  result: { counts: Record<string, number>; rows: Row[]; truncated: boolean; evidence: Record<string, string> };
}
interface CaseEvidence {
  missionId: string;
  sourceRow: number;
  source: { hash: string; name: string };
  targetSource: { hash: string };
  orderRuleHash: string;
  finding: Row;
}
interface CaseRecord {
  id: string;
  ownerId: string;
  status: 'open' | 'in_progress' | 'resolved';
  revision: number;
  evidence: CaseEvidence;
  evidenceHash: string;
  assignee: { id: string; displayName: string } | null;
  resolution: string | null;
  events: Array<{ kind: 'created' | 'claimed' | 'resolved' | 'reopened'; note: string | null }>;
}
interface CasePreview {
  title: string;
  evidence: CaseEvidence;
  evidenceHash: string;
  previewHash: string;
  existingCaseId: string | null;
}
interface Findings { items: Row[]; offset: number; limit: number; totalRows: number }
interface CreateInput { missionId: string; sourceRow: number; previewHash: string; confirmed: true; requestId: string }
const rule = { openStatuses: ['offen'], closedStatuses: ['erledigt'], asOf: '2026-09-23', dueDateMeaning: 'promised_delivery_day' };

async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(`${api}/api/${path}`, { data });
  expect(response.ok(), await response.text()).toBeTruthy(); return response.json() as Promise<T>;
}
async function get<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(`${api}/api/${path}`);
  expect(response.ok(), await response.text()).toBeTruthy(); return response.json() as Promise<T>;
}
async function missionAt(request: APIRequestContext, id: string, status: string): Promise<Mission> {
  await expect.poll(async () => (await get<{ mission: Mission }>(request, `missions/${id}`)).mission.status,
    { timeout: 20_000 }).toBe(status);
  return (await get<{ mission: Mission }>(request, `missions/${id}`)).mission;
}
async function seedMission(request: APIRequestContext, large = false): Promise<Mission> {
  const rows: Row[] = large ? [
    ...Array.from({ length: 105 }, (_, index) => ({ id: `O${index + 1}`, supplier: 'S', status: 'offen', due: '2026-09-20' })),
    { id: 'O106', supplier: 'UNKNOWN', status: 'erledigt', due: '2026-09-20' },
    { id: 'O107', supplier: 'S', status: 'offen', due: '2026-09-23' },
    { id: 'O108', supplier: 'S', status: 'erledigt', due: '2026-09-20' },
    { id: 'O109', supplier: 'S', status: 'unbekannt', due: '2026-09-20' },
  ] : [{ id: 'O1', supplier: 'S', status: 'offen', due: '2026-09-20' }];
  const source = await post<{ id: string }>(request, 'datasets/inline', {
    name: `Fall-Bestellungen-${randomUUID()}`, namespace: 'case-browser', rows,
  });
  trackDataset(request, source.id);
  const target = await post<{ id: string }>(request, 'datasets/inline', {
    name: `Fall-Lieferanten-${randomUUID()}`, namespace: 'case-browser', rows: [{ id: 'S', name: 'Synthetischer Lieferant' }],
  });
  trackDataset(request, target.id);
  const from = (await post<{ objectSet: { id: string } }>(request, 'model/object-sets', {
    name: 'Fall-Bestellungen', datasetId: source.id, keyField: 'id', confirmed: true, requestId: randomUUID(),
  })).objectSet;
  const to = (await post<{ objectSet: { id: string } }>(request, 'model/object-sets', {
    name: 'Fall-Lieferanten', datasetId: target.id, keyField: 'id', labelField: 'name', confirmed: true, requestId: randomUUID(),
  })).objectSet;
  const relationship = (await post<{ relationship: { id: string } }>(request, 'model/relationships', {
    name: 'Bestellung hat Lieferant', fromSetId: from.id, toSetId: to.id, fromField: 'supplier', confirmed: true, requestId: randomUUID(),
  })).relationship;
  const created = (await post<{ mission: Mission }>(request, 'missions', {
    datasetId: source.id, relationshipId: relationship.id, question: 'Offene Bestellungen mit Lieferkalendertagen klären.', requestId: randomUUID(),
  })).mission;
  const planned = await missionAt(request, created.id, 'awaiting_confirmation');
  await post(request, `missions/${created.id}/run`, { revision: planned.revision, confirmed: true, requestId: randomUUID(),
    binding: { statusField: 'status', dueDateField: 'due' }, orderRule: rule });
  const completed = await missionAt(request, created.id, 'completed');
  expect(completed.result.counts).toEqual(large
    ? { sourceRows: 109, overdueRows: 105, openRows: 1, closedRows: 2, unassessableRows: 1, clarificationRows: 2, deadlineUnassessableRows: 0 }
    : { sourceRows: 1, overdueRows: 1, openRows: 0, closedRows: 0, unassessableRows: 0, clarificationRows: 0, deadlineUnassessableRows: 0 });
  return completed;
}
async function createCase(request: APIRequestContext, missionId: string, sourceRow = 1): Promise<CaseRecord> {
  const preview = await post<CasePreview>(request, 'cases/preview', { missionId, sourceRow });
  return (await post<{ case: CaseRecord }>(request, 'cases', {
    missionId, sourceRow, previewHash: preview.previewHash, confirmed: true, requestId: randomUUID(),
  })).case;
}
async function transition(request: APIRequestContext, record: CaseRecord, action: 'claim' | 'resolve' | 'reopen', note?: string): Promise<CaseRecord> {
  return (await post<{ case: CaseRecord }>(request, `cases/${record.id}/transition`, {
    revision: record.revision, action, ...(note !== undefined ? { note } : {}), confirmed: true, requestId: randomUUID(),
  })).case;
}
async function casesFor(request: APIRequestContext, missionId: string): Promise<CaseRecord[]> {
  return (await get<{ items: CaseRecord[] }>(request, 'cases')).items.filter(record => record.evidence.missionId === missionId);
}
async function selectFinding(page: Page, sourceRow: number): Promise<CasePreview> {
  const pending = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/cases/preview');
  await page.getByTestId('case-preview-finding').and(page.locator(`[data-source-row="${sourceRow}"]`)).click();
  const response = await pending; expect(response.ok(), await response.text()).toBeTruthy();
  await expect(page.getByTestId('case-preview')).toBeVisible();
  return response.json() as Promise<CasePreview>;
}
async function uiTransition(page: Page, id: string, action: 'claim' | 'resolve' | 'reopen'): Promise<CaseRecord> {
  const pending = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/cases/${id}/transition`);
  await page.getByTestId(`case-${action}`).click();
  const response = await pending; expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json() as { case: CaseRecord }).case;
}

test('mobile work finds actionable rows beyond the result preview and records claim, resolution and reopening without changing evidence', async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const mission = await seedMission(request, true);
  expect(mission.result.truncated).toBe(true); expect(mission.result.rows).toHaveLength(100);
  expect(mission.result.rows.some(row => row.Quellzeile === 106)).toBe(false);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/#/missions?id=${mission.id}`);
  await page.getByTestId('mission-edit-findings').click();
  await expect(page.getByTestId('case-findings')).toBeVisible();
  await expect(page.getByTestId('case-preview-finding')).toHaveCount(25);
  for (const offset of [25, 50, 75, 100]) {
    const pending = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/api/cases/findings' && url.searchParams.get('offset') === String(offset);
    });
    await page.getByTestId('case-findings-next').click();
    const response = await pending; expect(response.ok(), await response.text()).toBeTruthy();
    const findings = await response.json() as Findings;
    expect(findings.offset).toBe(offset); expect(findings.totalRows).toBe(107);
    await expect(page.getByTestId('case-preview-finding')).toHaveCount(offset === 100 ? 7 : 25);
  }
  await expect(page.getByTestId('case-findings-next')).toBeDisabled();
  expect(await casesFor(request, mission.id)).toHaveLength(0);
  const preview = await selectFinding(page, 106);
  expect(preview.evidence.finding).toMatchObject({ Quellzeile: 106, Befund: 'Abgeschlossen', Originalstatus: 'erledigt' });
  expect(preview.evidence.finding.Klärungsgrund).toContain('Lieferanten');
  expect(preview.evidence.source.hash).toBe(mission.result.evidence.sourceHash);
  expect(preview.evidence.targetSource.hash).toBe(mission.result.evidence.targetSourceHash);
  expect(preview.evidence.orderRuleHash).toBe(mission.result.evidence.orderRuleHash);
  expect(await casesFor(request, mission.id)).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath('case-source-preview-mobile.png'), fullPage: true });
  const createdResponse = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/cases');
  await page.getByTestId('case-create').click();
  const created = (await (await createdResponse).json() as { case: CaseRecord }).case;
  await expect(page).toHaveURL(new RegExp(`#/missions\\?case=${created.id}$`));
  await expect(page.getByTestId('case-status')).toHaveText('Offen');
  expect(created.evidence).toEqual(preview.evidence); expect(created.evidenceHash).toBe(preview.evidenceHash);
  expect(created.assignee).toBeNull();
  const claimed = await uiTransition(page, created.id, 'claim');
  await expect(page.getByTestId('case-status')).toHaveText('In Bearbeitung');
  expect(claimed.assignee?.id).toBe(created.ownerId);
  await expect(page.getByTestId('case-resolve')).toBeDisabled();
  await page.getByTestId('case-note').fill('  ');
  await expect(page.getByTestId('case-resolve')).toBeDisabled();
  const resolution = 'Lieferantenreferenz anhand des vorliegenden Belegs geprüft; Korrektur separat veranlasst.';
  await page.getByTestId('case-note').fill(resolution);
  const resolved = await uiTransition(page, created.id, 'resolve');
  await expect(page.getByTestId('case-status')).toHaveText('Abgeschlossen');
  expect(resolved.resolution).toBe(resolution);
  expect(resolved.evidence).toEqual(created.evidence); expect(resolved.evidenceHash).toBe(created.evidenceHash);
  await page.reload();
  await expect(page.getByTestId('case-status')).toHaveText('Abgeschlossen');
  await expect(page.getByTestId('case-events')).toContainText(resolution);
  await expect(page.getByTestId('case-reopen')).toBeDisabled();
  const reason = 'Zuordnung weiterhin ungeklärt; neue Rückfrage ist erforderlich.';
  await page.getByTestId('case-note').fill(reason);
  const reopened = await uiTransition(page, created.id, 'reopen');
  await expect(page.getByTestId('case-status')).toHaveText('Offen');
  expect(reopened.events.map(event => event.kind)).toEqual(['created', 'claimed', 'resolved', 'reopened']);
  expect(reopened.events.at(-1)?.note).toBe(reason);
  expect(reopened.evidence).toEqual(created.evidence); expect(reopened.evidenceHash).toBe(created.evidenceHash);
  await expect(page.getByTestId('case-events')).toContainText(resolution);
  await expect(page.getByTestId('case-events')).toContainText(reason);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath('case-work-history-mobile.png'), fullPage: true });
  expect((await get<{ mission: Mission }>(request, `missions/${mission.id}`)).mission.result).toEqual(mission.result);
});

test('case creation survives a committed but lost response and stays unique across reload and a different request ID', async ({ page, request }) => {
  test.setTimeout(60_000);
  const mission = await seedMission(request);
  await page.goto(`/#/missions?view=cases&mission=${mission.id}`);
  const preview = await selectFinding(page, 1);
  const requests: CreateInput[] = []; let committedId = '';
  await page.route('**/api/cases', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    requests.push(route.request().postDataJSON() as CreateInput);
    if (!committedId) {
      const response = await route.fetch(); expect(response.ok(), await response.text()).toBeTruthy();
      committedId = (await response.json() as { case: CaseRecord }).case.id;
      await route.abort('connectionreset');
    } else await route.continue();
  });
  await page.getByTestId('case-create').click();
  await expect(page.getByRole('alert')).toContainText(/Antwort.*ausgeblieben|Antwort.*verloren/);
  expect(committedId).toMatch(/^[a-f0-9-]+$/); expect(requests).toHaveLength(1);
  await page.reload();
  await expect(page.getByTestId('case-preview')).toBeVisible();
  expect(requests).toHaveLength(1);
  // A second independently confirmed request for the same frozen finding must
  // return the existing case as well; request-id deduplication alone is insufficient.
  const duplicate = (await post<{ case: CaseRecord }>(request, 'cases', {
    missionId: mission.id, sourceRow: 1, previewHash: preview.previewHash, confirmed: true, requestId: randomUUID(),
  })).case;
  expect(duplicate.id).toBe(committedId);
  expect((await casesFor(request, mission.id)).map(record => record.id)).toEqual([committedId]);
  await page.getByTestId('case-existing').click();
  await expect(page).toHaveURL(new RegExp(`#/missions\\?case=${committedId}$`));
  await expect(page.getByTestId('case-status')).toHaveText('Offen');
  expect((await get<{ mission: Mission }>(request, `missions/${mission.id}`)).mission.result).toEqual(mission.result);
});

test('stale transition keeps a drafted note, reload never submits it and the refreshed case needs another explicit action', async ({ page, request }) => {
  test.setTimeout(60_000);
  const mission = await seedMission(request);
  const created = await createCase(request, mission.id);
  const claimed = await transition(request, created, 'claim');
  await page.goto(`/#/missions?case=${created.id}`);
  await expect(page.getByTestId('case-status')).toHaveText('In Bearbeitung');
  const note = 'Entwurf bleibt erhalten: Lieferantenzuordnung muss erneut geprüft werden.';
  await page.getByTestId('case-note').fill(note);
  let writes = 0;
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/cases/${created.id}/transition`) writes++; });
  await page.reload();
  await expect(page.getByTestId('case-note')).toHaveValue(note); expect(writes).toBe(0);
  await expect(page.getByTestId('case-status')).toHaveText('In Bearbeitung');
  const external = await transition(request, claimed, 'resolve', 'Parallel gespeicherte Bearbeitungsnotiz.');
  const conflict = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/cases/${created.id}/transition`);
  await page.getByTestId('case-resolve').click();
  expect((await conflict).status()).toBe(409);
  await expect(page.getByTestId('case-status')).toHaveText('Abgeschlossen');
  await expect(page.getByTestId('case-note')).toHaveValue(note); expect(writes).toBe(1);
  await expect(page.getByRole('alert')).toBeVisible();
  const unchanged = (await get<{ case: CaseRecord }>(request, `cases/${created.id}`)).case;
  expect(unchanged.revision).toBe(external.revision);
  expect(unchanged.events.some(event => event.note === note)).toBe(false);
  const reopened = await uiTransition(page, created.id, 'reopen');
  expect(writes).toBe(2); expect(reopened.revision).toBe(external.revision + 1);
  expect(reopened.events.at(-1)).toMatchObject({ kind: 'reopened', note });
  expect(reopened.evidence).toEqual(created.evidence); expect(reopened.evidenceHash).toBe(created.evidenceHash);
});

test('case and finding load failures remain explicit and retry restores saved work instead of showing false emptiness', async ({ page, request }) => {
  test.setTimeout(60_000);
  const mission = await seedMission(request); const created = await createCase(request, mission.id);
  let failList = true;
  await page.route('**/api/cases', route => route.request().method() === 'GET' && failList
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetische Fallablage nicht erreichbar.' }) })
    : route.continue());
  await page.goto('/#/missions?view=cases');
  await expect(page.getByRole('alert')).toContainText('Synthetische Fallablage');
  await expect(page.getByText(/Noch keine (Klärungsfälle|Fälle)|Keine (Klärungsfälle|Fälle) vorhanden/)).toHaveCount(0);
  failList = false; await page.getByTestId('case-list-retry').click();
  await expect(page.getByTestId('case-list').locator(`a[href="#/missions?case=${created.id}"]`)).toBeVisible();
  let failFindings = true;
  await page.route('**/api/cases/findings?**', route => failFindings
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetische Befunde nicht erreichbar.' }) })
    : route.continue());
  await page.goto(`/#/missions?view=cases&mission=${mission.id}`);
  await expect(page.getByRole('alert')).toContainText('Synthetische Befunde');
  await expect(page.getByTestId('case-preview-finding')).toHaveCount(0);
  await expect(page.getByText(/Keine (aktionsrelevanten|relevanten|bearbeitbaren) Befunde/)).toHaveCount(0);
  failFindings = false; await page.getByTestId('case-findings-retry').click();
  await expect(page.getByTestId('case-preview-finding')).toHaveCount(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('case work overview finds saved evidence, keeps status totals and preserves a filtered-out case note across reload', async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const mission = await seedMission(request, true);
  const open = await createCase(request, mission.id, 1);
  const working = await transition(request, await createCase(request, mission.id, 109), 'claim');
  const resolved = await transition(request, await transition(request, await createCase(request, mission.id, 2), 'claim'), 'resolve', 'Separat dokumentierte Bearbeitung.');
  const all = (await get<{ items: CaseRecord[] }>(request, 'cases')).items;
  const source = open.evidence.source.name;
  let writes = 0;
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/cases')) writes++; });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/#/missions?view=cases');
  const list = page.getByTestId('case-list');
  await page.getByTestId('case-search').fill(source.toLocaleUpperCase('de-DE'));
  await expect(list.locator('a')).toHaveCount(3);
  await expect(list.locator('a').nth(0)).toHaveAttribute('href', `#/missions?case=${open.id}`);
  await expect(list.locator('a').nth(1)).toHaveAttribute('href', `#/missions?case=${working.id}`);
  await expect(list.locator('a').nth(2)).toHaveAttribute('href', `#/missions?case=${resolved.id}`);
  await expect(list.locator('a').first()).toContainText('Stichtag 2026-09-23');
  await expect(list.locator('a').first()).toContainText('Lieferant: Synthetischer Lieferant');
  await expect(list.locator('a').first().locator('code')).toHaveText('"O1"');
  await expect(page.getByTestId('case-count-all').locator('strong')).toHaveText(all.length.toLocaleString('de-DE'));
  await expect(page.getByTestId('case-count-open').locator('strong')).toHaveText(all.filter(item => item.status === 'open').length.toLocaleString('de-DE'));
  await page.screenshot({ path: info.outputPath('case-work-overview-desktop.png'), fullPage: true });
  await page.getByTestId('case-sort').selectOption('updated');
  await expect(list.locator('a').first()).toHaveAttribute('href', `#/missions?case=${resolved.id}`);
  await page.getByTestId('case-search').fill(`${source} o109`);
  await expect(list.locator('a')).toHaveCount(1);
  await expect(list.locator('a').first()).toHaveAttribute('href', `#/missions?case=${working.id}`);
  await page.getByTestId('case-search').fill(`${source} SYNTHETISCHER LIEFERANT`);
  await expect(list.locator('a')).toHaveCount(3);
  await page.getByTestId('case-count-in_progress').click();
  await expect(list.locator('a')).toHaveCount(1);
  await page.reload();
  await expect(page.getByTestId('case-search')).toHaveValue(`${source} SYNTHETISCHER LIEFERANT`);
  await expect(page.getByTestId('case-sort')).toHaveValue('updated');
  await expect(page.getByTestId('case-count-in_progress')).toHaveAttribute('aria-pressed', 'true');
  await expect(list.locator('a')).toHaveCount(1);
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('case-work-overview-mobile.png'), fullPage: true });
  await list.locator('a').first().click();
  await expect(page.getByTestId('case-status')).toHaveText('In Bearbeitung');
  const note = 'Entwurf bleibt beim Wechsel der Arbeitsauswahl erhalten.';
  await page.getByTestId('case-note').fill(note);
  await page.getByTestId('case-count-open').click();
  await expect(page.getByTestId('case-outside-selection')).toBeVisible();
  await expect(page.getByTestId('case-note')).toHaveValue(note);
  await page.reload();
  await expect(page.getByTestId('case-note')).toHaveValue(note);
  await expect(page.getByTestId('case-outside-selection')).toBeVisible();
  await page.getByTestId('case-search').fill('nicht-vorhandener-suchbegriff');
  await expect(list.locator('a')).toHaveCount(0);
  await expect(page.getByText('Keine Fälle passen zu deiner Suche und dem gewählten Bearbeitungsstatus.')).toBeVisible();
  await page.getByRole('button', { name: 'Auswahl zurücksetzen' }).click();
  await expect(list.locator('a')).toHaveCount(all.length);
  await expect(page.getByTestId('case-outside-selection')).toHaveCount(0);
  await expect(page.getByTestId('case-note')).toHaveValue(note);
  expect(writes).toBe(0);
  const unchanged = (await get<{ case: CaseRecord }>(request, `cases/${working.id}`)).case;
  expect(unchanged.revision).toBe(working.revision);
  expect(unchanged.evidenceHash).toBe(working.evidenceHash);
  expect(unchanged.events.some(event => event.note === note)).toBe(false);
});
