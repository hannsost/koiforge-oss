import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './authenticated-fixture.js';

const api = 'http://127.0.0.1:3191';

async function importCsv(request: APIRequestContext, content: string): Promise<string> {
  const upload = await request.post(`${api}/api/import/sessions`, {
    multipart: { file: { name: `project-sharing-${randomUUID()}.csv`, mimeType: 'text/csv', buffer: Buffer.from(content) } },
  });
  if (!upload.ok()) throw new Error(await upload.text());
  const session = (await upload.json()).session as { id: string; nodes: Record<string, { capabilityId?: string; children: string[] }> };
  const leaf = Object.entries(session.nodes).find(([, node]) => node.capabilityId === 'csv-file' && node.children.length === 0)?.[0];
  expect(leaf).toBeTruthy();
  const run = await request.post(`${api}/api/import/sessions/${session.id}/run`, { data: { selectedNodeIds: [leaf] } });
  if (!run.ok()) throw new Error(await run.text());
  return (await run.json()).importedDatasets[0].id as string;
}

async function createObjectSet(request: APIRequestContext, datasetId: string): Promise<{ id: string; familyId: string }> {
  const response = await request.post(`${api}/api/model/object-sets`, { data: {
    name: `Shared family ${randomUUID().slice(0, 8)}`,
    datasetId,
    keyField: 'id',
    labelField: 'name',
    confirmed: true,
    requestId: randomUUID(),
  } });
  if (!response.ok()) throw new Error(await response.text());
  return (await response.json()).objectSet as { id: string; familyId: string };
}

async function objectId(request: APIRequestContext, familyId: string, setId: string): Promise<string> {
  const response = await request.get(`${api}/api/object-workspace/families/${encodeURIComponent(familyId)}/objects?setId=${encodeURIComponent(setId)}`);
  if (!response.ok()) throw new Error(await response.text());
  const item = (await response.json()).items[0] as { objectId: string };
  expect(item.objectId).toMatch(/^[a-f0-9]{64}$/);
  return item.objectId;
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
}

test('owner shares a confirmed family with a real reader and revocation removes the deep link', async ({ page, request, browser }, info) => {
  test.setTimeout(90_000);
  const datasetId = await importCsv(request, 'id,name\nSHARED-1,Shared object\n');
  const set = await createObjectSet(request, datasetId);
  const sharedObjectId = await objectId(request, set.familyId, set.id);
  const familiesResponse = await request.get(`${api}/api/object-workspace/families`);
  expect(familiesResponse.ok()).toBeTruthy();
  const family = ((await familiesResponse.json()).items as Array<{ id: string }>).find((item) => item.id === set.familyId);
  expect(family).toBeTruthy();

  await page.goto('/#/projects');
  await expect(page.getByTestId('project-workspace')).toBeVisible();
  await page.getByTestId('project-create').click();
  const projectName = `Reader project ${randomUUID().slice(0, 8)}`;
  await page.getByTestId('project-name').fill(projectName);
  await page.getByTestId('project-description').fill('A deliberately bounded read-only workspace.');
  await page.getByTestId(`project-family-${set.familyId}`).check();
  await page.getByTestId('project-confirm').check();
  await page.getByTestId('project-save').click();
  await expect(page.getByTestId('project-detail')).toContainText(projectName);
  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('project-owner-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  const inviteEmail = `reader-${randomUUID()}@example.test`;
  await page.getByTestId('team-email').fill(inviteEmail);
  await page.getByTestId('team-name').fill('Read only colleague');
  await page.getByTestId('team-invite').click();
  await expect(page.getByTestId('team-invitation-link')).toBeVisible();
  const teamResponse = await request.get(`${api}/api/team`);
  expect(teamResponse.ok()).toBeTruthy();
  const member = ((await teamResponse.json()).items as Array<{ id: string; email: string }>).find((item) => item.email === inviteEmail);
  expect(member).toBeTruthy();
  await expect(page.getByTestId(`project-member-${member!.id}`)).toBeVisible();
  await page.getByTestId(`project-member-${member!.id}`).check();
  await page.getByTestId('project-confirm').check();
  await page.getByTestId('project-save').click();
  await expect(page.getByTestId('project-detail')).toContainText('Revision 2');

  const projectResponse = await request.get(`${api}/api/projects`);
  expect(projectResponse.ok()).toBeTruthy();
  const project = ((await projectResponse.json()).items as Array<{ id: string; name: string }>).find((item) => item.name === projectName);
  expect(project).toBeTruthy();
  const invitationUrl = await page.getByTestId('team-invitation-link').textContent();
  expect(invitationUrl).toMatch(/#\/join\?token=/);
  expect(new URL(invitationUrl!).hash).toMatch(/^#\/join\?token=/);

  const readerContext = await browser.newContext({ baseURL: 'http://127.0.0.1:5191' });
  const readerPage = await readerContext.newPage();
  const readerApiRequests: string[] = [];
  readerPage.on('request', (entry) => {
    if (entry.url().includes('/api/')) readerApiRequests.push(entry.url());
  });
  try {
    await readerPage.goto(invitationUrl!);
    await readerPage.getByLabel('Passwort').fill('reader local passphrase 2026');
    await readerPage.getByRole('button', { name: 'Einladung annehmen' }).click();
    await expect(readerPage.getByTestId('project-workspace')).toBeVisible();
    await readerPage.goto('/#/model');
    await expect(readerPage.getByTestId('project-workspace')).toBeVisible();
    expect(readerApiRequests.some((url) => /\/api\/(datasets|model|import|missions|saved-views|boards|config|team)(?:\/|\?|$)/.test(url))).toBeFalsy();
    await readerPage.getByRole('link', { name: 'KoiForge Projekte' }).click();
    await expect(readerPage.getByTestId('project-workspace')).toBeVisible();
    await readerPage.getByRole('button', { name: projectName }).click();
    await expect(readerPage.getByTestId('project-open-objects')).toBeVisible();
    await readerPage.getByTestId('project-open-objects').click();
    await expect(readerPage.getByTestId('object-workspace')).toBeVisible();
    await expect(readerPage.getByTestId('object-project').locator('select')).toHaveValue(project!.id);
    await expect(readerPage.getByTestId('object-row')).toBeVisible();
    await readerPage.getByTestId('object-row').getByRole('link').first().click();
    await expect(readerPage.getByTestId('object-detail')).toContainText('Shared object');
    expect(new URL(readerPage.url()).hash).toContain(`project=${encodeURIComponent(project!.id)}`);
    await readerPage.goto(`/#/objects?project=${encodeURIComponent(project!.id)}&family=${encodeURIComponent(set.familyId)}&object=${encodeURIComponent(sharedObjectId)}&set=${encodeURIComponent(set.id)}`);
    await expect(readerPage.getByTestId('object-detail')).toContainText('Shared object');

    const deniedLegacy = await readerContext.request.get(`${api}/api/datasets`);
    expect(deniedLegacy.status()).toBe(403);
    await readerPage.reload();
    await expect(readerPage.getByTestId('object-detail')).toContainText('Shared object');
    await readerPage.setViewportSize({ width: 375, height: 812 });
    await expectNoHorizontalOverflow(readerPage);

    await page.goto(`/#/projects?id=${encodeURIComponent(project!.id)}`);
    await expect(page.getByTestId(`project-member-${member!.id}`)).toBeChecked();
    await page.getByTestId(`project-member-${member!.id}`).uncheck();
    await page.getByTestId('project-confirm').check();
    await page.getByTestId('project-save').click();
    await expect(page.getByTestId('project-detail')).toContainText('Revision 3');

    await readerPage.reload();
    await expect(readerPage.getByTestId('object-workspace')).toContainText('Projekt nicht gefunden');
    await readerPage.goto(`/#/projects?id=${encodeURIComponent(project!.id)}`);
    await expect(readerPage.getByTestId('project-workspace')).not.toContainText(projectName);
  } finally {
    await readerContext.close();
  }
});

test('project editing handles a stale revision and keeps create mode from existing detail', async ({ page, request }) => {
  test.setTimeout(60_000);
  const datasetId = await importCsv(request, 'id,name\nCONFLICT-1,Conflict object\n');
  const set = await createObjectSet(request, datasetId);
  await page.goto('/#/projects');
  await page.getByTestId('project-create').click();
  const projectName = `Conflict project ${randomUUID().slice(0, 8)}`;
  await page.getByTestId('project-name').fill(projectName);
  await page.getByTestId(`project-family-${set.familyId}`).check();
  await page.getByTestId('project-confirm').check();
  await page.getByTestId('project-save').click();
  await expect(page.getByTestId('project-detail')).toContainText('Revision 1');

  const list = await request.get(`${api}/api/projects`);
  const project = ((await list.json()).items as Array<{ id: string; name: string; familyCount: number }>).find((item) => item.name === projectName);
  expect(project).toBeTruthy();
  const serverUpdate = await request.patch(`${api}/api/projects/${project!.id}`, { data: {
    name: 'Server revision 2', description: 'Changed elsewhere', familyIds: [set.familyId], memberIds: [],
    confirmed: true, requestId: randomUUID(), revision: 1,
  } });
  expect(serverUpdate.ok()).toBeTruthy();

  await page.getByTestId('project-name').fill('Stale browser edit');
  await page.getByTestId('project-confirm').check();
  await page.getByTestId('project-save').click();
  await expect(page.getByTestId('project-detail')).toContainText('Revision 2');
  await expect(page.getByTestId('project-name')).toHaveValue('Server revision 2');
  await expect(page.getByTestId('project-confirm')).not.toBeChecked();
  await expect(page.getByRole('alert')).toContainText('inzwischen geändert');

  await page.getByTestId('project-name').fill('Browser revision 3');
  await page.getByTestId('project-confirm').check();
  await page.getByTestId('project-save').click();
  await expect(page.getByTestId('project-detail')).toContainText('Revision 3');
  await expect(page.getByTestId('project-name')).toHaveValue('Browser revision 3');

  await page.getByTestId('project-create').click();
  await expect(page.getByTestId('project-name')).toHaveValue('');
  await expect(page.getByTestId('project-confirm')).not.toBeChecked();
});

test('a late save response keeps the newly selected project editable', async ({ page, request }) => {
  const create = async (name: string) => {
    const response = await request.post(`${api}/api/projects`, { data: { name, description: '', familyIds: [], memberIds: [], confirmed: true, requestId: randomUUID() } });
    expect(response.ok()).toBeTruthy(); return (await response.json()).project as { id: string; name: string };
  };
  const first = await create(`First ${randomUUID()}`); const second = await create(`Second ${randomUUID()}`);
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered: () => void = () => undefined;
  const pending = new Promise<void>(resolve => { entered = resolve; });
  await page.route(`${api}/api/projects/${first.id}`, async route => {
    if (route.request().method() === 'PATCH') { entered(); await gate; }
    await route.continue();
  });
  await page.goto(`/#/projects?id=${first.id}`);
  await expect(page.getByTestId('project-name')).toHaveValue(first.name);
  await page.getByTestId('project-name').fill('Saved in background');
  await page.getByTestId('project-confirm').check();
  await page.getByTestId('project-save').click(); await pending;
  try {
    await page.getByRole('button', { name: new RegExp(second.name) }).click();
    await expect(page.getByTestId('project-name')).toHaveValue(second.name);
    const completed = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith(first.id));
    release(); expect((await completed).status()).toBe(200);
    await expect(page).toHaveURL(new RegExp(`id=${second.id}$`));
    await expect(page.getByTestId('project-name')).toHaveValue(second.name);
    await page.getByTestId('project-confirm').check();
    await expect(page.getByTestId('project-save')).toBeEnabled();
  } finally { release(); }
});
