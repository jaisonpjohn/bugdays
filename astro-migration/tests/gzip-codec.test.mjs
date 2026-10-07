import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync, deflateSync } from 'node:zlib';
import { convertGzip, GzipError } from '../src/lib/gzip-codec.ts';
import { bytesToBase64, GZIP_LIMITS } from '../src/lib/gzip-contract.ts';
import { gzipExamples } from '../src/lib/gzip-examples.ts';
const decode = (input, encoding = 'auto') => convertGzip({ input, action: 'decompress', encoding });
const encode = (input, level = 6) => convertGzip({ input, action: 'compress', level });
const error = (fn, code) => assert.throws(fn, e => e instanceof GzipError && e.code === code);

test('every published synthetic example decodes exactly and interops with Node', () => {
  for (const example of gzipExamples) {
    const r = decode(example.base64); assert.equal(r.text, example.text);
    assert.deepEqual(Buffer.from(r.decoded), Buffer.from(example.text));
    assert.equal(gunzipSync(Buffer.from(encode(example.text).base64, 'base64')).toString(), example.text);
  }
});
test('all three compression levels round-trip UTF-8 without mutating content', () => {
  const source = '  Hello, café ☕ 中文 😀\n'.repeat(1000);
  for (const level of [1, 6, 9]) {
    const r = encode(source, level); assert.equal(r.text, source); assert.equal(decode(r.base64).text, source);
    assert.equal(r.decoded.length, Buffer.byteLength(source));
  }
});
test('empty and tiny inputs compress correctly without pretending they shrink', () => {
  for (const input of ['', 'a']) { const r = encode(input); assert.equal(decode(r.base64).text, input); assert.ok(r.compressed.length > r.decoded.length); }
  error(() => decode('  '), 'empty');
});
test('large incompressible payloads do not hit JavaScript apply argument limits', () => {
  const source = randomBytes(300_000).toString('base64'), r = encode(source);
  assert.ok(r.compressed.length > 250_000); assert.equal(decode(r.base64).text, source);
  assert.equal(bytesToBase64(randomBytes(300_000)).length, 400_000);
});
test('Base64URL, omitted padding, wrapping, JSON strings and data URIs work', () => {
  const encoded = gzipSync(Buffer.from('Hello, café ☕')).toString('base64');
  for (const input of [encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), encoded.replace(/.{10}/g, '$&\n'), JSON.stringify(encoded), `data:application/gzip;base64,${encoded}`]) assert.equal(decode(input).text, 'Hello, café ☕');
  const escaped = JSON.stringify(encoded).replace(/\//g, '\\/'); assert.equal(decode(escaped).text, 'Hello, café ☕');
});
test('hex is detected by GZip magic and explicit hex accepts whitespace', () => {
  const hex = gzipSync(Buffer.from('hex result')).toString('hex');
  assert.equal(decode(hex).sourceFormat, 'hex'); assert.equal(decode(hex.toUpperCase().match(/../g).join(' \n'), 'hex').text, 'hex result');
  error(() => decode('1f8', 'hex'), 'hex'); error(() => decode('oops', 'hex'), 'hex');
});
test('padding, mixed alphabets and non-canonical bits fail rather than guessing', () => {
  for (const input of ['A', 'AAAA=', 'AA===', 'AA=A', 'AB==', 'a+/b-_']) assert.throws(() => decode(input), GzipError);
  for (const input of ['H4sI…', 'log: H4sI', '{"data":"H4sI"}', '%2FH4sI']) error(() => decode(input), 'base64');
  error(() => decode('"not closed'), 'base64'); error(() => decode('data:text/plain,abc'), 'base64');
});
test('non-GZip Base64, ZIP and zlib give format-specific explanations', () => {
  assert.throws(() => decode(Buffer.from('ordinary text').toString('base64')), /Plain Base64/);
  assert.throws(() => decode(Buffer.from('PK\x03\x04').toString('base64')), /ZIP archive/);
  assert.throws(() => decode(deflateSync(Buffer.from('zlib')).toString('base64')), /zlib-wrapped/);
});
test('truncated streams cannot return a partial success, including absent trailer', () => {
  const raw = gzipSync(Buffer.from('complete result'.repeat(100)));
  for (const cut of [1, 4, 8, 12, raw.length - 3]) assert.throws(() => decode(raw.subarray(0, raw.length - cut).toString('base64')), GzipError);
});
test('CRC and original-size corruption are rejected', () => {
  for (const index of [-8, -4]) {
    const raw = gzipSync(Buffer.from('checked')); raw[raw.length + index] ^= 1;
    error(() => decode(raw.toString('base64')), 'checksum');
  }
});
test('invalid method, reserved flags and appended garbage are rejected', () => {
  for (const [index, value] of [[2, 7], [3, 0x80]]) {
    const raw = gzipSync(Buffer.from('header')); raw[index] = value; error(() => decode(raw.toString('base64')), 'header');
  }
  const raw = gzipSync(Buffer.from('trailing'));
  error(() => decode(Buffer.concat([raw, Buffer.from([0, 0])]).toString('base64')), 'trailing');
  assert.throws(() => decode(Buffer.concat([raw, Buffer.from([1, 2])]).toString('base64')), GzipError);
});
test('concatenated GZip members produce their complete combined output', () => {
  const bytes = Buffer.concat([gzipSync(Buffer.from('first\n')), gzipSync(Buffer.from('second☕'))]);
  assert.equal(decode(bytes.toString('base64')).text, 'first\nsecond☕');
});
test('binary and non-UTF-8 results preserve the exact bytes for export', () => {
  for (const source of [Buffer.from([0, 255, 1, 65]), Buffer.from([0xe9, 0x20, 0x41]), Buffer.from([0, 65])]) {
    const r = decode(gzipSync(source).toString('base64')); assert.equal(r.text, null); assert.equal(r.content, 'binary'); assert.deepEqual(Buffer.from(r.decoded), source);
  }
});
test('JSON/XML classification never prettifies or changes the original output', () => {
  const json = '{ "big":9007199254740993, "x":1,"x":2 }';
  assert.equal(decode(encode(json).base64).content, 'json'); assert.equal(decode(encode(json).base64).text, json);
  assert.equal(decode(encode('<message> hi </message>').base64).content, 'xml');
  const bom = '\ufeffhello'; assert.equal(decode(encode(bom).base64).text, bom);
});
test('input/decoded-output limits stop before exporting partial payloads', () => {
  error(() => encode('a'.repeat(GZIP_LIMITS.text + 1)), 'size');
  error(() => decode('a'.repeat(GZIP_LIMITS.input + 1)), 'size');
  const bomb = gzipSync(Buffer.alloc(GZIP_LIMITS.output + 1, 65)); error(() => decode(bomb.toString('base64')), 'size');
  const boundary = gzipSync(Buffer.alloc(GZIP_LIMITS.output, 65)); assert.equal(decode(boundary.toString('base64')).decoded.length, GZIP_LIMITS.output);
});
test('invalid settings are rejected and old links default to auto and level 6', () => {
  error(() => convertGzip({ input: 'a', action: 'wat' }), 'setting');
  error(() => encode('a', 4), 'setting'); error(() => decode('H4sI', 'raw'), 'setting');
  const r = convertGzip({ action: 'compress', input: 'default' }); assert.equal(convertGzip({ action: 'decompress', input: r.base64 }).text, 'default');
});
