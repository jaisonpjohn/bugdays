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

async function share(page: Page, trigger: string) {
  await page.locator(trigger).click();
  await expect(page.locator('#share-modal')).toBeVisible();
  await page.locator('#share-url-btn').click();
  await expect.poll(() => page.evaluate(() => (window as any).__copied)).toContain('#lz:');
  return page.evaluate(() => (window as any).__copied as string);
}

test('Base64 safely handles UTF-8, Base64URL, local bytes, downloads, and shares', async ({ page }) => {
  await page.goto('/base64-encoder-decoder/');
  await page.locator('#input').fill('Hello, café ☕');
  await page.locator('#encode-btn').click();
  await expect(page.locator('#output')).toHaveValue('SGVsbG8sIGNhZsOpIOKYlQ==');
  await expect(page.locator('#output-status')).toContainText('UTF-8 bytes');
  await page.locator('#input').fill('SGVsbG8sIGNhZsOpIOKYlQ==');
  await page.locator('#decode-btn').click();
  await expect(page.locator('#output')).toHaveValue('Hello, café ☕');
  await page.locator('#input').fill('eyJzdWIiOiIxMjMifQ');
  await page.locator('#base64url-btn').click();
  await expect(page.locator('#output')).toHaveValue('eyJzdWIiOiIxMjMifQ==');
  await page.locator('#file-input').setInputFiles({ name: 'do-not-leak.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 255, 65]) });
  await expect(page.locator('#output')).toHaveValue('AP9B');
  await expect(page.locator('#input-status')).toContainText('Nothing was uploaded');
  await expect(page.locator('#input-status')).not.toContainText('do-not-leak');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#download-btn').click();
  expect((await downloadPromise).suggestedFilename()).toBe('base64-output.txt');
  const url = await share(page, '#share-base64-btn');
  const state = JSON.parse(LZString.decompressFromEncodedURIComponent(url.split('#lz:')[1])!);
  expect(state).toMatchObject({ t: 'base64', a: 'base64url' });
  await page.goto(url);
  await expect(page.locator('#output')).toHaveValue('AP9B');
});

test('Cron tests five-field schedules locally, accepts Sunday 7, and restores a shared schedule', async ({ page }) => {
  await page.goto('/cron-parser/');
  const sources = await page.locator('script[src]').evaluateAll(nodes => nodes.map(node => (node as HTMLScriptElement).src));
  expect(sources.some(src => src.includes('cdnjs.cloudflare.com'))).toBeFalsy();
  await page.locator('#cron-input').fill('*/15 * * * *');
  await page.locator('#parse-btn').click();
  await expect(page.locator('#human-output')).toContainText('Every 15 minutes');
  await expect(page.locator('#next-runs > div')).toHaveCount(5);
  await page.locator('#copy-cron-btn').click();
  expect(await page.evaluate(() => (window as any).__copied)).toBe('*/15 * * * *');
  await page.locator('#cron-input').fill('0 9 * * 7');
  await page.locator('#parse-btn').click();
  await expect(page.locator('#error-box')).toBeHidden();
  await expect(page.locator('#field-dow')).toHaveText('7');
  const url = await share(page, '#share-cron-btn');
  const state = JSON.parse(LZString.decompressFromEncodedURIComponent(url.split('#lz:')[1])!);
  expect(state).toMatchObject({ t: 'cron-parser', a: 'parse', d: { cron: '0 9 * * 7' } });
  await page.goto(url);
  await expect(page.locator('#cron-input')).toHaveValue('0 9 * * 7');
  await expect(page.locator('#next-runs > div')).toHaveCount(5);
  await page.locator('#cron-input').fill('*/0 * * * *');
  await page.locator('#parse-btn').click();
  await expect(page.locator('#error-box')).toContainText('Invalid step');
  await expect(page.locator('#results')).toBeHidden();
});

test('Base64 and cron pages expose matching metadata, guides, RSS entries, and visible FAQs', async ({ page, request }) => {
  const checks = [
    { tool: 'base64-encoder-decoder', guide: 'base64-utf8-base64url-file-decoder', faqCount: 5 },
    { tool: 'cron-parser', guide: 'cron-expression-next-run-timezone', faqCount: 4 },
  ];
  for (const check of checks) {
    await page.goto(`/${check.tool}/`);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `https://bugdays.com/${check.tool}/`);
    await expect(page.locator('meta[name="description"]')).not.toHaveAttribute('content', '');
    await expect(page.locator('meta[property="og:description"]')).toHaveAttribute('content', await page.locator('meta[name="description"]').getAttribute('content') as string);
    const schemas = await page.locator('script[type="application/ld+json"]').evaluateAll(nodes => nodes.flatMap(node => JSON.parse(node.textContent!)));
    expect(schemas.find(schema => schema['@type'] === 'WebApplication').url).toBe(`https://bugdays.com/${check.tool}/`);
    const faq = schemas.find(schema => schema['@type'] === 'FAQPage');
    expect(faq.mainEntity).toHaveLength(check.faqCount);
    await page.locator(`a[href="/guides/${check.guide}/"]`).first().click();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `https://bugdays.com/guides/${check.guide}/`);
    await expect(page.locator('meta[property="og:type"]')).toHaveAttribute('content', 'article');
    expect(await page.locator('.guide-body h2').count()).toBeGreaterThanOrEqual(4);
  }
  await page.goto('/guides/');
  for (const check of checks) await expect(page.locator(`a[href="/guides/${check.guide}/"]`).first()).toBeVisible();
  const rss = await (await request.get('/guides/rss.xml')).text();
  for (const check of checks) expect(rss).toContain(`/guides/${check.guide}/`);
});
