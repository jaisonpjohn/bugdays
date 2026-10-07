import { convertGzip, GzipError } from '../lib/gzip-codec.ts';
import type { GzipRequest } from '../lib/gzip-contract.ts';
self.onmessage = (event: MessageEvent<{ id: number; request: GzipRequest }>) => {
  const { id, request } = event.data;
  try {
    const result = convertGzip(request);
    const port = self as unknown as { postMessage: (value: unknown, transfer: Transferable[]) => void };
    port.postMessage({ id, result }, [result.compressed.buffer as ArrayBuffer, result.decoded.buffer as ArrayBuffer]);
  } catch (error) {
    self.postMessage({ id, error: error instanceof GzipError ? error.message : 'Conversion could not finish. Try a smaller, complete payload.', code: error instanceof GzipError ? error.code : 'unexpected' });
  }
};
