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

test('cURL converter parses common request fields locally, generates each target, downloads, and restores a share', async ({ page }) => {
  const source = [
    "curl -XPOST 'https://api.example.test/orders' \\",
    "  -H'Content-Type: application/json' \\",
    "  -H 'Authorization: Bearer placeholder-token' \\",
    "  --data-raw '{\"status\":\"paid\"}'",
  ].join('\n');
  await page.goto('/curl-to-code/');
  await page.locator('#curl-input').fill(source);
  await page.locator('#convert-btn').click();
  await expect(page.locator('#code-output')).toHaveValue(/fetch\(/);
  await expect(page.locator('#code-output')).toHaveValue(/method: "POST"/);
  await expect(page.locator('#code-output')).toHaveValue(/Authorization/);
  await expect(page.locator('#code-output')).toHaveValue(/status.*paid/);
  await expect(page.locator('#request-summary')).toContainText('not executed');

  await page.locator('#target').selectOption('python');
  await expect(page.locator('#code-output')).toHaveValue(/import requests/);
  await expect(page.locator('#code-output')).toHaveValue(/requests\.request/);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#download-btn').click();
  expect((await downloadPromise).suggestedFilename()).toBe('converted-request.py');

  await page.locator('#target').selectOption('curl');
  await expect(page.locator('#code-output')).toHaveValue(/curl -X POST/);
  await expect(page.locator('#code-output')).toHaveValue(/--data-raw/);
  await page.locator('#target').selectOption('fetch');

  await page.locator('#share-curl-btn').click();
  await expect(page.locator('#share-modal')).toBeVisible();
  await page.locator('#share-url-btn').click();
  await expect.poll(() => page.evaluate(() => (window as any).__copied)).toContain('#lz:');
  const url = await page.evaluate(() => (window as any).__copied as string);
  const state = JSON.parse(LZString.decompressFromEncodedURIComponent(url.split('#lz:')[1])!);
  expect(state).toMatchObject({ t: 'curl-to-code', a: 'convert', d: { curl: source, target: 'fetch' } });
  await page.goto(url);
  await expect(page.locator('#code-output')).toHaveValue(/fetch\(/);
});

test('cURL converter supports basic auth without duplicate generated headers and makes malformed commands actionable', async ({ page }) => {
  await page.goto('/curl-to-code/');
  await page.locator('#curl-input').fill("curl -u demo:placeholder-secret -H 'Accept: application/json' https://api.example.test/me");
  await page.locator('#convert-btn').click();
  const generated = await page.locator('#code-output').inputValue();
  expect(generated).toContain('headers.Authorization');
  expect(generated).toContain('headers: headers');
  expect((generated.match(/headers:/g) || []).length).toBe(1);
  await page.locator('#curl-input').fill("curl -H 'Accept: application/json https://api.example.test");
  await page.locator('#convert-btn').click();
  await expect(page.locator('#error-box')).toContainText('Unclosed quote');
});

test('cURL converter has metadata, a guide, category discovery, RSS, and Magic Box handoff', async ({ page, request }) => {
  await page.goto('/curl-to-code/');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://bugdays.com/curl-to-code/');
  const schemas = await page.locator('script[type="application/ld+json"]').evaluateAll(nodes => nodes.flatMap(node => JSON.parse(node.textContent!)));
  expect(schemas.find(schema => schema['@type'] === 'WebApplication').url).toBe('https://bugdays.com/curl-to-code/');
  expect(schemas.find(schema => schema['@type'] === 'FAQPage').mainEntity).toHaveLength(4);
  await page.locator('a[href="/guides/convert-curl-to-javascript-fetch-python-requests/"]').first().click();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://bugdays.com/guides/convert-curl-to-javascript-fetch-python-requests/');
  expect(await page.locator('.guide-body h2').count()).toBeGreaterThanOrEqual(4);
  await page.goto('/network-tools/');
  await expect(page.locator('main a[href="/curl-to-code/"]')).toBeVisible();
  const rss = await (await request.get('/guides/rss.xml')).text();
  expect(rss).toContain('/guides/convert-curl-to-javascript-fetch-python-requests/');
  await page.goto('/');
  await page.locator('#magic-input').fill('curl https://api.example.test/health -H "Accept: application/json"');
  await expect(page.locator('#magic-results')).toContainText('cURL command');
  await page.locator('#magic-results a').filter({ hasText: 'Convert to JavaScript or Python' }).click();
  await expect(page).toHaveURL(/\/curl-to-code\/#lz:/);
  await expect(page.locator('#code-output')).toHaveValue(/fetch\(/);
});
