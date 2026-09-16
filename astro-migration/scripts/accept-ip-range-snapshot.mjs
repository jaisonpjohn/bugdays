import { access, rename } from 'node:fs/promises';

const candidate = new URL('../data/ip-ranges.baseline.next.json.gz', import.meta.url);
const baseline = new URL('../data/ip-ranges.baseline.json.gz', import.meta.url);
try { await access(candidate); }
catch { throw new Error('No candidate IP snapshot exists. Generate and apply the differential SQL first.'); }
await rename(candidate, baseline);
console.log('Accepted the applied IP range snapshot. Commit data/ip-ranges.baseline.json.gz with the source changes.');
