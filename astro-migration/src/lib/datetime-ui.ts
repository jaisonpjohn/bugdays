import { ShareManager } from './share.ts';
import { browserTimeZone, formatsForInstant, parseDateInput, timeZones, validTimeZone } from './datetime.ts';
import type { DateTimeField, ParsedTime } from './datetime.ts';

function init() {
  const root = document.getElementById('datetime-workspace');
  if (!root || root.dataset.init) return;
  root.dataset.init = 'true';
  const lifetime = new AbortController(), signal = lifetime.signal;
  const fields = ['unix-sec', 'unix-ms', 'iso8601', 'human', 'datepicker', 'rfc2822'] as const;
  const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const inputs = Object.fromEntries(fields.map(id => [id, el<HTMLInputElement>(id)])) as Record<DateTimeField, HTMLInputElement>;
  // Keep the published timezone share key as the target/display timezone.
  const zone = el<HTMLSelectElement>('timezone'), sourceZone = el<HTMLSelectElement>('source-timezone');
  const occurrence = el<HTMLSelectElement>('dst-occurrence');
  const sourceIso = el<HTMLInputElement>('source-iso8601'), targetDate = el<HTMLInputElement>('target-datepicker');
  const local = browserTimeZone();
  const zones = timeZones(local);
  for (const select of [sourceZone, zone]) for (const value of [local, ...zones.filter(z => z !== local)]) {
    const option = document.createElement('option'); option.value = value;
    option.textContent = value === local ? `${value} — your timezone` : value;
    select.append(option);
  }
  sourceZone.value = local; zone.value = 'UTC';
  el('local-zone').textContent = `Your timezone: ${local}`;
  let instant: number | null = null, pending: DateTimeField | null = null;
  let sourceWall = false, occurrenceField: DateTimeField | null = null;
  let candidates: number[] = [];
  const status = (text: string) => { el('datetime-status').textContent = text; };
  function enabled() {
    el<HTMLButtonElement>('share-time-btn').disabled = instant === null;
    el<HTMLButtonElement>('swap-zones-btn').disabled = instant === null;
    root!.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach(button => { button.disabled = instant === null; });
  }
  function hideError() {
    el('error-box').classList.add('hidden'); fields.forEach(field => inputs[field].removeAttribute('aria-invalid'));
  }
  function resetOccurrences() {
    candidates = []; occurrenceField = null; occurrence.replaceChildren(); el('dst-choice').classList.add('hidden');
  }
  function clear(source?: DateTimeField) {
    instant = null; resetOccurrences();
    fields.forEach(field => { if (field !== source) inputs[field].value = ''; });
    sourceIso.value = ''; targetDate.value = '';
    for (const id of ['source-offset', 'zone-offset']) el(id).textContent = 'UTC offset depends on the date';
    enabled();
  }
  function fail(error: unknown, source?: DateTimeField) {
    clear(source); hideError();
    el('error-box').textContent = error instanceof Error ? error.message : 'Check the date and timezone.';
    el('error-box').classList.remove('hidden');
    if (source) inputs[source].setAttribute('aria-invalid', 'true');
    status('Other values will update when the entered time is valid.');
  }
  function render(ms: number, source?: DateTimeField) {
    // Compute the complete result before touching any input, so a failure never
    // leaves a mixture of values representing different moments.
    const values = formatsForInstant(ms, zone.value), sourceValues = formatsForInstant(ms, sourceZone.value);
    instant = ms; hideError();
    fields.forEach(field => { if (field !== source) inputs[field].value = field === 'datepicker' ? sourceValues[field] : values[field]; });
    sourceIso.value = sourceValues.iso8601; targetDate.value = values.datepicker;
    el('source-offset').textContent = `UTC offset ${sourceValues.offset}`;
    el('zone-offset').textContent = `UTC offset ${values.offset}`;
    status('All fields represent the same moment. Conversion stays in your browser.');
    ShareManager.setLastAction('convert'); enabled();
  }
  function showOccurrences(result: ParsedTime, field: DateTimeField) {
    occurrenceField = field;
    candidates = result.candidates; occurrence.replaceChildren();
    el('dst-choice').classList.toggle('hidden', candidates.length < 2);
    candidates.forEach((ms, index) => {
      const option = document.createElement('option'); option.value = String(ms);
      option.textContent = `${index === 0 ? 'First' : 'Second'} occurrence · ${formatsForInstant(ms, field === 'datepicker' ? sourceZone.value : zone.value).offset}`;
      occurrence.append(option);
    });
  }
  function convert(field: DateTimeField, normalize = false) {
    pending = field;
    sourceWall = field === 'datepicker';
    if (!inputs[field].value.trim()) { clear(field); hideError(); status('Enter a time or choose Use current time.'); return; }
    try {
      const result = parseDateInput(field, inputs[field].value, field === 'datepicker' ? sourceZone.value : zone.value);
      const choice = candidates.includes(instant!) && result.candidates.includes(instant!) ? instant! : result.instant;
      render(choice, normalize ? undefined : field); showOccurrences(result, field); occurrence.value = String(choice);
    } catch (error) { fail(error, field); }
  }
  for (const field of fields) {
    inputs[field].addEventListener('input', () => convert(field), { signal });
    // Keep the typed value and caret while editing; normalize it on commit.
    inputs[field].addEventListener('change', () => convert(field, true), { signal });
  }
  zone.addEventListener('change', () => {
    if (instant !== null) {
      try { render(instant); if (occurrenceField !== 'datepicker') resetOccurrences(); }
      catch (error) { fail(error); }
    } else if (pending && ['iso8601', 'human', 'rfc2822'].includes(pending)) convert(pending, true);
  }, { signal });
  sourceZone.addEventListener('change', () => {
    // A deliberately entered source clock time stays put when its zone changes.
    // Epochs, offset-bearing dates and "now" are absolute instants instead.
    if (sourceWall) convert('datepicker', true);
    else if (instant !== null) { try { render(instant); } catch (error) { fail(error); } }
  }, { signal });
  el('swap-zones-btn').addEventListener('click', () => {
    if (instant === null) return;
    const value = sourceZone.value; sourceZone.value = zone.value; zone.value = value;
    sourceWall = false; pending = null; resetOccurrences();
    try { render(instant); } catch (error) { fail(error); }
  }, { signal });
  occurrence.addEventListener('change', () => {
    const selected = Number(occurrence.value);
    if (candidates.includes(selected)) { render(selected); }
  }, { signal });
  el('now-btn').addEventListener('click', () => {
    pending = null; sourceWall = false; resetOccurrences(); render(Date.now());
  }, { signal });
  el('clear-btn').addEventListener('click', () => { clear(); hideError(); pending = null; sourceWall = false; status('Enter a time or choose Use current time.'); }, { signal });
  el('share-time-btn').addEventListener('click', () => el('share-btn')?.click(), { signal });
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-copy]')) button.addEventListener('click', async () => {
    if (instant === null) return;
    try { await navigator.clipboard.writeText(el<HTMLInputElement>(button.dataset.copy!).value); if (!signal.aborted) status('Copied.'); }
    catch { if (!signal.aborted) status('Clipboard access was unavailable. Select the value and copy it manually.'); }
  }, { signal });
  ShareManager.register({
    tool: 'datetime-converter', actions: { convert: () => { if (instant !== null) render(instant); } },
    customCollect: () => instant === null ? {} : { unixSec: formatsForInstant(instant, zone.value)['unix-sec'], unixMs: String(instant), timezone: zone.value, sourceTimezone: sourceZone.value, ...(sourceWall ? { sourceWall: true } : {}) },
    customRestore: data => {
      clear(); hideError(); pending = null; sourceWall = false;
      try {
        // Old links used unixSec and defaulted to UTC. Keep them valid; new
        // links include exact milliseconds and freeze "now" rather than replay it.
        const value = typeof data.timezone === 'string' ? data.timezone : 'UTC';
        const source = typeof data.sourceTimezone === 'string' ? data.sourceTimezone : value;
        if (!validTimeZone(value) || !validTimeZone(source)) throw new Error('This shared link uses an unsupported timezone.');
        for (const [select, selected] of [[zone, value], [sourceZone, source]] as const) {
          if (!Array.from(select.options).some(option => option.value === selected)) {
            const option = document.createElement('option'); option.value = selected; option.textContent = selected; select.append(option);
          }
          select.value = selected;
        }
        const field = data.unixMs !== undefined ? 'unix-ms' : 'unix-sec';
        const text = data.unixMs ?? data.unixSec;
        if (text === '' || text === undefined) { status('This shared link contains no timestamp.'); return; }
        if (typeof text !== 'string' && typeof text !== 'number') throw new Error('This shared timestamp is invalid.');
        render(parseDateInput(field, String(text), value).instant);
        sourceWall = data.sourceWall === true;
        if (sourceWall) {
          pending = 'datepicker'; showOccurrences(parseDateInput('datepicker', inputs.datepicker.value, source), 'datepicker');
          occurrence.value = String(instant);
        }
      } catch (error) { fail(error); }
    },
  });
  render(Date.now());
  document.addEventListener('astro:before-swap', () => lifetime.abort(), { once: true });
}
init(); document.addEventListener('astro:after-swap', init);
