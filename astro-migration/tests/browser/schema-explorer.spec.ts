import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('https://**/*', route => route.abort());
  await page.addInitScript(() => {
    localStorage.setItem('cookie-notice-dismissed', 'true');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { (window as any).__copied = text; },
      readText: async () => (window as any).__copied,
    } });
  });
});

test('sample schema can be explored, focused, annotated, exported and shared', async ({ page }) => {
  await page.goto('/schema-explorer/');
  await page.locator('#sample-btn').click();
  await expect(page.locator('#schema-stats')).toContainText('6 tables');
  await expect(page.locator('#erd-canvas > g:nth-child(2) > g[data-table]')).toHaveCount(6);
  await expect(page.locator('#diagram-card')).toBeVisible();
  await page.locator('#table-search').fill('products');
  await expect(page.locator('#table-results button')).toHaveCount(1);
  await page.locator('#table-results button').click();
  await expect(page.locator('#detail-title')).toHaveText('products');
  await expect(page.locator('#erd-canvas > g:nth-child(2) > g[data-table]')).not.toHaveCount(0);
  await page.locator('#annotation-input').fill('Catalog item');
  await page.locator('#export-btn').click();
  await expect(page.locator('#export-output')).toContainText('Catalog item');
  await page.locator('#export-close').click();
  await page.getByRole('button', { name: 'Share schema' }).click();
  await page.getByRole('button', { name: 'Link with data embedded' }).click();
  const url = await page.evaluate(() => navigator.clipboard.readText());
  expect(url).toContain('/schema-explorer/#lz:');
  await page.goto(url);
  await page.reload();
  await expect(page.locator('#schema-stats')).toContainText('6 tables');
  await page.locator('#export-btn').click();
  await expect(page.locator('#export-output')).toContainText('Catalog item');
});

test('large schemas start in a searchable list and draw a bounded neighborhood', async ({ page }) => {
  const ddl = Array.from({ length: 180 }, (_, index) =>
    `CREATE TABLE ${index < 90 ? 'public' : 'sales'}.table_${index} (id integer PRIMARY KEY${index ? `, previous_id integer REFERENCES ${index === 90 ? 'public' : index < 90 ? 'public' : 'sales'}.table_${index - 1}(id)` : ''});`
  ).join('\n');
  await page.goto('/schema-explorer/');
  await page.locator('#ddl-input').fill(ddl);
  await page.locator('#explore-btn').click();
  await expect(page.locator('#schema-stats')).toContainText('180 tables');
  await expect(page.locator('#diagram-card')).toBeHidden();
  await expect(page.locator('#table-results button')).toHaveCount(60);
  await page.locator('#table-search').fill('table_94');
  await expect(page.locator('#table-results button')).toHaveCount(1);
  await page.locator('#table-results button').click();
  await expect(page.locator('#diagram-card')).toBeVisible();
  await expect(page.locator('#erd-canvas > g:nth-child(2) > g[data-table]')).toHaveCount(3);
  await page.locator('#focus-hops').selectOption('2');
  await expect(page.locator('#erd-canvas > g:nth-child(2) > g[data-table]')).toHaveCount(5);
  await page.locator('#schema-filter').selectOption('sales');
  await expect(page.locator('#erd-canvas > g:nth-child(2) > g[data-table]')).toHaveCount(90);
  await expect(page.locator('#show-schema-btn')).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test('unsupported CREATE TABLE is explained rather than silently returning no tables', async ({ page }) => {
  await page.goto('/schema-explorer/');
  await page.locator('#ddl-input').fill('CREATE TABLE bad_table AS SELECT 1;');
  await page.locator('#explore-btn').click();
  await expect(page.locator('#error-text')).toContainText('bad_table');
  await expect(page.locator('#diagram-section')).toBeHidden();
});

test('catalog CSV imports and shares a useful ERD without including stale DDL', async ({ page }) => {
  await page.goto('/schema-explorer/');
  await page.locator('#metadata-details').evaluate((element: HTMLDetailsElement) => { element.open = true; });
  await page.locator('#ddl-input').fill('CREATE TABLE stale_secret (id int);');
  await page.locator('#metadata-columns').fill(`table_schema,table_name,column_name,data_type,ordinal_position,is_nullable,is_primary_key
public,customers,id,bigint,1,NO,YES
public,orders,id,bigint,1,NO,YES
public,orders,customer_id,bigint,2,NO,NO`);
  await page.locator('#metadata-foreign-keys').fill(`table_schema,table_name,column_name,constraint_name,ordinal_position,foreign_table_schema,foreign_table_name,foreign_column_name
public,orders,customer_id,orders_customer_fk,1,public,customers,id`);
  await page.locator('#import-metadata-btn').click();
  await expect(page.locator('#schema-stats')).toContainText('2 tables · 1 relationship');
  await page.locator('#table-search').fill('orders');
  await page.locator('#table-results button').click();
  await expect(page.locator('#detail-title')).toHaveText('orders');
  await expect(page.locator('#view-ddl-btn')).toBeHidden();
  await page.locator('#export-btn').click();
  await page.locator('[data-format="mermaid"]').click();
  await expect(page.locator('#export-output')).toContainText('customers ||--|{ orders');
  await page.locator('#export-close').click();
  await page.getByRole('button', { name: 'Share schema' }).click();
  await page.getByRole('button', { name: 'Link with data embedded' }).click();
  const url = await page.evaluate(() => navigator.clipboard.readText());
  await page.goto(url);
  await page.reload();
  await expect(page.locator('#schema-stats')).toContainText('2 tables · 1 relationship');
  await expect(page.locator('#ddl-input')).toHaveValue('');
});

test('metadata import errors are actionable and catalog queries can be copied', async ({ page }) => {
  await page.goto('/schema-explorer/');
  await page.locator('#metadata-details').evaluate((element: HTMLDetailsElement) => { element.open = true; });
  await page.locator('#metadata-engine').selectOption('sqlite');
  await page.locator('#metadata-query-kind').selectOption('foreignKeys');
  await expect(page.locator('#metadata-query')).toContainText('pragma_foreign_key_list');
  await page.locator('#copy-metadata-query').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('pragma_foreign_key_list');
  await page.locator('#metadata-columns').fill('table_name,column_name\nfoo,id');
  await page.locator('#import-metadata-btn').click();
  await expect(page.locator('#schema-stats')).toContainText('1 table');
  await page.locator('#ddl-toggle').click();
  await page.locator('#metadata-columns').fill('table_name,column_name\nfoo,id,extra');
  await page.locator('#import-metadata-btn').click();
  await expect(page.locator('#error-text')).toContainText('CSV row 2');
});
