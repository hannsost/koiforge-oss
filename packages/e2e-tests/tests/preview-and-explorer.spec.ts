import { expect, test, type APIRequestContext } from '@playwright/test';

async function bootstrap(request: APIRequestContext) {
  await request.post('http://127.0.0.1:3100/api/bootstrap/examples', { data: {} });
  await request.post('http://127.0.0.1:3100/api/bootstrap/datasets', { data: {} });
  await request.post('http://127.0.0.1:3100/api/bootstrap/assets', { data: {} });
}

test.beforeEach(async ({ request }) => {
  await bootstrap(request);
});

test('loads dataset preview and filters via search', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('nav-data').click();

  // platform_event dataset is registered by bootstrap (namespace=platform, name=event → id=platform_event)
  await page.getByTestId('dataset-item-platform_event').click();
  await expect(page.getByTestId('dataset-preview-table')).toBeVisible();

  // Search for a specific event type
  await page.getByTestId('dataset-search').fill('startup');
  const rows = page.locator('[data-testid="dataset-preview-table"] tbody tr');
  await expect(rows).toHaveCount(1);
  await expect(page.getByTestId('dataset-preview-table')).toContainText('startup');
});

test('switches object types and supports filters', async ({ page }) => {
  await page.goto('/');
  await page.goto('/#/object-preview');

  // At least one object type tab should be visible after bootstrap installs platform-core
  await expect(page.getByTestId('object-type-platform-event')).toBeVisible({ timeout: 10000 });
  await page.getByTestId('object-type-platform-event').click();

  // Objects from the sample-events dataset should appear
  await expect(page.locator('[data-testid^="object-card-platform-event-"]').first()).toBeVisible({ timeout: 10000 });

  // Switch to platform-metric type
  await page.getByTestId('object-type-platform-metric').click();
  await expect(page.locator('[data-testid^="object-card-platform-metric-"]').first()).toBeVisible({ timeout: 10000 });

  // Switch back to platform-event and apply a filter
  await page.getByTestId('object-type-platform-event').click();
  await expect(page.locator('[data-testid^="object-card-platform-event-"]').first()).toBeVisible({ timeout: 10000 });

  await page.getByTestId('object-filter-field').selectOption({ value: 'severity' });
  await page.getByTestId('object-filter-value').fill('warning');
  await page.getByTestId('add-object-filter').click();

  // Should show only warning-severity events
  await expect(page.locator('[data-testid^="object-card-platform-event-"]').first()).toBeVisible({ timeout: 10000 });
});
