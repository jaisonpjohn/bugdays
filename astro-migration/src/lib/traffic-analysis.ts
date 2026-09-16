import { parseIp, parseCidr, extractIps, specialIpLabel } from './ip-address.ts';
import type { IpAddress } from './ip-address.ts';
import { sourceIds } from './ip-datasets.ts';
import type { IpDataset, IpSource, SourceKind, SourceMethod } from './ip-datasets.ts';
import { validateIpEnrichment } from './ip-enrichment.ts';
import type { IpEnrichment } from './ip-enrichment.ts';

export type TrafficMode = 'ip' | 'log';
export interface RangeMatch { source: string; cidr: string; service: string; region: string; kind: SourceKind; method: SourceMethod }
export interface IpRow { address: string; version: 4 | 6; count: number; category: SourceKind | 'special' | 'unmatched'; label: string; matches: RangeMatch[]; errors: number; bytes: number; enrichment?: IpEnrichment }
export interface CountRow { label: string; count: number }
export interface TrafficReport {
  v: 1; kind: 'bugdays-traffic-report'; mode: TrafficMode; createdAt: string;
  title?: string;
  dataset: { fetchedAt: string; sources: IpSource[]; failures: string[] };
  summary: { lines: number; accepted: number; skipped: number; uniqueIps: number; matchedIps: number; matchedEvents: number; errors: number; bytes: number; timedRequests: number; p50: number | null; p95: number | null; first: number | null; last: number | null };
  ips: IpRow[]; paths: CountRow[]; statuses: CountRow[]; timeline: CountRow[]; bucketMinutes: number;
  issues: { line: number; reason: string }[]; shared?: { includedIps: number; totalIps: number; scope: string };
}

export class RangeIndex {
  private indexes = { 4: new Map<number, Map<bigint, RangeMatch[]>>(), 6: new Map<number, Map<bigint, RangeMatch[]>>() };
  private prefixes = { 4: [] as number[], 6: [] as number[] };
  constructor(dataset: IpDataset) {
    const sources = new Map(dataset.sources.map(source => [source.id, source]));
    for (const [cidr, source, service, region] of dataset.ranges) {
      const parsed = parseCidr(cidr), info = sources.get(source);
      if (!parsed || !info) continue;
      let group = this.indexes[parsed.version].get(parsed.prefix);
      if (!group) { group = new Map(); this.indexes[parsed.version].set(parsed.prefix, group); }
      const entries = group.get(parsed.network) || [];
      entries.push({ cidr, source, service, region, kind: info.kind, method: info.method });
      group.set(parsed.network, entries);
    }
    this.prefixes[4] = [...this.indexes[4].keys()].sort((a, b) => b - a);
    this.prefixes[6] = [...this.indexes[6].keys()].sort((a, b) => b - a);
  }
  lookup(ip: IpAddress): RangeMatch[] {
    const matches: RangeMatch[] = [];
    const seen = new Set<string>();
    const bits = ip.version === 4 ? 32 : 128;
    for (const prefix of this.prefixes[ip.version]) {
      const ranges = this.indexes[ip.version].get(prefix)!;
      const shift = BigInt(bits - prefix);
      for (const match of ranges.get((ip.value >> shift) << shift) || []) {
        const key = `${match.source}\0${match.service}\0${match.region}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push(match);
      }
    }
    return matches;
  }
}

function makeIpRow(ip: IpAddress, index: RangeIndex): IpRow {
  const label = specialIpLabel(ip);
  const matches = label ? [] : index.lookup(ip);
  const category = label ? 'special'
    : matches.some(m => m.kind === 'crawler') ? 'crawler'
      : matches.some(m => m.kind === 'service') ? 'service'
        : matches.some(m => m.kind === 'cdn') ? 'cdn'
          : matches.some(m => m.kind === 'cloud') ? 'cloud'
            : matches.some(m => m.kind === 'hosting') ? 'hosting'
              : 'unmatched';
  return { address: ip.address, version: ip.version, count: 0, category, label: label || (category === 'unmatched' ? 'No published range match' : ''), matches, errors: 0, bytes: 0 };
}

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function parseLogTime(value: unknown): number | null {
  if (typeof value === 'number') {
    const ms = value < 1e11 ? value * 1000 : value;
    return Number.isFinite(ms) && ms >= 0 && ms <= 8640000000000000 ? ms : null;
  }
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/);
  if (match) {
    const [, day, month, year, hour, minute, second, sign, offsetHour, offsetMinute] = match;
    const monthNumber = months.indexOf(month);
    if (monthNumber < 0 || +day < 1 || +hour > 23 || +minute > 59 || +second > 59 || +offsetHour > 23 || +offsetMinute > 59) return null;
    const utc = Date.UTC(+year, monthNumber, +day, +hour, +minute, +second);
    if (new Date(utc).getUTCDate() !== +day) return null;
    return utc - (sign === '+' ? 1 : -1) * (+offsetHour * 60 + +offsetMinute) * 60_000;
  }
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface LogEntry { ip: IpAddress; status: number; bytes: number; path: string; time: number | null; duration: number | null }
function cleanPath(input: string): string {
  let path = input.split(/[?#]/, 1)[0];
  if (/^https?:\/\//i.test(path)) { try { path = new URL(path).pathname; } catch { path = '(invalid target)'; } }
  return path.slice(0, 500) || '/';
}
function finiteNonnegative(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || value === '-') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1e15 ? number : null;
}

export function parseLogLine(line: string): LogEntry | null {
  let ipText: unknown, statusValue: unknown, bytesValue: unknown, path = '', timeValue: unknown, duration: number | null = null;
  if (line.startsWith('{')) {
    let entry: any;
    try { entry = JSON.parse(line); } catch { return null; }
    if (!entry || Array.isArray(entry)) return null;
    // Forwarded headers are deliberately not used as an authenticated source IP.
    ipText = entry.remote_addr ?? entry.remoteAddress ?? entry.client_ip ?? entry.ClientIP ?? entry.ip;
    statusValue = entry.status ?? entry.status_code ?? entry.EdgeResponseStatus;
    bytesValue = entry.body_bytes_sent ?? entry.bytes_sent ?? entry.bytes ?? entry.EdgeResponseBytes;
    timeValue = entry.time_iso8601 ?? entry.time_local ?? entry.timestamp ?? entry.time ?? entry['@timestamp'];
    const target = entry.uri ?? entry.path ?? entry.request_uri ?? entry.ClientRequestPath;
    if (typeof target === 'string') path = target;
    else if (typeof entry.request === 'string') path = entry.request.split(' ')[1] || '';
    duration = finiteNonnegative(entry.duration_ms ?? entry.response_time_ms);
    if (duration === null) { const seconds = finiteNonnegative(entry.request_time); if (seconds !== null) duration = seconds * 1000; }
  } else {
    const match = line.match(/^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"((?:\\.|[^"\\])*)"\s+(\d{3})\s+(\d+|-)(?:\s|$)/);
    if (!match) return null;
    [, ipText, timeValue, path, statusValue, bytesValue] = match;
    path = path.split(' ')[1] || '';
  }
  if (typeof ipText !== 'string') return null;
  const ip = parseIp(ipText), status = Number(statusValue);
  if (!ip || !Number.isInteger(status) || status < 100 || status > 599 || !path) return null;
  return { ip, status, bytes: finiteNonnegative(bytesValue) || 0, path: cleanPath(path), time: parseLogTime(timeValue), duration };
}

const MAX_TEXT = 20 * 1024 * 1024;
export const MAX_LINES = 200_000;
export const MAX_IPS = 20_000;
export function collectLookupIps(text: string, mode: TrafficMode): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > MAX_LINES + 1) throw new Error('Use a selection of up to 200,000 lines.');
  const addresses = new Set<string>();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const found = mode === 'log' ? [parseLogLine(line)?.ip].filter(Boolean) as IpAddress[] : extractIps(line);
    for (const ip of found) {
      addresses.add(ip.address);
      if (addresses.size > MAX_IPS) throw new Error('Use a selection with up to 20,000 unique IP addresses.');
    }
  }
  return [...addresses];
}
export async function analyzeTraffic(text: string, mode: TrafficMode, dataset: IpDataset, progress?: (percent: number) => void): Promise<TrafficReport> {
  if (new TextEncoder().encode(text).length > MAX_TEXT) throw new Error('Use a file or selection up to 20 MB.');
  const lines = text.split(/\r?\n/);
  if (lines.length > MAX_LINES + 1) throw new Error('Use a selection of up to 200,000 lines.');
  const index = new RangeIndex(dataset), ips = new Map<string, IpRow>(), paths = new Map<string, number>(), statuses = new Map<string, number>();
  const times: number[] = [], durations: number[] = [];
  const summary: TrafficReport['summary'] = { lines: 0, accepted: 0, skipped: 0, uniqueIps: 0, matchedIps: 0, matchedEvents: 0, errors: 0, bytes: 0, timedRequests: 0, p50: null, p95: null, first: null, last: null };
  const issues: TrafficReport['issues'] = [];
  const count = (ip: IpAddress) => {
    let row = ips.get(ip.address);
    if (!row) {
      if (ips.size >= MAX_IPS) throw new Error('Use a selection with up to 20,000 unique IP addresses.');
      row = makeIpRow(ip, index); ips.set(ip.address, row);
    }
    row.count++; summary.accepted++;
    return row;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    summary.lines++;
    if (mode === 'ip') {
      const extracted = extractIps(line);
      if (extracted.length) extracted.forEach(count);
      else { summary.skipped++; if (issues.length < 8) issues.push({ line: i + 1, reason: 'No valid IP address found' }); }
    } else {
      const entry = parseLogLine(line);
      if (!entry) { summary.skipped++; if (issues.length < 8) issues.push({ line: i + 1, reason: 'Not a supported access-log entry' }); }
      else {
        const row = count(entry.ip);
        row.bytes += entry.bytes; summary.bytes += entry.bytes;
        if (entry.status >= 400) { row.errors++; summary.errors++; }
        paths.set(entry.path, (paths.get(entry.path) || 0) + 1);
        statuses.set(String(entry.status), (statuses.get(String(entry.status)) || 0) + 1);
        if (entry.time !== null) times.push(entry.time);
        if (entry.duration !== null) durations.push(entry.duration);
      }
    }
    if (i % 2000 === 0) { progress?.(Math.round(i / lines.length * 100)); await new Promise(resolve => setTimeout(resolve, 0)); }
  }
  const ranked = (map: Map<string, number>) => [...map].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const rows = [...ips.values()].sort((a, b) => b.count - a.count || a.address.localeCompare(b.address));
  summary.uniqueIps = rows.length;
  for (const row of rows) if (row.matches.length) { summary.matchedIps++; summary.matchedEvents += row.count; }
  if (times.length) { times.sort((a, b) => a - b); summary.first = times[0]; summary.last = times.at(-1)!; }
  summary.timedRequests = durations.length;
  durations.sort((a, b) => a - b);
  if (durations.length) { summary.p50 = durations[Math.ceil(durations.length * .5) - 1]; summary.p95 = durations[Math.ceil(durations.length * .95) - 1]; }
  const spanMinutes = ((summary.last || 0) - (summary.first || 0)) / 60_000;
  const bucketMinutes = Math.max(1, Math.ceil(spanMinutes / 120));
  const buckets = new Map<string, number>();
  for (const time of times) { const bucket = new Date(Math.floor(time / (bucketMinutes * 60_000)) * bucketMinutes * 60_000).toISOString(); buckets.set(bucket, (buckets.get(bucket) || 0) + 1); }
  const timeline = [...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([label, count]) => ({ label, count }));
  progress?.(100);
  return { v: 1, kind: 'bugdays-traffic-report', mode, createdAt: new Date().toISOString(), dataset: { fetchedAt: dataset.fetchedAt, sources: dataset.sources, failures: dataset.failures }, summary, ips: rows, paths: ranked(paths), statuses: ranked(statuses), timeline, bucketMinutes, issues };
}

export function filterIpRows(report: TrafficReport, query = '', source = '', category = '', sort = 'count'): IpRow[] {
  const needle = query.trim().toLowerCase();
  const rows = report.ips.filter(row => (!source || row.matches.some(match => match.source === source)) && (!category || row.category === category || row.matches.some(match => match.kind === category)) && (!needle || [
    row.address, row.label,
    row.enrichment?.network?.asn ? `AS${row.enrichment.network.asn}` : '', row.enrichment?.network?.organization || '', row.enrichment?.network?.isp || '', row.enrichment?.network?.domain || '',
    row.enrichment?.location?.country || '', row.enrichment?.location?.countryCode || '', row.enrichment?.location?.region || '', row.enrichment?.location?.city || '', row.enrichment?.location?.timezone || '',
    ...(row.enrichment?.reverseDns || []), ...row.matches.flatMap(match => [match.source, match.service, match.region, match.cidr]),
  ].some(value => value.toLowerCase().includes(needle))));
  return rows.sort((a, b) => sort === 'errors' ? b.errors - a.errors || b.count - a.count : sort === 'address' ? a.version - b.version || (parseIp(a.address)!.value < parseIp(b.address)!.value ? -1 : parseIp(a.address)!.value > parseIp(b.address)!.value ? 1 : 0) : b.count - a.count || a.address.localeCompare(b.address));
}

export function reportShareSnapshot(report: TrafficReport, rows: IpRow[], scope = 'Current filters'): TrafficReport {
  const included = rows.slice(0, 200);
  const snapshot = { ...report, ips: included, paths: report.paths.slice(0, 50), issues: [] };
  while (included.length > 1 && new TextEncoder().encode(JSON.stringify(snapshot)).length > 850_000) included.pop();
  return { ...snapshot, shared: { includedIps: included.length, totalIps: report.summary.uniqueIps, scope: `${scope}; first ${included.length} of ${rows.length} matching IPs; top 50 paths; totals cover the full analysis` } };
}

/** Treat shared and imported reports as untrusted data, reconstructing only known fields. */
export function validateReport(input: unknown): TrafficReport {
  const obj = input as any;
  const fail = () => { throw new Error('This is not a valid Bug Days traffic report.'); };
  const str = (value: unknown, max = 500) => typeof value === 'string' && value.length <= max ? value : fail();
  const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e15 ? value : fail();
  const nullable = (value: unknown) => value === null ? null : num(value);
  const list = (value: unknown, max: number) => Array.isArray(value) && value.length <= max ? value : fail();
  if (!obj || obj.v !== 1 || obj.kind !== 'bugdays-traffic-report' || !['ip', 'log'].includes(obj.mode)) fail();
  const sources: IpSource[] = list(obj.dataset?.sources, 64).map((source: any) => {
    if (!sourceIds.has(source.id) || !['cloud', 'hosting', 'cdn', 'crawler', 'service'].includes(source.kind)) fail();
    const method = source.method === undefined ? 'official' : source.method;
    if (!['official', 'bgp'].includes(method)) fail();
    const asns = source.asns === undefined ? undefined : list(source.asns, 10).map((asn: unknown) => Number.isInteger(asn) && Number(asn) > 0 && Number(asn) <= 4294967295 ? Number(asn) : fail());
    return { id: source.id, name: str(source.name, 100), kind: source.kind, method, url: str(source.url, 1000), publishedAt: str(source.publishedAt, 100), count: num(source.count), ...(asns ? { asns } : {}) };
  });
  const summary = {} as TrafficReport['summary'];
  for (const key of ['lines', 'accepted', 'skipped', 'uniqueIps', 'matchedIps', 'matchedEvents', 'errors', 'bytes', 'timedRequests'] as const) summary[key] = num(obj.summary?.[key]);
  for (const key of ['p50', 'p95', 'first', 'last'] as const) summary[key] = nullable(obj.summary?.[key]);
  const ips: IpRow[] = list(obj.ips, MAX_IPS).map((row: any) => {
    const ip = parseIp(str(row.address, 80));
    if (!ip || !['cloud', 'hosting', 'cdn', 'crawler', 'service', 'special', 'unmatched'].includes(row.category)) return fail();
    const matches: RangeMatch[] = list(row.matches, 100).map((match: any) => {
      const source = sources.find(source => source.id === match.source);
      if (!source || !['cloud', 'hosting', 'cdn', 'crawler', 'service'].includes(match.kind) || !parseCidr(str(match.cidr, 80))) return fail();
      const method = match.method === undefined ? source.method : match.method;
      if (!['official', 'bgp'].includes(method)) return fail();
      return { source: match.source, kind: match.kind, method, cidr: match.cidr, service: str(match.service, 100), region: str(match.region, 100) };
    });
    if (['cloud', 'hosting', 'cdn', 'crawler', 'service'].includes(row.category) && !matches.some(match => match.kind === row.category)) return fail();
    const enrichment = row.enrichment === undefined ? undefined : validateIpEnrichment(row.enrichment, ip.address);
    return { address: ip.address, version: ip.version, count: num(row.count), category: row.category, label: str(row.label, 100), matches, errors: num(row.errors), bytes: num(row.bytes), ...(enrichment ? { enrichment } : {}) };
  });
  const counts = (value: unknown, max: number) => list(value, max).map((row: any) => ({ label: str(row.label), count: num(row.count) }));
  return { v: 1, kind: 'bugdays-traffic-report', mode: obj.mode, createdAt: str(obj.createdAt, 100), ...(obj.title !== undefined ? { title: str(obj.title, 120) } : {}), dataset: { fetchedAt: str(obj.dataset.fetchedAt, 100), sources, failures: list(obj.dataset.failures, 64).map((s: unknown) => str(s, 100)) }, summary, ips, paths: counts(obj.paths, MAX_LINES), statuses: counts(obj.statuses, 500), timeline: counts(obj.timeline, 200), bucketMinutes: num(obj.bucketMinutes), issues: list(obj.issues, 8).map((issue: any) => ({ line: num(issue.line), reason: str(issue.reason) })), ...(obj.shared ? { shared: { includedIps: num(obj.shared.includedIps), totalIps: num(obj.shared.totalIps), scope: str(obj.shared.scope) } } : {}) };
}

export function ipTableRows(report: TrafficReport, rows = report.ips): string[][] {
  const names = new Map(report.dataset.sources.map(source => [source.id, source.name]));
  return [[
    'IP address', 'IP version', 'Occurrences', 'Classification', 'Provider', 'Evidence', 'Published region', 'Service', 'Matched CIDR',
    'ASN', 'Network organization', 'ISP', 'Approximate country', 'Approximate region', 'Approximate city', 'Time zone', 'Reverse DNS',
    '4xx/5xx responses', 'Response bytes',
  ], ...rows.map(row => [
    row.address, String(row.version), String(row.count), row.label || row.category,
    [...new Set(row.matches.map(m => names.get(m.source) || m.source))].join('; '),
    [...new Set(row.matches.map(m => m.method === 'official' ? 'Official provider feed' : 'Current BGP origin'))].join('; '),
    [...new Set(row.matches.map(m => m.region).filter(Boolean))].join('; '), [...new Set(row.matches.map(m => m.service))].join('; '), [...new Set(row.matches.map(m => m.cidr))].join('; '),
    row.enrichment?.network?.asn ? `AS${row.enrichment.network.asn}` : '', row.enrichment?.network?.organization || '', row.enrichment?.network?.isp || '',
    row.enrichment?.location?.country || '', row.enrichment?.location?.region || '', row.enrichment?.location?.city || '', row.enrichment?.location?.timezone || '', row.enrichment?.reverseDns.join('; ') || '',
    String(row.errors), String(row.bytes),
  ])];
}

export function csvTable(rows: string[][]): string {
  return rows.map(row => row.map(value => '"' + safeSpreadsheetCell(value).replaceAll('"', '""') + '"').join(',')).join('\r\n');
}

export function safeSpreadsheetCell(value: string): string { return /^\s*[=+@-]/.test(value) || /^[\t\r]/.test(value) ? "'" + value : value; }
