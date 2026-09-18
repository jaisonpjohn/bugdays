// The analytics contract: tool ids, actions, formats and buckets go out; user input never does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { track, sizeBucket, countBucket } from '../src/lib/analytics.ts';

function capture(fn) {
  const sent = [];
  globalThis.window = { gtag: (kind, event, params) => sent.push([kind, event, params]) };
  try { fn(); } finally { delete globalThis.window; }
  return sent;
}

test('sends slug parameters', () => {
  const sent = capture(() => track('tool_used', { tool: 'json-formatter', action: 'Prettify' }));
  assert.deepEqual(sent, [['event', 'tool_used', { tool: 'json-formatter', action: 'prettify' }]]);
});

test('drops anything that looks like user content', () => {
  const [[, , params]] = capture(() => track('tool_used', {
    tool: 'jwt-decoder',
    pasted: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature-value-here',
    host: 'internal.corp.example.com',
    query: 'SELECT * FROM users',
    header: 'Bearer sk-live-123',
    email: 'someone@example.com',
    path: '/orders/4711?token=abc',
    note: 'two words',
  }));
  assert.deepEqual(params, { tool: 'jwt-decoder' }, 'only the tool id survives');
});

test('keeps numbers but rounds them, and ignores junk', () => {
  const [[, , params]] = capture(() => track('export_used', { tool: 'dns-lookup', rows: 12.7, nan: NaN, missing: undefined }));
  assert.deepEqual(params, { tool: 'dns-lookup', rows: 13 });
});

test('ignores invalid event names and a missing gtag', () => {
  assert.deepEqual(capture(() => track('tool used!', { tool: 'x' })), []);
  globalThis.window = {};
  assert.doesNotThrow(() => track('tool_used', { tool: 'x' }));
  delete globalThis.window;
  assert.doesNotThrow(() => track('tool_used', { tool: 'x' }));
});

test('buckets hide exact sizes and counts', () => {
  assert.equal(sizeBucket(0), 'lt_1kb');
  assert.equal(sizeBucket(999), 'lt_1kb');
  assert.equal(sizeBucket(1_000), 'lt_10kb');
  assert.equal(sizeBucket(250_000), 'lt_1mb');
  assert.equal(sizeBucket(5_000_000), 'gte_1mb');
  assert.equal(sizeBucket(Number.NaN), 'unknown');
  assert.equal(countBucket(1), '1');
  assert.equal(countBucket(7), '6_20');
  assert.equal(countBucket(5_000), 'gt_100');
});
