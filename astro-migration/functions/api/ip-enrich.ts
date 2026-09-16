import { parseIp, specialIpLabel } from '../../src/lib/ip-address.ts';
import { normalizeIpWhois, normalizePtrResponse, reverseDnsName, validateIpEnrichment } from '../../src/lib/ip-enrichment.ts';
import type { IpEnrichment } from '../../src/lib/ip-enrichment.ts';

interface Env { IPWHOIS_API_KEY?: string }
interface CacheLike { match(request: Request): Promise<Response | undefined>; put(request: Request, response: Response): Promise<void> }
interface Context { request: Request; env: Env; waitUntil?(promise: Promise<unknown>): void }

const responseHeaders = { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' };
const reply = (body: unknown, status = 200, cache = 'BYPASS') => new Response(JSON.stringify(body), { status, headers: { ...responseHeaders, 'X-BugDays-Cache': cache } });

class UpstreamError extends Error {
  status: number;
  constructor(status: number) { super(`Upstream returned ${status}.`); this.status = status; }
}

async function readJson(url: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new UpstreamError(response.status);
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > 100_000) throw new Error('Upstream response is too large.');
  const body = await response.text();
  if (body.length > 100_000) throw new Error('Upstream response is too large.');
  return JSON.parse(body);
}

function cacheApi(): CacheLike | undefined {
  return (globalThis as any).caches?.default as CacheLike | undefined;
}

async function enrich(ip: string, env: Env): Promise<IpEnrichment> {
  const warnings: string[] = [], sources: IpEnrichment['sources'] = [];
  const key = env.IPWHOIS_API_KEY?.trim();
  const geoUrl = key
    ? `https://ipwhois.pro/${encodeURIComponent(ip)}?key=${encodeURIComponent(key)}`
    : `https://ipwho.is/${encodeURIComponent(ip)}`;
  const ptrUrl = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(reverseDnsName(ip))}&type=PTR`;
  const [geoResult, ptrResult] = await Promise.allSettled([
    readJson(geoUrl),
    readJson(ptrUrl, { Accept: 'application/dns-json' }),
  ]);
  let providerData: Pick<IpEnrichment, 'network' | 'location' | 'security'> = {};
  if (geoResult.status === 'fulfilled') {
    try { providerData = normalizeIpWhois(geoResult.value, ip); sources.push('ipwhois'); }
    catch { warnings.push('Live ISP and location data could not be verified.'); }
  } else {
    warnings.push(geoResult.reason instanceof UpstreamError && geoResult.reason.status === 429
      ? 'Live ISP and location lookups reached their current service limit. Try again later.'
      : 'Live ISP and location data is temporarily unavailable.');
  }
  let reverseDns: string[] = [];
  if (ptrResult.status === 'fulfilled') {
    reverseDns = normalizePtrResponse(ptrResult.value); sources.push('cloudflare-dns');
  } else warnings.push('Reverse DNS is temporarily unavailable.');
  return { version: 1, ip, lookedUpAt: new Date().toISOString(), ...providerData, reverseDns, sources, warnings };
}

export async function onRequestPost(context: Context) {
  if (Number(context.request.headers.get('content-length') || 0) > 2_000) return reply({ error: 'Lookup request is too large.' }, 413);
  let body: any;
  try {
    const text = await context.request.text();
    if (text.length > 2_000) return reply({ error: 'Lookup request is too large.' }, 413);
    body = JSON.parse(text);
  } catch { return reply({ error: 'Expected a JSON request.' }, 400); }
  const parsed = typeof body?.ip === 'string' ? parseIp(body.ip) : null;
  if (!parsed) return reply({ error: 'Send one valid IPv4 or IPv6 address.' }, 400);
  const specialUse = specialIpLabel(parsed);
  if (specialUse) return reply({ version: 1, ip: parsed.address, lookedUpAt: new Date().toISOString(), specialUse, reverseDns: [], sources: [], warnings: [] } satisfies IpEnrichment);

  const cache = cacheApi();
  const cacheKey = new Request(new URL(`/api/ip-enrich/cache/${encodeURIComponent(parsed.address)}`, context.request.url), { method: 'GET' });
  if (cache) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) return reply(validateIpEnrichment(await cached.json(), parsed.address), 200, 'HIT');
    } catch { /* A corrupt or unavailable edge cache must not break the lookup. */ }
  }

  const result = await enrich(parsed.address, context.env || {});
  if (cache) {
    const ttl = result.sources.length ? 86_400 : 300;
    const write = cache.put(cacheKey, new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${ttl}` } })).catch(() => undefined);
    if (context.waitUntil) context.waitUntil(write); else await write;
  }
  return reply(result, 200, 'MISS');
}

export function onRequestGet() {
  return reply({ status: 'ok', endpoint: '/api/ip-enrich', accepts: 'POST { ip: string }', behavior: 'On-demand ISP, ASN, approximate location, and reverse DNS enrichment for one public IP.' });
}
