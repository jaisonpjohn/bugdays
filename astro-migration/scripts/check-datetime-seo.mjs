import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import LZString from 'lz-string';
import { formatsForInstant } from '../src/lib/datetime.ts';
const slug = 'epoch-iso8601-timezone-offset';
for (const path of ['datetime-converter', `guides/${slug}`]) {
  const html = readFileSync(`dist/${path}/index.html`, 'utf8');
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.ok(html.includes(`rel="canonical" href="https://bugdays.com/${path}/"`));
  assert.ok(html.includes('name="description"')); assert.ok(html.includes('https://bugdays.com/og/datetime-converter.png'));
  assert.ok(html.includes('application/ld+json')); assert.ok(html.includes('ISO 8601'));
}
const tool = readFileSync('dist/datetime-converter/index.html', 'utf8');
const schema = [...tool.matchAll(/<script type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs)].flatMap(match => JSON.parse(match[1]));
const faqs = schema.find(s => s['@type'] === 'FAQPage').mainEntity;
assert.equal(faqs.length, 5);
assert.equal((tool.match(/<summary\b/g) || []).length, faqs.length);
assert.ok(tool.includes(`/guides/${slug}/`)); assert.ok(tool.includes('id="share-time-btn"'));
const guide = readFileSync(`dist/guides/${slug}/index.html`, 'utf8');
const link = guide.match(/href="(\/datetime-converter\/#lz:[^"]+)"/)[1];
const state = JSON.parse(LZString.decompressFromEncodedURIComponent(link.split('#lz:')[1]));
assert.equal(formatsForInstant(Number(state.d.unixMs), state.d.timezone).iso8601, '2024-01-01T05:30:00.000+05:30');
for (const path of ['dist/guides/index.html', 'dist/guides/rss.xml', 'dist/sitemap-0.xml', 'dist/converter-tools/index.html']) assert.ok(readFileSync(path, 'utf8').includes(`/guides/${slug}/`));
const png = readFileSync('dist/og/datetime-converter.png'); assert.equal(png.subarray(1, 4).toString(), 'PNG'); assert.equal(png.readUInt32BE(16), 1280); assert.equal(png.readUInt32BE(20), 720);
const pageScript = tool.match(/src="(\/_astro\/datetime-converter[^" ]+\.js)"/)[1];
const size = gzipSync(readFileSync('dist' + pageScript)).length; assert.ok(size < 10_000, `Datetime page script: ${size} B gzip`);
console.log(`DateTime metadata, visible FAQs, runnable share, guide discovery, social art and script budget passed (${size} B gzip).`);
