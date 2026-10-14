export const MAX_LIST_BYTES = 5 * 1024 * 1024;
export const MAX_LIST_ITEMS = 100_000;
export const listActions = ['intersection', 'diffAB', 'diffBA', 'union', 'symmetric', 'duplicatesA', 'duplicatesB'] as const;
export type ListAction = typeof listActions[number];
export type ListOptions = { ignoreCase: boolean; trim: boolean; order: 'input' | 'ascending' | 'descending'; dedupe?: boolean; ignoreBlank?: boolean; ignoreZeros?: boolean; extraSpaces?: boolean; unicodeNfc?: boolean };
export const defaultListOptions: ListOptions = { ignoreCase: false, trim: true, order: 'input', dedupe: true, ignoreBlank: true, ignoreZeros: false, extraSpaces: false, unicodeNfc: false };
export type ListSummary = { items: number; unique: number; repeats: number };
export type ListReport = { a: ListSummary; b: ListSummary; results: Record<ListAction, string[]> };

function* lines(text: string): Generator<string> {
  text = text.replace(/^\uFEFF/, '');
  if (!text) return;
  let start = 0;
  for (const match of text.matchAll(/\r\n|\n|\r/g)) { yield text.slice(start, match.index); start = match.index! + match[0].length; }
  if (start < text.length) yield text.slice(start);
}
export function validateListText(text: string, options: Pick<ListOptions, 'ignoreBlank'> = {}): number {
  if (new TextEncoder().encode(text).length > MAX_LIST_BYTES) throw new Error('Each list supports up to 5 MiB. Split the list into smaller files.');
  let items = 0;
  if (options.ignoreBlank !== false && !text.trim()) return 0;
  for (const line of lines(text)) {
    if ((options.ignoreBlank === false || line.trim()) && ++items > MAX_LIST_ITEMS) throw new Error('Each list supports up to 100,000 included items. Split the list into smaller parts.');
  }
  return items;
}
function indexList(text: string, options: ListOptions) {
  const items = validateListText(text, options);
  const values = new Map<string, { value: string; count: number }>();
  const rows: { key: string; value: string }[] = [];
  for (const line of items ? lines(text) : []) {
    if (options.ignoreBlank !== false && !line.trim()) continue;
    const value = options.trim ? line.trim() : line;
    let key = value;
    if (options.extraSpaces) key = key.replace(/(\S)\s+(?=\S)/gu, '$1 ');
    if (options.unicodeNfc) key = key.normalize('NFC');
    if (options.ignoreCase) key = key.toLowerCase();
    if (options.ignoreZeros && /^\d+$/.test(key)) key = key.replace(/^0+(?=\d)/, '');
    rows.push({ key, value });
    const existing = values.get(key);
    if (existing) existing.count++;
    else values.set(key, { value, count: 1 });
  }
  return { values, rows, summary: { items, unique: values.size, repeats: items - values.size } };
}

export function compareLists(aText: string, bText: string, options: ListOptions = defaultListOptions): ListReport {
  const a = indexList(aText, options), b = indexList(bText, options);
  const results: Record<ListAction, string[]> = { intersection: [], diffAB: [], diffBA: [], union: [], symmetric: [], duplicatesA: [], duplicatesB: [] };
  for (const [key, item] of a.values) {
    (b.values.has(key) ? results.intersection : results.diffAB).push(item.value);
    results.union.push(item.value);
    if (item.count > 1) results.duplicatesA.push(item.value);
  }
  for (const [key, item] of b.values) {
    if (!a.values.has(key)) { results.diffBA.push(item.value); results.union.push(item.value); }
    if (item.count > 1) results.duplicatesB.push(item.value);
  }
  if (options.dedupe === false) {
    results.intersection = a.rows.filter(row => b.values.has(row.key)).map(row => row.value);
    results.diffAB = a.rows.filter(row => !b.values.has(row.key)).map(row => row.value);
    results.diffBA = b.rows.filter(row => !a.values.has(row.key)).map(row => row.value);
    results.union = [...a.rows, ...b.rows].map(row => row.value);
  }
  results.symmetric = [...results.diffAB, ...results.diffBA];
  if (options.order !== 'input') {
    const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'variant' });
    for (const values of Object.values(results)) values.sort((a, b) => collator.compare(a, b) * (options.order === 'descending' ? -1 : 1));
  }
  return { a: a.summary, b: b.summary, results };
}

/** Preserve trailing empty entries without inventing a row from a terminal newline. */
export function listText(values: string[]): string { return values.join('\n') + (values.length && values.at(-1) === '' ? '\n' : ''); }

/** Import one selected column. Reject multiline cells rather than splitting an item silently. */
export function importListColumn(text: string, delimiter: ',' | '\t', column = 1, header = false): string {
  if (new TextEncoder().encode(text).length > MAX_LIST_BYTES) throw new Error('Each file supports up to 5 MiB.');
  if (!Number.isInteger(column) || column < 1 || column > 1000) throw new Error('Choose a CSV/TSV column between 1 and 1,000.');
  text = text.replace(/^\uFEFF/, '');
  if (!text) return '';
  const values: string[] = []; let cell = '', cells: string[] = [], quoted = false, closed = false, row = 0;
  const finishCell = () => { cells.push(cell); cell = ''; closed = false; };
  const finishRow = () => {
    finishCell(); row++;
    if (!(header && row === 1)) {
      if (cells.length < column && cells.some(value => value.trim())) throw new Error(`Row ${row} has no column ${column}. Choose an existing column.`);
      values.push(cells[column - 1] ?? '');
      if (values.length > MAX_LIST_ITEMS) throw new Error('A file supports up to 100,000 data rows.');
    }
    cells = [];
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
      else if (char === '\r' || char === '\n') throw new Error('Multiline CSV/TSV cells cannot be represented as one item per line. Extract a single-line column.');
      else cell += char;
    } else if (char === delimiter) finishCell();
    else if (char === '\r' || char === '\n') { finishRow(); if (char === '\r' && text[i + 1] === '\n') i++; }
    else if (char === '"' && cell === '' && !closed) quoted = true;
    else if (char === '"' || closed) throw new Error(`Invalid quoting in row ${row + 1}. Use a standard CSV or TSV file.`);
    else cell += char;
  }
  if (quoted) throw new Error('The CSV/TSV file ends inside a quoted cell.');
  if (!/[\r\n]$/.test(text)) finishRow();
  return listText(values);
}

/** Spreadsheet-safe CSV; exact text remains available through Copy / TXT. */
export function listCsv(values: string[]): string {
  const cell = (value: string) => '"' + (/^[\s]*[=+\-@\t\r]/.test(value) ? "'" + value : value).replaceAll('"', '""') + '"';
  return '\uFEFFItem\r\n' + values.map(cell).join('\r\n') + (values.length ? '\r\n' : '');
}
