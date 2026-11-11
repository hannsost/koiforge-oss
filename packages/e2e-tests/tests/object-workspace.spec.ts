import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './authenticated-fixture.js';

const api = 'http://127.0.0.1:3191';

type Primitive = string | number | boolean;
type ObjectIdentity = 'unique' | 'missing' | 'duplicate';
type ObjectSet = {
  id: string;
  familyId: string;
  revision: number;
  previousId?: string;
  name: string;
  keyField: string;
  source: { datasetId: string; rowCount: number; hash: string };
  snapshotHash: string;
};
type ObjectFamily = { id: string; name: string; latest: ObjectSet; revisions: ObjectSet[] };
type WorkspaceObject = {
  objectId: string | null;
  sourceRow: number;
  key: Primitive | null;
  label: string;
  identity: ObjectIdentity;
  attributes: Record<string, Primitive | null>;
};
type ObjectPage = {
  objectSet: ObjectSet;
  items: WorkspaceObject[];
  offset: number;
  limit: number;
  totalRows: number;
  totalSourceRows: number;
};
type ObjectHistoryEntry = {
  objectSetId: string;
  revision: number;
  keyField: string;
  state: 'present' | 'ambiguous' | 'absent' | 'key_changed';
  sourceRows: number[];
  totalMatches: number;
};
type ObjectDetail = {
  objectId: string;
  key: Primitive;
  keyField: string;
  state: ObjectHistoryEntry['state'];
  objectSet: ObjectSet;
  object: WorkspaceObject | null;
  candidates: WorkspaceObject[];
  candidateCount: number;
  history: ObjectHistoryEntry[];
  relationships: Array<{
    relationship: { id: string; name: string; fromSetId: string; toSetId: string };
    direction: 'outgoing' | 'incoming';
    otherSet: ObjectSet;
    totalRows: number;
    linkedRows: number;
  }>;
};
type ObjectLinkPage = {
  relationship: { id: string; name: string };
  direction: 'outgoing' | 'incoming';
  objectSet: ObjectSet;
  otherSet: ObjectSet;
  items: Array<{
    status: string;
    sourceRow: number;
    reference: Primitive | null;
    object: WorkspaceObject | null;
  }>;
  offset: number;
  limit: number;
  totalRows: number;
};

async function importCsv(request: APIRequestContext, content: string): Promise<string> {
  const upload = await request.post(`${api}/api/import/sessions`, {
    multipart: {
      file: {
        name: `object-workspace-${randomUUID()}.csv`,
        mimeType: 'text/csv',
        buffer: Buffer.from(content),
      },
    },
  });
  if (!upload.ok()) throw new Error(await upload.text());
  const session = (await upload.json()).session;
  const leaf = Object.values(session.nodes).find(
    (node: any) => node.capabilityId === 'csv-file' && node.children.length === 0,
  ) as { id: string } | undefined;
  expect(leaf).toBeTruthy();
  const response = await request.post(`${api}/api/import/sessions/${session.id}/run`, {
    data: { selectedNodeIds: [leaf!.id] },
  });
  if (!response.ok()) throw new Error(await response.text());
  return (await response.json()).importedDatasets[0].id as string;
}

async function importJson(request: APIRequestContext, rows: Array<Record<string, Primitive | null>>): Promise<string> {
  const upload = await request.post(`${api}/api/import/sessions`, {
    multipart: {
      file: {
        name: `object-workspace-${randomUUID()}.json`,
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(rows)),
      },
    },
  });
  if (!upload.ok()) throw new Error(await upload.text());
  const session = (await upload.json()).session;
  const leaf = Object.values(session.nodes).find(
    (node: any) => node.capabilityId === 'json-file' && node.children.length === 0,
  ) as { id: string } | undefined;
  expect(leaf).toBeTruthy();
  const response = await request.post(`${api}/api/import/sessions/${session.id}/run`, {
    data: { selectedNodeIds: [leaf!.id] },
  });
  if (!response.ok()) throw new Error(await response.text());
  return (await response.json()).importedDatasets[0].id as string;
}

async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(`${api}/api/model/${path}`, { data });
  if (!response.ok()) throw new Error(await response.text());
  return response.json() as Promise<T>;
}

async function createObjectSet(
  request: APIRequestContext,
  datasetId: string,
  name: string,
  previousId?: string,
  keyField = 'id',
): Promise<ObjectSet> {
  const result = await post<{ objectSet: ObjectSet }>(request, 'object-sets', {
    name,
    datasetId,
    keyField,
    labelField: 'name',
    confirmed: true,
    requestId: randomUUID(),
    ...(previousId ? { previousId } : {}),
  });
  return result.objectSet;
}

async function createRelationship(
  request: APIRequestContext,
  name: string,
  fromSetId: string,
  toSetId: string,
  fromField: string,
): Promise<{ id: string; name: string; fromSetId: string; toSetId: string }> {
  const result = await post<{ relationship: { id: string; name: string; fromSetId: string; toSetId: string } }>(
    request,
    'relationships',
    { name, fromSetId, toSetId, fromField, confirmed: true, requestId: randomUUID() },
  );
  return result.relationship;
}

function query(values: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, value);
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

async function workspace<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(`${api}/api/object-workspace${path}`);
  if (!response.ok()) throw new Error(await response.text());
  return response.json() as Promise<T>;
}

async function families(request: APIRequestContext): Promise<ObjectFamily[]> {
  return (await workspace<{ items: ObjectFamily[] }>(request, '/families')).items;
}

async function objectPage(
  request: APIRequestContext,
  familyId: string,
  values: Record<string, string | undefined> = {},
): Promise<ObjectPage> {
  return workspace<ObjectPage>(request,
    `/families/${encodeURIComponent(familyId)}/objects${query(values)}`,
  );
}

async function objectDetail(
  request: APIRequestContext,
  familyId: string,
  objectId: string,
  setId?: string,
): Promise<ObjectDetail> {
  return workspace<ObjectDetail>(request,
    `/families/${encodeURIComponent(familyId)}/objects/${encodeURIComponent(objectId)}${query({ setId })}`,
  );
}

async function objectLinks(
  request: APIRequestContext,
  familyId: string,
  objectId: string,
  relationshipId: string,
  values: Record<string, string | undefined> = {},
): Promise<ObjectLinkPage> {
  return workspace<ObjectLinkPage>(request,
    `/families/${encodeURIComponent(familyId)}/objects/${encodeURIComponent(objectId)}/links/${encodeURIComponent(relationshipId)}${query(values)}`,
  );
}

function objectHash(familyId: string, objectId?: string | null, setId?: string): string {
  return `/#/objects?${query({ family: familyId, ...(objectId ? { object: objectId } : {}), ...(setId ? { set: setId } : {}) }).slice(1)}`;
}

function objectIdOf(page: ObjectPage, key: Primitive): string {
  const object = page.items.find((item) => item.key === key);
  expect(object, `Object with key ${String(key)} was not returned`).toBeTruthy();
  expect(object!.objectId).toMatch(/^[a-f0-9]{64}$/);
  return object!.objectId!;
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
}

test('generic Customers, Projects and Tickets navigate both relationship directions with pinned evidence', async ({ page, request }, info) => {
  const customers = await importCsv(request, 'id,name\nC-1,Customer One\nC-2,Customer Two\n');
  const projects = await importCsv(request, 'id,name,customer_id\nP-1,Project One,C-1\nP-2,Project Two,C-1\n');
  const tickets = await importCsv(request, 'id,name,project_id\nT-1,Ticket One,P-1\nT-2,Ticket Two,P-1\n');
  const customerSet = await createObjectSet(request, customers, `Customers ${randomUUID().slice(0, 8)}`);
  const projectSet = await createObjectSet(request, projects, `Projects ${randomUUID().slice(0, 8)}`);
  const ticketSet = await createObjectSet(request, tickets, `Tickets ${randomUUID().slice(0, 8)}`);
  const customerProjects = await createRelationship(request, 'Project belongs to customer', projectSet.id, customerSet.id, 'customer_id');
  const projectTickets = await createRelationship(request, 'Ticket belongs to project', ticketSet.id, projectSet.id, 'project_id');

  const listedFamilies = await families(request);
  const customerFamily = listedFamilies.find((item) => item.id === customerSet.familyId);
  expect(customerFamily).toMatchObject({ id: customerSet.familyId, latest: { id: customerSet.id, revision: 1 } });
  expect(customerFamily!.revisions.map((item) => item.id)).toContain(customerSet.id);

  const customerPage = await objectPage(request, customerSet.familyId, { setId: customerSet.id, limit: '25' });
  const projectPage = await objectPage(request, projectSet.familyId, { setId: projectSet.id, limit: '25' });
  const ticketPage = await objectPage(request, ticketSet.familyId, { setId: ticketSet.id, limit: '25' });
  const customerObjectId = objectIdOf(customerPage, 'C-1');
  const projectObjectId = objectIdOf(projectPage, 'P-1');
  const ticketObjectId = objectIdOf(ticketPage, 'T-1');

  const customerDetail = await objectDetail(request, customerSet.familyId, customerObjectId, customerSet.id);
  expect(customerDetail.object?.label).toBe('Customer One');
  expect(customerDetail.relationships).toEqual(expect.arrayContaining([
    expect.objectContaining({ relationship: expect.objectContaining({ id: customerProjects.id }), direction: 'incoming' }),
  ]));
  const customerLinks = await objectLinks(request, customerSet.familyId, customerObjectId, customerProjects.id, { setId: customerSet.id, limit: '1' });
  expect(customerLinks.direction).toBe('incoming');
  expect(customerLinks.totalRows).toBe(2);
  expect(customerLinks.items[0]!.object?.key).toBe('P-1');

  const projectDetail = await objectDetail(request, projectSet.familyId, projectObjectId, projectSet.id);
  expect(projectDetail.object?.label).toBe('Project One');
  expect(projectDetail.relationships).toEqual(expect.arrayContaining([
    expect.objectContaining({ relationship: expect.objectContaining({ id: customerProjects.id }), direction: 'outgoing' }),
    expect.objectContaining({ relationship: expect.objectContaining({ id: projectTickets.id }), direction: 'incoming' }),
  ]));
  const projectLinks = await objectLinks(request, projectSet.familyId, projectObjectId, projectTickets.id, { setId: projectSet.id, limit: '1' });
  expect(projectLinks.direction).toBe('incoming');
  expect(projectLinks.items[0]!.object?.key).toBe('T-1');

  await page.goto(objectHash(customerSet.familyId, customerObjectId));
  const workspace = page.getByTestId('object-workspace');
  await expect(workspace).toBeVisible();
  await expect(page.getByTestId('object-family').locator('select')).toHaveValue(customerSet.familyId);
  await expect(page.getByTestId('object-revision').locator('select')).toHaveValue('');
  await expect(page.getByTestId('object-detail')).toContainText('Customer One');
  expect(new URL(page.url()).hash).not.toContain('set=');
  const relationGroup = page.locator(`[data-testid="object-related-group"][data-relationship-id="${customerProjects.id}"]`);
  await expect(relationGroup).toBeVisible();
  if (!(await relationGroup.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await relationGroup.locator('summary').click();
  }
  await expect(relationGroup.getByTestId('object-links')).toBeVisible();
  await expect(relationGroup.getByTestId('object-links-previous')).toBeDisabled();
  await expect(relationGroup.getByTestId('object-links-next')).toBeDisabled();
  await expect(relationGroup).toContainText('Project One');
  await relationGroup.getByTestId('object-links').getByRole('link', { name: 'Project One' }).click();
  await expect(page.getByTestId('object-detail')).toContainText('Project One');
  expect(new URL(page.url()).hash).toContain(`set=${encodeURIComponent(projectSet.id)}`);

  // A relationship link from a sorted project must clear the project-specific
  // sort before opening the customer; the pinned family/set remains explicit.
  await page.goto(`${objectHash(projectSet.familyId, projectObjectId, projectSet.id)}&sortBy=name&sortDir=desc`);
  await expect(page.getByTestId('object-detail')).toContainText('Project One');
  const projectCustomerGroup = page.locator(`[data-testid="object-related-group"][data-relationship-id="${customerProjects.id}"]`);
  if (!(await projectCustomerGroup.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await projectCustomerGroup.locator('summary').click();
  }
  await expect(projectCustomerGroup.getByTestId('object-links')).toBeVisible();
  await projectCustomerGroup.getByTestId('object-links').getByRole('link', { name: 'Customer One' }).click();
  await expect(page.getByTestId('object-detail')).toContainText('Customer One');
  expect(new URL(page.url()).hash).not.toContain('sortBy=');
  expect(new URL(page.url()).hash).toContain(`set=${encodeURIComponent(customerSet.id)}`);

  // Deep-linking through the same family/object contract also works toward
  // the ticket side: the project has incoming tickets.
  await page.goto(objectHash(projectSet.familyId, projectObjectId));
  await expect(page.getByTestId('object-detail')).toContainText('Project One');
  await expect(page.locator(`[data-testid="object-related-group"][data-relationship-id="${customerProjects.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-testid="object-related-group"][data-relationship-id="${projectTickets.id}"]`)).toBeVisible();
  await page.goto(objectHash(ticketSet.familyId, ticketObjectId));
  await expect(page.getByTestId('object-detail')).toContainText('Ticket One');
  await expect(page.locator(`[data-testid="object-related-group"][data-relationship-id="${projectTickets.id}"]`)).toBeVisible();

  // The same object remains selected by family/object/set after a reload, so the
  // displayed relationship evidence cannot silently follow the latest revision.
  await page.goto(objectHash(customerSet.familyId, customerObjectId));
  await page.reload();
  await expect(page.getByTestId('object-detail')).toContainText('Customer One');
  expect(new URL(page.url()).hash).toContain(`object=${encodeURIComponent(customerObjectId)}`);
  expect(new URL(page.url()).hash).not.toContain('set=');

  await page.screenshot({ path: info.outputPath('object-workspace-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('object-workspace-mobile.png'), fullPage: true });
  expect(ticketObjectId).toMatch(/^[a-f0-9]{64}$/);
});

test('more than 100 objects support full-text search, paging, identity filtering and typed API filters', async ({ page, request }) => {
  const rows = Array.from({ length: 127 }, (_, index) => {
    const id = index + 1;
    const active = id % 2 === 0;
    const name = id === 117 ? 'Needle full text customer' : `Customer ${id}`;
    return { id, name, active, score: id % 7 };
  });
  const dataset = await importJson(request, rows);
  const set = await createObjectSet(request, dataset, `Large Customers ${randomUUID().slice(0, 8)}`);

  const firstPage = await objectPage(request, set.familyId, { setId: set.id, offset: '0', limit: '25', sortBy: 'id', sortDir: 'asc' });
  const secondPage = await objectPage(request, set.familyId, { setId: set.id, offset: '25', limit: '25', sortBy: 'id', sortDir: 'asc' });
  expect(firstPage.totalRows).toBe(127);
  expect(firstPage.totalSourceRows).toBe(127);
  expect(firstPage.items).toHaveLength(25);
  expect(secondPage.items[0]!.sourceRow).toBe(26);
  expect(secondPage.items.at(-1)!.sourceRow).toBe(50);

  const fullText = await objectPage(request, set.familyId, { setId: set.id, q: 'needle full text', limit: '25' });
  expect(fullText.totalRows).toBe(1);
  expect(fullText.items[0]!.label).toBe('Needle full text customer');
  const booleanFilter = await objectPage(request, set.familyId, {
    setId: set.id, filterField: 'active', filterValue: JSON.stringify(true), limit: '100',
  });
  expect(booleanFilter.totalRows).toBe(63);
  expect(booleanFilter.items.every((item) => item.attributes.active === true)).toBeTruthy();
  const numberFilter = await objectPage(request, set.familyId, {
    setId: set.id, filterField: 'score', filterValue: JSON.stringify(3), limit: '100',
  });
  expect(numberFilter.totalRows).toBe(18);
  expect(numberFilter.items.every((item) => item.attributes.score === 3)).toBeTruthy();
  const otherDataset = await importCsv(request, 'id,name\nOTHER,Other family object\n');
  const otherSet = await createObjectSet(request, otherDataset, `Other family ${randomUUID().slice(0, 8)}`);

  await page.goto(objectHash(set.familyId));
  await expect(page.getByTestId('object-list')).toBeVisible();
  await expect(page.getByTestId('object-row')).toHaveCount(25);
  await expect(page.getByTestId('object-next')).toBeEnabled();
  await page.getByTestId('object-search').fill('needle full text');
  await expect(page.getByTestId('object-row')).toHaveCount(1);
  await expect(page.getByTestId('object-row').first()).toContainText('Needle full text customer');
  await page.getByTestId('object-search').fill('');
  await expect(page.getByTestId('object-row')).toHaveCount(25);
  await page.getByTestId('object-next').click();
  await expect(page.getByTestId('object-row').first()).toHaveAttribute('data-source-row', '26');
  await page.getByTestId('object-previous').click();
  await expect(page.getByTestId('object-row').first()).toHaveAttribute('data-source-row', '1');
  await page.getByTestId('object-identity').locator('select').selectOption('unique');
  await expect(page.getByTestId('object-row')).toHaveCount(25);

  // On a narrow viewport, opening a record moves focus to the detail heading;
  // returning to results preserves the current page and identity filter.
  await page.getByTestId('object-next').click();
  await expect(page.getByTestId('object-row').first()).toHaveAttribute('data-source-row', '26');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByTestId('object-row').first().getByRole('link').first().click();
  const mobileDetailHeading = page.getByTestId('object-detail').getByRole('heading', { level: 3 });
  await expect(mobileDetailHeading).toBeVisible();
  await expect(mobileDetailHeading).toBeFocused();
  await page.getByRole('button', { name: 'Zur Ergebnisliste' }).click();
  await expect(page.getByTestId('object-list')).toBeVisible();
  await expect(page.getByTestId('object-row')).toHaveCount(25);
  expect(new URL(page.url()).hash).toContain('page=2');
  expect(new URL(page.url()).hash).toContain('identity=unique');
  expect(new URL(page.url()).hash).not.toContain('object=');

  // Typed UI filters produce the same primitive query as the API, and changing
  // families clears fields and sorting that belong to the previous schema.
  const advancedControls = page.locator('details').filter({ hasText: 'Filtern und sortieren' });
  if (await advancedControls.count()) {
    const open = await advancedControls.evaluate((element) => (element as HTMLDetailsElement).open);
    if (!open) await advancedControls.locator('summary').click();
  }
  await page.getByTestId('object-filter-field').selectOption('active');
  await page.getByTestId('object-filter-type').selectOption('boolean');
  await page.getByTestId('object-filter-value').selectOption('true');
  await page.getByTestId('object-sort').selectOption('score');
  await page.getByTestId('object-sort-dir').selectOption('desc');
  await page.getByTestId('object-family').locator('select').selectOption(otherSet.familyId);
  await expect(page.getByTestId('object-filter-field')).toHaveValue('');
  await expect(page.getByTestId('object-filter-type')).toHaveValue('text');
  await expect(page.getByTestId('object-filter-value')).toHaveValue('');
  await expect(page.getByTestId('object-identity').locator('select')).toHaveValue('');
  await expect(page.getByTestId('object-search')).toHaveValue('');
  await expect(page.getByTestId('object-sort')).toHaveValue('');
  await expect(page.getByTestId('object-sort-dir')).toHaveValue('asc');
});

test('revisions preserve identity when rows move and expose deleted, duplicate and key-changed evidence', async ({ page, request }) => {
  const originalDataset = await importCsv(request, [
    'id,name',
    'MOVE,Moved object',
    'DELETE,Deleted object',
    'DUP,Duplicate one',
    'DUP,Duplicate two',
    'CHANGE,Key changes',
  ].join('\n'));
  const revisedDataset = await importCsv(request, [
    'id,name',
    'OTHER,Other object',
    'MOVE,Moved object',
    'DUP,Duplicate one',
    'DUP,Duplicate two',
  ].join('\n'));
  const original = await createObjectSet(request, originalDataset, `Revision Customers ${randomUUID().slice(0, 8)}`);
  const revised = await createObjectSet(request, revisedDataset, original.name, original.id);
  expect(revised.familyId).toBe(original.familyId);
  expect(revised.revision).toBe(2);
  expect(revised.previousId).toBe(original.id);

  const originalPage = await objectPage(request, original.familyId, { setId: original.id, limit: '100' });
  const revisedPage = await objectPage(request, original.familyId, { setId: revised.id, limit: '100' });
  expect(revisedPage.items.find((item) => item.key === 'MOVE')?.sourceRow).toBe(2);
  expect(revisedPage.items.filter((item) => item.key === 'DUP').map((item) => item.identity)).toEqual(['duplicate', 'duplicate']);
  const moveId = objectIdOf(originalPage, 'MOVE');
  const deletedId = objectIdOf(originalPage, 'DELETE');

  const moveDetail = await objectDetail(request, original.familyId, moveId, revised.id);
  expect(moveDetail.state).toBe('present');
  expect(moveDetail.object?.sourceRow).toBe(2);
  expect(moveDetail.history).toEqual(expect.arrayContaining([
    expect.objectContaining({ objectSetId: original.id, revision: 1, state: 'present', sourceRows: [1] }),
    expect.objectContaining({ objectSetId: revised.id, revision: 2, state: 'present', sourceRows: [2] }),
  ]));
  const deletedDetail = await objectDetail(request, original.familyId, deletedId, revised.id);
  expect(deletedDetail.state).toBe('absent');
  expect(deletedDetail.object).toBeNull();

  // Changing the confirmed key field is a separate, explicit evidence state;
  // it must not be confused with a deleted value in an otherwise stable key.
  const keyOriginalDataset = await importCsv(request, 'id,name\nCHANGE,Key changes\n');
  const keyRevisedDataset = await importCsv(request, 'new_id,name\nCHANGE-NEW,Key changes\n');
  const keyOriginal = await createObjectSet(request, keyOriginalDataset, `Key revision ${randomUUID().slice(0, 8)}`);
  const keyRevised = await createObjectSet(request, keyRevisedDataset, keyOriginal.name, keyOriginal.id, 'new_id');
  const keyOriginalPage = await objectPage(request, keyOriginal.familyId, { setId: keyOriginal.id, limit: '100' });
  const changedId = objectIdOf(keyOriginalPage, 'CHANGE');
  const changedDetail = await objectDetail(request, keyOriginal.familyId, changedId, keyRevised.id);
  expect(changedDetail.state).toBe('key_changed');
  expect(changedDetail.object).toBeNull();
  expect(changedDetail.history).toEqual(expect.arrayContaining([
    expect.objectContaining({ objectSetId: keyOriginal.id, revision: 1, state: 'present' }),
    expect.objectContaining({ objectSetId: keyRevised.id, revision: 2, state: 'key_changed' }),
  ]));

  await page.goto(objectHash(original.familyId, moveId));
  await expect(page.getByTestId('object-detail')).toContainText('Moved object');
  await expect(page.getByTestId('object-revision').locator('select')).toHaveValue('');
  await page.getByTestId('object-revision').locator('select').selectOption(original.id);
  await expect(page.getByTestId('object-detail')).toContainText('Moved object');
  expect(new URL(page.url()).hash).toContain(`set=${encodeURIComponent(original.id)}`);
});

test('a transient detail failure clears stale evidence and retry restores the selected object', async ({ page, request }) => {
  const dataset = await importCsv(request, 'id,name\nA,First object\nB,Second object\n');
  const set = await createObjectSet(request, dataset, `Retry Customers ${randomUUID().slice(0, 8)}`);
  const listed = await objectPage(request, set.familyId, { setId: set.id, limit: '25' });
  const firstId = objectIdOf(listed, 'A');
  const secondId = objectIdOf(listed, 'B');
  await page.goto(objectHash(set.familyId, firstId));
  await expect(page.getByTestId('object-detail')).toContainText('First object');

  let failNextDetail = false;
  await page.route('**/api/object-workspace/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (failNextDetail && /\/objects\/[^/]+$/.test(pathname)) {
      failNextDetail = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic transient outage' }) });
      return;
    }
    await route.continue();
  });
  failNextDetail = true;
  const secondRow = page.getByTestId('object-row').filter({ hasText: 'Second object' });
  await expect(secondRow).toBeVisible();
  await secondRow.getByRole('link', { name: 'Second object' }).click();
  await expect(page.getByTestId('object-workspace-retry')).toBeVisible();
  await expect(page.getByTestId('object-detail')).not.toContainText('First object');
  await expect(page.getByTestId('object-detail')).not.toContainText('Second object');
  await page.getByTestId('object-workspace-retry').click();
  await expect(page.getByTestId('object-detail')).toContainText('Second object');
  expect(new URL(page.url()).hash).toContain(`object=${encodeURIComponent(secondId)}`);
});

test('an unknown family in the explicit hash remains selected and renders a not-found state', async ({ page }) => {
  const unknownFamily = '00000000-0000-4000-8000-000000000000';
  await page.goto(`/#/objects?family=${unknownFamily}`);
  await expect(page.getByTestId('object-workspace')).toBeVisible();
  await expect(page.getByTestId('object-workspace')).toContainText(/nicht gefunden|nicht verfügbar|not found|unknown/i);
  expect(new URL(page.url()).hash).toContain(`family=${unknownFamily}`);
});
