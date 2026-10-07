import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import LZString from 'lz-string';
import { apiResponse, originalConfig, modifiedConfig, exactJsonExample } from '../src/lib/json-examples.ts';
import { formatJson } from '../src/lib/json-formatter.ts';
import { gzipSync } from 'node:zlib';

const read = path => readFile(new URL(`../dist/${path}`, import.meta.url), 'utf8');
const entries = [
  { tool: 'json-formatter', guide: 'format-validate-json-api-response', topic: 'JSON Formatter', action: 'prettify', headings: ['Fix common invalid JSON errors', 'Syntax validation, schema validation, and exact data'], source: 'https://jqlang.org/manual/' },
  { tool: 'json-diff', guide: 'compare-json-api-responses-ignore-array-order', topic: 'JSON Diff', action: 'compare', headings: ['Ignore JSON key order', 'Compare JSON arrays with or without order'], source: 'https://www.rfc-editor.org/rfc/rfc8259' },
];
const index = await read('guides/index.html');
const rss = await read('guides/rss.xml');
const sitemap = await read('sitemap-0.xml');
const category = await read('json-tools/index.html');

for (const entry of entries) {
  const path = `/${entry.tool}/`;
  const html = await read(`${entry.tool}/index.html`);
  assert.ok(html.includes(`<link rel="canonical" href="https://bugdays.com${path}"`));
  assert.match(html, /<meta name="robots" content="index, follow[,\"]/);
  assert.ok(html.includes(entry.topic));
  for (const heading of entry.headings) assert.ok(html.includes(heading));
  for (const tag of ['name="description"', 'property="og:description"', 'name="twitter:description"']) {
    assert.ok(html.includes(`<meta ${tag} content="`), `${path}: missing ${tag}`);
  }
  const schemas = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap(match => JSON.parse(match[1]));
  assert.equal(schemas.find(schema => schema['@type'] === 'WebApplication').url, `https://bugdays.com${path}`);
  const questions = schemas.find(schema => schema['@type'] === 'FAQPage').mainEntity;
  assert.equal(questions.length, 5);
  assert.equal((html.match(/<details /g) || []).length, entry.tool === 'json-formatter' ? 6 : 5);

  const guidePath = `/guides/${entry.guide}/`;
  const guide = await read(`guides/${entry.guide}/index.html`);
  assert.ok(html.includes(`href="${guidePath}"`));
  assert.ok(category.includes(guidePath));
  assert.ok(index.includes(guidePath));
  assert.ok(rss.includes(guidePath));
  assert.ok(sitemap.includes(guidePath));
  assert.ok(guide.includes(`<link rel="canonical" href="https://bugdays.com${guidePath}"`));
  assert.ok(guide.includes('"@type":"Article"'));
  assert.ok(guide.includes('"datePublished":"2026-10-01T09:00:00-07:00"'));
  assert.ok(guide.includes('<meta property="og:type" content="article"'));
  assert.ok(guide.includes(entry.source));

  for (const page of [html, guide]) {
    const links = [...page.matchAll(new RegExp(`href="/${entry.tool}/#lz:([^\"]+)"`, 'g'))];
    assert.ok(links.length > 0, 'Missing runnable example');
    for (const [, payload] of links) {
      const state = JSON.parse(LZString.decompressFromEncodedURIComponent(payload));
      assert.equal(state.v, 1);
      assert.equal(state.t, entry.tool);
      assert.equal(state.a, entry.action);
      if (entry.tool === 'json-formatter') {
        if (state.d.json === exactJsonExample) assert.equal(state.d.indent, '4');
        else assert.deepEqual(JSON.parse(state.d.json), apiResponse);
      }
      else {
        assert.deepEqual(JSON.parse(state.d.json1), originalConfig);
        assert.deepEqual(JSON.parse(state.d.json2), modifiedConfig);
        assert.equal(state.d.ignoreKeyOrder, true);
        assert.equal(typeof state.d.ignoreArrayOrder, 'boolean');
      }
    }
  }
  console.log(`JSON SEO and runnable examples passed: ${path}, ${guidePath}`);
}
const precisionPath = '/guides/json-large-integers-duplicate-keys/';
const precision = await read('guides/json-large-integers-duplicate-keys/index.html');
for (const page of [index, rss, sitemap, await read('json-formatter/index.html')]) assert.ok(page.includes(precisionPath));
assert.ok(precision.includes(`rel="canonical" href="https://bugdays.com${precisionPath}"`));
for (const term of ['JSON.parse', '9007199254740993', 'duplicate', 'JSON Pointer', 'Share JSON']) assert.ok(precision.includes(term));
assert.ok(precision.includes('https://www.rfc-editor.org/rfc/rfc8259#section-6'));
assert.ok(precision.includes('"dateModified":"2026-10-07'));
const example = precision.match(/href="\/json-formatter\/#lz:([^\"]+)"/);
assert.ok(example);
const state = JSON.parse(LZString.decompressFromEncodedURIComponent(example[1]));
assert.equal(state.d.json, exactJsonExample); assert.equal(state.d.indent, '4');
assert.equal(formatJson(formatJson(state.d.json).text, 'compact').text, exactJsonExample);
const html = await read('json-formatter/index.html');
assert.ok(html.includes('https://bugdays.com/og/json-formatter.png'));
const png = await readFile(new URL('../dist/og/json-formatter.png', import.meta.url));
assert.equal(png.readUInt32BE(16), 1280); assert.equal(png.readUInt32BE(20), 720);
const scripts = [...html.matchAll(/<script[^>]+src="(\/_astro\/[^\"]+)"/g)];
assert.ok(scripts.length);
for (const [, path] of scripts) {
  const bytes = gzipSync(await readFile(new URL(`../dist${path}`, import.meta.url))).length;
  assert.ok(bytes < 30_000, `Initial script ${path}: ${bytes} B gzip exceeds budget`);
  console.log(`JSON initial script: ${path} (${bytes} B gzip)`);
}
console.log('Exact-number guide, original share state, relevant social art and script budgets passed.');
