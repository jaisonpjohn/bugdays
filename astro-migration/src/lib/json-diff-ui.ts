import { ShareManager } from './share.ts';
import { track } from './analytics.ts';
import { createJsonEditor } from './json-editor.ts';
import type { DiffOptions, DiffResult, JsonChange } from './json-diff.ts';

function init() {
  const root = document.getElementById('diff-workspace');
  if (!root || root.dataset.init) return;
  root.dataset.init = 'true';
  const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const lifetime = new AbortController(), signal = lifetime.signal;
  const on = (id: string, fn: () => void) => el(id).addEventListener('click', fn, { signal });
  const inputs = [el<HTMLTextAreaElement>('json1'), el<HTMLTextAreaElement>('json2')], editors = inputs.map(createJsonEditor);
  const keys = el<HTMLInputElement>('ignore-key-order'), arrays = el<HTMLInputElement>('ignore-array-order');
  const arrayKey = el<HTMLInputElement>('array-key'), ignoredPaths = el<HTMLTextAreaElement>('ignored-paths');
  const options = (): DiffOptions => ({ ignoreKeyOrder: keys.checked, ignoreArrayOrder: arrays.checked, arrayKey: arrayKey.value, ignoredPaths: ignoredPaths.value });
  let worker: Worker | null = null, sequence = 0, timer: ReturnType<typeof setTimeout>, debounce: ReturnType<typeof setTimeout>;
  let result: DiffResult | null = null, active = 0, visible: number[] = [], pageStart = 0;
  let errorSide: number | null = null, errorOffset: number | null = null;
  const fileSequence = [0, 0];
  const status = (text: string) => { el('diff-status').textContent = text; };
  function stop() {
    sequence++; worker?.terminate(); worker = null; clearTimeout(timer); clearTimeout(debounce);
    root!.setAttribute('aria-busy', 'false'); el('cancel-diff-btn').classList.add('hidden');
    el<HTMLButtonElement>('compare-btn').disabled = false; el<HTMLButtonElement>('format-btn').disabled = false;
    el<HTMLButtonElement>('share-diff-btn').disabled = !inputs.every(input => input.value.trim());
  }
  function hideError() { el('error-box').classList.add('hidden'); editors.forEach(editor => editor.clearError()); errorSide = errorOffset = null; }
  function invalidate() {
    stop(); hideError(); result = null; visible = []; pageStart = 0;
    el('results').classList.add('hidden'); el('stats').classList.add('hidden');
    el('diff-left').replaceChildren(); el('diff-right').replaceChildren(); el('changes-list').replaceChildren();
    status('Ready to compare. Inputs stay on this device.'); ShareManager.setLastAction('compare');
  }
  function showError(message: string, side: 'left' | 'right' | null = null, offset: number | null = null) {
    result = null; el('results').classList.add('hidden'); el('stats').classList.add('hidden');
    errorSide = side === null ? null : side === 'left' ? 0 : 1; errorOffset = offset;
    const before = errorSide === null || offset === null ? '' : inputs[errorSide].value.slice(0, offset);
    el('diff-error-text').textContent = (side ? `Invalid JSON in ${side} panel${offset === null ? '' : ` at line ${before.split('\n').length}, column ${offset - before.lastIndexOf('\n')}`}: ` : '') + message;
    el('error-box').classList.remove('hidden'); el('diff-error-jump').classList.toggle('hidden', errorSide === null || offset === null);
    if (errorSide !== null) editors[errorSide].showError(offset);
    status('Check the error. No partial comparison has been reported.');
  }
  on('diff-error-jump', () => { if (errorSide !== null && errorOffset !== null) editors[errorSide].focusPosition(errorOffset); });
  function run(action: 'compare' | 'format' = 'compare') {
    if (signal.aborted) return;
    invalidate();
    if (!inputs.every(input => input.value.trim())) { showError('Please enter JSON in both fields'); return; }
    const left = inputs[0].value, right = inputs[1].value, job = sequence;
    root!.setAttribute('aria-busy', 'true'); el('cancel-diff-btn').classList.remove('hidden');
    for (const id of ['compare-btn', 'format-btn', 'share-diff-btn']) el<HTMLButtonElement>(id).disabled = true;
    status(action === 'compare' ? 'Comparing locally… Cancel remains available.' : 'Formatting locally without rounding numbers…');
    try { worker = new Worker(new URL('../workers/json-diff.worker.ts', import.meta.url), { type: 'module' }); }
    catch { stop(); showError('Your browser could not start local processing. Reload and try again.'); return; }
    timer = setTimeout(() => { if (sequence === job) { stop(); showError('Processing took too long. Compare a smaller section.'); } }, 20_000);
    worker.onerror = () => { if (sequence === job) { stop(); showError('Local processing could not finish. Reload or try a smaller document.'); } };
    worker.onmessage = event => {
      if (job !== sequence || signal.aborted || left !== inputs[0].value || right !== inputs[1].value) return;
      stop();
      if (!event.data.ok) { showError(event.data.message, event.data.side, event.data.offset); return; }
      if (action === 'format') {
        editors[0].setValue(event.data.result.left); editors[1].setValue(event.data.result.right); refreshFind();
        status('Both documents formatted. Exact number tokens and duplicate members kept; Compare checks ambiguity.');
      } else { result = event.data.result; render(); }
    };
    worker.postMessage({ left, right, options: options(), action });
  }
  on('compare-btn', () => run()); on('format-btn', () => run('format'));
  on('cancel-diff-btn', () => { invalidate(); status('Cancelled. Your inputs are unchanged.'); });
  inputs.forEach((input, side) => input.addEventListener('input', () => { fileSequence[side]++; invalidate(); refreshFind(); }, { signal }));
  function settingsChanged(immediate = false) {
    const recompare = inputs.every(input => input.value.trim()); invalidate();
    if (recompare) { if (immediate) run(); else debounce = setTimeout(() => run(), 350); }
  }
  [keys, arrays].forEach(input => input.addEventListener('change', () => settingsChanged(true), { signal }));
  [arrayKey, ignoredPaths].forEach(input => input.addEventListener('input', () => settingsChanged(), { signal }));
  on('clear-btn', () => { fileSequence[0]++; fileSequence[1]++; editors.forEach(editor => editor.setValue('')); invalidate(); closeFind(); });
  on('swap-btn', () => {
    const hadResult = result !== null; fileSequence[0]++; fileSequence[1]++;
    const old = inputs[0].value; editors[0].setValue(inputs[1].value); editors[1].setValue(old); invalidate(); refreshFind(); if (hadResult) run();
  });
  on('sample-btn', () => {
    fileSequence[0]++; fileSequence[1]++;
    editors[0].setValue('{"items":[{"id":"ORD-42","status":"queued","total":9007199254740993},{"id":"ORD-43","status":"paid","total":12.50}],"updatedAt":"2026-10-06"}');
    editors[1].setValue('{"items":[{"id":"ORD-43","status":"paid","total":12.50},{"id":"ORD-42","status":"paid","total":9007199254740994}],"updatedAt":"2026-10-07"}');
    keys.checked = true; arrays.checked = false; arrayKey.value = 'id'; ignoredPaths.value = 'updatedAt';
    el<HTMLDetailsElement>('diff-advanced').open = true; invalidate(); closeFind(); run();
  });
  for (const id of ['share-diff-btn', 'share-result-btn']) on(id, () => { ShareManager.setLastAction('compare'); el('share-btn')?.click(); });

  function render() {
    if (!result) return;
    const changes = result.changes, stats = el('stats');
    const added = changes.filter(c => c.type === 'added').length, removed = changes.filter(c => c.type === 'removed').length, modified = changes.length - added - removed;
    stats.replaceChildren();
    const summary = document.createElement('strong'); summary.textContent = changes.length ? `Found ${changes.length} difference${changes.length === 1 ? '' : 's'}` : '✓ No differences';
    stats.append(summary, document.createTextNode(changes.length ? `: ${added} added, ${removed} removed, ${modified} changed` : ' — JSON values match with these settings.'));
    stats.className = 'mb-3 rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-900 dark:border-indigo-800 dark:bg-indigo-950/30 dark:text-indigo-100';
    el('diff-left').innerHTML = result.leftHtml; el('diff-right').innerHTML = result.rightHtml;
    el('results').classList.remove('hidden'); el('change-nav').classList.remove('hidden');
    el<HTMLButtonElement>('export-patch-btn').disabled = result.patch === null;
    el('patch-note').textContent = result.patchReason || 'JSON Patch uses RFC 6902 add / remove / replace operations, from original to modified. Numeric spelling and whitespace are not changes.';
    el<HTMLInputElement>('change-filter').value = ''; active = 0; pageStart = 0; filterChanges();
    status(`${changes.length} differences · exact decimal comparison${result.ignored ? ` · ${result.ignored} ignored values across both inputs` : ''}${result.previewLimited ? ' · previews limited; all changes and full inputs remain available.' : ' · select a changed path to inspect it.'}`);
  }
  const truncate = (text: string, length = 100) => text.length > length ? text.slice(0, length) + '…' : text;
  function filterChanges() {
    const query = el<HTMLInputElement>('change-filter').value.toLocaleLowerCase();
    visible = (result?.changes ?? []).map((_, i) => i).filter(i => result!.changes[i].path.toLocaleLowerCase().includes(query));
    pageStart = 0; renderList();
    if (visible.length) focusChange(visible.includes(active) ? active : visible[0], false);
    else { el('selected-change').classList.add('hidden'); el('change-position').textContent = result?.changes.length ? 'No paths match this filter' : 'No differences'; }
    for (const id of ['change-prev', 'change-next']) el<HTMLButtonElement>(id).disabled = !visible.length;
  }
  function renderList() {
    const list = el('changes-list'); list.replaceChildren();
    for (const index of visible.slice(pageStart, pageStart + 50)) {
      const change = result!.changes[index], row = document.createElement('div'), button = document.createElement('button');
      row.className = 'rounded-lg border-l-4 p-3 font-mono text-sm leading-relaxed ' + (change.type === 'added' ? 'border-green-500 bg-green-50 dark:bg-green-950/40' : change.type === 'removed' ? 'border-red-500 bg-red-50 dark:bg-red-950/40' : 'border-purple-500 bg-purple-50 dark:bg-purple-950/40');
      button.type = 'button'; button.dataset.changeIndex = String(index);
      button.className = 'text-left break-all text-indigo-700 underline decoration-indigo-300 underline-offset-2 hover:text-indigo-900 dark:text-indigo-300 dark:hover:text-indigo-100';
      button.textContent = truncate(change.path, 1000);
      row.append(document.createTextNode(change.type === 'added' ? '+ ' : change.type === 'removed' ? '− ' : '~ '), button);
      row.append(document.createTextNode(change.oldRaw === undefined ? ' = ' + truncate(change.newRaw!) : change.newRaw === undefined ? ' was ' + truncate(change.oldRaw) : ' changed from ' + truncate(change.oldRaw) + ' → ' + truncate(change.newRaw)));
      list.append(row);
    }
    if (!visible.length) list.textContent = result?.changes.length ? 'No matching paths.' : 'No differences with these comparison settings.';
    el('changes-more').classList.toggle('hidden', visible.length <= 50);
    el('changes-more').textContent = `Next 50 changes · showing ${pageStart + 1}–${Math.min(pageStart + 50, visible.length)} of ${visible.length}`;
  }
  function focusChange(index: number, scroll = true) {
    if (!result || !result.changes[index]) return;
    active = index; const c = result.changes[index], position = visible.indexOf(index);
    if (position >= 0 && (position < pageStart || position >= pageStart + 50)) { pageStart = Math.floor(position / 50) * 50; renderList(); }
    el('change-position').textContent = `Change ${index + 1} / ${result.changes.length} · ${truncate(c.path, 1000)}`;
    root!.querySelectorAll('mark.diff-focus').forEach(mark => mark.classList.remove('diff-focus'));
    const matches = root!.querySelectorAll<HTMLElement>(`mark[data-change-index="${index}"]`); matches.forEach(mark => mark.classList.add('diff-focus'));
    el('changes-list').querySelectorAll<HTMLElement>('[data-change-index]').forEach(button => { const selected = Number(button.dataset.changeIndex) === index; button.classList.toggle('font-bold', selected); button.setAttribute('aria-current', String(selected)); });
    el('selected-change').classList.remove('hidden');
    el('selected-path').textContent = `Original: ${c.oldPointer === undefined ? '(absent)' : c.oldPointer || '(root)'} → Modified: ${c.newPointer === undefined ? '(absent)' : c.newPointer || '(root)'}`;
    el('selected-value').textContent = (c.oldRaw === undefined ? '' : 'Before: ' + truncate(c.oldRaw, 2000) + '\n') + (c.newRaw === undefined ? '' : 'After: ' + truncate(c.newRaw, 2000)) + '\nCopy actions include the complete exact value.';
    for (const id of ['copy-old-btn', 'jump-old-btn']) el<HTMLButtonElement>(id).disabled = c.oldRaw === undefined;
    for (const id of ['copy-new-btn', 'jump-new-btn']) el<HTMLButtonElement>(id).disabled = c.newRaw === undefined;
    if (scroll) {
      if (matches.length) matches[0].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      else { const side = c.newOffset === undefined ? 0 : 1; editors[side].focusPosition(side === 0 ? c.oldOffset! : c.newOffset!); }
    }
  }
  const selected = (): JsonChange | undefined => result?.changes[active];
  const previews = [el('diff-left'), el('diff-right')];
  previews.forEach((view, side) => view.addEventListener('scroll', () => {
    if (!el<HTMLInputElement>('sync-previews').checked) return;
    const other = previews[1 - side], max = view.scrollHeight - view.clientHeight;
    const target = max > 0 ? view.scrollTop / max * (other.scrollHeight - other.clientHeight) : 0;
    if (Math.abs(other.scrollTop - target) > 1) other.scrollTop = target;
  }, { signal }));
  const nextChange = (delta: number) => { if (visible.length) focusChange(visible[(visible.indexOf(active) + delta + visible.length) % visible.length]); };
  on('change-prev', () => nextChange(-1)); on('change-next', () => nextChange(1));
  on('changes-more', () => { pageStart = pageStart + 50 >= visible.length ? 0 : pageStart + 50; renderList(); focusChange(visible[pageStart], false); });
  el('change-filter').addEventListener('input', filterChanges, { signal });
  el('changes-list').addEventListener('click', event => { const button = (event.target as HTMLElement).closest<HTMLElement>('[data-change-index]'); if (button) focusChange(Number(button.dataset.changeIndex)); }, { signal });
  async function copy(text: string | undefined) {
    if (text === undefined) return;
    try { await navigator.clipboard.writeText(text); if (!signal.aborted) status('Copied the complete exact value or path.'); }
    catch { status('Clipboard access was unavailable. Use Download report or select the text.'); }
  }
  on('copy-old-btn', () => { void copy(selected()?.oldRaw); }); on('copy-new-btn', () => { void copy(selected()?.newRaw); });
  on('copy-pointer-btn', () => { const c = selected(); void copy(c?.newPointer ?? c?.oldPointer); });
  on('jump-old-btn', () => { const c = selected(); if (c?.oldOffset !== undefined) editors[0].focusPosition(c.oldOffset); });
  on('jump-new-btn', () => { const c = selected(); if (c?.newOffset !== undefined) editors[1].focusPosition(c.newOffset); });
  function download(text: string | null | undefined, patch = false) {
    if (text == null) return;
    track('export_used', { tool: 'json-diff', format: patch ? 'json-patch' : 'json' });
    const url = URL.createObjectURL(new Blob([text], { type: patch ? 'application/json-patch+json' : 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = patch ? 'json-diff.patch.json' : 'json-diff-report.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  on('export-report-btn', () => download(result?.report)); on('export-patch-btn', () => download(result?.patch, true));

  inputs.forEach((_, side) => {
    const fileInput = el<HTMLInputElement>(`json${side + 1}-file`), shell = inputs[side].closest<HTMLElement>('[data-json-editor]')!;
    async function loadFile(file: File) {
      const id = ++fileSequence[side]; invalidate();
      if (file.size > 10 * 1024 ** 2) { showError('Choose a JSON file no larger than 10 MiB.'); return; }
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
        if (id !== fileSequence[side] || signal.aborted) return;
        editors[side].setValue(text); invalidate(); refreshFind();
        el(`json${side + 1}-file-status`).textContent = `Loaded ${Math.max(1, Math.round(file.size / 1024))} KiB locally. Nothing was uploaded.`;
      } catch { if (id === fileSequence[side] && !signal.aborted) showError('The file could not be read as UTF-8 JSON. Your input is unchanged.'); }
    }
    on(`json${side + 1}-file-btn`, () => fileInput.click());
    fileInput.addEventListener('change', () => { const file = fileInput.files?.[0]; if (file) void loadFile(file); fileInput.value = ''; }, { signal });
    for (const type of ['dragenter', 'dragover']) shell.addEventListener(type, event => { event.preventDefault(); shell.classList.add('json-editor-drop-target'); }, { signal });
    for (const type of ['dragleave', 'drop']) shell.addEventListener(type, event => { event.preventDefault(); shell.classList.remove('json-editor-drop-target'); }, { signal });
    shell.addEventListener('drop', event => { const file = event.dataTransfer?.files?.[0]; if (file) void loadFile(file); }, { signal });
  });
  const findInput = el<HTMLInputElement>('diff-find-input'), findScope = el<HTMLSelectElement>('diff-find-scope');
  let findIndex = 0, findTargets: Array<{ side: number; index: number }> = [];
  function refreshFind(focus = false) {
    const counts = editors.map((editor, side) => editor.setSearch(findScope.value === 'both' || findScope.value === (side === 0 ? 'original' : 'modified') ? findInput.value : '', -1));
    findTargets = counts.flatMap((count, side) => Array.from({ length: count }, (_, index) => ({ side, index })));
    findIndex = findTargets.length ? (findIndex + findTargets.length) % findTargets.length : 0;
    el('diff-find-count').textContent = !findInput.value ? '' : !findTargets.length ? 'No matches' : `${findIndex + 1} / ${findTargets.length}${counts.some(n => n === 500) ? '+' : ''}`;
    const current = findTargets[findIndex];
    if (current) {
      editors[current.side].setSearch(findInput.value, current.index);
      if (focus) editors[current.side].focusMatch(current.index);
    }
  }
  function closeFind() { el('diff-find-bar').classList.add('hidden'); findInput.value = ''; findIndex = 0; refreshFind(); }
  function openFind() { el('diff-find-bar').classList.remove('hidden'); findInput.focus(); findInput.select(); refreshFind(); }
  on('diff-find-btn', openFind); on('diff-find-close', closeFind);
  findInput.addEventListener('input', () => { findIndex = 0; refreshFind(); }, { signal }); findScope.addEventListener('change', () => { findIndex = 0; refreshFind(); }, { signal });
  on('diff-find-next', () => { findIndex++; refreshFind(true); }); on('diff-find-prev', () => { findIndex = (findIndex - 1 + findTargets.length) % Math.max(1, findTargets.length); refreshFind(true); });
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && el('share-modal')?.classList.contains('hidden')) { event.preventDefault(); openFind(); }
    if (event.key === 'Escape') closeFind();
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && root!.contains(document.activeElement)) { event.preventDefault(); run(); }
  }, { signal });
  ShareManager.register({ tool: 'json-diff', actions: { compare: () => run() }, beforeShare: () => ShareManager.setLastAction('compare'),
    customCollect: () => ({ json1: inputs[0].value, json2: inputs[1].value, ...options() }),
    customRestore: data => {
      fileSequence[0]++; fileSequence[1]++; closeFind();
      editors[0].setValue(typeof data.json1 === 'string' ? data.json1 : ''); editors[1].setValue(typeof data.json2 === 'string' ? data.json2 : '');
      keys.checked = data.ignoreKeyOrder !== false; arrays.checked = data.ignoreArrayOrder === true;
      arrayKey.value = typeof data.arrayKey === 'string' ? data.arrayKey.slice(0, 200) : ''; ignoredPaths.value = typeof data.ignoredPaths === 'string' ? data.ignoredPaths.slice(0, 100100) : '';
      el<HTMLDetailsElement>('diff-advanced').open = !!(arrayKey.value || ignoredPaths.value); invalidate();
    },
  });
  stop();
  document.addEventListener('astro:before-swap', () => { fileSequence[0]++; fileSequence[1]++; stop(); lifetime.abort(); editors.forEach(editor => editor.destroy()); }, { once: true });
}
init(); document.addEventListener('astro:after-swap', init);
