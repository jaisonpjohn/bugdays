import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import LZString from 'lz-string';
import { fixtureDataset, fixtureLog } from '../traffic-fixtures.mjs';
import { analyzeTraffic } from '../../src/lib/traffic-analysis';

test.beforeEach(async ({ page }) => {
  await page.route('https://**/*', route => route.abort());
  await page.route('**/data/ip-ranges.json', route => route.fulfill({ json: fixtureDataset }));
  await page.route('**/api/ip-ranges', route => route.fulfill({ json: fixtureDataset }));
  await page.addInitScript(() => {
    localStorage.setItem('cookie-notice-dismissed', 'true');
    localStorage.removeItem('bd-share-method');
    (window as any).__copied = '';
    (window as any).__errors = [];
    window.addEventListener('error', event => (window as any).__errors.push(event.message));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (value: string) => { (window as any).__copied = value; },
      write: async (items: ClipboardItem[]) => { (window as any).__copied = await (await items[0].getType('text/plain')).text(); (window as any).__copiedHtml = await (await items[0].getType('text/html')).text(); },
    } });
  });
});

test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => (window as any).__errors || [])).toEqual([]);
});

async function shareUrl(page: import('@playwright/test').Page) {
  await expect(page.locator('#share-modal')).toBeVisible();
  await page.locator('#share-url-btn').click();
  await expect.poll(() => page.evaluate(() => (window as any).__copied)).toContain('#lz:');
  return page.evaluate(() => (window as any).__copied as string);
}

test('auto-analysis, filters, IPv6 details and keyboard dialog dismissal', async ({ page }) => {
  await page.goto('/ip-lookup/');
  await page.locator('#traffic-input').fill('3.5.140.1\n3.5.140.1\n34.80.0.1\n2606:4700::1111\n10.0.0.24\n8.8.8.8');
  await expect(page.locator('#traffic-report')).toBeVisible();
  await expect(page.locator('#traffic-ip-rows tr')).toHaveCount(5);
  await expect(page.locator('#traffic-summary')).toContainText('6');
  await page.locator('#traffic-source').selectOption('aws');
  await expect(page.locator('#traffic-ip-rows tr')).toHaveCount(1);
  await expect(page.locator('#traffic-ip-rows')).toContainText('ap-northeast-2');
  await page.locator('#traffic-reset-filters').click();
  await page.getByRole('button', { name: '2606:4700::1111', exact: true }).click();
  await expect(page.locator('#traffic-detail')).toBeVisible();
  await expect(page.locator('#traffic-detail-body')).toContainText('2606:4700::/32');
  await page.keyboard.press('Escape');
  await expect(page.locator('#traffic-detail')).not.toBeVisible();
  await page.locator('#traffic-search').fill('no-such-region');
  await expect(page.locator('#traffic-ip-rows')).toContainText('No addresses match');
  await expect(page.locator('#traffic-share')).toBeDisabled();
});

test('IP report shares its title and filtered snapshot without making per-IP requests', async ({ page }) => {
  const outbound: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/') || request.method() === 'POST') outbound.push(request.url()); });
  await page.goto('/ip-lookup/');
  await page.locator('#traffic-demo').click();
  await expect(page.locator('#traffic-report')).toBeVisible();
  await page.locator('#traffic-title').fill('Unexpected cloud traffic');
  await page.locator('#traffic-source').selectOption('aws');
  await page.locator('#traffic-share').click();
  const url = await shareUrl(page);
  const state = JSON.parse(LZString.decompressFromEncodedURIComponent(url.split('#lz:')[1])!);
  expect(state.d.report.ips).toHaveLength(1);
  expect(state.d.report.dataset.fetchedAt).toBe(fixtureDataset.fetchedAt);
  expect(state.d).not.toHaveProperty('input');
  expect(outbound.every(url => url.endsWith('/api/ip-ranges'))).toBeTruthy();
  await page.goto(url);
  await expect(page.locator('#traffic-title')).toHaveValue('Unexpected cloud traffic');
  await expect(page.locator('#traffic-source')).toHaveValue('aws');
  await expect(page.locator('#traffic-ip-rows tr')).toHaveCount(1);
  await expect(page.locator('#traffic-notice')).toContainText('Shared report snapshot');
  await expect(page.locator('#traffic-input')).toHaveValue('');
});

test('access-log report has correct counts, excludes secrets from sharing, and reopens', async ({ page }) => {
  await page.goto('/access-log-analyzer/');
  await page.locator('#traffic-input').fill(fixtureLog);
  await expect(page.locator('#traffic-report')).toBeVisible();
  await expect(page.locator('#traffic-notice')).toContainText('1 of 7');
  await expect(page.locator('#traffic-latency')).toContainText('median 25.0 ms · p95 125.0 ms');
  await expect(page.locator('#traffic-paths')).toContainText('/api/orders');
  await expect(page.locator('#traffic-timeline .traffic-time-bar')).toHaveCount(5);
  await page.locator('#traffic-share').click();
  const url = await shareUrl(page);
  const json = LZString.decompressFromEncodedURIComponent(url.split('#lz:')[1])!;
  for (const secret of ['DO_NOT_SHARE', 'PRIVATE_USER_AGENT', 'private.example', 'NEVER_SHARE']) expect(json).not.toContain(secret);
  await page.goto(url);
  await expect(page.locator('#traffic-report')).toBeVisible();
  await expect(page.locator('#traffic-ip-rows tr')).toHaveCount(5);
  await expect(page.locator('#traffic-input')).toHaveValue('');
  await expect(page.locator('#traffic-latency')).toContainText('p95 125.0 ms');
  await page.reload();
  await page.goto(url);
  await expect(page.locator('#traffic-ip-rows tr')).toHaveCount(5);
});

test('sharing an individual IP includes no other addresses or unrelated paths', async ({ page }) => {
  await page.goto('/access-log-analyzer/');
  await page.locator('#traffic-input').fill(fixtureLog);
  await expect(page.locator('#traffic-report')).toBeVisible();
  await page.getByRole('button', { name: '3.5.140.1', exact: true }).click();
  await page.locator('#traffic-share-ip').click();
  const url = await shareUrl(page);
  const shared = JSON.parse(LZString.decompressFromEncodedURIComponent(url.split('#lz:')[1])!).d.report;
  expect(shared.ips).toHaveLength(1);
  expect(shared.summary.uniqueIps).toBe(1);
  expect(shared.summary.accepted).toBe(2);
  expect(shared.paths).toEqual([]);
  await page.goto(url);
  await expect(page.locator('#traffic-ip-rows tr')).toHaveCount(1);
});

test('short-link storage and restoration use the existing explicit share choice', async ({ page }) => {
  let stored = '';
  await page.route('https://api.bugdays.com/store', async route => {
    stored = route.request().postDataJSON().data;
    await route.fulfill({ json: { id: 'test-report' } });
  });
  await page.route('https://api.bugdays.com/get/test-report', route => route.fulfill({ json: { data: stored } }));
  await page.goto('/ip-lookup/');
  await page.locator('#traffic-demo').click();
  await expect(page.locator('#traffic-report')).toBeVisible();
  expect(stored).toBe('');
  await page.locator('#traffic-share').click();
  await page.locator('#share-server-btn').click();
  await expect.poll(() => page.evaluate(() => (window as any).__copied)).toContain('#kv:test-report');
  const url = await page.evaluate(() => (window as any).__copied);
  expect(JSON.parse(stored).d.report.ips.length).toBeGreaterThan(0);
  await page.goto(url);
  await expect(page.locator('#traffic-report')).toBeVisible();
});

test('CSV, Excel, clipboard, and full JSON export produce usable report data', async ({ page }) => {
  await page.goto('/ip-lookup/');
  await page.locator('#traffic-demo').click();
  await expect(page.locator('#traffic-report')).toBeVisible();
  await page.locator('#traffic-title').fill('My report');
  const csvPromise = page.waitForEvent('download'); await page.locator('#traffic-csv').click();
  const csv = await csvPromise;
  expect(csv.suggestedFilename()).toBe('my-report.csv');
  expect(await readFile((await csv.path())!, 'utf8')).toContain('3.5.140.1');
  const xlsxPromise = page.waitForEvent('download'); await page.locator('#traffic-xlsx').click();
  const xlsx = await xlsxPromise;
  expect((await readFile((await xlsx.path())!)).subarray(0, 2).toString()).toBe('PK');
  await page.locator('#traffic-copy').click();
  await expect.poll(() => page.evaluate(() => (window as any).__copied)).toContain('IP address\tIP version');
  expect(await page.evaluate(() => (window as any).__copiedHtml)).toContain('<table>');
  const jsonPromise = page.waitForEvent('download'); await page.locator('#traffic-json').click();
  const json = await jsonPromise;
  const content = await readFile((await json.path())!, 'utf8');
  expect(JSON.parse(content).title).toBe('My report');
  await page.locator('#traffic-clear').click();
  await page.locator('#traffic-file').setInputFiles({ name: 'report.json', mimeType: 'application/json', buffer: Buffer.from(content) });
  await expect(page.locator('#traffic-report')).toBeVisible();
  await expect(page.locator('#traffic-title')).toHaveValue('My report');
});

test('pagination, full filtered exports and explicit shared coverage for large lists', async ({ page }) => {
  await page.goto('/ip-lookup/');
  await page.locator('#traffic-input').fill(Array.from({ length: 250 }, (_, i) => `3.5.140.${i}`).join('\n'));
  await expect(page.locator('#traffic-report')).toBeVisible();
  await expect(page.locator('#traffic-ip-rows tr')).toHaveCount(50);
  await page.locator('#traffic-next').click();
  await expect(page.locator('#traffic-page-label')).toHaveText('51–100 of 250');
  await page.locator('#traffic-share').click();
  const url = await shareUrl(page);
  const state = JSON.parse(LZString.decompressFromEncodedURIComponent(url.split('#lz:')[1])!);
  expect(state.d.report.ips).toHaveLength(200);
  expect(state.d.report.shared.scope).toContain('200 of 250');
  await page.evaluate(() => { window.print = () => { (window as any).__printedRows = document.querySelectorAll('#traffic-ip-rows tr').length; }; });
  await page.locator('#traffic-print').click();
  expect(await page.evaluate(() => (window as any).__printedRows)).toBe(250);
  await expect(page.locator('#traffic-ip-rows tr')).toHaveCount(50);
});

test('gzip input, malformed input and failed live feeds have clear outcomes', async ({ page }) => {
  await page.route('**/api/ip-ranges', route => route.fulfill({ status: 503, body: 'unavailable' }));
  await page.goto('/access-log-analyzer/');
  await page.locator('#traffic-file').setInputFiles({ name: 'access.log.gz', mimeType: 'application/gzip', buffer: gzipSync(fixtureLog) });
  await expect(page.locator('#traffic-report')).toBeVisible();
  await expect(page.locator('#traffic-data-status')).toContainText('bundled snapshot');
  await page.locator('#traffic-input').fill('malformed log');
  await expect(page.locator('#traffic-error')).toContainText('No supported log entries');
  await expect(page.locator('#traffic-report')).not.toBeVisible();
  await page.locator('#traffic-demo').click();
  await expect(page.locator('#traffic-report')).toBeVisible();
});

test('shared strings render as text and malformed reports show an error', async ({ page }) => {
  const report = await analyzeTraffic('3.5.140.1', 'ip', fixtureDataset);
  report.ips[0].matches[0].service = '<img src=x onerror=alert(1)>';
  const link = '/ip-lookup/#lz:' + LZString.compressToEncodedURIComponent(JSON.stringify({ v: 1, t: 'ip-lookup', d: { report, title: '<script>alert(1)</script>' } }));
  await page.goto(link);
  await expect(page.locator('#traffic-report')).toBeVisible();
  await page.getByRole('button', { name: '3.5.140.1', exact: true }).click();
  await expect(page.locator('#traffic-detail-body')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('#traffic-detail-body img')).toHaveCount(0);
  await page.goto('/ip-lookup/#lz:' + LZString.compressToEncodedURIComponent(JSON.stringify({ v: 1, t: 'ip-lookup', d: { report: { v: 99 } } })));
  await expect(page.locator('#traffic-error')).toContainText('not a valid');
  await expect(page.locator('#traffic-report')).not.toBeVisible();
});

test('light/dark layouts fit the viewport and both pages have discoverable metadata', async ({ page }, testInfo) => {
  for (const path of ['/ip-lookup/', '/access-log-analyzer/']) {
    await page.goto(path);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `https://bugdays.com${path}`);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /IP|logs/);
    await page.locator('#traffic-demo').click();
    await expect(page.locator('#traffic-report')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    expect(await page.locator('.traffic-card, #traffic-share').evaluateAll(elements => elements.filter(el => el.getBoundingClientRect().width).every(el => {
      const rect = el.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth;
    }))).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath(`${path.includes('ip-lookup') ? 'ip' : 'log'}-light.png`), fullPage: true });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.screenshot({ path: testInfo.outputPath(`${path.includes('ip-lookup') ? 'ip' : 'log'}-dark.png`), fullPage: true });
  }
});

test('Magic Box routes an IP or access log directly into its working analyzer', async ({ page }) => {
  await page.goto('/');
  const magic = page.locator('textarea').first();
  await magic.fill('3.5.140.1');
  await page.getByRole('link', { name: /Look up cloud providers/ }).click();
  await expect(page.locator('#traffic-report')).toBeVisible();
  await expect(page.locator('#traffic-ip-rows')).toContainText('3.5.140.1');
  await page.goto('/');
  await page.locator('textarea').first().fill(fixtureLog);
  await page.getByRole('link', { name: /Analyze traffic and client IPs/ }).click();
  await expect(page.locator('#traffic-report')).toBeVisible();
});
