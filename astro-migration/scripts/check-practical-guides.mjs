// Fresh build required. Java snippet checks require JDK 9+ (compiled for Java 8).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { gzipSync, gunzipSync } from 'node:zlib';
import LZString from 'lz-string';
import { guides } from '../src/lib/guides.ts';
import { gzipExamples } from '../src/lib/gzip-examples.ts';
import { kafkaExampleHref, kafkaFindings, accessLogExampleReport, accessLogExampleHref } from '../src/lib/guide-examples.ts';
import { validateReport } from '../src/lib/traffic-analysis.ts';

const slugs = ['gzip-base64-java', 'base64-utf8-base64url-file-decoder', 'reset-kafka-consumer-group-offsets', 'diagnose-kafka-consumer-lag-stuck-partition', 'check-tls-certificate-chain-any-port', 'identify-cloud-hosting-ips-in-access-logs'];
const unescape = value => value.replace(/&(?:amp|lt|gt|quot|apos|#39|#x27);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&#x27;': "'" })[entity]);
const htmlFor = slug => readFileSync(`dist/guides/${slug}/index.html`, 'utf8');
const recipe = (slug, name) => {
  const match = htmlFor(slug).match(new RegExp(`<code data-recipe="${name}"[^>]*>(.*?)</code>`, 's'));
  assert.ok(match, `Rendered recipe ${name}`);
  return unescape(match[1]);
};
const decodeLink = href => JSON.parse(LZString.decompressFromEncodedURIComponent(new URL(href, 'https://bugdays.com').hash.slice(4)));
for (const slug of slugs) {
  const guide = guides.find(item => item.slug === slug);
  const html = htmlFor(slug);
  assert.equal((html.match(/<h1\b/g) || []).length, 1, `${slug}: one H1`);
  assert.ok(guide.description.length >= 100 && guide.description.length <= 180, `${slug}: concise useful description`);
  assert.ok(html.includes(`rel="canonical" href="https://bugdays.com/guides/${slug}/"`));
  assert.ok(html.includes(`content="https://bugdays.com${guide.image}"`), `${slug}: topic social image`);
  assert.notEqual(guide.image, '/og-image.png');
  const png = readFileSync(`dist${guide.image}`);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 1280);
  assert.equal(png.readUInt32BE(20), 720);
  const schema = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs)].flatMap(match => JSON.parse(match[1])).find(item => item['@type'] === 'Article');
  assert.equal(schema.headline, guide.title);
  assert.ok(schema.dateModified.startsWith('2026-10-01'));
  assert.ok(schema.datePublished.startsWith(guide.published));
  for (const path of ['dist/guides/index.html', 'dist/guides/rss.xml', 'dist/sitemap-0.xml']) assert.ok(readFileSync(path, 'utf8').includes(`/guides/${slug}/`), `${slug}: discoverable in ${path}`);
}

const context = { TextEncoder, TextDecoder, atob, btoa, console: { log() {} } };
runInNewContext(recipe('base64-utf8-base64url-file-decoder', 'browser-base64') + '\n' + recipe('base64-utf8-base64url-file-decoder', 'base64url-normalize'), context);
assert.equal(context.encodeUtf8('café'), 'Y2Fmw6k=');
assert.equal(context.decodeUtf8('SGVsbG8sIGNhZsOpIOKYlQ=='), 'Hello, café ☕');
assert.equal(context.base64UrlToBase64('-_8'), '+/8=');
assert.equal(context.base64UrlToBase64('Zg'), 'Zg==');
assert.equal(context.base64UrlToBase64('Zm8'), 'Zm8=');
assert.equal(context.base64UrlToBase64('Zm9v'), 'Zm9v');
for (const value of ['a', 'a b', '-_8=', '+/8', 'Zh']) assert.throws(() => context.base64UrlToBase64(value));
assert.throws(() => context.decodeUtf8('+/8='));

const kafkaState = decodeLink(kafkaExampleHref);
assert.equal(kafkaState.d.report.partitions[2].lag, '79');
assert.ok(kafkaFindings.some(f => f.title === 'Lag is growing' && f.partitions.includes(1)));
assert.ok(kafkaFindings.some(f => f.title === 'Commit stopped while data arrived' && f.partitions.includes(2)));
assert.ok(kafkaFindings.some(f => f.title === 'Unexpected group member' && f.partitions.includes(3)));
assert.ok(!JSON.stringify(kafkaState).includes('10.4.1.12'));
assert.ok(!kafkaState.a);
const report = validateReport(await accessLogExampleReport());
assert.equal(report.summary.accepted, 6);
assert.equal(report.summary.uniqueIps, 3);
assert.equal(report.summary.errors, 3);
assert.equal(report.summary.bytes, 4580);
assert.ok(report.ips.every(ip => ip.category === 'special' && ip.matches.length === 0));
assert.deepEqual(decodeLink(await accessLogExampleHref()).d.report.summary, report.summary);

const scratch = mkdtempSync(join(tmpdir(), 'bugdays-guide-java-'));
try {
  writeFileSync(join(scratch, 'GzipBase64.java'), recipe('gzip-base64-java', 'java'));
  writeFileSync(join(scratch, 'RecipeChecks.java'), `
public class RecipeChecks {
  public static void main(String[] args) throws Exception {
    if (!GzipBase64.decode(GzipBase64.encode(""), 0).equals("")) throw new AssertionError();
    try { GzipBase64.decode(GzipBase64.encode("hello"), 4); throw new AssertionError("limit"); }
    catch (java.io.IOException expected) { }
    try { GzipBase64.decode("not-base64!", 100); throw new AssertionError("alphabet"); }
    catch (IllegalArgumentException expected) { }
    try { GzipBase64.decode("aGVsbG8=", 100); throw new AssertionError("header"); }
    catch (java.io.IOException expected) { }
    try { GzipBase64.decode(args[0], 100); throw new AssertionError("UTF-8"); }
    catch (java.nio.charset.CharacterCodingException expected) { }
    try { GzipBase64.decode(args[1], 100); throw new AssertionError("trailer"); }
    catch (java.io.IOException expected) { }
  }
}`);
  execFileSync('javac', ['--release', '8', '-encoding', 'UTF-8', 'GzipBase64.java', 'RecipeChecks.java'], { cwd: scratch, stdio: 'pipe' });
  const output = execFileSync('java', ['-Dfile.encoding=UTF-8', '-cp', scratch, 'GzipBase64'], { encoding: 'utf8' }).trim().split('\n');
  assert.equal(output[1], gzipExamples[1].text);
  assert.equal(gunzipSync(Buffer.from(output[0], 'base64')).toString(), gzipExamples[1].text);
  assert.equal(execFileSync('java', ['-Dfile.encoding=UTF-8', '-cp', scratch, 'GzipBase64', gzipExamples[1].base64], { encoding: 'utf8' }).trim(), gzipExamples[1].text);
  execFileSync('java', ['-cp', scratch, 'RecipeChecks', gzipSync(Buffer.from([0xff])).toString('base64'), gzipSync(Buffer.from('hello')).subarray(0, -4).toString('base64')]);
} finally {
  // Only this test's mkdtemp-created directory is removed.
  rmSync(scratch, { recursive: true, force: true });
}
console.log('Passed: six guide metadata/discovery checks; published Java and JavaScript recipes; Unicode, corruption and size limits; Kafka evidence; synthetic log totals and share fixtures.');
