import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import LZString from 'lz-string';
import { exactJsonExample, exactFormatterExample, formatterExample } from '../../src/lib/json-examples.ts';

test.beforeEach(async ({ page }) => {
  await page.route('https://**/*', route => route.abort());
  await page.addInitScript(() => {
    localStorage.setItem('cookie-notice-dismissed', 'true'); localStorage.removeItem('bd-share-method');
    (window as any).__copied = ''; (window as any).__errors = [];
    window.addEventListener('error', event => (window as any).__errors.push(event.message));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as any).__copied = text; } } });
  });
});
test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => (window as any).__errors)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('lossless formatting, indent choices, validation, undo and downloads preserve exact tokens', async ({ page }) => {
  await page.goto('/json-formatter/');
  await page.locator('#editor').fill(exactJsonExample);
  await page.locator('#validate-btn').click();
  await expect(page.locator('#formatter-status')).toContainText('Input unchanged');
  await expect(page.locator('#editor')).toHaveValue(exactJsonExample);
  await expect(page.locator('#json-findings-summary')).toContainText('1 duplicate keys · 1 large numbers');
  await page.locator('#json-indent').selectOption('4');
  await page.locator('#prettify-btn').click();
  await expect(page.locator('#editor')).toHaveValue(/\n {4}"orderId": 9007199254740993/);
  await page.locator('#json-indent').selectOption('tab');
  await expect(page.locator('#editor')).toHaveValue(/\n\t"orderId": 9007199254740993/);
  await page.locator('#compact-btn').click();
  await expect(page.locator('#editor')).toHaveValue(exactJsonExample);
  const pending = page.waitForEvent('download'); await page.locator('#download-btn').click();
  expect(await readFile((await (await pending).path())!, 'utf8')).toBe(exactJsonExample);
  await page.locator('#undo-btn').click();
  await expect(page.locator('#editor')).toHaveValue(/\n\t"orderId"/);
  await page.locator('#clear-btn').click(); await expect(page.locator('#editor')).toHaveValue('');
  await page.locator('#undo-btn').click(); await expect(page.locator('#editor')).toHaveValue(/9007199254740993/);
});

test('duplicate tree entries, arbitrary keys, exact value and JSON Pointer copying', async ({ page }) => {
  await page.goto('/json-formatter/');
  const text = '{"a~/b":{"content.type":9007199254740993},"status":"first","status":"second","html":"<img src=x onerror=alert(1)>"}';
  await page.locator('#editor').fill(text); await page.locator('#tree-btn').click();
  await expect(page.locator('#tree-view [data-path=".status"]')).toHaveCount(2);
  await page.locator('#tree-view [data-path]').filter({ hasText: '9007199254740993' }).click();
  await expect(page.locator('#pointer-text')).toHaveText('/a~0~1b/content.type');
  await page.locator('#pointer-copy-btn').click(); expect(await page.evaluate(() => (window as any).__copied)).toBe('/a~0~1b/content.type');
  await page.locator('#value-copy-btn').click(); expect(await page.evaluate(() => (window as any).__copied)).toBe('9007199254740993');
  await page.locator('#path-copy-btn').click(); expect(await page.evaluate(() => (window as any).__copied)).toBe('.["a~/b"]["content.type"]');
  await expect(page.locator('#tree-view img, #tree-view script, #tree-view [onerror]')).toHaveCount(0);
  await page.locator('#back-btn').click(); await expect(page.locator('#editor')).toHaveValue(text);
});

test('large branches are lazy and bounded, expansion and collapse are keyboard-accessible', async ({ page }) => {
  await page.goto('/json-formatter/');
  await page.locator('#editor').fill('[' + Array.from({ length: 3000 }, (_, index) => index).join(',') + ']');
  await page.locator('#tree-btn').click();
  await expect(page.locator('#tree-view [data-path]')).toHaveCount(51);
  await page.locator('.json-tree-more').click(); await expect(page.locator('#tree-view [data-path]')).toHaveCount(101);
  await page.locator('#collapse-btn').click(); await expect(page.locator('.json-tree-children')).toBeHidden();
  await page.locator('#expand-btn').click(); await expect(page.locator('.json-tree-children')).toBeVisible();
  for (let i = 0; i < 30; i++) { if (await page.locator('.json-tree-more').isDisabled()) break; await page.locator('.json-tree-more').click(); }
  await expect(page.locator('#tree-view [data-path]')).toHaveCount(1500);
  await expect(page.locator('.json-tree-more')).toBeDisabled();
  await page.locator('#back-btn').click(); await expect(page.locator('#editor')).toHaveValue(/2999\]$/);
});

test('large-document text display, virtual line numbers, find and download stay complete', async ({ page }) => {
  await page.goto('/json-formatter/');
  const text = JSON.stringify({ rows: Array.from({ length: 1800 }, (_, i) => ({ id: i, payload: 'x'.repeat(160) })), last: 'END-OF-DOCUMENT' }, null, 2);
  await page.locator('#editor').fill(text);
  await expect(page.locator('[data-json-editor]')).toHaveClass(/json-editor-plain/);
  await page.locator('#find-btn').click(); await page.locator('#formatter-find-input').fill('END-OF-DOCUMENT');
  await page.locator('#formatter-find-next').click();
  await expect(page.locator('#formatter-find-count')).toHaveText('1 / 1');
  expect(await page.locator('#editor').evaluate(node => (node as HTMLTextAreaElement).scrollTop)).toBeGreaterThan(1000);
  const metrics = await page.locator('#editor').evaluate(node => ({ color: getComputedStyle(node).color, lines: node.closest('[data-json-editor]')!.querySelector('[data-json-editor-gutter]')!.textContent }));
  expect(metrics.color).not.toBe('rgba(0, 0, 0, 0)'); expect(metrics.lines).toContain('7200');
  await page.locator('#validate-btn').click(); await expect(page.locator('#formatter-status')).toContainText('Valid JSON');
  await page.locator('#copy-btn').click(); expect(await page.evaluate(() => (window as any).__copied)).toBe(text);
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  expect(await page.locator('#editor').evaluate(node => getComputedStyle(node).color)).toBe('rgb(226, 232, 240)');
});

test('same-tab shared restoration clears stale search and tree, old links retain default indentation', async ({ page }) => {
  await page.goto(exactFormatterExample);
  await expect(page.locator('#json-indent')).toHaveValue('4'); await expect(page.locator('#editor')).toHaveValue(/9007199254740993/);
  await page.locator('#find-btn').click(); await page.locator('#formatter-find-input').fill('orderId');
  await page.locator('#tree-btn').click(); await expect(page.locator('#tree-view')).toBeVisible();
  await page.evaluate(url => { location.hash = new URL(url, location.href).hash; }, formatterExample);
  await expect(page.locator('#editor')).toBeVisible(); await expect(page.locator('#editor')).toHaveValue(/ORD-42/);
  await expect(page.locator('#json-indent')).toHaveValue('2'); await expect(page.locator('#formatter-find-input')).toHaveValue('');
  await expect(page.locator('#json-findings')).toBeHidden();
});

test('share preserves exact raw text and indentation and restores the tree', async ({ page }) => {
  await page.goto('/json-formatter/'); await page.locator('#editor').fill(exactJsonExample); await page.locator('#json-indent').selectOption('tab');
  await page.locator('#tree-btn').click(); await expect(page.locator('#tree-view')).toBeVisible();
  await page.locator('#share-json-btn').click(); await page.locator('#share-url-btn').click();
  await expect.poll(() => page.evaluate(() => (window as any).__copied)).toContain('#lz:');
  const url = await page.evaluate(() => (window as any).__copied);
  const state = JSON.parse(LZString.decompressFromEncodedURIComponent(url.split('#lz:')[1])!);
  expect(state.d).toEqual({ json: exactJsonExample, indent: 'tab' }); expect(state.a).toBe('tree');
  await page.goto('/about/'); await page.goto(url);
  await expect(page.locator('#tree-view')).toContainText('9007199254740993');
  await expect(page.locator('#tree-view [data-path=".status"]')).toHaveCount(2);
});

test('invalid syntax, size, encoding and depth failures leave the current text intact', async ({ page }) => {
  await page.goto('/json-formatter/'); await page.locator('#editor').fill('{\n  "a":\n}');
  await page.locator('#validate-btn').click(); await expect(page.locator('#error-box')).toContainText('Line 3, column 1');
  await page.locator('#error-jump-btn').click(); expect(await page.locator('#editor').evaluate(node => (node as HTMLTextAreaElement).selectionStart)).toBe(9);
  const depth = '['.repeat(129) + '0' + ']'.repeat(129); await page.locator('#editor').fill(depth); await page.locator('#prettify-btn').click();
  await expect(page.locator('#error-box')).toContainText('128-level'); await expect(page.locator('#editor')).toHaveValue(depth);
  await page.locator('#json-file').setInputFiles({ name: 'private.json', mimeType: 'application/json', buffer: Buffer.from([0xff, 0xfe]) });
  await expect(page.locator('#error-box')).toContainText('UTF-8'); await expect(page.locator('#editor')).toHaveValue(depth);
  await page.locator('#json-file').setInputFiles({ name: 'large-private.json', mimeType: 'application/json', buffer: Buffer.alloc(10 * 1024 ** 2 + 1, 32) });
  await expect(page.locator('#error-box')).toContainText('10 MiB'); await expect(page.locator('#editor')).toHaveValue(depth);
});

test('cancelling and editing an in-flight operation cannot overwrite newer input', async ({ page }) => {
  await page.goto('/json-formatter/');
  await page.evaluate(() => {
    const text = '[' + Array.from({ length: 120000 }, () => '9007199254740993').join(',') + ']';
    const input = document.querySelector('#editor') as HTMLTextAreaElement; input.value = text; input.dispatchEvent(new Event('input', { bubbles: true }));
    (document.querySelector('#prettify-btn') as HTMLButtonElement).click();
    (document.querySelector('#cancel-btn') as HTMLButtonElement).click();
  });
  await expect(page.locator('#formatter-status')).toContainText('Cancelled');
  await page.locator('#editor').fill('{"new":true}'); await page.locator('#validate-btn').click();
  await expect(page.locator('#formatter-status')).toContainText('Valid JSON'); await expect(page.locator('#editor')).toHaveValue('{"new":true}');
});

test('precision guide is crawlable and its runnable example keeps original digits', async ({ page }) => {
  await page.goto('/guides/json-large-integers-duplicate-keys/');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://bugdays.com/guides/json-large-integers-duplicate-keys/');
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', 'https://bugdays.com/og/json-formatter.png');
  await page.locator('.json-example-primary').click(); await expect(page.locator('#editor')).toHaveValue(/9007199254740993/);
  await expect(page.locator('#json-indent')).toHaveValue('4');
});

test('a large clipboard paste replaces only the selected range and validates', async ({ page }) => {
  await page.goto('/json-formatter/');
  const records = '[' + Array.from({ length: 6000 }, (_, i) => `{"id":${i}}`).join(',') + ']';
  await page.locator('#editor').fill('{"rows":[],"keep":true}');
  await page.locator('#editor').evaluate((node, text) => {
    const input = node as HTMLTextAreaElement; input.focus(); input.setSelectionRange(8, 10);
    const data = new DataTransfer(); data.setData('text/plain', text);
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, records);
  await expect(page.locator('#editor')).toHaveValue(`{"rows":${records},"keep":true}`);
  await page.locator('#validate-btn').click(); await expect(page.locator('#formatter-status')).toContainText('Valid JSON');
});

test('clipboard denial and worker startup failure are recoverable and do not change input', async ({ page }) => {
  await page.goto('/json-formatter/'); await page.locator('#editor').fill('{"keep":true}');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied'); } } });
    (window as any).__realWorker = window.Worker;
    (window as any).Worker = class { constructor() { throw new Error('blocked'); } };
  });
  await page.locator('#copy-btn').click(); await expect(page.locator('#formatter-status')).toContainText('Clipboard access was unavailable');
  await page.locator('#prettify-btn').click(); await expect(page.locator('#error-box')).toContainText('could not start local processing');
  await expect(page.locator('#editor')).toHaveValue('{"keep":true}');
  await page.evaluate(() => { window.Worker = (window as any).__realWorker; });
  await page.locator('#validate-btn').click(); await expect(page.locator('#formatter-status')).toContainText('Valid JSON');
});
