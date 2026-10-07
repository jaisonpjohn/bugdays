import { createJsonEditor } from './json-editor.ts';
import { ShareManager } from './share.ts';
import { track } from './analytics.ts';
import { schemaExample, invalidExample, validExample, structuredExample } from './schema-doctor-examples.ts';
import type { DoctorInput, DoctorReport, Dialect, Profile } from './schema-doctor.ts';

function init() {
  const root = document.getElementById('schema-doctor');
  if (!root || root.dataset.init) return;
  root.dataset.init = 'true';
  const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(`doctor-${id}`) as T;
  const schema = createJsonEditor(el<HTMLTextAreaElement>('schema'));
  const json = createJsonEditor(el<HTMLTextAreaElement>('json'));
  const dialect = el<HTMLSelectElement>('dialect'), profile = el<HTMLSelectElement>('profile');
  const formats = el<HTMLInputElement>('formats'), auto = el<HTMLInputElement>('auto');
  const review = el<HTMLDialogElement>('share-review');
  // Undo must remain reachable after successful edits remove the suggestions panel.
  el('clear').after(el('undo'));
  let references: string[] = [], report: DoctorReport | null = null, worker: Worker | null = null;
  let debounce: ReturnType<typeof setTimeout>, timeout: ReturnType<typeof setTimeout>;
  let request = 0, approved = '', undoSchema: string | null = null, disposed = false;
  const text = (parent: HTMLElement, tag: string, value: string, className = '') => {
    const child = document.createElement(tag); child.textContent = value; child.className = className; parent.append(child); return child;
  };
  function state(): DoctorInput { return { schema: schema.getValue(), json: json.getValue(), dialect: dialect.value as Dialect, profile: profile.value as Profile, formats: formats.checked, references: [...references] }; }
  function notice(message: string) { el('notice').textContent = message; }
  function setBusy(busy: boolean) { el('cancel').hidden = !busy; el<HTMLButtonElement>('run').disabled = busy; }
  function stop() { clearTimeout(timeout); worker?.terminate(); worker = null; request++; setBusy(false); }
  function stale() {
    stop(); report = null; approved = ''; el('summary').hidden = true; el('fixes').hidden = true; el('findings').replaceChildren();
    el<HTMLButtonElement>('copy').disabled = true; el<HTMLButtonElement>('export').disabled = true;
    el('profile-note').hidden = profile.value !== 'openai';
    el('status').textContent = schema.getValue().trim() ? 'Inputs changed. Ready to validate.' : 'Paste a schema, or try an example above.';
  }
  function changed() {
    stale(); clearTimeout(debounce);
    if (auto.checked && schema.getValue().trim()) debounce = setTimeout(run, 600);
  }
  function renderReferences() {
    const list = el('ref-list'); list.replaceChildren(); el('ref-count').textContent = `(${references.length})`;
    references.forEach((raw, i) => {
      const li = document.createElement('li'); li.className = 'flex flex-wrap items-center gap-3 break-all';
      let label = `Reference ${i + 1}`;
      try { label += ` · ${JSON.parse(raw).$id || 'missing $id'}`; } catch { label += ' · invalid JSON'; }
      text(li, 'span', label);
      const remove = text(li, 'button', 'Remove', 'doctor-link'); remove.setAttribute('aria-label', `Remove reference ${i + 1}`);
      remove.addEventListener('click', () => { references.splice(i, 1); renderReferences(); changed(); }); list.append(li);
    });
  }
  function render(next: DoctorReport) {
    report = next; const errors = next.findings.filter(f => f.severity === 'error'), warnings = next.findings.filter(f => f.severity === 'warning');
    el('status').textContent = `${errors.length ? `${errors.length}${next.truncated ? '+' : ''} issue${errors.length === 1 ? '' : 's'} found` : 'Checks complete'}${warnings.length ? ` · ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : ''}. Select a finding to locate it.`;
    const summary = el('summary'); summary.replaceChildren(); summary.hidden = false;
    for (const label of [`Draft: ${next.dialect || 'not determined'}`, `Schema: ${next.schemaValid ? 'valid' : 'needs attention'}`, `Document: ${next.dataValid === null ? 'not checked' : next.dataValid ? 'valid' : 'invalid'}`, `Formats: ${next.formats ? 'asserted' : 'annotations only'}`]) text(summary, 'span', label, 'doctor-badge');
    if (next.profile === 'openai') text(summary, 'span', `Provider: ${!next.schemaValid ? 'not checked' : next.findings.some(f => f.source === 'profile') ? 'review findings' : 'no issues in checked rules'}`, 'doctor-badge');
    const findings = el('findings'); findings.replaceChildren();
    if (!next.findings.length) text(findings, 'p', next.dataValid ? 'Your JSON matches this schema. No values were changed.' : 'Schema checks passed. Add a JSON document to test it against these rules.', 'text-sm text-emerald-700 dark:text-emerald-300');
    for (const finding of next.findings) {
      const card = document.createElement('div'); card.className = 'doctor-finding'; card.dataset.severity = finding.severity;
      const source = finding.source === 'profile' ? 'Provider check' : finding.source === 'json' ? 'Document' : finding.source === 'reference' ? `Reference ${(finding.reference ?? 0) + 1}` : 'Schema';
      const heading = text(card, 'button', `${source} · ${finding.path || '/ (root)'}${finding.line ? ` · line ${finding.line}:${finding.column}` : ''}`, 'doctor-link text-left break-all');
      heading.addEventListener('click', () => {
        if (finding.source === 'reference') { el<HTMLDetailsElement>('references').open = true; el('references').scrollIntoView({ block: 'center' }); return; }
        const editor = finding.source === 'json' ? json : schema;
        editor.element.scrollIntoView({ block: 'center' }); editor.focusPosition(finding.offset ?? 0); editor.showError(finding.offset ?? 0);
      });
      text(card, 'p', finding.message, 'font-semibold'); text(card, 'p', finding.hint, 'text-slate-600 dark:text-slate-300');
      if (finding.schemaPath) text(card, 'p', `Schema rule: ${finding.schemaPath}`, 'font-mono text-xs text-slate-500 dark:text-slate-400');
      findings.append(card);
    }
    if (next.truncated) text(findings, 'p', 'Showing the first 200 findings. Reduce the example to focus the diagnosis.', 'text-sm');
    el('fixes').hidden = !next.edits.length; el<HTMLTextAreaElement>('proposed').value = next.proposedSchema ?? '';
    const edits = el('edit-list'); edits.replaceChildren();
    for (const edit of next.edits) {
      const row = document.createElement('div'); row.className = 'rounded-lg bg-slate-50 p-3 text-xs break-all dark:bg-slate-900';
      text(row, 'p', edit.path, 'font-mono font-semibold'); text(row, 'p', `Before: ${edit.before}`); text(row, 'p', `After: ${edit.after}`); text(row, 'p', edit.reason, 'mt-1'); edits.append(row);
    }
    el<HTMLButtonElement>('copy').disabled = false; el<HTMLButtonElement>('export').disabled = false;
  }
  function run() {
    clearTimeout(debounce); stale();
    if (!schema.getValue().trim()) { notice('Paste a schema first, or load an example.'); return; }
    notice('');
    const input = state();
    const sizes = [input.schema, input.json, ...input.references].map(s => new TextEncoder().encode(s).length);
    if (sizes.some(n => n > 500_000) || sizes.reduce((a, b) => a + b, 0) > 1_000_000) { notice('Use inputs under 500 KB each and 1 MB combined. A smaller example is easier to share, too.'); return; }
    ShareManager.setLastAction('validate'); setBusy(true); el('status').textContent = 'Checking locally…';
    requestWorker({ input }, result => render(result.report));
  }
  function requestWorker(payload: Record<string, unknown>, done: (result: any) => void) {
    const id = ++request;
    try {
      worker = new Worker(new URL('../workers/schema-doctor.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = event => { if (disposed || event.data.id !== request) return; stop(); done(event.data); };
      worker.onerror = () => { stop(); el('status').textContent = 'The validator could not finish. Try a smaller schema or reload this page.'; };
      timeout = setTimeout(() => { stop(); el('status').textContent = 'Stopped after 5 seconds. Reduce the schema or inspect expensive patterns and recursive references.'; }, 5000);
      worker.postMessage({ id, ...payload });
    } catch { stop(); el('status').textContent = 'This browser could not start the validator worker. Try an up-to-date browser.'; }
  }
  function loadSample(kind: 'invalid' | 'valid' | 'structured') {
    clearTimeout(debounce); undoSchema = null; el<HTMLButtonElement>('undo').disabled = true;
    references = []; renderReferences(); dialect.value = 'auto'; formats.checked = false;
    profile.value = kind === 'structured' ? 'openai' : 'standard';
    schema.setValue(kind === 'structured' ? structuredExample : schemaExample);
    json.setValue(kind === 'structured' ? '{"summary":"A fictional support request"}' : kind === 'valid' ? validExample : invalidExample);
    run(); track('tool_used', { tool: 'json-schema-validator', action: 'sample' });
  }
  function reportText() {
    if (!report) return '';
    const { proposedSchema, edits, ...findingsOnly } = report;
    return JSON.stringify({ ...findingsOnly, note: 'Original documents excluded. Field names, paths and diagnostic text included; review before distributing.' }, null, 2);
  }
  async function readFile(file: File) { if (file.size > 500_000) throw new Error('Choose a file under 500 KB.'); return file.text(); }
  for (const which of ['schema', 'json'] as const) {
    const editor = which === 'schema' ? schema : json;
    editor.element.addEventListener('input', changed);
    el(`format-${which}`).addEventListener('click', () => {
      clearTimeout(debounce); stale(); setBusy(true);
      requestWorker({ operation: 'format', input: editor.getValue() }, result => {
        if (result.error) { notice(`${result.error} Validate to locate the issue.`); return; }
        editor.setValue(result.formatted); changed(); notice('Formatted locally.');
      });
    });
    const input = el<HTMLInputElement>(`${which}-file`);
    async function loadFile(file: File) { try { editor.setValue(await readFile(file)); changed(); notice('File opened locally.'); } catch (error) { notice((error as Error).message); } }
    input.addEventListener('change', () => { const file = input.files?.[0]; input.value = ''; if (file) void loadFile(file); });
    const shell = editor.element.closest<HTMLElement>('[data-json-editor]')!;
    shell.addEventListener('dragover', e => e.preventDefault());
    shell.addEventListener('drop', e => { e.preventDefault(); const file = e.dataTransfer?.files[0]; if (file) void loadFile(file); });
  }
  el<HTMLInputElement>('ref-files').addEventListener('change', async event => {
    const input = event.target as HTMLInputElement, files = [...(input.files ?? [])]; input.value = '';
    if (references.length + files.length > 12) { notice('Use no more than 12 reference files.'); return; }
    try { const values = await Promise.all(files.map(readFile)); references.push(...values); renderReferences(); changed(); } catch (error) { notice((error as Error).message); }
  });
  [dialect, profile, formats].forEach(input => input.addEventListener('change', changed));
  auto.addEventListener('change', () => { clearTimeout(debounce); if (auto.checked && schema.getValue().trim()) changed(); });
  el('run').addEventListener('click', run);
  el('cancel').addEventListener('click', () => { clearTimeout(debounce); stop(); el('status').textContent = 'Validation cancelled. Your inputs are unchanged.'; });
  for (const kind of ['invalid', 'valid', 'structured'] as const) el(kind).addEventListener('click', () => loadSample(kind));
  el('clear').addEventListener('click', () => {
    clearTimeout(debounce); schema.setValue(''); json.setValue(''); references = []; renderReferences(); undoSchema = null; el<HTMLButtonElement>('undo').disabled = true; stale(); notice('');
    history.replaceState(null, '', location.pathname + location.search);
  });
  el('apply').addEventListener('click', () => {
    if (!report?.proposedSchema) return;
    undoSchema = schema.getValue(); schema.setValue(report.proposedSchema); el<HTMLButtonElement>('undo').disabled = false;
    run(); notice('Reviewed schema edits applied. Undo is available below.');
  });
  el('undo').addEventListener('click', () => { if (undoSchema === null) return; schema.setValue(undoSchema); undoSchema = null; el<HTMLButtonElement>('undo').disabled = true; run(); notice('Original schema restored.'); });
  el('copy').addEventListener('click', async () => { if (!report) return; try { await navigator.clipboard.writeText(reportText()); notice('Report copied. Original documents are not included.'); track('export_used', { tool: 'json-schema-validator', format: 'clipboard' }); } catch { notice('Clipboard access was blocked. Download the report instead.'); } });
  el('export').addEventListener('click', () => {
    if (!report) return;
    const href = URL.createObjectURL(new Blob([reportText()], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = href; a.download = 'json-schema-diagnosis.json'; a.click(); setTimeout(() => URL.revokeObjectURL(href), 1000);
    track('export_used', { tool: 'json-schema-validator', format: 'json' });
  });
  function openReview() {
    if (!schema.getValue().trim()) { notice('Add a schema before sharing an example.'); return; }
    const raw = JSON.stringify(state());
    if (new TextEncoder().encode(raw).length > 1_000_000) { notice('Use a smaller example before sharing (under 1 MB).'); return; }
    const snapshot = state();
    el('share-preview').textContent = [
      `SCHEMA\n${snapshot.schema}`, `JSON DOCUMENT\n${snapshot.json || '(not provided)'}`,
      `SETTINGS\nDialect: ${snapshot.dialect}\nProfile: ${snapshot.profile}\nAssert formats: ${snapshot.formats}`,
      ...snapshot.references.map((value, i) => `REFERENCE ${i + 1}\n${value}`),
    ].join('\n\n');
    el<HTMLInputElement>('share-ack').checked = false; el<HTMLButtonElement>('review-continue').disabled = true; review.showModal();
  }
  el('share').addEventListener('click', openReview);
  el('review-close').addEventListener('click', () => review.close());
  el('share-ack').addEventListener('change', () => { el<HTMLButtonElement>('review-continue').disabled = !el<HTMLInputElement>('share-ack').checked; });
  el('review-continue').addEventListener('click', () => { approved = JSON.stringify(state()); review.close(); ShareManager.setLastAction('validate'); document.getElementById('share-btn')?.click(); });
  const interceptShare = (event: MouseEvent) => {
    if (!(event.target instanceof Element) || !event.target.closest('.share-trigger, #share-btn-floating')) return;
    if (approved === JSON.stringify(state())) return;
    event.preventDefault(); event.stopImmediatePropagation(); openReview();
  };
  document.addEventListener('click', interceptShare, true);
  ShareManager.register({ tool: 'json-schema-validator', actions: { validate: run },
    customCollect: () => approved === JSON.stringify(state()) ? state() : {},
    customRestore(data) {
      const invalidReferences = data.references !== undefined && (!Array.isArray(data.references) || data.references.length > 12 || data.references.some((v: unknown) => typeof v !== 'string' || v.length > 500_000));
      if (typeof data.schema !== 'string' || data.schema.length > 500_000 || typeof data.json !== 'string' || data.json.length > 500_000 || invalidReferences) {
        schema.setValue(''); json.setValue(''); references = []; renderReferences(); stale(); notice('This shared example is invalid or exceeds the input limits. No partial data was restored.'); return;
      }
      schema.setValue(data.schema);
      json.setValue(data.json);
      dialect.value = ['auto', 'draft7', '2019-09', '2020-12'].includes(data.dialect) ? data.dialect : 'auto';
      profile.value = data.profile === 'openai' ? 'openai' : 'standard'; formats.checked = data.formats === true;
      references = Array.isArray(data.references) ? [...data.references] : [];
      renderReferences(); changed();
    },
  });
  document.addEventListener('astro:before-swap', () => { disposed = true; clearTimeout(debounce); stop(); document.removeEventListener('click', interceptShare, true); }, { once: true });
}
init();
document.addEventListener('astro:after-swap', init);
