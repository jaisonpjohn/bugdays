import { test, expect } from '@playwright/test';
import LZString from 'lz-string';
import { readFile } from 'node:fs/promises';
const shared = (data: Record<string, unknown>, action = 'intersection') => '/list-compare/#lz:' + LZString.compressToEncodedURIComponent(JSON.stringify({ v: 1, t: 'list-compare', a: action, d: data }));
const events = page => page.evaluate(() => Array.from((window as any).dataLayer || []).map(entry => Array.from(entry as any)).filter(args => args[0] === 'event'));
test.beforeEach(async ({page}) => {
  await page.route('https://**/*', route => route.abort());
  await page.addInitScript(() => {
    localStorage.setItem('cookie-notice-dismissed','true'); localStorage.removeItem('bd-share-method');
    (window as any).__copied = ''; (window as any).__errors = [];
    window.addEventListener('error', event => (window as any).__errors.push(event.message));
    Object.defineProperty(navigator,'clipboard',{ configurable:true, value:{ writeText: async text => { (window as any).__copied = text; } } });
  });
});
test.afterEach(async ({page}) => {
  expect(await page.evaluate(() => (window as any).__errors)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});
test('automatic results, seven views, counts and accessible selection', async ({page}) => {
  await page.goto('/list-compare/'); await page.locator('#load-example').click();
  await expect(page.locator('#output')).toHaveValue('SKU-101');
  await expect(page.locator('#setA-count')).toHaveText('4 items · 3 unique · 1 repeat');
  for (const [action, value] of [['diffAB','SKU-100\nSKU-102'], ['diffBA','SKU-103\nSKU-104'], ['symmetric','SKU-100\nSKU-102\nSKU-103\nSKU-104'], ['union','SKU-100\nSKU-101\nSKU-102\nSKU-103\nSKU-104'], ['duplicatesA','SKU-102'], ['duplicatesB','']]) {
    await page.locator('#' + action + '-btn').click(); await expect(page.locator('#output')).toHaveValue(value);
    await expect(page.locator('#' + action + '-btn')).toHaveAttribute('aria-pressed','true');
  }
  await expect(page.locator('#result-empty')).toBeVisible(); await expect(page.locator('#share-comparison')).toBeEnabled();
});
test('matching, natural order, manual mode, swap and clearing stale results', async ({page}) => {
  await page.goto('/list-compare/'); await page.locator('#setA').fill(' Apple \nSKU-10\nSKU-2'); await page.locator('#setB').fill('apple\nSKU-2');
  await expect(page.locator('#output')).toHaveValue('SKU-2'); await page.locator('#ignore-case').check();
  await expect(page.locator('#output')).toHaveValue('Apple\nSKU-2'); await page.locator('#union-btn').click();
  await page.locator('#result-order').selectOption('ascending'); await expect(page.locator('#output')).toHaveValue('Apple\nSKU-2\nSKU-10');
  await page.locator('#trim-spaces').uncheck(); await expect(page.locator('#output')).toHaveValue(' Apple \napple\nSKU-2\nSKU-10');
  await page.locator('#auto-compare').uncheck(); await page.locator('#setA').fill('0012\n12');
  await expect(page.locator('#output')).toHaveValue(''); await expect(page.locator('#share-comparison')).toBeDisabled();
  await page.locator('#compare-btn').click(); await expect(page.locator('#output')).not.toHaveValue('');
  await page.locator('#swap-lists').click(); await expect(page.locator('#setB')).toHaveValue('0012\n12');
  await page.locator('#clear-lists').click(); await expect(page.locator('#output')).toHaveValue(''); await expect(page.locator('#copy-btn')).toBeDisabled();
});
test('optional dedupe preserves qualifying rows and all-items concatenation', async ({page}) => {
  await page.goto('/list-compare/'); await page.locator('#setA').fill('a\na\nb'); await page.locator('#setB').fill('a\nc\nc');
  await expect(page.locator('#output')).toHaveValue('a');
  await page.locator('#more-options > summary').click(); await page.locator('#dedupe').uncheck();
  await expect(page.locator('#output')).toHaveValue('a\na'); await expect(page.locator('#result-label')).toHaveText('2 items');
  await page.locator('#union-btn').click(); await expect(page.locator('#output')).toHaveValue('a\na\nb\na\nc\nc');
  await expect(page.locator('#union-label')).toHaveText('All items');
  await page.locator('#duplicatesA-btn').click(); await expect(page.locator('#output')).toHaveValue('a');
  await expect(page.locator('#result-label')).toHaveText('1 unique item');
  await page.locator('#dedupe').check(); await page.locator('#union-btn').click(); await expect(page.locator('#output')).toHaveValue('a\nb\nc');
  await expect(page.locator('#union-label')).toHaveText('All unique');
});
test('blank-row preview markers never replace raw copy or TXT values', async ({page}) => {
  await page.goto('/list-compare/'); await page.locator('#more-options > summary').click();
  await page.locator('#ignore-blank').uncheck(); await page.locator('#dedupe').uncheck();
  await page.locator('#setA').fill('a\n\n  \n'); await page.locator('#setB').fill('\n');
  await expect(page.locator('#output')).toHaveValue('⟨empty line⟩\n⟨empty line⟩');
  await page.locator('#copy-btn').click(); expect(await page.evaluate(() => (window as any).__copied)).toBe('\n\n');
  const download = page.waitForEvent('download'); await page.locator('#download-txt').click();
  expect(await readFile((await (await download).path())!, 'utf8')).toBe('\n\n');
  await page.locator('#trim-spaces').uncheck(); await page.locator('#diffAB-btn').click();
  await expect(page.locator('#output')).toHaveValue('a\n⟨whitespace-only line⟩');
  await page.locator('#copy-btn').click(); expect(await page.evaluate(() => (window as any).__copied)).toBe('a\n  ');
});
test('optional zeros, internal spaces and Unicode matching retain original text', async ({page}) => {
  await page.goto('/list-compare/'); await page.locator('#more-options > summary').click();
  await page.locator('#setA').fill('00012\n09007199254740993\nJane  Doe\nCafe\u0301\nSKU-0012');
  await page.locator('#setB').fill('12\n9007199254740993\nJane Doe\nCafé\nSKU-12');
  await page.locator('#ignore-zeros').check(); await page.locator('#extra-spaces').check(); await page.locator('#unicode-nfc').check();
  await expect(page.locator('#output')).toHaveValue('00012\n09007199254740993\nJane  Doe\nCafe\u0301');
  await page.locator('#diffAB-btn').click(); await expect(page.locator('#output')).toHaveValue('SKU-0012');
});
test('CSV/TSV selected columns, header skip, empty files and malformed imports', async ({page}) => {
  await page.goto('/list-compare/'); await page.locator('#more-options > summary').click();
  await page.locator('#csv-column').fill('2'); await page.locator('#csv-header').check();
  await page.locator('#file-A').setInputFiles({name:'inventory.csv',mimeType:'text/csv',buffer:Buffer.from('name,id\r\n"Smith, John",0012\r\n"a""b",0003\r\n')});
  await expect(page.locator('#setA')).toHaveValue('0012\n0003');
  await page.locator('#file-B').setInputFiles({name:'inventory.tsv',mimeType:'text/tab-separated-values',buffer:Buffer.from('name\tid\na\t0003\nb\t0004\n')});
  await expect(page.locator('#output')).toHaveValue('0003');
  await page.locator('#file-A').setInputFiles({name:'empty.txt',mimeType:'text/plain',buffer:Buffer.from(' \n\t')});
  await expect(page.locator('#list-status')).toContainText('Skipped'); await expect(page.locator('#setA')).toHaveValue('0012\n0003');
  await page.locator('#file-A').setInputFiles({name:'malformed.csv',mimeType:'text/csv',buffer:Buffer.from('name,id\n"unfinished')});
  await expect(page.locator('#list-error')).toContainText('quoted'); await expect(page.locator('#setA')).toHaveValue('0012\n0003');
  await page.locator('#file-A').setInputFiles({name:'missing-column.csv',mimeType:'text/csv',buffer:Buffer.from('name,id\njust-one\n')});
  await expect(page.locator('#list-error')).toContainText('column 2');
  await page.locator('#skip-empty-files').uncheck(); await page.locator('#file-A').setInputFiles({name:'empty.txt',mimeType:'text/plain',buffer:Buffer.alloc(0)});
  await expect(page.locator('#setA')).toHaveValue(''); await expect(page.locator('#list-error')).toBeHidden();
  await page.locator('#ignore-blank').uncheck(); await page.locator('#trim-spaces').uncheck();
  await page.locator('#file-A').setInputFiles({name:'whitespace.txt',mimeType:'text/plain',buffer:Buffer.from('  \n')});
  await page.locator('#diffAB-btn').click(); await expect(page.locator('#output')).toHaveValue('⟨whitespace-only line⟩');
  const serialized = JSON.stringify(await events(page)); expect(serialized).not.toContain('inventory'); expect(serialized).not.toContain('Smith');
});
test('all optional settings round-trip through real shares and a complete JSON report', async ({page}) => {
  await page.goto('/list-compare/'); await page.locator('#more-options > summary').click();
  await page.locator('#dedupe').uncheck(); await page.locator('#ignore-blank').uncheck(); await page.locator('#ignore-zeros').check();
  await page.locator('#extra-spaces').check(); await page.locator('#unicode-nfc').check(); await page.locator('#skip-empty-files').uncheck();
  await page.locator('#csv-column').fill('2'); await page.locator('#csv-header').check();
  await page.locator('#ignore-case').check(); await page.locator('#result-order').selectOption('descending');
  await page.locator('#setA').fill('0012\n0012\n\nJane  Doe'); await page.locator('#setB').fill('12\njane doe');
  await expect(page.locator('#output')).toHaveValue('Jane  Doe\n0012\n0012');
  await page.locator('#result-search').fill('Jane'); await expect(page.locator('#output')).toHaveValue('Jane  Doe');
  const download = page.waitForEvent('download'); await page.locator('#download-json').click();
  const report = JSON.parse(await readFile((await (await download).path())!, 'utf8'));
  expect(report.version).toBe(1); expect(report.results.intersection).toEqual(['Jane  Doe','0012','0012']);
  expect(report.results.diffAB).toEqual(['']); expect(Object.keys(report.results)).toHaveLength(7);
  expect(report.matching).toMatchObject({dedupe:false,ignoreBlank:false,ignoreZeros:true,extraSpaces:true,unicodeNfc:true,ignoreCase:true,order:'descending'});
  await page.locator('#share-comparison').click(); await page.locator('#share-url-btn').click();
  const url = await page.evaluate(() => (window as any).__copied); await page.goto('/about/'); await page.goto(url);
  await expect(page.locator('#output')).toHaveValue('Jane  Doe\n0012\n0012');
  await expect(page.locator('#more-options')).toHaveAttribute('open',''); await expect(page.locator('#result-search')).toHaveValue('');
  for (const id of ['dedupe','ignore-blank','skip-empty-files']) await expect(page.locator('#'+id)).not.toBeChecked();
  for (const id of ['ignore-zeros','extra-spaces','unicode-nfc','csv-header','ignore-case']) await expect(page.locator('#'+id)).toBeChecked();
  await expect(page.locator('#csv-column')).toHaveValue('2'); await expect(page.locator('#result-order')).toHaveValue('descending');
  expect((await events(page)).filter(entry => entry[1] === 'tool_used')).toEqual([]);
  await page.evaluate(hash => { location.hash = hash; }, shared({setA:' A \nA\na',setB:'a'},'diffAB').split('#')[1]);
  await expect(page.locator('#output')).toHaveValue('A'); await expect(page.locator('#more-options')).not.toHaveAttribute('open');
  for (const id of ['dedupe','ignore-blank','skip-empty-files','trim-spaces']) await expect(page.locator('#'+id)).toBeChecked();
  for (const id of ['ignore-zeros','extra-spaces','unicode-nfc','csv-header','ignore-case']) await expect(page.locator('#'+id)).not.toBeChecked();
});
test('copy and TXT/CSV export include the full selection rather than search results', async ({page}) => {
  await page.goto('/list-compare/'); await page.locator('#setA').fill('0012\na,b\n=1+1'); await page.locator('#union-btn').click();
  await expect(page.locator('#output')).toHaveValue('0012\na,b\n=1+1'); await page.locator('#result-search').fill('0012');
  await expect(page.locator('#output')).toHaveValue('0012'); await page.locator('#copy-btn').click();
  expect(await page.evaluate(() => (window as any).__copied)).toBe('0012\na,b\n=1+1');
  for (const format of ['txt','csv']) {
    const download = page.waitForEvent('download'); await page.locator('#download-' + format).click(); const file = await download;
    const text = await readFile((await file.path())!, 'utf8');
    if (format === 'txt') expect(text).toBe('0012\na,b\n=1+1'); else expect(text).toBe('\uFEFFItem\r\n"0012"\r\n"a,b"\r\n"\'=1+1"\r\n');
  }
});
test('new shares restore settings/view and old actions/defaults still work without phantom usage events', async ({page}) => {
  await page.goto('/list-compare/'); await page.locator('#load-example').click(); await expect(page.locator('#output')).toHaveValue('SKU-101');
  await page.locator('#diffAB-btn').click(); await page.locator('#ignore-case').check(); await expect(page.locator('#output')).toHaveValue('SKU-100\nSKU-102');
  await page.locator('#share-comparison').click(); await page.locator('#share-url-btn').click();
  const url = await page.evaluate(() => (window as any).__copied); await page.goto('/about/'); await page.goto(url);
  await expect(page.locator('#output')).toHaveValue('SKU-100\nSKU-102'); await expect(page.locator('#ignore-case')).toBeChecked();
  expect((await events(page)).filter(entry => entry[1] === 'tool_used')).toEqual([]);
  await page.evaluate(hash => { location.hash = hash; }, shared({setA:' A \nA\na', setB:'a'} ,'diffAB').split('#')[1]);
  await expect(page.locator('#ignore-case')).not.toBeChecked(); await expect(page.locator('#trim-spaces')).toBeChecked(); await expect(page.locator('#output')).toHaveValue('A');
  await page.goto(shared({setA:'a\nb',setB:'b\nc'},'symmetric')); await expect(page.locator('#output')).toHaveValue('a\nc');
});
test('successful auto comparison, copy, file and export analytics contain only safe metadata', async ({page}) => {
  const sent: string[] = []; page.on('request', request => { if (request.method() !== 'GET') sent.push(request.url()); });
  await page.goto('/list-compare/'); await page.locator('#setA').fill('private@example.invalid\nsecret-value'); await page.locator('#setB').fill('secret-value');
  await expect(page.locator('#output')).toHaveValue('secret-value'); await page.locator('#copy-btn').click();
  let queued = await events(page); expect(queued.filter(entry => entry[1] === 'tool_used')).toHaveLength(1);
  expect(queued.some(entry => entry[1] === 'copy_used')).toBeTruthy();
  await page.locator('#file-A').setInputFiles({name:'private-filename.txt',mimeType:'text/plain',buffer:Buffer.from('alpha\nbeta')});
  await expect(page.locator('#setA')).toHaveValue('alpha\nbeta'); await expect(page.locator('#setA-count')).toContainText('2 items');
  queued = await events(page); expect(queued.some(entry => entry[1] === 'import_used')).toBeTruthy();
  const serialized = JSON.stringify(queued); for (const value of ['private@example','secret-value','private-filename']) expect(serialized).not.toContain(value);
  expect(sent).toEqual([]);
});
test('limits, invalid UTF-8, cancellation and rapid edits never show stale output', async ({page}) => {
  await page.goto('/list-compare/'); await page.locator('#file-A').setInputFiles({ name:'over-limit.txt', mimeType:'text/plain', buffer:Buffer.from('x\n'.repeat(100001)) });
  await expect(page.locator('#list-error')).toContainText('100,000'); await expect(page.locator('#copy-btn')).toBeDisabled();
  await page.locator('#file-A').setInputFiles({name:'bad.txt',mimeType:'text/plain',buffer:Buffer.from([0xff])}); await expect(page.locator('#list-error')).toContainText('UTF-8');
  let release: () => void = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
  const hold = async route => { await gate; await route.continue().catch(() => {}); };
  await page.route('**/*list-compare.worker*', hold);
  await page.locator('#setA').fill('old'); await page.locator('#compare-btn').click(); await page.locator('#cancel-compare').click();
  await expect(page.locator('#output')).toHaveValue(''); await expect(page.locator('#list-status')).toContainText('cancelled');
  release(); await page.unroute('**/*list-compare.worker*', hold);
  await page.locator('#setA').fill('new'); await page.locator('#setB').fill('new'); await expect(page.locator('#output')).toHaveValue('new');
  await page.locator('#setA').fill(''); await page.locator('#setB').fill(''); await expect(page.locator('#output')).toHaveValue('');
});
test('large native paste is intercepted, stays responsive and retains the whole list', async ({page}) => {
  await page.goto('/list-compare/');
  await page.locator('#setA').focus();
  await page.locator('#setA').evaluate(node => {
    const text = Array.from({length:5000},(_,i) => 'item-' + i).join('\n');
    const data = new DataTransfer(); data.setData('text/plain',text);
    const event = new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data});
    node.dispatchEvent(event); (window as any).__pastePrevented = event.defaultPrevented;
  });
  expect(await page.evaluate(() => (window as any).__pastePrevented)).toBe(true);
  await expect(page.locator('#setA-count')).toHaveText('5,000 items · 5,000 unique · 0 repeats');
  await page.locator('#union-btn').click(); await expect(page.locator('#output')).toHaveValue(/item-4999$/);
  await page.locator('#setA').evaluate(node => {
    const data = new DataTransfer(); data.setData('text/plain','x\n'.repeat(100001));
    node.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
  });
  await expect(page.locator('#list-error')).toContainText('100,000'); await expect(page.locator('#setA')).toHaveValue(/item-4999$/);
});
test('guide example, dark theme, scrolling long lists and return navigation', async ({page}) => {
  await page.goto('/guides/compare-two-lists-find-missing-items/'); await page.locator('.list-example').click(); await expect(page.locator('#output')).toHaveValue('SKU-100\nSKU-102');
  await page.locator('#setA').fill(Array.from({length:300},(_,i)=>'item-'+i).join('\n')); await page.locator('#union-btn').click();
  await expect(page.locator('#result-label')).toHaveText('303 unique items');
  expect((await page.locator('#setA').boundingBox())!.height).toBeLessThanOrEqual(176);
  expect((await page.locator('#result-search').boundingBox())!.width).toBeGreaterThan(180);
  expect(await page.locator('#setA').evaluate(node => node.scrollHeight > node.clientHeight)).toBeTruthy();
  expect(await page.locator('#output').evaluate(node => node.scrollHeight > node.clientHeight)).toBeTruthy();
  await page.evaluate(() => document.documentElement.classList.add('dark')); expect(await page.locator('#output').evaluate(node => getComputedStyle(node).color)).toBe('rgb(226, 232, 240)');
  await page.locator('a[href="/text-tools/"]').first().click(); await page.locator('a[href="/list-compare/"]').last().click();
  await page.locator('#load-example').click(); await expect(page.locator('#output')).toHaveValue('SKU-101');
});
test('file reads are independent per input and cannot overwrite cleared inputs', async ({page}) => {
  await page.goto('/list-compare/');
  await page.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = async function() {
      await new Promise<void>(resolve => { (window as any).__finishRead = resolve; }); return read.call(this);
    };
  });
  await page.locator('#file-A').setInputFiles({name:'example.txt',mimeType:'text/plain',buffer:Buffer.from('alpha\nbeta')});
  await page.locator('#setB').fill('beta'); await page.evaluate(() => (window as any).__finishRead());
  await expect(page.locator('#setA')).toHaveValue('alpha\nbeta'); await expect(page.locator('#output')).toHaveValue('beta');
  await page.locator('#file-A').setInputFiles({name:'example.txt',mimeType:'text/plain',buffer:Buffer.from('late')});
  await page.locator('#clear-lists').click(); await page.evaluate(() => (window as any).__finishRead());
  await expect(page.locator('#setA')).toHaveValue(''); await expect(page.locator('#output')).toHaveValue('');
});
