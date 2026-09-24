// Feed parsing is only exercised against the live internet by the refresh script, so the parsers
// that shape provider data into ranges are covered here with stubbed responses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchIpDataset, feedDefinitions } from '../src/lib/ip-datasets.ts';

const zscalerCloud = (cloud, entries) => ({
  [cloud]: {
    'continent : EMEA': { 'city : London II': entries },
    'continent : APAC': { 'city : Chennai I': [{ range: '165.225.242.0/23' }] },
  },
});

// Every non-Zscaler feed rejects, so the dataset contains exactly what the Zscaler parser produced.
const stubFetch = async (url) => {
  const address = String(url);
  if (!address.startsWith('https://config.zscaler.com/api/')) throw new Error(`unexpected fetch: ${address}`);
  const cloud = address.split('/api/')[1].split('/')[0];
  if (cloud === 'zscalergov.net') return { ok: false, status: 503, json: async () => ({}) };
  const entries = cloud === 'zscaler.net'
    ? [{ range: '165.225.0.0/24' }, { range: 'not-a-cidr' }, { range: '165.225.0.0/24' }, {}]
    : [{ range: '147.161.128.0/24' }];
  return { ok: true, status: 200, json: async () => zscalerCloud(cloud, entries) };
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
