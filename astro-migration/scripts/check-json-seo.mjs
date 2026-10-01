import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import LZString from 'lz-string';
import { apiResponse, originalConfig, modifiedConfig } from '../src/lib/json-examples.ts';

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
  assert.equal((html.match(/<details /g) || []).length, 5);

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
      if (entry.tool === 'json-formatter') assert.deepEqual(JSON.parse(state.d.json), apiResponse);
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
