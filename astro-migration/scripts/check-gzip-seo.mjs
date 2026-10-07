// Run after npm run build with Node 22.18+ (native TS loading) and Python 3.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';
import LZString from 'lz-string';
import { gzipExamples } from '../src/lib/gzip-examples.ts';

const slugs = ['decode-base64-gzip-to-json', 'gzip-base64-python-nodejs', 'fix-base64-gzip-decode-errors', 'gzip-base64-java'];
const unescape = (value) => value.replace(/&(?:amp|lt|gt|quot|apos|#39|#x27);/g, (entity) => ({
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&#x27;': "'",
}[entity]));
const readPage = (path) => readFileSync(`dist/${path}/index.html`, 'utf8');

for (const example of gzipExamples) {
  assert.equal(gunzipSync(Buffer.from(example.base64, 'base64')).toString('utf8'), example.text);
  for (const [href, action, input] of [[example.decodeHref, 'decompress', example.base64], [example.encodeHref, 'compress', example.text]]) {
    const url = new URL(href, 'https://bugdays.com');
    assert.equal(url.pathname, '/gzip-base64/');
    assert.ok(href.length < 2000, 'Published examples should stay comfortably shareable');
    const state = JSON.parse(LZString.decompressFromEncodedURIComponent(url.hash.slice(4)));
    assert.deepEqual(state, { v: 1, t: 'gzip-base64', a: action, d: { input } });
  }
}

const pages = ['gzip-base64', ...slugs.map((slug) => `guides/${slug}`)];
const seenTitles = new Set();
for (const path of pages) {
  const html = readPage(path);
  const title = unescape(html.match(/<title>(.*?)<\/title>/s)?.[1] || '');
  assert.ok(title.includes('GZip') && title.includes('Base64'), `${path}: descriptive title`);
  assert.ok(!seenTitles.has(title), `${path}: duplicate title`);
  seenTitles.add(title);
  assert.equal((html.match(/<h1\b/g) || []).length, 1, `${path}: one H1`);
  const description = html.match(/<meta name="description" content="([^"]+)"/)?.[1];
  assert.ok(description && unescape(description).length < 180, `${path}: concise description`);
  assert.ok(html.includes(`rel="canonical" href="https://bugdays.com/${path}/"`), `${path}: canonical`);
  assert.ok(html.includes('max-image-preview:large'), `${path}: social/search image preview`);
  assert.ok(html.includes('content="https://bugdays.com/og/gzip-base64.png"'), `${path}: social image`);
  const schemas = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs)].map((match) => JSON.parse(match[1]));
  assert.ok(schemas.some((schema) => schema['@type'] === (path === 'gzip-base64' ? 'WebApplication' : 'Article')), `${path}: structured data`);
  assert.ok(html.includes('#lz:'), `${path}: embedded example links`);
  assert.ok(!html.includes('#kv:'), `${path}: no expiring example links`);
  for (const [, href] of html.matchAll(/href="(\/[^"#]*)"/g)) {
    const pathname = new URL(unescape(href), 'https://bugdays.com').pathname;
    assert.ok(existsSync(`dist${pathname}`) || existsSync(`dist${pathname}/index.html`), `${path}: broken internal link ${href}`);
  }
  console.log(`SEO metadata and links: /${path}/`);
}

const recipeHtml = readPage('guides/gzip-base64-python-nodejs');
const getRecipe = (html, name) => {
  const code = html.match(new RegExp(`<code data-recipe="${name}"[^>]*>(.*?)</code>`, 's'))?.[1];
  assert.ok(code, `Missing ${name} recipe`);
  return unescape(code);
};
const pythonOutput = execFileSync('python3', ['-c', getRecipe(recipeHtml, 'python')], { encoding: 'utf8' }).trim().split('\n');
const nodeOutput = execFileSync(process.execPath, ['--input-type=module', '-e', getRecipe(recipeHtml, 'node')], { encoding: 'utf8' }).trim().split('\n');
for (const [encoded, decoded] of [pythonOutput, nodeOutput]) {
  assert.equal(decoded, gzipExamples[1].text);
  assert.equal(gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8'), decoded);
}
const pythonDecoded = execFileSync('python3', ['-c', 'import sys,base64,gzip; print(gzip.decompress(base64.b64decode(sys.argv[1], validate=True)).decode("utf-8"))', nodeOutput[0]], { encoding: 'utf8' }).trim();
assert.equal(pythonDecoded, gzipExamples[1].text, 'Python must decode the Node.js output');
const headerOutput = execFileSync('python3', ['-c', getRecipe(readPage('guides/fix-base64-gzip-decode-errors'), 'header')], { encoding: 'utf8' }).trim();
assert.equal(headerOutput, '1f 8b 08');

// Verify every rendered example's displayed data and both of its runnable links.
for (const slug of slugs) {
  const html = readPage(`guides/${slug}`);
  const base64 = unescape(html.match(/<code data-example-base64[^>]*>(.*?)<\/code>/s)?.[1] || '');
  const text = unescape(html.match(/<code data-example-text[^>]*>(.*?)<\/code>/s)?.[1] || '');
  assert.equal(gunzipSync(Buffer.from(base64, 'base64')).toString('utf8'), text);
  const links = [...html.matchAll(/href="([^"]+)" data-example-(decode|encode)/g)];
  assert.equal(links.length, 2, `${slug}: both example directions must be linked`);
  for (const [, href, action] of links) {
    const state = JSON.parse(LZString.decompressFromEncodedURIComponent(new URL(unescape(href), 'https://bugdays.com').hash.slice(4)));
    assert.equal(state.d.input, action === 'decode' ? base64 : text);
    assert.equal(state.a, action === 'decode' ? 'decompress' : 'compress');
    if (action === 'encode') assert.equal(gunzipSync(gzipSync(Buffer.from(state.d.input))).toString(), text);
  }
  assert.ok(readFileSync('dist/guides/rss.xml', 'utf8').includes(`/guides/${slug}/`), `${slug}: RSS discovery`);
  assert.ok(readFileSync('dist/sitemap-0.xml', 'utf8').includes(`/guides/${slug}/`), `${slug}: sitemap discovery`);
}
const image = readFileSync('dist/og/gzip-base64.png');
assert.deepEqual(image, readFileSync('public/og/gzip-base64.png'), 'Build must contain the current social image');
assert.equal(image.subarray(1, 4).toString(), 'PNG');
assert.equal(image.readUInt32BE(16), 1280);
assert.equal(image.readUInt32BE(20), 720);

const toolHtml = readPage('gzip-base64');
const toolSchemas = [...toolHtml.matchAll(/<script type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs)].flatMap(match => JSON.parse(match[1]));
const faq = toolSchemas.find(schema => schema['@type'] === 'FAQPage');
assert.equal(faq.mainEntity.length, 7, 'Shipped workflows need matching FAQ structured data');
for (const question of faq.mainEntity) {
  assert.ok(toolHtml.includes(question.name), `Missing visible FAQ: ${question.name}`);
  assert.ok(toolHtml.includes(question.acceptedAnswer.text), 'FAQ answer must match visible copy');
}
assert.ok(toolHtml.includes('Share example'), 'Sharing must be visible in the result workflow');
assert.ok(toolHtml.includes('Download .gz') && toolHtml.includes('Open file'), 'File workflows must be discoverable');
assert.ok(!toolHtml.includes('not file uploads'), 'Do not retain obsolete file-support claims');
const uiName = readdirSync('dist/_astro').find(name => name.startsWith('gzip-base64.astro_') && name.endsWith('.js'));
const workerName = readdirSync('dist/_astro').find(name => /^gzip\.worker-.*\.js$/.test(name));
assert.ok(uiName && workerName, 'GZip requires a separately compiled worker');
const ui = readFileSync(`dist/_astro/${uiName}`), worker = readFileSync(`dist/_astro/${workerName}`);
assert.ok(ui.toString().includes('new Worker('), 'Heavy processing must be deferred until conversion');
assert.ok(!ui.toString().includes('invalid distance too far back'), 'Pako must not enter the initial UI bundle');
assert.ok(gzipSync(ui).length < 8_000, 'Keep tool-specific initial UI under 8 KB gzip');
assert.ok(gzipSync(worker).length < 25_000, 'Keep deferred worker under 25 KB gzip');
console.log(`GZip bundle budgets: UI ${gzipSync(ui).length} B gzip; deferred worker ${gzipSync(worker).length} B gzip.`);
console.log('Passed: share fixtures, published Python/Node.js recipes, UTF-8 interop, rendered examples, RSS, sitemap, and 1280×720 social image.');
