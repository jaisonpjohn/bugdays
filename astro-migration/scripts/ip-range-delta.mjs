import { createHash } from 'node:crypto';
import { rangeLookupKey } from '../src/lib/ip-range-database.ts';

const quote = value => `'${String(value ?? '').replaceAll("'", "''")}'`;
const rangeKey = range => range.join('\0');
const sourceKey = source => JSON.stringify([
  source.id,
  source.name,
  source.kind,
  source.method,
  source.url,
  source.publishedAt || '',
  source.count,
  source.asns || null,
]);
const uniqueRanges = ranges => new Map(ranges.map(range => [rangeKey(range), range]));

function indexSources(sources, label) {
  const indexed = new Map();
  for (const source of sources || []) {
    if (!source?.id) throw new Error(`${label} contains a source without an id.`);
    if (indexed.has(source.id)) throw new Error(`${label} contains duplicate source id ${source.id}.`);
    indexed.set(source.id, source);
  }
  return indexed;
}

function validateRanges(ranges, sourceIds, label) {
  for (const range of ranges) {
    if (!Array.isArray(range) || range.length !== 4) throw new Error(`${label} contains a malformed range.`);
    if (!sourceIds.has(range[1])) throw new Error(`${label} range ${range[0]} references missing source ${range[1]}.`);
  }
}

function fingerprint(ranges) {
  return createHash('sha256').update([...ranges.keys()].sort().join('\n')).digest('hex');
}

function sourceUpsert(source) {
  const columns = [source.id, source.name, source.kind, source.method, source.url, source.publishedAt || '', source.count, source.asns ? JSON.stringify(source.asns) : null]
    .map(value => value === null ? 'NULL' : typeof value === 'number' ? value : quote(value))
    .join(',');
  return `INSERT INTO ip_sources(id,name,kind,method,url,published_at,range_count,asns_json) VALUES(${columns}) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,method=excluded.method,url=excluded.url,published_at=excluded.published_at,range_count=excluded.range_count,asns_json=excluded.asns_json;`;
}

export function buildIpRangeDelta({ dataset, baseline = { sources: [], ranges: [] }, full = false, allowLargeFullImport = false, safetyLimit = 80_000 }) {
  if (!dataset?.fetchedAt || !Array.isArray(dataset.sources) || !Array.isArray(dataset.ranges)) throw new Error('Fresh IP range data is malformed.');
  const currentSources = indexSources(dataset.sources, 'Fresh data');
  const baselineSources = indexSources(baseline.sources || [], 'Baseline');
  validateRanges(dataset.ranges, currentSources, 'Fresh data');
  validateRanges(baseline.ranges || [], baselineSources, 'Baseline');

  const currentRanges = uniqueRanges(dataset.ranges);
  const baselineRanges = uniqueRanges(baseline.ranges || []);
  const currentFingerprint = fingerprint(currentRanges);
  const baselineFingerprint = fingerprint(baselineRanges);
  const added = full
    ? [...currentRanges.values()]
    : [...currentRanges].filter(([key]) => !baselineRanges.has(key)).map(([, range]) => range);
  const removed = full
    ? []
    : [...baselineRanges].filter(([key]) => !currentRanges.has(key)).map(([, range]) => range);
  const changedSources = full
    ? [...currentSources.values()]
    : [...currentSources.values()].filter(source => sourceKey(source) !== sourceKey(baselineSources.get(source.id) || {}));
  const removedSources = full
    ? []
    : [...baselineSources.values()].filter(source => !currentSources.has(source.id));
  const removedSourceIds = new Set(removedSources.map(source => source.id));
  const directRemovals = removed.filter(range => !removedSourceIds.has(range[1]));
  const fetchedAtChanged = full || dataset.fetchedAt !== baseline.fetchedAt;
  const fingerprintChanged = full || currentFingerprint !== baselineFingerprint;

  // A full replacement is conservatively estimated as deleting and reinserting a similarly sized catalog.
  const projectedWrites = full
    ? (currentRanges.size * 2) + (currentSources.size * 2) + 4
    : added.length + removed.length + changedSources.length + removedSources.length + Number(fetchedAtChanged) + Number(fingerprintChanged);
  if (projectedWrites > safetyLimit && !(full && allowLargeFullImport)) {
    const mode = full ? 'Full import' : 'Refresh';
    const override = full ? ' Pass --allow-large-full-import only on a paid plan or when intentionally consuming that allowance.' : ' No SQL or candidate baseline was written.';
    throw new Error(`${mode} projects ${projectedWrites.toLocaleString()} D1 row writes, above the ${safetyLimit.toLocaleString()} safety limit.${override}`);
  }

  const lines = ['PRAGMA foreign_keys = ON;'];
  if (full) lines.push('DELETE FROM ip_ranges;', 'DELETE FROM ip_sources;', 'DELETE FROM ip_meta;');
  for (const source of removedSources) lines.push(`DELETE FROM ip_sources WHERE id=${quote(source.id)};`);
  for (const source of changedSources) lines.push(sourceUpsert(source));

  const batchSize = 250;
  for (let at = 0; at < directRemovals.length; at += batchSize) {
    const values = directRemovals.slice(at, at + batchSize).map(([cidr, source, service, region]) => `(${[rangeLookupKey(cidr), cidr, source, service, region].map(quote).join(',')})`);
    lines.push(`DELETE FROM ip_ranges WHERE (lookup_key,cidr,source_id,service,region) IN (VALUES${values.join(',')});`);
  }
  for (let at = 0; at < added.length; at += batchSize) {
    const values = added.slice(at, at + batchSize).map(([cidr, source, service, region]) => `(${[rangeLookupKey(cidr), cidr, source, service, region].map(quote).join(',')})`);
    lines.push(`INSERT OR IGNORE INTO ip_ranges(lookup_key,cidr,source_id,service,region) VALUES${values.join(',')};`);
  }
  if (fetchedAtChanged) lines.push(`INSERT INTO ip_meta(key,value) VALUES('fetched_at',${quote(dataset.fetchedAt)}) ON CONFLICT(key) DO UPDATE SET value=excluded.value;`);
  if (fingerprintChanged) lines.push(`INSERT INTO ip_meta(key,value) VALUES('range_fingerprint',${quote(currentFingerprint)}) ON CONFLICT(key) DO UPDATE SET value=excluded.value;`);

  return {
    sql: lines.join('\n'),
    canonicalDataset: { ...dataset, ranges: [...currentRanges.values()] },
    stats: {
      additions: added.length,
      removals: removed.length,
      changedSources: changedSources.length,
      removedSources: removedSources.length,
      projectedWrites,
      fingerprint: currentFingerprint,
    },
  };
}
