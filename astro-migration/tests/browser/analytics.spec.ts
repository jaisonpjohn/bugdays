import { test, expect, type Page } from '@playwright/test';

// Reads GA4's real queue. Layout.astro defines its own gtag() that pushes into dataLayer, so
// inspecting dataLayer covers the true path from call site to Google, with the network blocked.
const stubGtag = async (page: Page) => {
  await page.addInitScript(() => {
    (window as any).dataLayer = (window as any).dataLayer || [];
    localStorage.setItem('cookie-notice-dismissed', 'true');
  });
};
const events = (page: Page) => page.evaluate(() =>
  Array.from((window as any).dataLayer || [])
    .map((entry: any) => Array.from(entry))
    .filter((args: any[]) => args[0] === 'event')
    .map((args: any[]) => ({ kind: args[0], event: args[1], params: args[2] })));
const typeJson = async (page: Page, value: string) => {
  await page.locator('#editor').click();
  await page.locator('#editor').evaluate((el, text) => {
    el.textContent = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
};

test.beforeEach(async ({ page, context }) => {
  await stubGtag(page);
  await context.route('https://pagead2.googlesyndication.com/**', (route) => route.abort());
  await context.route('https://www.googletagmanager.com/**', (route) => route.abort());
});

test('running a tool and sharing reports tool, method and size only', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/json-formatter/');
  await typeJson(page, '{"customer":"ACME Corp","token":"sk-live-should-never-be-sent"}');
  await page.locator('[data-share-action="prettify"]').first().click();

  expect(await events(page)).toContainEqual({ kind: 'event', event: 'tool_used', params: { tool: 'json-formatter', action: 'prettify' } });

  await page.locator('#share-btn').click();
  await page.locator('#share-url-btn').click();
  await expect.poll(async () => (await events(page)).some((e: any) => e.event === 'share_created')).toBeTruthy();
  const sent = await events(page);
  const share = sent.find((e: any) => e.event === 'share_created');
  expect(share?.params).toEqual({ tool: 'json-formatter', method: 'link', size: 'lt_1kb' });

  const serialized = JSON.stringify(sent);
  expect(serialized).not.toContain('ACME');
  expect(serialized).not.toContain('sk-live');
});

test('opening a shared link reports share_opened', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/json-formatter/');
  await typeJson(page, '{"a":1}');
  await page.locator('[data-share-action="prettify"]').first().click();
  await page.locator('#share-btn').click();
  await page.locator('#share-url-btn').click();
  await expect.poll(async () => (await events(page)).some((e: any) => e.event === 'share_created')).toBeTruthy();
  const shareUrl = await page.evaluate(() => navigator.clipboard.readText());
  expect(shareUrl).toContain('#lz:');

  // A same-page hash change would not re-run the restore, so land on another page first.
  await page.goto('/uuid-generator/');
  await page.goto(shareUrl);
  await expect.poll(async () => (await events(page)).some((e: any) => e.event === 'share_opened')).toBeTruthy();
  const opened = (await events(page)).find((e: any) => e.event === 'share_opened');
  expect(opened.params).toEqual({ tool: 'json-formatter', method: 'link', status: 'ok' });
});

test('palette and paste box report navigation without content', async ({ page }) => {
  await page.goto('/');
  await page.locator('#palette-trigger').click();
  await page.keyboard.type('uuid');
  const palette = await events(page);
  expect(palette).toContainEqual({ kind: 'event', event: 'palette_used', params: { action: 'opened' } });
  await page.keyboard.press('Escape');
  await expect(page.locator('#palette-modal')).toBeHidden();

  await page.locator('#magic-input').fill('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJzZWNyZXQtdXNlciJ9.aaaa');
  const link = page.locator('#magic-results a[href*="#lz:"]').first();
  await link.waitFor();
  // Stop the navigation so dataLayer survives for inspection; the link's own handler still runs.
  await page.evaluate(() => document.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('a')) event.preventDefault();
  }, true));
  await link.click();
  const sent = await events(page);
  const routed = sent.find((e: any) => e.event === 'magic_box_routed');
  expect(routed?.params.tool).toBe('jwt-decoder');
  expect(JSON.stringify(sent)).not.toContain('eyJ');
});

test('exports report the format', async ({ page }) => {
  await page.goto('/json-formatter/');
  await typeJson(page, '{"a":1}');
  await page.locator('[data-share-action="prettify"]').first().click();
  const download = page.waitForEvent('download').catch(() => null);
  await page.locator('#download-btn').click();
  await download;
  expect(await events(page)).toContainEqual({ kind: 'event', event: 'export_used', params: { tool: 'json-formatter', format: 'json' } });
});
