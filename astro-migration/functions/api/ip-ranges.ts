// Retained as a small migration response for older clients; the global multi-megabyte
// catalog is no longer served to browsers.
export function onRequestGet() {
  return Response.json({ error: 'The range catalog endpoint has been replaced by batched IP lookup.', endpoint: '/api/ip-lookup', method: 'POST', body: { ips: ['143.198.1.2'] } }, { status: 410, headers: { 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' } });
}
