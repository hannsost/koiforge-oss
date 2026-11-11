import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './authenticated-fixture.js';

const api = 'http://127.0.0.1:3191';
type ObjectSet = { id: string; familyId: string; revision: number; name: string; keyField: string; labelField?: string; source: { columns: string[]; rowCount: number; hash: string }; snapshotHash: string };

async function importCsv(request: APIRequestContext, content: string): Promise<string> {
  const upload = await request.post(`${api}/api/import/sessions`, { multipart: { file: {
    name: `dataflow-${randomUUID()}.csv`, mimeType: 'text/csv', buffer: Buffer.from(content),
  } } });
  expect(upload.ok(), await upload.text()).toBeTruthy();
  const session = (await upload.json()).session;
  const leaf = Object.values(session.nodes).find((node: any) => node.capabilityId === 'csv-file' && node.children.length === 0) as { id: string };
  expect(leaf).toBeTruthy();
  const response = await request.post(`${api}/api/import/sessions/${session.id}/run`, { data: { selectedNodeIds: [leaf.id] } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()).importedDatasets[0].id as string;
}

async function createObjectSet(request: APIRequestContext, datasetId: string, name: string, previousId?: string): Promise<ObjectSet> {
  const response = await request.post(`${api}/api/model/object-sets`, { data: {
    name, datasetId, keyField: 'id', labelField: 'name', confirmed: true, requestId: randomUUID(), ...(previousId ? { previousId } : {}),
  } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()).objectSet as ObjectSet;
}

async function noHorizontalOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
}

function routeFlowId(page: Page): string {
  return new URLSearchParams(page.url().split('?')[1] ?? '').get('id')!;
}

test('three sources refresh data, block changed schemas, and publish only confirmed revisions', async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const customersDataset = await importCsv(request, 'id,name\nC-1,Alpha\nC-2,Beta\n');
  const projectsDataset = await importCsv(request, 'id,name,customer_id\nP-1,Project One,C-1\nP-2,Project Two,C-2\n');
  const ticketsDataset = await importCsv(request, 'id,name,project_id\nT-1,Ticket One,P-1\nT-2,Ticket Two,P-2\n');
  const customers = await createObjectSet(request, customersDataset, `Flow customers ${randomUUID().slice(0, 8)}`);
  const projects = await createObjectSet(request, projectsDataset, `Flow projects ${randomUUID().slice(0, 8)}`);
  const tickets = await createObjectSet(request, ticketsDataset, `Flow tickets ${randomUUID().slice(0, 8)}`);

  await page.goto('/#/dataflows');
  await expect(page.getByTestId('flow-workspace')).toBeVisible();
  await page.getByTestId('flow-create').click();
  await page.getByTestId('flow-name').fill(`Customer enrichment ${randomUUID().slice(0, 8)}`);
  await page.getByTestId('flow-input').selectOption(tickets.familyId);
  await page.getByTestId('flow-key').selectOption('id');

  const addJoin = page.getByRole('button', { name: 'Verknüpfung hinzufügen' });
  await addJoin.click();
  const projectJoin = page.locator('.dataflow-join').nth(0);
  await projectJoin.getByLabel('Rechte Objektfamilie').selectOption(projects.familyId);
  await projectJoin.getByLabel('Linkes Feld').selectOption('project_id');
  await projectJoin.getByLabel('Rechtes Feld').selectOption('id');
  await projectJoin.getByLabel('Erforderlich:', { exact: false }).check();
  await projectJoin.getByRole('checkbox', { name: 'customer_id', exact: true }).check();
  await projectJoin.getByLabel('Ausgabename für customer_id').fill('customerId');

  await addJoin.click();
  const customerJoin = page.locator('.dataflow-join').nth(1);
  await customerJoin.getByLabel('Rechte Objektfamilie').selectOption(customers.familyId);
  await customerJoin.getByLabel('Linkes Feld').selectOption('customerId');
  await customerJoin.getByLabel('Rechtes Feld').selectOption('id');
  await customerJoin.getByLabel('Erforderlich:', { exact: false }).check();
  await customerJoin.getByRole('checkbox', { name: 'name', exact: true }).check();
  await customerJoin.getByLabel('Ausgabename für name').fill('customerName');
  await page.getByLabel('Anzeigename', { exact: false }).selectOption('customerName');

  await page.getByTestId('flow-confirm').check();
  await page.getByTestId('flow-save').click();
  await expect(page.getByTestId('flow-run')).toBeVisible();
  const flowId = routeFlowId(page);
  expect(flowId).toMatch(/^[0-9a-f-]{36}$/);

  await page.getByTestId('flow-run-confirm').check();
  await page.getByTestId('flow-run').click();
  await expect(page.getByTestId('flow-run-detail')).toContainText('Bereit', { timeout: 15_000 });
  await expect(page.getByTestId('flow-output-row').first()).toBeVisible();
  await page.getByTestId('flow-publish-confirm').check();
  await page.getByTestId('flow-publish').click();
  await expect(page.getByTestId('flow-published-object')).toBeVisible();
  const publishedHref = await page.getByTestId('flow-published-object').getAttribute('href');
  expect(publishedHref).toContain('#/objects?family=');

  await expect(page.getByTestId('flow-output-row')).toHaveCount(2);
  await expect(page.getByTestId('flow-published-object')).toContainText('Revision 1');
  const revisedCustomersDataset = await importCsv(request, 'id,name\nC-1,Alpha updated\nC-2,Beta\n');
  const customerRevision2 = await createObjectSet(request, revisedCustomersDataset, customers.name, customers.id);
  await page.reload();
  await expect(page.getByText('Eine Eingangsquelle hat eine neue Revision.')).toBeVisible();
  await page.getByTestId('flow-run-confirm').check();
  await page.getByTestId('flow-run').click();
  await expect(page.getByTestId('flow-run-detail')).toContainText('Bereit');
  await expect(page.getByTestId('flow-output-row').first()).toContainText('Alpha updated');
  await page.getByTestId('flow-publish-confirm').check();
  await page.getByTestId('flow-publish').click();
  await expect(page.getByTestId('flow-published-object')).toContainText('Revision 2');
  const revision2Href = await page.getByTestId('flow-published-object').getAttribute('href');

  const changedSchemaDataset = await importCsv(request, 'id,name,region\nC-1,Alpha updated,North\nC-2,Beta,South\n');
  await createObjectSet(request, changedSchemaDataset, customers.name, customerRevision2.id);
  await page.reload();
  await page.getByTestId('flow-run-confirm').check();
  await page.getByTestId('flow-run').click();
  await expect(page.getByTestId('flow-run-detail')).toContainText('Schema');
  await expect(page.getByTestId('flow-run-detail')).toContainText('blockiert');
  await expect(page.getByTestId('flow-publish')).toHaveCount(0);
  await expect(page.getByTestId('flow-published-object')).toHaveAttribute('href', revision2Href!);
  await noHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('dataflow-desktop.png'), fullPage: true });

  // The reopened editor offers newly available fields without reselecting the family.
  await customerJoin.getByRole('checkbox', { name: 'region', exact: true }).check();
  await customerJoin.getByLabel('Ausgabename für region').fill('customerRegion');
  await expect(page.getByTestId('flow-run')).toBeDisabled();
  // Reconfirm the revised schema; no automatic execution or publication occurs.
  await page.getByTestId('flow-confirm').check();
  await page.getByTestId('flow-save').click();
  await expect(page.locator('.dataflow-detail-heading')).toContainText('Revision 2');
  await page.getByTestId('flow-run-confirm').check();
  await page.getByTestId('flow-run').click();
  await expect(page.getByTestId('flow-run-detail')).toContainText('Bereit');
  await expect(page.getByTestId('flow-published-object')).toHaveAttribute('href', revision2Href!);

  await expect(page.getByTestId('flow-output-row').first()).toContainText('North');
  await page.setViewportSize({ width: 375, height: 812 });
  await noHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('dataflow-mobile.png'), fullPage: true });
  await page.getByTestId('flow-published-object').click();
  await expect(page).toHaveURL(/#\/objects\?family=/);
  await expect(page.getByTestId('object-revision')).toBeVisible();
  await noHorizontalOverflow(page);
});

test('a lost save response can be retried after reload without duplicating the flow', async ({ page, request }) => {
  const dataset = await importCsv(request, 'id,name\nS-1,Safe retry\n');
  const source = await createObjectSet(request, dataset, `Retry source ${randomUUID().slice(0, 8)}`);
  const name = `Retry flow ${randomUUID()}`;
  await page.goto('/#/dataflows');
  await page.getByTestId('flow-create').click();
  await page.getByTestId('flow-name').fill(name);
  await page.getByTestId('flow-input').selectOption(source.familyId);
  let firstRequestId = '';
  await page.route('**/api/dataflows', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    firstRequestId = route.request().postDataJSON().requestId;
    const committed = await route.fetch();
    expect(committed.ok(), await committed.text()).toBeTruthy();
    await route.abort('failed');
  });
  await page.getByTestId('flow-confirm').check();
  await page.getByTestId('flow-save').click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(firstRequestId).toMatch(/^[0-9a-f-]{36}$/);
  await page.unroute('**/api/dataflows');
  await page.reload();
  await expect(page.getByTestId('flow-name')).toHaveValue(name);
  let retriedRequestId = '';
  await page.route('**/api/dataflows', async route => {
    if (route.request().method() === 'POST') retriedRequestId = route.request().postDataJSON().requestId;
    await route.continue();
  });
  await page.getByTestId('flow-confirm').check();
  await page.getByTestId('flow-save').click();
  await expect(page.getByTestId('flow-run')).toBeVisible();
  expect(retriedRequestId).toBe(firstRequestId);
  const response = await request.get(`${api}/api/dataflows`);
  expect(response.ok()).toBeTruthy();
  expect((await response.json()).items.filter((item: { name: string }) => item.name === name)).toHaveLength(1);
});

test('typed filter values preserve boolean, number and null through editing and reload', async ({ page, request }) => {
  const sourceName = `Typed values ${randomUUID()}`;
  const registration = await request.post(`${api}/api/datasets/inline`, { data: { name: sourceName,
    rows: [{ id: 'typed-1', name: 'One', urgent: true, amount: 7, comment: null },
      { id: 'typed-2', name: 'Two', urgent: false, amount: 7, comment: 'present' }] } });
  expect(registration.ok(), await registration.text()).toBeTruthy();
  const source = await createObjectSet(request, (await registration.json()).id, sourceName);
  await page.goto('/#/dataflows');
  await page.getByTestId('flow-create').click();
  await page.getByTestId('flow-name').fill(sourceName);
  await page.getByTestId('flow-input').selectOption(source.familyId);
  const expected = [
    { field: 'urgent', kind: 'boolean', value: true },
    { field: 'amount', kind: 'number', value: 7 },
    { field: 'comment', kind: 'null', value: null },
  ];
  for (const [index, filter] of expected.entries()) {
    await page.getByRole('button', { name: 'Filter hinzufügen' }).click();
    const row = page.locator('.dataflow-filter-row').nth(index);
    await row.getByLabel('Filterfeld', { exact: true }).selectOption(filter.field);
    await row.getByLabel('Filterwerttyp', { exact: true }).selectOption(filter.kind);
    if (filter.kind === 'number') await row.getByLabel('Filterwert', { exact: true }).fill(String(filter.value));
    if (filter.kind === 'boolean') await expect(row.getByLabel('Filterwert', { exact: true })).toHaveValue('true');
  }
  await page.getByTestId('flow-confirm').check();
  await page.getByTestId('flow-save').click();
  await expect(page.getByTestId('flow-run')).toBeVisible();
  const id = routeFlowId(page);
  await page.reload();
  for (const [index, filter] of expected.entries()) {
    await expect(page.locator('.dataflow-filter-row').nth(index).getByLabel('Filterwerttyp', { exact: true })).toHaveValue(filter.kind);
  }
  await page.getByTestId('flow-name').fill(`${sourceName} revised`);
  await page.getByTestId('flow-confirm').check();
  await page.getByTestId('flow-save').click();
  await expect(page.locator('.dataflow-detail-heading')).toContainText('Revision 2');
  const stored = await request.get(`${api}/api/dataflows/${id}`);
  expect((await stored.json()).definition.spec.filters).toEqual(expected.map(filter => ({ field: filter.field, operator: 'eq', value: filter.value })));
  await page.getByTestId('flow-run-confirm').check();
  await page.getByTestId('flow-run').click();
  await expect(page.getByTestId('flow-output-row')).toHaveCount(1);
  await expect(page.getByTestId('flow-output-row')).toContainText('typed-1');
});
