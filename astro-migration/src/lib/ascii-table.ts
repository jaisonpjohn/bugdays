export type TerminalTableFormat = 'bordered' | 'pipe' | 'aligned' | 'whitespace';

export interface ParsedTerminalTable {
  rows: string[][];
  format: TerminalTableFormat;
  formatLabel: string;
  headerSeparatorDetected: boolean;
  skippedLineCount: number;
  warnings: string[];
}

const MAX_INPUT_CHARACTERS = 5 * 1024 * 1024;
const MAX_ROWS = 20_000;
const MAX_COLUMNS = 250;
const VERTICALS = new Set(['|', '¦', '│', '┃', '╎', '╏', '║']);
const HORIZONTAL_RUN = /[-=_—─━═]{2,}/g;
const RULE_CHARACTERS = new Set(
  Array.from('|+¦-=:_—─━│┃┌┐└┘├┤┬┴┼┏┓┗┛┣┫┳┻╋╭╮╯╰╔╗╚╝╠╣╦╩╬║═'),
);

interface Candidate {
  rows: string[][];
  format: TerminalTableFormat;
  formatLabel: string;
  headerSeparatorDetected: boolean;
  sourceLineCount: number;
  score: number;
  ragged: boolean;
}

function stripTerminalControlSequences(value: string): string {
  return value
    // OSC sequences, including terminal hyperlinks.
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    // CSI color/cursor sequences.
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '');
}

function isRuleLine(line: string): boolean {
  const compact = line.replace(/\s/g, '');
  if (compact.length < 3) return false;
  let hasHorizontal = false;
  for (const character of compact) {
    if (!RULE_CHARACTERS.has(character)) return false;
    if ('-=_—─━═'.includes(character)) hasHorizontal = true;
  }
  return hasHorizontal;
}

function delimiterFor(line: string): string | null {
  const counts = new Map<string, number>();
  for (const character of line) {
    if (VERTICALS.has(character)) counts.set(character, (counts.get(character) || 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [character, count] of counts) {
    if (count > bestCount) {
      best = character;
      bestCount = count;
    }
  }
  return best;
}

function splitDelimitedLine(line: string): string[] | null {
  const delimiter = delimiterFor(line);
  if (!delimiter) return null;

  const trimmed = line.trim();
  const hasLeadingBorder = trimmed.startsWith(delimiter);
  const hasTrailingBorder = trimmed.endsWith(delimiter);
  const pieces = trimmed.split(delimiter);
  if (hasLeadingBorder) pieces.shift();
  if (hasTrailingBorder) pieces.pop();
  if (pieces.length === 0 || pieces.length > MAX_COLUMNS) return null;
  return pieces.map(piece => piece.trim());
}

function looksLikeRowFooter(line: string): boolean {
  const value = line.trim();
  return /^\(\d+\s+rows?\)$/i.test(value)
    || /^\d+\s+rows?\s+(?:in set|selected|returned)/i.test(value)
    || /^time:\s+\d/i.test(value);
}

function normalizeRows(rows: string[][]): { rows: string[][]; ragged: boolean } {
  const columnCount = Math.max(...rows.map(row => row.length));
  const ragged = rows.some(row => row.length !== columnCount);
  return {
    rows: rows.map(row => Array.from({ length: columnCount }, (_, index) => row[index] || '')),
    ragged,
  };
}

function delimitedCandidates(lines: string[]): Candidate[] {
  const groups: Array<{ start: number; lines: string[] }> = [];
  let current: { start: number; lines: string[] } | null = null;

  lines.forEach((line, index) => {
    const qualifies = isRuleLine(line) || splitDelimitedLine(line) !== null;
    if (qualifies) {
      if (!current) current = { start: index, lines: [] };
      current.lines.push(line);
    } else if (current) {
      groups.push(current);
      current = null;
    }
  });
  if (current) groups.push(current);

  return groups.flatMap(group => {
    const rows: string[][] = [];
    const separatorPositions: number[] = [];
    let hasBoxCharacters = false;

    for (const line of group.lines) {
      if (isRuleLine(line)) {
        separatorPositions.push(rows.length);
        if (/[^\p{ASCII}]/u.test(line)) hasBoxCharacters = true;
        continue;
      }
      const row = splitDelimitedLine(line);
      if (row) rows.push(row);
    }

    if (rows.length === 0) return [];
    const normalized = normalizeRows(rows);
    const columnCount = normalized.rows[0]?.length || 0;
    if (columnCount === 0) return [];
    const headerSeparatorDetected = rows.length > 1 && separatorPositions.includes(1);
    const hasBorder = separatorPositions.length > 0;
    const consistency = rows.filter(row => row.length === columnCount).length;

    return [{
      rows: normalized.rows,
      format: hasBorder ? 'bordered' : 'pipe',
      formatLabel: hasBoxCharacters
        ? 'Unicode box-drawing table'
        : hasBorder
          ? 'ASCII bordered table'
          : 'Pipe-delimited table',
      headerSeparatorDetected,
      sourceLineCount: group.lines.length,
      score: rows.length * 20 + columnCount * 4 + separatorPositions.length * 5 + consistency * 2,
      ragged: normalized.ragged,
    }];
  });
}

function horizontalRuns(line: string): Array<{ start: number; end: number }> {
  const runs: Array<{ start: number; end: number }> = [];
  for (const match of line.matchAll(HORIZONTAL_RUN)) {
    const start = match.index || 0;
    runs.push({ start, end: start + match[0].length });
  }
  return runs;
}

function sliceAtColumns(line: string, starts: number[]): string[] {
  return starts.map((start, index) => {
    const end = starts[index + 1];
    return line.slice(start, end).trim();
  });
}

function alignedCandidates(lines: string[]): Candidate[] {
  const candidates: Candidate[] = [];

  lines.forEach((line, separatorIndex) => {
    if (!isRuleLine(line)) return;
    // A fixed-width underline contains only horizontal runs and whitespace.
    // Junctions such as +, ┬, and ┼ belong to bordered-table dialects.
    if (line.replace(HORIZONTAL_RUN, '').trim()) return;
    const runs = horizontalRuns(line);
    if (runs.length < 2 || separatorIndex === 0) return;
    const starts = runs.map(run => run.start);
    const headerLine = lines[separatorIndex - 1];
    if (!headerLine.trim() || isRuleLine(headerLine)) return;

    const rows = [sliceAtColumns(headerLine, starts)];
    let sourceLineCount = 2;
    for (let index = separatorIndex + 1; index < lines.length; index++) {
      const candidateLine = lines[index];
      if (!candidateLine.trim() || looksLikeRowFooter(candidateLine)) break;
      if (isRuleLine(candidateLine)) {
        sourceLineCount++;
        continue;
      }
      const row = sliceAtColumns(candidateLine, starts);
      const nonEmptyCells = row.filter(Boolean).length;
      if (nonEmptyCells === 0) break;
      if (nonEmptyCells === 1 && rows.length > 1 && !candidateLine.slice(starts[1]).trim()) break;
      rows.push(row);
      sourceLineCount++;
      if (rows.length >= MAX_ROWS) break;
    }

    if (rows.length < 2) return;
    candidates.push({
      rows,
      format: 'aligned',
      formatLabel: 'Fixed-width table with underline',
      headerSeparatorDetected: true,
      sourceLineCount,
      score: rows.length * 18 + starts.length * 5 + 12,
      ragged: false,
    });
  });

  return candidates;
}

function splitWhitespaceLine(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed || isRuleLine(trimmed) || looksLikeRowFooter(trimmed)) return null;
  const pieces = trimmed.split(/\t+| {2,}/).map(piece => piece.trim());
  if (pieces.length < 2 || pieces.length > MAX_COLUMNS) return null;
  return pieces;
}

function whitespaceCandidates(lines: string[]): Candidate[] {
  const groups: string[][][] = [];
  let current: string[][] = [];

  for (const line of lines) {
    const row = splitWhitespaceLine(line);
    if (row) {
      current.push(row);
    } else if (current.length) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length) groups.push(current);

  return groups
    .filter(rows => rows.length >= 2)
    .map(rows => {
      const frequencies = new Map<number, number>();
      rows.forEach(row => frequencies.set(row.length, (frequencies.get(row.length) || 0) + 1));
      const expectedColumns = [...frequencies.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
      const compatible = rows.filter(row => Math.abs(row.length - expectedColumns) <= 1);
      const normalized = normalizeRows(compatible);
      return {
        rows: normalized.rows,
        format: 'whitespace' as const,
        formatLabel: 'Columns separated by spaces or tabs',
        headerSeparatorDetected: false,
        sourceLineCount: rows.length,
        score: compatible.length * 12 + expectedColumns * 3 + frequencies.get(expectedColumns)! * 4,
        ragged: normalized.ragged,
      };
    });
}

export function parseTerminalTable(input: string): ParsedTerminalTable {
  if (input.length > MAX_INPUT_CHARACTERS) {
    throw new Error('That input is larger than 5 MB. Trim the terminal output and try again.');
  }

  const cleaned = stripTerminalControlSequences(input);
  const lines = cleaned.split('\n').map(line => line.replace(/\s+$/, ''));
  const nonEmptyLineCount = lines.filter(line => line.trim()).length;
  const candidates = [
    ...delimitedCandidates(lines),
    ...alignedCandidates(lines),
    ...whitespaceCandidates(lines),
  ].filter(candidate => candidate.rows.length <= MAX_ROWS);

  const best = candidates.sort((a, b) => b.score - a.score || b.sourceLineCount - a.sourceLineCount)[0];
  if (!best) {
    throw new Error('No table found. Paste rows that use pipes, box-drawing borders, tabs, or two or more spaces between columns.');
  }

  const columnCount = best.rows[0]?.length || 0;
  if (columnCount > MAX_COLUMNS) {
    throw new Error(`The detected table has more than ${MAX_COLUMNS} columns. Trim the input and try again.`);
  }

  const warnings: string[] = [];
  if (best.ragged) warnings.push('Some short rows were padded with empty cells.');
  if (best.rows.length === MAX_ROWS) warnings.push(`Only the first ${MAX_ROWS.toLocaleString()} rows were included.`);

  return {
    rows: best.rows,
    format: best.format,
    formatLabel: best.formatLabel,
    headerSeparatorDetected: best.headerSeparatorDetected,
    skippedLineCount: Math.max(0, nonEmptyLineCount - best.sourceLineCount),
    warnings,
  };
}
