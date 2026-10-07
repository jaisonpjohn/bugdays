import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatJson, JsonFormatError, JSON_LIMITS, jqChildPath, pointerChildPath } from '../src/lib/json-formatter.ts';

const exact = '{"id":9007199254740993,"n":1.0000000000000001,"exp":1E400,"zero":-0,"price":10.50,"a":1,"a":2,"escape":"\\u0061","2":2,"1":1}';
test('formatting and minifying preserve every token, duplicates and source order', () => {
  for (const indent of ['2', '4', 'tab']) {
    const result = formatJson(exact, 'prettify', indent);
    assert.equal(formatJson(result.text, 'compact').text, exact);
    assert.match(result.text, new RegExp('\\n' + (indent === 'tab' ? '\\t' : ' '.repeat(Number(indent))) + '"id"'));
    assert.equal(result.duplicates, 1); assert.equal(result.largeNumbers, 2);
  }
});
test('validation and tree leave text untouched and tree has both duplicate values', () => {
  assert.equal(formatJson(' \n' + exact, 'validate').text, ' \n' + exact);
  const tree = formatJson(exact, 'tree');
  assert.equal(tree.nodes.filter(n => n.key === 'a').length, 2);
  assert.equal(exact.slice(tree.nodes[1].offset, tree.nodes[1].offset + tree.nodes[1].length), '9007199254740993');
});
test('prototype keys and escaped duplicates cannot mutate objects', () => {
  const r = formatJson('{"__proto__":{"x":1},"a":1,"\\u0061":2,"nested":{"a":3}}', 'tree');
  assert.equal(r.duplicates, 1); assert.equal({}.x, undefined);
});
for (const invalid of ['', '{"a":}', '{"a":1,}', '[1,]', '{/*comment*/"x":1}', '01', '-01', '+1', '1.', '1e', 'NaN', 'Infinity', "{'a':1}", '{a:1}', '{} {}', 'true false', '"bad\nstring"', '"\\x00"', '"\\u00ZZ"', '\u00a0{}', '\ufeff{}']) {
  test(`strict JSON rejects ${JSON.stringify(invalid)} without rewriting it`, () => assert.throws(() => formatJson(invalid), JsonFormatError));
}
test('error offsets identify missing values exactly', () => {
  assert.throws(() => formatJson('{\n  "a":\n}'), error => error.offset === 9);
});
test('scalars, empty containers, Unicode and escaped strings work', () => {
  for (const text of ['null', 'true', 'false', '0', '"😀"', '{}', '[]', '{"a":[],"b":{}}', '{"line":"a\\n b","quote":"\\\""}']) {
    assert.deepEqual(JSON.parse(formatJson(text).text), JSON.parse(text));
    assert.equal(formatJson(formatJson(text).text, 'compact').text, text);
  }
});
test('boundary depth is accepted, excessive depth and size are bounded', () => {
  const nested = depth => '['.repeat(depth) + '0' + ']'.repeat(depth);
  assert.equal(formatJson(nested(JSON_LIMITS.depth), 'validate').depth, JSON_LIMITS.depth);
  assert.throws(() => formatJson(nested(JSON_LIMITS.depth + 1)), /nesting limit/);
  assert.throws(() => formatJson(' '.repeat(JSON_LIMITS.inputBytes + 1)), /10 MiB/);
});
test('large document formats in source order and reports correct counts', () => {
  const text = '[' + Array.from({ length: 10000 }, (_, i) => `{"id":${i},"value":9007199254740993}`).join(',') + ']';
  const r = formatJson(text);
  assert.equal(r.values, 30001); assert.equal(r.largeNumbers, 10000); assert.equal(r.findings.length, 20);
  assert.equal(formatJson(r.text, 'compact').text, text);
});
test('jq accessors and JSON Pointer encode arbitrary keys', () => {
  assert.equal(jqChildPath('.', 'content.type', false), '.["content.type"]');
  assert.equal(jqChildPath('.orders', '0', true), '.orders[0]');
  assert.equal(pointerChildPath('/items/0', 'a~/b'), '/items/0/a~0~1b');
  assert.equal(jqChildPath('.', 'a"b', false), '.["a\\"b"]');
});
