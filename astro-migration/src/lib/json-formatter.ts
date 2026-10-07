import { createScanner, parseTree, printParseErrorCode, SyntaxKind, type Node, type ParseError } from 'jsonc-parser';

export type FormatterAction = 'prettify' | 'compact' | 'validate' | 'tree';
export type JsonIndent = '2' | '4' | 'tab';
export const JSON_LIMITS = { inputBytes: 10 * 1024 ** 2, outputBytes: 20 * 1024 ** 2, depth: 128, tokens: 600_000 };
export interface JsonTreeNode { type: string; offset: number; length: number; children?: number[]; key?: string; }
export interface JsonFinding { offset: number; message: string; }
export interface FormatterResult {
  text: string; values: number; depth: number; duplicates: number; largeNumbers: number;
  findings: JsonFinding[]; nodes?: JsonTreeNode[];
}
export class JsonFormatError extends Error {
  offset: number | null;
  constructor(message: string, offset: number | null = null) { super(message); this.offset = offset; }
}
const messages: Record<string, string> = {
  InvalidSymbol: 'Unexpected text. JSON uses double-quoted strings and lowercase true, false, and null.',
  InvalidNumberFormat: 'Invalid number. Check leading zeros, decimal digits, and the exponent.',
  PropertyNameExpected: 'Expected a double-quoted property name. Check for a trailing comma.',
  ValueExpected: 'Expected a JSON value. Check for a missing value or a trailing comma.',
  ColonExpected: 'Expected a colon after the property name.',
  CommaExpected: 'Expected a comma between items.',
  CloseBraceExpected: 'Expected a closing brace }.', CloseBracketExpected: 'Expected a closing bracket ].',
  EndOfFileExpected: 'Unexpected content after the document. For JSON Lines, use the JSONL Viewer.',
  InvalidCommentToken: 'Comments are not valid JSON. Remove the comment before formatting.',
  UnexpectedEndOfString: 'Unclosed string. Add the closing double quote.',
  InvalidEscapeCharacter: 'Invalid string escape. Escape quotes, backslashes, and line breaks.',
  InvalidUnicode: 'A Unicode escape needs four hexadecimal digits.',
  InvalidCharacter: 'Unexpected character in a string. Escape literal line breaks and control characters.',
};

// A bounded scanner pass prevents recursive-parser stack exhaustion before parseTree.
// Number values in the AST are never used: output always copies the original tokens.
export function formatJson(text: string, action: FormatterAction = 'prettify', indent: JsonIndent = '2'): FormatterResult {
  if (new TextEncoder().encode(text).length > JSON_LIMITS.inputBytes) throw new JsonFormatError('Choose a JSON document no larger than 10 MiB.');
  if (!text.trim()) throw new JsonFormatError('Paste a JSON document first.', 0);
  const scanner = createScanner(text, true);
  let nesting = 0, depth = 0, tokens = 0;
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    if (++tokens > JSON_LIMITS.tokens) throw new JsonFormatError('This document has too many tokens. Split it into smaller documents.');
    if (token === SyntaxKind.OpenBraceToken || token === SyntaxKind.OpenBracketToken) {
      depth = Math.max(depth, ++nesting);
      if (depth > JSON_LIMITS.depth) throw new JsonFormatError('This document exceeds the 128-level nesting limit.', scanner.getTokenOffset());
    } else if (token === SyntaxKind.CloseBraceToken || token === SyntaxKind.CloseBracketToken) nesting--;
  }
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
  if (errors.length || !root) {
    const error = errors[0];
    const name = error ? printParseErrorCode(error.error) : 'ValueExpected';
    throw new JsonFormatError(messages[name] ?? 'Invalid JSON syntax.', error?.offset ?? 0);
  }
  let values = 0, duplicates = 0, largeNumbers = 0;
  const findings: JsonFinding[] = [], nodes: JsonTreeNode[] = [];
  const queue: { node: Node; parent?: number; key?: string }[] = [{ node: root }];
  while (queue.length) {
    const { node, parent, key } = queue.pop()!;
    const index = nodes.length;
    const child: JsonTreeNode = { type: node.type, offset: node.offset, length: node.length };
    if (key !== undefined) child.key = key;
    if (node.type === 'object' || node.type === 'array') child.children = [];
    nodes.push(child);
    if (parent !== undefined) nodes[parent].children!.push(index);
    values++;
    if (node.type === 'number') {
      const raw = text.slice(node.offset, node.offset + node.length), number = Number(raw);
      if (!Number.isFinite(number) || (/^-?\d+$/.test(raw) && !Number.isSafeInteger(number))) {
        largeNumbers++;
        if (findings.length < 20) findings.push({ offset: node.offset, message: 'Large number kept exactly. Some downstream JavaScript parsers may round or overflow it.' });
      }
    }
    const children = node.children ?? [];
    if (node.type === 'object') {
      const seen = new Set<string>();
      for (const property of children) {
        const name = property.children![0].value as string;
        if (seen.has(name)) {
          duplicates++;
          if (findings.length < 20) findings.push({ offset: property.offset, message: `Duplicate key ${JSON.stringify(name).slice(0, 120)} kept. Other parsers may keep only its last value.` });
        }
        seen.add(name);
      }
      for (let i = children.length - 1; i >= 0; i--) queue.push({ node: children[i].children![1], parent: index, key: children[i].children![0].value });
    } else if (node.type === 'array') {
      for (let i = children.length - 1; i >= 0; i--) queue.push({ node: children[i], parent: index, key: String(i) });
    }
  }
  let output = text;
  if (action === 'prettify' || action === 'compact') {
    const parts: string[] = [], unit = indent === 'tab' ? '\t' : indent === '4' ? '    ' : '  ';
    let length = 0, level = 0, previous = SyntaxKind.Unknown;
    const append = (value: string) => {
      length += value.length;
      if (length > JSON_LIMITS.outputBytes) throw new JsonFormatError('Formatted output is too large. Use Compact or fewer indentation spaces.');
      parts.push(value);
    };
    scanner.setPosition(0);
    for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
      const raw = text.slice(scanner.getTokenOffset(), scanner.getTokenOffset() + scanner.getTokenLength());
      if (action === 'compact') append(raw);
      else {
        const closing = token === SyntaxKind.CloseBraceToken || token === SyntaxKind.CloseBracketToken;
        const opened = previous === SyntaxKind.OpenBraceToken || previous === SyntaxKind.OpenBracketToken;
        if (closing) { level--; if (!opened) append('\n' + unit.repeat(level)); }
        else if (opened) append('\n' + unit.repeat(level));
        append(raw);
        if (token === SyntaxKind.OpenBraceToken || token === SyntaxKind.OpenBracketToken) level++;
        else if (token === SyntaxKind.CommaToken) append('\n' + unit.repeat(level));
        else if (token === SyntaxKind.ColonToken) append(' ');
      }
      previous = token;
    }
    output = parts.join('');
    if (new TextEncoder().encode(output).length > JSON_LIMITS.outputBytes) throw new JsonFormatError('Formatted output exceeds 20 MiB. Use Compact instead.');
  }
  return { text: output, values, depth, duplicates, largeNumbers, findings, ...(action === 'tree' ? { nodes } : {}) };
}

export function jqChildPath(parent: string, key: string, array: boolean): string {
  return array ? `${parent}[${key}]` : /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `${parent === '.' ? '.' : parent + '.'}${key}` : `${parent}[${JSON.stringify(key)}]`;
}
export function pointerChildPath(parent: string, key: string): string {
  return `${parent}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
}
