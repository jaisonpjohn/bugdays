export interface JsonErrorLocation {
  position: number | null;
  line: number | null;
  column: number | null;
}

export interface JsonEditor {
  element: HTMLTextAreaElement;
  getValue(): string;
  setValue(value: string): void;
  refresh(): void;
  setSearch(query: string, activeMatch?: number): number;
  getMatches(): number[];
  focusMatch(index: number): void;
  showError(position: number | null): void;
  clearError(): void;
  focusPosition(position: number): void;
  destroy(): void;
}

const MAX_SEARCH_MATCHES = 500;

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function searchOccurrences(value: string, query: string): number[] {
  if (!query) return [];
  const needle = query.toLocaleLowerCase();
  const haystack = value.toLocaleLowerCase();
  const matches: number[] = [];
  let start = 0;
  while (matches.length < MAX_SEARCH_MATCHES) {
    const found = haystack.indexOf(needle, start);
    if (found < 0) break;
    matches.push(found);
    start = found + Math.max(needle.length, 1);
  }
  return matches;
}

function rangeHtml(value: string, start: number, className: string | null, errorPosition: number | null, matches: number[], activeMatch: number, queryLength: number) {
  if (!value) return '';
  const end = start + value.length;
  const boundaries = new Set<number>([start, end]);
  if (errorPosition !== null && errorPosition >= start && errorPosition < end) boundaries.add(errorPosition + 1), boundaries.add(errorPosition);
  matches.forEach((match, index) => {
    const matchEnd = match + queryLength;
    if (match < end && matchEnd > start) {
      boundaries.add(Math.max(start, match));
      boundaries.add(Math.min(end, matchEnd));
    }
  });
  const points = [...boundaries].sort((a, b) => a - b);
  let html = '';
  for (let i = 0; i < points.length - 1; i++) {
    const segmentStart = points[i];
    const segmentEnd = points[i + 1];
    const segment = escapeHtml(value.slice(segmentStart - start, segmentEnd - start));
    const matchIndex = matches.findIndex(match => match <= segmentStart && match + queryLength > segmentStart);
    const error = errorPosition !== null && errorPosition >= segmentStart && errorPosition < segmentEnd;
    let content = segment;
    if (matchIndex >= 0) content = `<mark class="json-search-match${matchIndex === activeMatch ? ' json-search-active' : ''}">${content}</mark>`;
    if (error) content = `<mark class="json-editor-error" title="JSON parser error">${content}</mark>`;
    html += className ? `<span class="${className}">${content}</span>` : content;
  }
  return html;
}

function highlightJson(value: string, errorPosition: number | null, matches: number[], activeMatch: number, queryLength: number): string {
  let html = '';
  let index = 0;
  while (index < value.length) {
    const start = index;
    const character = value[index];
    if (/\s/.test(character)) {
      while (index < value.length && /\s/.test(value[index])) index++;
      html += rangeHtml(value.slice(start, index), start, null, errorPosition, matches, activeMatch, queryLength);
      continue;
    }
    if (character === '"') {
      index++;
      let escaped = false;
      while (index < value.length) {
        const next = value[index++];
        if (!escaped && next === '"') break;
        escaped = !escaped && next === '\\';
        if (next !== '\\') escaped = false;
      }
      let lookAhead = index;
      while (/\s/.test(value[lookAhead] || '')) lookAhead++;
      html += rangeHtml(value.slice(start, index), start, value[lookAhead] === ':' ? 'json-token-key' : 'json-token-string', errorPosition, matches, activeMatch, queryLength);
      continue;
    }
    const number = value.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (number) {
      index += number[0].length;
      html += rangeHtml(number[0], start, 'json-token-number', errorPosition, matches, activeMatch, queryLength);
      continue;
    }
    const keyword = value.slice(index).match(/^(?:true|false|null)\b/);
    if (keyword) {
      index += keyword[0].length;
      html += rangeHtml(keyword[0], start, 'json-token-literal', errorPosition, matches, activeMatch, queryLength);
      continue;
    }
    index++;
    html += rangeHtml(character, start, /[{}\[\],:]/.test(character) ? 'json-token-punctuation' : null, errorPosition, matches, activeMatch, queryLength);
  }
  if (errorPosition !== null && errorPosition >= value.length) html += '<mark class="json-editor-error json-editor-error-eof" title="JSON parser error">↵</mark>';
  return html || '<span class="json-editor-placeholder">Paste JSON here…</span>';
}

// Newer Chromium versions deliberately omit a byte position from some JSON.parse
// messages. This small grammar walk runs only after JSON.parse has already failed,
// so the editor can still point to the offending line without sending the JSON away.
function syntaxErrorPosition(value: string): number | null {
  let index = 0;
  const whitespace = () => { while (/\s/.test(value[index] || '')) index++; };
  const string = (): number | null => {
    if (value[index] !== '"') return index;
    index++;
    while (index < value.length) {
      const character = value[index++];
      if (character === '"') return null;
      if (character === '\\') {
        const escapeStart = index - 1;
        const escaped = value[index++];
        if (!escaped || !'"\\/bfnrtu'.includes(escaped)) return escapeStart;
        if (escaped === 'u') {
          for (let offset = 0; offset < 4; offset++) {
            if (!/[0-9a-f]/i.test(value[index + offset] || '')) return index + offset;
          }
          index += 4;
        }
      } else if (character < ' ') return index - 1;
    }
    return value.length;
  };
  const valueAt = (): number | null => {
    whitespace();
    const character = value[index];
    if (character === '{') {
      index++; whitespace();
      if (value[index] === '}') { index++; return null; }
      while (index < value.length) {
        const keyError = string();
        if (keyError !== null) return keyError;
        whitespace();
        if (value[index] !== ':') return index;
        index++;
        const childError = valueAt();
        if (childError !== null) return childError;
        whitespace();
        if (value[index] === '}') { index++; return null; }
        if (value[index] !== ',') return index;
        index++; whitespace();
      }
      return value.length;
    }
    if (character === '[') {
      index++; whitespace();
      if (value[index] === ']') { index++; return null; }
      while (index < value.length) {
        const childError = valueAt();
        if (childError !== null) return childError;
        whitespace();
        if (value[index] === ']') { index++; return null; }
        if (value[index] !== ',') return index;
        index++; whitespace();
      }
      return value.length;
    }
    if (character === '"') return string();
    const number = value.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (number) { index += number[0].length; return null; }
    for (const literal of ['true', 'false', 'null']) {
      if (value.slice(index, index + literal.length) === literal) { index += literal.length; return null; }
    }
    return index;
  };

  const error = valueAt();
  if (error !== null) return Math.max(0, Math.min(value.length, error));
  whitespace();
  return index < value.length ? index : null;
}

function positionFromLineColumn(value: string, line: number, column: number): number {
  const lines = value.split('\n');
  const safeLine = Math.max(1, Math.min(lines.length, line));
  const preceding = lines.slice(0, safeLine - 1).reduce((total, item) => total + item.length + 1, 0);
  return Math.max(0, Math.min(value.length, preceding + Math.max(0, column - 1)));
}

export function jsonErrorLocation(value: string, error: unknown): JsonErrorLocation {
  const message = error instanceof Error ? error.message : String(error);
  const positionMatch = message.match(/position\s+(\d+)/i);
  if (positionMatch) {
    const position = Math.max(0, Math.min(value.length, Number(positionMatch[1])));
    const before = value.slice(0, position);
    return { position, line: before.split('\n').length, column: position - before.lastIndexOf('\n') };
  }
  const lineColumnMatch = message.match(/line\s+(\d+).*?(?:column|col)\s+(\d+)/i);
  if (lineColumnMatch) {
    const line = Number(lineColumnMatch[1]);
    const column = Number(lineColumnMatch[2]);
    return { position: positionFromLineColumn(value, line, column), line, column };
  }
  const position = syntaxErrorPosition(value);
  if (position !== null) {
    const before = value.slice(0, position);
    return { position, line: before.split('\n').length, column: position - before.lastIndexOf('\n') };
  }
  return { position: null, line: null, column: null };
}

export function createJsonEditor(element: HTMLTextAreaElement): JsonEditor {
  const shell = element.closest<HTMLElement>('[data-json-editor]');
  const gutter = shell?.querySelector<HTMLElement>('[data-json-editor-gutter]');
  const code = shell?.querySelector<HTMLElement>('[data-json-editor-code]');
  if (!shell || !gutter || !code) throw new Error('JSON editor markup is incomplete.');

  let errorPosition: number | null = null;
  let query = '';
  let matches: number[] = [];
  let activeMatch = -1;
  let pendingRefresh = 0;
  const lifetime = new AbortController();
  let plain = false, lineCount = 1;

  function lineNumbers() {
    lineCount = Math.max(1, element.value.split('\n').length);
    if (!plain) gutter.textContent = Array.from({ length: lineCount }, (_, i) => String(i + 1)).join('\n');
  }
  function syncScroll() {
    if (plain) {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight) || 21;
      const first = Math.max(0, Math.floor((element.scrollTop - 12) / lineHeight));
      const count = Math.min(lineCount - first, Math.ceil(element.clientHeight / lineHeight) + 2);
      const span = document.createElement('span');
      span.style.display = 'block'; span.style.transform = `translateY(${first * lineHeight - element.scrollTop}px)`;
      span.textContent = Array.from({ length: Math.max(0, count) }, (_, i) => String(first + i + 1)).join('\n');
      gutter.replaceChildren(span); gutter.scrollTop = 0;
      return;
    }
    gutter.scrollTop = element.scrollTop;
    code.style.transform = `translate(${-element.scrollLeft}px, ${-element.scrollTop}px)`;
  }
  function refresh() {
    if (pendingRefresh) cancelAnimationFrame(pendingRefresh);
    pendingRefresh = 0;
    plain = element.value.length > 200_000 || element.value.split('\n').length > 5000 || element.value.length * matches.length > 5_000_000;
    shell.classList.toggle('json-editor-plain', plain);
    lineNumbers();
    if (plain) code.replaceChildren();
    else code.innerHTML = highlightJson(element.value, errorPosition, matches, activeMatch, query.length);
    syncScroll();
  }
  function focusPosition(position: number) {
    const bounded = Math.max(0, Math.min(element.value.length, position));
    element.focus();
    element.setSelectionRange(bounded, Math.min(element.value.length, bounded + 1));
    const linesBefore = element.value.slice(0, bounded).split('\n').length - 1;
    const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight) || 21;
    element.scrollTop = Math.max(0, linesBefore * lineHeight - element.clientHeight / 2);
    const column = bounded - element.value.lastIndexOf('\n', bounded - 1) - 1;
    const fontSize = Number.parseFloat(getComputedStyle(element).fontSize) || 13;
    element.scrollLeft = Math.max(0, column * fontSize * .6 - element.clientWidth / 2);
    syncScroll();
  }
  element.addEventListener('input', () => {
    errorPosition = null;
    matches = searchOccurrences(element.value, query);
    activeMatch = matches.length ? Math.min(activeMatch, matches.length - 1) : -1;
    // A large native insertion can emit many input events. Coalesce overlay
    // painting instead of rebuilding thousands of token spans for every event.
    if (!pendingRefresh) pendingRefresh = requestAnimationFrame(refresh);
  }, { signal: lifetime.signal });
  element.addEventListener('scroll', syncScroll, { signal: lifetime.signal });
  function insertLargeText(text: string) {
    // Native content-editing insertion can spend seconds laying out a large,
    // multiline paste before it even emits input. Replace the selected range
    // directly and paint the overlay only once, just as local file loading does.
    element.setRangeText(text, element.selectionStart, element.selectionEnd, 'end');
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }
  element.addEventListener('paste', event => {
    const text = event.clipboardData?.getData('text/plain');
    if (text && text.length > 50_000) { event.preventDefault(); insertLargeText(text); }
  }, { signal: lifetime.signal });
  element.addEventListener('beforeinput', event => {
    if (event.cancelable && event.data && event.data.length > 50_000 && event.inputType === 'insertText') {
      event.preventDefault(); insertLargeText(event.data);
    }
  }, { signal: lifetime.signal });
  element.addEventListener('keydown', event => {
    if (event.key === 'Tab') {
      event.preventDefault();
      const start = element.selectionStart;
      const end = element.selectionEnd;
      element.setRangeText('  ', start, end, 'end');
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, { signal: lifetime.signal });
  refresh();
  return {
    element,
    getValue: () => element.value,
    setValue(value) { element.value = value; errorPosition = null; matches = searchOccurrences(value, query); activeMatch = matches.length ? 0 : -1; refresh(); },
    refresh,
    setSearch(nextQuery, nextActive = 0) { query = nextQuery; matches = searchOccurrences(element.value, query); activeMatch = matches.length && nextActive >= 0 ? ((nextActive % matches.length) + matches.length) % matches.length : -1; refresh(); return matches.length; },
    getMatches: () => [...matches],
    focusMatch(index) { if (!matches.length) return; activeMatch = ((index % matches.length) + matches.length) % matches.length; refresh(); focusPosition(matches[activeMatch]); },
    showError(position) { errorPosition = position; refresh(); },
    clearError() { errorPosition = null; refresh(); },
    focusPosition,
    destroy() { lifetime.abort(); if (pendingRefresh) cancelAnimationFrame(pendingRefresh); },
  };
}
