import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { buildIpRangeDelta } from './ip-range-delta.mjs';

const input = new URL('../data/ip-ranges.json', import.meta.url);
const baselinePath = new URL('../data/ip-ranges.baseline.json.gz', import.meta.url);
const candidatePath = new URL('../data/ip-ranges.baseline.next.json.gz', import.meta.url);
const full = process.argv.includes('--full');
const allowLargeFullImport = process.argv.includes('--allow-large-full-import');
const outputArgument = process.argv.find(value => value.endsWith('.sql'));
const output = outputArgument || `/tmp/bugdays-ip-intelligence-${full ? 'full' : 'delta'}.sql`;
const dataset = JSON.parse(await readFile(input, 'utf8'));
let baseline = { sources: [], ranges: [] };
if (!full) {
  try { baseline = JSON.parse(gunzipSync(await readFile(baselinePath)).toString('utf8')); }
  catch { throw new Error('Missing data/ip-ranges.baseline.json.gz. A differential refresh cannot safely continue.'); }
}
const result = buildIpRangeDelta({ dataset, baseline, full, allowLargeFullImport });
await writeFile(output, result.sql);
if (!full) await writeFile(candidatePath, gzipSync(JSON.stringify(result.canonicalDataset), { level: 9 }));
const { additions, removals, changedSources, removedSources, projectedWrites } = result.stats;
console.log(`Generated ${full ? 'full' : 'differential'} SQL at ${output}: ${additions.toLocaleString()} additions, ${removals.toLocaleString()} removals, ${changedSources} changed sources, ${removedSources} removed sources, about ${projectedWrites.toLocaleString()} D1 row writes.`);
if (!full) console.log('After the remote SQL succeeds, run npm run accept:ip-database-snapshot and commit the updated baseline.');
