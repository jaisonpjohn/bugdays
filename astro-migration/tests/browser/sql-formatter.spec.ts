import { test, expect } from '@playwright/test';
import LZString from 'lz-string';

test.beforeEach(async ({ page }) => {
  await page.route('https://**/*', route => route.abort());
  await page.addInitScript(() => {
    localStorage.setItem('cookie-notice-dismissed', 'true');
    localStorage.removeItem('bd-share-method');
    (window as any).__copied = '';
    (window as any).__errors = [];
    window.addEventListener('error', event => (window as any).__errors.push(event.message));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { (window as any).__copied = value; } } });
  });
});

test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => (window as any).__errors)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('SQL formatter formats locally, controls dialect options, downloads, and restores a share', async ({ page }) => {
  const source = "select customer_id,count(*) as paid_orders from orders where status = 'paid' group by customer_id order by paid_orders desc;";
  await page.goto('/sql-formatter/');
  await page.locator('#sql-input').fill(source);
  await page.locator('#format-btn').click();
  await expect.poll(() => page.locator('#sql-output').inputValue()).toContain('SELECT');
  await expect(page.locator('#sql-output')).toHaveValue(/GROUP BY/);
  await page.locator('#dialect').selectOption('postgresql');
  await expect.poll(() => page.locator('#sql-output').inputValue()).toContain('ORDER BY');
  await page.locator('#keyword-case').selectOption('lower');
  await expect.poll(() => page.locator('#sql-output').inputValue()).toContain('select');
  await page.locator('#sql-file').setInputFiles({ name: 'private-migration.sql', mimeType: 'application/sql', buffer: Buffer.from('select 1 as id;') });
  await expect(page.locator('#file-status')).toContainText('Nothing was uploaded');
  await expect(page.locator('#file-status')).not.toContainText('private-migration');
  await expect.poll(() => page.locator('#sql-output').inputValue()).toContain('select');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#download-btn').click();
  expect((await downloadPromise).suggestedFilename()).toBe('formatted.sql');
  await page.locator('#share-sql-btn').click();
  await expect(page.locator('#share-modal')).toBeVisible();
  await page.locator('#share-url-btn').click();
  await expect.poll(() => page.evaluate(() => (window as any).__copied)).toContain('#lz:');
  const url = await page.evaluate(() => (window as any).__copied as string);
  const state = JSON.parse(LZString.decompressFromEncodedURIComponent(url.split('#lz:')[1])!);
  expect(state).toMatchObject({ t: 'sql-formatter', a: 'format', d: { sql: 'select 1 as id;', dialect: 'postgresql', keywordCase: 'lower' } });
  await page.goto(url);
  await expect.poll(() => page.locator('#sql-output').inputValue()).toContain('select');
});

test('SQL formatter has structured metadata, guide, database category, and RSS discovery', async ({ page, request }) => {
  await page.goto('/sql-formatter/');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://bugdays.com/sql-formatter/');
  const schemas = await page.locator('script[type="application/ld+json"]').evaluateAll(nodes => nodes.flatMap(node => JSON.parse(node.textContent!)));
  expect(schemas.find(schema => schema['@type'] === 'WebApplication').url).toBe('https://bugdays.com/sql-formatter/');
  expect(schemas.find(schema => schema['@type'] === 'FAQPage').mainEntity).toHaveLength(4);
  await page.locator('a[href="/guides/format-sql-query-postgres-mysql-sql-server/"]').first().click();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://bugdays.com/guides/format-sql-query-postgres-mysql-sql-server/');
  expect(await page.locator('.guide-body h2').count()).toBeGreaterThanOrEqual(4);
  await page.goto('/database-tools/');
  await expect(page.locator('main a[href="/sql-formatter/"]')).toBeVisible();
  const rss = await (await request.get('/guides/rss.xml')).text();
  expect(rss).toContain('/guides/format-sql-query-postgres-mysql-sql-server/');
});
