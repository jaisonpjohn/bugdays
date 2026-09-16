import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import LZString from 'lz-string';

const certificateSource = await readFile(new URL('../../src/pages/certificate-inspector.astro', import.meta.url), 'utf8');
const samplePem = certificateSource.match(/const sampleCertificate = `([\s\S]*?)`;/)?.[1] || '';
const sampleDerBase64 = samplePem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');

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
  expect(await page.evaluate(() => (window as any).__errors || [])).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

async function copyShareUrl(page: import('@playwright/test').Page, trigger: import('@playwright/test').Locator): Promise<string> {
  await trigger.click();
  await expect(page.locator('#share-modal')).toBeVisible();
  await page.locator('#share-url-btn').click();
  await expect.poll(() => page.evaluate(() => (window as any).__copied)).toContain('#lz:');
  return page.evaluate(() => (window as any).__copied);
}

test('public PTR lookup forward-confirms the hostname and shares a restorable snapshot', async ({ page }) => {
  await page.route('https://cloudflare-dns.com/dns-query?*', route => {
    const url = new URL(route.request().url());
    const type = url.searchParams.get('type');
    if (type === 'PTR') return route.fulfill({ json: { Status: 0, Answer: [{ name: url.searchParams.get('name'), type: 12, TTL: 300, data: 'dns.google.' }] } });
    if (type === 'A') return route.fulfill({ json: { Status: 0, Answer: [{ name: 'dns.google.', type: 1, TTL: 60, data: '8.8.8.8' }] } });
    return route.fulfill({ json: { Status: 0 } });
  });
  await page.goto('/dns-lookup/');
  await page.locator('input[name="dns-mode"][value="public"]').check();
  await page.locator('#dns-target').fill('8.8.8.8');
  await page.locator('#dns-run').click();
  await expect(page.locator('#dns-report')).toBeVisible();
  await expect(page.locator('#dns-source-cards')).toContainText('dns.google');
  await expect(page.locator('#dns-source-cards')).toContainText('Forward-confirmed');
  const download = page.waitForEvent('download');
  await page.locator('#dns-csv').click();
  expect((await download).suggestedFilename()).toBe('dns-8.8.8.8.csv');
  const shared = await copyShareUrl(page, page.getByRole('button', { name: 'Share DNS report' }));
  const state = JSON.parse(LZString.decompressFromEncodedURIComponent(shared.split('#lz:')[1])!);
  expect(state.d.report.sources[0].forwardConfirmed).toBe(true);
  await page.goto('/about/');
  await page.goto(shared);
  await expect(page.locator('#dns-report')).toBeVisible();
  await expect(page.locator('#dns-notice')).toContainText('Shared DNS snapshot restored');
});

test('device DNS uses the bridge and renders private and reverse answers safely', async ({ page }) => {
  await page.route('http://127.0.0.1:2345/api/v1/capabilities', route => route.fulfill({ json: { version: '0.3.0', capabilities: { dnsLookup: true, tlsInspection: true } } }));
  await page.route('http://127.0.0.1:2345/api/v1/dns/query', route => route.fulfill({ json: {
    query: 'orders.internal', resolver: 'system', reverseLookup: false, elapsedMs: 4, forwardConfirmed: null, forwardAddresses: [],
    results: [{ recordType: 'A', status: 'NOERROR', elapsedMs: 3, answers: [{ name: 'orders.internal.', type: 'A', ttl: 30, data: '10.20.4.8' }] }],
  } }));
  await page.goto('/dns-lookup/');
  await page.locator('input[name="dns-mode"][value="system"]').check();
  await page.locator('#dns-target').fill('orders.internal');
  await page.locator('#dns-run').click();
  await expect(page.locator('#bridge-access-dialog')).toBeVisible();
  await page.locator('#bridge-access-continue').click();
  await expect(page.locator('#dns-report')).toBeVisible();
  await expect(page.locator('#dns-rows')).toContainText('10.20.4.8');
  await expect(page.locator('#dns-source-cards')).toContainText('System resolver');
});

test('live TLS inspection analyzes a server chain on a Kafka port and restores its share', async ({ page }) => {
  await page.route('http://127.0.0.1:2345/api/v1/capabilities', route => route.fulfill({ json: { version: '0.3.0', capabilities: { dnsLookup: true, tlsInspection: true } } }));
  await page.route('http://127.0.0.1:2345/api/v1/tls/inspect', route => route.fulfill({ json: {
    host: '10.20.4.8', port: 9093, serverName: 'example.test', peerAddress: '10.20.4.8:9093', tlsVersion: 'TLSv1_3', cipherSuite: 'TLS13_AES_256_GCM_SHA384', alpn: null,
    validation: { trusted: false, error: 'The certificate chain is not trusted by this device.' },
    certificates: [{ position: 0, derBase64: sampleDerBase64 }], connectedAt: Date.now(), elapsedMs: 18,
  } }));
  await page.goto('/certificate-inspector/');
  await page.locator('#tls-host').fill('10.20.4.8');
  await page.locator('#tls-port').fill('9093');
  await page.locator('#tls-server-name').fill('example.test');
  await page.locator('#tls-inspect-btn').click();
  await expect(page.locator('#bridge-access-dialog')).toBeVisible();
  await page.locator('#bridge-access-continue').click();
  await expect(page.locator('#live-tls-summary')).toBeVisible();
  await expect(page.locator('#live-endpoint')).toHaveText('10.20.4.8:9093');
  await expect(page.locator('#live-status-grid')).toContainText('Name match');
  await expect(page.locator('#live-status-grid')).toContainText('Pass');
  await expect(page.locator('#certificate-list button')).toHaveCount(1);
  const shared = await copyShareUrl(page, page.getByRole('button', { name: 'Share certificate report' }));
  await page.goto(shared);
  await expect(page.locator('#live-tls-summary')).toBeVisible();
  await expect(page.locator('#live-endpoint')).toHaveText('10.20.4.8:9093');
});

test('new DNS and TLS guides are crawlable and internally linked', async ({ page, request }) => {
  for (const slug of ['dns-lookup-public-vs-system-resolver', 'check-tls-certificate-chain-any-port']) {
    await page.goto(`/guides/${slug}/`);
    await expect(page.locator('.guide-article h1')).toBeVisible();
    expect(await page.locator('.guide-body h2').count()).toBeGreaterThanOrEqual(5);
    expect((await page.locator('.guide-body').innerText()).split(/\s+/).length).toBeGreaterThan(650);
  }
  await page.goto('/network-tools/');
  await expect(page.locator('a[href="/dns-lookup"]').first()).toBeVisible();
  const rss = await (await request.get('/guides/rss.xml')).text();
  expect(rss).toContain('/guides/dns-lookup-public-vs-system-resolver/');
});
