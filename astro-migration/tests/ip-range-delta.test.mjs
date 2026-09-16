import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { buildIpRangeDelta } from '../scripts/ip-range-delta.mjs';
import { rangeLookupKey } from '../src/lib/ip-range-database.ts';

const source = (overrides = {}) => ({
  id: 'example',
  name: 'Example Cloud',
  kind: 'cloud',
  method: 'official',
  url: 'https://example.com/ranges.json',
  publishedAt: '2026-09-14',
  count: 2,
  ...overrides,
});
const dataset = (ranges, overrides = {}) => ({
  fetchedAt: '2026-09-15T00:00:00.000Z',
  sources: [source({ count: ranges.length })],
  ranges,
  ...overrides,
});

test('an unchanged snapshot produces no D1 writes', () => {
  const current = dataset([
    ['192.0.2.0/24', 'example', 'compute', 'us-test-1'],
    ['2001:db8::/32', 'example', 'compute', 'us-test-1'],
  ]);
  const result = buildIpRangeDelta({ dataset: current, baseline: structuredClone(current) });

  assert.equal(result.stats.projectedWrites, 0);
  assert.equal(result.stats.additions, 0);
  assert.equal(result.stats.removals, 0);
  assert.equal(result.sql, 'PRAGMA foreign_keys = ON;');
});

test('a delta adds and removes exact range records in SQLite', () => {
  const oldRange = ['192.0.2.0/24', 'example', 'compute', 'us-test-1'];
  const keptRange = ['198.51.100.0/24', 'example', 'compute', 'us-test-1'];
  const newRange = ['203.0.113.0/24', 'example', 'storage', 'eu-test-1'];
  const baseline = dataset([oldRange, keptRange]);
  const current = dataset([keptRange, newRange], { fetchedAt: '2026-09-16T00:00:00.000Z' });
  const result = buildIpRangeDelta({ dataset: current, baseline });
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE ip_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE ip_sources(id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, method TEXT NOT NULL, url TEXT NOT NULL, published_at TEXT NOT NULL, range_count INTEGER NOT NULL, asns_json TEXT) WITHOUT ROWID;
    CREATE TABLE ip_ranges(lookup_key TEXT NOT NULL, cidr TEXT NOT NULL, source_id TEXT NOT NULL, service TEXT NOT NULL, region TEXT NOT NULL, PRIMARY KEY(lookup_key,cidr,source_id,service,region), FOREIGN KEY(source_id) REFERENCES ip_sources(id) ON DELETE CASCADE) WITHOUT ROWID;
  `);
  const insertSource = db.prepare('INSERT INTO ip_sources VALUES(?,?,?,?,?,?,?,?)');
  insertSource.run('example', 'Example Cloud', 'cloud', 'official', 'https://example.com/ranges.json', '2026-09-14', 2, null);
  const insertRange = db.prepare('INSERT INTO ip_ranges VALUES(?,?,?,?,?)');
  for (const [cidr, sourceId, service, region] of baseline.ranges) insertRange.run(rangeLookupKey(cidr), cidr, sourceId, service, region);

  db.exec(result.sql);
  const rows = db.prepare('SELECT cidr, service, region FROM ip_ranges ORDER BY cidr').all().map(row => ({ ...row }));
  assert.deepEqual(rows, [
    { cidr: '198.51.100.0/24', service: 'compute', region: 'us-test-1' },
    { cidr: '203.0.113.0/24', service: 'storage', region: 'eu-test-1' },
  ]);
  assert.equal(result.stats.additions, 1);
  assert.equal(result.stats.removals, 1);
});

test('the safety limit rejects a large delta before SQL is returned', () => {
  const baseline = dataset([]);
  const current = dataset([
    ['192.0.2.0/24', 'example', '', ''],
    ['198.51.100.0/24', 'example', '', ''],
  ], { fetchedAt: '2026-09-16T00:00:00.000Z' });

  assert.throws(
    () => buildIpRangeDelta({ dataset: current, baseline, safetyLimit: 2 }),
    /above the 2 safety limit/,
  );
});

test('full replacement requires an explicit large-import override', () => {
  const current = dataset([['192.0.2.0/24', 'example', '', '']]);
  assert.throws(
    () => buildIpRangeDelta({ dataset: current, full: true, safetyLimit: 1 }),
    /allow-large-full-import/,
  );
  assert.doesNotThrow(() => buildIpRangeDelta({ dataset: current, full: true, safetyLimit: 1, allowLargeFullImport: true }));
});
