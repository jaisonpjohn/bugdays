import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import LZString from 'lz-string';
import { compareLists } from '../src/lib/list-compare.ts';
const slug = 'compare-two-lists-find-missing-items';
for (const path of ['list-compare', `guides/${slug}`]) {
  const html = readFileSync(`dist/${path}/index.html`,'utf8');
  assert.equal((html.match(/<h1\b/g)||[]).length,1); assert.ok(html.includes(`rel="canonical" href="https://bugdays.com/${path}/"`));
  assert.ok(html.includes('name="description"')); assert.ok(html.includes('https://bugdays.com/og/list-compare.png'));
  assert.ok(html.includes('application/ld+json'));
}
const tool = readFileSync('dist/list-compare/index.html','utf8');
assert.ok(tool.includes('data-share-key="setA"')); assert.ok(tool.includes('data-share-key="setB"'));
assert.equal((tool.match(/<summary\b/g)||[]).length,7); // Six FAQs plus the matching/import options panel.
for (const action of ['intersection','diffAB','diffBA','union','symmetric']) assert.ok(tool.includes(`data-share-action="${action}"`));
assert.ok(tool.includes(`/guides/${slug}/`)); assert.ok(tool.includes('id="share-comparison"'));
const guide = readFileSync(`dist/guides/${slug}/index.html`,'utf8');
const href = guide.match(/href="(\/list-compare\/#lz:[^"]+)"/)[1];
const state = JSON.parse(LZString.decompressFromEncodedURIComponent(href.split('#lz:')[1]));
assert.deepEqual(compareLists(state.d.setA,state.d.setB).results[state.a], ['SKU-100','SKU-102']);
for (const path of ['dist/guides/index.html','dist/guides/rss.xml','dist/sitemap-0.xml','dist/text-tools/index.html']) assert.ok(readFileSync(path,'utf8').includes(`/guides/${slug}/`));
const png = readFileSync('dist/og/list-compare.png'); assert.equal(png.readUInt32BE(16),1280); assert.equal(png.readUInt32BE(20),720);
const script = tool.match(/src="(\/_astro\/list-compare[^" ]+\.js)"/)[1];
const size = gzipSync(readFileSync('dist'+script)).length; assert.ok(size < 10_000);
console.log(`List Compare metadata, FAQ, old share API, guide example/discovery, social image and JS budget passed (${size} B gzip).`);
