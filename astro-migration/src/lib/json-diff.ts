import { formatJson, JsonFormatError, pointerChildPath } from './json-formatter.ts';

export interface DiffOptions { ignoreKeyOrder: boolean; ignoreArrayOrder: boolean; arrayKey?: string; ignoredPaths?: string; }
export interface JsonChange {
  type: 'added' | 'removed' | 'modified'; path: string;
  oldPointer?: string; newPointer?: string; oldRaw?: string; newRaw?: string;
  oldOffset?: number; newOffset?: number; oldNode?: number; newNode?: number;
}
export interface DiffResult {
  changes: JsonChange[]; leftHtml: string; rightHtml: string; previewLimited: boolean;
  report: string; patch: string | null; patchReason: string; ignored: number;
}
export class JsonDiffError extends Error {
  side: 'left' | 'right' | null; offset: number | null;
  constructor(message: string, side: 'left' | 'right' | null = null, offset: number | null = null) { super(message); this.side = side; this.offset = offset; }
}
export const DIFF_LIMITS = { changes: 5000, previewChars: 200_000, previewNodes: 10_000, exportChars: 32 * 1024 ** 2 };

// Compare mathematical decimal values, not rounded JavaScript numbers. Exponents
// stay symbolic; 1e400 never becomes Infinity, and 1.00 equals 100e-2.
export function exactNumber(raw: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw)!;
  let digits = (match[2] + (match[3] ?? '')).replace(/^0+/, '');
  if (!digits) return '0';
  const exponent = match[4] ?? '0';
  if (exponent.length > 1000) throw new JsonDiffError('A number exponent exceeds the 1,000-character comparison limit.');
  const trimmed = digits.replace(/0+$/, '');
  const power = BigInt(exponent) - BigInt((match[3] ?? '').length) + BigInt(digits.length - trimmed.length);
  digits = trimmed;
  return `${match[1]}${digits}e${power}`;
}

function parse(text: string, side: 'left' | 'right') {
  try {
    const nodes = formatJson(text, 'tree').nodes!;
    for (const node of nodes) if (node.type === 'object') {
      const seen = new Set<string>();
      for (const index of node.children!) {
        const child = nodes[index];
        if (seen.has(child.key!)) throw new JsonDiffError(`Duplicate key ${JSON.stringify(child.key).slice(0, 100)} is ambiguous. Remove duplicates before comparing; JSON Formatter can inspect them without dropping them.`, side, child.offset);
        seen.add(child.key!);
      }
    }
    return { text, nodes };
  } catch (error) {
    if (error instanceof JsonDiffError) throw error;
    throw new JsonDiffError(error instanceof Error ? error.message : 'Unable to read this document.', side, error instanceof JsonFormatError ? error.offset : null);
  }
}
const propertyPath = (path: string, key: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? (path ? `${path}.${key}` : key) : `${path}[${JSON.stringify(key)}]`;
export const escapeDiffHtml = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));

export function compareJson(leftText: string, rightText: string, settings: DiffOptions): DiffResult {
  const options = { ...settings, arrayKey: (settings.arrayKey ?? '').trim(), ignoredPaths: (settings.ignoredPaths ?? '').trim() };
  if (options.arrayKey.length > 200) throw new JsonDiffError('Choose an array identity field no longer than 200 characters.');
  // Pointer lines may contain literal commas in member names; only bare-name
  // lines support comma-separated shorthand.
  const rules = options.ignoredPaths ? options.ignoredPaths.split('\n').flatMap(line => line.trim().startsWith('/') ? [line.trim()] : line.split(',').map(s => s.trim())).filter(Boolean) : [];
  if (rules.length > 100 || rules.some(rule => rule.length > 1000)) throw new JsonDiffError('Use at most 100 ignored fields or pointers, each no longer than 1,000 characters.');
  if (rules.some(rule => rule.startsWith('/') && /~(?![01])/u.test(rule))) throw new JsonDiffError('Invalid JSON Pointer escape. Use ~0 for a tilde and ~1 for a slash.');
  const names = new Set(rules.filter(rule => !rule.startsWith('/'))), pointers = new Set(rules.filter(rule => rule.startsWith('/')));
  const docs = [parse(leftText, 'left'), parse(rightText, 'right')];
  const raw = (side: number, index: number) => { const node = docs[side].nodes[index]; return docs[side].text.slice(node.offset, node.offset + node.length); };
  let ignored = 0, pathBudget = 0, signatureBudget = 0;
  const skip = (pointer: string, key?: string, object = false) => pointers.has(pointer) || (object && names.has(key!));
  const intern = new Map<string, number>(), ids: number[][] = [[], []], identities: Map<number, string[]>[] = [new Map(), new Map()];
  function signature(side: number, index: number, pointer: string): number {
    pathBudget += pointer.length;
    if (pathBudget > 20 * 1024 ** 2 || pointer.length > 10_000) throw new JsonDiffError('This document needs too much comparison metadata. Split it into smaller documents.');
    const node = docs[side].nodes[index];
    let key: string;
    if (node.type === 'object') {
      const entries: [string, number][] = [];
      for (const child of node.children!) {
        const name = docs[side].nodes[child].key!, next = pointerChildPath(pointer, name);
        if (skip(next, name, true)) { ignored++; continue; }
        entries.push([name, signature(side, child, next)]);
      }
      if (options.ignoreKeyOrder) entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
      key = 'object:' + JSON.stringify(entries);
    } else if (node.type === 'array') {
      const children = node.children!, allObjects = children.length > 0 && children.every(child => docs[side].nodes[child].type === 'object');
      const childIds = children.map((child, i) => {
        const next = pointerChildPath(pointer, String(i));
        if (skip(next)) { ignored++; return 0; }
        return signature(side, child, next);
      });
      if (options.arrayKey && allObjects) {
        const seen = new Set<string>(), keys: string[] = [];
        for (const child of children) {
          const identity = docs[side].nodes[child].children!.find(i => docs[side].nodes[i].key === options.arrayKey);
          if (identity === undefined || !['string', 'number', 'boolean'].includes(docs[side].nodes[identity].type)) throw new JsonDiffError(`Array ${pointer || '(root)'} needs a string, number, or boolean ${JSON.stringify(options.arrayKey)} on every record.`, side === 0 ? 'left' : 'right', docs[side].nodes[child].offset);
          const idNode = docs[side].nodes[identity], value = raw(side, identity);
          const id = idNode.type + ':' + (idNode.type === 'number' ? exactNumber(value) : JSON.stringify(JSON.parse(value)));
          if (seen.has(id)) throw new JsonDiffError(`Array ${pointer || '(root)'} has duplicate ${JSON.stringify(options.arrayKey)} values. Choose a unique identity field.`, side === 0 ? 'left' : 'right', idNode.offset);
          seen.add(id); keys.push(id);
        }
        identities[side].set(index, keys);
        key = 'keyed:' + JSON.stringify(keys.map((id, i) => [id, childIds[i]]).sort((a, b) => String(a[0]) < String(b[0]) ? -1 : 1));
      } else {
        if (options.arrayKey && children.some(child => docs[side].nodes[child].type === 'object')) throw new JsonDiffError(`Array ${pointer || '(root)'} mixes records and other values. Match by field requires an array of objects.`, side === 0 ? 'left' : 'right', node.offset);
        const visible = childIds.filter(id => id !== 0);
        if (options.ignoreArrayOrder) visible.sort((a, b) => a - b);
        key = 'array:' + visible.join(',');
      }
    } else {
      const value = raw(side, index);
      try { key = node.type + ':' + (node.type === 'number' ? exactNumber(value) : node.type === 'string' ? JSON.stringify(JSON.parse(value)) : value); }
      catch (error) { throw new JsonDiffError(error instanceof Error ? error.message : 'Unable to compare this number.', side === 0 ? 'left' : 'right', node.offset); }
    }
    signatureBudget += key.length;
    if (signatureBudget > 60 * 1024 ** 2) throw new JsonDiffError('This document needs too much comparison metadata. Split it into smaller documents.');
    let id = intern.get(key);
    if (id === undefined) { id = intern.size + 1; intern.set(key, id); }
    ids[side][index] = id; return id;
  }
  signature(0, 0, ''); signature(1, 0, '');
  const changes: JsonChange[] = [];
  function add(type: JsonChange['type'], path: string, a?: number, b?: number, ap = '', bp = '') {
    if (changes.length >= DIFF_LIMITS.changes) throw new JsonDiffError('More than 5,000 differences. Compare a smaller section; no partial result has been reported as complete.');
    changes.push({ type, path: path || '(root)', ...(a === undefined ? {} : { oldNode: a, oldRaw: raw(0, a), oldOffset: docs[0].nodes[a].offset, oldPointer: ap }), ...(b === undefined ? {} : { newNode: b, newRaw: raw(1, b), newOffset: docs[1].nodes[b].offset, newPointer: bp }) });
  }
  function walk(a: number, b: number, path: string, ap: string, bp: string) {
    if (ids[0][a] === ids[1][b]) return;
    const an = docs[0].nodes[a], bn = docs[1].nodes[b];
    if (an.type !== bn.type || !an.children || !bn.children) { add('modified', path, a, b, ap, bp); return; }
    if (an.type === 'object') {
      const amap = new Map(an.children.filter(i => !skip(pointerChildPath(ap, docs[0].nodes[i].key!), docs[0].nodes[i].key, true)).map(i => [docs[0].nodes[i].key!, i]));
      const bmap = new Map(bn.children.filter(i => !skip(pointerChildPath(bp, docs[1].nodes[i].key!), docs[1].nodes[i].key, true)).map(i => [docs[1].nodes[i].key!, i]));
      const ak = [...amap.keys()], bk = [...bmap.keys()];
      if (!options.ignoreKeyOrder && ak.length === bk.length && ak.every(k => bmap.has(k)) && ak.some((k, i) => k !== bk[i])) { add('modified', path, a, b, ap, bp); return; }
      for (const [k, i] of amap) if (!bmap.has(k)) add('removed', propertyPath(path, k), i, undefined, pointerChildPath(ap, k));
      for (const [k, i] of bmap) if (!amap.has(k)) add('added', propertyPath(path, k), undefined, i, '', pointerChildPath(bp, k));
      for (const [k, i] of amap) if (bmap.has(k)) walk(i, bmap.get(k)!, propertyPath(path, k), pointerChildPath(ap, k), pointerChildPath(bp, k));
    } else {
      const aa = an.children, bb = bn.children, aKeys = identities[0].get(a), bKeys = identities[1].get(b);
      if (options.arrayKey && (aKeys || bKeys)) {
        if ((!aKeys && aa.length) || (!bKeys && bb.length)) throw new JsonDiffError(`Array ${ap || '(root)'} changes between records and non-record values. Clear the identity field to compare by position.`);
        const amap = new Map((aKeys ?? []).map((id, i) => [id, i])), bmap = new Map((bKeys ?? []).map((id, i) => [id, i]));
        for (const [id, i] of amap) {
          const j = bmap.get(id);
          if (j === undefined) { if (!skip(pointerChildPath(ap, String(i)))) add('removed', `${path}[${i}]`, aa[i], undefined, pointerChildPath(ap, String(i))); }
          else if (!skip(pointerChildPath(ap, String(i))) && !skip(pointerChildPath(bp, String(j)))) walk(aa[i], bb[j], `${path}[${j}]`, pointerChildPath(ap, String(i)), pointerChildPath(bp, String(j)));
        }
        for (const [id, j] of bmap) if (!amap.has(id) && !skip(pointerChildPath(bp, String(j)))) add('added', `${path}[${j}]`, undefined, bb[j], '', pointerChildPath(bp, String(j)));
      } else if (options.ignoreArrayOrder) {
        const buckets = new Map<number, number[]>();
        bb.forEach((child, i) => { if (skip(pointerChildPath(bp, String(i)))) return; const id = ids[1][child], bucket = buckets.get(id) ?? []; bucket.push(i); buckets.set(id, bucket); });
        aa.forEach((child, i) => {
          if (skip(pointerChildPath(ap, String(i)))) return;
          const bucket = buckets.get(ids[0][child]);
          if (bucket?.length) bucket.pop(); else add('removed', `${path}[${i}]`, child, undefined, pointerChildPath(ap, String(i)));
        });
        const remaining = [...buckets.values()].flat().sort((a, b) => a - b);
        for (const i of remaining) add('added', `${path}[${i}]`, undefined, bb[i], '', pointerChildPath(bp, String(i)));
      } else {
        for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
          const ai = pointerChildPath(ap, String(i)), bi = pointerChildPath(bp, String(i));
          if (!skip(ai) && !skip(bi)) walk(aa[i], bb[i], `${path}[${i}]`, ai, bi);
        }
        // Tail removals descend so the exported JSON Patch never shifts a later index.
        for (let i = aa.length - 1; i >= bb.length; i--) if (!skip(pointerChildPath(ap, String(i)))) add('removed', `${path}[${i}]`, aa[i], undefined, pointerChildPath(ap, String(i)));
        for (let i = aa.length; i < bb.length; i++) if (!skip(pointerChildPath(bp, String(i)))) add('added', `${path}[${i}]`, undefined, bb[i], '', pointerChildPath(bp, String(i)));
      }
    }
  }
  walk(0, 0, '', '', '');
  const exportOptions = { ignoreKeyOrder: options.ignoreKeyOrder, ignoreArrayOrder: options.ignoreArrayOrder, ...(options.arrayKey ? { arrayKey: options.arrayKey } : {}), ...(rules.length ? { ignoredPaths: options.ignoredPaths } : {}) };
  const entries = changes.map(c => {
    const metadata = JSON.stringify({ type: c.type, path: c.path, ...(c.oldPointer === undefined ? {} : { oldPointer: c.oldPointer }), ...(c.newPointer === undefined ? {} : { newPointer: c.newPointer }) });
    return metadata.slice(0, -1) + (c.oldRaw === undefined ? '' : `,"oldValue":${c.oldRaw}`) + (c.newRaw === undefined ? '' : `,"newValue":${c.newRaw}`) + '}';
  });
  const report = `{"format":"bugdays-json-diff-report/v1","comparedAt":${JSON.stringify(new Date().toISOString())},"options":${JSON.stringify(exportOptions)},"changes":[${entries.join(',\n')}]}`;
  const patchReason = !options.ignoreKeyOrder || options.ignoreArrayOrder || options.arrayKey || rules.length ? 'JSON Patch needs key order ignored, positional arrays, and no ignored fields. Switch to an exact structural comparison to export a patch.' : '';
  const patch = patchReason ? null : '[' + changes.map(c => {
    const op = c.type === 'added' ? 'add' : c.type === 'removed' ? 'remove' : 'replace';
    return `{"op":${JSON.stringify(op)},"path":${JSON.stringify(c.type === 'removed' ? c.oldPointer : c.newPointer)}${op === 'remove' ? '' : `,"value":${c.newRaw}`}}`;
  }).join(',\n') + ']';
  if (report.length > DIFF_LIMITS.exportChars || (patch?.length ?? 0) > DIFF_LIMITS.exportChars) throw new JsonDiffError('The complete report exceeds 32 MiB. Compare smaller sections.');
  let previewLimited = false;
  function preview(side: number) {
    const doc = docs[side];
    if (doc.text.length > DIFF_LIMITS.previewChars || doc.nodes.length > DIFF_LIMITS.previewNodes) { previewLimited = true; return '<p>Large document: use the changes below to jump to the complete input above. Find searches the full document.</p>'; }
    const marks = new Map<number, number>();
    changes.forEach((c, i) => { const index = side === 0 ? c.oldNode : c.newNode; if (index !== undefined) marks.set(index, i); });
    let length = 0;
    const mark = (html: string, index: number) => {
      const change = changes[index], colors = change.type === 'added' ? '#bbf7d0;color:#14532d;border:1px solid #22c55e' : change.type === 'removed' ? '#fecaca;color:#7f1d1d;border:1px solid #ef4444;text-decoration:line-through' : '#e9d5ff;color:#581c87;border:1px solid #a855f7';
      return `<mark data-change-index="${index}" title="${escapeDiffHtml(change.path)}" style="background:${colors};border-radius:2px">${html}</mark>`;
    };
    function render(index: number, depth: number, inherited = false): string {
      const node = doc.nodes[index], change = marks.get(index), highlight = !inherited && change !== undefined;
      let html: string;
      if (!node.children) html = escapeDiffHtml(raw(side, index));
      else if (!node.children.length) html = node.type === 'array' ? '[]' : '{}';
      else {
        const lines = node.children.map(child => {
          const key = node.type === 'array' ? '' : escapeDiffHtml(JSON.stringify(doc.nodes[child].key)) + ': ';
          length += key.length + depth * 2 + 4;
          if (length > 2_000_000) throw new JsonDiffError('Preview display limit.');
          return '  '.repeat(depth + 1) + key + render(child, depth + 1, inherited || highlight);
        });
        html = `${node.type === 'array' ? '[' : '{'}\n${lines.join(',\n')}\n${'  '.repeat(depth)}${node.type === 'array' ? ']' : '}'}`;
      }
      return highlight ? mark(html, change) : html;
    }
    try { return '<pre class="whitespace-pre-wrap break-words text-sm">' + render(0, 0) + '</pre>'; }
    catch { previewLimited = true; return '<p>Preview limited. Select a change to inspect the complete input above.</p>'; }
  }
  const leftHtml = preview(0), rightHtml = preview(1);
  // Node indexes are internal implementation details; raw values remain exact.
  return { changes, leftHtml, rightHtml, previewLimited, report, patch, patchReason, ignored };
}
