import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { onRequestPost } from '../functions/api/ip-enrich.ts';
import { reverseDnsName, validateIpEnrichment } from '../src/lib/ip-enrichment.ts';

const originalFetch = globalThis.fetch;
const originalCaches = globalThis.caches;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalCaches === undefined) delete globalThis.caches;
  else globalThis.caches = originalCaches;
});

const invoke = async (body, env = {}) => onRequestPost({
  request: new Request('https://bugdays.com/api/ip-enrich', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  env,
});

test('public IP enrichment normalizes ISP, ASN, location, security, and PTR data', async () => {
  const requested = [];
  globalThis.fetch = async input => {
    const url = String(input); requested.push(url);
    if (url.startsWith('https://ipwho.is/')) return Response.json({
      ip: '8.8.8.8', success: true, continent: 'North America', continent_code: 'NA', country: 'United States', country_code: 'US',
      region: 'California', region_code: 'CA', city: 'San Jose', postal: '95025', latitude: 37.33, longitude: -121.89,
      flag: { emoji: '🇺🇸', img: 'https://untrusted.example/flag.svg' },
      connection: { asn: 15169, org: 'Google LLC', isp: 'Google LLC', domain: 'google.com' },
      timezone: { id: 'America/Los_Angeles', utc: '-07:00', current_time: 'not retained' },
      security: { hosting: true, vpn: false, extra: 'discard me' }, extra: 'discard me',
    });
    if (url.startsWith('https://cloudflare-dns.com/')) return Response.json({ Status: 0, Answer: [
      { type: 12, data: 'dns.google.' }, { type: 1, data: '192.0.2.1' }, { type: 12, data: '<script>' },
    ] });
    throw new Error(`Unexpected request: ${url}`);
  };

  const response = await invoke({ ip: '8.8.8.8' });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.network.asn, 15169);
  assert.equal(result.network.organization, 'Google LLC');
  assert.equal(result.location.city, 'San Jose');
  assert.equal(result.location.timezone, 'America/Los_Angeles');
  assert.deepEqual(result.reverseDns, ['dns.google']);
  assert.deepEqual(result.security, { vpn: false, hosting: true });
  assert.deepEqual(result.sources, ['ipwhois', 'cloudflare-dns']);
  assert.equal(result.extra, undefined);
  assert.equal(result.location.flagImage, undefined);
  assert.equal(requested.length, 2);
});

test('special-use addresses never leave Bug Days', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('should not fetch'); };
  const response = await invoke({ ip: '10.0.0.24' });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.match(result.specialUse, /Private/);
  assert.deepEqual(result.sources, []);
  assert.equal(calls, 0);
});

test('an upstream limit returns useful partial data instead of failing the lookup', async () => {
  globalThis.fetch = async input => String(input).includes('ipwho')
    ? new Response('limited', { status: 429 })
    : Response.json({ Status: 3 });
  const response = await invoke({ ip: '1.1.1.1' });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(result.sources, ['cloudflare-dns']);
  assert.match(result.warnings.join(' '), /service limit/);
});

test('requests and imported enrichment are strictly validated', async () => {
  assert.equal((await invoke({ ip: 'not-an-ip' })).status, 400);
  assert.equal(reverseDnsName('8.8.4.4'), '4.4.8.8.in-addr.arpa');
  assert.equal(reverseDnsName('2001:db8::1'), '1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa');
  assert.throws(() => validateIpEnrichment({ version: 1, ip: '8.8.8.8', lookedUpAt: 'now', reverseDns: [], sources: ['evil'], warnings: [] }, '8.8.8.8'));
});

test('a configured paid key uses the pro endpoint without returning the key', async () => {
  const urls = [];
  globalThis.fetch = async input => {
    const url = String(input); urls.push(url);
    return url.includes('cloudflare-dns') ? Response.json({ Status: 3 }) : Response.json({ ip: '8.8.8.8', success: true, connection: { asn: 15169 } });
  };
  const response = await invoke({ ip: '8.8.8.8' }, { IPWHOIS_API_KEY: 'private-test-key' });
  const text = await response.text();
  assert.ok(urls.some(url => url.startsWith('https://ipwhois.pro/8.8.8.8?key=private-test-key')));
  assert.ok(!text.includes('private-test-key'));
});

test('edge caching reuses normalized public results without another upstream lookup', async () => {
  const stored = new Map();
  globalThis.caches = { default: {
    async match(request) { return stored.get(request.url)?.clone(); },
    async put(request, response) { stored.set(request.url, response.clone()); },
  } };
  let calls = 0;
  globalThis.fetch = async input => {
    calls++;
    return String(input).includes('cloudflare-dns')
      ? Response.json({ Status: 0, Answer: [{ type: 12, data: 'one.one.one.one.' }] })
      : Response.json({ ip: '1.1.1.1', success: true, country: 'Australia', connection: { asn: 13335, org: 'Cloudflare, Inc.' } });
  };

  const first = await invoke({ ip: '1.1.1.1' });
  const second = await invoke({ ip: '1.1.1.1' });
  assert.equal(first.headers.get('X-BugDays-Cache'), 'MISS');
  assert.equal(second.headers.get('X-BugDays-Cache'), 'HIT');
  assert.equal(calls, 2);
  assert.equal((await second.json()).network.asn, 13335);
});
