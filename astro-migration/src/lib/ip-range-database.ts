import { parseCidr, parseIp } from './ip-address.ts';
import type { IpDataset, IpRange, IpSource } from './ip-datasets.ts';

const hexWidth = (version: 4 | 6) => version === 4 ? 8 : 32;

function networkHex(value: bigint, bits: number, prefix: number, width: number) {
  const shift = BigInt(bits - prefix);
  return ((value >> shift) << shift).toString(16).padStart(width, '0');
}

export function rangeLookupKey(cidr: string): string {
  const parsed = parseCidr(cidr);
  if (!parsed) throw new Error(`Invalid CIDR: ${cidr}`);
  return `${parsed.version}:${String(parsed.prefix).padStart(3, '0')}:${parsed.network.toString(16).padStart(hexWidth(parsed.version), '0')}`;
}

/** Keys for every possible containing prefix. D1 can find longest and overlapping matches with one indexed IN query. */
export function addressLookupKeys(address: string): string[] {
  const parsed = parseIp(address);
  if (!parsed) return [];
  const bits = parsed.version === 4 ? 32 : 128;
  const width = hexWidth(parsed.version);
  return Array.from({ length: bits + 1 }, (_, prefix) => `${parsed.version}:${String(prefix).padStart(3, '0')}:${networkHex(parsed.value, bits, prefix, width)}`);
}

export interface IpRangeRow {
  lookup_key?: string;
  cidr: string;
  source_id: string;
  service: string;
  region: string;
}

export interface IpSourceRow {
  id: string;
  name: string;
  kind: IpSource['kind'];
  method: IpSource['method'];
  url: string;
  published_at: string;
  range_count: number;
  asns_json: string | null;
}

export function datasetFromRows(fetchedAt: string, sourceRows: IpSourceRow[], rangeRows: IpRangeRow[], failures: string[] = []): IpDataset {
  const seen = new Set<string>();
  const ranges: IpRange[] = [];
  for (const row of rangeRows) {
    const key = `${row.cidr}\0${row.source_id}\0${row.service}\0${row.region}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ranges.push([row.cidr, row.source_id, row.service || '', row.region || '']);
  }
  const used = new Set(ranges.map(range => range[1]));
  const sources: IpSource[] = sourceRows.filter(source => used.has(source.id)).map(source => ({
    id: source.id,
    name: source.name,
    kind: source.kind,
    method: source.method,
    url: source.url,
    publishedAt: source.published_at || '',
    count: source.range_count,
    ...(source.asns_json ? { asns: JSON.parse(source.asns_json) as number[] } : {}),
  }));
  return { version: 1, fetchedAt, sources, ranges, failures };
}

export function mergeIpDatasets(datasets: IpDataset[]): IpDataset {
  const sourceMap = new Map<string, IpSource>();
  const rangeMap = new Map<string, IpRange>();
  const failures = new Set<string>();
  let fetchedAt = '';
  for (const dataset of datasets) {
    if (!fetchedAt || Date.parse(dataset.fetchedAt) > Date.parse(fetchedAt)) fetchedAt = dataset.fetchedAt;
    for (const source of dataset.sources) sourceMap.set(source.id, source);
    for (const range of dataset.ranges) rangeMap.set(range.join('\0'), range);
    for (const failure of dataset.failures) failures.add(failure);
  }
  return { version: 1, fetchedAt: fetchedAt || new Date().toISOString(), sources: [...sourceMap.values()], ranges: [...rangeMap.values()], failures: [...failures] };
}
