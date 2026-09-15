export type SourceKind = 'cloud' | 'cdn' | 'crawler';
export interface IpSource { id: string; name: string; kind: SourceKind; url: string; publishedAt: string; count: number }
export type IpRange = [cidr: string, source: string, service: string, region: string];
export interface IpDataset { version: 1; fetchedAt: string; sources: IpSource[]; ranges: IpRange[]; failures: string[] }

export const feedDefinitions = [
  { id: 'aws', name: 'AWS', kind: 'cloud', url: 'https://ip-ranges.amazonaws.com/ip-ranges.json' },
  { id: 'gcp', name: 'Google Cloud', kind: 'cloud', url: 'https://www.gstatic.com/ipranges/cloud.json' },
  { id: 'azure', name: 'Azure', kind: 'cloud', url: 'https://www.microsoft.com/en-us/download/details.aspx?id=56519' },
  { id: 'cloudflare', name: 'Cloudflare', kind: 'cdn', url: 'https://api.cloudflare.com/client/v4/ips' },
  { id: 'googlebot', name: 'Google common crawlers', kind: 'crawler', url: 'https://developers.google.com/crawling/ipranges/common-crawlers.json' },
] as const;

export async function fetchIpDataset(fetcher: typeof fetch = fetch): Promise<IpDataset> {
  const dataset: IpDataset = { version: 1, fetchedAt: new Date().toISOString(), sources: [], ranges: [], failures: [] };
  const responses = await Promise.allSettled(feedDefinitions.map(async feed => {
    const get = async (url: string) => {
      const response = await fetcher(url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`${feed.name}: HTTP ${response.status}`);
      return response;
    };
    let url: string = feed.url;
    if (feed.id === 'azure') {
      const html = await (await get(url)).text();
      const match = html.match(/https:\/\/download\.microsoft\.com\/download\/[^"\s<>]+\/ServiceTags_Public_\d+\.json/i);
      if (!match) throw new Error('Azure download unavailable');
      url = match[0];
    }
    const data = await (await get(url)).json() as any;
    const ranges: IpRange[] = [];
    const add = (cidr: unknown, service = '', region = '') => {
      if (typeof cidr === 'string' && cidr.includes('/')) ranges.push([cidr, feed.id, String(service).slice(0, 100), String(region).slice(0, 100)]);
    };
    if (feed.id === 'aws') {
      for (const entry of [...(data.prefixes || []), ...(data.ipv6_prefixes || [])]) add(entry.ip_prefix || entry.ipv6_prefix, entry.service, entry.region);
    } else if (feed.id === 'azure') {
      for (const entry of data.values || []) for (const prefix of entry.properties?.addressPrefixes || []) add(prefix, entry.properties.systemService || entry.name, entry.properties.region || 'global');
    } else if (feed.id === 'cloudflare') {
      for (const prefix of [...(data.result?.ipv4_cidrs || []), ...(data.result?.ipv6_cidrs || [])]) add(prefix, 'Proxy / CDN', 'global');
    } else {
      for (const entry of data.prefixes || []) add(entry.ipv4Prefix || entry.ipv6Prefix, entry.service || (feed.kind === 'crawler' ? 'Common crawler range' : ''), entry.scope || 'global');
    }
    if (!ranges.length) throw new Error(`${feed.name}: empty dataset`);
    const publishedAt = String(data.createDate || data.creationTime || (feed.id === 'azure' ? url.match(/(\d{8})\.json/)?.[1] : '') || '');
    return { source: { ...feed, url, publishedAt, count: ranges.length }, ranges };
  }));
  responses.forEach((result, index) => {
    if (result.status === 'fulfilled') { dataset.sources.push(result.value.source); for (const range of result.value.ranges) dataset.ranges.push(range); }
    else dataset.failures.push(feedDefinitions[index].name);
  });
  if (!dataset.sources.length) throw new Error('Provider datasets are temporarily unavailable.');
  return dataset;
}
