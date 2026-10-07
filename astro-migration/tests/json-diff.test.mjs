import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareJson, exactNumber, JsonDiffError, DIFF_LIMITS } from '../src/lib/json-diff.ts';
import { formatJson } from '../src/lib/json-formatter.ts';
const defaults = { ignoreKeyOrder: true, ignoreArrayOrder: false };
const diff = (a, b, options = {}) => compareJson(a, b, { ...defaults, ...options });
const objects = (a, b, options = {}) => diff(JSON.stringify(a), JSON.stringify(b), options);
for (const [a, b] of [['1', '1.00'], ['100', '1e2'], ['-0', '0'], ['0.00100', '1e-3'], ['-123000', '-1.23e5'], ['1e400', '10e399']]) {
  test(`exact numeric equivalence ${a} / ${b}`, () => { assert.equal(exactNumber(a), exactNumber(b)); assert.equal(diff(a, b).changes.length, 0); });
}
for (const [a, b] of [['9007199254740993', '9007199254740992'], ['1.0000000000000001', '1'], ['1e400', '2e400'], ['1e-400', '0'], ['-1e999', '1e999']]) {
  test(`exact numeric difference ${a} / ${b}`, () => { const r = diff(a, b); assert.equal(r.changes.length, 1); assert.equal(r.changes[0].oldRaw, a); assert.ok(r.patch.includes(b)); assert.ok(r.report.includes(a)); });
}
test('escaped strings are equivalent but types, null, missing, and containers differ', () => {
  assert.equal(diff('"a"', '"\\u0061"').changes.length, 0);
  for (const [a, b] of [['1', '"1"'], ['null', '[]'], ['{}', '[]'], ['{}', '{"x":null}']]) assert.equal(diff(a, b).changes.length, 1);
});
test('duplicate keys are rejected before comparison, even when ignored or equal', () => {
  for (const side of ['left', 'right']) {
    const duplicate = '{"a":1,"\\u0061":2}';
    assert.throws(() => diff(side === 'left' ? duplicate : '{}', side === 'right' ? duplicate : '{}', { ignoredPaths: 'a' }), error => error instanceof JsonDiffError && error.side === side && error.offset > 0 && /Duplicate/.test(error.message));
  }
});
test('syntax locations include leading whitespace and the correct input side', () => {
  assert.throws(() => diff('{}', ' \n{\n"x":\n}'), error => error.side === 'right' && error.offset === 9);
  for (const text of ['{}{}', '[1,]', 'NaN', '{/*x*/"x":1}', '01']) assert.throws(() => diff(text, '{}'), JsonDiffError);
});
test('object order is optional and no numeric-looking property reordering occurs', () => {
  assert.equal(diff('{"2":2,"1":1}', '{"1":1,"2":2}').changes.length, 0);
  assert.equal(diff('{"2":2,"1":1}', '{"1":1,"2":2}', { ignoreKeyOrder: false }).changes.length, 1);
});
test('unordered comparison preserves multiplicities and recursively applies settings', () => {
  const r = objects([1, 1, 2], [1, 2, 2], { ignoreArrayOrder: true });
  assert.deepEqual(r.changes.map(c => c.type).sort(), ['added', 'removed']);
  assert.equal(objects([{ a: 1, b: [1, 2] }], [{ b: [2, 1], a: 1 }], { ignoreArrayOrder: true }).changes.length, 0);
  assert.equal(objects([{ a: 1, b: [1, 2] }], [{ b: [2, 1], a: 1 }], { ignoreArrayOrder: true, ignoreKeyOrder: false }).changes.length, 2);
});
test('keyed arrays pair records and keep separate source and destination pointers', () => {
  const r = objects([{ id: 'a', value: 1 }, { id: 'b', value: 2 }], [{ id: 'b', value: 2 }, { id: 'a', value: 3 }], { arrayKey: 'id' });
  assert.equal(r.changes.length, 1); assert.equal(r.changes[0].oldPointer, '/0/value'); assert.equal(r.changes[0].newPointer, '/1/value');
  assert.equal(r.changes[0].path, '[1].value'); assert.equal(r.patch, null);
  assert.match(r.leftHtml, /data-change-index="0"[^>]*>1<\/mark>/); assert.match(r.rightHtml, /data-change-index="0"[^>]*>3<\/mark>/);
});
test('keyed matching handles insertions, removals, empty arrays, exact numeric IDs, and primitive arrays', () => {
  assert.equal(objects([], [{ id: 1 }], { arrayKey: 'id' }).changes[0].type, 'added');
  assert.equal(objects([{ id: 1 }], [], { arrayKey: 'id' }).changes[0].type, 'removed');
  assert.equal(diff('[{"id":9007199254740993},{"id":9007199254740992}]', '[{"id":9007199254740992},{"id":9007199254740993}]', { arrayKey: 'id' }).changes.length, 0);
  assert.equal(objects([1, 2], [2, 1], { arrayKey: 'id' }).changes.length, 2);
});
test('ambiguous, missing, mixed, and duplicate identities fail clearly, including identical inputs', () => {
  for (const value of [[{ id: 1 }, { id: 1 }], [{ id: 1 }, {}], [{ id: null }], [{ id: 1 }, 2]]) assert.throws(() => objects(value, value, { arrayKey: 'id' }), JsonDiffError);
  assert.throws(() => objects([{ id: 1 }], [1], { arrayKey: 'id' }), /non-record/);
  assert.throws(() => diff('[{"id":1},{"id":1.0}]', '[]', { arrayKey: 'id' }), /duplicate/);
});
test('ignored field names apply recursively while pointers target exact source locations', () => {
  const a = { updatedAt: 1, meta: { requestId: 'a', stable: 1 }, items: [{ id: 1, updatedAt: 2 }] };
  const b = { updatedAt: 3, meta: { requestId: 'b', stable: 2 }, items: [{ id: 1, updatedAt: 4 }] };
  const r = objects(a, b, { ignoredPaths: 'updatedAt\n/meta/requestId' });
  assert.deepEqual(r.changes.map(c => c.path), ['meta.stable']); assert.equal(r.ignored, 6); assert.equal(r.patch, null);
  assert.equal(objects({ x: 1 }, {}, { ignoredPaths: 'x' }).changes.length, 0);
  assert.equal(objects({ 'a/b': { '~': 1 } }, { 'a/b': { '~': 2 } }, { ignoredPaths: '/a~1b/~0' }).changes.length, 0);
  assert.equal(objects({ 'a,b': 1 }, { 'a,b': 2 }, { ignoredPaths: '/a,b' }).changes.length, 0);
  assert.throws(() => objects({}, {}, { ignoredPaths: '/a~b' }), /Pointer escape/);
  assert.throws(() => objects({}, {}, { ignoredPaths: Array(101).fill('x').join(',') }), /100 ignored/);
});
test('HTML-like keys, prototype properties, and values never become executable markup', () => {
  const r = diff('{"__proto__":{"x":1},"a.b":1,"a":{"b":2},"<img>":"<script>"}', '{"__proto__":{"x":2},"a.b":3,"a":{"b":4},"<img>":"<img onerror=x>"}');
  assert.equal({}.x, undefined); assert.ok(r.changes.some(c => c.path === '["a.b"]')); assert.ok(r.changes.some(c => c.path === 'a.b'));
  assert.ok(!r.leftHtml.includes('<script>')); assert.ok(!r.rightHtml.includes('<img'));
});
// An independent sequential patch applicator, used only on safe, synthetic test fixtures.
function applyPatch(document, patch) {
  let target = structuredClone(document);
  for (const change of patch) {
    const tokens = change.path.slice(1).split('/').map(t => t.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (!change.path) { target = change.value; continue; }
    const key = tokens.pop(), parent = tokens.reduce((value, k) => value[k], target);
    if (Array.isArray(parent)) {
      if (change.op === 'remove') parent.splice(Number(key), 1);
      else if (change.op === 'add') parent.splice(Number(key), 0, change.value);
      else parent[Number(key)] = change.value;
    } else if (change.op === 'remove') delete parent[key];
    else Object.defineProperty(parent, key, { value: change.value, enumerable: true, configurable: true, writable: true });
  }
  return target;
}
test('patches round-trip roots, escaped paths, shrinking and growing arrays, and nested edits', () => {
  const cases = [[null, { x: 1 }], [{ 'a~/b': [1, 2, 3, 4] }, { 'a~/b': [9] }], [[1], [2, 3, 4]], [{ a: [{ x: 1 }, { y: 2 }], old: 1 }, { a: [{ z: 3 }], next: true }], [{ '': 1 }, { '': 2 }]];
  for (const [a, b] of cases) { const r = objects(a, b); assert.deepEqual(applyPatch(a, JSON.parse(r.patch)), b); }
  const r = objects([1, 2, 3, 4], [1]); assert.deepEqual(JSON.parse(r.patch).map(c => c.path), ['/3', '/2', '/1']);
});
test('patch export is unavailable when rules cannot reproduce the whole document', () => {
  for (const option of [{ ignoreArrayOrder: true }, { ignoreKeyOrder: false }, { arrayKey: 'id' }, { ignoredPaths: 'x' }]) {
    const r = objects({ x: 1 }, { x: 2 }, option); assert.equal(r.patch, null); assert.match(r.patchReason, /JSON Patch needs/);
  }
  assert.equal(objects({}, {}).patch, '[]'); assert.equal(JSON.parse(objects({}, {}).report).changes.length, 0);
});
test('reports and previews retain exact number tokens and original option compatibility', () => {
  const r = diff('{"id":9007199254740993,"price":1.0000000000000001}', '{"id":9007199254740994,"price":1.0000000000000002}');
  assert.match(r.report, /"oldValue":9007199254740993/); assert.match(r.report, /"newValue":1\.0000000000000002/);
  assert.match(r.leftHtml, />9007199254740993<\/mark>/); assert.deepEqual(JSON.parse(r.report).options, defaults);
});
test('large input has bounded previews, complete comparisons, and no partial-success limit', () => {
  const rows = Array.from({ length: 10000 }, (_, i) => ({ id: i, value: 'x'.repeat(25) })), other = structuredClone(rows); other[9999].value = 'changed';
  const r = objects(rows, other); assert.equal(r.previewLimited, true); assert.equal(r.changes.length, 1); assert.equal(r.changes[0].newPointer, '/9999/value');
  assert.throws(() => objects(Array(DIFF_LIMITS.changes + 1).fill(0), Array(DIFF_LIMITS.changes + 1).fill(1)), /5,000 differences/);
  assert.throws(() => diff('['.repeat(129) + '0' + ']'.repeat(129), '[]'), /128-level/);
  assert.throws(() => diff(' '.repeat(10 * 1024 ** 2 + 1), '{}'), /10 MiB/);
  assert.throws(() => diff('1e' + '1'.repeat(1001), '1'), /exponent exceeds/);
});
test('format-both core keeps numbers, duplicate keys, and escapes without value serialization', () => {
  const text = '{"id":9007199254740993,"a":1,"a":2,"escape":"\\u0061"}'; assert.equal(formatJson(formatJson(text).text, 'compact').text, text);
});
test('250 deterministic nested document pairs produce independently applicable patches', () => {
  let seed = 42;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  function document(depth = 0) {
    const kind = Math.floor(random() * (depth > 3 ? 4 : 6));
    if (kind === 0) return null;
    if (kind === 1) return random() > 0.5;
    if (kind === 2) return Math.floor(random() * 100);
    if (kind === 3) return ['text', 'a/b', '~', '', '<script>', '😀'][Math.floor(random() * 6)];
    if (kind === 4) return Array.from({ length: Math.floor(random() * 6) }, () => document(depth + 1));
    const value = {};
    for (const key of ['a', 'b', 'c', 'a~/b', '']) if (random() > 0.5) value[key] = document(depth + 1);
    return value;
  }
  for (let i = 0; i < 250; i++) { const a = document(), b = document(), r = objects(a, b); assert.deepEqual(applyPatch(a, JSON.parse(r.patch)), b); }
});
