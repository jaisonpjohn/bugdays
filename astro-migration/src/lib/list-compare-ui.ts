import { ShareManager } from './share.ts';
import { track, countBucket, sizeBucket } from './analytics.ts';
import { defaultListOptions, listActions, listCsv, listText, importListColumn, MAX_LIST_BYTES, validateListText } from './list-compare.ts';
import type { ListAction, ListOptions, ListReport } from './list-compare.ts';

function init() {
  const root = document.getElementById('list-workspace');
  if (!root || root.dataset.init) return;
  root.dataset.init = 'true';
  const life = new AbortController(), signal = life.signal;
  const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const a = el<HTMLTextAreaElement>('setA'), b = el<HTMLTextAreaElement>('setB'), output = el<HTMLTextAreaElement>('output');
  const ignoreCase = el<HTMLInputElement>('ignore-case'), trim = el<HTMLInputElement>('trim-spaces'), auto = el<HTMLInputElement>('auto-compare');
  const sort = el<HTMLSelectElement>('result-order'), search = el<HTMLInputElement>('result-search');
  const dedupe = el<HTMLInputElement>('dedupe'), ignoreBlank = el<HTMLInputElement>('ignore-blank'), ignoreZeros = el<HTMLInputElement>('ignore-zeros');
  const extraSpaces = el<HTMLInputElement>('extra-spaces'), unicodeNfc = el<HTMLInputElement>('unicode-nfc'), skipEmpty = el<HTMLInputElement>('skip-empty-files');
  const csvColumn = el<HTMLInputElement>('csv-column'), csvHeader = el<HTMLInputElement>('csv-header');
  let report: ListReport | null = null, action: ListAction = 'intersection', worker: Worker | null = null;
  let version = 0, timer: ReturnType<typeof setTimeout> | undefined, timeout: ReturnType<typeof setTimeout> | undefined;
  let trackedComparison = false, busy = false, fileVersion = 0;
  const fileTokens = { A: 0, B: 0 };
  const options = (): ListOptions => ({ ignoreCase: ignoreCase.checked, trim: trim.checked, order: sort.value as ListOptions['order'], dedupe: dedupe.checked, ignoreBlank: ignoreBlank.checked, ignoreZeros: ignoreZeros.checked, extraSpaces: extraSpaces.checked, unicodeNfc: unicodeNfc.checked });
  const status = (value: string) => { el('list-status').textContent = value; };
  function controls() {
    for (const id of ['copy-btn', 'download-txt', 'download-csv', 'download-json', 'share-comparison']) el<HTMLButtonElement>(id).disabled = !report || busy;
    el<HTMLButtonElement>('cancel-compare').hidden = !busy;
    root!.setAttribute('aria-busy', String(busy));
  }
  function stop() { version++; clearTimeout(timer); clearTimeout(timeout); worker?.terminate(); worker = null; busy = false; controls(); }
  function clearReport() {
    report = null; output.value = ''; el('result-label').textContent = '';
    el('result-empty').hidden = true;
    for (const id of ['setA-count', 'setB-count']) el(id).textContent = '';
    root!.querySelectorAll<HTMLElement>('[data-result-count]').forEach(node => { node.textContent = '—'; });
    controls();
  }
  function render() {
    el('union-label').textContent = dedupe.checked ? 'All unique' : 'All items';
    root!.querySelectorAll<HTMLButtonElement>('[data-result-action]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.resultAction === action));
    });
    if (!report) return;
    const all = report.results[action], query = search.value.toLowerCase();
    const visible = query ? all.filter(value => value.toLowerCase().includes(query)) : all;
    output.value = visible.map(value => value.trim() ? value : value.length ? '⟨whitespace-only line⟩' : '⟨empty line⟩').join('\n');
    const unique = dedupe.checked || action.startsWith('duplicates');
    el('result-label').textContent = query ? `${visible.length.toLocaleString()} of ${all.length.toLocaleString()} items shown` : `${all.length.toLocaleString()} ${unique ? 'unique ' : ''}${all.length === 1 ? 'item' : 'items'}`;
    el('result-title').textContent = action === 'union' && !dedupe.checked ? 'All items' : el<HTMLButtonElement>(action + '-btn').dataset.title!;
    el('result-hint').textContent = action === 'union' && !dedupe.checked ? 'Both lists combined, including repeated rows.' : el<HTMLButtonElement>(action + '-btn').dataset.hint!;
    for (const [id, summary] of [['setA-count', report.a], ['setB-count', report.b]] as const) el(id).textContent = `${summary.items.toLocaleString()} ${summary.items === 1 ? 'item' : 'items'} · ${summary.unique.toLocaleString()} unique · ${summary.repeats.toLocaleString()} ${summary.repeats === 1 ? 'repeat' : 'repeats'}`;
    root!.querySelectorAll<HTMLElement>('[data-result-count]').forEach(node => { node.textContent = report!.results[node.dataset.resultCount as ListAction].length.toLocaleString(); });
    el('result-empty').hidden = visible.length > 0;
    el('result-empty').textContent = all.length ? 'No items match this filter. Clear the search to see the full result.' : 'No items in this result. Try another view or change the matching options.';
    ShareManager.setLastAction(action); controls();
  }
  async function compare(user = false) {
    stop(); clearReport(); el('list-error').hidden = true;
    if (ignoreBlank.checked ? (!a.value.trim() && !b.value.trim()) : (!a.value && !b.value)) { status('Paste a list on either side, or load the example.'); return; }
    const id = version; busy = true; controls(); status('Comparing locally…');
    try {
      const module = await import('./list-compare.worker.ts?worker');
      if (signal.aborted || id !== version) return;
      worker = new module.default();
      const fail = (message: string) => { stop(); clearReport(); el('list-error').textContent = message; el('list-error').hidden = false; status('Check the input and try again.'); };
      worker.onerror = () => fail('The comparison worker could not start. Reload the page and try again.');
      worker.onmessage = event => {
        if (id !== version || signal.aborted) return;
        if (event.data.error) { fail(event.data.error); return; }
        clearTimeout(timeout); worker?.terminate(); worker = null; busy = false; report = event.data.report; render();
        status('Comparison ready. Copy or download the full selected result, or share both lists and settings.');
        if (user && !trackedComparison) {
          trackedComparison = true;
          track('tool_used', { tool: 'list-compare', action: 'compare', count: countBucket(report!.a.items + report!.b.items), size: sizeBucket(new TextEncoder().encode(a.value + b.value).length) });
        }
      };
      timeout = setTimeout(() => fail('Comparison timed out. Try smaller lists.'), 20_000);
      worker.postMessage({ id, a: a.value, b: b.value, options: options() });
    } catch { if (id === version && !signal.aborted) { stop(); clearReport(); el('list-error').textContent = 'Could not start the comparison. Reload and try again.'; el('list-error').hidden = false; } }
  }
  function changed() { stop(); clearReport(); render(); el('list-error').hidden = true; if (auto.checked) timer = setTimeout(() => compare(true), 250); else status('Inputs changed. Select Compare lists to refresh the result.'); }
  for (const node of [a, b]) node.addEventListener('input', () => { fileTokens[node === a ? 'A' : 'B']++; changed(); }, { signal });
  for (const node of [a, b]) node.addEventListener('paste', event => {
    const text = event.clipboardData?.getData('text/plain');
    if (!text || (text.length < 64_000 && text.split(/\r\n|\n|\r/, 2002).length < 2000)) return;
    // Large native insertions can stall Chromium before the input handler runs.
    event.preventDefault();
    fileTokens[node === a ? 'A' : 'B']++;
    const start = node.selectionStart, end = node.selectionEnd;
    const value = node.value.slice(0, start) + text + node.value.slice(end);
    try { validateListText(value, options()); node.value = value; node.setSelectionRange(start + text.length, start + text.length); changed(); }
    catch (error) { stop(); clearReport(); el('list-error').textContent = (error as Error).message; el('list-error').hidden = false; status('Paste was not inserted. Your previous input is unchanged.'); }
  }, { signal });
  for (const node of [ignoreCase, trim, sort, auto, dedupe, ignoreBlank, ignoreZeros, extraSpaces, unicodeNfc]) node.addEventListener('change', changed, { signal });
  el('compare-btn').addEventListener('click', () => compare(false), { signal });
  el('cancel-compare').addEventListener('click', () => { stop(); clearReport(); status('Comparison cancelled. Your inputs are unchanged.'); }, { signal });
  for (const name of listActions) el(name + '-btn').addEventListener('click', () => { action = name; if (report) render(); else compare(false); }, { signal });
  search.addEventListener('input', render, { signal });
  el('swap-lists').addEventListener('click', () => { fileVersion++; [a.value, b.value] = [b.value, a.value]; changed(); }, { signal });
  el('clear-lists').addEventListener('click', () => { fileVersion++; stop(); a.value = ''; b.value = ''; search.value = ''; clearReport(); el('list-error').hidden = true; status('Lists cleared.'); }, { signal });
  el('load-example').addEventListener('click', () => { fileVersion++; a.value = 'SKU-100\nSKU-101\nSKU-102\nSKU-102'; b.value = 'SKU-101\nSKU-103\nSKU-104'; changed(); }, { signal });
  for (const side of ['A', 'B'] as const) {
    const picker = el<HTMLInputElement>('file-' + side);
    el('open-' + side).addEventListener('click', () => picker.click(), { signal });
    picker.addEventListener('change', async () => {
      const file = picker.files?.[0], token = ++fileTokens[side], epoch = fileVersion; picker.value = ''; if (!file) return;
      try {
        if (file.size > MAX_LIST_BYTES) throw new Error('Each file supports up to 5 MiB.');
        let value = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
        if (signal.aborted || token !== fileTokens[side] || epoch !== fileVersion) return;
        const format = /\.csv$/i.test(file.name) || file.type === 'text/csv' ? 'csv' : /\.tsv$/i.test(file.name) || file.type === 'text/tab-separated-values' ? 'tsv' : 'txt';
        if (format !== 'txt') value = importListColumn(value, format === 'csv' ? ',' : '\t', csvColumn.valueAsNumber, csvHeader.checked);
        if (skipEmpty.checked && !value.trim()) { status('Skipped the empty or whitespace-only file. Your previous input is unchanged.'); track('import_skipped', { tool:'list-compare', format, reason:'empty' }); return; }
        validateListText(value, options());
        (side === 'A' ? a : b).value = value; changed();
        track('import_used', { tool: 'list-compare', format, size: sizeBucket(file.size) });
      } catch (error) { if (!signal.aborted && token === fileTokens[side] && epoch === fileVersion) { stop(); clearReport(); el('list-error').textContent = error instanceof TypeError ? 'Open a valid UTF-8 text file.' : (error as Error).message; el('list-error').hidden = false; status('File was not loaded. Your previous input is unchanged.'); } }
    }, { signal });
  }
  el('copy-btn').addEventListener('click', async () => {
    if (!report || busy) return;
    try { await navigator.clipboard.writeText(listText(report.results[action])); status('Copied the full selected result, including items hidden by search.'); track('copy_used', { tool: 'list-compare', action: action.toLowerCase() }); }
    catch { status('Clipboard unavailable. Download TXT to keep the exact result text.'); }
  }, { signal });
  for (const format of ['txt', 'csv', 'json'] as const) el('download-' + format).addEventListener('click', () => {
    if (!report || busy) return;
    const values = report.results[action], text = format === 'csv' ? listCsv(values) : format === 'json' ? JSON.stringify({ version:1, matching:options(), a:report.a, b:report.b, results:report.results }, null, 2) : listText(values);
    const url = URL.createObjectURL(new Blob([text], { type: format === 'csv' ? 'text/csv;charset=utf-8' : format === 'json' ? 'application/json' : 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `list-${action.toLowerCase()}.${format}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    track('export_used', { tool: 'list-compare', format });
  }, { signal });
  el('share-comparison').addEventListener('click', () => { ShareManager.setLastAction(action); el('share-btn')?.click(); }, { signal });
  ShareManager.register({ tool: 'list-compare', actions: { compare: () => { if (!signal.aborted && el('list-error').hidden) compare(false); }, ...Object.fromEntries(listActions.map(name => [name, () => { if (!signal.aborted && el('list-error').hidden) { action = name; report ? render() : compare(false); } }])) },
    customCollect: () => ({ setA: a.value, setB: b.value, ignoreCase: ignoreCase.checked, trimSpaces: trim.checked, order: sort.value, autoCompare: auto.checked, view: action, dedupe:dedupe.checked, ignoreBlank:ignoreBlank.checked, ignoreZeros:ignoreZeros.checked, extraSpaces:extraSpaces.checked, unicodeNfc:unicodeNfc.checked, skipEmptyFiles:skipEmpty.checked, csvColumn:csvColumn.value, csvHeader:csvHeader.checked }),
    customRestore: data => {
      fileVersion++; stop(); clearReport(); search.value = ''; el('list-error').hidden = true;
      const aValue = typeof data.setA === 'string' ? data.setA : '', bValue = typeof data.setB === 'string' ? data.setB : '';
      a.value = ''; b.value = '';
      ignoreCase.checked = data.ignoreCase === true; trim.checked = data.trimSpaces !== false; auto.checked = data.autoCompare !== false;
      dedupe.checked = data.dedupe !== false; ignoreBlank.checked = data.ignoreBlank !== false; ignoreZeros.checked = data.ignoreZeros === true;
      extraSpaces.checked = data.extraSpaces === true; unicodeNfc.checked = data.unicodeNfc === true; skipEmpty.checked = data.skipEmptyFiles !== false;
      csvHeader.checked = data.csvHeader === true;
      const column = Number(data.csvColumn ?? 1); csvColumn.value = Number.isInteger(column) && column >= 1 && column <= 1000 ? String(column) : '1';
      el<HTMLDetailsElement>('more-options').open = !dedupe.checked || !ignoreBlank.checked || ignoreZeros.checked || extraSpaces.checked || unicodeNfc.checked || !skipEmpty.checked || csvHeader.checked || csvColumn.value !== '1';
      sort.value = ['input', 'ascending', 'descending'].includes(data.order) ? data.order : defaultListOptions.order;
      action = listActions.includes(data.view) ? data.view : 'intersection';
      try { validateListText(aValue, options()); validateListText(bValue, options()); }
      catch (error) { el('list-error').textContent = (error as Error).message; el('list-error').hidden = false; status('This shared comparison exceeds the input limits.'); return; }
      a.value = aValue; b.value = bValue;
      compare(false);
    },
  });
  render(); controls();
  document.addEventListener('astro:before-swap', () => { fileVersion++; stop(); life.abort(); }, { once: true });
}
init(); document.addEventListener('astro:after-swap', init);
