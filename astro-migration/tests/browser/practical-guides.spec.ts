import { test, expect } from '@playwright/test';

const slugs = ['gzip-base64-java', 'base64-utf8-base64url-file-decoder', 'reset-kafka-consumer-group-offsets', 'diagnose-kafka-consumer-lag-stuck-partition', 'check-tls-certificate-chain-any-port', 'identify-cloud-hosting-ips-in-access-logs'];
test.beforeEach(async ({ page }) => {
  await page.route('https://**/*', route => route.abort());
  await page.addInitScript(() => localStorage.setItem('cookie-notice-dismissed', 'true'));
});

test('six practical guides have crawlable metadata, relevant artwork, and responsive layouts', async ({ page }, testInfo) => {
  for (const slug of slugs) {
    await page.goto(`/guides/${slug}/`);
    await expect(page.locator('.guide-article h1')).toHaveCount(1);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `https://bugdays.com/guides/${slug}/`);
    await expect(page.locator('meta[property="og:type"]')).toHaveAttribute('content', 'article');
    await expect(page.locator('.guide-article figure img')).toHaveJSProperty('naturalWidth', 1280);
    await expect(page.locator('.guide-article figure img')).not.toHaveAttribute('alt', '');
    expect(await page.locator('.guide-body h2').count()).toBeGreaterThanOrEqual(6);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    if (slug === 'gzip-base64-java' || slug === 'identify-cloud-hosting-ips-in-access-logs') {
      await page.screenshot({ path: testInfo.outputPath(`${slug}.png`) });
    }
    await page.locator('.guide-body h2').last().scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  }
});

test('published Java and Base64 examples restore the correct operation and result', async ({ page }) => {
  await page.goto('/guides/gzip-base64-java/');
  await page.locator('[data-example-decode]').click();
  await expect(page.locator('#output')).toHaveValue('{"message":"Hello, café ☕","city":"Montréal"}');
  await page.goto('/guides/base64-utf8-base64url-file-decoder/');
  await page.locator('[data-guide-example="base64"]').click();
  await expect(page.locator('#output')).toHaveValue('Hello, café ☕');
  await page.goto('/guides/base64-utf8-base64url-file-decoder/');
  await page.locator('[data-guide-example="base64url"]').click();
  await expect(page.locator('#output')).toHaveValue('+/8=');
});

test('Kafka article share restores without a running bridge or any Kafka operations', async ({ page }) => {
  const bridgeCalls: string[] = [];
  await page.route('http://127.0.0.1:2345/**', async route => { bridgeCalls.push(route.request().url()); await route.abort(); });
  await page.goto('/guides/diagnose-kafka-consumer-lag-stuck-partition/');
  await page.locator('[data-guide-example="kafka"]').click();
  await expect(page.locator('#k-summary')).toContainText('4 partitions · 3 members');
  await expect(page.locator('#k-lag-rows tr')).toHaveCount(4);
  await expect(page.locator('#k-lag-rows tr').nth(2)).toContainText('79');
  await expect(page.locator('#k-findings')).toContainText('Unexpected group member');
  await expect(page.locator('#k-findings')).toContainText('Commit stopped while data arrived');
  await expect(page.locator('#k-brokers')).toHaveValue('');
  // The page can probe capabilities; the failed probe must not prevent reading
  // a snapshot, and opening the link must never connect to or operate on Kafka.
  expect(bridgeCalls.filter(url => new URL(url).pathname !== '/api/v1/capabilities')).toEqual([]);
});

test('access-log article opens a complete snapshot and exports the expected counts', async ({ page }) => {
  const lookupCalls: string[] = [];
  await page.route('**/api/ip-**', async route => { lookupCalls.push(route.request().url()); await route.abort(); });
  await page.goto('/guides/identify-cloud-hosting-ips-in-access-logs/');
  await page.locator('[data-guide-example="logs"]').click();
  await expect(page.locator('#traffic-report')).toBeVisible();
  await expect(page.locator('#traffic-input-size')).toContainText('Shared report');
  await expect(page.locator('#traffic-ip-rows tr')).toHaveCount(3);
  await expect(page.locator('#traffic-ip-rows')).toContainText('198.51.100.20');
  const download = page.waitForEvent('download');
  await page.locator('#traffic-json').click();
  const result = await download;
  expect(result.suggestedFilename()).toMatch(/\.json$/);
  const stream = await result.createReadStream();
  const chunks = [];
  for await (const chunk of stream!) chunks.push(chunk);
  const report = JSON.parse(Buffer.concat(chunks).toString());
  expect(report.summary).toMatchObject({ accepted: 6, uniqueIps: 3, errors: 3 });
  expect(lookupCalls).toEqual([]);
});
