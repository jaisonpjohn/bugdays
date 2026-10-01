import { test, expect, type Page } from '@playwright/test';
import LZString from 'lz-string';
import { readFile } from 'node:fs/promises';
import { apiResponse, originalConfig, modifiedConfig, formatterExample, diffExample, unorderedExample } from '../../src/lib/json-examples.ts';

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

async function compare(page: Page, original: unknown, modified: unknown) {
  await page.locator('#json1').fill(JSON.stringify(original));
  await page.locator('#json2').fill(JSON.stringify(modified));
  await page.locator('#compare-btn').click();
  await expect(page.locator('#stats')).toBeVisible();
  // Highlighting must leave the complete JSON intact, including repeated values.
  expect(JSON.parse((await page.locator('#diff-left').textContent())!)).toEqual(original);
  expect(JSON.parse((await page.locator('#diff-right').textContent())!)).toEqual(modified);
}

test('formatter formats, compacts, downloads, and restores a shared tree', async ({ page }) => {
  await page.goto('/json-formatter/');
  await page.locator('#sample-btn').click();
  await expect(page.locator('#editor')).toHaveValue(JSON.stringify(apiResponse, null, 2));
  await page.locator('#compact-btn').click();
  await expect(page.locator('#editor')).toHaveValue(JSON.stringify(apiResponse));
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#download-btn').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('formatted.json');
  expect(JSON.parse(await readFile((await download.path())!, 'utf8'))).toEqual(apiResponse);
  await page.locator('#tree-btn').click();
  await expect(page.locator('#tree-view')).toBeVisible();
  await page.locator('[data-path=".orders[0].status"]').last().click();
  await expect(page.locator('#path-text')).toHaveText('.orders[0].status');
  await page.locator('#path-tooltip').click();
  expect(await page.evaluate(() => (window as any).__copied)).toBe('.orders[0].status');
  const url = await share(page, '#share-json-btn');
  const state = JSON.parse(LZString.decompressFromEncodedURIComponent(url.split('#lz:')[1])!);
  expect(state.t).toBe('json-formatter');
  expect(state.a).toBe('tree');
  expect(JSON.parse(state.d.json)).toEqual(apiResponse);
  await page.goto('/about/');
  await page.goto(url);
  await expect(page.locator('#tree-view')).toBeVisible();
  await expect(page.locator('#tree-view')).toContainText('paid');
  await page.locator(`.json-copy a[href="${formatterExample}"]`).click();
  await expect(page.locator('#editor')).toBeVisible();
  await expect(page.locator('#editor')).toHaveValue(JSON.stringify(apiResponse, null, 2));
});

test('formatter safely quotes arbitrary keys in jq paths and reports syntax errors', async ({ page }) => {
  await page.goto('/json-formatter/');
  const key = 'a" onmouseover="alert(1)';
  const data = { 'content.type': 'application/json', [key]: '<script>bad</script>' };
  await page.locator('#editor').fill(JSON.stringify(data));
  await page.locator('#tree-btn').click();
  const paths = await page.locator('#tree-view [data-path]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.path));
  expect(paths).toContain('.["content.type"]');
  expect(paths).toContain(`.[${JSON.stringify(key)}]`);
  await expect(page.locator('#tree-view [onmouseover], #tree-view script')).toHaveCount(0);
  await page.locator('#tree-view [data-path]').filter({ hasText: 'application/json' }).click();
  await expect(page.locator('#path-text')).toHaveText('.["content.type"]');
  await page.locator('#back-btn').click();
  await page.locator('#editor').fill('{"status":"paid",}');
  await page.locator('#prettify-btn').click();
  await expect(page.locator('#error-box')).toBeVisible();
  await expect(page.locator('#editor')).toHaveValue('{"status":"paid",}');
  await page.locator('#editor').fill('null');
  await page.locator('#prettify-btn').click();
  await expect(page.locator('#error-box')).toBeHidden();
  await expect(page.locator('#editor')).toHaveValue('null');
});

test('formatter provides syntax colors, line numbers, search, local files, and an error jump', async ({ page }) => {
  await page.goto('/json-formatter/');
  await page.locator('#editor').fill('{\n  "status": "paid",\n  "total": 29.5\n}');
  await expect(page.locator('[data-json-editor-gutter]')).toContainText('1\n2\n3');
  await expect(page.locator('[data-json-editor-code] .json-token-key')).toHaveCount(2);
  await page.locator('#find-btn').click();
  await page.locator('#formatter-find-input').fill('paid');
  await expect(page.locator('#formatter-find-count')).toHaveText('1 / 1');
  await expect(page.locator('.json-search-active')).toHaveCount(1);
  await page.locator('#json-file').setInputFiles({ name: 'private-response.json', mimeType: 'application/json', buffer: Buffer.from('{"loaded":true}') });
  await expect(page.locator('#editor')).toHaveValue('{"loaded":true}');
  await expect(page.locator('#file-status')).toContainText('Nothing was uploaded');
  await expect(page.locator('#file-status')).not.toContainText('private-response');
  await page.locator('#editor').fill('{\n  "loaded":\n}');
  await page.locator('#prettify-btn').click();
  await expect(page.locator('#error-box')).toContainText('Line 3, column 1');
  await expect(page.locator('.json-editor-error')).toHaveCount(1);
  await page.locator('#error-jump-btn').click();
  expect(await page.locator('#editor').evaluate(element => document.activeElement === element && (element as HTMLTextAreaElement).selectionStart > 0)).toBeTruthy();
});

test('runnable diff examples restore settings and share the actual comparison', async ({ page }) => {
  await page.goto(diffExample);
  await expect(page.locator('#stats')).toContainText('4 differences');
  await expect(page.locator('#changes-list')).toContainText('service.timeout');
  await page.goto(unorderedExample);
  await expect(page.locator('#stats')).toContainText('2 differences');
  await expect(page.locator('#ignore-array-order')).toBeChecked();
  const url = await share(page, '#share-diff-btn');
  const state = JSON.parse(LZString.decompressFromEncodedURIComponent(url.split('#lz:')[1])!);
  expect(state.t).toBe('json-diff');
  expect(state.a).toBe('compare');
  expect(state.d.ignoreArrayOrder).toBe(true);
  expect(JSON.parse(state.d.json1)).toEqual(originalConfig);
  expect(JSON.parse(state.d.json2)).toEqual(modifiedConfig);
  await page.goto('/about/');
  await page.goto(url);
  await expect(page.locator('#stats')).toContainText('2 differences');
  await page.locator('#swap-btn').click();
  await expect(page.locator('#stats')).toContainText('1 removed');
});

test('diff has line-aware inputs, file loading, find, change navigation, and JSON report export', async ({ page }) => {
  await page.goto('/json-diff/');
  await page.locator('#json1-file').setInputFiles({ name: 'before-private.json', mimeType: 'application/json', buffer: Buffer.from('{"status":"queued","count":1}') });
  await page.locator('#json2-file').setInputFiles({ name: 'after-private.json', mimeType: 'application/json', buffer: Buffer.from('{"status":"paid","count":2,"active":true}') });
  await expect(page.locator('#json1')).toHaveValue('{"status":"queued","count":1}');
  await expect(page.locator('#json2')).toHaveValue('{"status":"paid","count":2,"active":true}');
  await expect(page.locator('#json1-file-status')).toContainText('Nothing was uploaded');
  await expect(page.locator('#json1-file-status')).not.toContainText('before-private');
  await page.locator('#compare-btn').click();
  await expect(page.locator('#change-nav')).toBeVisible();
  await expect(page.locator('#change-position')).toContainText('Change 1 / 3');
  await page.locator('#change-next').click();
  await expect(page.locator('#change-position')).toContainText('Change 2 / 3');
  await page.locator('#changes-list [data-change-index="1"]').click();
  await expect(page.locator('#diff-left mark.diff-focus, #diff-right mark.diff-focus')).toHaveCount(2);
  await page.locator('#diff-find-btn').click();
  await page.locator('#diff-find-input').fill('paid');
  await expect(page.locator('#diff-find-count')).toHaveText('1 / 1');
  await expect(page.locator('.json-search-active')).toHaveCount(1);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-report-btn').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('json-diff-report.json');
  const report = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(report.options).toEqual({ ignoreKeyOrder: true, ignoreArrayOrder: false });
  expect(report.changes.map((change: { path: string }) => change.path).sort()).toEqual(['active', 'count', 'status']);
});

test('unordered arrays preserve duplicate counts and respect nested ordering options', async ({ page }) => {
  await page.goto('/json-diff/');
  await page.locator('#ignore-array-order').check();
  await compare(page, [1, 1, 2], [1, 2, 2]);
  await expect(page.locator('#stats')).toContainText('2 differences');
  await expect(page.locator('#stats')).toContainText('1 added');
  await expect(page.locator('#stats')).toContainText('1 removed');
  await compare(page, [{ a: 1, b: [1, 2] }], [{ b: [2, 1], a: 1 }]);
  await expect(page.locator('#stats')).toContainText('No differences');
  await page.locator('#ignore-key-order').uncheck();
  await expect(page.locator('#stats')).toContainText('2 differences');
  const proto1 = JSON.parse('[{"__proto__":{"x":1}}]');
  const proto2 = JSON.parse('[{"__proto__":{"x":2}}]');
  await compare(page, proto1, proto2);
  await expect(page.locator('#stats')).toContainText('2 differences');
});

test('ordered objects, missing fields, nulls, roots, and repeated values highlight correctly', async ({ page }) => {
  await page.goto('/json-diff/');
  await compare(page, { a: 1, b: 2 }, { b: 2, a: 1 });
  await expect(page.locator('#stats')).toContainText('No differences');
  await page.locator('#ignore-key-order').uncheck();
  await expect(page.locator('#stats')).toContainText('1 difference');
  await expect(page.locator('#diff-left mark')).toHaveAttribute('title', '(root)');
  await page.locator('#ignore-key-order').check();
  await compare(page, { a: 1, b: 1, c: [1, 1] }, { a: 2, b: 2, c: [2, 2], email: null });
  await expect(page.locator('#stats')).toContainText('5 differences');
  await expect(page.locator('#diff-left mark')).toHaveCount(4);
  await compare(page, { email: 'user@example.test', value: 1 }, { email: null, value: '1' });
  await expect(page.locator('#stats')).toContainText('2 differences');
  await compare(page, null, []);
  await expect(page.locator('#stats')).toContainText('1 difference');
  await expect(page.locator('#diff-left mark')).toHaveText('null');
});

test('quoted keys and HTML-like values remain text and cannot collide with nested paths', async ({ page }) => {
  await page.goto('/json-diff/');
  const key = 'a" onmouseover="alert(1)';
  await compare(page,
    { 'a.b': 1, a: { b: 2 }, [key]: '<img src=x onerror=alert(1)>' },
    { 'a.b': 3, a: { b: 4 }, [key]: '<script>alert(2)</script>' });
  await expect(page.locator('#stats')).toContainText('3 differences');
  const titles = await page.locator('#diff-left mark').evaluateAll(nodes => nodes.map(node => node.getAttribute('title')));
  expect(titles).toContain('["a.b"]');
  expect(titles).toContain('a.b');
  expect(titles).toContain(`[${JSON.stringify(key)}]`);
  await expect(page.locator('#results [onmouseover], #results img, #results script')).toHaveCount(0);
  await page.locator('#json2').fill('{invalid}');
  await page.locator('#compare-btn').click();
  await expect(page.locator('#error-box')).toContainText('Invalid JSON in right panel');
  await expect(page.locator('#results')).toBeHidden();
});

test('diff results remain readable in dark mode', async ({ page }) => {
  await page.goto('/json-diff/');
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await compare(page, { value: 1 }, { value: 2, enabled: true });
  expect(await page.locator('#stats').evaluate(node => getComputedStyle(node).color)).not.toBe('rgb(31, 41, 55)');
  await expect(page.locator('#changes-list .dark\\:text-indigo-300')).toHaveCount(2);
});

test('JSON tool SEO, visible FAQs, guides, and runnable examples agree', async ({ page, request }) => {
  const guides = ['format-validate-json-api-response', 'compare-json-api-responses-ignore-array-order'];
  for (const [tool, slug] of [['json-formatter', guides[0]], ['json-diff', guides[1]]]) {
    await page.goto(`/${tool}/`);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `https://bugdays.com/${tool}/`);
    await expect(page.locator('meta[name="robots"]')).not.toHaveAttribute('content', /noindex/);
    await expect(page.locator('meta[property="og:description"]')).toHaveAttribute('content', await page.locator('meta[name="description"]').getAttribute('content') as string);
    const schemas = await page.locator('script[type="application/ld+json"]').evaluateAll(nodes => nodes.flatMap(node => JSON.parse(node.textContent!)));
    expect(schemas.find(schema => schema['@type'] === 'WebApplication').url).toBe(`https://bugdays.com/${tool}/`);
    const faq = schemas.find(schema => schema['@type'] === 'FAQPage');
    expect(faq.mainEntity).toHaveLength(5);
    for (const question of faq.mainEntity) {
      const details = page.locator('.json-copy details').filter({ hasText: question.name });
      await expect(details.locator('summary')).toHaveText(question.name);
      expect(await details.locator('p').textContent()).toBe(question.acceptedAnswer.text);
    }
    await page.locator(`.json-copy a[href="/guides/${slug}/"]`).first().click();
    await expect(page.locator('meta[property="og:type"]')).toHaveAttribute('content', 'article');
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `https://bugdays.com/guides/${slug}/`);
    expect(await page.locator('.guide-body h2').count()).toBeGreaterThanOrEqual(5);
    const exampleButton = page.locator('.guide-body .json-example-primary');
    expect(await exampleButton.evaluate(node => getComputedStyle(node).color)).toBe('rgb(255, 255, 255)');
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    expect(await exampleButton.evaluate(node => getComputedStyle(node).color)).toBe('rgb(255, 255, 255)');
    const link = await page.locator(`.guide-body a[href^="/${tool}/#lz:"]`).first().getAttribute('href');
    await page.goto(link!);
    if (tool === 'json-formatter') await expect(page.locator('#editor')).toHaveValue(JSON.stringify(apiResponse, null, 2));
    else await expect(page.locator('#stats')).toContainText('4 differences');
  }
  await page.goto('/guides/');
  for (const slug of guides) await expect(page.locator(`a[href="/guides/${slug}/"]`).first()).toBeVisible();
  const rss = await (await request.get('/guides/rss.xml')).text();
  for (const slug of guides) expect(rss).toContain(`/guides/${slug}/`);
  await page.goto(formatterExample);
  await expect(page.locator('#editor')).toHaveValue(JSON.stringify(apiResponse, null, 2));
});
