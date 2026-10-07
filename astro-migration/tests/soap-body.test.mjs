import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSoapBody } from '../src/lib/soap-messages.ts';

test('response buffering preserves UTF-8 split across chunks', async () => {
  const bytes = new TextEncoder().encode('  café ☕ 中文 😀\n');
  const stream = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  assert.equal(await readSoapBody(new Response(stream)), '  café ☕ 中文 😀\n');
});
test('empty and bodyless responses remain exportable empty text', async () => {
  assert.equal(await readSoapBody(new Response(null)), '');
  assert.equal(await readSoapBody(new Response('')), '');
});
test('size limits apply to streamed bytes, not JavaScript character count', async () => {
  assert.equal(await readSoapBody(new Response('☕'), 3), '☕');
  await assert.rejects(readSoapBody(new Response('☕'), 2), /larger than/);
});
test('oversized streaming responses are cancelled before parsing', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(20)); }, cancel() { cancelled = true; } });
  await assert.rejects(readSoapBody(new Response(stream), 10), /larger than/);
  assert.equal(cancelled, true);
});
test('body transport failures are not mistaken for a complete response', async () => {
  const stream = new ReadableStream({ start(controller) { controller.error(new Error('Disconnected')); } });
  await assert.rejects(readSoapBody(new Response(stream)), /Disconnected/);
});
