// Build-time fixtures only: no sample payload is stored in the sharing service.
import { gzipSync } from 'node:zlib';
import LZString from 'lz-string';

export interface GzipExample {
  id: string;
  title: string;
  description: string;
  text: string;
  base64: string;
  decodeHref: string;
  encodeHref: string;
}

function shareHref(input: string, action: 'compress' | 'decompress'): string {
  const state = { v: 1, t: 'gzip-base64', a: action, d: { input } };
  return `/gzip-base64/#lz:${LZString.compressToEncodedURIComponent(JSON.stringify(state))}`;
}

function example(id: string, title: string, description: string, text: string): GzipExample {
  const base64 = gzipSync(Buffer.from(text, 'utf8'), { level: 6 }).toString('base64');
  return { id, title, description, text, base64, decodeHref: shareHref(base64, 'decompress'), encodeHref: shareHref(text, 'compress') };
}

export const gzipExamples = [
  example('json', 'JSON API response', 'Decode a small order-status response.', '{"orderId":"demo-1042","status":"shipped","items":3}'),
  example('unicode', 'UTF-8 text', 'Round-trip accented text and an emoji.', '{"message":"Hello, café ☕","city":"Montréal"}'),
  example('xml', 'XML payload', 'Inspect an XML message after decompression.', '<status><service>demo-api</service><healthy>true</healthy></status>'),
];
