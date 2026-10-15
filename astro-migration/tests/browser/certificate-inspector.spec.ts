import { test, expect, type Page } from '@playwright/test';
import LZString from 'lz-string';
import { readFile } from 'node:fs/promises';
import { certificateFixture } from '../fixtures/certificate-chain.mjs';

const fixture = await certificateFixture();
const pem = fixture.leaf.toString('pem');
const chain = fixture.chain.map(item => item.toString('pem')).join('\n');
const livePayload = { host: 'example.test', port: 443, serverName: 'example.test', peerAddress: '127.0.0.1:443', validation: { trusted: false, error: 'Synthetic test CA is not trusted.' }, certificates: fixture.chain.map((item, position) => ({ position, derBase64: item.toString('base64') })), connectedAt: Date.now(), elapsedMs: 5 };

test.beforeEach(async ({ page }) => {
  await page.route('https://**/*', route => route.abort());
  await page.addInitScript(() => {
    localStorage.setItem('cookie-notice-dismissed', 'true');
    localStorage.removeItem('bd-share-method');
    (window as any).__copied = ''; (window as any).__events = []; (window as any).__errors = [];
    (window as any).gtag = (...args: unknown[]) => (window as any).__events.push(args);
    window.addEventListener('error', event => (window as any).__errors.push(event.message));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { (window as any).__copied = value; } } });
  });
});
test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => (window as any).__errors || [])).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});
async function inspect(page: Page, value = chain) {
  await page.locator('#certificate-input').fill(value);
  await page.locator('#inspect-btn').click();
  await expect(page.locator('#results')).toBeVisible();
}
async function share(page: Page) {
  await page.locator('#share-certificate-report').click();
  await page.locator('#share-url-btn').click();
  await expect.poll(() => page.evaluate(() => (window as any).__copied)).toContain('#lz:');
  return page.evaluate(() => (window as any).__copied as string);
}
test('file chains show every expiry and verify supplied signatures without claiming trust', async ({ page }) => {
  await page.goto('/certificate-inspector/'); await inspect(page);
  await expect(page.locator('#chain-overview > button')).toHaveCount(3);
  await expect(page.locator('#chain-overview')).toContainText('Signature verified with certificate 2');
  await expect(page.locator('#chain-overview')).toContainText('Self-signature verified · not a trust decision');
  await expect(page.locator('#live-tls-summary')).toBeHidden();
  await page.locator('#certificate-identity').fill('api.example.test');
  await expect(page.locator('#identity-result')).toContainText('matches SAN *.example.test');
  await page.locator('#certificate-identity').fill('deep.api.example.test');
  await expect(page.locator('#identity-result')).toContainText('Name mismatch');
  await page.locator('#certificate-identity').fill('[2001:db8::1]');
  await expect(page.locator('#identity-result')).toContainText('matches SAN');
  await page.locator('#certificate-list button').nth(1).click();
  await expect(page.locator('#certificate-heading')).toHaveText('Example Test Intermediate');
  await expect(page.locator('#identity-result')).toContainText('Name mismatch');
  for (const dark of [false, true]) {
    await page.evaluate(value => document.documentElement.classList.toggle('dark', value), dark);
    await expect(page.locator('#share-certificate-report')).toHaveCSS('color', 'rgb(255, 255, 255)');
    expect(await page.locator('#certificate-input').evaluate(node => node.getBoundingClientRect().height)).toBeLessThanOrEqual(160);
  }
});
test('DER files and PEM / P7B conversion downloads round trip, report formats contain the entire chain', async ({ page }) => {
  await page.goto('/certificate-inspector/');
  await page.locator('#certificate-file').setInputFiles({ name: 'synthetic.cer', mimeType: 'application/pkix-cert', buffer: Buffer.from(fixture.leaf.rawData) });
  await expect(page.locator('#results')).toBeVisible();
  await expect(page.locator('#source-summary')).toContainText('DER / CER');
  await page.locator('#copy-pem').click();
  await expect.poll(() => page.evaluate(() => (window as any).__copied)).toBe(pem);
  await inspect(page);
  for (const [id, suffix] of [['download-chain', '.pem'], ['download-p7b', '.p7b'], ['live-csv', '.csv'], ['live-xlsx', '.xlsx'], ['live-json', '.json']]) {
    const pending = page.waitForEvent('download'); await page.locator('#' + id).click(); const downloaded = await pending;
    expect(downloaded.suggestedFilename()).toContain(suffix);
    const bytes = await readFile((await downloaded.path())!);
    if (id === 'live-csv') { expect(bytes.toString()).toContain('Example Test Root'); expect(bytes.toString()).toContain('verified'); }
    if (id === 'live-json') expect(JSON.parse(bytes.toString()).certificates).toHaveLength(3);
    if (id === 'live-xlsx') expect(bytes.subarray(0, 2).toString()).toBe('PK');
    if (id === 'download-p7b') { await page.locator('#certificate-file').setInputFiles({ name: 'bundle.p7b', mimeType: 'application/pkcs7-mime', buffer: bytes }); await expect(page.locator('#certificate-list button')).toHaveCount(3); }
  }
});
test('sharing restores selected certificate and SAN settings, stripping unrelated pasted text', async ({ page }) => {
  let bridgeRequests = 0; await page.route('http://127.0.0.1:2345/**', route => { bridgeRequests++; return route.abort(); });
  await page.goto('/certificate-inspector/'); await inspect(page, 'Ignore this unrelated synthetic note\n' + chain);
  await page.locator('#certificate-identity').fill('example.test');
  await page.locator('#certificate-list button').nth(1).click();
  const link = await share(page);
  const state = JSON.parse(LZString.decompressFromEncodedURIComponent(link.split('#lz:')[1])!);
  expect(state.d.certificate).not.toContain('unrelated synthetic');
  expect(state.d.identity).toBe('example.test'); expect(state.d.selectedIndex).toBe(1);
  await page.goto('/about/'); await page.goto(link);
  await expect(page.locator('#certificate-heading')).toHaveText('Example Test Intermediate');
  await expect(page.locator('#identity-result')).toContainText('Name mismatch');
  expect(bridgeRequests).toBe(0);
  expect(JSON.stringify(await page.evaluate(() => (window as any).__events))).not.toMatch(/Example Test|example\.test|BEGIN CERTIFICATE|unrelated synthetic/);
});
test('invalid URL or credential-like identity input is excluded from shared state', async ({ page }) => {
  await page.goto('/certificate-inspector/'); await inspect(page, pem);
  await page.locator('#certificate-identity').fill('https://synthetic-user:synthetic-password@example.test/');
  await expect(page.locator('#identity-result')).toContainText('not a URL');
  const link = await share(page);
  const state = JSON.parse(LZString.decompressFromEncodedURIComponent(link.split('#lz:')[1])!);
  expect(state.d.identity).toBe('');
  expect(JSON.stringify(state)).not.toContain('synthetic-password');
});
test('private-key and invalid input cannot be shared as raw pasted material', async ({ page }) => {
  await page.goto('/certificate-inspector/');
  await page.locator('#certificate-input').fill(pem + '\n-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic-test-only\n-----END OPENSSH PRIVATE KEY-----');
  await page.locator('#inspect-btn').click(); await expect(page.locator('#error-box')).toContainText('public certificate');
  await expect(page.locator('#results')).toBeHidden();
  await page.locator('#share-btn-floating').click();
  await expect(page.locator('#share-modal')).toBeHidden();
  expect(await page.evaluate(() => (window as any).__copied)).toBe('');
  await page.locator('#sample-btn').click(); await expect(page.locator('#results')).toBeVisible();
  await page.locator('#certificate-input').fill('not a certificate');
  await expect(page.locator('#results')).toBeHidden();
  await expect(page.locator('#error-box')).toBeVisible();
});
test('rapid changes and clear never restore a stale certificate report', async ({ page }) => {
  await page.goto('/certificate-inspector/');
  await page.locator('#certificate-input').fill(chain); await page.locator('#inspect-btn').click();
  await page.locator('#clear-btn').click();
  await expect(page.locator('#results')).toBeHidden(); await expect(page.locator('#certificate-input')).toHaveValue('');
  await page.locator('#certificate-input').fill(pem); await page.locator('#inspect-btn').click();
  await page.locator('#certificate-input').fill('invalid'); await page.locator('#inspect-btn').click();
  await expect(page.locator('#error-box')).toBeVisible(); await expect(page.locator('#results')).toBeHidden();
});
test('legacy certificate-only share links still restore and guide examples are runnable', async ({ page }) => {
  const link = '/certificate-inspector/#lz:' + LZString.compressToEncodedURIComponent(JSON.stringify({ v: 1, t: 'certificate-inspector', a: 'inspect', d: { certificate: pem } }));
  await page.goto(link); await expect(page.locator('#certificate-heading')).toHaveText('example.test');
  await page.goto('/guides/pem-vs-der-vs-cer-vs-p7b-certificate-formats/');
  await page.locator('.guide-body a.bg-indigo-600').click();
  await expect(page.locator('#results')).toBeVisible(); await expect(page.locator('#identity-result')).toContainText('matches SAN api.example.test');
  await expect(page.locator('#certificate-list button')).toHaveCount(1);
});
test('older or unavailable bridges give an update/start message and can retry', async ({ page }) => {
  let available = false;
  await page.route('http://127.0.0.1:2345/api/v1/capabilities', route => route.fulfill({ json: { version: '0.2.0', capabilities: { tlsInspection: available } } }));
  await page.route('http://127.0.0.1:2345/api/v1/tls/inspect', route => route.fulfill({ json: livePayload }));
  await page.goto('/certificate-inspector/'); await page.locator('#tls-inspect-btn').click();
  await page.locator('#bridge-access-continue').click(); await expect(page.locator('#tls-error-box')).toContainText('Update it and retry');
  available = true; await page.locator('#tls-inspect-btn').click(); await expect(page.locator('#live-tls-summary')).toBeVisible();
});
test('cancelling a live inspection prevents a late response replacing file results', async ({ page }) => {
  await page.route('http://127.0.0.1:2345/api/v1/capabilities', route => route.fulfill({ json: { version: '0.3.0', capabilities: { tlsInspection: true } } }));
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('http://127.0.0.1:2345/api/v1/tls/inspect', async route => { await gate; await route.fulfill({ json: livePayload }).catch(() => {}); });
  await page.goto('/certificate-inspector/'); await page.locator('#tls-inspect-btn').click(); await page.locator('#bridge-access-continue').click();
  await expect(page.locator('#tls-cancel')).toBeVisible(); await page.locator('#tls-cancel').click();
  await page.locator('#sample-btn').click(); release();
  await expect(page.locator('#certificate-list button')).toHaveCount(1); await expect(page.locator('#live-tls-summary')).toBeHidden();
});
test('print view hides editable inputs and sharing controls while retaining the report', async ({ page }) => {
  await page.goto('/certificate-inspector/'); await inspect(page);
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#certificate-input')).toBeHidden(); await expect(page.locator('#share-certificate-report')).toBeHidden();
  await expect(page.locator('#chain-overview')).toBeVisible();
});
