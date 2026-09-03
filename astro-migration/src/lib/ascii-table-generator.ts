export type StructuredTableFormat = 'auto' | 'csv' | 'tsv' | 'json' | 'html';
export type AsciiTableStyle = 'rounded' | 'single' | 'ascii' | 'markdown' | 'postgres';
export type CellOverflow = 'wrap' | 'truncate';

export interface ParsedStructuredTable {
  rows: string[][];
  format: Exclude<StructuredTableFormat, 'auto'>;
  formatLabel: string;
}

export interface AsciiTableOptions {
  style: AsciiTableStyle;
  headerRow: boolean;
  padding: number;
  maxColumnWidth: number;
  overflow: CellOverflow;
  alignNumbers: boolean;
}

const MAX_INPUT_CHARACTERS = 5 * 1024 * 1024;
const MAX_ROWS = 20_000;
const MAX_COLUMNS = 250;

function stringifyCell(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function normalizeRows(rows: string[][]): string[][] {
  if (!rows.length) throw new Error('No rows found in that input.');
  if (rows.length > MAX_ROWS) throw new Error(`The table has more than ${MAX_ROWS.toLocaleString()} rows.`);
  const columns = Math.max(...rows.map(row => row.length));
  if (!columns) throw new Error('No columns found in that input.');
  if (columns > MAX_COLUMNS) throw new Error(`The table has more than ${MAX_COLUMNS} columns.`);
  return rows.map(row => Array.from({ length: columns }, (_, index) => (row[index] || '').trim()));
}

function parseDelimited(input: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (character === '"') {
      if (quoted && input[index + 1] === '"') {
        value += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      row.push(value);
      value = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && input[index + 1] === '\n') index++;
      row.push(value);
      if (row.some(cell => cell.trim())) rows.push(row);
      row = [];
      value = '';
    } else {
      value += character;
    }
  }

  if (quoted) throw new Error('A quoted field is not closed. Check the CSV or TSV input.');
  row.push(value);
  if (row.some(cell => cell.trim())) rows.push(row);
  return normalizeRows(rows);
}

function parseJson(input: string): string[][] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid JSON.';
    throw new Error(`Could not parse JSON: ${message}`);
  }
  if (!Array.isArray(parsed)) throw new Error('JSON input must be an array of objects, arrays, or values.');
  if (!parsed.length) throw new Error('The JSON array is empty.');

  if (parsed.every(item => Array.isArray(item))) {
    return normalizeRows((parsed as unknown[][]).map(row => row.map(stringifyCell)));
  }

  if (parsed.every(item => item !== null && typeof item === 'object' && !Array.isArray(item))) {
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const item of parsed as Record<string, unknown>[]) {
      for (const key of Object.keys(item)) {
        if (!seen.has(key)) {
          seen.add(key);
          keys.push(key);
        }
      }
    }
    return normalizeRows([
      keys,
      ...(parsed as Record<string, unknown>[]).map(item => keys.map(key => stringifyCell(item[key]))),
    ]);
  }

  return normalizeRows([['Value'], ...parsed.map(value => [stringifyCell(value)])]);
}

function parseHtml(input: string): string[][] {
  if (typeof DOMParser === 'undefined') throw new Error('HTML table parsing requires a browser.');
  const document = new DOMParser().parseFromString(input, 'text/html');
  const table = document.querySelector('table');
  if (!table) throw new Error('No HTML <table> element was found.');
  const rows = Array.from(table.rows).map(row =>
    Array.from(row.cells).map(cell => (cell.textContent || '').replace(/\u00a0/g, ' ').trim()),
  );
  return normalizeRows(rows);
}

function guessDelimitedFormat(input: string): 'csv' | 'tsv' {
  const lines = input.split(/\r?\n/).filter(line => line.trim()).slice(0, 8);
  if (lines.length && lines.filter(line => line.includes('\t')).length >= Math.min(2, lines.length)) return 'tsv';
  return 'csv';
}

export function parseStructuredTable(input: string, requestedFormat: StructuredTableFormat = 'auto'): ParsedStructuredTable {
  if (input.length > MAX_INPUT_CHARACTERS) throw new Error('That input is larger than 5 MB.');
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Paste CSV, TSV, JSON, or an HTML table first.');

  let format: Exclude<StructuredTableFormat, 'auto'>;
  if (requestedFormat !== 'auto') {
    format = requestedFormat;
  } else if (/^(?:<!doctype\s+html[^>]*>\s*)?(?:<html[\s>][\s\S]*?)?<table[\s>]/i.test(trimmed) || /<table[\s>]/i.test(trimmed)) {
    format = 'html';
  } else if (trimmed.startsWith('[')) {
    try {
      if (Array.isArray(JSON.parse(trimmed))) format = 'json';
      else format = guessDelimitedFormat(trimmed);
    } catch {
      format = guessDelimitedFormat(trimmed);
    }
  } else {
    format = guessDelimitedFormat(trimmed);
  }

  const rows = format === 'json'
    ? parseJson(trimmed)
    : format === 'html'
      ? parseHtml(trimmed)
      : parseDelimited(input, format === 'tsv' ? '\t' : ',');

  return {
    rows,
    format,
    formatLabel: format === 'csv' ? 'CSV' : format === 'tsv' ? 'TSV' : format === 'json' ? 'JSON array' : 'HTML table',
  };
}

function characters(value: string): string[] {
  return Array.from(value);
}

function fitCell(value: string, width: number, overflow: CellOverflow): string[] {
  const logicalLines = value.replace(/\r\n?/g, '\n').split('\n');
  const output: string[] = [];
  for (const line of logicalLines) {
    const points = characters(line);
    if (points.length <= width) {
      output.push(line);
    } else if (overflow === 'truncate') {
      output.push(width <= 1 ? '…' : points.slice(0, width - 1).join('') + '…');
    } else {
      for (let start = 0; start < points.length; start += width) output.push(points.slice(start, start + width).join(''));
    }
  }
  return output.length ? output : [''];
}

function isNumeric(value: string): boolean {
  const trimmed = value.trim().replace(/,/g, '');
  return trimmed !== '' && /^[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[-+]?\d+)?%?$/i.test(trimmed);
}

function align(value: string, width: number, right: boolean): string {
  const missing = Math.max(0, width - characters(value).length);
  return right ? ' '.repeat(missing) + value : value + ' '.repeat(missing);
}

interface BorderStyle {
  vertical: string;
  left: string;
  middle: string;
  right: string;
  topLeft: string;
  topJoin: string;
  topRight: string;
  headerLeft: string;
  headerJoin: string;
  headerRight: string;
  bottomLeft: string;
  bottomJoin: string;
  bottomRight: string;
  horizontal: string;
}

const BORDER_STYLES: Record<'rounded' | 'single' | 'ascii', BorderStyle> = {
  rounded: { vertical: '│', left: '│', middle: '│', right: '│', topLeft: '╭', topJoin: '┬', topRight: '╮', headerLeft: '├', headerJoin: '┼', headerRight: '┤', bottomLeft: '╰', bottomJoin: '┴', bottomRight: '╯', horizontal: '─' },
  single: { vertical: '│', left: '│', middle: '│', right: '│', topLeft: '┌', topJoin: '┬', topRight: '┐', headerLeft: '├', headerJoin: '┼', headerRight: '┤', bottomLeft: '└', bottomJoin: '┴', bottomRight: '┘', horizontal: '─' },
  ascii: { vertical: '|', left: '|', middle: '|', right: '|', topLeft: '+', topJoin: '+', topRight: '+', headerLeft: '+', headerJoin: '+', headerRight: '+', bottomLeft: '+', bottomJoin: '+', bottomRight: '+', horizontal: '-' },
};

function border(widths: number[], padding: number, style: BorderStyle, position: 'top' | 'header' | 'bottom'): string {
  const names = position === 'top'
    ? [style.topLeft, style.topJoin, style.topRight]
    : position === 'header'
      ? [style.headerLeft, style.headerJoin, style.headerRight]
      : [style.bottomLeft, style.bottomJoin, style.bottomRight];
  return names[0] + widths.map(width => style.horizontal.repeat(width + padding * 2)).join(names[1]) + names[2];
}

export function renderAsciiTable(rows: string[][], options: AsciiTableOptions): string {
  const normalized = normalizeRows(rows);
  const padding = Math.max(0, Math.min(3, Math.round(options.padding)));
  const maxColumnWidth = Math.max(3, Math.min(120, Math.round(options.maxColumnWidth)));
  const columnCount = normalized[0].length;
  const widths = Array.from({ length: columnCount }, (_, columnIndex) => {
    const natural = Math.max(...normalized.flatMap(row => row[columnIndex].split(/\r?\n/).map(line => characters(line).length)));
    return Math.max(1, Math.min(maxColumnWidth, natural));
  });
  const numericColumns = Array.from({ length: columnCount }, (_, columnIndex) => {
    const values = normalized.slice(options.headerRow ? 1 : 0).map(row => row[columnIndex]).filter(value => value.trim());
    return options.alignNumbers && values.length > 0 && values.every(isNumeric);
  });

  const renderRow = (row: string[], style: BorderStyle | null, markdown = false): string[] => {
    const fitted = row.map((value, index) => fitCell(value, widths[index], options.overflow));
    const height = Math.max(...fitted.map(lines => lines.length));
    return Array.from({ length: height }, (_, lineIndex) => {
      const cells = fitted.map((lines, columnIndex) => {
        const value = lines[lineIndex] || '';
        return ' '.repeat(padding) + align(value, widths[columnIndex], numericColumns[columnIndex]) + ' '.repeat(padding);
      });
      if (markdown) return `|${cells.join('|')}|`;
      if (!style) return cells.join(' | ');
      return style.left + cells.join(style.middle) + style.right;
    });
  };

  if (options.style === 'markdown') {
    const output: string[] = [];
    normalized.forEach((row, rowIndex) => {
      output.push(...renderRow(row, null, true));
      if (options.headerRow && rowIndex === 0) {
        output.push('|' + widths.map((width, index) => {
          const minimum = Math.max(3, width + padding * 2);
          return numericColumns[index] ? '-'.repeat(minimum - 1) + ':' : '-'.repeat(minimum);
        }).join('|') + '|');
      }
    });
    return output.join('\n');
  }

  if (options.style === 'postgres') {
    const output: string[] = [];
    normalized.forEach((row, rowIndex) => {
      output.push(...renderRow(row, null));
      if (options.headerRow && rowIndex === 0) {
        output.push(widths.map(width => '-'.repeat(width + padding * 2)).join('-+-'));
      }
    });
    return output.join('\n');
  }

  const style = BORDER_STYLES[options.style];
  const output = [border(widths, padding, style, 'top')];
  normalized.forEach((row, rowIndex) => {
    output.push(...renderRow(row, style));
    if (options.headerRow && rowIndex === 0) output.push(border(widths, padding, style, 'header'));
  });
  output.push(border(widths, padding, style, 'bottom'));
  return output.join('\n');
}
