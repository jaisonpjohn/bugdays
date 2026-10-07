import { gzip, Inflate } from 'pako';
import { bytesToBase64, GZIP_LIMITS, type GzipRequest } from './gzip-contract.ts';

export class GzipError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.name = 'GzipError'; this.code = code; }
}
export interface GzipResult {
  action: 'compress' | 'decompress';
  text: string | null;
  base64: string;
  compressed: Uint8Array;
  decoded: Uint8Array;
  sourceFormat: 'text' | 'base64' | 'base64url' | 'hex';
  content: 'text' | 'json' | 'xml' | 'binary';
  notes: string[];
}
const fail = (code: string, message: string): never => { throw new GzipError(code, message); };
function normalize(raw: string): { value: string; notes: string[] } {
  let value = raw.trim(); const notes: string[] = [];
  if (value.startsWith('"')) {
    try { const parsed = JSON.parse(value); if (typeof parsed !== 'string') throw new Error(); value = parsed; notes.push('Unwrapped a JSON string.'); }
    catch { fail('base64', 'The quoted input is not a complete JSON string. Copy the encoded field value, not the whole response.'); }
  }
  if (/^data:/i.test(value)) {
    const match = /^data:[^,]{0,200};base64,([\s\S]*)$/i.exec(value);
    if (!match) fail('base64', 'This data URI is not Base64 encoded. Use a Base64 GZip value or open a .gz file.');
    value = match[1]; notes.push('Removed the Base64 data URI prefix.');
  }
  const compact = value.replace(/[ \t\r\n\f]/g, '');
  if (compact !== value) notes.push('Ignored whitespace wrapping; spaces are not converted to plus signs.');
  return { value: compact, notes };
}
function decodeInput(raw: string, encoding: GzipRequest['encoding']) {
  const { value, notes } = normalize(raw);
  if (!value) fail('empty', 'Paste Base64 GZip or hex data, or open a .gz file.');
  if (encoding === 'hex' || (encoding === 'auto' && /^1f8b/i.test(value) && /^[0-9a-f]+$/i.test(value))) {
    if (value.length % 2 || !/^[0-9a-f]+$/i.test(value)) fail('hex', 'Hex needs complete byte pairs using 0–9 and a–f. Spaces and line breaks are accepted.');
    if (value.length / 2 > GZIP_LIMITS.compressed) fail('size', 'Compressed data exceeds 2 MiB. Use a smaller GZip payload.');
    return { bytes: Uint8Array.from(value.match(/../g)!, pair => parseInt(pair, 16)), sourceFormat: 'hex' as const, notes };
  }
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(value)) fail('base64', 'Invalid Base64 characters. Copy only the encoded value; log prefixes, ellipses and entire JSON objects are not Base64.');
  if (/[+/]/.test(value) && /[-_]/.test(value)) fail('base64', 'The value mixes standard Base64 and Base64URL alphabets. Check the original value rather than replacing characters.');
  const urlSafe = /[-_]/.test(value);
  const standard = value.replace(/-/g, '+').replace(/_/g, '/');
  const unpadded = standard.replace(/=+$/, '');
  if (unpadded.length % 4 === 1 || (standard.includes('=') && standard.length % 4 !== 0)) fail('padding', 'Invalid Base64 length or padding. The payload may be truncated; adding padding cannot recover missing bytes.');
  const padded = unpadded + '='.repeat((4 - unpadded.length % 4) % 4);
  if (standard.includes('=') && standard !== padded) fail('padding', 'Incorrect Base64 padding. Check that the full encoded field was copied.');
  if (unpadded.length * 3 / 4 > GZIP_LIMITS.compressed + 1) fail('size', 'Compressed data exceeds 2 MiB. Use a smaller GZip payload.');
  let binary: string;
  try { binary = atob(padded); } catch { fail('base64', 'Base64 could not be decoded. Check the alphabet, padding and complete field value.'); }
  const bytes = Uint8Array.from(binary!, char => char.charCodeAt(0));
  if (bytesToBase64(bytes) !== padded) fail('padding', 'Non-canonical Base64 padding bits. Re-copy the original value; its last character may have changed.');
  if (bytes.length > GZIP_LIMITS.compressed) fail('size', 'Compressed data exceeds 2 MiB. Use a smaller GZip payload.');
  if (!standard.includes('=') && padded.includes('=')) notes.push('Restored omitted Base64 padding.');
  if (urlSafe) notes.push('Decoded the Base64URL alphabet.');
  return { bytes, sourceFormat: urlSafe ? 'base64url' as const : 'base64' as const, notes };
}
function inflateGzip(bytes: Uint8Array): Uint8Array {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) fail('header', 'This is a ZIP archive, not GZip. Use an archive tool to extract it.');
    if (bytes.length >= 2 && (bytes[0] & 15) === 8 && ((bytes[0] << 8) + bytes[1]) % 31 === 0) fail('header', 'This looks like zlib-wrapped DEFLATE, not GZip. Ask the producer for the compression format.');
    fail('header', 'Base64 decoded, but the bytes do not start with the GZip header (1f 8b). Plain Base64 text belongs in the Base64 decoder.');
  }
  if (bytes.length < 18) fail('truncated', 'The GZip stream is too short to contain its complete header and trailer. Copy the whole payload.');
  if (bytes[2] !== 8 || (bytes[3] & 0xe0)) fail('header', 'Invalid GZip compression method or reserved header flags. Check for damaged bytes.');
  // windowBits 31 accepts GZip only, never silently treating zlib as GZip.
  const inflator = new Inflate({ windowBits: 31, chunkSize: 65_536 });
  const chunks: Uint8Array[] = []; let length = 0;
  inflator.onData = (chunk: Uint8Array) => {
    length += chunk.length;
    if (length > GZIP_LIMITS.output) fail('size', 'Stopped before decompressed output exceeded 8 MiB. Use a smaller sample; no partial output is exported.');
    chunks.push(chunk);
  };
  inflator.push(bytes, true);
  if (inflator.err) {
    if (/data check|length check/.test(inflator.msg)) fail('checksum', 'The GZip checksum or original-size check failed. The payload is corrupt or incomplete; partial output is not trusted.');
    fail('corrupt', 'The GZip stream is invalid or damaged. Verify the complete payload and compression format.');
  }
  // Pako can return true for a truncated stream without reaching Z_STREAM_END.
  if (!(inflator as Inflate & { ended: boolean }).ended) fail('truncated', 'The GZip stream ended before its trailer. The payload may have been truncated in a log or database field.');
  const stream = (inflator as Inflate & { strm: { avail_in: number } }).strm;
  if (stream.avail_in) fail('trailing', 'Unexpected bytes follow the GZip stream. Copy only the complete payload, without trailing data.');
  const decoded = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { decoded.set(chunk, offset); offset += chunk.length; }
  return decoded;
}
function inspect(bytes: Uint8Array): { text: string | null; content: GzipResult['content'] } {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return { text: null, content: 'binary' }; }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return { text: null, content: 'binary' };
  try { JSON.parse(text); return { text, content: 'json' }; } catch { /* Keep the exact original text. */ }
  return { text, content: text.trimStart().startsWith('<') ? 'xml' : 'text' };
}
export function convertGzip(request: GzipRequest): GzipResult {
  if (typeof request.input !== 'string' || new TextEncoder().encode(request.input).length > GZIP_LIMITS.input) fail('size', 'Keep encoded input under 3 MiB and text to compress under 2 MiB.');
  if (request.action === 'compress') {
    const decoded = new TextEncoder().encode(request.input);
    if (decoded.length > GZIP_LIMITS.text) fail('size', 'Text to compress exceeds 2 MiB. Use a smaller sample.');
    const level = request.level ?? 6;
    if (![1, 6, 9].includes(level)) fail('setting', 'Choose compression level 1, 6 or 9.');
    const compressed = gzip(decoded, { level });
    // Incompressible input can grow past the compressed-size limit. Do not produce a
    // payload that this tool would refuse to round-trip.
    if (compressed.length > GZIP_LIMITS.compressed) fail('size', 'This input grows past the 2 MiB compressed-data limit. Use a slightly smaller sample.');
    return { action: 'compress', text: request.input, base64: bytesToBase64(compressed), compressed, decoded, sourceFormat: 'text', content: inspect(decoded).content, notes: [] };
  }
  if (request.action !== 'decompress') fail('setting', 'Choose compress or decompress.');
  const encoding = request.encoding ?? 'auto';
  if (!['auto', 'base64', 'hex'].includes(encoding)) fail('setting', 'Choose auto, Base64 or hex input.');
  const { bytes: compressed, sourceFormat, notes } = decodeInput(request.input, encoding);
  const decoded = inflateGzip(compressed);
  return { action: 'decompress', ...inspect(decoded), base64: bytesToBase64(compressed), compressed, decoded, sourceFormat, notes };
}
