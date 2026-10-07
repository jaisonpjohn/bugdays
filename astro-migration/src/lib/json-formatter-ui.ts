import { ShareManager } from './share.ts';
import { track } from './analytics.ts';
import { createJsonEditor } from './json-editor.ts';
import type { FormatterAction, FormatterResult, JsonTreeNode } from './json-formatter.ts';

function init() {
  const root = document.getElementById('formatter-workspace');
  if (!root || root.dataset.init) return;
  root.dataset.init = 'true';
  const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const input = el<HTMLTextAreaElement>('editor'), editor = createJsonEditor(input);
  const indent = el<HTMLSelectElement>('json-indent'), tree = el('tree-view');
  const lifetime = new AbortController(), signal = lifetime.signal;
  const on = (id: string, handler: () => void) => el(id).addEventListener('click', handler, { signal });
  let worker: Worker | null = null, sequence = 0, timer: ReturnType<typeof setTimeout>, statusFrame = 0;
  let undo: string | null = null, errorOffset: number | null = null, last: FormatterAction = 'validate';
  let source = '', nodes: JsonTreeNode[] = [], rendered = 0;
  let selected = { jq: '.', pointer: '', value: '' };
  const status = (message: string) => { el('formatter-status').textContent = message; };
  function stop() {
    sequence++; worker?.terminate(); worker = null; clearTimeout(timer);
    root!.setAttribute('aria-busy', 'false'); el('cancel-btn').classList.add('hidden');
    for (const id of ['prettify-btn', 'compact-btn', 'validate-btn', 'tree-btn', 'share-json-btn']) el<HTMLButtonElement>(id).disabled = false;
    el<HTMLButtonElement>('share-json-btn').disabled = !input.value;
  }
  function textView() {
    el('editor-view').classList.remove('hidden'); el('text-buttons').classList.remove('hidden');
    tree.classList.add('hidden'); el('tree-buttons').classList.add('hidden'); el('path-tooltip').classList.add('hidden');
  }
  function hideError() { el('error-box').classList.add('hidden'); errorOffset = null; editor.clearError(); }
  function showError(message: string, offset: number | null = null) {
    textView(); errorOffset = offset;
    const before = offset === null ? '' : input.value.slice(0, offset);
    el('error-text').textContent = (offset === null ? '' : `Line ${before.split('\n').length}, column ${offset - before.lastIndexOf('\n')}: `) + message;
    el('error-box').classList.remove('hidden'); el('error-jump-btn').classList.toggle('hidden', offset === null);
    editor.showError(offset); status('Check the highlighted error. Your input is unchanged.');
  }
  function counts() {
    statusFrame = 0;
    const bytes = new TextEncoder().encode(input.value).length;
    el('json-size').textContent = `${bytes < 1024 ? bytes + ' B' : bytes < 1024 ** 2 ? (bytes / 1024).toFixed(1) + ' KiB' : (bytes / 1024 ** 2).toFixed(2) + ' MiB'} · ${input.value.split('\n').length.toLocaleString()} lines`;
    el<HTMLButtonElement>('undo-btn').disabled = undo === null;
    el<HTMLButtonElement>('share-json-btn').disabled = !!worker || !input.value;
    for (const id of ['copy-btn', 'download-btn']) el<HTMLButtonElement>(id).disabled = !input.value;
  }
  function invalidate() {
    stop(); textView(); hideError(); nodes = []; source = ''; tree.replaceChildren();
    el('json-findings').classList.add('hidden');
    status(input.value ? 'Ready to format or validate.' : 'Paste JSON, open a file, or try the sample.');
    if (!statusFrame) statusFrame = requestAnimationFrame(counts);
    last = 'validate'; ShareManager.setLastAction(last);
  }
  input.addEventListener('input', () => { fileSequence++; invalidate(); }, { signal });
  indent.addEventListener('change', () => {
    stop(); if (last === 'prettify' && input.value) run('prettify');
  }, { signal });
  function findings(result: FormatterResult) {
    const count = result.duplicates + result.largeNumbers;
    el('json-findings').classList.toggle('hidden', !count);
    el('json-findings-summary').textContent = `${result.duplicates} duplicate keys · ${result.largeNumbers} large numbers · all kept exactly`;
    const list = el('json-findings-list'); list.replaceChildren();
    for (const finding of result.findings) { const row = document.createElement('li'); row.textContent = finding.message; list.append(row); }
    if (count > result.findings.length) { const row = document.createElement('li'); row.textContent = 'Showing the first 20 interoperability notes.'; list.append(row); }
  }
  function run(action: FormatterAction) {
    stop(); hideError(); last = action; ShareManager.setLastAction(action);
    const text = input.value, job = sequence;
    status('Working locally…'); root!.setAttribute('aria-busy', 'true'); el('cancel-btn').classList.remove('hidden');
    for (const id of ['prettify-btn', 'compact-btn', 'validate-btn', 'tree-btn', 'share-json-btn']) el<HTMLButtonElement>(id).disabled = true;
    try { worker = new Worker(new URL('../workers/json-formatter.worker.ts', import.meta.url), { type: 'module' }); }
    catch { stop(); showError('Your browser could not start local processing. Reload and try again.'); return; }
    timer = setTimeout(() => { if (sequence === job) { stop(); showError('Processing took too long. Try a smaller document.'); } }, 20_000);
    worker.onerror = () => { if (sequence === job) { stop(); showError('Local processing could not finish. Reload or try a smaller document.'); } };
    worker.onmessage = event => {
      if (sequence !== job || input.value !== text) return;
      stop();
      if (!event.data.ok) { showError(event.data.message, event.data.offset); return; }
      const result = event.data.result as FormatterResult;
      if (action === 'prettify' || action === 'compact') {
        textView();
        if (result.text !== text) { undo = text; editor.setValue(result.text); }
        refreshFind();
      } else if (action === 'tree') {
        source = text; nodes = result.nodes!; rendered = 0; tree.replaceChildren();
        tree.append(renderNode(0, '.', '', 0));
        el('editor-view').classList.add('hidden'); el('text-buttons').classList.add('hidden');
        tree.classList.remove('hidden'); el('tree-buttons').classList.remove('hidden');
        el('formatter-find-bar').classList.add('hidden'); el('path-tooltip').classList.add('hidden');
      }
      findings(result); counts();
      status(`Valid JSON · ${result.values.toLocaleString()} values · ${result.depth} levels. ${action === 'tree' ? 'Select a key or value to copy paths. Large branches load in batches.' : action === 'validate' ? 'Input unchanged.' : 'Only formatting whitespace changed.'}${input.closest('[data-json-editor]')?.classList.contains('json-editor-plain') ? ' Text-only display for this large document; search and line numbers still work.' : ''}`);
    };
    worker.postMessage({ text, action, indent: indent.value });
  }
  for (const action of ['prettify', 'compact', 'validate', 'tree'] as FormatterAction[]) on(action === 'tree' ? 'tree-btn' : action === 'validate' ? 'validate-btn' : action + '-btn', () => run(action));
  on('cancel-btn', () => { stop(); status('Cancelled. Your input is unchanged.'); });
  on('back-btn', () => { textView(); last = 'validate'; ShareManager.setLastAction(last); });
  on('error-jump-btn', () => { if (errorOffset !== null) editor.focusPosition(errorOffset); });
  on('share-json-btn', () => el('share-btn')?.click());
  on('undo-btn', () => {
    if (undo === null) return;
    const previous = undo; undo = null; editor.setValue(previous); invalidate(); refreshFind(); counts(); status('Original text restored.');
  });
  on('clear-btn', () => { if (input.value) undo = input.value; editor.setValue(''); invalidate(); refreshFind(); counts(); });
  on('sample-btn', () => {
    if (input.value) undo = input.value;
    editor.setValue('{"orders":[{"id":"ORD-42","status":"paid","total":29.5,"items":["notebook","pen"]}],"pagination":{"page":1,"hasNext":false}}');
    invalidate(); run('prettify');
  });
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); if (signal.aborted) return; el('copied-msg').classList.remove('hidden'); setTimeout(() => { if (!signal.aborted) el('copied-msg').classList.add('hidden'); }, 1600); }
    catch { status('Clipboard access was unavailable. Select the text or use Download.'); }
  }
  on('copy-btn', () => { void copy(input.value); });
  on('download-btn', () => {
    if (!input.value) { status('Paste a document before downloading.'); return; }
    track('export_used', { tool: 'json-formatter', format: 'json' });
    const url = URL.createObjectURL(new Blob([input.value], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'formatted.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  function renderNode(index: number, path: string, pointer: string, level: number): HTMLElement {
    rendered++;
    const node = nodes[index], block = document.createElement('div'), row = document.createElement('div');
    row.className = 'json-tree-row'; block.append(row);
    const value = document.createElement('button'); value.className = 'json-tree-value'; value.dataset.path = path;
    const raw = source.slice(node.offset, node.offset + node.length);
    const preview = node.children ? `${node.type === 'array' ? '[' : '{'}${node.children.length} ${node.type === 'array' ? 'items]' : 'keys}'}` : raw.length > 300 ? raw.slice(0, 300) + '…' : raw;
    if (node.key !== undefined) {
      const key = document.createElement('span'); key.className = 'json-tree-key';
      key.textContent = (node.key.length > 120 ? JSON.stringify(node.key.slice(0, 120)) + '…' : JSON.stringify(node.key)) + ': ';
      value.append(key);
    }
    value.append(document.createTextNode(preview));
    value.addEventListener('click', () => {
      selected = { jq: path, pointer, value: raw }; el('path-text').textContent = path;
      el('pointer-text').textContent = pointer || 'JSON Pointer: empty string (root)'; el('path-tooltip').classList.remove('hidden');
    }, { signal });
    if (node.children?.length) {
      const toggle = document.createElement('button'); toggle.className = 'json-tree-toggle'; toggle.textContent = '▶'; toggle.setAttribute('aria-label', `Expand ${node.type}`); toggle.setAttribute('aria-expanded', 'false');
      const children = document.createElement('div'); children.className = 'json-tree-children hidden';
      let loaded = 0;
      const more = document.createElement('button'); more.className = 'json-tree-more';
      function batch() {
        more.remove(); const end = Math.min(loaded + 50, node.children!.length);
        while (loaded < end && rendered < 1500) {
          const childIndex = node.children![loaded++], key = nodes[childIndex].key!;
          const childPath = node.type === 'array' ? `${path}[${key}]` : /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `${path === '.' ? '.' : path + '.'}${key}` : `${path}[${JSON.stringify(key)}]`;
          children.append(renderNode(childIndex, childPath, `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, level + 1));
        }
        if (loaded < node.children!.length) {
          more.textContent = rendered >= 1500 ? 'Tree display limit reached. Use Find in text for the rest.' : `Load next ${Math.min(50, node.children!.length - loaded)} (${loaded} / ${node.children!.length})`;
          more.disabled = rendered >= 1500; children.append(more);
        }
      }
      const setOpen = (open: boolean) => {
        if (open && !loaded) batch();
        children.classList.toggle('hidden', !open); toggle.textContent = open ? '▼' : '▶';
        toggle.setAttribute('aria-expanded', String(open)); toggle.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} ${node.type}`);
      };
      toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'), { signal });
      more.addEventListener('click', batch, { signal }); row.append(toggle, value); block.append(children);
      if (level < 4 && rendered < 200) setOpen(true);
    } else row.append(value);
    return block;
  }
  on('expand-btn', () => {
    for (let pass = 0; pass < 128; pass++) {
      const collapsed = tree.querySelectorAll<HTMLButtonElement>('.json-tree-toggle[aria-expanded="false"]');
      if (!collapsed.length || rendered >= 1500) break;
      collapsed.forEach(button => { if (rendered < 1500) button.click(); });
    }
    status('Expanded loaded branches. Long lists have Load next controls; at most 1,500 values are displayed.');
  });
  on('collapse-btn', () => tree.querySelectorAll<HTMLButtonElement>('.json-tree-toggle[aria-expanded="true"]').forEach(button => button.click()));
  on('path-copy-btn', () => { void copy(selected.jq); });
  // Preserve the old tooltip click target for existing integrations; child buttons are distinct actions.
  el('path-tooltip').addEventListener('click', event => { if (!(event.target as HTMLElement).closest('button')) void copy(selected.jq); }, { signal });
  on('pointer-copy-btn', () => { void copy(selected.pointer); }); on('value-copy-btn', () => { void copy(selected.value); });

  const fileInput = el<HTMLInputElement>('json-file');
  let fileSequence = 0;
  async function loadFile(file: File) {
    const id = ++fileSequence; stop();
    if (file.size > 10 * 1024 ** 2) { showError('Choose a JSON file no larger than 10 MiB.'); return; }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (id !== fileSequence || signal.aborted) return;
      if (input.value) undo = input.value;
      editor.setValue(text); invalidate(); refreshFind(); counts();
      el('file-status').textContent = `Loaded ${Math.max(1, Math.round(file.size / 1024))} KiB locally. Nothing was uploaded.`;
      run('validate');
    } catch { if (id === fileSequence) showError('Could not read this file as UTF-8. Convert its encoding and try again.'); }
  }
  on('file-btn', () => fileInput.click());
  fileInput.addEventListener('change', () => { const file = fileInput.files?.[0]; if (file) void loadFile(file); fileInput.value = ''; }, { signal });
  const shell = input.closest<HTMLElement>('[data-json-editor]')!;
  for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) shell.addEventListener(type, event => {
    event.preventDefault(); shell.classList.toggle('json-editor-drop-target', type === 'dragenter' || type === 'dragover');
    if (type === 'drop') { const file = (event as DragEvent).dataTransfer?.files?.[0]; if (file) void loadFile(file); }
  }, { signal });

  const findInput = el<HTMLInputElement>('formatter-find-input'); let findIndex = 0;
  function refreshFind(focus = false) {
    const count = editor.setSearch(findInput.value, findIndex); findIndex = count ? findIndex % count : 0;
    el('formatter-find-count').textContent = !findInput.value ? '' : count ? `${findIndex + 1} / ${count}${count === 500 ? '+' : ''}` : 'No matches';
    if (focus && count) editor.focusMatch(findIndex);
  }
  function openFind() { textView(); el('formatter-find-bar').classList.remove('hidden'); findInput.focus(); findInput.select(); refreshFind(); }
  function closeFind() { el('formatter-find-bar').classList.add('hidden'); findInput.value = ''; findIndex = 0; refreshFind(); }
  on('find-btn', openFind); on('formatter-find-close', closeFind);
  findInput.addEventListener('input', () => { findIndex = 0; refreshFind(); }, { signal });
  input.addEventListener('input', () => { if (findInput.value) refreshFind(); }, { signal });
  for (const [id, step] of [['formatter-find-next', 1], ['formatter-find-prev', -1]] as const) on(id, () => { const count = editor.getMatches().length; if (count) { findIndex = (findIndex + step + count) % count; refreshFind(true); } });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); openFind(); }
    if (event.key === 'Escape') closeFind();
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && root!.contains(document.activeElement)) { event.preventDefault(); run('prettify'); }
  }, { signal });
  ShareManager.register({ tool: 'json-formatter',
    customCollect: () => ({ json: input.value, indent: indent.value }),
    customRestore: data => {
      fileSequence++; undo = null; closeFind(); editor.setValue(typeof data.json === 'string' ? data.json : '');
      indent.value = ['2', '4', 'tab'].includes(data.indent) ? data.indent : '2'; invalidate(); counts();
      el('file-status').textContent = 'Shared example loaded locally. Nothing is uploaded by formatting.';
    },
    actions: Object.fromEntries((['prettify', 'compact', 'validate', 'tree'] as FormatterAction[]).map(action => [action, () => run(action)])),
  });
  counts();
  document.addEventListener('astro:before-swap', () => { fileSequence++; stop(); lifetime.abort(); editor.destroy(); cancelAnimationFrame(statusFrame); }, { once: true });
}
init(); document.addEventListener('astro:after-swap', init);
