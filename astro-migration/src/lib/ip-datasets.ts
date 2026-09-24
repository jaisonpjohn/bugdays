import { mergeCidrs, parseIp } from './ip-address.ts';

export type SourceKind = 'cloud' | 'hosting' | 'cdn' | 'crawler' | 'service';
export type SourceMethod = 'official' | 'bgp';
export interface IpSource {
  id: string;
  name: string;
  kind: SourceKind;
  method: SourceMethod;
  url: string;
  publishedAt: string;
  count: number;
  asns?: number[];
}
export type IpRange = [cidr: string, source: string, service: string, region: string];
export interface IpDataset { version: 1; fetchedAt: string; sources: IpSource[]; ranges: IpRange[]; failures: string[] }

type OfficialParser = 'aws' | 'azure' | 'gcp' | 'prefixes' | 'cloudflare' | 'oracle' | 'fastly' | 'github' | 'zscaler' | 'private-relay' | 'ip-lines';
interface OfficialFeedDefinition {
  id: string;
  name: string;
  kind: SourceKind;
  method: 'official';
  url: string;
  parser: OfficialParser;
  service?: string;
}
interface BgpFeedDefinition {
  id: string;
  name: string;
  kind: 'hosting' | 'service';
  method: 'bgp';
  url: string;
  asns: readonly number[];
}
export type FeedDefinition = OfficialFeedDefinition | BgpFeedDefinition;

export const officialFeedDefinitions: readonly OfficialFeedDefinition[] = [
  { id: 'aws', name: 'AWS', kind: 'cloud', method: 'official', parser: 'aws', url: 'https://ip-ranges.amazonaws.com/ip-ranges.json' },
  { id: 'gcp', name: 'Google Cloud', kind: 'cloud', method: 'official', parser: 'gcp', url: 'https://www.gstatic.com/ipranges/cloud.json' },
  { id: 'azure', name: 'Microsoft Azure', kind: 'cloud', method: 'official', parser: 'azure', url: 'https://www.microsoft.com/en-us/download/details.aspx?id=56519' },
  { id: 'oracle', name: 'Oracle Cloud', kind: 'cloud', method: 'official', parser: 'oracle', url: 'https://docs.oracle.com/en-us/iaas/tools/public_ip_ranges.json' },
  { id: 'cloudflare', name: 'Cloudflare', kind: 'cdn', method: 'official', parser: 'cloudflare', url: 'https://api.cloudflare.com/client/v4/ips' },
  { id: 'fastly', name: 'Fastly', kind: 'cdn', method: 'official', parser: 'fastly', url: 'https://api.fastly.com/public-ip-list' },
  { id: 'github', name: 'GitHub', kind: 'service', method: 'official', parser: 'github', url: 'https://api.github.com/meta' },
  { id: 'zscaler', name: 'Zscaler', kind: 'service', method: 'official', parser: 'zscaler', url: 'https://config.zscaler.com/api/zscaler.net/cenr/json' },
  { id: 'icloud-private-relay', name: 'iCloud Private Relay', kind: 'service', method: 'official', parser: 'private-relay', service: 'Private Relay egress', url: 'https://mask-api.icloud.com/egress-ip-ranges.csv' },
  { id: 'tor-exit', name: 'Tor exit nodes', kind: 'service', method: 'official', parser: 'ip-lines', service: 'Tor exit node', url: 'https://check.torproject.org/torbulkexitlist' },
  { id: 'googlebot', name: 'Google common crawlers', kind: 'crawler', method: 'official', parser: 'prefixes', service: 'Common crawler range', url: 'https://developers.google.com/crawling/ipranges/common-crawlers.json' },
  { id: 'google-special', name: 'Google special crawlers', kind: 'crawler', method: 'official', parser: 'prefixes', service: 'Special crawler range', url: 'https://developers.google.com/crawling/ipranges/special-crawlers.json' },
  { id: 'google-fetchers', name: 'Google user-triggered fetchers', kind: 'crawler', method: 'official', parser: 'prefixes', service: 'User-triggered fetcher range', url: 'https://developers.google.com/crawling/ipranges/user-triggered-fetchers-google.json' },
  { id: 'google-agents', name: 'Google user-triggered agents', kind: 'crawler', method: 'official', parser: 'prefixes', service: 'User-triggered agent range', url: 'https://developers.google.com/crawling/ipranges/user-triggered-agents.json' },
  { id: 'bingbot', name: 'Bingbot', kind: 'crawler', method: 'official', parser: 'prefixes', service: 'Bing crawler range', url: 'https://www.bing.com/toolbox/bingbot.json' },
  { id: 'gptbot', name: 'GPTBot', kind: 'crawler', method: 'official', parser: 'prefixes', service: 'OpenAI training crawler range', url: 'https://openai.com/gptbot.json' },
  { id: 'openai-searchbot', name: 'OAI-SearchBot', kind: 'crawler', method: 'official', parser: 'prefixes', service: 'OpenAI search crawler range', url: 'https://openai.com/searchbot.json' },
  { id: 'chatgpt-user', name: 'ChatGPT-User', kind: 'crawler', method: 'official', parser: 'prefixes', service: 'ChatGPT user-triggered fetch range', url: 'https://openai.com/chatgpt-user.json' },
  { id: 'openai-adsbot', name: 'OAI-AdsBot', kind: 'crawler', method: 'official', parser: 'prefixes', service: 'OpenAI ads crawler range', url: 'https://openai.com/adsbot.json' },
] as const;

export const bgpFeedDefinitions: readonly BgpFeedDefinition[] = [
  { id: 'digitalocean', name: 'DigitalOcean', kind: 'hosting', method: 'bgp', asns: [14061], url: 'https://stat.ripe.net/AS14061' },
  { id: 'hetzner', name: 'Hetzner', kind: 'hosting', method: 'bgp', asns: [24940], url: 'https://stat.ripe.net/AS24940' },
  { id: 'ovhcloud', name: 'OVHcloud', kind: 'hosting', method: 'bgp', asns: [16276], url: 'https://stat.ripe.net/AS16276' },
  { id: 'vultr', name: 'Vultr', kind: 'hosting', method: 'bgp', asns: [20473], url: 'https://stat.ripe.net/AS20473' },
  { id: 'linode', name: 'Akamai Connected Cloud / Linode', kind: 'hosting', method: 'bgp', asns: [63949], url: 'https://stat.ripe.net/AS63949' },
  { id: 'hostinger', name: 'Hostinger', kind: 'hosting', method: 'bgp', asns: [47583], url: 'https://stat.ripe.net/AS47583' },
  { id: 'contabo', name: 'Contabo', kind: 'hosting', method: 'bgp', asns: [51167], url: 'https://stat.ripe.net/AS51167' },
  { id: 'scaleway', name: 'Scaleway', kind: 'hosting', method: 'bgp', asns: [12876], url: 'https://stat.ripe.net/AS12876' },
  { id: 'upcloud', name: 'UpCloud', kind: 'hosting', method: 'bgp', asns: [202053], url: 'https://stat.ripe.net/AS202053' },
  { id: 'ionos', name: 'IONOS', kind: 'hosting', method: 'bgp', asns: [8560], url: 'https://stat.ripe.net/AS8560' },
  { id: 'leaseweb', name: 'Leaseweb', kind: 'hosting', method: 'bgp', asns: [60781], url: 'https://stat.ripe.net/AS60781' },
  { id: 'rackspace', name: 'Rackspace', kind: 'hosting', method: 'bgp', asns: [33070], url: 'https://stat.ripe.net/AS33070' },
  // Satellite ISP rather than a datacenter: a match means consumer/enterprise access behind carrier NAT.
  { id: 'starlink', name: 'Starlink', kind: 'service', method: 'bgp', asns: [14593], url: 'https://stat.ripe.net/AS14593' },
] as const;

export const feedDefinitions: readonly FeedDefinition[] = [...officialFeedDefinitions, ...bgpFeedDefinitions];
export const sourceIds = new Set(feedDefinitions.map(feed => feed.id));

const cidrPattern = /^[0-9a-f:.]+\/\d{1,3}$/i;

async function fetchJson(fetcher: typeof fetch, name: string, url: string) {
  const response = await fetcher(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'BugDays-IP-Intelligence/1.0 (+https://bugdays.com/ip-lookup/)' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  return response.json() as Promise<any>;
}

/**
 * Zscaler publishes one Cloud Enforcement Node list per cloud; customers sit on exactly one of
 * them, so all are needed to recognise a corporate proxy egress. A cloud that is unreachable is
 * skipped rather than failing the feed, since the others remain valid evidence.
 */
const zscalerClouds = ['zscaler.net', 'zscalerone.net', 'zscalertwo.net', 'zscalerthree.net', 'zscloud.net', 'zscalerbeta.net', 'zscalergov.net', 'zscalerten.net'] as const;

async function fetchZscalerFeed(feed: OfficialFeedDefinition, fetcher: typeof fetch) {
  const ranges: IpRange[] = [];
  const seen = new Set<string>();
  const reached: string[] = [];
  const strip = (value: string) => value.split(' : ').slice(1).join(' : ').trim() || value.trim();
  for (const cloud of zscalerClouds) {
    let data: any;
    try { data = await fetchJson(fetcher, `${feed.name} ${cloud}`, `https://config.zscaler.com/api/${cloud}/cenr/json`); }
    catch { continue; }
    reached.push(cloud);
    for (const [continent, cities] of Object.entries(data?.[cloud] || {})) {
      for (const [city, entries] of Object.entries((cities || {}) as Record<string, unknown>)) {
        for (const entry of (Array.isArray(entries) ? entries : []) as Array<{ range?: unknown }>) {
          const cidr = entry?.range;
          if (typeof cidr !== 'string' || !cidrPattern.test(cidr)) continue;
          const key = `${cloud} ${cidr}`;
          if (seen.has(key)) continue;
          seen.add(key);
          ranges.push([cidr, feed.id, cloud, (strip(city) || strip(continent)).slice(0, 100)]);
        }
      }
    }
  }
  if (!ranges.length) throw new Error(`${feed.name}: empty dataset`);
  return { source: { id: feed.id, name: feed.name, kind: feed.kind, method: feed.method, url: `https://config.zscaler.com/api/{${reached.join(',')}}/cenr/json`, publishedAt: '', count: ranges.length } satisfies IpSource, ranges };
}

async function fetchText(fetcher: typeof fetch, name: string, url: string) {
  const response = await fetcher(url, {
    headers: { 'User-Agent': 'BugDays-IP-Intelligence/1.0 (+https://bugdays.com/ip-lookup/)' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  return response.text();
}

/**
 * Apple publishes one row per city, currently about 285,000 of them, mostly /31s. Merging per
 * country keeps the useful part (which country the relay exit sits in) at a twentieth of the rows.
 */
async function fetchPrivateRelayFeed(feed: OfficialFeedDefinition, fetcher: typeof fetch) {
  const text = await fetchText(fetcher, feed.name, feed.url);
  const byCountry = new Map<string, string[]>();
  for (const line of text.split('\n')) {
    const [cidr, country] = line.trim().split(',');
    if (!cidr || !cidrPattern.test(cidr)) continue;
    const key = /^[A-Z]{2}$/.test(country || '') ? country : '';
    const bucket = byCountry.get(key);
    if (bucket) bucket.push(cidr); else byCountry.set(key, [cidr]);
  }
  const ranges: IpRange[] = [];
  for (const [country, cidrs] of byCountry) for (const cidr of mergeCidrs(cidrs)) ranges.push([cidr, feed.id, feed.service || '', country]);
  if (!ranges.length) throw new Error(`${feed.name}: empty dataset`);
  return { source: { id: feed.id, name: feed.name, kind: feed.kind, method: feed.method, url: feed.url, publishedAt: '', count: ranges.length } satisfies IpSource, ranges };
}

/** Plain-text lists of bare addresses, one per line (Tor publishes exits this way). */
async function fetchIpListFeed(feed: OfficialFeedDefinition, fetcher: typeof fetch) {
  const text = await fetchText(fetcher, feed.name, feed.url);
  const ranges: IpRange[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const ip = parseIp(line.trim());
    if (!ip || ip.mapped) continue;
    const cidr = `${ip.address}/${ip.version === 4 ? 32 : 128}`;
    if (seen.has(cidr)) continue;
    seen.add(cidr);
    ranges.push([cidr, feed.id, feed.service || '', '']);
  }
  if (!ranges.length) throw new Error(`${feed.name}: empty dataset`);
  return { source: { id: feed.id, name: feed.name, kind: feed.kind, method: feed.method, url: feed.url, publishedAt: '', count: ranges.length } satisfies IpSource, ranges };
}

async function fetchOfficialFeed(feed: OfficialFeedDefinition, fetcher: typeof fetch) {
  if (feed.parser === 'zscaler') return fetchZscalerFeed(feed, fetcher);
  if (feed.parser === 'private-relay') return fetchPrivateRelayFeed(feed, fetcher);
  if (feed.parser === 'ip-lines') return fetchIpListFeed(feed, fetcher);
  let url = feed.url;
  if (feed.parser === 'azure') {
    const response = await fetcher(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`${feed.name}: HTTP ${response.status}`);
    const html = await response.text();
    const match = html.match(/https:\/\/download\.microsoft\.com\/download\/[^"\s<>]+\/ServiceTags_Public_\d+\.json/i);
    if (!match) throw new Error('Microsoft Azure download unavailable');
    url = match[0];
  }
  const data = await fetchJson(fetcher, feed.name, url);
  const ranges: IpRange[] = [];
  const add = (cidr: unknown, service = feed.service || '', region = '') => {
    if (typeof cidr === 'string' && cidrPattern.test(cidr)) ranges.push([cidr, feed.id, String(service).slice(0, 100), String(region).slice(0, 100)]);
  };
  if (feed.parser === 'aws') {
    for (const entry of [...(data.prefixes || []), ...(data.ipv6_prefixes || [])]) add(entry.ip_prefix || entry.ipv6_prefix, entry.service, entry.region);
  } else if (feed.parser === 'azure') {
    for (const entry of data.values || []) for (const prefix of entry.properties?.addressPrefixes || []) add(prefix, entry.properties.systemService || entry.name, entry.properties.region || 'global');
  } else if (feed.parser === 'gcp') {
    for (const entry of data.prefixes || []) add(entry.ipv4Prefix || entry.ipv6Prefix, entry.service || 'Google Cloud', entry.scope || 'global');
  } else if (feed.parser === 'cloudflare') {
    for (const prefix of [...(data.result?.ipv4_cidrs || []), ...(data.result?.ipv6_cidrs || [])]) add(prefix, 'Proxy / CDN', 'global');
  } else if (feed.parser === 'oracle') {
    for (const region of data.regions || []) for (const entry of [...(region.cidrs || []), ...(region.ipv6_cidrs || [])]) add(entry.cidr, (entry.tags || []).join(', ') || 'OCI', region.region);
  } else if (feed.parser === 'fastly') {
    for (const prefix of [...(data.addresses || []), ...(data.ipv6_addresses || [])]) add(prefix, 'Edge cloud / CDN', 'global');
  } else if (feed.parser === 'github') {
    for (const [service, entries] of Object.entries(data)) if (Array.isArray(entries)) for (const prefix of entries) add(prefix, service.replaceAll('_', ' '), 'global');
  } else {
    for (const entry of data.prefixes || []) add(entry.ipv4Prefix || entry.ipv6Prefix, feed.service || entry.service || 'Published crawler range', entry.scope || 'global');
  }
  if (!ranges.length) throw new Error(`${feed.name}: empty dataset`);
  const publishedAt = String(data.createDate || data.creationTime || data.last_updated_timestamp || (feed.parser === 'azure' ? url.match(/(\d{8})\.json/)?.[1] : '') || '');
  return { source: { id: feed.id, name: feed.name, kind: feed.kind, method: feed.method, url, publishedAt, count: ranges.length } satisfies IpSource, ranges };
}

async function fetchBgpFeed(feed: BgpFeedDefinition, fetcher: typeof fetch) {
  const ranges: IpRange[] = [];
  let publishedAt = '';
  for (const asn of feed.asns) {
    const apiUrl = `https://stat.ripe.net/data/ris-prefixes/data.json?resource=AS${asn}&list_prefixes=true&types=o&noise=filter`;
    const response = await fetchJson(fetcher, feed.name, apiUrl);
    if (response.status !== 'ok') throw new Error(`${feed.name}: RIPEstat lookup failed`);
    const data = response.data || {};
    publishedAt = String(data.query_time || data.latest_time || publishedAt);
    const prefixes = data.prefixes || {};
    for (const cidr of [...(prefixes.v4?.originating || []), ...(prefixes.v6?.originating || [])]) if (typeof cidr === 'string' && cidrPattern.test(cidr)) ranges.push([cidr, feed.id, `BGP origin AS${asn}`, '']);
  }
  if (!ranges.length) throw new Error(`${feed.name}: no originated prefixes`);
  return { source: { id: feed.id, name: feed.name, kind: feed.kind, method: feed.method, url: feed.url, publishedAt, count: ranges.length, asns: [...feed.asns] } satisfies IpSource, ranges };
}

export async function fetchIpDataset(fetcher: typeof fetch = fetch): Promise<IpDataset> {
  const dataset: IpDataset = { version: 1, fetchedAt: new Date().toISOString(), sources: [], ranges: [], failures: [] };
  const responses = await Promise.allSettled(feedDefinitions.map(feed => feed.method === 'bgp' ? fetchBgpFeed(feed, fetcher) : fetchOfficialFeed(feed, fetcher)));
  responses.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      dataset.sources.push(result.value.source);
      dataset.ranges.push(...result.value.ranges);
    } else dataset.failures.push(feedDefinitions[index].name);
  });
  if (!dataset.sources.length) throw new Error('Provider datasets are temporarily unavailable.');
  return dataset;
}
