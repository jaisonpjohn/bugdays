import { test, expect } from '@playwright/test';
import LZString from 'lz-string';
const share = (data: Record<string, unknown>) => '/datetime-converter/#lz:' + LZString.compressToEncodedURIComponent(JSON.stringify({ v: 1, t: 'datetime-converter', a: 'convert', d: data }));
test.use({ timezoneId: 'America/Los_Angeles' });
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
test('source defaults to local and target to UTC; absolute instants synchronize every format', async ({ page }) => {
  await page.goto('/datetime-converter/');
  await expect(page.locator('#source-timezone')).toHaveValue('America/Los_Angeles');
  await expect(page.locator('#timezone')).toHaveValue('UTC');
  await page.locator('#unix-ms').fill('1704067200123');
  await page.locator('#timezone').selectOption('Asia/Kolkata');
  await expect(page.locator('#iso8601')).toHaveValue('2024-01-01T05:30:00.123+05:30');
  await expect(page.locator('#datepicker')).toHaveValue('2023-12-31T16:00:00.123');
  await expect(page.locator('#source-iso8601')).toHaveValue('2023-12-31T16:00:00.123-08:00');
  await expect(page.locator('#target-datepicker')).toHaveValue('2024-01-01T05:30:00.123');
  await expect(page.locator('#human')).toHaveValue(/05:30:00.123 GMT\+05:30/);
  await expect(page.locator('#rfc2822')).toHaveValue('Mon, 01 Jan 2024 05:30:00 +0530');
  await expect(page.locator('#unix-sec')).toHaveValue('1704067200.123');
  await expect(page.locator('#unix-ms')).toHaveValue('1704067200123');
  await page.locator('#source-timezone').selectOption('Asia/Kathmandu');
  await expect(page.locator('#source-iso8601')).toHaveValue('2024-01-01T05:45:00.123+05:45');
  await expect(page.locator('#unix-ms')).toHaveValue('1704067200123');
  const before = Date.now(); await page.locator('#now-btn').click(); const ms = Number(await page.locator('#unix-ms').inputValue());
  expect(ms).toBeGreaterThanOrEqual(before - 1000); expect(ms).toBeLessThanOrEqual(Date.now() + 1000);
  expect(Date.parse(await page.locator('#iso8601').inputValue())).toBe(ms);
});
test('source fields stay in the left card, target fields in the right, and epochs stay global', async ({ page }) => {
  await page.goto('/datetime-converter/');
  const global = page.locator('#epoch-values');
  await expect(global).toContainText('Timezone-independent');
  await expect(global.locator('#unix-sec')).toHaveCount(1); await expect(global.locator('#unix-ms')).toHaveCount(1);
  await expect(page.locator('#zoned-times #unix-sec')).toHaveCount(0);
  await expect(page.locator('#zoned-times #unix-ms')).toHaveCount(0);
  for (const id of ['source-timezone', 'datepicker', 'source-iso8601', 'source-human', 'source-rfc2822']) {
    await expect(page.locator('#source-times #' + id)).toHaveCount(1);
    await expect(page.locator('#target-times #' + id)).toHaveCount(0);
  }
  for (const id of ['timezone', 'target-datepicker', 'iso8601', 'human', 'rfc2822']) {
    await expect(page.locator('#target-times #' + id)).toHaveCount(1);
    await expect(page.locator('#source-times #' + id)).toHaveCount(0);
  }
  const left = (await page.locator('#source-times').boundingBox())!, right = (await page.locator('#target-times').boundingBox())!;
  if (page.viewportSize()!.width >= 768) expect(right.x).toBeGreaterThan(left.x + left.width);
  else expect(right.y).toBeGreaterThan(left.y + left.height);
  const distinctCards = async () => expect(await page.evaluate(() => {
    const source = getComputedStyle(document.querySelector('#source-times')!), target = getComputedStyle(document.querySelector('#target-times')!);
    return source.backgroundColor !== target.backgroundColor && parseFloat(source.borderTopWidth) > 0 && parseFloat(target.borderTopWidth) > 0;
  })).toBeTruthy();
  await distinctCards();
  const distinctBackground = async () => expect(await page.evaluate(() => getComputedStyle(document.querySelector('#epoch-values')!).backgroundColor !== getComputedStyle(document.querySelector('#datetime-workspace')!).backgroundColor)).toBeTruthy();
  await distinctBackground();
  await page.locator('#unix-ms').fill('1719837296789');
  await page.locator('#timezone').selectOption('Asia/Kolkata');
  await expect(page.locator('#source-human')).toHaveValue('Monday, July 1, 2024 05:34:56.789 GMT-07:00');
  await expect(page.locator('#human')).toHaveValue('Monday, July 1, 2024 18:04:56.789 GMT+05:30');
  await expect(page.locator('#source-human-hint')).toContainText('America/Los_Angeles');
  await expect(page.locator('#human-hint')).toContainText('Asia/Kolkata');
  await expect(page.locator('#source-rfc2822')).toHaveValue('Mon, 01 Jul 2024 05:34:56 -0700');
  await expect(page.locator('#rfc2822')).toHaveValue('Mon, 01 Jul 2024 18:04:56 +0530');
  await page.locator('[data-copy="source-human"]').click();
  expect(await page.evaluate(() => (window as any).__copied)).toBe('Monday, July 1, 2024 05:34:56.789 GMT-07:00');
  await page.locator('[data-copy="source-rfc2822"]').click();
  expect(await page.evaluate(() => (window as any).__copied)).toBe('Mon, 01 Jul 2024 05:34:56 -0700');
  await page.locator('#swap-zones-btn').click();
  await expect(page.locator('#source-human-hint')).toContainText('Asia/Kolkata');
  await expect(page.locator('#human-hint')).toContainText('America/Los_Angeles');
  await expect(page.locator('#unix-ms')).toHaveValue('1719837296789');
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await distinctBackground(); await distinctCards();
  await page.locator('#unix-ms').fill('bad');
  for (const id of ['source-human', 'source-rfc2822', 'human', 'source-iso8601', 'target-datepicker']) await expect(page.locator('#' + id)).toHaveValue('');
  await expect(page.locator('[data-copy="source-human"]')).toBeDisabled();
  await page.locator('#source-timezone').selectOption('UTC');
  await expect(page.locator('#source-human-hint')).toContainText('UTC');
});
test('source picker and target dates without offsets use their own zones with milliseconds', async ({ page }) => {
  await page.goto('/datetime-converter/'); await page.locator('#source-timezone').selectOption('Asia/Kathmandu');
  await page.locator('#datepicker').fill('2024-01-01T09:00:00.025');
  await expect(page.locator('#unix-ms')).toHaveValue(String(Date.parse('2024-01-01T03:15:00.025Z')));
  await expect(page.locator('#source-iso8601')).toHaveValue('2024-01-01T09:00:00.025+05:45');
  await expect(page.locator('#iso8601')).toHaveValue('2024-01-01T03:15:00.025Z');
  await page.locator('#timezone').selectOption('Asia/Kathmandu');
  await page.locator('#iso8601').fill('2024-07-01T09:00:05.321');
  await expect(page.locator('#datepicker')).toHaveValue('2024-07-01T09:00:05.321');
  await page.locator('#human').fill('January 1, 2024 12:00:00 AM');
  await expect(page.locator('#iso8601')).toHaveValue('2024-01-01T00:00:00.000+05:45');
  await page.locator('#rfc2822').fill('Mon, 01 Jan 2024 05:30:00 +0530');
  await expect(page.locator('#iso8601')).toHaveValue('2024-01-01T05:45:00.000+05:45');
});
test('visible field badges and styling distinguish editable controls from selectable read-only results', async ({ page }) => {
  await page.goto('/datetime-converter/');
  const editable = ['unix-sec', 'unix-ms', 'source-timezone', 'timezone', 'datepicker', 'iso8601', 'human', 'rfc2822'];
  const readonly = ['source-iso8601', 'source-human', 'source-rfc2822', 'target-datepicker'];
  for (const id of editable) {
    await expect(page.locator('#' + id + '-mode')).toHaveText('Editable');
    await expect(page.locator('#' + id + '-mode')).toBeVisible();
    await expect(page.locator('#' + id)).toBeEditable();
    await expect(page.locator('#' + id)).toHaveAttribute('aria-describedby', new RegExp(id + '-mode'));
  }
  for (const id of readonly) {
    await expect(page.locator('#' + id + '-mode')).toHaveText('Read-only');
    await expect(page.locator('#' + id + '-mode')).toBeVisible();
    await expect(page.locator('#' + id)).not.toBeEditable();
    await expect(page.locator('#' + id)).toBeEnabled();
    await expect(page.locator('#' + id)).toHaveAttribute('aria-describedby', new RegExp(id + '-mode'));
  }
  const distinct = async () => expect(await page.evaluate(() => {
    const input = getComputedStyle(document.querySelector('#datepicker')!), output = getComputedStyle(document.querySelector('#source-human')!);
    return input.backgroundColor !== output.backgroundColor && input.borderStyle === 'solid' && output.borderStyle === 'dashed' && output.opacity === '1';
  })).toBeTruthy();
  await distinct();
  await page.locator('#unix-ms').fill('1704067200123');
  await page.locator('#source-human').focus(); await page.locator('#source-human').press('x');
  await expect(page.locator('#source-human')).toHaveValue('Sunday, December 31, 2023 16:00:00.123 GMT-08:00');
  const selected = await page.locator('#source-human').evaluate((node: HTMLInputElement) => {
    node.select(); return node.value.slice(node.selectionStart!, node.selectionEnd!);
  });
  expect(selected).toBe('Sunday, December 31, 2023 16:00:00.123 GMT-08:00');
  await page.locator('[data-copy="source-human"]').click(); expect(await page.evaluate(() => (window as any).__copied)).toBe(selected);
  await page.evaluate(() => document.documentElement.classList.add('dark')); await distinct();
  await page.locator('#source-timezone').selectOption('America/New_York'); await page.locator('#datepicker').fill('2024-11-03T01:30');
  await expect(page.locator('#dst-occurrence-mode')).toBeVisible(); await expect(page.locator('#dst-occurrence-mode')).toHaveText('Editable');
  await page.locator('#dst-occurrence').selectOption('1730615400000'); await expect(page.locator('#unix-ms')).toHaveValue('1730615400000');
});
test('source-zone edits reinterpret entered wall time; target edits and swap preserve the instant', async ({ page }) => {
  await page.goto('/datetime-converter/');
  await page.locator('#source-timezone').selectOption('Asia/Kolkata');
  await page.locator('#datepicker').fill('2024-01-01T09:00:00.123');
  await page.locator('#timezone').selectOption('America/New_York');
  await expect(page.locator('#datepicker')).toHaveValue('2024-01-01T09:00:00.123');
  await expect(page.locator('#target-datepicker')).toHaveValue('2023-12-31T22:30:00.123');
  await expect(page.locator('#iso8601')).toHaveValue('2023-12-31T22:30:00.123-05:00');
  await expect(page.locator('#unix-ms')).toHaveValue('1704079800123');
  await page.locator('#source-timezone').selectOption('Asia/Kathmandu');
  await expect(page.locator('#datepicker')).toHaveValue('2024-01-01T09:00:00.123');
  await expect(page.locator('#iso8601')).toHaveValue('2023-12-31T22:15:00.123-05:00');
  await expect(page.locator('#unix-ms')).toHaveValue('1704078900123');
  await page.locator('#swap-zones-btn').click();
  await expect(page.locator('#source-timezone')).toHaveValue('America/New_York');
  await expect(page.locator('#timezone')).toHaveValue('Asia/Kathmandu');
  await expect(page.locator('#datepicker')).toHaveValue('2023-12-31T22:15:00.123');
  await expect(page.locator('#iso8601')).toHaveValue('2024-01-01T09:00:00.123+05:45');
  await expect(page.locator('#unix-ms')).toHaveValue('1704078900123');
  await page.locator('#source-timezone').selectOption('UTC');
  await expect(page.locator('#unix-ms')).toHaveValue('1704078900123');
  await expect(page.locator('#target-datepicker')).toHaveAttribute('readonly', '');
  await expect(page.locator('#source-iso8601')).toHaveAttribute('readonly', '');
});
test('explicit ISO offsets identify their own instant and normalize to selected zone on commit', async ({ page }) => {
  await page.goto('/datetime-converter/'); await page.locator('#timezone').selectOption('America/New_York');
  await page.locator('#iso8601').fill('2024-07-01T09:00:00.123+05:30');
  await expect(page.locator('#unix-ms')).toHaveValue(String(Date.parse('2024-07-01T03:30:00.123Z')));
  await page.locator('#iso8601').blur();
  await expect(page.locator('#iso8601')).toHaveValue('2024-06-30T23:30:00.123-04:00');
  await expect(page.locator('#target-datepicker')).toHaveValue('2024-06-30T23:30:00.123');
  await expect(page.locator('#datepicker')).toHaveValue('2024-06-30T20:30:00.123');
  await page.locator('#source-timezone').selectOption('UTC');
  await expect(page.locator('#unix-ms')).toHaveValue(String(Date.parse('2024-07-01T03:30:00.123Z')));
});
test('DST gaps clear stale results and overlaps let users select either exact instant', async ({ page }) => {
  await page.goto('/datetime-converter/'); await page.locator('#source-timezone').selectOption('America/New_York');
  await page.locator('#datepicker').fill('2024-03-10T02:30');
  await expect(page.locator('#error-box')).toContainText('does not exist');
  await expect(page.locator('#unix-ms')).toHaveValue(''); await expect(page.locator('#share-time-btn')).toBeDisabled();
  await page.locator('#timezone').selectOption('Asia/Kolkata');
  await expect(page.locator('#error-box')).toContainText('does not exist');
  await expect(page.locator('#datepicker')).toHaveValue('2024-03-10T02:30');
  await expect(page.locator('#target-datepicker')).toHaveValue('');
  await page.locator('#datepicker').fill('2024-11-03T01:30');
  await expect(page.locator('#dst-choice')).toBeVisible();
  await expect(page.locator('#source-iso8601')).toHaveValue('2024-11-03T01:30:00.000-04:00');
  await page.locator('#dst-occurrence').selectOption(String(Date.parse('2024-11-03T06:30:00Z')));
  await expect(page.locator('#source-iso8601')).toHaveValue('2024-11-03T01:30:00.000-05:00');
  await expect(page.locator('#unix-ms')).toHaveValue('1730615400000');
  await page.locator('#timezone').selectOption('UTC');
  await expect(page.locator('#iso8601')).toHaveValue('2024-11-03T06:30:00.000Z');
  await expect(page.locator('#dst-choice')).toBeVisible();
  await expect(page.locator('#dst-occurrence')).toHaveValue('1730615400000');
});
test('a source DST gap can be corrected by changing the source zone, not the target', async ({ page }) => {
  await page.goto('/datetime-converter/'); await page.locator('#source-timezone').selectOption('America/New_York');
  await page.locator('#datepicker').fill('2024-03-10T02:30');
  await expect(page.locator('#error-box')).toBeVisible();
  await page.locator('#source-timezone').selectOption('UTC');
  await expect(page.locator('#error-box')).toBeHidden();
  await expect(page.locator('#iso8601')).toHaveValue('2024-03-10T02:30:00.000Z');
  await expect(page.locator('#source-iso8601')).toHaveValue('2024-03-10T02:30:00.000Z');
});
test('ambiguous editable target time uses target offsets and stops showing choices after target changes', async ({ page }) => {
  await page.goto('/datetime-converter/'); await page.locator('#timezone').selectOption('America/New_York');
  await page.locator('#iso8601').fill('2024-11-03T01:30');
  await expect(page.locator('#dst-choice')).toBeVisible();
  await page.locator('#dst-occurrence').selectOption('1730615400000');
  await expect(page.locator('#datepicker')).toHaveValue('2024-11-02T23:30');
  await page.locator('#timezone').selectOption('UTC');
  await expect(page.locator('#iso8601')).toHaveValue('2024-11-03T06:30:00.000Z');
  await expect(page.locator('#dst-choice')).toBeHidden();
});
test('malformed, rollover and out-of-range input never produce plausible stale outputs', async ({ page }) => {
  await page.goto('/datetime-converter/');
  for (const [id, text] of [['unix-sec', '123oops'], ['unix-ms', '99999999999999999'], ['iso8601', '2024-02-30T12:00Z']]) {
    await page.locator('#' + id).fill(text); await expect(page.locator('#error-box')).toBeVisible();
    await expect(page.locator('#share-time-btn')).toBeDisabled(); await expect(page.locator('#datepicker')).toHaveValue('');
    await expect(page.locator('#swap-zones-btn')).toBeDisabled();
  }
  await page.locator('#unix-sec').fill('-0.001'); await expect(page.locator('#unix-ms')).toHaveValue('-1');
  await page.locator('#clear-btn').click(); await expect(page.locator('#unix-sec')).toHaveValue('');
  await expect(page.locator('#error-box')).toBeHidden(); await expect(page.locator('#share-time-btn')).toBeDisabled();
  await expect(page.locator('#swap-zones-btn')).toBeDisabled();
});
test('sharing freezes exact milliseconds and both zones; legacy and same-tab links restore', async ({ page }) => {
  await page.goto('/datetime-converter/'); await page.locator('#unix-ms').fill('1704067200123'); await page.locator('#timezone').selectOption('Asia/Kolkata');
  await page.locator('[data-copy="iso8601"]').click(); expect(await page.evaluate(() => (window as any).__copied)).toBe('2024-01-01T05:30:00.123+05:30');
  await page.locator('#share-time-btn').click(); await page.locator('#share-url-btn').click();
  const url = await page.evaluate(() => (window as any).__copied);
  const state = JSON.parse(LZString.decompressFromEncodedURIComponent(url.split('#lz:')[1])!);
  expect(state.a).toBe('convert');
  expect(state.d).toEqual({ unixSec: '1704067200.123', unixMs: '1704067200123', timezone: 'Asia/Kolkata', sourceTimezone: 'America/Los_Angeles' });
  await page.goto('/about/'); await page.goto(url);
  await expect(page.locator('#unix-ms')).toHaveValue('1704067200123'); await expect(page.locator('#timezone')).toHaveValue('Asia/Kolkata');
  await expect(page.locator('#source-timezone')).toHaveValue('America/Los_Angeles');
  await page.evaluate(url => { location.hash = new URL(url, location.href).hash; }, share({ unixSec: '0', timezone: 'America/New_York' }));
  await expect(page.locator('#iso8601')).toHaveValue('1969-12-31T19:00:00.000-05:00');
  await expect(page.locator('#source-timezone')).toHaveValue('America/New_York');
  await page.goto(share({ unixSec: '1704067200' })); await expect(page.locator('#timezone')).toHaveValue('UTC');
  await expect(page.locator('#iso8601')).toHaveValue('2024-01-01T00:00:00.000Z');
  await expect(page.locator('#source-timezone')).toHaveValue('UTC');
});
test('sharing a repeated source time restores both occurrence and source-edit behavior', async ({ page }) => {
  await page.goto('/datetime-converter/'); await page.locator('#source-timezone').selectOption('America/New_York');
  await page.locator('#datepicker').fill('2024-11-03T01:30');
  await page.locator('#dst-occurrence').selectOption('1730615400000');
  await page.locator('#timezone').selectOption('Asia/Kolkata');
  await page.locator('#share-time-btn').click(); await page.locator('#share-url-btn').click();
  const url = await page.evaluate(() => (window as any).__copied);
  await page.goto('/about/'); await page.goto(url);
  await expect(page.locator('#source-timezone')).toHaveValue('America/New_York');
  await expect(page.locator('#timezone')).toHaveValue('Asia/Kolkata');
  await expect(page.locator('#source-iso8601')).toHaveValue('2024-11-03T01:30:00.000-05:00');
  await expect(page.locator('#iso8601')).toHaveValue('2024-11-03T12:00:00.000+05:30');
  await expect(page.locator('#dst-occurrence')).toHaveValue('1730615400000');
  await page.locator('#source-timezone').selectOption('UTC');
  await expect(page.locator('#datepicker')).toHaveValue('2024-11-03T01:30');
  await expect(page.locator('#iso8601')).toHaveValue('2024-11-03T07:00:00.000+05:30');
  await expect(page.locator('#dst-choice')).toBeHidden();
});
test('guide example, local processing, copy denial and client-side navigation work', async ({ page }) => {
  const outgoing: string[] = [];
  page.on('request', request => { if (request.method() !== 'GET') outgoing.push(request.url()); });
  await page.goto('/guides/epoch-iso8601-timezone-offset/'); await page.locator('.datetime-example').click();
  await expect(page.locator('#iso8601')).toHaveValue('2024-01-01T05:30:00.000+05:30');
  await expect(page.locator('#source-timezone')).toHaveValue('UTC');
  await expect(page.locator('#source-iso8601')).toHaveValue('2024-01-01T00:00:00.000Z');
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied'); } } }));
  await page.locator('[data-copy="iso8601"]').click(); await expect(page.locator('#datetime-status')).toContainText('Clipboard access was unavailable');
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  expect(await page.locator('#iso8601').evaluate(node => getComputedStyle(node).color)).toBe('rgb(226, 232, 240)');
  await page.locator('#unix-ms').fill('1704067200000'); await page.locator('#timezone').selectOption('UTC');
  await expect(page.locator('#iso8601')).toHaveValue('2024-01-01T00:00:00.000Z'); expect(outgoing).toEqual([]);
  await page.locator('a[href="/json-formatter/"]').last().click();
  await expect(page.locator('#editor')).toBeVisible();
  if (await page.locator('#menu-toggle').isVisible()) await page.locator('#menu-toggle').click();
  const group = page.locator('.sidebar-group-toggle').filter({ hasText: 'Converters' });
  if (await group.getAttribute('aria-expanded') !== 'true') await group.click();
  await page.locator('a[href="/datetime-converter/"]').first().click();
  await expect(page.locator('#source-timezone')).toHaveValue('America/Los_Angeles');
  await expect(page.locator('#timezone')).toHaveValue('UTC');
  await page.locator('#unix-sec').fill('0'); await expect(page.locator('#unix-ms')).toHaveValue('0');
});
test('current-time shares remain a snapshot and invalid shared zones fail without stale results', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2024-07-01T12:34:56.789Z'));
  await page.goto('/datetime-converter/'); await page.locator('#now-btn').click();
  await page.locator('#share-time-btn').click(); await page.locator('#share-url-btn').click();
  const url = await page.evaluate(() => (window as any).__copied);
  await page.clock.setFixedTime(new Date('2025-01-01T00:00:00Z'));
  await page.goto(url); await expect(page.locator('#unix-ms')).toHaveValue(String(Date.parse('2024-07-01T12:34:56.789Z')));
  await expect(page.locator('#iso8601')).toHaveValue('2024-07-01T12:34:56.789Z');
  await expect(page.locator('#source-iso8601')).toHaveValue('2024-07-01T05:34:56.789-07:00');
  await page.goto(share({ unixSec: '0', timezone: 'not/a-zone' }));
  await expect(page.locator('#error-box')).toContainText('unsupported timezone');
  await expect(page.locator('#unix-ms')).toHaveValue(''); await expect(page.locator('#share-time-btn')).toBeDisabled();
  await page.goto(share({ unixMs: '0', timezone: 'UTC', sourceTimezone: 'not/a-zone' }));
  await expect(page.locator('#error-box')).toContainText('unsupported timezone');
  await expect(page.locator('#source-iso8601')).toHaveValue(''); await expect(page.locator('#target-datepicker')).toHaveValue('');
});
test('source-to-target guide example restores an editable complete conversion', async ({ page }) => {
  await page.goto('/guides/epoch-iso8601-timezone-offset/'); await page.locator('.source-target-example').click();
  await expect(page.locator('#source-timezone')).toHaveValue('Asia/Kolkata');
  await expect(page.locator('#timezone')).toHaveValue('America/New_York');
  await expect(page.locator('#datepicker')).toHaveValue('2024-01-01T09:00');
  await expect(page.locator('#iso8601')).toHaveValue('2023-12-31T22:30:00.000-05:00');
  await page.locator('#source-timezone').selectOption('UTC');
  await expect(page.locator('#iso8601')).toHaveValue('2024-01-01T04:00:00.000-05:00');
  await page.locator('[data-copy="source-iso8601"]').click();
  expect(await page.evaluate(() => (window as any).__copied)).toBe('2024-01-01T09:00:00.000Z');
  await page.locator('[data-copy="target-datepicker"]').click();
  expect(await page.evaluate(() => (window as any).__copied)).toBe('2024-01-01T04:00');
});
