import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import LZString from 'lz-string';
import { keyedDiffExample, diffExample, keyedDiffOriginal, keyedDiffModified } from '../../src/lib/json-examples.ts';

test.beforeEach(async ({ page }) => {
  await page.route('https://**/*', route => route.abort());
  await page.addInitScript(() => {
    localStorage.setItem('cookie-notice-dismissed', 'true'); localStorage.removeItem('bd-share-method');
    (window as any).__errors = []; (window as any).__copied = '';
    window.addEventListener('error', event => (window as any).__errors.push(event.message));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as any).__copied = text; } } });
  });
});
test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => (window as any).__errors)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});
async function compare(page: Page, left: string, right: string) {
  await page.locator('#json1').fill(left); await page.locator('#json2').fill(right); await page.locator('#compare-btn').click();
  await expect(page.locator('#stats')).toBeVisible();
}
async function download(page: Page, id: string) {
  const pending = page.waitForEvent('download'); await page.locator(id).click(); const file = await pending;
  return { name: file.suggestedFilename(), text: await readFile((await file.path())!, 'utf8') };
}
test('exact numbers survive comparison, copy, report and JSON Patch export', async ({ page }) => {
  await page.goto('/json-diff/');
  await compare(page, '{"id":9007199254740993,"decimal":1.0000000000000001}', '{"id":9007199254740994,"decimal":1.0000000000000002}');
  await expect(page.locator('#stats')).toContainText('2 differences');
  await expect(page.locator('#diff-left')).toContainText('9007199254740993');
  await page.locator('#copy-old-btn').click(); expect(await page.evaluate(() => (window as any).__copied)).toBe('9007199254740993');
  await page.locator('#copy-new-btn').click(); expect(await page.evaluate(() => (window as any).__copied)).toBe('9007199254740994');
  await page.locator('#copy-pointer-btn').click(); expect(await page.evaluate(() => (window as any).__copied)).toBe('/id');
  const report = await download(page, '#export-report-btn'); expect(report.name).toBe('json-diff-report.json'); expect(report.text).toContain('"oldValue":9007199254740993');
  const patch = await download(page, '#export-patch-btn'); expect(patch.name).toBe('json-diff.patch.json'); expect(patch.text).toContain('"value":1.0000000000000002');
});
test('equal decimals and roots still export an empty report and patch', async ({ page }) => {
  await page.goto('/json-diff/'); await compare(page, '1e400', '10e399');
  await expect(page.locator('#stats')).toContainText('No differences'); await expect(page.locator('#selected-change')).toBeHidden();
  expect(JSON.parse((await download(page, '#export-report-btn')).text).changes).toEqual([]);
  expect((await download(page, '#export-patch-btn')).text).toBe('[]');
});
test('ID matching and ignored timestamps restore through same-tab and fresh share links', async ({ page }) => {
  await page.goto(keyedDiffExample); await expect(page.locator('#stats')).toContainText('2 differences');
  await expect(page.locator('#array-key')).toHaveValue('id'); await expect(page.locator('#ignored-paths')).toHaveValue('updatedAt');
  await expect(page.locator('#selected-path')).toContainText('/items/0/status → Modified: /items/1/status');
  await expect(page.locator('#export-patch-btn')).toBeDisabled();
  await page.locator('#share-result-btn').click(); await page.locator('#share-url-btn').click();
  const url = await page.evaluate(() => (window as any).__copied as string);
  const state = JSON.parse(LZString.decompressFromEncodedURIComponent(url.split('#lz:')[1])!);
  expect(state.d.json1).toBe(keyedDiffOriginal); expect(state.d.json2).toBe(keyedDiffModified); expect(state.d.arrayKey).toBe('id'); expect(state.d.ignoredPaths).toBe('updatedAt');
  await page.goto(diffExample); await expect(page.locator('#stats')).toContainText('4 differences');
  await expect(page.locator('#array-key')).toHaveValue(''); await expect(page.locator('#ignored-paths')).toHaveValue(''); await expect(page.locator('#export-patch-btn')).toBeEnabled();
  await page.goto('/about/'); await page.goto(url); await expect(page.locator('#stats')).toContainText('2 differences');
});
test('duplicate keys and duplicate or missing IDs report precise actionable errors', async ({ page }) => {
  await page.goto('/json-diff/');
  await page.locator('#json1').fill('{}'); await page.locator('#json2').fill(' \n{"a":1,"a":2}'); await page.locator('#compare-btn').click();
  await expect(page.locator('#error-box')).toContainText('Duplicate key'); await expect(page.locator('#error-box')).toContainText('right panel at line 2');
  await page.locator('#diff-error-jump').click(); expect(await page.locator('#json2').evaluate(n => (n as HTMLTextAreaElement).selectionStart)).toBeGreaterThan(5);
  await page.locator('#diff-advanced').evaluate(n => (n as HTMLDetailsElement).open = true); await page.locator('#array-key').fill('id');
  await page.locator('#json1').fill('[{"id":1},{"id":1}]'); await page.locator('#json2').fill('[]'); await page.locator('#compare-btn').click();
  await expect(page.locator('#error-box')).toContainText('duplicate "id"'); await expect(page.locator('#results')).toBeHidden();
  await page.locator('#json1').fill('[{}]'); await page.locator('#compare-btn').click(); await expect(page.locator('#error-box')).toContainText('on every record');
});
test('format both is lossless and atomic when one panel is malformed', async ({ page }) => {
  await page.goto('/json-diff/'); const source = '{"id":9007199254740993,"a":1,"a":2,"price":12.50}';
  await page.locator('#json1').fill(source); await page.locator('#json2').fill('{bad}'); await page.locator('#format-btn').click();
  await expect(page.locator('#error-box')).toBeVisible(); await expect(page.locator('#json1')).toHaveValue(source);
  await page.locator('#json2').fill('{}'); await page.locator('#format-btn').click(); await expect(page.locator('#json1')).toHaveValue(/\n/);
  await expect(page.locator('#json1')).toHaveValue(/9007199254740993/); await expect(page.locator('#json1')).toHaveValue(/12\.50/);
  expect((await page.locator('#json1').inputValue()).match(/"a"/g)).toHaveLength(2);
});
test('editing and clearing invalidate old results, report exports, and copied selections', async ({ page }) => {
  await page.goto('/json-diff/'); await compare(page, '{"x":1}', '{"x":2}');
  await page.locator('#json2').fill('{"x":3}'); await expect(page.locator('#stats')).toBeHidden(); await expect(page.locator('#results')).toBeHidden();
  await page.locator('#compare-btn').click(); await expect(page.locator('#selected-value')).toContainText('After: 3');
  await page.locator('#clear-btn').click(); await expect(page.locator('#results')).toBeHidden(); await expect(page.locator('#share-diff-btn')).toBeDisabled();
});
test('field and pointer filters take effect without redacting the shared input', async ({ page }) => {
  await page.goto('/json-diff/'); await compare(page, '{"updatedAt":1,"meta":{"requestId":"a"},"x":1}', '{"updatedAt":2,"meta":{"requestId":"b"},"x":2}');
  await page.locator('#diff-advanced').evaluate(n => (n as HTMLDetailsElement).open = true); await page.locator('#ignored-paths').fill('updatedAt\n/meta/requestId');
  await expect(page.locator('#stats')).toContainText('1 difference'); await expect(page.locator('#diff-left')).toContainText('requestId');
  await page.locator('#ignored-paths').fill('/meta/request~Id'); await expect(page.locator('#error-box')).toContainText('Pointer escape');
});
test('large comparisons keep bounded previews and a full-input jump at the last record', async ({ page }) => {
  await page.goto('/json-diff/');
  const a = JSON.stringify({ rows: Array.from({ length: 10000 }, (_, id) => ({ id, text: 'x'.repeat(25) })) }); const b = a.replace(/x{25}(?="\}\]\})/, 'last-record-changed');
  await compare(page, a, b); await expect(page.locator('#stats')).toContainText('1 difference'); await expect(page.locator('#diff-status')).toContainText('previews limited');
  await expect(page.locator('#changes-list')).toContainText('rows[9999].text'); await page.locator('#jump-new-btn').click();
  expect(await page.locator('#json2').evaluate(n => (n as HTMLTextAreaElement).selectionStart)).toBeGreaterThan(400000);
  await page.locator('#copy-new-btn').click(); expect(await page.evaluate(() => (window as any).__copied)).toBe('"last-record-changed"');
});
test('cancel and new edits terminate queued processing without a stale success', async ({ page }) => {
  await page.goto('/json-diff/'); await page.locator('#json1').fill('[1,2,3]'); await page.locator('#json2').fill('[2,3,4]');
  await page.evaluate(() => { document.getElementById('compare-btn')!.click(); document.getElementById('cancel-diff-btn')!.click(); });
  await expect(page.locator('#diff-status')).toContainText('Cancelled'); await page.waitForTimeout(200); await expect(page.locator('#results')).toBeHidden();
  await page.evaluate(() => { document.getElementById('compare-btn')!.click(); const n = document.getElementById('json2') as HTMLTextAreaElement; n.value = '[1,2,3]'; n.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(200); await expect(page.locator('#results')).toBeHidden(); await page.locator('#compare-btn').click(); await expect(page.locator('#stats')).toContainText('No differences');
});
test('change lists stay paged and path filters do not narrow report exports', async ({ page }) => {
  await page.goto('/json-diff/'); await compare(page, JSON.stringify(Array(120).fill(1)), JSON.stringify(Array(120).fill(2)));
  await expect(page.locator('#changes-list [data-change-index]')).toHaveCount(50); await page.locator('#changes-more').click(); await expect(page.locator('#changes-more')).toContainText('51–100');
  await page.locator('#change-filter').fill('[119]'); await expect(page.locator('#changes-list [data-change-index]')).toHaveCount(1);
  expect(JSON.parse((await download(page, '#export-report-btn')).text).changes).toHaveLength(120);
});
test('find has one active match across both panels and survives scrolling and navigation', async ({ page }) => {
  await page.goto('/json-diff/'); await compare(page, '{"needle":1}', '{"needle":2}');
  await page.locator('#diff-find-btn').click(); await page.locator('#diff-find-input').fill('needle'); await expect(page.locator('#diff-find-count')).toHaveText('1 / 2');
  await expect(page.locator('.json-search-active')).toHaveCount(1); await page.locator('#diff-find-next').click(); await expect(page.locator('#diff-find-count')).toHaveText('2 / 2'); await expect(page.locator('.json-search-active')).toHaveCount(1);
  await page.locator('#diff-find-close').click(); await page.locator('#json1').focus(); await page.keyboard.press('Control+f'); await expect(page.locator('#diff-find-bar')).toBeVisible();
  await page.goto('/json-formatter/'); await page.locator('#editor').fill('{"x":1}'); await page.keyboard.press('Control+f'); await expect(page.locator('#formatter-find-bar')).toBeVisible();
  await page.goto('/json-diff/'); await compare(page, '1', '2'); await expect(page.locator('#stats')).toContainText('1 difference');
});
test('local malformed UTF-8 files fail without replacing existing text', async ({ page }) => {
  await page.goto('/json-diff/'); await page.locator('#json1').fill('{"kept":true}');
  await page.locator('#json1-file').setInputFiles({ name: 'private.json', mimeType: 'application/json', buffer: Buffer.from([0xff, 0xfe]) });
  await expect(page.locator('#error-box')).toContainText('UTF-8'); await expect(page.locator('#json1')).toHaveValue('{"kept":true}'); await expect(page.locator('#error-box')).not.toContainText('private.json');
});
test('new guide is discoverable, relevant, runnable and has article metadata', async ({ page }) => {
  await page.goto('/json-tools/'); await page.locator('a[href="/guides/compare-json-arrays-by-id-ignore-fields/"]').click();
  await expect(page.locator('h1')).toContainText('Compare JSON Arrays by ID'); await expect(page.locator('meta[property="og:type"]')).toHaveAttribute('content', 'article');
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', 'https://bugdays.com/og/json-diff.png');
  await page.locator('.json-example-primary').click(); await expect(page.locator('#stats')).toContainText('2 differences');
  await page.evaluate(() => document.documentElement.classList.add('dark')); await expect(page.locator('#changes-list .dark\\:text-indigo-300')).toHaveCount(2);
});
test('preview scrolling stays synchronized and can be unlinked', async ({ page }) => {
  await page.goto('/json-diff/');
  await compare(page, JSON.stringify(Array(120).fill({ value: 1 })), JSON.stringify(Array(120).fill({ value: 2 })));
  await page.locator('#diff-left').evaluate(n => n.scrollTop = 600);
  await expect.poll(() => page.locator('#diff-right').evaluate(n => n.scrollTop)).toBeGreaterThan(500);
  await page.locator('#sync-previews').uncheck();
  const previous = await page.locator('#diff-right').evaluate(n => n.scrollTop);
  await page.locator('#diff-left').evaluate(n => n.scrollTop = 1000); await page.waitForTimeout(50);
  expect(await page.locator('#diff-right').evaluate(n => n.scrollTop)).toBe(previous);
});
