// Feed parsing is only exercised against the live internet by the refresh script, so the parsers
// that shape provider data into ranges are covered here with stubbed responses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchIpDataset, feedDefinitions } from '../src/lib/ip-datasets.ts';
import { mergeCidrs, parseCidr } from '../src/lib/ip-address.ts';

const zscalerCloud = (cloud, entries) => ({
  [cloud]: {
    'continent : EMEA': { 'city : London II': entries },
    'continent : APAC': { 'city : Chennai I': [{ range: '165.225.242.0/23' }] },
  },
});

const relayCsv = [
  '172.224.226.32/31,GB,GB-EN,London,',
  '172.224.226.34/31,GB,GB-SC,Aberdeen,',
  '172.224.226.36/31,GB,GB-EN,Oxford,',
  '104.28.28.0/26,DE,DE-BE,Berlin,',
  '2606:54c0::/35,DE,DE-BY,Munich,',
  'nonsense,GB,,,',
  '',
].join('\n');

const torList = ['171.25.193.25', '80.67.167.81', '171.25.193.25', 'not-an-ip', '2001:db8::1', ''].join('\n');

// Feeds not under test reject, so each assertion sees only what its own parser produced.
const stubFetch = async (url) => {
  const address = String(url);
  if (address.startsWith('https://config.zscaler.com/api/')) {
    const cloud = address.split('/api/')[1].split('/')[0];
    if (cloud === 'zscalergov.net') return { ok: false, status: 503, json: async () => ({}) };
    const entries = cloud === 'zscaler.net'
      ? [{ range: '165.225.0.0/24' }, { range: 'not-a-cidr' }, { range: '165.225.0.0/24' }, {}]
      : [{ range: '147.161.128.0/24' }];
    return { ok: true, status: 200, json: async () => zscalerCloud(cloud, entries) };
  }
  if (address.startsWith('https://mask-api.icloud.com/')) return { ok: true, status: 200, text: async () => relayCsv };
  if (address.startsWith('https://check.torproject.org/')) return { ok: true, status: 200, text: async () => torList };
  throw new Error(`unexpected fetch: ${address}`);
};

test('Zscaler ranges are collected across clouds, with city regions', async () => {
  const dataset = await fetchIpDataset(stubFetch);
  const source = dataset.sources.find((entry) => entry.id === 'zscaler');
  assert.ok(source, 'zscaler source present');
  assert.equal(source.kind, 'service');
  assert.equal(source.method, 'official');

  const ranges = dataset.ranges.filter((range) => range[1] === 'zscaler');
  assert.deepEqual(
    ranges.find((range) => range[0] === '165.225.0.0/24'),
    ['165.225.0.0/24', 'zscaler', 'zscaler.net', 'London II'],
    'service names the cloud, region names the city',
  );
  assert.equal(source.count, ranges.length);

  const clouds = new Set(ranges.map((range) => range[2]));
  assert.ok(clouds.has('zscaler.net') && clouds.has('zscloud.net'), 'multiple clouds contribute');
  assert.ok(!clouds.has('zscalergov.net'), 'an unavailable cloud is skipped, not fatal');
  assert.ok(ranges.every((range) => /^[0-9a-f:.]+\/\d{1,3}$/i.test(range[0])), 'malformed CIDRs dropped');

  const keys = ranges.map((range) => `${range[2]} ${range[0]}`);
  assert.equal(new Set(keys).size, keys.length, 'duplicate ranges within a cloud are dropped');
});

test('an unreachable provider is reported without losing the rest', async () => {
  const dataset = await fetchIpDataset(stubFetch);
  assert.ok(dataset.failures.length > 0, 'failed feeds are recorded');
  assert.ok(!dataset.failures.includes('Zscaler'), 'Zscaler still parsed');
  assert.equal(dataset.sources.length + dataset.failures.length, feedDefinitions.length);
});

test('iCloud Private Relay rows are merged per country', async () => {
  const dataset = await fetchIpDataset(stubFetch);
  const ranges = dataset.ranges.filter((range) => range[1] === 'icloud-private-relay');
  const gb = ranges.filter((range) => range[3] === 'GB').map((range) => range[0]).sort();
  assert.deepEqual(gb, ['172.224.226.32/30', '172.224.226.36/31'], 'adjacent /31s collapse');
  assert.ok(ranges.some((range) => range[0] === '104.28.28.0/26' && range[3] === 'DE'));
  assert.ok(ranges.some((range) => range[0] === '2606:54c0::/35' && range[3] === 'DE'), 'IPv6 kept');
  assert.ok(ranges.every((range) => range[2] === 'Private Relay egress'));
  assert.ok(ranges.every((range) => parseCidr(range[0])), 'every merged range is a valid CIDR');
});

test('Tor exits become single-address ranges, deduplicated', async () => {
  const dataset = await fetchIpDataset(stubFetch);
  const ranges = dataset.ranges.filter((range) => range[1] === 'tor-exit');
  assert.deepEqual(ranges.map((range) => range[0]).sort(), ['171.25.193.25/32', '2001:db8::1/128', '80.67.167.81/32']);
  assert.ok(ranges.every((range) => range[2] === 'Tor exit node'));
});

test('merging keeps the covered addresses identical', () => {
  const spans = (cidrs) => {
    const covered = new Set();
    for (const text of cidrs) {
      const cidr = parseCidr(text);
      for (let value = cidr.network; value < cidr.network + (1n << cidr.shift); value += 1n) covered.add(`${cidr.version}:${value}`);
    }
    return covered;
  };
  const input = ['10.0.0.0/30', '10.0.0.4/30', '10.0.1.0/32', '192.168.0.0/31', '10.0.0.2/31'];
  assert.deepEqual(spans(mergeCidrs(input)), spans(input));
  assert.deepEqual(mergeCidrs(['10.0.0.0/25', '10.0.0.128/25']), ['10.0.0.0/24']);
  // Merging must also be minimal: 256 consecutive /32s are one /24, not 256 rows.
  const singles = Array.from({ length: 256 }, (_, index) => `10.1.2.${index}/32`);
  assert.deepEqual(mergeCidrs(singles), ['10.1.2.0/24']);
  assert.deepEqual(mergeCidrs(['2001:db8::/33', '2001:db8:8000::/33']), ['2001:db8::/32']);
  assert.deepEqual(mergeCidrs(['bad', '']), []);
});

test('Starlink is published as a BGP-derived network, not a datacenter', () => {
  const starlink = feedDefinitions.find((feed) => feed.id === 'starlink');
  assert.ok(starlink, 'starlink feed present');
  assert.equal(starlink.method, 'bgp');
  assert.equal(starlink.kind, 'service');
  assert.deepEqual([...starlink.asns], [14593]);
});
