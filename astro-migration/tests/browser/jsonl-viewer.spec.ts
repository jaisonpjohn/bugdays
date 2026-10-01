import { test, expect } from '@playwright/test';
import LZString from 'lz-string';
import { readFile } from 'node:fs/promises';

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

test('JSONL viewer isolates bad lines, filters and inspects safe previews, exports valid JSON, and shares', async ({ page }) => {
  const source = '{"event":"started","id":1,"message":"<img src=x>"}\n{"event":"broken",}\n{"event":"finished","id":1,"durationMs":142}';
  await page.goto('/jsonl-viewer/');
  await page.locator('#jsonl-input').fill(source);
  await page.locator('#parse-btn').click();
  await expect(page.locator('#results')).toBeVisible();
  await expect(page.locator('#line-count')).toHaveText('3');
  await expect(page.locator('#valid-count')).toHaveText('2');
  await expect(page.locator('#invalid-count')).toHaveText('1');
  await expect(page.locator('#error-box')).toContainText('line 2');
  await expect(page.locator('#records-body tr')).toHaveCount(3);
  await expect(page.locator('#records-body img')).toHaveCount(0);
  await page.locator('#records-body tr').filter({ hasText: 'started' }).click();
  await expect(page.locator('#selected-record')).toContainText('<img src=x>');
  await page.locator('#filter-input').fill('finished');
  await expect(page.locator('#records-body tr')).toHaveCount(1);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-btn').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('jsonl-valid-records.json');
  expect(JSON.parse(await readFile((await download.path())!, 'utf8'))).toEqual([
    { event: 'started', id: 1, message: '<img src=x>' },
    { event: 'finished', id: 1, durationMs: 142 },
  ]);
  await page.locator('#share-jsonl-btn').click();
  await expect(page.locator('#share-modal')).toBeVisible();
  await page.locator('#share-url-btn').click();
  await expect.poll(() => page.evaluate(() => (window as any).__copied)).toContain('#lz:');
  const url = await page.evaluate(() => (window as any).__copied as string);
  const state = JSON.parse(LZString.decompressFromEncodedURIComponent(url.split('#lz:')[1])!);
  expect(state).toMatchObject({ t: 'jsonl-viewer', a: 'parse', d: { jsonl: source, filter: 'finished' } });
  await page.goto(url);
  await expect(page.locator('#valid-count')).toHaveText('2');
  await expect(page.locator('#records-body tr')).toHaveCount(1);
});

test('JSONL viewer local file, metadata, guide, category, RSS, and Magic Box route work', async ({ page, request }) => {
  await page.goto('/jsonl-viewer/');
  await page.locator('#jsonl-file').setInputFiles({ name: 'private-logs.ndjson', mimeType: 'application/x-ndjson', buffer: Buffer.from('{"id":1}\n{"id":2}') });
  await expect(page.locator('#file-status')).toContainText('Nothing was uploaded');
  await expect(page.locator('#file-status')).not.toContainText('private-logs');
  await expect(page.locator('#valid-count')).toHaveText('2');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://bugdays.com/jsonl-viewer/');
  const schemas = await page.locator('script[type="application/ld+json"]').evaluateAll(nodes => nodes.flatMap(node => JSON.parse(node.textContent!)));
  expect(schemas.find(schema => schema['@type'] === 'WebApplication').url).toBe('https://bugdays.com/jsonl-viewer/');
  expect(schemas.find(schema => schema['@type'] === 'FAQPage').mainEntity).toHaveLength(4);
  await page.locator('a[href="/guides/jsonl-ndjson-viewer-validator/"]').first().click();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://bugdays.com/guides/jsonl-ndjson-viewer-validator/');
  expect(await page.locator('.guide-body h2').count()).toBeGreaterThanOrEqual(4);
  await page.goto('/json-tools/');
  await expect(page.locator('main a[href="/jsonl-viewer/"]')).toBeVisible();
  const rss = await (await request.get('/guides/rss.xml')).text();
  expect(rss).toContain('/guides/jsonl-ndjson-viewer-validator/');
  await page.goto('/');
  await page.locator('#magic-input').fill('{"id":1}\n{"id":2}');
  await expect(page.locator('#magic-results')).toContainText('JSON Lines / NDJSON');
  await page.locator('#magic-results a').filter({ hasText: 'Validate JSON Lines' }).click();
  await expect(page).toHaveURL(/\/jsonl-viewer\/#lz:/);
  await expect(page.locator('#valid-count')).toHaveText('2');
});
