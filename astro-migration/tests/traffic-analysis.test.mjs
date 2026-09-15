import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseIp, parseCidr, extractIps, specialIpLabel } from '../src/lib/ip-address.ts';
import { RangeIndex, analyzeTraffic, parseLogLine, parseLogTime, filterIpRows, reportShareSnapshot, validateReport, ipTableRows, csvTable, safeSpreadsheetCell } from '../src/lib/traffic-analysis.ts';
import { fetchIpDataset } from '../src/lib/ip-datasets.ts';
import { fixtureDataset, fixtureLog } from './traffic-fixtures.mjs';

test('IPv4 is strict; equivalent IPv6 and mapped addresses normalize consistently', () => {
  assert.equal(parseIp('255.255.255.255').value, 4294967295n);
  for (const input of ['256.0.0.1', '1.2.3', '127.1', '012.1.1.1', '0x7f.0.0.1', '1.2.3.4.extra', '1.2.3.4/24', ':::', '1::2::3', '12345::1', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', 'fe80::1%eth0']) assert.equal(parseIp(input), null, input);
  assert.equal(parseIp('2001:0DB8:0000:0000:0001:0000:0000:0001').address, '2001:db8::1:0:0:1');
  assert.equal(parseIp('0:0:0:0:0:0:0:0').address, '::');
  assert.equal(parseIp('::1').value, 1n);
  assert.equal(parseIp('::FFFF:192.0.2.1').address, '192.0.2.1');
  assert.equal(parseIp('::ffff:c000:201').mapped, true);
  assert.equal(parseIp('ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff').value, (1n << 128n) - 1n);
});

test('CIDR masks include first and last addresses without signed-integer errors', () => {
  assert.equal(parseCidr('255.255.255.255/0').network, 0n);
  assert.equal(parseCidr('255.255.255.255/32').network, 4294967295n);
  assert.equal(parseCidr('2001:db8::1/128').network, parseIp('2001:db8::1').value);
  assert.equal(parseCidr('ffff::/0').network, 0n);
  for (const cidr of ['1.2.3.4/33', '::/129', '1.2.3.4/-1', '1.2.3.4/1.5', '1.2.3.4/24/x', '1.2.3.4/', '::/']) assert.equal(parseCidr(cidr), null);
});

test('extracts addresses from endpoint notation and prose without accepting hostnames or invalid IPs', () => {
  const found = extractIps('client=3.5.140.1:443, [2001:db8::1]:8080 "34.80.0.1" / 999.4.3.2 3.5.140.1.example.test 12:00:00 ::ffff:3.5.140.1');
  assert.deepEqual(found.map(ip => ip.address), ['3.5.140.1', '2001:db8::1', '34.80.0.1', '3.5.140.1']);
});

test('special-use address classes are not described as public cloud addresses', () => {
  for (const [ip, label] of [['10.1.2.3', 'Private network'], ['172.31.255.255', 'Private network'], ['127.0.0.1', 'Loopback'], ['100.64.0.1', 'Shared address space'], ['::1', 'Loopback'], ['fd12::1', 'Private network'], ['fe80::1', 'Link-local'], ['2001:db8::1', 'Documentation'], ['203.0.113.1', 'Documentation']]) assert.equal(specialIpLabel(parseIp(ip)), label);
  assert.equal(specialIpLabel(parseIp('172.32.0.1')), null);
});

test('matching retains distinct overlapping services and chooses the most specific duplicate service', () => {
  const index = new RangeIndex(fixtureDataset);
  const matches = index.lookup(parseIp('3.5.140.1'));
  assert.equal(matches.length, 2);
  assert.equal(matches[0].cidr, '3.5.140.0/25');
  assert.equal(matches[1].service, 'AMAZON');
  assert.equal(index.lookup(parseIp('3.5.140.255'))[0].cidr, '3.5.140.0/24');
  assert.equal(index.lookup(parseIp('4.0.0.0')).length, 0);
  assert.equal(index.lookup(parseIp('2001:4860:ffff:ffff:ffff:ffff:ffff:ffff'))[0].source, 'gcp');
  assert.equal(index.lookup(parseIp('2001:4861::')).length, 0);
});

test('bulk analysis counts repeats, normalizes mapped IPv6, and reports skipped lines', async () => {
  const report = await analyzeTraffic('3.5.140.1\n::ffff:3.5.140.1\n2606:4700::1111\n10.0.0.1\n8.8.8.8\nnot an IP\n', 'ip', fixtureDataset);
  assert.equal(report.summary.accepted, 5);
  assert.equal(report.summary.uniqueIps, 4);
  assert.equal(report.summary.matchedIps, 2);
  assert.equal(report.summary.matchedEvents, 3);
  assert.equal(report.summary.skipped, 1);
  assert.equal(report.ips[0].count, 2);
  assert.equal(report.ips.find(row => row.address === '10.0.0.1').category, 'special');
  assert.equal(report.ips.find(row => row.address === '8.8.8.8').category, 'unmatched');
});

test('common, combined, IPv6, and JSON logs retain request evidence but discard query strings', () => {
  const lines = fixtureLog.split('\n');
  assert.equal(parseLogLine(lines[0]).path, '/api/orders');
  assert.equal(parseLogLine(lines[0]).status, 200);
  assert.equal(parseLogLine(lines[3]).ip.version, 6);
  assert.equal(parseLogLine(lines[4]).duration, 125);
  assert.equal(parseLogLine(lines[5]).duration, 25);
  assert.equal(parseLogLine(lines[6]), null);
  assert.equal(parseLogLine(JSON.stringify({ remote_addr: '3.5.140.1', status: 999, path: '/' })), null);
  assert.equal(parseLogLine(JSON.stringify({ 'x-forwarded-for': '3.5.140.1', status: 200, path: '/' })), null);
  assert.equal(parseLogLine(JSON.stringify({ ip: '3.5.140.1', status: 200, path: 'https://example.test/a?q=secret#fragment' })).path, '/a');
});

test('timestamps respect UTC offsets and reject rollover dates and ambiguous local times', () => {
  assert.equal(parseLogTime('14/Sep/2026:12:00:00 +0200'), Date.parse('2026-09-14T10:00:00Z'));
  assert.equal(parseLogTime('14/Sep/2026:03:00:00 -0700'), Date.parse('2026-09-14T10:00:00Z'));
  assert.equal(parseLogTime('2026-09-14T12:00:00+02:00'), Date.parse('2026-09-14T10:00:00Z'));
  assert.equal(parseLogTime(1_789_380_000), 1_789_380_000_000);
  for (const date of ['31/Feb/2026:10:00:00 +0000', '14/Sep/2026:25:00:00 +0000', '2026-09-14 10:00:00', 'garbage']) assert.equal(parseLogTime(date), null);
});

test('log summary, status, paths, UTC buckets and percentiles agree with hand-counted fixture', async () => {
  const report = await analyzeTraffic(fixtureLog, 'log', fixtureDataset);
  assert.equal(report.summary.accepted, 6);
  assert.equal(report.summary.uniqueIps, 5);
  assert.equal(report.summary.errors, 2);
  assert.equal(report.summary.bytes, 2034);
  assert.equal(report.summary.p50, 25);
  assert.equal(report.summary.p95, 125);
  assert.equal(report.summary.timedRequests, 2);
  assert.equal(report.summary.skipped, 1);
  assert.deepEqual(report.paths[0], { label: '/api/orders', count: 2 });
  assert.equal(report.timeline.reduce((sum, row) => sum + row.count, 0), 6);
  assert.equal(report.timeline.length, 4);
  assert.equal(report.summary.first, Date.parse('2026-09-14T10:00:00Z'));
  assert.equal(report.summary.last, Date.parse('2026-09-14T10:04:00Z'));
  assert.equal(JSON.stringify(report).includes('DO_NOT_SHARE'), false);
  assert.equal(JSON.stringify(report).includes('PRIVATE_USER_AGENT'), false);
});

test('numeric address sorting, region filtering, and provider filtering compose', async () => {
  const report = await analyzeTraffic('3.5.140.10\n3.5.140.2\n34.80.0.1\n20.0.0.1\n66.249.66.1', 'ip', fixtureDataset);
  assert.deepEqual(filterIpRows(report, 'ap-northeast', 'aws', 'cloud', 'address').map(row => row.address), ['3.5.140.2', '3.5.140.10']);
  assert.equal(filterIpRows(report, '', '', 'crawler').length, 1);
});

test('shared snapshots preserve provenance, have explicit coverage and exclude raw input', async () => {
  const text = Array.from({ length: 250 }, (_, i) => `3.5.140.${i}`).join('\n');
  const report = await analyzeTraffic(text, 'ip', fixtureDataset);
  const shared = reportShareSnapshot(report, report.ips);
  assert.equal(shared.ips.length, 200);
  assert.equal(shared.summary.uniqueIps, 250);
  assert.match(shared.shared.scope, /200 of 250/);
  assert.equal(shared.dataset.fetchedAt, fixtureDataset.fetchedAt);
  assert.deepEqual(validateReport(JSON.parse(JSON.stringify(shared))), shared);
  assert.equal(new TextEncoder().encode(JSON.stringify(shared)).length < 1_000_000, true);
});

test('import validation rejects malformed counts, categories, IPs and unexpected source IDs', async () => {
  const report = await analyzeTraffic('3.5.140.1', 'ip', fixtureDataset);
  for (const mutate of [r => { r.ips[0].address = '<script>'; }, r => { r.summary.accepted = -1; }, r => { r.ips[0].matches = []; }, r => { r.dataset.sources[0].id = 'javascript:alert(1)'; }, r => { r.v = 99; }]) {
    const damaged = structuredClone(report); mutate(damaged); assert.throws(() => validateReport(damaged));
  }
  assert.throws(() => validateReport(null));
  assert.throws(() => validateReport({}));
});

test('CSV escapes quotes and spreadsheet expressions; table export includes all selected rows', async () => {
  assert.equal(csvTable([['=SUM(1,2)', 'a"b', 'line\nbreak']]), '"\'=SUM(1,2)","a""b","line\nbreak"');
  for (const cell of ['=CMD()', '+123', '-123', '@SUM(A1)', '\tformula', '   =SUM(A1)']) assert.equal(safeSpreadsheetCell(cell), "'" + cell);
  const report = await analyzeTraffic('3.5.140.1\n34.80.0.1', 'ip', fixtureDataset);
  assert.equal(ipTableRows(report).length, 3);
});

test('large inputs are bounded and 200,000 repeated addresses remain responsive', async () => {
  const started = performance.now();
  const report = await analyzeTraffic('3.5.140.1\n'.repeat(200_000), 'ip', fixtureDataset);
  assert.equal(report.summary.accepted, 200_000);
  assert.equal(report.summary.uniqueIps, 1);
  assert.ok(performance.now() - started < 20_000);
  await assert.rejects(() => analyzeTraffic('x\n'.repeat(200_001), 'ip', fixtureDataset), /200,000/);
  await assert.rejects(() => analyzeTraffic('x'.repeat(21 * 1024 * 1024), 'ip', fixtureDataset), /20 MB/);
});

test('official bundled dataset contains valid ranges from every advertised source', async () => {
  const real = JSON.parse(await readFile(new URL('../public/data/ip-ranges.json', import.meta.url), 'utf8'));
  assert.equal(real.sources.length, 5);
  assert.deepEqual(real.failures, []);
  assert.ok(real.ranges.length > 1000);
  for (const range of real.ranges) assert.ok(parseCidr(range[0]), range[0]);
  for (const source of real.sources) assert.equal(real.ranges.filter(range => range[1] === source.id).length, source.count);
  const index = new RangeIndex(real);
  assert.ok(index.lookup(parseIp('3.5.140.1')).some(match => match.source === 'aws'));
  assert.ok(index.lookup(parseIp('104.16.0.1')).some(match => match.source === 'cloudflare'));
});

test('feed refresh discovers Azure URL and reports individual source failures', async () => {
  const urls = [];
  const fakeFetch = async url => {
    urls.push(String(url));
    if (String(url).includes('details.aspx')) return new Response('<a href="https://download.microsoft.com/download/test/ServiceTags_Public_20260914.json">Download</a>');
    if (String(url).includes('download.microsoft.com')) return Response.json({ values: [{ name: 'AzureCloud', properties: { addressPrefixes: ['20.0.0.0/8'], region: 'global' } }] });
    if (String(url).includes('amazonaws')) return Response.json({ prefixes: [{ ip_prefix: '3.0.0.0/8', region: 'GLOBAL', service: 'AMAZON' }] });
    if (String(url).includes('gstatic')) return Response.json({ prefixes: [{ ipv4Prefix: '34.80.0.0/16', service: 'Google Cloud', scope: 'asia-east1' }] });
    if (String(url).includes('cloudflare')) return Response.json({ result: { ipv4_cidrs: ['104.16.0.0/13'] } });
    return new Response('Unavailable', { status: 503 });
  };
  const dataset = await fetchIpDataset(fakeFetch);
  assert.equal(dataset.sources.length, 4);
  assert.deepEqual(dataset.failures, ['Google common crawlers']);
  assert.ok(urls.some(url => url.includes('ServiceTags_Public_20260914.json')));
});
