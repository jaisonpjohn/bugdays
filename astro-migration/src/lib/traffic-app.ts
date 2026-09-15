import { ShareManager } from './share';
import { feedDefinitions } from './ip-datasets';
import type { IpDataset } from './ip-datasets';
import { mergeIpDatasets } from './ip-range-database';
import { filterIpRows, reportShareSnapshot, validateReport, ipTableRows, csvTable, safeSpreadsheetCell } from './traffic-analysis';
import type { TrafficReport, IpRow, CountRow, TrafficMode } from './traffic-analysis';
import { createXlsxBlob } from './spreadsheet-export';

const escapeHtml = (value: unknown) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const number = (value: number) => value.toLocaleString();
const date = (value: string | number) => { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? 'Unknown date' : parsed.toLocaleString(undefined, { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' UTC'; };
const sourceName = (id: string) => feedDefinitions.find(feed => feed.id === id)?.name || id;
const categoryLabel = (category: string) => ({ cloud: 'Cloud range', hosting: 'Hosting / VPS range', cdn: 'CDN / proxy', crawler: 'Crawler range', service: 'Service network', special: 'Special-use IP', unmatched: 'No match' }[category] || category);
const MAX_BYTES = 20 * 1024 * 1024;
const PAGE_SIZE = 50;

export const demoIps = '3.5.140.1\n3.5.140.1\n34.80.0.1\n20.0.0.1\n143.198.1.2\n104.16.0.1\n66.249.66.1\n2606:4700::1111\n10.0.0.24\n2001:db8::1\n8.8.8.8';
function demoLog() {
  const clients = ['3.5.140.1', '34.80.0.1', '143.198.1.2', '104.16.0.1', '66.249.66.1', '10.0.0.24', '2001:db8::1'];
  const paths = ['/api/orders', '/products', '/robots.txt', '/wp-login.php', '/.env', '/'];
  return Array.from({ length: 120 }, (_, i) => {
    const noisy = i >= 45 && i < 75;
    const client = noisy ? clients[0] : clients[i % clients.length];
    const status = noisy ? (i % 3 ? 404 : 403) : i % 17 === 0 ? 503 : 200;
    return `${client} - - [14/Sep/2026:10:${String(Math.floor(i / 10)).padStart(2, '0')}:${String(i % 10 * 6).padStart(2, '0')} +0000] "GET ${noisy ? paths[3 + i % 2] : paths[i % paths.length]} HTTP/1.1" ${status} ${status === 200 ? 1240 : 180} "-" "Example client"`;
  }).join('\n');
}

export function initTrafficWorkbench() {
  const root = document.querySelector<HTMLElement>('.traffic-workbench');
  if (!root || root.dataset.initialized) return;
  root.dataset.initialized = 'true';
  const mode = root.dataset.mode as TrafficMode;
  const toolId = mode === 'log' ? 'access-log-analyzer' : 'ip-lookup';
  const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(`traffic-${id}`) as T;
  const input = get<HTMLTextAreaElement>('input'), title = get<HTMLInputElement>('title');
  const search = get<HTMLInputElement>('search'), source = get<HTMLSelectElement>('source'), category = get<HTMLSelectElement>('category'), sort = get<HTMLSelectElement>('sort');
  const detail = get<HTMLDialogElement>('detail');
  let report: TrafficReport | null = null;
  let dataset: IpDataset = { version: 1, fetchedAt: '', sources: [], ranges: [], failures: [] };
  const knownIps = new Set<string>();
  let worker: Worker | null = null, revision = 0, timer = 0, toastTimer = 0, page = 0, activeIp: IpRow | null = null, shareOverride: TrafficReport | null = null;

  function toast(message: string) { const el = get('toast'); el.textContent = message; el.hidden = false; window.clearTimeout(toastTimer); toastTimer = window.setTimeout(() => { el.hidden = true; }, 3500); }
  function error(message: string) { get('error').textContent = message; get('error').hidden = !message; }
  function notice(message: string) { get('notice').textContent = message; get('notice').hidden = !message; }
  function busy(value: boolean) { get<HTMLButtonElement>('analyze').disabled = value; get('cancel').hidden = !value; get('progress').hidden = !value; root!.setAttribute('aria-busy', String(value)); }
  function stop() { revision++; worker?.terminate(); worker = null; busy(false); }
  function currentRows() { return report ? filterIpRows(report, search.value, source.value, category.value, sort.value) : []; }

  async function loadDataset(addresses: string[]) {
    const missing = addresses.filter(address => !knownIps.has(address));
    if (!missing.length) return dataset;
    const batches: string[][] = [];
    for (let at = 0; at < missing.length; at += 1000) batches.push(missing.slice(at, at + 1000));
    const additions: IpDataset[] = [];
    for (let at = 0; at < batches.length; at += 3) {
      additions.push(...await Promise.all(batches.slice(at, at + 3).map(async ips => {
        const response = await fetch('/api/ip-lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ips }), signal: AbortSignal.timeout(25_000) });
        const data = await response.json().catch(() => null) as (IpDataset & { error?: string }) | null;
        if (!response.ok || !data) throw new Error(data?.error || 'Could not look up provider ranges. Try again shortly.');
        if (data.version !== 1 || !Array.isArray(data.ranges) || !Array.isArray(data.sources)) throw new Error('The provider lookup returned an invalid response.');
        ips.forEach(address => knownIps.add(address));
        return data;
      })));
    }
    dataset = mergeIpDatasets([dataset, ...additions]);
    get('data-status').textContent = 'Official feeds + current BGP ranges';
    return dataset;
  }

  async function analyze() {
    window.clearTimeout(timer); stop(); error(''); notice('');
    const text = input.value;
    if (!text.trim()) { report = null; get('report').hidden = true; get('empty').hidden = false; return; }
    if (new TextEncoder().encode(text).length > MAX_BYTES) { error('Use a file or selection up to 20 MB.'); return; }
    const ticket = revision;
    busy(true);
    const progress = get('progress');
    progress.querySelector('span')!.textContent = 'Reading IP addresses locally…';
    progress.querySelector('progress')!.value = 0;
    try {
      worker = new Worker(new URL('../workers/traffic.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = async event => {
        if (ticket !== revision) return;
        if (event.data.type === 'addresses') {
          try {
            progress.querySelector('span')!.textContent = `Checking ${number(event.data.addresses.length)} unique IP${event.data.addresses.length === 1 ? '' : 's'}…`;
            const ranges = event.data.addresses.length ? await loadDataset(event.data.addresses) : dataset;
            if (ticket !== revision) return;
            worker?.postMessage({ text, mode, dataset: ranges });
          } catch (cause) { if (ticket === revision) { stop(); error(cause instanceof Error ? cause.message : 'Provider ranges unavailable. Try again shortly.'); } }
        } else if (event.data.type === 'progress') {
          progress.querySelector('progress')!.value = event.data.percent;
          progress.querySelector('span')!.textContent = `Analyzing locally… ${event.data.percent}%`;
        } else if (event.data.type === 'result') {
          report = event.data.report; stop(); page = 0;
          if (!report!.summary.accepted) { report = null; get('report').hidden = true; get('empty').hidden = false; error(mode === 'log' ? 'No supported log entries found. Try Apache/Nginx common or combined logs, or JSON lines with a client IP, status, and request path.' : 'No valid IP addresses found. Paste IPv4 or IPv6 addresses, or try the example.'); return; }
          if (report!.summary.skipped) notice(`${number(report!.summary.skipped)} of ${number(report!.summary.lines)} non-empty lines were skipped. Details are listed under Sources, coverage & parsing details.`);
          render();
        } else { stop(); error(event.data.message || 'Could not analyze this input.'); }
      };
      worker.onerror = () => { if (ticket === revision) { stop(); error('The analysis could not finish. Try a smaller selection or reload the page.'); } };
      worker.postMessage({ text, mode, phase: 'extract' });
    } catch (cause) { if (ticket === revision) { stop(); error(cause instanceof Error ? cause.message : 'Provider ranges unavailable. Try again shortly.'); } }
  }

  function barRows(rows: CountRow[], total: number, colors = ['#818cf8', '#14b8a6', '#38bdf8', '#f59e0b', '#94a3b8']) {
    return rows.map((row, i) => `<div class="traffic-bar-row"><div class="traffic-bar-label"><span>${escapeHtml(row.label)}</span><b>${number(row.count)} <span style="font-weight:400;color:var(--tw-muted)">· ${total ? (row.count / total * 100).toFixed(1) : '0'}%</span></b></div><div class="traffic-bar-track"><div class="traffic-bar-fill" style="width:${total ? Math.min(100, row.count / total * 100) : 0}%;background:${colors[i % colors.length]}"></div></div></div>`).join('');
  }

  function render() {
    if (!report) return;
    get('empty').hidden = true; get('report').hidden = false;
    const s = report.summary;
    get('report-meta').textContent = `${date(report.createdAt)} · Range snapshot: ${date(report.dataset.fetchedAt)}`;
    if (report.shared) notice(`Shared report snapshot: ${report.shared.scope}. Raw input is not included.`);
    const stats = mode === 'log' ? [
      ['Requests', s.accepted, `${number(s.lines)} non-empty lines`], ['Unique IPs', s.uniqueIps, `${number(s.matchedIps)} with range matches`], ['Range matches', s.matchedEvents, 'requests in published ranges'], ['4xx / 5xx', s.errors, `${(s.errors / s.accepted * 100).toFixed(1)}% of requests`],
    ] : [['IP occurrences', s.accepted, 'including repeated addresses'], ['Unique IPs', s.uniqueIps, 'normalized IPv4 + IPv6'], ['Range matches', s.matchedIps, 'unique IPs in published ranges'], ['Other addresses', s.uniqueIps - s.matchedIps, 'unmatched or special-use']];
    get('summary').innerHTML = stats.map(([label, value, subtitle], i) => `<div class="traffic-stat ${i === 2 ? 'highlight' : ''}"><span>${escapeHtml(label)}</span><strong>${number(Number(value))}</strong><small>${escapeHtml(subtitle)}</small></div>`).join('');
    // Charts use non-overlapping primary categories, so percentages always add up.
    const mix = new Map<string, number>();
    for (const row of report.ips) {
      const label = row.category === 'special' ? 'Special-use IP' : row.category === 'unmatched' ? 'No range match' : row.category === 'crawler' ? 'Crawler range' : row.category === 'cdn' ? 'CDN / proxy' : sourceName(row.matches.find(m => m.kind === row.category)?.source || row.matches[0]?.source || row.category);
      mix.set(label, (mix.get(label) || 0) + row.count);
    }
    const includedCount = report.ips.reduce((sum, row) => sum + row.count, 0);
    get('mix-unit').textContent = report.shared ? 'Included IPs only' : mode === 'log' ? 'By request count' : 'By occurrence';
    get('provider-chart').innerHTML = barRows([...mix].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count), includedCount);
    if (mode === 'log') {
      const statuses = new Map<string, number>();
      for (const row of report.statuses) { const name = `${row.label[0]}xx`; statuses.set(name, (statuses.get(name) || 0) + row.count); }
      get('secondary-chart').innerHTML = statuses.size ? barRows([...statuses].sort().map(([label, count]) => ({ label, count })), s.accepted, ['#14b8a6', '#38bdf8', '#f59e0b', '#f87171']) : '<p class="traffic-small">Status breakdown is not included in this snapshot.</p>';
      const buckets = report.timeline;
      if (buckets.length) {
        const width = Math.max(1, report.bucketMinutes) * 60_000;
        const first = Date.parse(buckets[0].label), last = Date.parse(buckets.at(-1)!.label);
        const peak = Math.max(...buckets.map(b => b.count), 1), lookup = new Map(buckets.map(b => [Date.parse(b.label), b.count]));
        const bars: string[] = [];
        for (let at = first; at <= last && bars.length < 200; at += width) { const count = lookup.get(at) || 0; bars.push(`<div class="traffic-time-bar" style="height:${count ? Math.max(3, count / peak * 100) : 0}%" title="${escapeHtml(date(at))}: ${number(count)} requests" role="img" aria-label="${escapeHtml(date(at))}: ${number(count)} requests"></div>`); }
        get('timeline').innerHTML = bars.join(''); get('timeline-label').textContent = `${report.bucketMinutes}-minute buckets · UTC`;
        get('time-range').innerHTML = `<span>${escapeHtml(date(s.first!))}</span><span>${escapeHtml(date(s.last!))}</span>`;
      } else { get('timeline').innerHTML = '<p class="traffic-small">No dated entries in this report.</p>'; get('time-range').textContent = ''; }
      get('latency').textContent = s.p50 !== null ? `Request duration: median ${s.p50.toFixed(1)} ms · p95 ${s.p95!.toFixed(1)} ms · ${number(s.timedRequests)} timed requests.` : 'Latency needs JSON duration_ms, response_time_ms, or request_time fields.';
      get('paths').innerHTML = report.paths.length ? report.paths.slice(0, 12).map(row => `<div class="traffic-path-row"><code title="${escapeHtml(row.label)}">${escapeHtml(row.label)}</code><strong>${number(row.count)}</strong></div>`).join('') : '<p class="traffic-small">Path counts are not included in this snapshot.</p>';
    } else {
      get('secondary-chart').innerHTML = barRows([4, 6].map(version => ({ label: `IPv${version}`, count: report!.ips.filter(ip => ip.version === version).length })), report.ips.length, ['#818cf8', '#14b8a6']);
    }
    const previousSource = source.value;
    source.innerHTML = '<option value="">All providers</option>' + report.dataset.sources.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(sourceName(s.id))}</option>`).join('');
    source.value = previousSource;
    get('sources').innerHTML = report.dataset.sources.map(s => `<div><a href="${escapeHtml(feedDefinitions.find(feed => feed.id === s.id)?.url || '#')}" target="_blank" rel="noopener noreferrer">${escapeHtml(sourceName(s.id))} ↗</a><span>${s.method === 'bgp' ? `BGP origin${s.asns?.length ? ` · ${s.asns.map(asn => `AS${asn}`).join(', ')}` : ''}` : 'Official feed'} · ${number(s.count)} published ranges${s.publishedAt ? ` · ${escapeHtml(s.publishedAt)}` : ''}</span></div>`).join('') + `<p>Dataset updated ${escapeHtml(date(report.dataset.fetchedAt))}. Bug Days receives only the unique IP addresses needed for matching; access-log lines, paths, headers, and user agents stay in this browser.</p>`;
    get('issues').innerHTML = `<p>${number(s.accepted)} ${mode === 'log' ? 'requests parsed' : 'IP occurrences extracted'}; ${number(s.skipped)} lines skipped.${report.dataset.failures.length ? ` Unavailable feeds: ${escapeHtml(report.dataset.failures.join(', '))}.` : ''}</p>` + report.issues.map(issue => `<p>Line ${issue.line}: ${escapeHtml(issue.reason)}</p>`).join('');
    renderRows();
  }

  function rowHtml(row: IpRow) {
    const providers = [...new Set(row.matches.map(m => sourceName(m.source)))];
    const regions = [...new Set(row.matches.map(m => m.region).filter(Boolean))];
    const evidence = [...new Set(row.matches.map(m => m.method === 'bgp' ? 'BGP origin' : 'Official feed'))];
    return `<tr><td><button class="traffic-ip-button" type="button" data-ip="${escapeHtml(row.address)}">${escapeHtml(row.address)}</button><span class="traffic-cell-note">IPv${row.version}</span></td><td><span class="traffic-badge traffic-badge-${row.category}">${escapeHtml(row.label || categoryLabel(row.category))}</span><span class="traffic-cell-note">${escapeHtml(providers.join(' · '))}</span></td><td><span title="${escapeHtml(regions.join(', '))}">${escapeHtml(regions.slice(0, 2).join(', ') || evidence.join(' · ') || '—')}${regions.length > 2 ? ` +${regions.length - 2}` : ''}</span></td><td class="traffic-number">${number(row.count)}</td>${mode === 'log' ? `<td class="traffic-number">${number(row.errors)}</td>` : ''}<td><button type="button" data-ip="${escapeHtml(row.address)}" class="traffic-text-button" aria-label="Inspect ${escapeHtml(row.address)}">↗</button></td></tr>`;
  }

  function renderRows() {
    if (!report) return;
    const rows = currentRows();
    page = Math.min(page, Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1));
    get('ip-rows').innerHTML = rows.length ? rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(rowHtml).join('') : `<tr><td colspan="${mode === 'log' ? 6 : 5}">No addresses match these filters. Try resetting them.</td></tr>`;
    get('row-count').textContent = `${number(rows.length)} matching IPs · select an address for details`;
    get('page-label').textContent = rows.length ? `${number(page * PAGE_SIZE + 1)}–${number(Math.min(rows.length, (page + 1) * PAGE_SIZE))} of ${number(rows.length)}` : '0 addresses';
    get<HTMLButtonElement>('prev').disabled = page === 0; get<HTMLButtonElement>('next').disabled = (page + 1) * PAGE_SIZE >= rows.length;
    const shareCount = reportShareSnapshot(report, rows).ips.length;
    get('share-description').textContent = `Sharing includes the report title, full-analysis totals, ${shareCount} filtered IPs (up to 200 within the link size limit), and the top 50 paths. IPs and paths are visible to recipients; raw lines and query strings are excluded. CSV/Excel use all filtered rows. Report JSON preserves all results available here.`;
    get<HTMLButtonElement>('share').disabled = !rows.length;
    for (const id of ['csv', 'xlsx', 'copy']) get<HTMLButtonElement>(id).disabled = !rows.length;
  }

  function showDetail(address: string) {
    activeIp = report?.ips.find(row => row.address === address) || null;
    if (!activeIp) return;
    get('detail-title').textContent = activeIp.address;
    get('detail-body').innerHTML = `<p>${number(activeIp.count)} ${mode === 'log' ? 'requests' : 'occurrences'} · ${escapeHtml(activeIp.label || categoryLabel(activeIp.category))}</p>` + (activeIp.matches.length ? activeIp.matches.map(match => { const source = report?.dataset.sources.find(source => source.id === match.source); return `<article><h3>${escapeHtml(sourceName(match.source))}</h3><dl><dt>Matched range</dt><dd><code>${escapeHtml(match.cidr)}</code></dd><dt>Evidence</dt><dd>${match.method === 'bgp' ? `Current BGP origin${source?.asns?.length ? ` (${source.asns.map(asn => `AS${asn}`).join(', ')})` : ''}` : 'Official published feed'}</dd><dt>Service</dt><dd>${escapeHtml(match.service || 'Not specified')}</dd><dt>Region</dt><dd>${escapeHtml(match.region || (match.method === 'bgp' ? 'Not published by BGP' : 'Not specified'))}</dd></dl></article>`; }).join('') : `<p class="traffic-small">${activeIp.category === 'special' ? 'This address is in a recognized special-use range.' : 'No match in the checked datasets. This does not establish whether the address is residential, hosted, or a bot.'}</p>`) + (activeIp.category === 'crawler' ? '<p class="traffic-small">This address matches a crawler range published by the named operator. Confirm request behavior and identity signals before making a blocking decision.</p>' : '');
    detail.showModal();
  }

  function download(blob: Blob, extension: string) {
    const slug = title.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || toolId;
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = `${slug}.${extension}`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  function updateInput() {
    window.clearTimeout(timer); stop(); error(''); notice(''); report = null; get('report').hidden = true; get('empty').hidden = false;
    const size = new TextEncoder().encode(input.value).length;
    get('input-size').textContent = size ? `${number(size)} bytes` : 'No input yet';
    if (get<HTMLInputElement>('auto').checked && input.value.trim()) timer = window.setTimeout(analyze, 600);
  }
  async function readFile(file: File) {
    if (file.size > MAX_BYTES) { error('Choose a file up to 20 MB.'); return; }
    window.clearTimeout(timer); stop(); const ticket = revision;
    try {
      let stream: ReadableStream<Uint8Array> = file.stream();
      if (/\.gz$/i.test(file.name)) stream = stream.pipeThrough(new DecompressionStream('gzip'));
      const reader = stream.getReader(), decoder = new TextDecoder();
      let size = 0, text = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (ticket !== revision) { await reader.cancel(); return; }
        size += value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); throw new Error('The expanded file is larger than 20 MB. Use a smaller selection.'); }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      if (ticket !== revision) return;
      if (text.trimStart().startsWith('{')) {
        let parsed: any;
        try { parsed = JSON.parse(text); } catch { /* JSON lines are handled by the log parser. */ }
        if (parsed?.kind === 'bugdays-traffic-report') {
          const restored = validateReport(parsed);
          if (restored.mode !== mode) throw new Error(`Open this report in ${restored.mode === 'ip' ? 'IP & cloud lookup' : 'Access-log analyzer'}.`);
          report = restored; if (restored.title) title.value = restored.title; input.value = ''; get('input-size').textContent = 'Report imported · raw input not included'; error(''); notice('Imported report. Provider matches are preserved from its original dataset.'); page = 0; render(); return;
        }
      }
      input.value = text; updateInput(); if (!get<HTMLInputElement>('auto').checked) await analyze();
    } catch (cause) { error(cause instanceof Error ? cause.message : 'Could not read this file.'); }
  }

  input.addEventListener('input', updateInput);
  get('analyze').addEventListener('click', analyze);
  get('cancel').addEventListener('click', () => { window.clearTimeout(timer); stop(); toast('Analysis canceled.'); });
  get('clear').addEventListener('click', () => { input.value = ''; updateInput(); input.focus(); });
  get('demo').addEventListener('click', () => { input.value = mode === 'log' ? demoLog() : demoIps; updateInput(); analyze(); });
  get<HTMLInputElement>('auto').addEventListener('change', () => { window.clearTimeout(timer); if (get<HTMLInputElement>('auto').checked && input.value.trim()) analyze(); });
  get('upload').addEventListener('click', () => get<HTMLInputElement>('file').click());
  get<HTMLInputElement>('file').addEventListener('change', event => { const picker = event.target as HTMLInputElement; if (picker.files?.[0]) readFile(picker.files[0]); picker.value = ''; });
  const drop = get('drop-zone');
  for (const event of ['dragenter', 'dragover']) drop.addEventListener(event, e => { e.preventDefault(); drop.classList.add('dragging'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
  drop.addEventListener('drop', event => { event.preventDefault(); drop.classList.remove('dragging'); if (event.dataTransfer?.files[0]) readFile(event.dataTransfer.files[0]); });
  for (const field of [search, source, category, sort]) field.addEventListener(field === search ? 'input' : 'change', () => { page = 0; renderRows(); });
  get('reset-filters').addEventListener('click', () => { search.value = source.value = category.value = ''; sort.value = 'count'; page = 0; renderRows(); });
  get('prev').addEventListener('click', () => { page--; renderRows(); }); get('next').addEventListener('click', () => { page++; renderRows(); });
  get('ip-rows').addEventListener('click', event => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-ip]'); if (button?.dataset.ip) showDetail(button.dataset.ip); });
  get('detail-close').addEventListener('click', () => detail.close());
  get('share').addEventListener('click', () => document.getElementById('share-btn')?.click());
  get('share-ip').addEventListener('click', () => {
    if (!report || !activeIp) return;
    const row = activeIp;
    const selected: TrafficReport = { ...report, summary: { ...report.summary, lines: row.count, accepted: row.count, skipped: 0, uniqueIps: 1, matchedIps: row.matches.length ? 1 : 0, matchedEvents: row.matches.length ? row.count : 0, errors: row.errors, bytes: row.bytes, timedRequests: 0, p50: null, p95: null, first: null, last: null }, ips: [row], paths: [], statuses: [], timeline: [], issues: [] };
    shareOverride = reportShareSnapshot(selected, [row], 'Selected IP only'); detail.close(); document.getElementById('share-btn')?.click();
  });
  get('csv').addEventListener('click', () => { if (report) download(new Blob(['\ufeff' + csvTable(ipTableRows(report, currentRows()))], { type: 'text/csv;charset=utf-8' }), 'csv'); });
  get('xlsx').addEventListener('click', () => { if (report) download(createXlsxBlob(ipTableRows(report, currentRows()), { sheetName: 'IP analysis', headerRow: true }), 'xlsx'); });
  get('json').addEventListener('click', () => { if (report) download(new Blob([JSON.stringify({ ...report, title: title.value }, null, 2)], { type: 'application/json' }), 'json'); });
  get('copy').addEventListener('click', async () => {
    if (!report) return;
    const rows = ipTableRows(report, currentRows()).map(row => row.map(safeSpreadsheetCell));
    const text = rows.map(row => row.join('\t')).join('\n');
    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
        const html = '<table>' + rows.map((row, index) => '<tr>' + row.map(value => `<${index ? 'td' : 'th'}>${escapeHtml(value)}</${index ? 'td' : 'th'}>`).join('') + '</tr>').join('') + '</table>';
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })]);
      } else await navigator.clipboard.writeText(text);
      toast('Table copied. Paste into Excel, Word, or email.');
    } catch { toast('Clipboard unavailable. Use CSV or Excel download instead.'); }
  });
  get('print').addEventListener('click', () => { get('ip-rows').innerHTML = currentRows().map(rowHtml).join(''); window.print(); renderRows(); });

  ShareManager.register({ tool: toolId,
    customCollect: () => {
      if (!report) return {};
      const selected = shareOverride; shareOverride = null;
      return { report: selected || reportShareSnapshot(report, currentRows()), title: title.value, query: selected ? '' : search.value, source: selected ? '' : source.value, category: selected ? '' : category.value, sort: sort.value };
    },
    customRestore: data => {
      stop(); window.clearTimeout(timer); detail.close(); shareOverride = null;
      report = null; get('report').hidden = true; get('empty').hidden = false;
      error(''); notice('');
      try {
        if (typeof data.input === 'string' && !data.report) { input.value = data.input; updateInput(); analyze(); return; }
        const restored = validateReport(data.report);
        if (restored.mode !== mode) throw new Error('This report belongs to the other traffic tool.');
        stop(); window.clearTimeout(timer); report = restored; input.value = ''; get('input-size').textContent = 'Shared report · raw input not included';
        title.value = typeof data.title === 'string' ? data.title.slice(0, 120) : title.value;
        search.value = typeof data.query === 'string' ? data.query.slice(0, 500) : '';
        category.value = typeof data.category === 'string' ? data.category : '';
        sort.value = typeof data.sort === 'string' ? data.sort : 'count';
        error(''); page = 0; render(); source.value = typeof data.source === 'string' ? data.source : ''; renderRows();
      } catch (cause) { error(cause instanceof Error ? cause.message : 'Could not open this shared report.'); }
    },
  });
  // A link to another report on this page changes only the fragment; scripts
  // do not rerun. Restore it just as we do when opening a new tab.
  const restoreFragment = () => { if (root.isConnected) void ShareManager.loadFromUrl(); };
  window.addEventListener('hashchange', restoreFragment);
  document.addEventListener('astro:before-swap', () => {
    window.removeEventListener('hashchange', restoreFragment);
    window.clearTimeout(timer); stop();
  }, { once: true });
}
