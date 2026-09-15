import { fetchIpDataset } from '../../src/lib/ip-datasets';

// This endpoint only returns public range lists. It accepts no IPs or log data.
export async function onRequestGet(context: { request: Request; waitUntil: (promise: Promise<unknown>) => void }) {
  const cache = (caches as CacheStorage & { default: Cache }).default;
  const key = new Request(new URL('/api/ip-ranges', context.request.url));
  const cached = await cache.match(key);
  if (cached) return cached;
  try {
    const dataset = await fetchIpDataset();
    const response = Response.json(dataset, { headers: { 'Cache-Control': `public, max-age=${dataset.failures.length ? 300 : 21600}`, 'X-Content-Type-Options': 'nosniff' } });
    context.waitUntil(cache.put(key, response.clone()));
    return response;
  } catch {
    return Response.json({ error: 'Range feeds unavailable; use the bundled snapshot.' }, { status: 503 });
  }
}
