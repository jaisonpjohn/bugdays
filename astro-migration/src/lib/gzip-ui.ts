import LZString from 'lz-string';
import { ShareManager } from './share.ts';
import { track, sizeBucket } from './analytics.ts';
import { bytesToBase64, GZIP_LIMITS, type GzipAction, type GzipRequest, type GzipEncoding, type GzipLevel } from './gzip-contract.ts';
import type { GzipResult } from './gzip-codec.ts';

function init() {
  const root = document.getElementById('gzip-workspace');
  if (!root || root.dataset.init) return;
  root.dataset.init = 'true';
  const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const input = el<HTMLTextAreaElement>('input'), output = el<HTMLTextAreaElement>('output');
  const encoding = el<HTMLSelectElement>('gzip-encoding'), level = el<HTMLSelectElement>('gzip-level');
  const auto = el<HTMLInputElement>('gzip-auto');
  let result: GzipResult | null = null, worker: Worker | null = null, sequence = 0, disposed = false;
  let lastAction: GzipAction = 'decompress', invalidSharedInput = false;
  let timer: ReturnType<typeof setTimeout>, timeout: ReturnType<typeof setTimeout>, counterFrame = 0;
  const bytesLabel = (n: number) => n < 1024 ? `${n.toLocaleString()} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 ** 2).toFixed(2)} MiB`;
  const notice = (text: string) => { el('gzip-notice').textContent = text; };
  function busy(value: boolean) {
    el('gzip-cancel').hidden = !value;
    for (const id of ['compress-btn', 'decompress-btn']) el<HTMLButtonElement>(id).disabled = value;
    root!.setAttribute('aria-busy', String(value));
  }
  function stop() { clearTimeout(timeout); worker?.terminate(); worker = null; sequence++; busy(false); }
  function counts() {
    counterFrame = 0;
    el('gzip-input-size').textContent = `${bytesLabel(new TextEncoder().encode(input.value).length)} input`;
    el<HTMLButtonElement>('gzip-share').disabled = !input.value && !result;
  }
  function invalidate() {
    clearTimeout(timer); stop(); result = null; output.value = ''; output.placeholder = 'Your result appears here…'; el('stats').hidden = true;
    el('gzip-error').hidden = true; el('gzip-error').textContent = ''; el('gzip-next').hidden = true;
    for (const id of ['copy-btn', 'gzip-download', 'gzip-download-gz', 'gzip-use-output']) el<HTMLButtonElement>(id).disabled = true;
    el('gzip-output-type').textContent = 'Result';
    el('gzip-status').textContent = input.value ? 'Ready. Choose decode or compress.' : 'Paste a payload, open a file, or try an example.';
    if (!counterFrame) counterFrame = requestAnimationFrame(counts);
  }
  function changed() {
    invalidate(); notice('');
    if (auto.checked && input.value) timer = setTimeout(() => run(lastAction), 600);
  }
  function state(): GzipRequest { return { input: input.value, action: lastAction, encoding: encoding.value as GzipEncoding, level: Number(level.value) as GzipLevel }; }
  function render(next: GzipResult) {
    result = next; output.value = next.action === 'compress' ? next.base64 : next.text ?? '';
    output.placeholder = next.content === 'binary' && next.action === 'decompress' ? 'Binary or non-UTF-8 content. Download output to preserve the exact bytes.' : 'Your result appears here…';
    el('gzip-output-type').textContent = next.action === 'compress' ? 'Base64 GZip' : next.content === 'binary' ? 'Binary / non-UTF-8' : `${next.content.toUpperCase()} · UTF-8`;
    el('gzip-status').textContent = next.action === 'compress' ? 'Compressed locally. Base64 output is ready to copy or share.' : next.content === 'binary' ? 'GZip decoded successfully. Download the original bytes; no replacement characters were inserted.' : 'Decoded successfully. The original UTF-8 text is unchanged.';
    const stats = el('stats'); stats.hidden = false; stats.replaceChildren();
    const difference = next.decoded.length ? 100 * (next.compressed.length / next.decoded.length - 1) : null;
    const rows = [
      ['Original bytes', bytesLabel(next.decoded.length)], ['GZip bytes', bytesLabel(next.compressed.length)],
      ['Base64 size', bytesLabel(next.base64.length)],
      ['GZip vs original', difference === null ? 'Empty input' : `${Math.abs(difference).toFixed(1)}% ${difference <= 0 ? 'smaller' : 'larger'}`],
    ];
    for (const [label, value] of rows) {
      const card = document.createElement('div'), title = document.createElement('span'), number = document.createElement('strong');
      card.className = 'gzip-stat'; title.textContent = label; number.textContent = value; card.append(title, number); stats.append(card);
    }
    for (const id of ['gzip-download', 'gzip-download-gz']) el<HTMLButtonElement>(id).disabled = false;
    for (const id of ['copy-btn', 'gzip-use-output']) el<HTMLButtonElement>(id).disabled = next.action === 'decompress' && next.text === null;
    el<HTMLButtonElement>('gzip-share').disabled = false;
    const nextButton = el<HTMLButtonElement>('gzip-next');
    nextButton.hidden = next.action !== 'decompress' || !['json', 'xml'].includes(next.content);
    nextButton.textContent = next.content === 'json' ? 'Inspect in JSON Formatter →' : 'Inspect in XML Formatter →';
    notice(next.notes.join(' '));
  }
  function run(action: GzipAction) {
    invalidate(); notice(''); lastAction = action; ShareManager.setLastAction(action);
    if (new TextEncoder().encode(input.value).length > GZIP_LIMITS.input) {
      showError('Keep encoded input under 3 MiB and text to compress under 2 MiB.'); return;
    }
    const id = ++sequence; busy(true); el('gzip-status').textContent = action === 'compress' ? 'Compressing locally…' : 'Decoding locally…';
    try {
      worker = new Worker(new URL('../workers/gzip.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = event => {
        if (disposed || event.data.id !== sequence) return;
        stop(); if (event.data.error) showError(event.data.error); else render(event.data.result);
      };
      worker.onerror = () => { stop(); showError('The local converter could not start. Reload the page or try an up-to-date browser.'); };
      timeout = setTimeout(() => { stop(); showError('Stopped after 8 seconds. Try a smaller payload; no partial result was kept.'); }, 8000);
      worker.postMessage({ id, request: state() });
    } catch { stop(); showError('This browser could not start background conversion. Try an up-to-date browser.'); }
  }
  function showError(message: string) { el('gzip-error').hidden = false; el('gzip-error').textContent = message; el('gzip-status').textContent = 'Input unchanged. Check the message below and try again.'; }
  input.addEventListener('input', changed);
  for (const setting of [encoding, level]) setting.addEventListener('change', changed);
  auto.addEventListener('change', () => { clearTimeout(timer); if (auto.checked && input.value) changed(); });
  el('compress-btn').addEventListener('click', () => run('compress'));
  el('decompress-btn').addEventListener('click', () => run('decompress'));
  el('gzip-cancel').addEventListener('click', () => { stop(); el('gzip-status').textContent = 'Conversion cancelled. Your input is unchanged.'; });
  el('clear-btn').addEventListener('click', () => {
    input.value = ''; lastAction = 'decompress'; ShareManager.setLastAction(lastAction); invalidate(); notice('');
    output.placeholder = 'Your result appears here…'; history.replaceState(null, '', location.pathname + location.search);
  });
  document.querySelectorAll<HTMLAnchorElement>('[data-gzip-example]').forEach(link => link.addEventListener('click', event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault(); input.value = link.dataset.exampleInput || ''; encoding.value = 'auto'; run('decompress');
    track('tool_used', { tool: 'gzip-base64', action: 'sample' });
  }));
  el('gzip-use-output').addEventListener('click', () => {
    if (!result) return;
    const action = result.action === 'compress' ? 'decompress' : 'compress';
    input.value = output.value; encoding.value = 'auto'; run(action);
  });
  el('copy-btn').addEventListener('click', async () => {
    if (!result) return;
    const version = sequence;
    try { await navigator.clipboard.writeText(output.value); if (version === sequence) notice('Output copied.'); track('export_used', { tool: 'gzip-base64', format: 'clipboard' }); }
    catch { if (version === sequence) notice('Clipboard access was blocked. Download the output or select it to copy.'); }
  });
  function download(bytes: Uint8Array | string, name: string, mime: string, format: string) {
    const url = URL.createObjectURL(new Blob([typeof bytes === 'string' ? bytes : new Uint8Array(bytes).buffer], { type: mime }));
    const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    track('export_used', { tool: 'gzip-base64', format, size: sizeBucket(typeof bytes === 'string' ? bytes.length : bytes.byteLength) });
  }
  el('gzip-download').addEventListener('click', () => {
    if (!result) return;
    if (result.action === 'compress') download(result.base64, 'gzip-base64.txt', 'text/plain;charset=utf-8', 'base64');
    else {
      const formats = { json: ['json', 'application/json'], xml: ['xml', 'application/xml'], text: ['txt', 'text/plain;charset=utf-8'], binary: ['bin', 'application/octet-stream'] };
      const [extension, mime] = formats[result.content]; download(result.decoded, `decoded-output.${extension}`, mime, extension);
    }
  });
  el('gzip-download-gz').addEventListener('click', () => { if (result) download(result.compressed, 'payload.gz', 'application/gzip', 'gzip'); });
  el('gzip-share').addEventListener('click', () => {
    if (new TextEncoder().encode(JSON.stringify(state())).length > 1024 * 1024) { notice('Share a smaller example (under 1 MiB), or download this result.'); return; }
    ShareManager.setLastAction(lastAction); document.getElementById('share-btn')?.click();
  });
  el('gzip-next').addEventListener('click', () => {
    if (!result?.text) return;
    if (result.decoded.length > 900_000) { notice('For larger output, download it and open the file in the formatter.'); return; }
    const json = result.content === 'json';
    // Automatic JSON.parse/stringify could round large IDs or discard duplicate keys.
    const state = { v: 1, t: json ? 'json-formatter' : 'xml-formatter', ...(json ? {} : { a: 'format' }), d: { [json ? 'json' : 'xml']: result.text } };
    const url = `/${json ? 'json-formatter' : 'xml-formatter'}/#lz:${LZString.compressToEncodedURIComponent(JSON.stringify(state))}`;
    location.assign(url);
  });
  async function loadFile(file: File) {
    invalidate(); const version = sequence;
    try {
      if (file.size > GZIP_LIMITS.input) throw new Error('Choose a file under 3 MiB; binary .gz files must be under 2 MiB.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (disposed || version !== sequence) return;
      const compressed = bytes[0] === 0x1f && bytes[1] === 0x8b;
      if (compressed || /\.gz$/i.test(file.name)) {
        if (bytes.length > GZIP_LIMITS.compressed) throw new Error('Choose a .gz file under 2 MiB.');
        input.value = bytesToBase64(bytes); encoding.value = 'base64'; run('decompress');
      } else {
        let text: string;
        try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
        catch { throw new Error('Open a UTF-8 text file or a GZip (.gz) file. This file is neither.'); }
        input.value = text; changed(); notice('Text file opened locally. Choose decode or compress; nothing was uploaded.');
      }
      track('tool_used', { tool: 'gzip-base64', action: 'file', size: sizeBucket(file.size) });
    } catch (error) { if (version === sequence && !disposed) showError((error as Error).message); }
  }
  const fileInput = el<HTMLInputElement>('gzip-file');
  fileInput.addEventListener('change', () => { const file = fileInput.files?.[0]; fileInput.value = ''; if (file) void loadFile(file); });
  const panel = el('gzip-input-panel');
  panel.addEventListener('dragover', event => { event.preventDefault(); panel.dataset.drag = 'true'; });
  panel.addEventListener('dragleave', () => { delete panel.dataset.drag; });
  panel.addEventListener('drop', event => { event.preventDefault(); delete panel.dataset.drag; const file = event.dataTransfer?.files[0]; if (file) void loadFile(file); });
  ShareManager.register({ tool: 'gzip-base64', actions: { compress: () => { if (!invalidSharedInput) run('compress'); }, decompress: () => { if (!invalidSharedInput) run('decompress'); } },
    beforeShare: () => ShareManager.setLastAction(lastAction),
    customCollect: () => ({ input: input.value, encoding: encoding.value, level: Number(level.value) }),
    customRestore(data) {
      invalidSharedInput = !data || typeof data.input !== 'string' || new TextEncoder().encode(data.input).length > GZIP_LIMITS.input;
      if (invalidSharedInput) { input.value = ''; invalidate(); showError('This shared input is invalid or exceeds 3 MiB. No partial data was restored.'); return; }
      input.value = data.input; encoding.value = ['auto', 'base64', 'hex'].includes(data.encoding) ? data.encoding : 'auto';
      level.value = [1, 6, 9].includes(Number(data.level)) ? String(data.level) : '6'; invalidate();
    },
  });
  counts();
  document.addEventListener('astro:before-swap', () => { disposed = true; clearTimeout(timer); stop(); cancelAnimationFrame(counterFrame); }, { once: true });
}
init();
document.addEventListener('astro:after-swap', init);
