import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { expect, test } from './authenticated-fixture.js';

// Uses the isolated, authenticated Foundry fixture and its local CLI double.
// Data and expected business counts below are synthetic and independent of the UI.
const api = 'http://127.0.0.1:3191';
type Row = Record<string, string | number | boolean | null>;
type Counts = Record<string, number>;
interface ObjectSet {
  id: string;
  familyId: string;
  revision: number;
  source: { datasetId: string; hash: string; rowCount: number };
  snapshotHash: string;
}
interface Relationship { id: string }
interface OrderRule {
  openStatuses: string[];
  closedStatuses: string[];
  asOf: string;
  dueDateMeaning: 'promised_delivery_day';
}
interface Mission {
  id: string;
  status: string;
  revision: number;
  plan: { capabilityId: string; capabilityVersion: string };
  input: { binding: { statusField: string; dueDateField?: string }; orderRule: OrderRule };
  result: { counts: Counts; rows: Row[]; evidence: Record<string, string> };
  routine?: { id: string; sourceMissionId: string; previewHash: string };
}
interface Routine {
  id: string;
  name: string;
  sourceMissionId: string;
  binding: Mission['input']['binding'];
  orderRule: OrderRule;
  baseline: { fromFamilyId: string; toFamilyId: string; counts: Counts };
}
interface Preview {
  ready: boolean;
  asOf: string;
  previewHash?: string;
  previousCounts: Counts;
  newCounts?: Counts;
  deltas?: Counts;
  blockingReasons: string[];
  changes: { from: { previousRevision: number; revision: number }; to: { previousRevision: number; revision: number } };
  statusProfile: { unknownRows: number; unknownValues: Array<{ value: string; count: number }> };
}
interface RunInput { relationshipId: string; asOf: string; previewHash: string; confirmed: true; requestId: string }

const baselineCounts: Counts = { sourceRows: 4, overdueRows: 1, openRows: 2, closedRows: 1,
  unassessableRows: 0, clarificationRows: 1, deadlineUnassessableRows: 1 };
const newCounts: Counts = { sourceRows: 6, overdueRows: 2, openRows: 2, closedRows: 1,
  unassessableRows: 1, clarificationRows: 2, deadlineUnassessableRows: 1 };
const binding = { statusField: 'status', dueDateField: 'due' };
const orderRule: OrderRule = { openStatuses: ['offen'], closedStatuses: ['erledigt'], asOf: '2026-09-23', dueDateMeaning: 'promised_delivery_day' };
const originalRows: Row[] = [
  { id: 'a', supplier: 'S', status: 'offen', due: '2026-09-20', legacy: 'alter Zusatz' },
  { id: 'b', supplier: 'S', status: 'offen', due: '2026-09-23', legacy: 'alter Zusatz' },
  { id: 'c', supplier: 'S', status: 'erledigt', due: '2026-09-20', legacy: 'alter Zusatz' },
  { id: 'd', supplier: 'S', status: 'offen', due: null, legacy: 'alter Zusatz' },
];
const revisedRows: Row[] = [
  { id: 'a', supplier: 'S', status: 'offen', due: '2026-09-26', note: 'neuer Zusatz' },
  { id: 'b', supplier: 'S', status: 'offen', due: '2026-09-23', note: 'neuer Zusatz' },
  { id: 'c', supplier: 'S', status: 'erledigt', due: '2026-09-20', note: 'neuer Zusatz' },
  { id: 'd', supplier: 'S', status: 'offen', due: null, note: 'neuer Zusatz' },
  { id: 'e', supplier: 'S', status: 'Freigabe fehlt', due: '2026-09-01', note: 'ungeklärter Status' },
  { id: 'f', supplier: 'T', status: 'offen', due: '2026-09-24', note: 'neuer Lieferant' },
];

async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(`${api}/api/${path}`, { data });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<T>;
}
async function get<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(`${api}/api/${path}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<T>;
}
async function createSet(request: APIRequestContext, name: string, rows: Row[], previousId?: string): Promise<ObjectSet> {
  const source = await post<{ id: string }>(request, 'datasets/inline', {
    name: `${name}-${randomUUID()}`, namespace: 'routine-browser', rows,
  });
  return (await post<{ objectSet: ObjectSet }>(request, 'model/object-sets', { name, datasetId: source.id,
    keyField: 'id', ...(name === 'Lieferanten' ? { labelField: 'name' } : {}), ...(previousId ? { previousId } : {}),
    confirmed: true, requestId: randomUUID() })).objectSet;
}
async function createRelationship(request: APIRequestContext, from: ObjectSet, to: ObjectSet): Promise<Relationship> {
  return (await post<{ relationship: Relationship }>(request, 'model/relationships', {
    name: `Bestellung hat Lieferant · R${from.revision}/R${to.revision}`, fromSetId: from.id, toSetId: to.id,
    fromField: 'supplier', confirmed: true, requestId: randomUUID(),
  })).relationship;
}
async function waitForMission(request: APIRequestContext, id: string, status: string): Promise<Mission> {
  await expect.poll(async () => (await get<{ mission: Mission }>(request, `missions/${id}`)).mission.status,
    { timeout: 20_000, message: `Mission ${id} should reach ${status}` }).toBe(status);
  return (await get<{ mission: Mission }>(request, `missions/${id}`)).mission;
}
async function completedFixture(request: APIRequestContext) {
  const from = await createSet(request, 'Bestellungen', originalRows);
  const to = await createSet(request, 'Lieferanten', [{ id: 'S', name: 'Synthetischer Lieferant S' }]);
  const relationship = await createRelationship(request, from, to);
  const created = (await post<{ mission: Mission }>(request, 'missions', {
    datasetId: from.source.datasetId, relationshipId: relationship.id,
    question: 'Offene Bestellungen mit Lieferkalendertagen klären.', requestId: randomUUID(),
  })).mission;
  const planned = await waitForMission(request, created.id, 'awaiting_confirmation');
  expect(planned.plan.capabilityId).toBe('order_review');
  await post(request, `missions/${created.id}/run`, {
    revision: planned.revision, requestId: randomUUID(), confirmed: true, binding, orderRule,
  });
  const mission = await waitForMission(request, created.id, 'completed');
  expect(mission.result.counts).toEqual(baselineCounts);
  return { from, to, relationship, mission };
}
async function savedRoutine(request: APIRequestContext, mission: Mission): Promise<Routine> {
  return (await post<{ routine: Routine }>(request, 'routines', {
    sourceMissionId: mission.id, name: `Bestellungen klären ${randomUUID()}`, confirmed: true, requestId: randomUUID(),
  })).routine;
}
async function saveThroughUi(page: Page, mission: Mission): Promise<Routine> {
  await page.goto(`/#/missions?id=${mission.id}`);
  await expect(page.getByTestId('mission-result')).toContainText('4 Quellzeilen');
  await page.getByTestId('mission-save-routine').click();
  await page.getByTestId('routine-name').fill(`Bestellungen klären ${randomUUID()}`);
  const pending = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/routines');
  await page.getByTestId('routine-save').click();
  const response = await pending;
  expect(response.ok(), await response.text()).toBeTruthy();
  const routine = (await response.json() as { routine: Routine }).routine;
  await expect(page).toHaveURL(new RegExp(`#/missions\\?routine=${routine.id}$`));
  await expect(page.getByTestId('routine-list').getByRole('link', { name: new RegExp(routine.name) })).toBeVisible();
  await expect(page.getByTestId('routine-rules')).toContainText('2026-09-23');
  return routine;
}
async function inspect(page: Page, routineId: string, relationshipId: string, asOf: string): Promise<Preview> {
  await page.getByTestId('routine-relationship').selectOption(relationshipId);
  await page.getByTestId('routine-as-of').fill(asOf);
  const pending = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/routines/${routineId}/preview`);
  await page.getByTestId('routine-preview-button').click();
  const response = await pending;
  expect(response.ok(), await response.text()).toBeTruthy();
  await expect(page.getByTestId('routine-preview')).toBeVisible();
  return response.json() as Promise<Preview>;
}
async function countRow(table: Locator, label: string, values: string[]) {
  const row = table.getByRole('row').filter({ has: table.page().getByRole('rowheader', { name: label, exact: true }) });
  await expect(row.getByRole('cell')).toHaveText(values);
}
async function routineMissions(request: APIRequestContext, routineId: string): Promise<Mission[]> {
  return (await get<{ items: Mission[] }>(request, 'missions')).items.filter(mission => mission.routine?.id === routineId);
}

test('saved routine previews both new revisions, requires fresh confirmation and preserves the original result', async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const f = await completedFixture(request);
  const routine = await saveThroughUi(page, f.mission);
  expect(routine.baseline.counts).toEqual(baselineCounts);
  expect(routine.baseline.fromFamilyId).toBe(f.from.familyId); expect(routine.baseline.toFamilyId).toBe(f.to.familyId);
  const from = await createSet(request, 'Bestellungen', revisedRows, f.from.id);
  const to = await createSet(request, 'Lieferanten', [
    { id: 'S', name: 'Synthetischer Lieferant S', region: 'Nord' },
    { id: 'T', name: 'Synthetischer Lieferant T', region: 'Süd' },
  ], f.to.id);
  const relationship = await createRelationship(request, from, to);
  await page.getByRole('button', { name: 'Beziehungsliste aktualisieren', exact: true }).click();
  let runs = 0; let replans = 0;
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    if (new URL(request.url()).pathname === `/api/routines/${routine.id}/run`) runs++;
    if (new URL(request.url()).pathname === '/api/missions') replans++;
  });
  const first = await inspect(page, routine.id, relationship.id, '2026-09-24');
  expect(first.ready).toBe(true); expect(first.newCounts).toMatchObject({ overdueRows: 1, openRows: 3 });
  expect(await routineMissions(request, routine.id)).toHaveLength(0);
  await expect(page.getByTestId('routine-run')).toBeDisabled(); expect(runs).toBe(0);
  await page.getByTestId('routine-confirm').check();
  await page.getByTestId('routine-as-of').fill('2026-09-25');
  await expect(page.getByTestId('routine-preview')).toHaveCount(0);
  await expect(page.getByTestId('routine-run')).toHaveCount(0);
  const preview = await inspect(page, routine.id, relationship.id, '2026-09-25');
  expect(preview.previewHash).not.toBe(first.previewHash);
  expect(preview.previousCounts).toEqual(baselineCounts); expect(preview.newCounts).toEqual(newCounts);
  expect(preview.deltas).toEqual({ sourceRows: 2, overdueRows: 1, openRows: 0, closedRows: 0,
    unassessableRows: 1, clarificationRows: 1, deadlineUnassessableRows: 0 });
  expect(preview.changes.from).toMatchObject({ previousRevision: 1, revision: 2 });
  expect(preview.changes.to).toMatchObject({ previousRevision: 1, revision: 2 });
  expect(preview.statusProfile.unknownValues).toEqual([{ value: 'Freigabe fehlt', count: 1 }]);
  await expect(page.getByTestId('routine-confirm')).not.toBeChecked();
  await expect(page.getByTestId('routine-run')).toBeDisabled();
  await expect(page.getByTestId('routine-preview')).toContainText('Revision 1 → 2');
  await expect(page.getByTestId('routine-preview')).toContainText('4 → 6 Zeilen');
  await expect(page.getByTestId('routine-preview')).toContainText('1 → 2 Zeilen');
  await expect(page.getByTestId('routine-preview')).toContainText('Differenzen zeigen keine Ursache');
  await expect(page.getByTestId('routine-unknown-statuses')).toContainText('Freigabe fehlt');
  await expect(page.getByTestId('routine-unknown-statuses')).toContainText('1 mit unbestätigtem Textstatus');
  const comparison = page.getByTestId('routine-count-comparison');
  await countRow(comparison, 'Geprüfte Quellzeilen', ['4', '6', '+2']);
  await countRow(comparison, 'Offen und überfällig', ['1', '2', '+1']);
  await countRow(comparison, 'Bestellung nicht beurteilbar', ['0', '1', '+1']);
  await page.getByText('Spalten, Feldbedeutungen und Vorschau-Belege', { exact: true }).click();
  await expect(page.getByTestId('routine-preview')).toContainText('Hinzugefügte Spalten: note');
  await expect(page.getByTestId('routine-preview')).toContainText('Entfernte Spalten: legacy');
  await expect(page.getByTestId('routine-preview')).toContainText(from.source.hash);
  await expect(page.getByTestId('routine-preview')).toContainText(to.source.hash);
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await comparison.scrollIntoViewIfNeeded();
  await expect(comparison.getByRole('columnheader', { name: 'Kennzahl', exact: true })).toBeInViewport();
  await page.screenshot({ path: info.outputPath('routine-preview-mobile.png'), fullPage: true });
  await page.getByTestId('routine-confirm').check();
  await page.getByTestId('routine-run').click();
  await expect(page).toHaveURL(/#\/missions\?id=[a-f0-9-]+$/);
  const missionId = new URLSearchParams(page.url().split('?')[1]).get('id')!;
  expect(missionId).not.toBe(f.mission.id);
  await expect(page.getByTestId('mission-result')).toContainText('6 Quellzeilen', { timeout: 20_000 });
  const completed = await waitForMission(request, missionId, 'completed');
  expect(completed.result.counts).toEqual(newCounts);
  expect(completed.routine).toMatchObject({ id: routine.id, sourceMissionId: f.mission.id, previewHash: preview.previewHash });
  expect(completed.input).toMatchObject({ binding, orderRule: { ...orderRule, asOf: '2026-09-25' } });
  expect(completed.result.evidence).toMatchObject({ sourceHash: from.source.hash, targetSourceHash: to.source.hash,
    fromSnapshotHash: from.snapshotHash, toSnapshotHash: to.snapshotHash });
  expect(completed.result.rows.find(row => row['Bestellungs-ID'] === '"e"')).toMatchObject({ Befund: 'Nicht beurteilbar', Originalstatus: 'Freigabe fehlt' });
  expect(runs).toBe(1); expect(replans).toBe(0);
  await expect(page.getByTestId('mission-order-status-values')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('mission-result')).toContainText('6 Quellzeilen');
  await expect(page.getByTestId('mission-order-rules')).toContainText('2026-09-25');
  await page.screenshot({ path: info.outputPath('routine-result-mobile.png'), fullPage: true });
  await page.goto(`/#/missions?routine=${routine.id}`);
  await page.getByRole('link', { name: 'Bestätigten Auftrag öffnen', exact: true }).click();
  await expect(page.getByTestId('mission-result')).toContainText('4 Quellzeilen');
  await expect(page.getByTestId('mission-order-rules')).toContainText('2026-09-23');
  expect((await get<{ mission: Mission }>(request, `missions/${f.mission.id}`)).mission.result).toEqual(f.mission.result);
  expect((await get<{ routine: Routine }>(request, `routines/${routine.id}`)).routine).toEqual(routine);
  expect(errors).toEqual([]);
});

test('a missing required column blocks the comparison and never offers a routine start', async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const f = await completedFixture(request); const routine = await savedRoutine(request, f.mission);
  const rows = originalRows.map(({ due: _removed, ...row }) => row);
  const from = await createSet(request, 'Bestellungen', rows, f.from.id);
  const relationship = await createRelationship(request, from, f.to);
  await page.goto(`/#/missions?routine=${routine.id}`);
  const preview = await inspect(page, routine.id, relationship.id, '2026-09-25');
  expect(preview.ready).toBe(false); expect(preview.previewHash).toBeUndefined();
  expect(preview.newCounts).toBeUndefined(); expect(preview.deltas).toBeUndefined();
  await expect(page.getByTestId('routine-preview').getByRole('alert')).toContainText('Benötigte Bestellspalte „due“ fehlt');
  await expect(page.getByTestId('routine-count-comparison')).toContainText('Nicht berechnet');
  await expect(page.getByTestId('routine-confirm')).toHaveCount(0);
  await expect(page.getByTestId('routine-run')).toHaveCount(0);
  expect(await routineMissions(request, routine.id)).toHaveLength(0);
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: info.outputPath('routine-incompatible-mobile.png'), fullPage: true });
  expect((await get<{ mission: Mission }>(request, `missions/${f.mission.id}`)).mission.result).toEqual(f.mission.result);
});

test('a committed run with a lost response reuses its request after reload and creates exactly one mission', async ({ page, request }) => {
  test.setTimeout(60_000);
  const f = await completedFixture(request); const routine = await savedRoutine(request, f.mission);
  await page.goto(`/#/missions?routine=${routine.id}`);
  const preview = await inspect(page, routine.id, f.relationship.id, '2026-09-25');
  expect(preview.ready).toBe(true);
  const requests: RunInput[] = []; let committedId = '';
  await page.route(`**/api/routines/${routine.id}/run`, async route => {
    requests.push(route.request().postDataJSON() as RunInput);
    if (requests.length === 1) {
      // The actual API commits before only the browser's response is discarded.
      const response = await route.fetch();
      expect(response.status(), await response.text()).toBe(202);
      committedId = (await response.json() as { mission: Mission }).mission.id;
      await route.abort('failed');
    } else await route.continue();
  });
  await page.getByTestId('routine-confirm').check();
  await page.getByTestId('routine-run').click();
  await expect(page.getByRole('alert')).toContainText('Die Antwort ist ausgeblieben');
  expect(committedId).toMatch(/^[a-f0-9-]+$/); expect(requests).toHaveLength(1);
  await waitForMission(request, committedId, 'completed');
  expect(await routineMissions(request, routine.id)).toHaveLength(1);
  await page.reload();
  await expect(page.getByTestId('routine-preview')).toBeVisible();
  await expect(page.getByTestId('routine-relationship')).toHaveValue(f.relationship.id);
  await expect(page.getByTestId('routine-as-of')).toHaveValue('2026-09-25');
  await expect(page.getByTestId('routine-confirm')).not.toBeChecked();
  await expect(page.getByTestId('routine-run')).toBeDisabled();
  expect(requests).toHaveLength(1);
  await page.getByTestId('routine-confirm').check();
  await page.getByTestId('routine-run').click();
  await expect(page).toHaveURL(new RegExp(`#/missions\\?id=${committedId}$`));
  await expect(page.getByTestId('mission-result')).toContainText('4 Quellzeilen');
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  expect(requests[0]).toMatchObject({ relationshipId: f.relationship.id, asOf: '2026-09-25', confirmed: true, previewHash: preview.previewHash });
  expect(requests[0]!.requestId).toMatch(/^[a-f0-9]{8}-[a-f0-9-]{27}$/);
  expect((await routineMissions(request, routine.id)).map(mission => mission.id)).toEqual([committedId]);
  expect((await get<{ mission: Mission }>(request, `missions/${f.mission.id}`)).mission.result).toEqual(f.mission.result);
});

test('completed runs track findings across source rows, preserve existing cases and restore filtered pages without writes', async ({ page, request }, info) => {
  test.setTimeout(90_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const f = await completedFixture(request); const routine = await savedRoutine(request, f.mission);
  const location = { missionId: f.mission.id, sourceRow: 1 };
  const proposal = await post<{ previewHash: string }>(request, 'cases/preview', location);
  const originalCase = (await post<{ case: { id: string; status: string; revision: number } }>(request, 'cases', {
    ...location, previewHash: proposal.previewHash, confirmed: true, requestId: randomUUID(),
  })).case;
  const rows: Row[] = [
    ...Array.from({ length: 130 }, (_, i) => ({ id: `N-${String(i).padStart(3, '0')}`, supplier: 'S', status: 'offen', due: '2026-09-20' })),
    { id: 'd', supplier: 'S', status: 'offen', due: null },
    { id: 'a', supplier: 'S', status: 'erledigt', due: '2026-09-20' },
    { id: 'b', supplier: 'S', status: 'offen', due: '2026-09-23' },
    { id: 'c', supplier: 'S', status: 'erledigt', due: '2026-09-20' },
    { id: 'DUP', supplier: 'S', status: 'offen', due: '2026-09-20' },
    { id: 'DUP', supplier: 'S', status: 'offen', due: '2026-09-20' },
  ];
  let previousSetId = f.from.id;
  async function repeat(data: Row[]) {
    const from = await createSet(request, 'Bestellungen', data, previousSetId);
    previousSetId = from.id;
    const relation = await createRelationship(request, from, f.to);
    const selection = { relationshipId: relation.id, asOf: '2026-09-25' };
    const preview = await post<Preview>(request, `routines/${routine.id}/preview`, selection);
    const accepted = (await post<{ mission: Mission }>(request, `routines/${routine.id}/run`, {
      ...selection, previewHash: preview.previewHash, confirmed: true, requestId: randomUUID(),
    })).mission;
    return waitForMission(request, accepted.id, 'completed');
  }
  const first = await repeat(rows);
  const second = await repeat([{ id: 'c', supplier: 'S', status: 'erledigt', due: '2026-09-20' }]);
  let writes = 0; page.on('request', req => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method())) writes++; });
  await page.goto(`/#/missions?id=${first.id}`);
  await page.getByTestId('mission-compare-findings').click();
  const work = page.getByTestId('routine-run-comparison');
  await expect(work).toBeVisible();
  await expect(page.getByTestId('change-run')).toHaveValue(first.id);
  await expect(work).toContainText('Stichtag');
  await expect(work).toContainText('2026-09-23'); await expect(work).toContainText('2026-09-25');
  await expect(work.getByTestId('change-item')).toHaveCount(25);
  await page.getByTestId('change-filter').selectOption('cleared');
  const cleared = work.getByTestId('change-item'); await expect(cleared).toHaveCount(1);
  await expect(cleared).toContainText('"a"');
  await expect(cleared).toContainText('132');
  const caseLink = cleared.locator(`a[href="#/missions?case=${originalCase.id}"]`);
  await expect(caseLink).toBeVisible(); await expect(cleared).toContainText('Offen');
  await page.screenshot({ path: info.outputPath('routine-changes-desktop.png'), fullPage: true });
  await caseLink.click();
  await expect(page.getByTestId('case-detail')).toContainText('"a"');
  await page.goBack();
  await expect(page.getByTestId('change-filter')).toHaveValue('cleared');
  await page.getByTestId('change-filter').selectOption('new');
  for (let i = 0; i < 5; i++) {
    const response = page.waitForResponse(r => r.url().includes('/compare?') && new URL(r.url()).searchParams.get('offset') === String((i + 1) * 25));
    await page.getByTestId('change-next').click(); await response;
  }
  await expect(work.getByTestId('change-item')).toHaveCount(6);
  await page.reload();
  await expect(page.getByTestId('change-filter')).toHaveValue('new');
  await expect(work.getByTestId('change-item')).toHaveCount(6);
  await page.getByTestId('change-filter').selectOption('uncomparable');
  await expect(work.getByTestId('change-item')).toHaveCount(2);
  await expect(work.getByTestId('change-item').first()).toContainText('"DUP"');
  await page.getByTestId('change-filter').selectOption('persisting');
  await expect(work.getByTestId('change-item')).toHaveCount(1);
  await expect(work.getByTestId('change-item')).toContainText('"d"');
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: info.outputPath('routine-changes-mobile.png'), fullPage: true });
  await page.getByTestId('change-run').selectOption(second.id);
  await page.getByTestId('change-filter').selectOption('missing');
  await expect(work.getByTestId('change-item')).toHaveCount(2);
  const secondComparison = await get<{ counts: Counts; items: unknown[] }>(request, `routines/${routine.id}/compare?missionId=${second.id}`);
  expect(secondComparison.counts).toEqual({ new: 0, persisting: 0, cleared: 0, missing: 2, uncomparable: 0 });
  await page.reload();
  await expect(page.getByTestId('change-run')).toHaveValue(second.id);
  await expect(page.getByTestId('change-filter')).toHaveValue('missing');
  await expect(work.getByTestId('change-item')).toHaveCount(2);
  expect((await get<{ case: unknown }>(request, `cases/${originalCase.id}`)).case).toEqual(originalCase);
  expect((await get<{ mission: Mission }>(request, `missions/${f.mission.id}`)).mission.result).toEqual(f.mission.result);
  expect(writes).toBe(0); expect(errors).toEqual([]);
  // Long comparison lists do not bury the new-run form; keyboard tabs preserve its draft.
  await page.getByRole('tab', { name: 'Befunde vergleichen', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: 'Neuen Stand prüfen', exact: true })).toBeFocused();
  await expect(work).toHaveCount(0);
  await inspect(page, routine.id, f.relationship.id, '2026-09-27');
  await page.getByRole('tab', { name: 'Neuen Stand prüfen', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Befunde vergleichen', exact: true })).toBeFocused();
  await expect(work.getByTestId('change-item')).toHaveCount(2);
  const writesBeforeReload = writes;
  await page.reload();
  await expect(work.getByTestId('change-item')).toHaveCount(2);
  expect(writes, 'a comparison reload does not resume hidden run previews').toBe(writesBeforeReload);
  await page.getByRole('tab', { name: 'Neuen Stand prüfen', exact: true }).click();
  await expect(page.getByTestId('routine-as-of')).toHaveValue('2026-09-27');
  await expect(page.getByTestId('routine-preview')).toBeVisible();
  await expect(page.getByTestId('routine-run')).toBeDisabled();
  expect(errors).toEqual([]);
});

test('comparison failures retry and unavailable case links never imply missing cases', async ({ page, request }) => {
  test.setTimeout(60_000);
  const f = await completedFixture(request); const routine = await savedRoutine(request, f.mission);
  const selection = { relationshipId: f.relationship.id, asOf: '2026-09-24' };
  const preview = await post<Preview>(request, `routines/${routine.id}/preview`, selection);
  const accepted = (await post<{ mission: Mission }>(request, `routines/${routine.id}/run`, {
    ...selection, previewHash: preview.previewHash, confirmed: true, requestId: randomUUID(),
  })).mission;
  await waitForMission(request, accepted.id, 'completed');
  let compareAttempts = 0;
  await page.route(`**/api/routines/${routine.id}/compare?**`, async route => {
    if (++compareAttempts === 1) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Vergleich vorübergehend nicht verfügbar.' }) });
    else await route.continue();
  });
  const casePath = '**/api/cases';
  await page.route(casePath, route => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Keine Fallberechtigung.' }) }));
  let writes = 0; page.on('request', req => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method())) writes++; });
  await page.goto(`/#/missions?routine=${routine.id}&compare=${accepted.id}`);
  const work = page.getByTestId('routine-run-comparison');
  await expect(work).toContainText('Vergleich vorübergehend nicht verfügbar.');
  await expect(work).toContainText('Keine Fallberechtigung.');
  await expect(work.getByTestId('change-item')).toHaveCount(0);
  await page.getByTestId('change-compare-retry').click();
  await expect(work.getByTestId('change-item')).toHaveCount(3);
  await expect(work).toContainText('Klärungsfall-Verknüpfungen sind derzeit nicht verfügbar');
  await expect(work.getByRole('link', { name: 'Befunde öffnen', exact: true })).toHaveCount(0);
  await page.unroute(casePath);
  await page.getByTestId('change-cases-retry').click();
  await expect(work.getByRole('link', { name: 'Befunde öffnen', exact: true }).first()).toBeVisible();
  await expect(work).not.toContainText('Keine Fallberechtigung.');
  expect(compareAttempts).toBe(2); expect(writes).toBe(0);
  const invalidMission = randomUUID();
  await page.goto(`/#/missions?routine=${routine.id}&compare=${invalidMission}`);
  await expect(work).toContainText('Auftrag nicht gefunden.');
  await expect(work.getByTestId('change-item')).toHaveCount(0);
  await page.goto(`/#/missions?routine=${routine.id}&compare=${accepted.id}`);
  await expect(work.getByTestId('change-item')).toHaveCount(3);
  expect(writes).toBe(0);
});
