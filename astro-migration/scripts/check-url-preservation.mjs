// Run after `npm run build`. Guards the rule that a public URL never breaks:
// every URL in the live sitemap or ever linked in git history must still be a built page or a
// 301 in public/_redirects, and every redirect must land directly on a real page.
// Set SKIP_LIVE_SITEMAP=1 to skip the network comparison against https://bugdays.com.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const DIST = 'dist';
const SITE = 'https://bugdays.com';

const builtTarget = (path) => {
  const clean = decodeURIComponent(path.split(/[?#]/)[0]);
  if (/\.[a-z0-9]+$/i.test(clean)) return existsSync(join(DIST, clean));
  return existsSync(join(DIST, clean, 'index.html'));
};

// --- _redirects syntax and targets ---
const redirects = new Map();
for (const [index, raw] of readFileSync('public/_redirects', 'utf8').split('\n').entries()) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const [source, destination, code, ...extra] = line.split(/\s+/);
  const where = `_redirects:${index + 1}`;
  assert.equal(extra.length, 0, `${where}: unexpected fields`);
  assert.equal(code, '301', `${where}: retired URLs need an explicit permanent 301`);
  assert.ok(source.startsWith('/') && !/[*:]/.test(source), `${where}: static source path expected`);
  assert.ok(destination.startsWith('/'), `${where}: redirect within the site`);
  assert.ok(!redirects.has(source), `${where}: duplicate source ${source}`);
  redirects.set(source, destination);
}
assert.ok(redirects.size > 0, '_redirects has rules');

for (const [source, destination] of redirects) {
  assert.ok(builtTarget(destination), `${source} -> ${destination}: destination is not a built page`);
  assert.ok(!redirects.has(destination), `${source} -> ${destination}: redirect chain`);
  assert.ok(destination.endsWith('/') || /\.[a-z0-9]+$/i.test(destination), `${source} -> ${destination}: add the trailing slash to avoid a second hop`);
  assert.ok(!builtTarget(source), `${source}: a built page exists here but the redirect hides it`);
  if (!/\.[a-z0-9]+$/i.test(source) && source !== '/') {
    const twin = source.endsWith('/') ? source.slice(0, -1) : `${source}/`;
    assert.ok(redirects.has(twin), `${source}: also redirect ${twin}`);
  }
}

// --- 404 page and sitemap hygiene ---
const notFound = readFileSync(join(DIST, '404.html'), 'utf8');
assert.ok(notFound.includes('name="robots" content="noindex'), '404 page is noindex');
assert.ok(!notFound.includes('rel="canonical"'), '404 page has no canonical');

const sitemapPaths = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
const builtSitemap = readdirSync(DIST).filter((f) => /^sitemap-\d+\.xml$/.test(f)).flatMap((f) => sitemapPaths(readFileSync(join(DIST, f), 'utf8')));
assert.ok(builtSitemap.length > 50, 'built sitemap lists the site');
for (const path of builtSitemap) {
  assert.ok(!redirects.has(path), `sitemap lists redirecting URL ${path}`);
  assert.ok(!path.startsWith('/404'), 'sitemap lists the 404 page');
  assert.ok(builtTarget(path), `sitemap lists missing page ${path}`);
}

// --- internal links must resolve without landing on a retired URL ---
const htmlFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = join(dir, entry.name);
  if (entry.isDirectory()) return entry.name === '_astro' ? [] : htmlFiles(full);
  return entry.name.endsWith('.html') ? [full] : [];
});
const brokenLinks = new Set();
for (const file of htmlFiles(DIST)) {
  for (const [, href] of readFileSync(file, 'utf8').matchAll(/\shref="(\/(?!\/)[^"#?]*)/g)) {
    const path = href.endsWith('/') || /\.[a-z0-9]+$/i.test(href) ? href : `${href}/`;
    if (redirects.has(href) || redirects.has(path)) brokenLinks.add(`${file}: links to retired URL ${href}`);
    else if (!builtTarget(path) && !href.startsWith('/api/')) brokenLinks.add(`${file}: broken link ${href}`);
  }
}
assert.equal(brokenLinks.size, 0, `Internal link problems:\n${[...brokenLinks].join('\n')}`);

// --- every internal URL this repo has ever linked may have been crawled, so it must still resolve ---
// Fixing a broken link does not retire the URL it pointed at; that URL needs a 301 too.
const history = execFileSync('git', ['log', '-p', '--format=', '--', 'src', 'public', ':!public/data'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const linkPattern = /(?:href\s*[=:]\s*\{?\s*["'`]|Astro\.redirect\(\s*["'`]|https:\/\/(?:www\.)?bugdays\.com)(\/[A-Za-z0-9][A-Za-z0-9/_.-]*)/g;
const everLinked = new Set();
for (const line of history.split('\n')) {
  if (!line.startsWith('+') || line.startsWith('+++')) continue;
  for (const [, path] of line.matchAll(linkPattern)) everLinked.add(path);
}
const resolves = (path) => {
  const bare = path.replace(/\/+$/, '') || '/';
  return builtTarget(bare) || builtTarget(`${bare}/`) || redirects.has(bare) || redirects.has(`${bare}/`);
};
const unresolved = [...everLinked].filter((path) => !path.startsWith('/api/') && !path.startsWith('/_astro/') && !resolves(path));
assert.deepEqual(unresolved, [], `Previously linked URLs with no page and no 301 in public/_redirects:\n${unresolved.join('\n')}`);

// --- nothing currently published may disappear ---
if (process.env.SKIP_LIVE_SITEMAP === '1') {
  console.log('Skipped live sitemap comparison (SKIP_LIVE_SITEMAP=1).');
} else {
  const index = await (await fetch(`${SITE}/sitemap-index.xml`)).text();
  const livePaths = [];
  for (const child of sitemapPaths(index)) livePaths.push(...sitemapPaths(await (await fetch(`${SITE}${child}`)).text()));
  assert.ok(livePaths.length > 50, 'fetched the live sitemap');
  const lost = livePaths.filter((path) => !builtTarget(path) && !redirects.has(path));
  assert.deepEqual(lost, [], `Live URLs with no page and no 301 in public/_redirects:\n${lost.join('\n')}`);
  console.log(`Live sitemap: all ${livePaths.length} published URLs still resolve.`);
}

console.log(`URL preservation checks passed: ${redirects.size} redirects, ${builtSitemap.length} sitemap URLs.`);
