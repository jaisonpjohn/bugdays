import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import LZString from 'lz-string';
import {compareYaml} from '../src/lib/yaml-diff.ts';
const slug='compare-kubernetes-yaml-ignore-order';
for(const path of ['yaml-diff','guides/'+slug]) {
  const html=readFileSync('dist/'+path+'/index.html','utf8');
  assert.equal((html.match(/<h1\b/g)||[]).length,1);
  assert.ok(html.includes(`rel="canonical" href="https://bugdays.com/${path}/"`));
  assert.ok(html.includes('https://bugdays.com/og/yaml-diff.png'));assert.ok(html.includes('name="description"'));assert.ok(html.includes('application/ld+json'));
}
const html=readFileSync('dist/yaml-diff/index.html','utf8');
for(const id of ['yaml1','yaml2'])assert.ok(html.includes('data-share-key="'+id+'"'));
assert.ok(html.includes('data-share-action="compare"'));assert.ok(html.includes('id="share-comparison"'));
assert.ok(!html.includes('cdn.jsdelivr.net/npm/js-yaml'));assert.ok(html.includes('/guides/'+slug+'/'));
const schemas=[...html.matchAll(/<script type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs)].flatMap(match=>JSON.parse(match[1]));
assert.equal(schemas.find(schema=>schema['@type']==='FAQPage').mainEntity.length,7);
const guide=readFileSync('dist/guides/'+slug+'/index.html','utf8'), href=guide.match(/href="(\/yaml-diff\/#lz:[^"]+)"/)[1];
const state=JSON.parse(LZString.decompressFromEncodedURIComponent(href.split('#lz:')[1]));
assert.equal(compareYaml(state.d.yaml1,state.d.yaml2,state.d).changes.length,2);
for(const path of ['dist/guides/index.html','dist/guides/rss.xml','dist/sitemap-0.xml','dist/yaml-tools/index.html'])assert.ok(readFileSync(path,'utf8').includes('/guides/'+slug+'/'));
const png=readFileSync('dist/og/yaml-diff.png');assert.equal(png.readUInt32BE(16),1280);assert.equal(png.readUInt32BE(20),720);
const script=html.match(/src="(\/_astro\/yaml-diff[^" ]+\.js)"/)[1], size=gzipSync(readFileSync('dist'+script)).length;
assert.ok(size<12000,'Initial YAML UI must stay below 12 KB gzip, with parser deferred.');
console.log(`YAML Diff metadata, FAQs, legacy share keys, runnable guide, discovery, social image and JS budget passed (${size} B gzip).`);
