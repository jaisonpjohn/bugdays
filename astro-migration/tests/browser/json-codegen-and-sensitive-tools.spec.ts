import { test, expect, type Page } from '@playwright/test';
import LZString from 'lz-string';

test.beforeEach(async ({ page }) => {
  await page.route('https://**/*', route => route.abort());
  await page.addInitScript(() => {
    localStorage.setItem('cookie-notice-dismissed', 'true');
    localStorage.removeItem('bd-share-method');
    (window as any).__copied = '';
    (window as any).__errors = [];
    window.addEventListener('error', event => (window as any).__errors.push(event.message));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (value: string) => { (window as any).__copied = value; },
    } });
  });
});

test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => (window as any).__errors)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

async function share(page: Page) {
  await page.locator('#share-code-btn').click();
  await expect(page.locator('#share-modal')).toBeVisible();
  await page.locator('#share-url-btn').click();
  await expect.poll(() => page.evaluate(() => (window as any).__copied)).toContain('#lz:');
  return page.evaluate(() => (window as any).__copied as string);
}

test('JSON code generator infers nested types, missing fields, targets, files, downloads, and a share', async ({ page }) => {
  const source = JSON.stringify([
    { id: 1, 'display-name': 'Ada', profile: { timezone: 'UTC' } },
    { id: 2, profile: null, active: true },
  ]);
  await page.goto('/json-to-code/');
  await page.locator('#json-input').fill(source);
  await page.locator('#generate-btn').click();
  await expect(page.locator('#code-output')).toHaveValue(/export type Root = Array<RootItem>;/);
  await expect(page.locator('#code-output')).toHaveValue(/"display-name"\?: string;/);
  await expect(page.locator('#code-output')).toHaveValue(/active\?: boolean;/);
  await expect(page.locator('#code-output')).toHaveValue(/profile: RootItemProfile \| null;/);
  await page.locator('#target').selectOption('zod');
  await expect(page.locator('#code-output')).toHaveValue(/import \{ z \} from 'zod';/);
  await expect(page.locator('#code-output')).toHaveValue(/"active": z\.boolean\(\)\.optional\(\)/);
  await page.locator('#target').selectOption('pydantic');
  await expect(page.locator('#code-output')).toHaveValue(/from pydantic import BaseModel, Field/);
  await expect(page.locator('#code-output')).toHaveValue(/display_name: str \| None = Field\(default=None, alias="display-name"\)/);
  await expect(page.locator('#code-output')).toHaveValue(/active: bool \| None = None/);
  await page.locator('#json-file').setInputFiles({ name: 'private-api-response.json', mimeType: 'application/json', buffer: Buffer.from('{"id":7,"name":"Lin"}') });
  await expect(page.locator('#file-status')).toContainText('Nothing was uploaded');
  await expect(page.locator('#file-status')).not.toContainText('private-api-response');
  await expect(page.locator('#code-output')).toHaveValue(/name: str/);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#download-btn').click();
  expect((await downloadPromise).suggestedFilename()).toBe('Root.py');
  const url = await share(page);
  const state = JSON.parse(LZString.decompressFromEncodedURIComponent(url.split('#lz:')[1])!);
  expect(state).toMatchObject({ t: 'json-to-code', a: 'generate', d: { json: '{"id":7,"name":"Lin"}', target: 'pydantic', rootName: 'Root' } });
  await page.goto(url);
  await expect(page.locator('#code-output')).toHaveValue(/class Root\(BaseModel\):/);
});

test('JSON code generator exposes its page schema and practical guide', async ({ page, request }) => {
  await page.goto('/json-to-code/');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://bugdays.com/json-to-code/');
  const schemas = await page.locator('script[type="application/ld+json"]').evaluateAll(nodes => nodes.flatMap(node => JSON.parse(node.textContent!)));
  expect(schemas.find(schema => schema['@type'] === 'WebApplication').url).toBe('https://bugdays.com/json-to-code/');
  expect(schemas.find(schema => schema['@type'] === 'FAQPage').mainEntity).toHaveLength(4);
  await page.locator('a[href="/guides/json-to-typescript-zod-pydantic/"]').first().click();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://bugdays.com/guides/json-to-typescript-zod-pydantic/');
  await expect(page.locator('meta[property="og:type"]')).toHaveAttribute('content', 'article');
  expect(await page.locator('.guide-body h2').count()).toBeGreaterThanOrEqual(4);
  await page.goto('/json-tools/');
  await expect(page.locator('main a[href="/json-to-code/"]')).toBeVisible();
  const rss = await (await request.get('/guides/rss.xml')).text();
  expect(rss).toContain('/guides/json-to-typescript-zod-pydantic/');
});

test('DBeaver recovery excludes sharing and keeps local file names out of the page', async ({ page, request }) => {
  await page.goto('/dbeaver-password-decrypter/');
  await expect(page.locator('#share-btn, #share-btn-floating')).toHaveCount(0);
  await expect(page.locator('#encrypted')).not.toHaveAttribute('data-share-key');
  await page.locator('#file-input').setInputFiles({ name: 'production-database-credentials.json', mimeType: 'application/json', buffer: Buffer.from('not an encrypted DBeaver file') });
  await expect(page.locator('#file-name')).toContainText('contents stay in this browser');
  await expect(page.locator('#file-name')).not.toContainText('production-database');
  const schemas = await page.locator('script[type="application/ld+json"]').evaluateAll(nodes => nodes.flatMap(node => JSON.parse(node.textContent!)));
  expect(schemas.find(schema => schema['@type'] === 'WebApplication').url).toBe('https://bugdays.com/dbeaver-password-decrypter/');
  expect(schemas.find(schema => schema['@type'] === 'FAQPage').mainEntity).toHaveLength(4);
  await page.locator('a[href="/guides/recover-dbeaver-saved-password-credentials-config/"]').first().click();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://bugdays.com/guides/recover-dbeaver-saved-password-credentials-config/');
  const rss = await (await request.get('/guides/rss.xml')).text();
  expect(rss).toContain('/guides/recover-dbeaver-saved-password-credentials-config/');
});
