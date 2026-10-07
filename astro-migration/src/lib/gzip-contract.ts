// Small browser/worker contract. Keep the compression library out of the initial page bundle.
export const GZIP_LIMITS = { input: 3 * 1024 * 1024, compressed: 2 * 1024 * 1024, text: 2 * 1024 * 1024, output: 8 * 1024 * 1024 };
export type GzipAction = 'compress' | 'decompress';
export type GzipEncoding = 'auto' | 'base64' | 'hex';
export type GzipLevel = 1 | 6 | 9;
export interface GzipRequest { input: string; action: GzipAction; encoding?: GzipEncoding; level?: GzipLevel; }
export function bytesToBase64(bytes: Uint8Array): string {
  // A single apply/spread call exceeds the argument limit on realistic payloads.
  const chunks: string[] = [];
  for (let start = 0; start < bytes.length; start += 16_384) chunks.push(String.fromCharCode(...bytes.subarray(start, start + 16_384)));
  return btoa(chunks.join(''));
}
