import { ShareManager } from './share';
import { ungzip } from 'pako';
import {
  GrpcWebFrameDecoder,
  buildGrpcUrl,
  decodeResponse,
  encodeRequest,
  frameGrpcMessage,
  grpcStatusLabel,
  grpcTimeoutHeader,
  makeRequestTemplate,
  parseProtoSources,
  parseTrailerFrame,
  redactMetadata,
} from './grpc-web.mjs';

type ProtoSource = { name: string; content: string };
type Metadata = Record<string, string>;
type Snapshot = {
  version: 1;
  transport: string;
  endpoint: string;
  bridgeUrl: string;
  deadline: string;
  protoSources?: ProtoSource[];
  methodId?: string;
  request: string;
  metadata: Metadata;
};

const SAMPLE_PROTO = `syntax = "proto3";

package bugdays.demo;

service Greeter {
  rpc SayHello (HelloRequest) returns (HelloReply);
  rpc WatchGreetings (HelloRequest) returns (stream HelloReply);
}

message HelloRequest {
  string name = 1;
  int32 count = 2;
  repeated string tags = 3;
}

message HelloReply {
  string message = 1;
  int64 timestamp = 2;
}`;

const SAVED_KEY = 'bugdays-grpc-saved-v1';
const HISTORY_KEY = 'bugdays-grpc-history-v1';
const INSTALL_COMMAND = 'brew install bugdays-com/tap/holy-cors && holy-cors';
const SECRET_METADATA = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i;
const RESERVED_METADATA = /^(content-length|content-type|connection|host|origin|referer|te|trailer|transfer-encoding|grpc-timeout|grpc-encoding|grpc-accept-encoding|x-grpc-web|x-holy-cors-mode|x-user-agent)$/i;

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing gRPC client element: ${id}`);
  return element as T;
}

function getJson<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

function setJson(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage can be disabled. */ }
}

function download(name: string, content: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 500);
}

function headersObject(headers: Headers): Metadata {
  return Object.fromEntries([...headers.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function printableHeaders(headers: Metadata) {
  const entries = Object.entries(headers);
  return entries.length ? entries.map(([name, value]) => `${name}: ${value}`).join('\n') : '(none exposed)';
}

function byteDump(bytes: Uint8Array) {
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join(' ');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Hex (${bytes.length} bytes)\n${hex}\n\nBase64\n${btoa(binary)}`;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function initGrpcClient() {
  const root = document.querySelector('[data-tool-id="grpc-client"]') || document.body;
  if ((root as HTMLElement).dataset.grpcClientReady === 'true') return;
  (root as HTMLElement).dataset.grpcClientReady = 'true';

  const protoInput = byId<HTMLTextAreaElement>('proto-input');
  const protoFiles = byId<HTMLInputElement>('proto-files');
  const endpointInput = byId<HTMLInputElement>('endpoint-url');
  const transportInput = byId<HTMLSelectElement>('transport');
  const bridgeInput = byId<HTMLInputElement>('bridge-url');
  const requestInput = byId<HTMLTextAreaElement>('request-json');
  const servicesList = byId<HTMLDivElement>('services-list');
  const errorBox = byId<HTMLDivElement>('error-box');
  const sendButton = byId<HTMLButtonElement>('send-btn');
  const cancelButton = byId<HTMLButtonElement>('cancel-btn');
  const responseMessages = byId<HTMLPreElement>('response-messages');
  const responseHeaders = byId<HTMLPreElement>('response-headers');
  const responseTrailers = byId<HTMLPreElement>('response-trailers');
  const responseRaw = byId<HTMLPreElement>('response-raw');

  let sources: ProtoSource[] = [];
  let parsed: any = null;
  let selected: any = null;
  let activeController: AbortController | null = null;
  let lastResponse = { messages: [] as unknown[], headers: {} as Metadata, trailers: {} as Metadata, raw: new Uint8Array() };

  function showError(message: string) {
    errorBox.textContent = message;
    errorBox.classList.remove('hidden');
    errorBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function clearError() {
    errorBox.classList.add('hidden');
    errorBox.textContent = '';
  }

  function announce(message: string, error = false) {
    const badge = byId<HTMLSpanElement>('status-badge');
    badge.textContent = message;
    badge.className = error
      ? 'rounded-full bg-red-100 px-2.5 py-1 font-semibold text-red-700 dark:bg-red-950 dark:text-red-300'
      : 'rounded-full bg-green-100 px-2.5 py-1 font-semibold text-green-700 dark:bg-green-950 dark:text-green-300';
  }

  function methodKind(method: any) {
    if (method.requestStream && method.responseStream) return 'Bidi stream';
    if (method.requestStream) return 'Client stream';
    if (method.responseStream) return 'Server stream';
    return 'Unary';
  }

  function renderMethods(filter = '') {
    servicesList.replaceChildren();
    if (!parsed) return;
    const query = filter.trim().toLowerCase();
    let count = 0;
    for (const service of parsed.services) {
      const methods = service.methods.filter((method: any) => `${service.name} ${method.name}`.toLowerCase().includes(query));
      if (!methods.length) continue;
      const group = document.createElement('section');
      const heading = document.createElement('h3');
      heading.className = 'mb-1 truncate text-xs font-bold text-gray-500 dark:text-slate-400';
      heading.textContent = service.name;
      group.appendChild(heading);
      const stack = document.createElement('div');
      stack.className = 'space-y-1';
      for (const method of methods) {
        count += 1;
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.methodId = method.id;
        button.className = method.id === selected?.id
          ? 'w-full rounded-lg border border-indigo-300 bg-indigo-50 p-2 text-left dark:border-indigo-800 dark:bg-indigo-950/50'
          : 'w-full rounded-lg border border-transparent p-2 text-left hover:border-gray-200 hover:bg-white dark:hover:border-slate-700 dark:hover:bg-slate-900';
        const name = document.createElement('span');
        name.className = 'block truncate font-mono text-xs font-semibold text-gray-900 dark:text-slate-100';
        name.textContent = method.name;
        const kind = document.createElement('span');
        kind.className = 'mt-1 block text-[11px] text-gray-500 dark:text-slate-400';
        kind.textContent = methodKind(method);
        button.append(name, kind);
        button.addEventListener('click', () => selectMethod(method));
        stack.appendChild(button);
      }
      group.appendChild(stack);
      servicesList.appendChild(group);
    }
    if (!count) servicesList.textContent = 'No matching methods.';
  }

  function selectMethod(method: any, keepBody = false) {
    selected = method;
    byId('selected-method').textContent = method.path;
    byId('method-type').textContent = methodKind(method);
    byId('method-signature').textContent = `${method.requestType?.fullName || '?'} → ${method.responseType?.fullName || '?'}`;
    if (!keepBody) requestInput.value = JSON.stringify(makeRequestTemplate(method.requestType), null, 2);
    const unsupported = Boolean(method.requestStream);
    sendButton.disabled = unsupported;
    byId('request-validation').textContent = unsupported
      ? 'Client-streaming and bidirectional calls need a native client; browser request streams are not portable.'
      : `Validated and encoded as ${method.requestType?.fullName || 'protobuf'} in your browser.`;
    renderMethods(byId<HTMLInputElement>('method-search').value);
  }

  function parseSources(preferredMethod?: string, keepBody = false) {
    clearError();
    try {
      parsed = parseProtoSources(sources);
      const methodCount = parsed.services.reduce((total: number, service: any) => total + service.methods.length, 0);
      byId('contract-summary').textContent = `${sources.length} file${sources.length === 1 ? '' : 's'} · ${parsed.services.length} service${parsed.services.length === 1 ? '' : 's'} · ${methodCount} methods`;
      const warningBox = byId('proto-warnings');
      warningBox.textContent = parsed.warnings.join('\n');
      warningBox.classList.toggle('hidden', parsed.warnings.length === 0);
      const allMethods = parsed.services.flatMap((service: any) => service.methods);
      const method = allMethods.find((candidate: any) => candidate.id === preferredMethod) || allMethods[0];
      renderMethods();
      if (method) selectMethod(method, keepBody);
    } catch (error) {
      parsed = null;
      selected = null;
      servicesList.textContent = 'The contract could not be parsed.';
      showError(error instanceof Error ? error.message : 'Could not parse the proto definition.');
    }
  }

  function metadataRows() {
    return [...document.querySelectorAll<HTMLElement>('.grpc-metadata-row')];
  }

  function addMetadataRow(key = '', value = '') {
    const row = document.createElement('div');
    row.className = 'grpc-metadata-row grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2';
    const keyInput = document.createElement('input');
    keyInput.className = 'metadata-key min-w-0 rounded-lg border border-gray-300 bg-white p-2 font-mono text-xs dark:border-slate-600 dark:bg-slate-800';
    keyInput.placeholder = 'metadata-key';
    keyInput.value = key;
    const valueInput = document.createElement('input');
    valueInput.className = 'metadata-value min-w-0 rounded-lg border border-gray-300 bg-white p-2 font-mono text-xs dark:border-slate-600 dark:bg-slate-800';
    valueInput.placeholder = 'value';
    valueInput.value = value;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'rounded-lg px-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-950';
    remove.textContent = '×';
    remove.addEventListener('click', () => row.remove());
    row.append(keyInput, valueInput, remove);
    byId('metadata-list').appendChild(row);
  }

  function collectMetadata(includeSecrets = true) {
    const metadata: Metadata = {};
    for (const row of metadataRows()) {
      const key = row.querySelector<HTMLInputElement>('.metadata-key')?.value.trim().toLowerCase() || '';
      const value = row.querySelector<HTMLInputElement>('.metadata-value')?.value.trim() || '';
      if (!key || !value || (!includeSecrets && SECRET_METADATA.test(key))) continue;
      if (!/^[0-9a-z_.-]+$/.test(key)) throw new Error(`Invalid metadata name: ${key}`);
      if (RESERVED_METADATA.test(key)) throw new Error(`${key} is managed by the gRPC client and cannot be added as custom metadata.`);
      metadata[key] = value;
    }
    return metadata;
  }

  function restoreMetadata(metadata: Metadata = {}) {
    byId('metadata-list').replaceChildren();
    const entries = Object.entries(metadata);
    if (!entries.length) addMetadataRow();
    else for (const [key, value] of entries) addMetadataRow(key, value);
  }

  function collectSnapshot(includeProto = true): Snapshot {
    return {
      version: 1,
      transport: transportInput.value,
      endpoint: endpointInput.value,
      bridgeUrl: bridgeInput.value,
      deadline: byId<HTMLInputElement>('deadline-ms').value,
      ...(includeProto ? { protoSources: sources } : {}),
      methodId: selected?.id,
      request: requestInput.value,
      metadata: collectMetadata(false),
    };
  }

  function applySnapshot(snapshot: Partial<Snapshot>) {
    if (snapshot.transport) transportInput.value = snapshot.transport;
    if (snapshot.endpoint != null) endpointInput.value = snapshot.endpoint;
    if (snapshot.bridgeUrl) bridgeInput.value = snapshot.bridgeUrl;
    if (snapshot.deadline) byId<HTMLInputElement>('deadline-ms').value = snapshot.deadline;
    if (snapshot.protoSources?.length) {
      sources = snapshot.protoSources;
      protoInput.value = sources[0]?.content || '';
      parseSources(snapshot.methodId, true);
    } else if (parsed && snapshot.methodId) {
      const method = parsed.services.flatMap((service: any) => service.methods).find((candidate: any) => candidate.id === snapshot.methodId);
      if (method) selectMethod(method, true);
    }
    if (snapshot.request != null) requestInput.value = snapshot.request;
    restoreMetadata(snapshot.metadata || {});
    updateTransport();
  }

  function addAuth(headers: Metadata) {
    const type = byId<HTMLSelectElement>('auth-type').value;
    if (type === 'bearer') {
      const token = byId<HTMLInputElement>('bearer-token').value.trim();
      if (!token) throw new Error('Enter a bearer token or choose No auth.');
      headers.authorization = `Bearer ${token}`;
    } else if (type === 'basic') {
      const username = byId<HTMLInputElement>('basic-user').value;
      const password = byId<HTMLInputElement>('basic-password').value;
      if (!username) throw new Error('Enter a Basic Auth username or choose No auth.');
      headers.authorization = `Basic ${btoa(unescape(encodeURIComponent(`${username}:${password}`)))}`;
    }
  }

  async function checkBridge(showNotice = false) {
    const status = byId<HTMLSpanElement>('bridge-status');
    const notice = byId('bridge-notice');
    status.textContent = 'Checking…';
    status.className = 'rounded-full bg-gray-100 px-2.5 py-1 font-semibold text-gray-600 dark:bg-slate-800 dark:text-slate-300';
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 1800);
    try {
      const response = await fetch(`${bridgeInput.value.replace(/\/$/, '')}/api/v1/capabilities`, { signal: controller.signal, cache: 'no-store' });
      const capabilities = await response.json();
      if (!response.ok || !capabilities?.capabilities?.grpcNativeBridge) throw new Error('Upgrade required');
      status.textContent = `Ready · v${capabilities.version}`;
      status.className = 'rounded-full bg-green-100 px-2.5 py-1 font-semibold text-green-700 dark:bg-green-950 dark:text-green-300';
      notice.classList.add('hidden');
      return true;
    } catch {
      status.textContent = 'Not running';
      status.className = 'rounded-full bg-amber-100 px-2.5 py-1 font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-200';
      notice.classList.toggle('hidden', transportInput.value !== 'native' && !showNotice);
      return false;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function updateTransport() {
    const native = transportInput.value === 'native';
    byId('bridge-notice').classList.toggle('hidden', !native || byId('bridge-status').textContent?.startsWith('Ready'));
    if (native) void checkBridge();
  }

  async function sendRequest() {
    clearError();
    if (!selected) { showError('Load a proto contract and select a method first.'); return; }
    if (selected.requestStream) { showError('Client-streaming and bidirectional methods require a native client.'); return; }
    const rpcMethod = selected;
    if (transportInput.value === 'native' && !await checkBridge(true)) {
      showError(`Holy CORS is not reachable at ${bridgeInput.value}.\n\nRun: ${INSTALL_COMMAND}\nThen choose Check again and retry.`);
      return;
    }

    let framed: Uint8Array;
    let metadata: Metadata;
    let url: string;
    try {
      framed = frameGrpcMessage(encodeRequest(rpcMethod.requestType, requestInput.value));
      metadata = collectMetadata(true);
      addAuth(metadata);
      url = buildGrpcUrl(endpointInput.value, rpcMethod.path, transportInput.value, bridgeInput.value);
    } catch (error) {
      showError(error instanceof Error ? error.message : 'The request is invalid.');
      return;
    }

    const deadline = Number(byId<HTMLInputElement>('deadline-ms').value);
    const headers: Metadata = {
      'content-type': 'application/grpc-web+proto',
      'x-grpc-web': '1',
      'x-user-agent': 'bugdays-grpc-client/1',
      'grpc-accept-encoding': 'identity,gzip',
      ...metadata,
    };
    const grpcTimeout = grpcTimeoutHeader(deadline);
    if (grpcTimeout) headers['grpc-timeout'] = grpcTimeout;
    if (transportInput.value === 'native') headers['x-holy-cors-mode'] = 'grpc-native';

    activeController = new AbortController();
    const timeout = Number.isFinite(deadline) && deadline > 0 ? window.setTimeout(() => activeController?.abort('deadline'), deadline + 250) : null;
    sendButton.disabled = true;
    sendButton.textContent = 'Sending…';
    cancelButton.classList.remove('hidden');
    announce('Sending');
    byId('response-empty').classList.add('hidden');
    showTab('response', 'messages');
    responseMessages.textContent = '';
    responseHeaders.textContent = '';
    responseTrailers.textContent = '';
    responseRaw.textContent = '';
    const started = performance.now();
    const decoder = new GrpcWebFrameDecoder();
    const messages: unknown[] = [];
    const trailers: Metadata = {};
    const rawChunks: Uint8Array[] = [];
    let rawSize = 0;

    try {
      const response = await fetch(url, { method: 'POST', headers, body: framed, signal: activeController.signal });
      const responseHeaderMap = headersObject(response.headers);
      responseHeaders.textContent = printableHeaders(responseHeaderMap);
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/grpc')) {
        const message = await response.text();
        throw new Error(`${response.status} ${response.statusText}${message ? `\n${message}` : ''}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('This browser did not expose the response stream.');
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        rawChunks.push(value);
        rawSize += value.length;
        for (const frame of decoder.push(value)) {
          if (frame.trailer) {
            Object.assign(trailers, parseTrailerFrame(frame.data));
          } else {
            let messageBytes = frame.data;
            if (frame.compressed) {
              const encoding = response.headers.get('grpc-encoding') || '';
              if (encoding !== 'gzip') throw new Error(`Unsupported gRPC response compression: ${encoding || 'unknown'}.`);
              messageBytes = ungzip(messageBytes);
            }
            messages.push(decodeResponse(rpcMethod.responseType, messageBytes));
            responseMessages.textContent = JSON.stringify(messages.length === 1 && !rpcMethod.responseStream ? messages[0] : messages, null, 2);
            byId('message-count').textContent = `(${messages.length})`;
          }
        }
      }
      decoder.finish();
      const raw = new Uint8Array(rawSize);
      let offset = 0;
      for (const chunk of rawChunks) { raw.set(chunk, offset); offset += chunk.length; }
      responseRaw.textContent = byteDump(raw);
      responseTrailers.textContent = printableHeaders(trailers);
      if (!messages.length) responseMessages.textContent = '(no response messages)';

      const grpcStatus = trailers['grpc-status'] ?? response.headers.get('grpc-status') ?? (response.ok ? '0' : '2');
      const grpcMessage = trailers['grpc-message'] ?? response.headers.get('grpc-message') ?? '';
      const successful = String(grpcStatus) === '0';
      announce(grpcStatusLabel(grpcStatus), !successful);
      byId('response-time').textContent = `${Math.round(performance.now() - started)} ms`;
      byId('response-size').textContent = `${rawSize.toLocaleString()} bytes`;
      lastResponse = { messages, headers: responseHeaderMap, trailers, raw };
      if (!successful) showError(`gRPC ${grpcStatusLabel(grpcStatus)}${grpcMessage ? `: ${decodeURIComponent(grpcMessage)}` : ''}`);

      if (byId<HTMLInputElement>('save-history').checked) {
        const history = getJson<any[]>(HISTORY_KEY, []);
        history.unshift({ at: new Date().toISOString(), status: grpcStatusLabel(grpcStatus), elapsed: Math.round(performance.now() - started), snapshot: collectSnapshot(false), metadata: redactMetadata(collectMetadata(false)) });
        setJson(HISTORY_KEY, history.slice(0, 30));
        renderHistory();
      }
      (window as any).gtag?.('event', 'grpc_request', { transport: transportInput.value, rpc_type: methodKind(rpcMethod), grpc_status: String(grpcStatus) });
    } catch (error) {
      const aborted = activeController?.signal.aborted;
      const message = aborted ? 'Request cancelled or deadline exceeded.' : (error instanceof Error ? error.message : 'Request failed.');
      announce(aborted ? 'Cancelled' : 'Request failed', true);
      if (transportInput.value === 'native' && /fetch|network|load failed/i.test(message)) {
        byId('bridge-notice').classList.remove('hidden');
        showError(`${message}\n\nThe local bridge or target service could not be reached. Confirm Holy CORS is running, then verify the endpoint and retry.`);
      } else showError(message);
    } finally {
      if (timeout != null) window.clearTimeout(timeout);
      activeController = null;
      sendButton.disabled = Boolean(selected?.requestStream);
      sendButton.textContent = 'Send';
      cancelButton.classList.add('hidden');
    }
  }

  function showTab(group: string, tab: string) {
    document.querySelectorAll<HTMLElement>(`[data-tab-group="${group}"] .tab-btn`).forEach((button) => {
      const active = button.dataset.tab === tab;
      button.classList.toggle('border-indigo-600', active);
      button.classList.toggle('text-indigo-600', active);
      button.classList.toggle('border-transparent', !active);
      button.classList.toggle('text-gray-500', !active);
    });
    document.querySelectorAll<HTMLElement>(`[data-tab-panel^="${group}:"]`).forEach((panel) => panel.classList.toggle('hidden', panel.dataset.tabPanel !== `${group}:${tab}`));
    if (group === 'response') byId('response-empty').classList.add('hidden');
  }

  function renderSaved() {
    renderSnapshotList('saved-list', getJson<any[]>(SAVED_KEY, []), 'saved');
  }

  function renderHistory() {
    renderSnapshotList('history-list', getJson<any[]>(HISTORY_KEY, []), 'history');
  }

  function renderSnapshotList(elementId: string, items: any[], kind: 'saved' | 'history') {
    const list = byId(elementId);
    list.replaceChildren();
    if (!items.length) { list.textContent = kind === 'saved' ? 'Nothing saved yet.' : 'No requests yet.'; return; }
    for (const [index, item] of items.entries()) {
      const row = document.createElement('div');
      row.className = 'flex items-center justify-between gap-3 rounded-lg border border-gray-200 p-2 dark:border-slate-700';
      const load = document.createElement('button');
      load.className = 'min-w-0 flex-1 text-left';
      const title = document.createElement('strong');
      title.className = 'block truncate text-xs text-gray-800 dark:text-slate-100';
      title.textContent = item.name || item.snapshot?.methodId || 'gRPC request';
      const detail = document.createElement('span');
      detail.className = 'block truncate text-[11px] text-gray-500 dark:text-slate-400';
      detail.textContent = kind === 'history' ? `${item.status} · ${item.elapsed} ms · ${new Date(item.at).toLocaleString()}` : item.snapshot?.endpoint || '';
      load.append(title, detail);
      load.addEventListener('click', () => applySnapshot(item.snapshot));
      const remove = document.createElement('button');
      remove.className = 'px-2 text-xs text-red-500';
      remove.textContent = 'Delete';
      remove.addEventListener('click', () => {
        items.splice(index, 1);
        setJson(kind === 'saved' ? SAVED_KEY : HISTORY_KEY, items);
        kind === 'saved' ? renderSaved() : renderHistory();
      });
      row.append(load, remove);
      list.appendChild(row);
    }
  }

  document.querySelectorAll<HTMLElement>('[data-tab-group]').forEach((group) => group.querySelectorAll<HTMLElement>('.tab-btn').forEach((button) => button.addEventListener('click', () => showTab(group.dataset.tabGroup || '', button.dataset.tab || ''))));
  byId('parse-proto-btn').addEventListener('click', () => { sources = [{ name: 'pasted.proto', content: protoInput.value }]; parseSources(); });
  byId('load-sample-btn').addEventListener('click', () => { sources = [{ name: 'greeter.proto', content: SAMPLE_PROTO }]; protoInput.value = SAMPLE_PROTO; parseSources(); });
  protoFiles.addEventListener('change', async () => {
    sources = await Promise.all([...protoFiles.files || []].map(async (file) => ({ name: file.webkitRelativePath || file.name, content: await file.text() })));
    protoInput.value = sources[0]?.content || '';
    parseSources();
  });
  byId<HTMLInputElement>('method-search').addEventListener('input', (event) => renderMethods((event.target as HTMLInputElement).value));
  byId('format-request-btn').addEventListener('click', () => { try { requestInput.value = JSON.stringify(JSON.parse(requestInput.value), null, 2); clearError(); } catch { showError('Request body is not valid JSON.'); } });
  byId('add-metadata-btn').addEventListener('click', () => addMetadataRow());
  byId<HTMLSelectElement>('auth-type').addEventListener('change', (event) => {
    const value = (event.target as HTMLSelectElement).value;
    byId('bearer-fields').classList.toggle('hidden', value !== 'bearer');
    byId('basic-fields').classList.toggle('hidden', value !== 'basic');
  });
  transportInput.addEventListener('change', updateTransport);
  bridgeInput.addEventListener('change', () => void checkBridge());
  byId('check-bridge-btn').addEventListener('click', () => void checkBridge(true));
  byId('copy-install-btn').addEventListener('click', () => void navigator.clipboard.writeText(INSTALL_COMMAND));
  sendButton.addEventListener('click', () => void sendRequest());
  cancelButton.addEventListener('click', () => activeController?.abort('user'));
  byId('save-request-btn').addEventListener('click', () => {
    if (!selected) { showError('Select a method before saving the request.'); return; }
    const name = window.prompt('Saved request name', selected.path) || selected.path;
    const saved = getJson<any[]>(SAVED_KEY, []);
    saved.unshift({ name, snapshot: collectSnapshot(true) });
    setJson(SAVED_KEY, saved.slice(0, 20));
    renderSaved();
  });
  byId('clear-saved-btn').addEventListener('click', () => { setJson(SAVED_KEY, []); renderSaved(); });
  byId('clear-history-btn').addEventListener('click', () => { setJson(HISTORY_KEY, []); renderHistory(); });
  byId('copy-grpcurl-btn').addEventListener('click', async () => {
    if (!selected) { showError('Select a method first.'); return; }
    try {
      const metadata = collectMetadata(false);
      const flags = Object.entries(metadata).map(([key, value]) => `-H ${shellQuote(`${key}: ${value}`)}`).join(' ');
      const plaintext = /^http:\/\//i.test(endpointInput.value) || !/^https:\/\//i.test(endpointInput.value);
      const endpoint = endpointInput.value.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const command = `grpcurl ${plaintext ? '-plaintext ' : ''}${flags ? `${flags} ` : ''}-d ${shellQuote(requestInput.value)} ${shellQuote(endpoint)} ${shellQuote(selected.id)}`;
      await navigator.clipboard.writeText(command);
      announce('grpcurl copied');
    } catch (error) { showError(error instanceof Error ? error.message : 'Could not copy grpcurl.'); }
  });
  byId('export-btn').addEventListener('click', () => download(`grpc-request-${Date.now()}.json`, JSON.stringify({ kind: 'bugdays-grpc-request', exportedAt: new Date().toISOString(), snapshot: collectSnapshot(true) }, null, 2)));
  byId<HTMLInputElement>('import-state').addEventListener('change', async (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.kind !== 'bugdays-grpc-request' || !data.snapshot) throw new Error('This is not a Bug Days gRPC request export.');
      applySnapshot(data.snapshot);
    } catch (error) { showError(error instanceof Error ? error.message : 'Could not import request.'); }
  });
  byId('copy-response-btn').addEventListener('click', () => void navigator.clipboard.writeText(JSON.stringify(lastResponse.messages, null, 2)));
  byId('download-response-btn').addEventListener('click', () => download(`grpc-response-${Date.now()}.json`, JSON.stringify({ messages: lastResponse.messages, headers: lastResponse.headers, trailers: lastResponse.trailers }, null, 2)));

  ShareManager.register({
    tool: 'grpc-client',
    customCollect: () => collectSnapshot(true) as unknown as Record<string, any>,
    customRestore: (data) => applySnapshot(data as Partial<Snapshot>),
  });

  restoreMetadata();
  renderSaved();
  renderHistory();
  updateTransport();
}
