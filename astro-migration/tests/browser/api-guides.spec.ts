import { test, expect } from '@playwright/test';

const guides = [
  { slug: 'test-grpc-api-proto-metadata-streaming', title: 'How to Test a gRPC API: Proto Files, Metadata, and Streaming', tool: '/grpc-client' },
  { slug: 'grpc-web-vs-native-grpc-browser-testing', title: 'gRPC-Web vs Native gRPC: How Browser Testing Actually Works', tool: '/grpc-client' },
  { slug: 'soap-api-authentication-basic-ws-security-mtls', title: 'SOAP API Authentication: Basic Auth, WS-Security, and mTLS', tool: '/soap-client' },
];

test.beforeEach(async ({ page }) => {
  await page.route('https://**/*', route => route.abort());
  await page.addInitScript(() => {
    localStorage.setItem('cookie-notice-dismissed', 'true');
    (window as any).__errors = [];
    window.addEventListener('error', event => (window as any).__errors.push(event.message));
  });
});

test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => (window as any).__errors || [])).toEqual([]);
});

test('API guides render substantial, crawlable articles without mobile overflow', async ({ page }) => {
  for (const guide of guides) {
    await page.goto(`/guides/${guide.slug}/`);
    await expect(page.locator('.guide-article > header h1')).toHaveText(guide.title);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `https://bugdays.com/guides/${guide.slug}/`);
    await expect(page.locator('meta[property="og:type"]')).toHaveAttribute('content', 'article');
    expect(await page.locator('.guide-body h2').count()).toBeGreaterThanOrEqual(5);
    expect((await page.locator('.guide-body').innerText()).split(/\s+/).length).toBeGreaterThan(700);
    await expect(page.locator(`.guide-article > aside a[href="${guide.tool}"]`)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  }
});

test('gRPC examples and SOAP capability boundaries survive rendering', async ({ page }) => {
  await page.goto('/guides/test-grpc-api-proto-metadata-streaming/');
  await expect(page.locator('.guide-body pre').first()).toContainText('service Catalog {');
  await expect(page.locator('.guide-body pre').nth(1)).toContainText(`-d '{"id":"SKU-42"}'`);
  await expect(page.locator('img[src="/og/grpc-client.png"]')).toHaveJSProperty('naturalWidth', 1280);
  await page.goto('/guides/soap-api-authentication-basic-ws-security-mtls/');
  await expect(page.locator('.guide-note')).toContainText('does not generate WS-Security signatures');
  await expect(page.locator('.guide-body')).toContainText('mTLS happens during the TLS handshake');
});

test('guide discovery and RSS surface the complete API testing cluster', async ({ page, request }) => {
  await page.goto('/guides/');
  for (const guide of guides) await expect(page.locator(`a[href="/guides/${guide.slug}"]`).first()).toBeVisible();
  const rss = await (await request.get('/guides/rss.xml')).text();
  for (const guide of guides) {
    expect(rss).toContain(`/guides/${guide.slug}/`);
  }
});
