import {test,expect} from '@playwright/test';
import LZString from 'lz-string';
import {readFile} from 'node:fs/promises';
const shared=(data:Record<string,unknown>)=>'/yaml-diff/#lz:'+LZString.compressToEncodedURIComponent(JSON.stringify({v:1,t:'yaml-diff',a:'compare',d:data}));
const events=page=>page.evaluate(()=>Array.from((window as any).dataLayer||[]).map(entry=>Array.from(entry as any)).filter(args=>args[0]==='event'));
test.beforeEach(async({page})=>{
  await page.route('https://**/*',route=>route.abort());
  await page.addInitScript(()=>{localStorage.setItem('cookie-notice-dismissed','true');localStorage.removeItem('bd-share-method');(window as any).__copied='';(window as any).__errors=[];window.addEventListener('error',event=>(window as any).__errors.push(event.message));Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{(window as any).__copied=text;}}});});
});
test.afterEach(async({page})=>{
  expect(await page.evaluate(()=>(window as any).__errors)).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});
test('worked sample, keyed resource/list counts, selected values and precise source navigation',async({page})=>{
  await page.goto('/yaml-diff/');await page.locator('#sample-btn').click();
  await expect(page.locator('#stats')).toContainText('2 changes');await expect(page.locator('#stats')).toContainText('2 keyed lists');
  await expect(page.locator('#changes-list button')).toHaveCount(2);
  await expect(page.locator('#old-value')).toHaveText('2');await expect(page.locator('#new-value')).toHaveText('3');
  await page.locator('[data-change-index="1"]').click();await expect(page.locator('#old-value')).toHaveText('"example/web:1.0"');await expect(page.locator('#new-value')).toHaveText('"example/web:2.0"');
  await page.locator('#old-jump').click();expect(await page.locator('#yaml1').evaluate((node:HTMLTextAreaElement)=>node.value.slice(node.selectionStart).startsWith('example/web:1.0'))).toBeTruthy();
  await page.locator('#new-copy').click();expect(await page.evaluate(()=>(window as any).__copied)).toBe('"example/web:2.0"');
  await page.locator('#copy-path').click();expect(await page.evaluate(()=>(window as any).__copied)).toBe('/spec/template/spec/containers/1/image');
});
test('literal source stays intact; semantic equality, exact numbers and quoted types',async({page})=>{
  await page.goto('/yaml-diff/');await page.locator('#yaml1').fill('a: 1\nb: "hi" # note\n');await page.locator('#yaml2').fill('b: hi\na: 1.0\n');await page.locator('#compare-btn').click();
  await expect(page.locator('#stats')).toContainText('0 changes');await expect(page.locator('#change-count')).toContainText('No semantic differences');await expect(page.locator('#yaml1')).toHaveValue('a: 1\nb: "hi" # note\n');
  await page.locator('#yaml1').fill('id: 9007199254740993\nflag: true');await expect(page.locator('#results')).toBeHidden();
  await page.locator('#yaml2').fill('id: 9007199254740994\nflag: "true"');await page.locator('#compare-btn').click();
  await expect(page.locator('#stats')).toContainText('2 changes');await expect(page.locator('#old-value')).toHaveText('9007199254740993');
});
test('matching modes, generated-field toggle, ignored pointers and unnamed nested lists',async({page})=>{
  await page.goto('/yaml-diff/');await page.locator('#yaml1').fill('metadata: {resourceVersion: "1"}\nitems: [1, 2, 2]');await page.locator('#yaml2').fill('items: [2, 1, 2]\nmetadata: {resourceVersion: "2"}');
  await page.locator('#ignore-generated').check();await page.locator('#yaml-advanced > summary').click();await page.locator('#array-mode').selectOption('unordered');await page.locator('#compare-btn').click();
  await expect(page.locator('#stats')).toContainText('0 changes');
  await page.locator('#yaml2').fill('items: [2, 1]\nmetadata: {resourceVersion: "2"}');await page.locator('#compare-btn').click();await expect(page.locator('#stats')).toContainText('1 removed');
  await page.locator('#array-mode').selectOption('key');await page.locator('#yaml1').fill('items: [{name: web, ports: [{containerPort: 80}]}]');await page.locator('#yaml2').fill('items: [{name: web, ports: [{containerPort: 443}]}]');await page.locator('#compare-btn').click();
  await expect(page.locator('#stats')).toContainText('1 change');await expect(page.locator('#selected-path')).toContainText('/items/0/ports/0/containerPort');
  await page.locator('#ignored-paths').fill('/items/0/ports');await page.locator('#compare-btn').click();await expect(page.locator('#stats')).toContainText('0 changes');
});
test('errors identify a side and position, disable stale exports and preserve inputs',async({page})=>{
  await page.goto('/yaml-diff/');await page.locator('#sample-btn').click();await expect(page.locator('#stats')).toContainText('2 changes');
  await page.locator('#yaml2').fill('a: 1\na: 2');await page.locator('#compare-btn').click();await expect(page.locator('#error-text')).toContainText('Modified');await expect(page.locator('#error-text')).toContainText('unique');
  await expect(page.locator('#download-json')).toBeDisabled();await page.locator('#error-jump').click();expect(await page.locator('#yaml2').evaluate((node:HTMLTextAreaElement)=>node.selectionStart)).toBeGreaterThan(0);
  await page.locator('#yaml2').fill('a: !Custom x');await page.locator('#compare-btn').click();await expect(page.locator('#error-text')).toContainText('tag');
  await page.locator('#yaml2-file').setInputFiles({name:'bad.yml',mimeType:'application/yaml',buffer:Buffer.from([0xff])});await expect(page.locator('#error-text')).toContainText('UTF-8');await expect(page.locator('#yaml2')).toHaveValue('a: !Custom x');
  await page.locator('#yaml2-file').setInputFiles({name:'oversized.yml',mimeType:'application/yaml',buffer:Buffer.alloc(5*1024*1024+1,97)});await expect(page.locator('#error-text')).toContainText('5 MiB');await expect(page.locator('#yaml2')).toHaveValue('a: !Custom x');
});
test('copy and exports contain the complete report despite filtering',async({page})=>{
  await page.goto('/yaml-diff/');await page.locator('#sample-btn').click();await expect(page.locator('#stats')).toContainText('2 changes');await page.locator('#change-search').fill('replicas');await expect(page.locator('#changes-list button')).toHaveCount(1);
  await page.locator('#copy-report').click();expect(await page.evaluate(()=>(window as any).__copied)).toContain('example/web:2.0');
  for(const format of ['json','txt']){const download=page.waitForEvent('download');await page.locator('#download-'+format).click();const text=await readFile((await(await download).path())!,'utf8');if(format==='json'){const report=JSON.parse(text);expect(report.changes).toHaveLength(2);expect(report.options.documents).toBe('kubernetes');expect(report.changes[0].original.document).toBe(2);}else{expect(text).toContain('"documents":"kubernetes"');expect(text).toContain('example/web:2.0');}}
});
test('real shares preserve modes; old shares reset defaults without replay usage',async({page})=>{
  await page.goto('/yaml-diff/');await page.locator('#sample-btn').click();await expect(page.locator('#stats')).toContainText('2 changes');
  await page.locator('#auto-compare').check();await expect(page.locator('#stats')).toContainText('2 changes');
  await page.locator('#share-comparison').click();await page.locator('#share-url-btn').click();const url=await page.evaluate(()=>(window as any).__copied);
  await page.goto('/about/');await page.goto(url);await expect(page.locator('#stats')).toContainText('2 changes');await expect(page.locator('#document-mode')).toHaveValue('kubernetes');await expect(page.locator('#array-mode')).toHaveValue('key');await expect(page.locator('#ignore-generated')).toBeChecked();await expect(page.locator('#auto-compare')).toBeChecked();
  expect((await events(page)).filter(entry=>entry[1]==='tool_used')).toEqual([]);
  await page.evaluate(hash=>{location.hash=hash;},shared({yaml1:'x: 1',yaml2:'x: 2'}).split('#')[1]);await expect(page.locator('#stats')).toContainText('1 change');await expect(page.locator('#document-mode')).toHaveValue('position');await expect(page.locator('#array-mode')).toHaveValue('position');await expect(page.locator('#ignore-generated')).not.toBeChecked();await expect(page.locator('#auto-compare')).not.toBeChecked();await expect(page.locator('#old-value')).toHaveText('1');
});
test('format both preserves exact numeric tokens and is atomic on an invalid document',async({page})=>{
  await page.goto('/yaml-diff/');const left='# note\na: [1, 2]\n', right='value: 0.10000000000000001';await page.locator('#yaml1').fill(left);await page.locator('#yaml2').fill(right);await page.locator('#format-btn').click();await expect(page.locator('#yaml-status')).toContainText('Both inputs formatted');await expect(page.locator('#yaml1')).toHaveValue(/# note/);await expect(page.locator('#yaml2')).toHaveValue(/0\.10000000000000001/);
  const formatted=await page.locator('#yaml1').inputValue();await page.locator('#yaml2').fill('a: [bad');await page.locator('#format-btn').click();await expect(page.locator('#error-box')).toBeVisible();await expect(page.locator('#yaml1')).toHaveValue(formatted);
});
test('cancel and rapid edits never publish stale results',async({page})=>{
  let release:()=>void=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});const hold=async route=>{await gate;await route.continue().catch(()=>{});};
  await page.route('**/*yaml-diff.worker*',hold);await page.goto('/yaml-diff/');await page.locator('#yaml1').fill('a: old');await page.locator('#yaml2').fill('a: different');await page.locator('#compare-btn').click();await page.locator('#cancel-btn').click();await expect(page.locator('#yaml-status')).toContainText('Cancelled');await expect(page.locator('#results')).toBeHidden();release();await page.unroute('**/*yaml-diff.worker*',hold);
  await page.locator('#auto-compare').check();await page.locator('#yaml1').fill('a: new');await page.locator('#yaml2').fill('a: new');await expect(page.locator('#stats')).toContainText('0 changes');await page.locator('#clear-btn').click();await expect(page.locator('#yaml1')).toHaveValue('');await expect(page.locator('#results')).toBeHidden();
});
test('large paste, source find, line gutters and navigation remain usable',async({page})=>{
  await page.goto('/yaml-diff/');await page.locator('#yaml1').evaluate(node=>{const text=Array.from({length:5000},(_,i)=>'key'+i+': value'+i).join('\n');const data=new DataTransfer();data.setData('text/plain',text);const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data});node.dispatchEvent(event);(window as any).__prevented=event.defaultPrevented;});
  expect(await page.evaluate(()=>(window as any).__prevented)).toBe(true);await expect(page.locator('#yaml1')).toHaveValue(/key4999: value4999$/);
  await page.locator('#yaml2-file').setInputFiles({name:'long.yaml',mimeType:'application/yaml',buffer:Buffer.from((await page.locator('#yaml1').inputValue()).replace('value4999','updated'))});await page.locator('#compare-btn').click();await expect(page.locator('#stats')).toContainText('1 change');await page.locator('#old-jump').click();expect(await page.locator('#yaml1').evaluate(node=>node.scrollTop>0)).toBeTruthy();await expect(page.locator('#yaml1').locator('..').locator('[data-yaml-gutter]')).toContainText('4999');
  await page.locator('summary').filter({hasText:'Find in source files'}).click();await page.locator('#find-query').fill('key4999');await page.locator('#find-next').click();expect(await page.locator('#yaml1').evaluate((node:HTMLTextAreaElement)=>node.value.slice(node.selectionStart,node.selectionEnd))).toBe('key4999');
  expect((await page.locator('#yaml1').boundingBox())!.height).toBeLessThanOrEqual(224);await page.evaluate(()=>document.documentElement.classList.add('dark'));expect(await page.locator('#yaml1').evaluate(node=>getComputedStyle(node).color)).toBe('rgb(226, 232, 240)');
  await page.goto('/yaml-tools/');await page.locator('a[href="/yaml-diff/"]').last().click();await page.locator('#sample-btn').click();await expect(page.locator('#stats')).toContainText('2 changes');
});
test('file reads are independent and cannot overwrite cleared or manually edited inputs',async({page})=>{
  await page.goto('/yaml-diff/');await page.evaluate(()=>{const read=File.prototype.arrayBuffer;File.prototype.arrayBuffer=async function(){await new Promise<void>(resolve=>{(window as any).__finishRead=resolve;});return read.call(this);};});
  await page.locator('#yaml1-file').setInputFiles({name:'local.yaml',mimeType:'application/yaml',buffer:Buffer.from('a: 1')});await page.locator('#yaml2').fill('a: 2');await page.evaluate(()=>(window as any).__finishRead());await expect(page.locator('#yaml1')).toHaveValue('a: 1');
  await page.locator('#yaml1-file').setInputFiles({name:'local.yaml',mimeType:'application/yaml',buffer:Buffer.from('a: late')});await page.locator('#clear-btn').click();await page.evaluate(()=>(window as any).__finishRead());await expect(page.locator('#yaml1')).toHaveValue('');
  await page.locator('#yaml1-file').setInputFiles({name:'local.yaml',mimeType:'application/yaml',buffer:Buffer.from('a: late')});await page.locator('#yaml1').fill('a: manual');await page.evaluate(()=>(window as any).__finishRead());await expect(page.locator('#yaml1')).toHaveValue('a: manual');
});
test('analytics never includes file names, config values, ignored paths or errors',async({page})=>{
  const sent:string[]=[];page.on('request',request=>{if(request.method()!=='GET')sent.push(request.url());});await page.goto('/yaml-diff/');await page.locator('#yaml1-file').setInputFiles({name:'private-filename.yml',mimeType:'application/yaml',buffer:Buffer.from('privateField: private-value')});await page.locator('#yaml2').fill('privateField: another-value');await page.locator('#compare-btn').click();await expect(page.locator('#stats')).toContainText('1 change');await page.locator('#new-copy').click();const queued=await events(page);expect(queued.some(entry=>entry[1]==='tool_used')).toBeTruthy();expect(queued.some(entry=>entry[1]==='import_used')).toBeTruthy();expect(queued.some(entry=>entry[1]==='copy_used')).toBeTruthy();const text=JSON.stringify(queued);for(const value of ['private-filename','privateField','private-value','another-value'])expect(text).not.toContain(value);expect(sent).toEqual([]);
});
test('guide example is runnable and matches the published two changes',async({page})=>{
  await page.goto('/guides/compare-kubernetes-yaml-ignore-order/');await page.locator('.yaml-guide-example').click();await expect(page.locator('#stats')).toContainText('2 changes');await expect(page.locator('#changes-list button')).toHaveCount(2);
});
test('paging and filters keep selected inspection in the visible result set',async({page})=>{
  await page.goto('/yaml-diff/');await page.locator('#yaml1').fill(Array.from({length:120},(_,i)=>'key'+i+': old').join('\n'));await page.locator('#yaml2').fill(Array.from({length:120},(_,i)=>'key'+i+': new').join('\n'));await page.locator('#compare-btn').click();await expect(page.locator('#stats')).toContainText('120 changes');await expect(page.locator('#changes-list button')).toHaveCount(50);await page.locator('#next-page').click();await expect(page.locator('#change-count')).toHaveText('51–100 of 120 shown');await expect(page.locator('#selected-path')).toContainText('/key50');await page.locator('#next-page').click();await expect(page.locator('#changes-list button')).toHaveCount(20);await expect(page.locator('#next-page')).toBeDisabled();await page.locator('#change-filter').selectOption('added');await expect(page.locator('#changes-list button')).toHaveCount(0);await expect(page.locator('#selected-change')).toBeHidden();await page.locator('#change-filter').selectOption('all');await page.locator('#change-search').fill('/key119');await expect(page.locator('#changes-list button')).toHaveCount(1);await expect(page.locator('#selected-path')).toContainText('/key119');
});
test('source search treats punctuation literally and previous begins at the final match',async({page})=>{
  await page.goto('/yaml-diff/');await page.locator('#yaml1').fill('first: "[x]"\nsecond: "[x]"');await page.locator('summary').filter({hasText:'Find in source files'}).click();await page.locator('#find-query').fill('[x]');await page.locator('#find-previous').click();expect(await page.locator('#yaml1').evaluate((node:HTMLTextAreaElement)=>node.selectionStart)).toBeGreaterThan(12);await page.locator('#find-next').click();expect(await page.locator('#yaml1').evaluate((node:HTMLTextAreaElement)=>node.selectionStart)).toBe(8);
});
