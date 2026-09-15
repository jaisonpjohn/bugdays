import { parseIp, specialIpLabel } from '../../src/lib/ip-address.ts';
import { addressLookupKeys, datasetFromRows } from '../../src/lib/ip-range-database.ts';
import type { IpRangeRow, IpSourceRow } from '../../src/lib/ip-range-database.ts';

interface D1Result<T> { results?: T[] }
interface D1Statement { bind(...values: unknown[]): D1Statement }
interface D1Database {
  prepare(query: string): D1Statement;
  batch<T>(statements: D1Statement[]): Promise<D1Result<T>[]>;
}
interface Env { IP_DB?: D1Database }

const jsonHeaders = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Type': 'application/json; charset=utf-8' };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: jsonHeaders });

export async function onRequestPost(context: { request: Request; env: Env }) {
  if (!context.env.IP_DB) return reply({ error: 'IP intelligence is temporarily unavailable.' }, 503);
  if (Number(context.request.headers.get('content-length') || 0) > 100_000) return reply({ error: 'Lookup request is too large.' }, 413);
  let body: unknown;
  try {
    const text = await context.request.text();
    if (text.length > 100_000) return reply({ error: 'Lookup request is too large.' }, 413);
    body = JSON.parse(text);
  } catch { return reply({ error: 'Expected a JSON request.' }, 400); }
  const submitted = (body as { ips?: unknown })?.ips;
  if (!Array.isArray(submitted) || !submitted.length || submitted.length > 1000) return reply({ error: 'Send between 1 and 1,000 IP addresses.' }, 400);
  const parsed = submitted.map(value => typeof value === 'string' ? parseIp(value) : null);
  if (parsed.some(ip => !ip)) return reply({ error: 'Every item must be a valid IPv4 or IPv6 address.' }, 400);
  const ips = [...new Set(parsed.map(ip => ip!.address))];

  // Special-use addresses never need a database query.
  const publicIps = ips.filter(address => !specialIpLabel(parseIp(address)!));
  const keySet = new Set(publicIps.flatMap(addressLookupKeys));
  const keyChunks: string[][] = [];
  const keys = [...keySet];
  for (let at = 0; at < keys.length; at += 4000) keyChunks.push(keys.slice(at, at + 4000));
  try {
    const statements = [
      context.env.IP_DB.prepare('SELECT id, name, kind, method, url, published_at, range_count, asns_json FROM ip_sources ORDER BY id'),
      context.env.IP_DB.prepare("SELECT value FROM ip_meta WHERE key = 'fetched_at'"),
      ...keyChunks.map(chunk => context.env.IP_DB!.prepare('SELECT cidr, source_id, service, region FROM ip_ranges WHERE lookup_key IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(chunk))),
    ];
    const results = await context.env.IP_DB.batch<any>(statements);
    const sources = (results[0]?.results || []) as IpSourceRow[];
    const fetchedAt = String((results[1]?.results?.[0] as { value?: string } | undefined)?.value || new Date().toISOString());
    const ranges = results.slice(2).flatMap(result => result.results || []) as IpRangeRow[];
    return reply(datasetFromRows(fetchedAt, sources, ranges));
  } catch {
    return reply({ error: 'IP intelligence is temporarily unavailable.' }, 503);
  }
}

export function onRequestGet() {
  return reply({ status: 'ok', endpoint: '/api/ip-lookup', accepts: 'POST { ips: string[] }', maximum: 1000 });
}
