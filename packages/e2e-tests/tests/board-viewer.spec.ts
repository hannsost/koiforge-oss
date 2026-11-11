import { expect, test, type APIRequestContext } from '@playwright/test';

async function bootstrap(request: APIRequestContext) {
  await request.post('http://127.0.0.1:3100/api/bootstrap/examples', { data: {} });
  await request.post('http://127.0.0.1:3100/api/bootstrap/datasets', { data: {} });
  await request.post('http://127.0.0.1:3100/api/bootstrap/assets', { data: {} });
}

test.beforeEach(async ({ request }) => {
  await bootstrap(request);
});

test('renders board canvas and grouping controls', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('nav-boards').click();

  await expect(page.getByTestId('board-canvas')).toBeVisible();
  await expect(page.getByTestId('board-group-none')).toBeVisible();
  await expect(page.getByTestId('board-group-status')).toBeVisible();
  await expect(page.getByTestId('board-group-type')).toBeVisible();
});

test('switches board grouping modes', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('nav-boards').click();

  await expect(page.getByTestId('board-canvas')).toBeVisible();

  await page.getByTestId('board-group-status').click();
  await expect(page.getByTestId('board-group-status')).toHaveClass(/bg-brand/);

  await page.getByTestId('board-group-type').click();
  await expect(page.getByTestId('board-group-type')).toHaveClass(/bg-brand/);

  await page.getByTestId('board-group-none').click();
  await expect(page.getByTestId('board-group-none')).toHaveClass(/bg-brand/);
});
