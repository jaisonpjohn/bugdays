export const fixtureDataset = {
  version: 1,
  fetchedAt: '2026-09-14T10:00:00.000Z',
  failures: [],
  sources: [
    { id: 'aws', name: 'AWS', kind: 'cloud', method: 'official', url: 'https://ip-ranges.amazonaws.com/ip-ranges.json', publishedAt: '2026-09-14', count: 3 },
    { id: 'gcp', name: 'Google Cloud', kind: 'cloud', method: 'official', url: 'https://www.gstatic.com/ipranges/cloud.json', publishedAt: '2026-09-14', count: 2 },
    { id: 'azure', name: 'Azure', kind: 'cloud', method: 'official', url: 'https://www.microsoft.com/en-us/download/details.aspx?id=56519', publishedAt: '20260914', count: 1 },
    { id: 'cloudflare', name: 'Cloudflare', kind: 'cdn', method: 'official', url: 'https://api.cloudflare.com/client/v4/ips', publishedAt: '', count: 2 },
    { id: 'googlebot', name: 'Google common crawlers', kind: 'crawler', method: 'official', url: 'https://developers.google.com/crawling/ipranges/common-crawlers.json', publishedAt: '', count: 1 },
    { id: 'digitalocean', name: 'DigitalOcean', kind: 'hosting', method: 'bgp', url: 'https://stat.ripe.net/AS14061', publishedAt: '2026-09-14T08:00:00', count: 1, asns: [14061] },
  ],
  // Synthetic ranges for deterministic tests; never used as the published dataset.
  ranges: [
    ['3.0.0.0/8', 'aws', 'AMAZON', 'GLOBAL'],
    ['3.5.140.0/24', 'aws', 'EC2', 'ap-northeast-2'],
    ['3.5.140.0/25', 'aws', 'EC2', 'ap-northeast-2'],
    ['34.80.0.0/16', 'gcp', 'Google Cloud', 'asia-east1'],
    ['2001:4860::/32', 'gcp', 'Google Cloud', 'global'],
    ['20.0.0.0/8', 'azure', 'AzureCloud', 'global'],
    ['104.16.0.0/13', 'cloudflare', 'Proxy / CDN', 'global'],
    ['2606:4700::/32', 'cloudflare', 'Proxy / CDN', 'global'],
    ['66.249.64.0/19', 'googlebot', 'Common crawler range', 'global'],
    ['143.198.0.0/16', 'digitalocean', 'BGP origin AS14061', ''],
  ],
};

export const fixtureLog = [
  '3.5.140.1 - - [14/Sep/2026:10:00:00 +0000] "GET /api/orders?token=DO_NOT_SHARE HTTP/1.1" 200 1024 "https://private.example/?secret=HIDDEN" "PRIVATE_USER_AGENT"',
  '3.5.140.1 - - [14/Sep/2026:10:00:30 +0000] "GET /missing HTTP/1.1" 404 128',
  '66.249.66.1 - - [14/Sep/2026:10:02:00 +0000] "GET /robots.txt HTTP/1.1" 200 64',
  '2606:4700::1111 - - [14/Sep/2026:10:02:30 +0000] "POST /api/orders HTTP/1.1" 503 256',
  JSON.stringify({ remote_addr: '34.80.0.1', time_iso8601: '2026-09-14T10:03:00Z', status: 201, body_bytes_sent: 512, request: 'POST /api/items?key=NEVER_SHARE HTTP/2.0', request_time: .125 }),
  JSON.stringify({ client_ip: '20.0.0.1', timestamp: '2026-09-14T12:04:00+02:00', status: 200, bytes: 50, path: '/health', duration_ms: 25 }),
  'malformed input line',
].join('\n');
