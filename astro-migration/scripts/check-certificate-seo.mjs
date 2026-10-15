import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import LZString from 'lz-string';
import { parseCertificateInput } from '../src/lib/certificate-inspector.ts';
import { certificateMatchesIdentity } from '../src/lib/tls-certificate-check.ts';
import { inspectCertificate } from '../src/lib/certificate-inspector.ts';

const slug = 'pem-vs-der-vs-cer-vs-p7b-certificate-formats';
for (const path of ['certificate-inspector', 'guides/' + slug, 'guides/check-tls-certificate-chain-any-port']) {
  const html = readFileSync('dist/' + path + '/index.html', 'utf8');
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.ok(html.includes(`rel="canonical" href="https://bugdays.com/${path}/"`));
  assert.ok(html.includes('name="description"'));
  assert.ok(html.includes('application/ld+json'));
}
const html = readFileSync('dist/certificate-inspector/index.html', 'utf8');
assert.ok(html.includes('data-share-key="certificate"'));
assert.ok(html.includes('data-share-action="inspect"'));
assert.ok(html.includes('id="share-certificate-report"'));
assert.ok(html.includes('/guides/' + slug + '/'));
const schemas = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs)].flatMap(match => JSON.parse(match[1]));
const app = schemas.find(schema => schema['@type'] === 'WebApplication');
assert.equal(app.url, 'https://bugdays.com/certificate-inspector/');
for (const question of schemas.find(schema => schema['@type'] === 'FAQPage').mainEntity) {
  assert.ok(html.includes(question.name));
  assert.ok(html.includes(question.acceptedAnswer.text));
}
const guide = readFileSync('dist/guides/' + slug + '/index.html', 'utf8');
const href = guide.match(/href="(\/certificate-inspector\/#lz:[^"]+)"/)[1];
const state = JSON.parse(LZString.decompressFromEncodedURIComponent(href.split('#lz:')[1]));
assert.equal(state.t, 'certificate-inspector');
assert.equal(state.d.mode, 'file');
const report = await inspectCertificate(parseCertificateInput(state.d.certificate).certificates[0]);
assert.equal(certificateMatchesIdentity(report, state.d.identity).matches, true);
for (const path of ['dist/guides/index.html', 'dist/guides/rss.xml', 'dist/sitemap-0.xml']) assert.ok(readFileSync(path, 'utf8').includes('/guides/' + slug + '/'));
const png = readFileSync('dist/og/certificate-checker-v2.png');
assert.equal(png.readUInt32BE(16), 1280); assert.equal(png.readUInt32BE(20), 720);
const script = html.match(/src="(\/_astro\/certificate-inspector\.astro[^" ]+\.js)"/)[1];
const initial = readFileSync('dist' + script, 'utf8'), size = gzipSync(initial).length;
assert.ok(size < 14000, 'Certificate UI should keep its X.509 parser deferred.');
assert.ok(initial.includes('import('));
console.log(`Certificate metadata, visible FAQs, stable share keys, runnable guide, discovery, social image and initial JS budget passed (${size} B gzip).`);
