import { parseIp } from './ip-address.ts';
import { reverseDnsName } from './ip-enrichment.ts';

export const DNS_RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'SRV', 'CAA'] as const;
export type DnsRecordType = typeof DNS_RECORD_TYPES[number] | 'PTR';
export type DnsMode = 'compare' | 'public' | 'system';

export interface DnsAnswer {
  name: string;
  type: string;
  ttl: number;
  data: string;
}

export interface DnsRecordSet {
  recordType: string;
  status: string;
  elapsedMs: number;
  answers: DnsAnswer[];
  error?: string;
}

export interface DnsSourceReport {
  query: string;
  resolver: 'public' | 'system';
  reverseLookup: boolean;
  elapsedMs: number;
  results: DnsRecordSet[];
  forwardConfirmed?: boolean;
  forwardAddresses: string[];
}

export interface DnsReport {
  version: 1;
  target: string;
  lookedUpAt: string;
  requestedTypes: string[];
  sources: DnsSourceReport[];
}

interface DohAnswer { name?: unknown; type?: unknown; TTL?: unknown; data?: unknown }
interface DohResponse { Status?: unknown; Answer?: unknown }

const TYPE_CODES: Record<string, number> = {
  A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, SRV: 33, CAA: 257,
};
const CODE_TYPES = Object.fromEntries(Object.entries(TYPE_CODES).map(([name, code]) => [code, name]));
const STATUS_NAMES: Record<number, string> = { 0: 'NOERROR', 1: 'FORMERR', 2: 'SERVFAIL', 3: 'NXDOMAIN', 4: 'NOTIMP', 5: 'REFUSED' };

export class BridgeUnavailableError extends Error {
  readonly outdated: boolean;
  constructor(message: string, outdated = false) { super(message); this.outdated = outdated; }
}

export function normalizeDnsTarget(value: string): string {
  let target = value.trim();
  if (!target) throw new Error('Enter a hostname or IP address.');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    try { target = new URL(target).hostname; }
    catch { throw new Error('Enter a valid hostname, IP address, or URL.'); }
  }
  target = target.trim().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!parseIp(target) && /^[^:]+:\d+$/.test(target)) target = target.replace(/:\d+$/, '');
  if (!target || target.length > 253 || /[\s/@]/.test(target)) {
    throw new Error('Enter one valid hostname or IP address.');
  }
  return parseIp(target)?.address || target.toLowerCase();
}

export function selectedDnsTypes(target: string, values: readonly string[]): DnsRecordType[] {
  if (parseIp(target)) return ['PTR'];
  const result = [...new Set(values.map(value => value.toUpperCase()).filter(value => DNS_RECORD_TYPES.includes(value as any)))] as DnsRecordType[];
  if (!result.length) throw new Error('Choose at least one DNS record type.');
  return result;
}

function now(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function normalizeDohAnswer(value: DohAnswer): DnsAnswer | null {
  if (typeof value.name !== 'string' || typeof value.type !== 'number' || typeof value.TTL !== 'number' || typeof value.data !== 'string') return null;
  const type = CODE_TYPES[value.type] || `TYPE${value.type}`;
  return {
    name: value.name.replace(/\.$/, ''),
    type,
    ttl: Math.max(0, Math.floor(value.TTL)),
    data: ['CNAME', 'NS', 'PTR'].includes(type) ? value.data.replace(/\.$/, '') : value.data,
  };
}

async function publicRecordQuery(target: string, type: DnsRecordType): Promise<DnsRecordSet> {
  const query = type === 'PTR' ? reverseDnsName(target) : target;
  const started = now();
  try {
    const url = new URL('https://cloudflare-dns.com/dns-query');
    url.searchParams.set('name', query);
    url.searchParams.set('type', type);
    const response = await fetch(url, { headers: { Accept: 'application/dns-json' } });
    if (!response.ok) throw new Error(`Public resolver returned HTTP ${response.status}.`);
    const payload = await response.json() as DohResponse;
    const statusCode = typeof payload.Status === 'number' ? payload.Status : -1;
    const answers = Array.isArray(payload.Answer)
      ? payload.Answer.map(value => normalizeDohAnswer(value as DohAnswer)).filter((value): value is DnsAnswer => Boolean(value))
      : [];
    return {
      recordType: type,
      status: STATUS_NAMES[statusCode] || `RCODE${statusCode}`,
      elapsedMs: Math.round(now() - started),
      answers,
    };
  } catch (error) {
    return {
      recordType: type,
      status: 'ERROR',
      elapsedMs: Math.round(now() - started),
      answers: [],
      error: error instanceof Error ? error.message : 'Public DNS lookup failed.',
    };
  }
}

export async function queryPublicDns(targetValue: string, requestedTypes: readonly string[]): Promise<DnsSourceReport> {
  const target = normalizeDnsTarget(targetValue);
  const types = selectedDnsTypes(target, requestedTypes);
  const started = now();
  const results = await Promise.all(types.map(type => publicRecordQuery(target, type)));
  const reverseLookup = types.length === 1 && types[0] === 'PTR';
  const forwardAddresses: string[] = [];
  let forwardConfirmed: boolean | undefined;
  if (reverseLookup) {
    const names = results.flatMap(result => result.answers).filter(answer => answer.type === 'PTR').map(answer => answer.data).slice(0, 5);
    if (names.length) {
      const forward = await Promise.all(names.flatMap(name => [publicRecordQuery(name, 'A'), publicRecordQuery(name, 'AAAA')]));
      for (const value of forward.flatMap(result => result.answers).filter(answer => answer.type === 'A' || answer.type === 'AAAA').map(answer => answer.data)) {
        const address = parseIp(value)?.address;
        if (address && !forwardAddresses.includes(address)) forwardAddresses.push(address);
      }
      forwardConfirmed = forwardAddresses.includes(parseIp(target)?.address || target);
    }
  }
  return { query: target, resolver: 'public', reverseLookup, elapsedMs: Math.round(now() - started), results, forwardConfirmed, forwardAddresses };
}

function bridgeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '');
  const url = new URL(normalized);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Bridge URL must start with http:// or https://.');
  return normalized;
}

export async function checkDnsBridge(value: string): Promise<{ version: string }> {
  const base = bridgeBaseUrl(value);
  try {
    const response = await fetch(`${base}/api/v1/capabilities`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as any;
    if (payload?.capabilities?.dnsLookup !== true) {
      throw new BridgeUnavailableError('Holy CORS is running, but this version does not include DNS lookup. Update it and retry.', true);
    }
    return { version: typeof payload.version === 'string' ? payload.version : 'current' };
  } catch (error) {
    if (error instanceof BridgeUnavailableError) throw error;
    throw new BridgeUnavailableError(`Could not reach Holy CORS at ${base}. Start or update the bridge, then retry.`);
  }
}

export async function querySystemDns(targetValue: string, requestedTypes: readonly string[], bridgeValue: string): Promise<DnsSourceReport> {
  const target = normalizeDnsTarget(targetValue);
  const types = selectedDnsTypes(target, requestedTypes);
  const base = bridgeBaseUrl(bridgeValue);
  await checkDnsBridge(base);
  const response = await fetch(`${base}/api/v1/dns/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: target, types, forwardCheck: true }),
  });
  const payload = await response.json().catch(() => ({})) as any;
  if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : `DNS lookup failed with HTTP ${response.status}.`);
  return validateDnsSource(payload, 'system', target);
}

export function validateDnsSource(input: unknown, resolver: 'public' | 'system', expectedTarget: string): DnsSourceReport {
  const value = input as any;
  if (!value || value.query !== expectedTarget || value.resolver !== resolver || !Array.isArray(value.results)) throw new Error('Invalid DNS response.');
  const results = value.results.slice(0, 16).map((result: any): DnsRecordSet => {
    if (!result || typeof result.recordType !== 'string' || typeof result.status !== 'string' || !Array.isArray(result.answers)) throw new Error('Invalid DNS response.');
    return {
      recordType: result.recordType.slice(0, 16),
      status: result.status.slice(0, 32),
      elapsedMs: Number.isFinite(result.elapsedMs) ? Math.max(0, result.elapsedMs) : 0,
      answers: result.answers.slice(0, 100).map((answer: any): DnsAnswer => {
        if (!answer || typeof answer.name !== 'string' || typeof answer.type !== 'string' || typeof answer.ttl !== 'number' || typeof answer.data !== 'string') throw new Error('Invalid DNS response.');
        return { name: answer.name.slice(0, 253), type: answer.type.slice(0, 16), ttl: Math.max(0, answer.ttl), data: answer.data.slice(0, 4096) };
      }),
      ...(typeof result.error === 'string' ? { error: result.error.slice(0, 500) } : {}),
    };
  });
  return {
    query: expectedTarget,
    resolver,
    reverseLookup: value.reverseLookup === true,
    elapsedMs: Number.isFinite(value.elapsedMs) ? Math.max(0, value.elapsedMs) : 0,
    results,
    ...(typeof value.forwardConfirmed === 'boolean' ? { forwardConfirmed: value.forwardConfirmed } : {}),
    forwardAddresses: Array.isArray(value.forwardAddresses) ? value.forwardAddresses.filter((item: unknown) => typeof item === 'string').slice(0, 20) : [],
  };
}

export function dnsReportRows(report: DnsReport): string[][] {
  const rows = [['Resolver', 'Query', 'Type', 'Status', 'TTL', 'Record name', 'Answer', 'Latency (ms)']];
  for (const source of report.sources) {
    for (const result of source.results) {
      if (!result.answers.length) rows.push([source.resolver, source.query, result.recordType, result.status, '', '', result.error || '', String(result.elapsedMs)]);
      for (const answer of result.answers) rows.push([source.resolver, source.query, answer.type, result.status, String(answer.ttl), answer.name, answer.data, String(result.elapsedMs)]);
    }
  }
  return rows;
}

export function dnsReportsDiffer(report: DnsReport): boolean {
  if (report.sources.length < 2) return false;
  const signature = (source: DnsSourceReport) => source.results
    .flatMap(result => result.answers.map(answer => `${answer.type}\t${answer.data}`))
    .sort()
    .join('\n');
  return signature(report.sources[0]) !== signature(report.sources[1]);
}
