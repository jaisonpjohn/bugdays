import { test, expect, type Download } from '@playwright/test';
import { gzipSync, gunzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import LZString from 'lz-string';

const payload = (text: string) => gzipSync(Buffer.from(text)).toString('base64');
async function downloaded(download: Download) {
  const stream = await download.createReadStream(), chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
test.beforeEach(async ({ page }) => {
  await page.route('https://**/*', route => route.abort());
  await page.addInitScript(() => {
    localStorage.setItem('cookie-notice-dismissed', 'true'); localStorage.removeItem('bd-share-method');
    (window as any).__copied = ''; (window as any).__errors = [];
    window.addEventListener('error', event => (window as any).__errors.push(event.message));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { (window as any).__copied = value; } } });
  });
});
test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => (window as any).__errors)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('compact light/dark UI defers its worker and decodes every published example', async ({ page }, testInfo) => {
  const workers: string[] = []; page.on('request', request => { if (request.url().includes('gzip.worker')) workers.push(request.url()); });
  await page.goto('/gzip-base64/'); await expect(page.locator('#gzip-workspace')).toHaveAttribute('data-init', 'true');
  expect(workers).toEqual([]); await expect(page.locator('#copy-btn')).toBeDisabled();
  if (testInfo.project.name === 'mobile') {
    const action = await page.locator('#decompress-btn').boundingBox(), result = await page.locator('#output').boundingBox();
    expect(action!.y).toBeLessThan(result!.y);
  }
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://bugdays.com/gzip-base64/');
  const examples = page.locator('[data-gzip-example]'); await expect(examples).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    const encoded = await examples.nth(i).getAttribute('data-example-input'); await examples.nth(i).click();
    await expect(page.locator('#output')).toHaveValue(gunzipSync(Buffer.from(encoded!, 'base64')).toString());
    await expect(page.locator('#stats .gzip-stat')).toHaveCount(4); await expect(page.locator('#gzip-share')).toBeEnabled();
  }
  expect(workers.length).toBeGreaterThan(0);
  await page.evaluate(() => { window.scrollTo(0, 0); document.documentElement.classList.remove('dark'); });
  await expect(page.locator('body')).toHaveCSS('background-color', /oklch\(0\.984 /);
  await page.screenshot({ path: testInfo.outputPath('gzip-light.png') });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await expect(page.locator('body')).toHaveCSS('background-color', /oklch\(0\.208 /);
  await page.screenshot({ path: testInfo.outputPath('gzip-dark.png') });
});

test('UTF-8 compression, clipboard, reverse conversion and both downloads retain bytes', async ({ page }) => {
  await page.goto('/gzip-base64/'); const text = '{"message":"Hello, café ☕ 中文"}';
  await page.locator('#input').fill(text); await page.locator('#gzip-level').selectOption('9'); await page.locator('#compress-btn').click();
  await expect(page.locator('#gzip-status')).toContainText('Compressed locally');
  const encoded = await page.locator('#output').inputValue(); expect(gunzipSync(Buffer.from(encoded, 'base64')).toString()).toBe(text);
  await page.locator('#copy-btn').click(); expect(await page.evaluate(() => (window as any).__copied)).toBe(encoded);
  const gzPromise = page.waitForEvent('download'); await page.locator('#gzip-download-gz').click(); const gz = await gzPromise;
  expect(gz.suggestedFilename()).toBe('payload.gz'); expect(gunzipSync(await downloaded(gz)).toString()).toBe(text);
  const b64Promise = page.waitForEvent('download'); await page.locator('#gzip-download').click();
  expect((await downloaded(await b64Promise)).toString()).toBe(encoded);
  await page.locator('#gzip-use-output').click(); await expect(page.locator('#output')).toHaveValue(text);
  const jsonPromise = page.waitForEvent('download'); await page.locator('#gzip-download').click(); const json = await jsonPromise;
  expect(json.suggestedFilename()).toBe('decoded-output.json'); expect((await downloaded(json)).toString()).toBe(text);
  await page.locator('#gzip-use-output').click(); await expect(page.locator('#output')).toHaveValue(encoded);
});

test('errors distinguish Base64, headers, truncation and checksums; stale results cannot be exported', async ({ page }) => {
  await page.goto('/gzip-base64/');
  const raw = gzipSync(Buffer.from('complete value')), crc = Buffer.from(raw); crc[crc.length - 8] ^= 1;
  const samples = [
    ['{ "bad": true }', 'Invalid Base64 characters'], ['A', 'Invalid Base64 length'],
    [Buffer.from('plain text').toString('base64'), 'do not start with the GZip header'],
    [raw.subarray(0, -8).toString('base64'), 'before its trailer'], [crc.toString('base64'), 'checksum'],
  ];
  for (const [input, message] of samples) {
    await page.locator('#input').fill(payload('valid')); await page.locator('#decompress-btn').click(); await expect(page.locator('#output')).toHaveValue('valid');
    await page.locator('#input').fill(input); await expect(page.locator('#output')).toHaveValue(''); await expect(page.locator('#gzip-download')).toBeDisabled();
    await page.locator('#decompress-btn').click(); await expect(page.locator('#gzip-error')).toContainText(message);
    await expect(page.locator('#output')).toHaveValue(''); await expect(page.locator('#copy-btn')).toBeDisabled();
  }
  await page.locator('#clear-btn').click(); await expect(page.locator('#gzip-error')).toBeHidden(); await expect(page.locator('#gzip-share')).toBeDisabled();
});

test('Base64URL, wrapping, quoted strings, data URI and explicit hex have useful results', async ({ page }) => {
  await page.goto('/gzip-base64/'); const text = 'Hello, café ☕', encoded = payload(text);
  for (const input of [encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), encoded.replace(/.{12}/g, '$&\n'), JSON.stringify(encoded), `data:application/gzip;base64,${encoded}`]) {
    await page.locator('#input').fill(input); await page.locator('#decompress-btn').click(); await expect(page.locator('#output')).toHaveValue(text);
  }
  await page.locator('#input').fill(gzipSync(Buffer.from(text)).toString('hex').match(/../g)!.join(' '));
  await page.locator('#gzip-encoding').selectOption('hex'); await page.locator('#decompress-btn').click(); await expect(page.locator('#output')).toHaveValue(text);
});

test('local .gz and text files never upload; binary downloads preserve original bytes', async ({ page }) => {
  const uploads: string[] = []; page.on('request', request => { if (['POST', 'PUT'].includes(request.method())) uploads.push(request.url()); });
  await page.goto('/gzip-base64/'); const binary = Buffer.from([0, 255, 65, 1]);
  await page.locator('#gzip-file').setInputFiles({ name: 'private-account.bin.gz', mimeType: 'application/gzip', buffer: gzipSync(binary) });
  await expect(page.locator('#gzip-status')).toContainText('original bytes'); await expect(page.locator('#output')).toHaveValue('');
  await expect(page.locator('#copy-btn')).toBeDisabled(); const promise = page.waitForEvent('download'); await page.locator('#gzip-download').click(); const file = await promise;
  expect(file.suggestedFilename()).toBe('decoded-output.bin'); expect(await downloaded(file)).toEqual(binary);
  await page.locator('#gzip-share').click(); await page.locator('#share-url-btn').click();
  await expect.poll(() => page.evaluate(() => (window as any).__copied)).toContain('#lz:');
  const url = await page.evaluate(() => (window as any).__copied as string);
  const state = JSON.parse(LZString.decompressFromEncodedURIComponent(url.split('#lz:')[1])!);
  expect(JSON.stringify(state)).not.toContain('private-account'); expect(state.d.input).toBe(gzipSync(binary).toString('base64'));
  await page.goto(url); await expect(page.locator('#gzip-status')).toContainText('original bytes');
  await page.locator('#gzip-file').setInputFiles({ name: 'source.txt', mimeType: 'text/plain', buffer: Buffer.from('local text ☕') });
  await expect(page.locator('#input')).toHaveValue('local text ☕'); await page.locator('#compress-btn').click(); await expect(page.locator('#gzip-status')).toContainText('Compressed locally');
  expect(uploads).toEqual([]);
});

test('new settings round-trip in shares and legacy share fixtures remain valid', async ({ page }) => {
  const source = 'settings ☕'; const hex = gzipSync(Buffer.from(source)).toString('hex');
  await page.goto('/gzip-base64/'); await page.locator('#input').fill(hex); await page.locator('#gzip-encoding').selectOption('hex'); await page.locator('#gzip-level').selectOption('1');
  await page.locator('#decompress-btn').click(); await expect(page.locator('#output')).toHaveValue(source);
  await page.locator('#gzip-share').click(); await expect(page.locator('#share-modal')).toBeVisible(); await page.locator('#share-url-btn').click();
  await expect.poll(() => page.evaluate(() => (window as any).__copied)).toContain('#lz:');
  const url = await page.evaluate(() => (window as any).__copied as string); await page.goto(url);
  await expect(page.locator('#output')).toHaveValue(source); await expect(page.locator('#gzip-encoding')).toHaveValue('hex'); await expect(page.locator('#gzip-level')).toHaveValue('1');
  const old = { v: 1, t: 'gzip-base64', a: 'compress', d: { input: 'old link ☕' } };
  await page.goto(`/gzip-base64/#lz:${LZString.compressToEncodedURIComponent(JSON.stringify(old))}`);
  await expect(page.locator('#gzip-status')).toContainText('Compressed locally'); expect(gunzipSync(Buffer.from(await page.locator('#output').inputValue(), 'base64')).toString()).toBe('old link ☕');
});

test('invalid shared input, wrong local files and drop errors fail clearly without a partial result', async ({ page }) => {
  const bad = { v: 1, t: 'gzip-base64', a: 'compress', d: { input: { unexpected: 'object' } } };
  await page.goto(`/gzip-base64/#lz:${LZString.compressToEncodedURIComponent(JSON.stringify(bad))}`);
  await expect(page.locator('#gzip-error')).toContainText('shared input is invalid'); await expect(page.locator('#output')).toHaveValue(''); await expect(page.locator('#gzip-download')).toBeDisabled();
  await page.locator('#gzip-file').setInputFiles({ name: 'wrong.gz', mimeType: 'application/gzip', buffer: Buffer.from('not gzip') });
  await expect(page.locator('#gzip-error')).toContainText('GZip header');
  await page.locator('#gzip-file').setInputFiles({ name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from([255, 254, 255]) });
  await expect(page.locator('#gzip-error')).toContainText('neither');
  const encoded = gzipSync(Buffer.from('dropped file')).toString('base64');
  await page.locator('#gzip-input-panel').evaluate((node, value) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(atob(value), c => c.charCodeAt(0))], 'drop.gz'));
    node.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
  }, encoded);
  await expect(page.locator('#output')).toHaveValue('dropped file');
});

test('auto-run uses the last operation, empty input is valid compression, and large text scrolls', async ({ page }) => {
  await page.goto('/gzip-base64/'); await page.locator('#compress-btn').click(); await expect(page.locator('#stats')).toContainText('Empty input');
  expect(gunzipSync(Buffer.from(await page.locator('#output').inputValue(), 'base64')).length).toBe(0);
  await page.locator('#gzip-auto').check(); await page.locator('#input').fill('automatic ☕'); await expect(page.locator('#gzip-status')).toContainText('Compressed locally');
  await page.locator('#gzip-auto').uncheck();
  const large = randomBytes(160_000).toString('base64').match(/.{1,100}/g)!.join('\n');
  await page.locator('#input').fill(large); await page.locator('#compress-btn').click(); await expect(page.locator('#gzip-status')).toContainText('Compressed locally');
  const encoded = await page.locator('#output').inputValue(); expect(gunzipSync(Buffer.from(encoded, 'base64')).toString()).toBe(large);
  await page.locator('#input').evaluate((node: HTMLTextAreaElement) => { node.scrollTop = node.scrollHeight; node.scrollLeft = node.scrollWidth; });
  expect(await page.locator('#input').evaluate((node: HTMLTextAreaElement) => node.scrollTop)).toBeGreaterThan(1000);
});

test('expansion limit rejects bombs, unsafe markup stays text and formatter handoff preserves raw JSON', async ({ page }) => {
  await page.goto('/gzip-base64/'); const bomb = gzipSync(Buffer.alloc(8 * 1024 * 1024 + 1, 65));
  await page.locator('#input').fill(bomb.toString('base64')); await page.locator('#decompress-btn').click(); await expect(page.locator('#gzip-error')).toContainText('exceeded 8 MiB');
  await expect(page.locator('#gzip-download')).toBeDisabled();
  const json = '{ "id":9007199254740993, "x":1, "x":2, "html":"<img src=x onerror=alert(1)>" }';
  await page.locator('#input').fill(payload(json)); await page.locator('#decompress-btn').click(); await expect(page.locator('#output')).toHaveValue(json);
  expect(await page.locator('#gzip-workspace img').count()).toBe(0); await page.locator('#gzip-next').click();
  await expect(page).toHaveURL(/\/json-formatter\/#lz:/); await expect(page.locator('#editor')).toHaveValue(json);
});

test('cancel and timeout restore controls and a new worker can recover', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__realWorker = window.Worker;
    (window as any).Worker = class { onmessage = null; onerror = null; postMessage() {} terminate() {} };
  });
  await page.goto('/gzip-base64/'); await page.locator('#input').fill(payload('recovery'));
  await page.locator('#decompress-btn').click(); await page.locator('#gzip-cancel').click(); await expect(page.locator('#gzip-status')).toContainText('cancelled');
  await expect(page.locator('#decompress-btn')).toBeEnabled(); await page.locator('#decompress-btn').click();
  await expect(page.locator('#gzip-error')).toContainText('Stopped after 8 seconds', { timeout: 10_000 }); await expect(page.locator('#decompress-btn')).toBeEnabled();
  await page.evaluate(() => { (window as any).Worker = (window as any).__realWorker; }); await page.locator('#decompress-btn').click(); await expect(page.locator('#output')).toHaveValue('recovery');
});

test('FAQ matches structured data and guides explain the shipped file and error workflows', async ({ page }) => {
  await page.goto('/gzip-base64/'); const schemas = await page.locator('script[type="application/ld+json"]').evaluateAll(nodes => nodes.flatMap(node => JSON.parse(node.textContent!)));
  const faq = schemas.find(schema => schema['@type'] === 'FAQPage'); expect(faq.mainEntity).toHaveLength(7);
  const visible = page.locator('details'); await expect(visible).toHaveCount(7);
  for (let i = 0; i < 7; i++) { await expect(visible.nth(i).locator('summary')).toHaveText(faq.mainEntity[i].name); await expect(visible.nth(i).locator('p')).toHaveText(faq.mainEntity[i].acceptedAnswer.text); }
  await page.goto('/guides/decode-base64-gzip-to-json/'); await expect(page.locator('.guide-body')).toContainText('Open a .gz file');
  await page.goto('/guides/fix-base64-gzip-decode-errors/'); await expect(page.locator('.guide-body')).toContainText('8 MiB');
});
