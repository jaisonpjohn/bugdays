import { readFile, writeFile } from 'node:fs/promises';
import { rangeLookupKey } from '../src/lib/ip-range-database.ts';

const input = new URL('../data/ip-ranges.json', import.meta.url);
const output = process.argv[2] || '/tmp/bugdays-ip-intelligence.sql';
const dataset = JSON.parse(await readFile(input, 'utf8'));
const quote = value => `'${String(value ?? '').replaceAll("'", "''")}'`;
const lines = [
  'PRAGMA foreign_keys = ON;',
  'DELETE FROM ip_ranges;',
  'DELETE FROM ip_sources;',
  'DELETE FROM ip_meta;',
  `INSERT INTO ip_meta(key,value) VALUES('fetched_at',${quote(dataset.fetchedAt)});`,
];
for (const source of dataset.sources) lines.push(`INSERT INTO ip_sources(id,name,kind,method,url,published_at,range_count,asns_json) VALUES(${[source.id, source.name, source.kind, source.method, source.url, source.publishedAt || '', source.count, source.asns ? JSON.stringify(source.asns) : null].map(value => value === null ? 'NULL' : typeof value === 'number' ? value : quote(value)).join(',')});`);
const batchSize = 250;
for (let at = 0; at < dataset.ranges.length; at += batchSize) {
  const values = dataset.ranges.slice(at, at + batchSize).map(([cidr, source, service, region]) => `(${[rangeLookupKey(cidr), cidr, source, service, region].map(quote).join(',')})`);
  lines.push(`INSERT OR IGNORE INTO ip_ranges(lookup_key,cidr,source_id,service,region) VALUES${values.join(',')};`);
}
await writeFile(output, lines.join('\n'));
console.log(`Generated ${dataset.ranges.length.toLocaleString()} indexed ranges at ${output}.`);
