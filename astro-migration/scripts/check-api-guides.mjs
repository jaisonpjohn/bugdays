import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const guides = [
  { slug: 'test-grpc-api-proto-metadata-streaming', phrase: 'How to Test a gRPC API', tool: '/grpc-client', source: 'https://grpc.io/docs/guides/metadata/' },
  { slug: 'grpc-web-vs-native-grpc-browser-testing', phrase: 'gRPC-Web vs Native gRPC', tool: '/grpc-client', source: 'https://grpc.io/docs/platforms/web/basics/' },
  { slug: 'soap-api-authentication-basic-ws-security-mtls', phrase: 'SOAP API Authentication', tool: '/soap-client', source: 'https://docs.oasis-open.org/' },
  { slug: 'identify-cloud-hosting-ips-in-access-logs', phrase: 'How to Identify Cloud, Hosting, and Crawler IPs', tool: '/ip-lookup', source: 'https://data.stat.ripe.net/docs/data-api/api-endpoints/ris-prefixes', published: '2026-09-15' },
];

const read = path => readFile(new URL(`../dist/${path}`, import.meta.url), 'utf8');
const index = await read('guides/index.html');
const rss = await read('guides/rss.xml');
const sitemap = await read('sitemap-0.xml');

for (const guide of guides) {
  const html = await read(`guides/${guide.slug}/index.html`);
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z0-9#]+;/gi, ' ')
    .replace(/\s+/g, ' ');
  assert.match(html, new RegExp(`<h1[^>]*>[^<]*${guide.phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(html, new RegExp(`<link rel="canonical" href="https://bugdays.com/guides/${guide.slug}/"`));
  assert.match(html, /<meta name="description" content="[^\"]{100,180}"/);
  assert.match(html, /"@type":"Article"/);
  assert.ok(html.includes(`"datePublished":"${guide.published || '2026-09-14'}T09:00:00-07:00"`));
  assert.match(html, /<meta property="og:type" content="article"/);
  assert.ok(text.split(' ').length >= 700, `${guide.slug} is too thin`);
  assert.ok(html.includes(`href="${guide.tool}"`), `${guide.slug} does not link to its tool`);
  assert.ok(html.includes(guide.source), `${guide.slug} is missing its primary source`);
  assert.ok(index.includes(`/guides/${guide.slug}`), `${guide.slug} is missing from the guide index`);
  assert.ok(rss.includes(`/guides/${guide.slug}/`), `${guide.slug} is missing from RSS`);
  assert.ok(sitemap.includes(`/guides/${guide.slug}/`), `${guide.slug} is missing from the sitemap`);
  console.log(`Guide checks passed: /guides/${guide.slug}/`);
}

const grpcClient = await read('grpc-client/index.html');
const soapClient = await read('soap-client/index.html');
assert.ok(grpcClient.includes('/guides/test-grpc-api-proto-metadata-streaming'));
assert.ok(grpcClient.includes('/guides/grpc-web-vs-native-grpc-browser-testing'));
assert.ok(soapClient.includes('/guides/soap-api-authentication-basic-ws-security-mtls'));
const ipLookup = await read('ip-lookup/index.html');
assert.ok(ipLookup.includes('/guides/identify-cloud-hosting-ips-in-access-logs'));
console.log('API guide index, RSS, sitemap, structured data, sources, and tool links passed.');
