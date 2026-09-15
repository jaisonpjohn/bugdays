import { mkdir, writeFile, rename } from 'node:fs/promises';
import { fetchIpDataset } from '../src/lib/ip-datasets.ts';
import { parseCidr } from '../src/lib/ip-address.ts';

const dataset = await fetchIpDataset();
if (dataset.failures.length) throw new Error(`Keeping the existing snapshot: unavailable sources: ${dataset.failures.join(', ')}`);
for (const range of dataset.ranges) if (!parseCidr(range[0])) throw new Error(`Invalid CIDR from ${range[1]}: ${range[0]}`);
const directory = new URL('../data/', import.meta.url);
await mkdir(directory, { recursive: true });
const temporary = new URL('ip-ranges.json.tmp', directory);
await writeFile(temporary, JSON.stringify(dataset));
await rename(temporary, new URL('ip-ranges.json', directory));
console.log(`Saved ${dataset.ranges.length.toLocaleString()} ranges from ${dataset.sources.length} sources.`);
