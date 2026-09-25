import { ShareManager } from '../lib/share.ts';
import { track } from '../lib/analytics.ts';
import { anonymizeSnapshot, diagnoseKafka, type KafkaGroupSnapshot } from '../lib/kafka-diagnostics.ts';
import { bridgePost, bridgeReady, clearSessionToken, sampleGroup, samplePreviousGroup, sampleRecords, saveSessionToken, sessionToken, type KafkaConnection, type KafkaPage, type KafkaRecord, type KafkaTopic } from '../lib/kafka-bridge.ts';

const root = document.getElementById('kafka-workspace') as HTMLElement | null;
if (root) init(root);
document.addEventListener('astro:after-swap', () => { const next = document.getElementById('kafka-workspace') as HTMLElement | null; if (next) init(next); });

function init(root: HTMLElement): void {
  if (root.dataset.initialized) return;
  root.dataset.initialized = '1';
  const view = root.dataset.view as 'client' | 'diagnostics';
  const id = <T extends HTMLElement>(name: string) => root.querySelector<T>(`#${name}`)!;
  const value = (name: string) => id<HTMLInputElement | HTMLSelectElement>(name).value.trim();
  const messageBox = id<HTMLElement>('k-message');
  let token = sessionToken();
  let demo = false;
  let sourceConnected = false;
  let connectedBrokers = '';
  let records: KafkaRecord[] = [];
  let selected: KafkaRecord | null = null;
  let includeSelected = false;
  let page: KafkaPage | null = null;
  let snapshot: KafkaGroupSnapshot | null = null;
  let previous: KafkaGroupSnapshot | undefined;
  let watchTimer: number | undefined;
  let replayStopped = false;
  let resetPlan = '';
  let takeSnapshot: () => Promise<void> = async () => {};
  function invalidateReset(): void {
    resetPlan = '';
    if (view === 'diagnostics') {
      id<HTMLElement>('k-apply').hidden = true;
      id<HTMLElement>('k-reset-preview').hidden = true;
    }
  }

  function announce(message: string, error = false): void {
    messageBox.hidden = false;
    messageBox.textContent = message;
    messageBox.style.borderColor = error ? '#fb7185' : '';
    messageBox.style.backgroundColor = error ? 'rgba(244,63,94,.1)' : '';
  }
  const readableError = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Try again.';
  function refreshReplaySource(): void {
    if (view !== 'client') return;
    id<HTMLElement>('k-replay-source-status').textContent = demo ? 'Sample only' : sourceConnected ? 'Connected' : 'Not connected';
    id<HTMLElement>('k-replay-source-brokers').textContent = demo ? 'Sample data · no live cluster' : sourceConnected ? connectedBrokers || 'Connected via Holy CORS' : value('k-brokers') || 'Connect a cluster above';
    const topic = value('k-topic');
    id<HTMLElement>('k-replay-source-topic').textContent = topic ? `${topic} · partition ${value('k-partition')}` : 'Choose a topic above';
  }
  function textNode(tag: string, content: string, className = ''): HTMLElement {
    const element = document.createElement(tag);
    element.textContent = content;
    element.className = className;
    return element;
  }
  function setConnected(connected: boolean): void {
    sourceConnected = connected;
    if (!connected) connectedBrokers = '';
    const badge = id<HTMLElement>('k-connection-badge');
    badge.textContent = connected ? 'Connected' : 'Not connected';
    badge.className = connected ? 'rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-300';
    id<HTMLElement>('k-disconnect').hidden = !connected;
    if (connected && view === 'diagnostics') id<HTMLButtonElement>('k-sample').disabled = false;
    refreshReplaySource();
  }
  function download(content: string, name: string, type: string): void {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a'); link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    track('export_used', { tool: view === 'client' ? 'kafka-client' : 'kafka-diagnostics', format: name.split('.').at(-1) || 'file' });
  }
  function csv(rows: unknown[][]): string {
    return rows.map(row => row.map(cell => `"${String(cell ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n');
  }
  function utf8(base64: string | null): string | null {
    if (base64 === null) return null;
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(base64), c => c.charCodeAt(0))); } catch { return null; }
  }
  function encode(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return btoa(binary);
  }
  function recordPreview(row: KafkaRecord): string {
    const plain = utf8(row.valueBase64);
    if (plain === null) {
      if (row.valueBase64 === null) return 'null / tombstone';
      try { return `[binary, ${atob(row.valueBase64).length} bytes]`; } catch { return '[invalid Base64]'; }
    }
    return plain.replaceAll(/\s+/g, ' ').slice(0, 110);
  }
  function prettyBytes(base64: string | null, format: string): string {
    if (base64 === null) return 'null';
    if (format === 'base64') return base64;
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    if (format === 'hex') return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(' ');
    const text = utf8(base64);
    if (text === null) return 'Not valid UTF-8. Choose Hex or Base64 to inspect the bytes.';
    if (format === 'json') { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return 'This value is not valid JSON. Choose Text, Hex, or Base64.'; } }
    return text;
  }
  function connectionFromForm(prefix = 'k'): KafkaConnection {
    const get = (name: string) => value(`${prefix}-${name}`);
    const securityProtocol = get('security');
    return {
      brokers: get('brokers'), securityProtocol,
      ...(securityProtocol.startsWith('SASL') ? { saslMechanism: get('mechanism'), username: get('username'), password: get('password') } : {}),
      ...(securityProtocol.endsWith('SSL') ? { caPem: get('ca'), certificatePem: get('cert'), keyPem: get('key'), keyPassword: get('key-password') } : {}),
    };
  }
  async function metadata(): Promise<void> {
    if (!token) return;
    const info = await bridgePost<{ topics: Array<{ name: string; partitions: number }> }>('metadata', { token });
    const selector = id<HTMLSelectElement>('k-topic');
    const previousTopic = selector.value;
    selector.replaceChildren(new Option('Choose a topic', ''), ...info.topics.sort((a, b) => a.name.localeCompare(b.name)).map(t => new Option(`${t.name} · ${t.partitions} partitions`, t.name)));
    if (info.topics.some(t => t.name === previousTopic)) selector.value = previousTopic;
    if (view === 'diagnostics') {
      const response = await bridgePost<{ groups: Array<{ name: string; state: string; members: number }> }>('groups', { token });
      const group = id<HTMLSelectElement>('k-group'); const old = group.value;
      group.replaceChildren(new Option('Choose a group', ''), ...response.groups.sort((a, b) => a.name.localeCompare(b.name)).map(g => new Option(`${g.name} · ${g.state}`, g.name)));
      if (response.groups.some(g => g.name === old)) group.value = old;
    }
    setConnected(true);
  }
  async function topicInfo(): Promise<KafkaTopic | null> {
    if (!token || !value('k-topic')) return null;
    const info = await bridgePost<KafkaTopic>('topic', { token, topic: value('k-topic') });
    id<HTMLElement>('k-topic-info').textContent = `${info.partitions.length} partitions · ${info.partitions.filter(p => p.isr.length < p.replicas.length).length} under replicated`;
    if (view === 'client') {
      const select = id<HTMLSelectElement>('k-partition'); const old = select.value;
      select.replaceChildren(...info.partitions.map(p => new Option(`${p.partition} · ${p.earliest}–${p.latest}`, String(p.partition))));
      if (info.partitions.some(p => String(p.partition) === old)) select.value = old;
      refreshReplaySource();
    }
    return info;
  }

  id<HTMLFormElement>('k-connect-form').addEventListener('submit', async event => {
    event.preventDefault(); demo = false;
    const button = id<HTMLButtonElement>('k-connect'); button.disabled = true; button.textContent = 'Connecting…';
    try {
      const connection = connectionFromForm();
      const response = await bridgePost<{ token: string; overview: { brokers: number; topics: number } }>('connect', connection);
      connectedBrokers = connection.brokers;
      token = response.token; saveSessionToken(token); setConnected(true);
      id<HTMLInputElement>('k-password').value = ''; id<HTMLTextAreaElement>('k-key').value = ''; id<HTMLInputElement>('k-key-password').value = '';
      announce(`Connected to ${response.overview.brokers} broker${response.overview.brokers === 1 ? '' : 's'}. Choose a topic to begin.`);
      await metadata();
    } catch (error) { announce(readableError(error), true); }
    finally { button.disabled = false; button.textContent = 'Connect cluster'; }
  });
  id<HTMLSelectElement>('k-security').addEventListener('change', () => { id<HTMLElement>('k-sasl').hidden = !value('k-security').startsWith('SASL'); });
  id<HTMLButtonElement>('k-disconnect').addEventListener('click', async () => {
    if (token) await bridgePost('disconnect', { token }).catch(() => {});
    token = ''; clearSessionToken(); setConnected(false); announce('Disconnected. Your connection details were cleared from the local bridge.');
  });
  id<HTMLButtonElement>('k-refresh').addEventListener('click', async () => { try { await metadata(); await topicInfo(); if (view === 'diagnostics') await takeSnapshot(); } catch (error) { announce(readableError(error), true); } });
  id<HTMLSelectElement>('k-topic').addEventListener('change', () => { invalidateReset(); refreshReplaySource(); topicInfo().catch(error => announce(readableError(error), true)); });

  async function start(): Promise<void> {
    const ready = await bridgeReady();
    id<HTMLElement>('k-bridge-state').textContent = ready ? 'Holy CORS ready' : 'Start Holy CORS to connect';
    if (ready && token) {
      try { await metadata(); } catch { token = ''; clearSessionToken(); setConnected(false); }
    }
  }
  start();

  if (view === 'client') {
    refreshReplaySource();
    id<HTMLInputElement>('k-brokers').addEventListener('input', refreshReplaySource);
    id<HTMLSelectElement>('k-partition').addEventListener('change', refreshReplaySource);
    id<HTMLButtonElement>('k-replay-change-source').addEventListener('click', () => {
      const brokers = id<HTMLInputElement>('k-brokers');
      brokers.scrollIntoView({ behavior: 'smooth', block: 'center' });
      brokers.focus({ preventScroll: true });
    });
    const table = id<HTMLElement>('k-records');
    const detail = id<HTMLElement>('k-record-detail');
    function renderRecords(): void {
      table.replaceChildren();
      for (const row of records) {
        const tr = document.createElement('tr'); tr.className = 'hover:bg-slate-50 dark:hover:bg-slate-800';
        for (const field of [row.offset, String(row.partition), row.timestampMs ? new Date(row.timestampMs).toLocaleString() : '—', utf8(row.keyBase64) ?? (row.keyBase64 === null ? 'null' : '[binary]'), recordPreview(row)]) tr.append(textNode('td', field, 'max-w-[260px] truncate p-2 font-mono'));
        const cell = document.createElement('td'); cell.className = 'p-2';
        const open = textNode('button', 'Inspect ↗', 'font-semibold text-indigo-600 dark:text-indigo-400');
        open.addEventListener('click', () => { selected = row; renderDetail(); }); cell.append(open); tr.append(cell); table.append(tr);
      }
      id<HTMLElement>('k-record-count').textContent = `${records.length} shown`;
      id<HTMLElement>('k-next').hidden = !(page?.hasMore && !demo);
      id<HTMLElement>('k-read-meta').textContent = page ? `Retained ${page.earliest}–${page.latest}; next ${page.nextOffset}` : demo ? 'Sample data' : '';
    }
    function renderDetail(): void {
      detail.hidden = !selected; detail.replaceChildren(); if (!selected) return;
      const title = textNode('h3', `Partition ${selected.partition} · offset ${selected.offset}`, 'mb-2 font-bold');
      const buttons = document.createElement('div'); buttons.className = 'mb-2 flex flex-wrap gap-2';
      const output = textNode('pre', '', 'max-h-80 overflow-auto rounded-lg bg-slate-950 p-3 font-mono text-xs leading-5 text-slate-100');
      for (const format of ['json', 'text', 'hex', 'base64']) {
        const button = textNode('button', format.toUpperCase(), 'k-btn k-btn-soft');
        button.addEventListener('click', () => { output.textContent = prettyBytes(selected!.valueBase64, format); }); buttons.append(button);
      }
      output.textContent = prettyBytes(selected.valueBase64, 'json');
      const metadata = textNode('p', `Key: ${prettyBytes(selected.keyBase64, 'text')} · ${selected.headers.length} headers`, 'mb-2 break-all text-xs text-slate-500 dark:text-slate-400');
      const headers = textNode('pre', selected.headers.map(h => `${h.key}: ${prettyBytes(h.valueBase64, 'text')}`).join('\n') || 'No headers', 'mb-2 overflow-auto rounded-lg bg-slate-50 p-2 font-mono text-xs dark:bg-slate-900');
      const shareLine = document.createElement('label'); shareLine.className = 'mb-3 flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300';
      const shareCheck = document.createElement('input'); shareCheck.type = 'checkbox'; shareCheck.checked = includeSelected;
      shareCheck.addEventListener('change', () => { includeSelected = shareCheck.checked; });
      shareLine.append(shareCheck, document.createTextNode('Include this record’s key, value, and headers in the shared link'));
      const edit = document.createElement('details');
      const summary = textNode('summary', 'Edit this record for replay', 'cursor-pointer text-sm font-semibold text-indigo-600 dark:text-indigo-400'); edit.append(summary);
      const field = (label: string, original: string | null, height: string) => {
        const wrap = document.createElement('div'); wrap.className = 'mt-2';
        const heading = textNode('p', label, 'text-xs font-semibold');
        const format = document.createElement('select'); format.className = 'k-input max-w-32';
        format.append(new Option('Text', 'text'), new Option('Base64', 'base64'));
        format.value = original !== null && utf8(original) === null ? 'base64' : 'text';
        const nullLabel = document.createElement('label'); nullLabel.className = 'mt-1 flex items-center gap-2 text-xs';
        const isNull = document.createElement('input'); isNull.type = 'checkbox'; isNull.checked = original === null;
        nullLabel.append(isNull, document.createTextNode('Null (tombstone for a value)'));
        const input = document.createElement('textarea'); input.className = `k-input mt-2 ${height} font-mono text-xs`; input.value = format.value === 'base64' ? original ?? '' : utf8(original) ?? '';
        format.addEventListener('change', () => { input.value = format.value === 'base64' ? original ?? '' : utf8(original) ?? ''; });
        wrap.append(heading, format, nullLabel, input);
        return { wrap, format, isNull, input };
      };
      const keyField = field('Key', selected.keyBase64, 'h-16');
      const valueField = field('Value', selected.valueBase64, 'h-32');
      const headerInput = document.createElement('textarea'); headerInput.className = 'k-input mt-2 h-20 font-mono text-xs'; headerInput.value = JSON.stringify(selected.headers, null, 2); headerInput.placeholder = '[{"key":"event-type","valueBase64":"T3JkZXJQYWlk"}]';
      const headerLabel = textNode('p', 'Headers JSON · Base64 values', 'mt-2 text-xs font-semibold');
      const use = textNode('button', 'Use edited record for replay', 'k-btn k-btn-soft mt-2');
      use.addEventListener('click', () => {
        id<HTMLInputElement>('k-replay-start').value = selected!.offset;
        id<HTMLInputElement>('k-replay-end').value = (BigInt(selected!.offset) + 1n).toString();
        id<HTMLInputElement>('k-replay-topic').value ||= selected!.topic;
        try {
          const parsed = JSON.parse(headerInput.value) as Array<{ key: string; valueBase64: string | null }>;
          if (!Array.isArray(parsed) || parsed.some(h => typeof h.key !== 'string' || !(typeof h.valueBase64 === 'string' || h.valueBase64 === null))) throw new Error('Headers must be an array of key and valueBase64 fields.');
          for (const header of parsed) if (header.valueBase64 !== null) atob(header.valueBase64);
          const bytes = (item: typeof keyField): string | null => {
            if (item.isNull.checked) return null;
            if (item.format.value === 'text') return encode(item.input.value);
            atob(item.input.value);
            return item.input.value;
          };
          selectedEdit = { offset: selected!.offset, keyBase64: bytes(keyField), valueBase64: bytes(valueField), headers: parsed };
          announce('Edited record is ready. Review the destination, then replay this one offset.');
        } catch (error) { announce(readableError(error), true); }
      });
      edit.append(keyField.wrap, valueField.wrap, headerLabel, headerInput, use);
      detail.append(title, buttons, metadata, headers, output, shareLine, edit);
      id<HTMLInputElement>('k-replay-start').value = selected.offset;
      id<HTMLInputElement>('k-replay-end').value = (BigInt(selected.offset) + 1n).toString();
      id<HTMLInputElement>('k-replay-topic').value ||= selected.topic;
    }
    let selectedEdit: { offset: string; keyBase64: string | null; valueBase64: string | null; headers: Array<{ key: string; valueBase64: string | null }> } | null = null;
    let exportStopped = false;
    async function browse(next = false): Promise<void> {
      if (!token) { announce('Connect Holy CORS to browse live Kafka messages, or try the sample.', true); return; }
      const topic = value('k-topic'); if (!topic) { announce('Choose a topic first.', true); return; }
      const mode = next ? 'offset' : value('k-read-mode');
      const start = next ? page?.nextOffset ?? '0' : value('k-start');
      const timeMs = mode === 'time' ? Date.parse(start.endsWith('Z') ? start : `${start}Z`) : undefined;
      if (mode === 'time' && !Number.isFinite(timeMs)) { announce('Enter a UTC time such as 2026-09-24T12:00.', true); return; }
      const endTimeText = value('k-read-end-time');
      const endTimeMs = endTimeText && (mode === 'time' || next) ? Date.parse(endTimeText.endsWith('Z') ? endTimeText : `${endTimeText}Z`) : undefined;
      if (endTimeText && (mode === 'time' || next) && !Number.isFinite(endTimeMs)) { announce('Enter a valid UTC end time.', true); return; }
      try {
        page = await bridgePost<KafkaPage>('browse', { token, topic, partition: Number(value('k-partition')), mode, offset: mode === 'offset' ? start : undefined, timeMs, endTimeMs, endExclusive: value('k-read-end') || undefined, limit: Number(value('k-limit')) });
        records = page.records; selected = null; selectedEdit = null; detail.hidden = true; demo = false; renderRecords();
        announce(records.length ? `Read ${records.length} message${records.length === 1 ? '' : 's'} from ${topic}.` : 'No records in this range. Try another offset, time, or partition.');
      } catch (error) { announce(readableError(error), true); }
    }
    id<HTMLSelectElement>('k-read-mode').addEventListener('change', () => { const mode = value('k-read-mode'); id<HTMLElement>('k-start-wrap').hidden = mode !== 'offset' && mode !== 'time'; id<HTMLElement>('k-read-end-time-wrap').hidden = mode !== 'time'; id<HTMLElement>('k-read-end-offset-wrap').hidden = mode === 'time'; id<HTMLInputElement>('k-start').placeholder = mode === 'time' ? '2026-09-24T12:00' : '0'; });
    id<HTMLButtonElement>('k-read').addEventListener('click', () => browse());
    id<HTMLButtonElement>('k-next').addEventListener('click', () => browse(true));
    id<HTMLButtonElement>('k-export-stop').addEventListener('click', () => { exportStopped = true; });
    id<HTMLButtonElement>('k-export-all').addEventListener('click', async () => {
      if (!token || !value('k-topic') || demo) { announce('Connect and choose a live topic to export retained messages.', true); return; }
      const button = id<HTMLButtonElement>('k-export-all'); const stop = id<HTMLButtonElement>('k-export-stop');
      let writable: any; const chunks: string[] = []; let bytes = 0; let count = 0; exportStopped = false;
      try {
        const savePicker = (window as any).showSaveFilePicker;
        if (typeof savePicker === 'function') {
          const handle = await savePicker({ suggestedName: 'kafka-messages.jsonl', types: [{ description: 'JSON Lines', accept: { 'application/x-ndjson': ['.jsonl'] } }] });
          writable = await handle.createWritable();
        }
        button.disabled = true; stop.hidden = false;
        const info = await topicInfo();
        const allPartitions = id<HTMLInputElement>('k-export-all-partitions').checked;
        const parts = allPartitions ? info?.partitions ?? [] : info?.partitions.filter(p => p.partition === Number(value('k-partition'))) ?? [];
        if (!parts.length) throw new Error('Choose a valid partition.');
        for (const part of parts) {
          const end = BigInt(part.latest); let cursor = BigInt(part.earliest);
          while (cursor < end && !exportStopped) {
            const result = await bridgePost<KafkaPage>('browse', { token, topic: value('k-topic'), partition: part.partition, mode: 'offset', offset: cursor.toString(), endExclusive: end.toString(), limit: 200 });
            const data = result.records.map(row => JSON.stringify(row)).join('\n') + (result.records.length ? '\n' : '');
            if (writable) await writable.write(data);
            else { bytes += new TextEncoder().encode(data).length; if (bytes > 20 * 1024 * 1024) throw new Error('This browser needs a streaming file saver for exports over 20 MB. Use Chrome, or export smaller offset ranges.'); chunks.push(data); }
            count += result.records.length;
            const next = BigInt(result.nextOffset);
            id<HTMLElement>('k-read-meta').textContent = `Exporting ${count} records · partition ${part.partition}, offset ${next} / ${end}`;
            if (next <= cursor || !result.hasMore) { cursor = next; break; }
            cursor = next;
          }
          if (!exportStopped && cursor < end) throw new Error(`Export stopped early in partition ${part.partition} at offset ${cursor}; the retained end was ${end}. No incomplete file was saved.`);
          if (exportStopped) break;
        }
        if (writable) await writable.close();
        else download(chunks.join(''), 'kafka-messages.jsonl', 'application/x-ndjson');
        if (writable) track('export_used', { tool: 'kafka-client', format: 'jsonl' });
        announce(`${exportStopped ? 'Partial export saved' : 'Export complete'}: ${count} retained records from ${allPartitions ? `${parts.length} partitions` : `partition ${parts[0].partition}`}.`);
      } catch (error) { if (writable) await writable.abort().catch(() => {}); if (!(error instanceof DOMException && error.name === 'AbortError')) announce(readableError(error), true); }
      finally { button.disabled = false; stop.hidden = true; }
    });
    id<HTMLButtonElement>('k-copy-json').addEventListener('click', async () => { await navigator.clipboard.writeText(JSON.stringify(records, null, 2)); announce(`${records.length} records copied as JSON.`); });
    id<HTMLButtonElement>('k-export-json').addEventListener('click', () => download(JSON.stringify(records, null, 2), 'kafka-messages.json', 'application/json'));
    id<HTMLButtonElement>('k-export-csv').addEventListener('click', () => download(csv([['topic','partition','offset','timestamp_ms','key_base64','value_base64','headers_json'], ...records.map(r => [r.topic,r.partition,r.offset,r.timestampMs,r.keyBase64,r.valueBase64,JSON.stringify(r.headers)])]), 'kafka-messages.csv', 'text/csv'));
    id<HTMLSelectElement>('k-replay-destination').addEventListener('change', () => {
      const other = value('k-replay-destination') === 'other';
      id<HTMLElement>('k-other-cluster').hidden = !other;
      id<HTMLElement>('k-replay-same-note').hidden = other;
    });
    id<HTMLSelectElement>('k-other-security').addEventListener('change', () => {
      const security = value('k-other-security');
      id<HTMLElement>('k-other-sasl').hidden = !security.startsWith('SASL');
      id<HTMLElement>('k-other-tls').hidden = !security.endsWith('SSL');
    });
    id<HTMLSelectElement>('k-replay-policy').addEventListener('change', () => { id<HTMLElement>('k-replay-fixed-wrap').hidden = value('k-replay-policy') !== 'fixed'; });
    id<HTMLButtonElement>('k-replay-stop').addEventListener('click', () => { replayStopped = true; id<HTMLElement>('k-replay-progress').textContent = 'Stopping after the current batch…'; });
    id<HTMLButtonElement>('k-replay').addEventListener('click', async () => {
      if (!token || demo) { announce('Connect to a live Kafka cluster before replaying messages.', true); return; }
      const sourceTopic = value('k-topic'), destinationTopic = value('k-replay-topic');
      if (!sourceTopic || !destinationTopic) { announce('Choose source and destination topics.', true); return; }
      let start: bigint, end: bigint;
      try { start = BigInt(value('k-replay-start')); end = value('k-replay-end') ? BigInt(value('k-replay-end')) : BigInt((await topicInfo())!.partitions.find(p => p.partition === Number(value('k-partition')))!.latest); }
      catch { announce('Enter valid whole-number offsets.', true); return; }
      if (start < 0 || end <= start) { announce('End offset must be greater than start offset.', true); return; }
      let destinationToken = token;
      const button = id<HTMLButtonElement>('k-replay'); const stop = id<HTMLButtonElement>('k-replay-stop'); button.disabled = true; stop.hidden = false; replayStopped = false;
      let sent = 0;
      try {
        if (value('k-replay-destination') === 'other') {
          const connected = await bridgePost<{ token: string }>('connect', connectionFromForm('k-other'));
          destinationToken = connected.token;
          id<HTMLInputElement>('k-other-password').value = '';
          id<HTMLTextAreaElement>('k-other-key').value = '';
          id<HTMLInputElement>('k-other-key-password').value = '';
        }
        while (start < end && !replayStopped) {
          const limit = Number((end - start) > 200n ? 200n : end - start);
          const edit = selectedEdit?.offset === start.toString() && end === start + 1n ? { keyBase64: selectedEdit.keyBase64, valueBase64: selectedEdit.valueBase64, headers: selectedEdit.headers } : undefined;
          const result = await bridgePost<{ sent: number; nextOffset: string; hasMore: boolean }>('replay', {
            sourceToken: token, destinationToken, sourceTopic, destinationTopic, partition: Number(value('k-partition')),
            offset: start.toString(), endExclusive: end.toString(), limit, partitionPolicy: value('k-replay-policy'),
            fixedPartition: Number(value('k-replay-fixed')), preserveTimestamp: id<HTMLInputElement>('k-replay-timestamp').checked, edit,
          });
          sent += result.sent;
          const next = BigInt(result.nextOffset);
          id<HTMLElement>('k-replay-progress').textContent = `${sent} message${sent === 1 ? '' : 's'} delivered. Next source offset ${next}.`;
          if (next <= start || !result.hasMore) break;
          start = next;
        }
        announce(`Replay ${replayStopped ? 'stopped' : 'finished'}: ${sent} message${sent === 1 ? '' : 's'} delivered to ${destinationTopic}.`);
      } catch (error) { announce(`${readableError(error)} ${sent} message${sent === 1 ? '' : 's'} delivered before the error.`, true); }
      finally { button.disabled = false; stop.hidden = true; if (destinationToken !== token) bridgePost('disconnect', { token: destinationToken }).catch(() => {}); }
    });
    id<HTMLButtonElement>('k-demo').addEventListener('click', () => {
      demo = true; records = sampleRecords; page = null; selected = null; detail.hidden = true;
      id<HTMLSelectElement>('k-topic').replaceChildren(new Option('orders.events · sample', 'orders.events'));
      id<HTMLSelectElement>('k-partition').replaceChildren(new Option('2 · sample', '2'));
      refreshReplaySource(); renderRecords(); announce('Sample messages loaded. Connect a cluster to browse or replay live data.');
    });
  } else {
    id<HTMLSelectElement>('k-group').addEventListener('change', invalidateReset);
    function renderGroup(): void {
      if (!snapshot) return;
      const totalLag = snapshot.partitions.reduce((sum, part) => sum + BigInt(part.lag ?? '0'), 0n);
      const metrics = [['Group state', snapshot.state], ['Members', String(snapshot.members.length)], ['Partitions', String(snapshot.partitions.length)], ['Offset lag', totalLag.toString()]];
      const summary = id<HTMLElement>('k-summary'); summary.replaceChildren(...metrics.map(([label, amount]) => { const card = textNode('div', '', 'rounded-xl bg-slate-50 p-3 dark:bg-slate-900'); card.append(textNode('div', label, 'text-xs text-slate-500 dark:text-slate-400'), textNode('div', amount, 'mt-1 text-xl font-bold')); return card; }));
      const findings = id<HTMLElement>('k-findings'); findings.replaceChildren();
      for (const finding of diagnoseKafka(snapshot, previous, value('k-expected'))) {
        const card = document.createElement('article'); card.className = `rounded-lg border p-3 text-sm ${finding.severity === 'high' ? 'border-rose-300 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/30' : finding.severity === 'medium' ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30' : 'border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900'}`;
        card.append(textNode('h3', finding.title, 'font-bold'), textNode('p', `${finding.detail}${finding.partitions.length ? ` Partitions: ${finding.partitions.join(', ')}.` : ''}`, 'mt-1 text-xs leading-5'));
        findings.append(card);
      }
      const tbody = id<HTMLElement>('k-lag-rows'); tbody.replaceChildren();
      for (const part of snapshot.partitions) {
        const row = document.createElement('tr'); row.className = 'hover:bg-slate-50 dark:hover:bg-slate-800';
        const owner = snapshot.members.find(m => m.id === part.owner);
        for (const field of [String(part.partition), part.committed ?? 'unset', part.latest, part.lag ?? '—', owner ? `${owner.clientId} · ${owner.host}` : 'unassigned', `${part.isr.length}/${part.replicas.length} ISR`]) row.append(textNode('td', field, 'p-2 font-mono'));
        const cell = document.createElement('td'); cell.className = 'p-2';
        const inspect = textNode('button', 'Compare ↗', 'font-semibold text-indigo-600 dark:text-indigo-400'); inspect.addEventListener('click', () => compare(part.partition)); cell.append(inspect); row.append(cell); tbody.append(row);
      }
      id<HTMLElement>('k-lag-note').textContent = `Sampled ${new Date(snapshot.sampledAt).toLocaleString()}. Lag is an offset gap; compacted or aborted records can make it different from a message count.`;
    }
    takeSnapshot = async (): Promise<void> => {
      if (!token || !value('k-topic') || !value('k-group')) { announce('Choose a live topic and consumer group first.', true); return; }
      try { const current = await bridgePost<KafkaGroupSnapshot>('group', { token, topic: value('k-topic'), group: value('k-group') }); previous = snapshot ?? undefined; snapshot = current; demo = false; renderGroup(); }
      catch (error) { announce(readableError(error), true); }
    };
    async function compare(partition: number): Promise<void> {
      if (!snapshot) return;
      const part = snapshot.partitions.find(p => p.partition === partition);
      if (!part || part.committed === null) { announce('This partition has no committed position to compare.', true); return; }
      const area = id<HTMLElement>('k-compare'); const card = id<HTMLElement>('k-compare-card'); card.hidden = false; area.replaceChildren();
      if (!token || demo) { for (const row of sampleRecords) { const box = textNode('pre', prettyBytes(row.valueBase64, 'json'), 'overflow-auto rounded-lg bg-slate-950 p-3 font-mono text-xs text-white'); area.append(box); } card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); return; }
      try {
        const commit = BigInt(part.committed); const low = BigInt(part.earliest);
        const calls: Array<[string, bigint, bigint]> = [['Previous retained', commit > low ? commit - 1n : low, commit], ['Next available', commit, BigInt(part.latest)]];
        for (const [label, from, to] of calls) {
          const result = await bridgePost<KafkaPage>('browse', { token, topic: snapshot.topic, partition, mode: 'offset', offset: from.toString(), endExclusive: to.toString(), limit: 1 });
          const section = document.createElement('div'); section.append(textNode('h3', label, 'mb-1 text-xs font-bold'));
          section.append(textNode('pre', result.records[0] ? `Offset ${result.records[0].offset}\n${prettyBytes(result.records[0].valueBase64, 'json')}` : 'No retained message in this position.', 'max-h-72 overflow-auto rounded-lg bg-slate-950 p-3 font-mono text-xs text-white'));
          area.append(section);
        }
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } catch (error) { announce(readableError(error), true); }
    }
    id<HTMLButtonElement>('k-sample').addEventListener('click', () => takeSnapshot());
    id<HTMLButtonElement>('k-watch').addEventListener('click', () => {
      const button = id<HTMLButtonElement>('k-watch');
      if (watchTimer) { clearInterval(watchTimer); watchTimer = undefined; button.textContent = 'Watch live'; return; }
      if (!token) { announce('Connect a cluster to watch live group lag.', true); return; }
      takeSnapshot(); watchTimer = window.setInterval(() => { if (!document.hidden) takeSnapshot(); }, 5000); button.textContent = 'Stop watching';
    });
    id<HTMLInputElement>('k-expected').addEventListener('input', renderGroup);
    id<HTMLButtonElement>('k-export-group').addEventListener('click', () => { if (snapshot) download(csv([['group','topic','partition','committed','earliest','latest','lag','owner','isr','replicas'], ...snapshot.partitions.map(p => [snapshot!.group,snapshot!.topic,p.partition,p.committed,p.earliest,p.latest,p.lag,p.owner,p.isr.join('|'),p.replicas.join('|')])]), 'kafka-consumer-lag.csv', 'text/csv'); });
    id<HTMLButtonElement>('k-print').addEventListener('click', () => window.print());
    id<HTMLSelectElement>('k-reset-mode').addEventListener('change', () => { const mode = value('k-reset-mode'); id<HTMLElement>('k-reset-value-wrap').hidden = ['to-earliest','to-latest','to-current','from-file'].includes(mode); id<HTMLElement>('k-reset-file-wrap').hidden = mode !== 'from-file'; id<HTMLInputElement>('k-reset-value').placeholder = mode === 'to-datetime' ? '2026-09-24T12:00' : mode === 'by-duration' ? 'PT24H' : mode === 'shift-by' ? '-10 or 10' : 'Offset'; resetPlan = ''; id<HTMLElement>('k-apply').hidden = true; });
    for (const name of ['k-reset-parts','k-reset-value']) id<HTMLInputElement>(name).addEventListener('input', () => { resetPlan = ''; id<HTMLElement>('k-apply').hidden = true; });
    function durationMs(input: string): number {
      const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(input.toUpperCase());
      if (!match || !match.slice(1).some(Boolean)) throw new Error('Use an ISO duration such as PT24H, PT30M, or P7D.');
      return (Number(match[1] || 0) * 86400 + Number(match[2] || 0) * 3600 + Number(match[3] || 0) * 60 + Number(match[4] || 0)) * 1000;
    }
    id<HTMLButtonElement>('k-preview').addEventListener('click', async () => {
      if (!token || !snapshot || demo) { announce('Connect and take a live group snapshot before changing offsets.', true); return; }
      try {
        const all = snapshot.partitions.map(p => p.partition);
        const parts = value('k-reset-parts') ? value('k-reset-parts').split(',').map(v => Number(v.trim())) : all;
        if (!parts.length || parts.some(p => !Number.isInteger(p) || !all.includes(p))) throw new Error('Choose valid partition numbers from the current topic.');
        const mode = value('k-reset-mode'); let target = value('k-reset-value'); let targets: Array<{ partition: number; offset: string }> | undefined;
        if (mode === 'to-datetime') { const time = Date.parse(target.endsWith('Z') ? target : `${target}Z`); if (!Number.isFinite(time)) throw new Error('Enter a UTC datetime.'); target = String(time); }
        if (mode === 'by-duration') target = String(durationMs(target));
        if (mode === 'from-file') {
          const file = id<HTMLInputElement>('k-reset-file').files?.[0]; if (!file) throw new Error('Choose a CSV file.');
          targets = (await file.text()).trim().split(/\r?\n/).filter(line => line && !/^topic,/i.test(line)).map(line => {
            const columns = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
            if (![2, 3].includes(columns.length) || (columns.length === 3 && columns[0] !== snapshot!.topic)) throw new Error('CSV rows must be partition,offset or this topic,partition,offset.');
            const partition = Number(columns.at(-2)), offset = columns.at(-1) ?? '';
            if (!Number.isInteger(partition) || !/^\d+$/.test(offset)) throw new Error('CSV contains an invalid partition or offset.');
            return { partition, offset };
          });
        }
        const result = await bridgePost<{ planId: string; partitions: Array<{ partition: number; current: string | null; target: string; earliest: string; latest: string }> }>('reset-preview', { token, group: snapshot.group, topic: snapshot.topic, partitions: parts, mode, value: target, targets });
        resetPlan = result.planId; const area = id<HTMLElement>('k-reset-preview'); area.hidden = false; area.replaceChildren(textNode('p', 'Review these offsets before applying:', 'mb-2 font-semibold'));
        for (const p of result.partitions) area.append(textNode('p', `Partition ${p.partition}: ${p.current ?? 'unset'} → ${p.target} (retained ${p.earliest}–${p.latest})`, 'font-mono text-xs leading-6'));
        id<HTMLElement>('k-apply').hidden = false; announce('Preview is valid for 5 minutes. The group must remain stopped.');
      } catch (error) { announce(readableError(error), true); }
    });
    id<HTMLButtonElement>('k-apply').addEventListener('click', async () => {
      if (!resetPlan || !token) return;
      const button = id<HTMLButtonElement>('k-apply'); button.disabled = true;
      try {
        const result = await bridgePost<{ partitions: Array<{ ok: boolean; partition: number; actual: string }> }>('reset-apply', { token, planId: resetPlan });
        resetPlan = ''; button.hidden = true;
        announce(result.partitions.every(p => p.ok) ? `Offset change applied and verified for ${result.partitions.length} partitions.` : 'Kafka returned a partial result. Review the actual offsets and refresh.');
        await takeSnapshot();
      } catch (error) { announce(readableError(error), true); resetPlan = ''; button.hidden = true; }
      finally { button.disabled = false; }
    });
    id<HTMLButtonElement>('k-demo').addEventListener('click', () => {
      demo = true; previous = samplePreviousGroup; snapshot = { ...sampleGroup, sampledAt: Date.now() };
      id<HTMLSelectElement>('k-topic').replaceChildren(new Option('orders.events · sample', 'orders.events'));
      id<HTMLSelectElement>('k-group').replaceChildren(new Option('checkout-workers · sample', 'checkout-workers'));
      id<HTMLInputElement>('k-expected').value = 'checkout-processor*, 10.4.*';
      renderGroup(); announce('Sample group report loaded. Connect a cluster to inspect live lag and move offsets.');
    });
  }

  ShareManager.register({
    tool: view === 'client' ? 'kafka-client' : 'kafka-diagnostics',
    customCollect: () => view === 'client' ? {
      v: 1, view, topic: value('k-topic'), partition: value('k-partition'), mode: value('k-read-mode'),
      rows: records.slice(0, 50).map(row => ({ topic: row.topic, partition: row.partition, offset: row.offset, timestampMs: row.timestampMs,
        keyBase64: includeSelected && row === selected ? row.keyBase64 : null,
        valueBase64: includeSelected && row === selected ? row.valueBase64 : null,
        headers: includeSelected && row === selected ? row.headers : row.headers.map(h => ({ key: h.key, valueBase64: null })),
      })),
      selectedOffset: includeSelected ? selected?.offset : null,
    } : { v: 1, view, report: snapshot ? anonymizeSnapshot(snapshot) : null,
      findings: snapshot ? diagnoseKafka(snapshot, previous, value('k-expected')).map(finding => ({ severity: finding.severity, title: finding.title, partitions: finding.partitions })) : [],
    },
    customRestore: data => {
      if (data.v !== 1 || data.view !== view) return;
      demo = true;
      if (view === 'client') {
        const restored = Array.isArray(data.rows) ? data.rows.slice(0, 50).filter((row: any) => row && typeof row.offset === 'string' && Number.isInteger(row.partition) && Array.isArray(row.headers)) : [];
        records = restored as KafkaRecord[];
        if (typeof data.topic === 'string') id<HTMLSelectElement>('k-topic').replaceChildren(new Option(`${data.topic.slice(0, 150)} · shared`, data.topic.slice(0, 150)));
        if (typeof data.partition === 'string') id<HTMLSelectElement>('k-partition').replaceChildren(new Option(`${data.partition} · shared`, data.partition));
        refreshReplaySource();
        id<HTMLElement>('k-records').replaceChildren();
        // A shared snapshot remains inert until the user connects their own bridge.
        id<HTMLElement>('k-record-count').textContent = `${records.length} shared`;
        for (const row of records) {
          const tr = document.createElement('tr');
          for (const field of [row.offset, String(row.partition), row.timestampMs ? new Date(row.timestampMs).toLocaleString() : '—', row.keyBase64 ? utf8(row.keyBase64) ?? '[binary]' : 'hidden', row.valueBase64 ? recordPreview(row) : 'Content hidden', '—']) tr.append(textNode('td', field, 'p-2 font-mono text-xs'));
          id<HTMLElement>('k-records').append(tr);
        }
      } else if (data.report && typeof data.report === 'object') {
        const report = data.report as KafkaGroupSnapshot;
        if (Array.isArray(report.partitions) && Array.isArray(report.members) && report.partitions.length <= 512) {
          snapshot = report; previous = undefined;
          id<HTMLSelectElement>('k-topic').replaceChildren(new Option('Shared topic', 'shared'));
          id<HTMLSelectElement>('k-group').replaceChildren(new Option('Shared consumer group', 'shared'));
          // Rendering uses text nodes throughout; shared material is never executed.
          const sampleButton = id<HTMLButtonElement>('k-sample'); sampleButton.disabled = true;
          const summary = id<HTMLElement>('k-summary'); summary.replaceChildren(textNode('p', `Shared report · ${report.partitions.length} partitions · ${report.members.length} members`, 'text-sm font-semibold'));
          const findings = id<HTMLElement>('k-findings'); findings.replaceChildren();
          if (Array.isArray(data.findings)) for (const finding of data.findings.slice(0, 30)) {
            if (!finding || !['high', 'medium', 'info'].includes(finding.severity) || typeof finding.title !== 'string' || !Array.isArray(finding.partitions)) continue;
            const card = textNode('article', '', 'rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm dark:border-slate-700 dark:bg-slate-900');
            card.append(textNode('h3', finding.title.slice(0, 120), 'font-bold'), textNode('p', `Severity: ${finding.severity}${finding.partitions.length ? ` · Partitions: ${finding.partitions.slice(0, 100).join(', ')}` : ''}`, 'mt-1 text-xs'));
            findings.append(card);
          }
          const rows = id<HTMLElement>('k-lag-rows'); rows.replaceChildren();
          for (const p of report.partitions) { const tr = document.createElement('tr'); for (const field of [p.partition,p.committed,p.latest,p.lag,p.owner,p.isr?.length ?? 0,'—']) tr.append(textNode('td', String(field ?? '—'), 'p-2 font-mono text-xs')); rows.append(tr); }
        }
      }
      announce('Shared snapshot restored. Connect your own cluster to refresh live data.');
    },
  });
}
