import { test, expect } from '@playwright/test';
import LZString from 'lz-string';
import { readFile } from 'node:fs/promises';

test.beforeEach(async ({ page }) => {
  await page.route('https://**/*', route => route.abort());
  await page.addInitScript(() => {
    localStorage.setItem('cookie-notice-dismissed', 'true');
    localStorage.removeItem('bd-share-method');
    (window as any).__copied = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { (window as any).__copied = text; },
      readText: async () => (window as any).__copied,
    } });
  });
  await page.route('http://127.0.0.1:2345/api/v1/capabilities', route => route.fulfill({ json: { version: '0.4.0', capabilities: { kafkaApiVersion: 1 } } }));
});

test('Kafka pages and worked guides are crawlable and internally linked', async ({ page }) => {
  for (const path of ['/kafka-client/', '/kafka-diagnostics/']) {
    await page.goto(path);
    await expect(page.locator('h1')).toContainText('Kafka');
    expect(await page.locator('meta[name="description"]').getAttribute('content')).toMatch(/Kafka/i);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `https://bugdays.com${path}`);
    await expect(page.locator('a[href^="/guides/"]')).not.toHaveCount(0);
  }
  for (const slug of ['browse-kafka-messages-by-offset-time', 'diagnose-kafka-consumer-lag-stuck-partition', 'replay-kafka-messages-between-topics']) {
    await page.goto(`/guides/${slug}/`);
    await expect(page.locator('h1')).toContainText('Kafka');
    await expect(page.getByRole('link', { name: 'Open the tool →' })).toBeVisible();
  }
  const feed = await page.request.get('/guides/rss.xml');
  expect(feed.ok()).toBeTruthy();
  expect(await feed.text()).toContain('/guides/browse-kafka-messages-by-offset-time/');
});

test('message sample is usable and shared link omits content by default', async ({ page }) => {
  await page.goto('/kafka-client/');
  await page.getByRole('button', { name: 'Try sample' }).click();
  await expect(page.locator('#k-records tr')).toHaveCount(2);
  await expect(page.getByText('order-1028', { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Inspect ↗' }).first().click();
  await expect(page.locator('#k-record-detail')).toContainText('9309');
  await page.getByRole('button', { name: 'Share report' }).click();
  await expect(page.locator('#share-modal')).toBeVisible();
  await page.getByRole('button', { name: 'Link with data embedded' }).click();
  const url = await page.evaluate(() => navigator.clipboard.readText());
  const state = JSON.parse(LZString.decompressFromEncodedURIComponent(url.split('#lz:')[1])!);
  expect(state.d.rows[0].valueBase64).toBeNull();
  expect(JSON.stringify(state)).not.toContain('broker1.example.com');
  await page.goto(url);
  await page.reload();
  await expect(page.locator('#k-records tr')).toHaveCount(2);
  await expect(page.getByText('Content hidden').first()).toBeVisible();
});

test('live Kafka browse and replay send exact ranges through the bridge', async ({ page }) => {
  const calls: Array<{ path: string; body: any }> = [];
  await page.route('http://127.0.0.1:2345/api/v1/kafka/**', async route => {
    const path = new URL(route.request().url()).pathname.split('/').at(-1)!;
    const body = route.request().postDataJSON(); calls.push({ path, body });
    const json = path === 'connect' ? { token: 'session-1', overview: { brokers: 1, topics: 1 } }
      : path === 'metadata' ? { topics: [{ name: 'orders.events', partitions: 1 }], brokers: [] }
      : path === 'topic' ? { topic: 'orders.events', partitions: [{ partition: 2, earliest: '9300', latest: '9320', leader: 1, replicas: [1], isr: [1] }] }
      : path === 'browse' ? { records: [{ topic: 'orders.events', partition: 2, offset: '9310', timestampMs: 1000, keyBase64: btoa('order-1'), valueBase64: btoa('{"status":"paid"}'), headers: [] }], nextOffset: '9311', earliest: '9300', latest: '9320', endExclusive: '9311', hasMore: false }
      : path === 'replay' ? { sent: 1, nextOffset: '9311', hasMore: false, deliveries: [{ sourceOffset: '9310', partition: 2, offset: '100' }] }
      : {};
    await route.fulfill({ json });
  });
  await page.goto('/kafka-client/');
  await page.locator('#k-brokers').fill('127.0.0.1:9092');
  await page.getByRole('button', { name: 'Connect cluster' }).click();
  await expect(page.locator('#k-connection-badge')).toHaveText('Connected');
  await page.locator('#k-topic').selectOption('orders.events');
  await page.locator('#k-read-mode').selectOption('offset');
  await page.locator('#k-start').fill('9310');
  await page.locator('#k-read-end').fill('9311');
  await page.getByRole('button', { name: 'Read messages' }).click();
  await expect(page.locator('#k-records tr')).toHaveCount(1);
  await page.locator('#k-replay-topic').fill('orders.retry');
  await page.locator('#k-replay-start').fill('9310');
  await page.locator('#k-replay-end').fill('9311');
  await page.getByRole('button', { name: 'Replay selected range' }).click();
  await expect(page.locator('#k-message')).toContainText('1 message delivered');
  expect(calls.find(call => call.path === 'browse')?.body).toMatchObject({ partition: 2, offset: '9310', endExclusive: '9311' });
  expect(calls.find(call => call.path === 'replay')?.body).toMatchObject({ sourceTopic: 'orders.events', destinationTopic: 'orders.retry', partition: 2, offset: '9310', endExclusive: '9311' });

  await page.getByRole('button', { name: 'Inspect ↗' }).click();
  await page.getByText('Edit this record for replay').click();
  const edit = page.locator('#k-record-detail details');
  await edit.locator('input[type="checkbox"]').first().check();
  await edit.locator('textarea').nth(1).fill('');
  await edit.locator('textarea').nth(2).fill('[{"key":"x-test","valueBase64":""},{"key":"x-test","valueBase64":null}]');
  await page.getByRole('button', { name: 'Use edited record for replay' }).click();
  await page.getByRole('button', { name: 'Replay selected range' }).click();
  await expect(page.locator('#k-message')).toContainText('1 message delivered');
  const edited = calls.filter(call => call.path === 'replay').at(-1)!.body.edit;
  expect(edited).toMatchObject({ keyBase64: null, valueBase64: '', headers: [{ key: 'x-test', valueBase64: '' }, { key: 'x-test', valueBase64: null }] });
});

test('all-partition export saves every retained message as JSONL', async ({ page }) => {
  const browsed: number[] = [];
  await page.addInitScript(() => { Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined }); });
  await page.route('http://127.0.0.1:2345/api/v1/kafka/**', async route => {
    const path = new URL(route.request().url()).pathname.split('/').at(-1)!;
    const body = route.request().postDataJSON();
    const json = path === 'connect' ? { token: 'session-1', overview: { brokers: 1, topics: 1 } }
      : path === 'metadata' ? { topics: [{ name: 'orders.events', partitions: 2 }] }
      : path === 'topic' ? { topic: 'orders.events', partitions: [0, 1].map(partition => ({ partition, earliest: '0', latest: '1', leader: 1, replicas: [1], isr: [1] })) }
      : path === 'browse' ? (() => { browsed.push(body.partition); return { records: [{ topic: 'orders.events', partition: body.partition, offset: '0', timestampMs: 1000, keyBase64: null, valueBase64: btoa(`record-${body.partition}`), headers: [] }], nextOffset: '1', earliest: '0', latest: '1', endExclusive: '1', hasMore: false }; })()
      : {};
    await route.fulfill({ json });
  });
  await page.goto('/kafka-client/');
  await page.locator('#k-brokers').fill('127.0.0.1:9092');
  await page.getByRole('button', { name: 'Connect cluster' }).click();
  await page.locator('#k-topic').selectOption('orders.events');
  await page.locator('#k-export-all-partitions').check();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export retained · JSONL' }).click()]);
  const rows = (await readFile(await download.path(), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(browsed).toEqual([0, 1]);
  expect(rows.map(row => row.partition)).toEqual([0, 1]);
  await expect(page.locator('#k-message')).toContainText('2 partitions');
});

test('replay to another cluster uses a separate short-lived bridge session', async ({ page }) => {
  const calls: Array<{ path: string; body: any }> = [];
  await page.route('http://127.0.0.1:2345/api/v1/kafka/**', async route => {
    const path = new URL(route.request().url()).pathname.split('/').at(-1)!;
    const body = route.request().postDataJSON(); calls.push({ path, body });
    const json = path === 'connect' ? { token: body.brokers === 'destination:9092' ? 'destination-token' : 'source-token', overview: { brokers: 1, topics: 1 } }
      : path === 'metadata' ? { topics: [{ name: 'orders.events', partitions: 1 }] }
      : path === 'topic' ? { topic: 'orders.events', partitions: [{ partition: 0, earliest: '0', latest: '2', leader: 1, replicas: [1], isr: [1] }] }
      : path === 'replay' ? { sent: 1, nextOffset: '1', hasMore: false, deliveries: [{ sourceOffset: '0', partition: 0, offset: '0' }] }
      : {};
    await route.fulfill({ json });
  });
  await page.goto('/kafka-client/');
  await page.locator('#k-brokers').fill('source:9092');
  await page.getByRole('button', { name: 'Connect cluster' }).click();
  await page.locator('#k-topic').selectOption('orders.events');
  await page.locator('#k-replay-destination').selectOption('other');
  await page.locator('#k-other-brokers').fill('destination:9092');
  await page.locator('#k-other-security').selectOption('SSL');
  await page.locator('#k-other-key-password').fill('test-only-key-password');
  await page.locator('#k-replay-topic').fill('orders.retry');
  await page.locator('#k-replay-start').fill('0');
  await page.locator('#k-replay-end').fill('1');
  await page.getByRole('button', { name: 'Replay selected range' }).click();
  await expect(page.locator('#k-message')).toContainText('1 message delivered');
  expect(calls.find(call => call.path === 'replay')?.body).toMatchObject({ sourceToken: 'source-token', destinationToken: 'destination-token' });
  expect(calls.find(call => call.path === 'connect' && call.body.brokers === 'destination:9092')?.body).toMatchObject({ securityProtocol: 'SSL', keyPassword: 'test-only-key-password' });
  await expect(page.locator('#k-other-key-password')).toBeEmpty();
  await expect.poll(() => calls.some(call => call.path === 'disconnect' && call.body.token === 'destination-token')).toBeTruthy();
});

test('diagnostic sample surfaces evidence and live offset change requires a preview', async ({ page }) => {
  await page.route('http://127.0.0.1:2345/api/v1/kafka/**', async route => {
    const path = new URL(route.request().url()).pathname.split('/').at(-1)!;
    const json = path === 'connect' ? { token: 'session-1', overview: { brokers: 1, topics: 1 } }
      : path === 'metadata' ? { topics: [{ name: 'orders.events', partitions: 1 }] }
      : path === 'groups' ? { groups: [{ name: 'checkout-workers', state: 'Empty', members: 0 }] }
      : path === 'topic' ? { topic: 'orders.events', partitions: [{ partition: 0, earliest: '0', latest: '10', leader: 1, replicas: [1], isr: [1] }] }
      : path === 'group' ? { group: 'checkout-workers', topic: 'orders.events', state: 'Empty', sampledAt: Date.now(), members: [], partitions: [{ partition: 0, committed: '4', earliest: '0', latest: '10', lag: '6', leader: 1, replicas: [1], isr: [1], owner: null }] }
      : path === 'reset-preview' ? { planId: 'plan-1', expiresInSeconds: 300, partitions: [{ partition: 0, current: '4', target: '10', earliest: '0', latest: '10' }] }
      : path === 'reset-apply' ? { group: 'checkout-workers', topic: 'orders.events', partitions: [{ partition: 0, previous: '4', requested: '10', actual: '10', ok: true }] }
      : {};
    await route.fulfill({ json });
  });
  await page.goto('/kafka-diagnostics/');
  await page.getByRole('button', { name: 'Try sample' }).click();
  await expect(page.locator('#k-findings')).toContainText('Unexpected group member');
  await expect(page.locator('#k-findings')).toContainText('Commit stopped while data arrived');
  await page.getByRole('button', { name: 'Share report' }).click();
  await page.getByRole('button', { name: 'Link with data embedded' }).click();
  const url = await page.evaluate(() => navigator.clipboard.readText());
  const shared = JSON.parse(LZString.decompressFromEncodedURIComponent(url.split('#lz:')[1])!);
  expect(JSON.stringify(shared)).not.toContain('10.4.');
  await page.goto(url);
  await page.reload();
  await expect(page.locator('#k-findings')).toContainText('Commit stopped while data arrived');
  await page.locator('#k-brokers').fill('127.0.0.1:9092');
  await page.getByRole('button', { name: 'Connect cluster' }).click();
  await page.locator('#k-topic').selectOption('orders.events');
  await page.locator('#k-group').selectOption('checkout-workers');
  await page.getByRole('button', { name: 'Take snapshot' }).click();
  await expect(page.locator('#k-lag-rows tr')).toHaveCount(1);
  await page.locator('#k-reset-mode').selectOption('to-latest');
  await page.getByRole('button', { name: 'Preview offset change' }).click();
  await expect(page.locator('#k-reset-preview')).toContainText('4 → 10');
  await page.locator('#k-topic').selectOption('');
  await expect(page.locator('#k-apply')).toBeHidden();
  await page.locator('#k-topic').selectOption('orders.events');
  await page.getByRole('button', { name: 'Preview offset change' }).click();
  await page.getByRole('button', { name: 'Apply these offsets' }).click();
  await expect(page.locator('#k-message')).toContainText('applied and verified');
});
