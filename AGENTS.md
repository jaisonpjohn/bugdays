# AGENTS.md

Instructions for coding agents (Claude Code, Codex and others) working in this repository.

This is the only instruction file. Do not create a `CLAUDE.md` or `CLAUDE.local.md` anywhere in the repo: Claude Code reads `AGENTS.md` only when no `CLAUDE.md` exists in the working directory or above it, so adding one silently disables everything below.

## What this is

bugdays.com — 60+ free developer tools that run in the browser. Privacy is the brand promise: pasted data must never be uploaded. The active codebase is **`astro-migration/`**; the directory name is historical, and the Angular era it migrated from is gone.

- `astro-migration/` — the site (Astro 5 + Tailwind 4, static) plus Pages Functions in `functions/api/` backed by the D1 database `bugdays-ip-intelligence`.
- `astro-migration/workers/share/` — share-link storage (Cloudflare KV), served at api.bugdays.com.
- `workers/contact/` — contact/feedback worker (Cloudflare D1, `schema.sql` alongside).
- `holy-cors/` — a separate git repo (gitignored here). Don't touch it as part of site work.

## Commands

Run site commands in `astro-migration/`:

```sh
npm run dev        # local dev at localhost:4321
npm run build      # static build to dist/; treat any build error as blocking
npm run preview    # serve dist/ locally for curl smoke tests
```

Tests (run the ones relevant to the change; run them all before a large deploy):

```sh
npm run test:urls              # URL preservation, redirects, internal links (needs a fresh build)
npm run test:analytics         # analytics never sends user content
npm run test:ip-datasets       # IP feed parsers and CIDR merging
npm run test:ip-database       # D1 delta generation
npm run test:ip-enrichment
npm run test:traffic           # IP / access-log analysis
npm run test:network-diagnostics
npm run test:grpc-client
npm run test:gzip-seo          # these two read dist/, so build first
npm run test:api-guides
npx playwright test            # browser tests, desktop + mobile; starts the dev server itself
```

- Imports inside `src/lib/` must use explicit `.ts` extensions (`from './ip-address.ts'`). Vite tolerates bare paths, but the Node test runner does not.
- For quick checks of pure logic, write a throwaway script in the scratchpad and run it with `npx tsx <file>.mts`. Use the `.mts` extension, because top-level await fails under `.ts`/CJS.
- When an automated browser (Lighthouse, Playwright) hits **production**, block `googletagmanager.com`, `google-analytics.com` and `googlesyndication.com`. Otherwise every run counts as a new GA4 user and distorts real traffic numbers.

## Deploy (manual, no CI)

```sh
# Site. MUST run with local git branch `main` checked out: Cloudflare Pages maps the branch
# name to the environment, so any other branch deploys a PREVIEW, not production.
cd astro-migration && npm run build && npx wrangler pages deploy dist --project-name=bugdays --commit-dirty=true

# Workers, only when their code changes:
cd astro-migration/workers/share && npx wrangler deploy
cd workers/contact && npx wrangler deploy
```

Deploy cautions learned the hard way:
- **Batch changes into one deploy.** Back-to-back deploys open a propagation window where an edge node serves new HTML but 404s the new hashed CSS, and browsers cache that 404 for 4 hours under the asset URL.
- Verify production afterwards with `curl https://bugdays.com/...`. Check content, not just status, and allow ~30 s for cache lag before concluding something is wrong.
- Unhashed assets (e.g. `favicon.ico`) need a `?v=N` bump in `Layout.astro` when replaced.
- To test a risky change on real Cloudflare infrastructure, deploy it with `--branch=<name>` (preview URL `https://<name>.bugdays.pages.dev`), then delete the preview with `npx wrangler pages deployment delete <id> --project-name=bugdays`.

### IP intelligence data

Provider ranges live in D1, not in the site bundle. Feeds are defined in `astro-migration/src/lib/ip-datasets.ts`. To refresh, from `astro-migration/`:

```sh
npm run refresh:ip-ranges            # fetch every feed into data/ip-ranges.json (aborts if any feed fails)
npm run generate:ip-database         # differential SQL at /tmp/bugdays-ip-intelligence-delta.sql
npx wrangler d1 execute bugdays-ip-intelligence --remote --file /tmp/bugdays-ip-intelligence-delta.sql
npm run accept:ip-database-snapshot  # only after the remote SQL succeeds
```

Then commit `data/ip-ranges.baseline.json.gz`. The generator refuses to exceed 80,000 row writes; don't raise that limit casually, because the D1 free tier allows 100,000 writes a day. Don't deploy page copy that claims new coverage until its data is in D1.

## Git

The canonical remote is `bugdays` (github.com/jaisonpjohn/bugdays, **public**). Push with `git push bugdays HEAD:main`. The `origin` remote and the local `legacy-main`/`master` branches are the pre-2026 Angular archive; never push new work there.

Because the repo is public, never commit API tokens, account credentials, local Wrangler state, production payloads, user-submitted data, or `astro-migration/GROWTH.md`.

## Architecture

Astro 5 + Tailwind 4, fully static, no frontend framework. Each tool page carries its own vanilla-TS `<script>`, bundled per page by Astro, so heavy dependencies only load where used. Pages re-initialize on `astro:after-swap`, so any script attaching listeners must handle re-runs (see the `dataset.init` guard pattern in `CommandPalette.astro`).

### Adding a tool (the most common task)

1. Create `src/pages/<tool-name>.astro`, copying the shape of an existing tool (e.g. `json-formatter.astro`): `<Layout>` with `title`/`description`/`keywords`/`breadcrumb`/`toolId`/`jsonLd` (WebApplication + FAQPage schemas), then markup and an inline script.
2. Register it in `src/lib/tools.ts` with a trailing-slash href (e.g. `/json-formatter/`). This is the **single registry** behind the sidebar, the ⌘K command palette (names, keywords and descriptions are its search index) and "Popular" deduplication.
3. Add internal links: the category page in `src/pages/*-tools.astro`, plus `index.astro` and `developer-tools.astro` if it deserves homepage placement. The sitemap picks it up automatically.
4. If the tool has a primary action, give its button a `data-share-action` so `tool_used` analytics records it, and route downloads through a helper that calls `track('export_used', …)`.

### Share-state system (`src/lib/share.ts`) — powers three features

Tool state is collected from any element carrying `data-share-key`, and the last-clicked `data-share-action` is replayed on load. One mechanism serves:
- **Share button**: state → LZString → `#lz:<compressed>` URL hash (client-only), or `#kv:<id>` via the share worker for large payloads. The user always chooses which. Stored (`#kv:`) shares are currently kept unencrypted on the server.
- **Magic box** (`src/lib/detect.ts` + `MagicBox.astro` on the homepage): detectors identify pasted blobs (JWT, base64→gzip→JSON chains, DDL, epoch…) and deep-link into tools by constructing the same `#lz:` hash with preloaded data. A new tool becomes magic-box-routable just by having `data-share-key` inputs.
- Tools with non-DOM state register hooks via `ShareManager.register({ tool, actions, customCollect, customRestore })` (see `schema-explorer.astro`).

If you rename a `data-share-key` or `toolId`, old share links break silently. Treat them as public API.

### Analytics (`src/lib/analytics.ts`)

GA4 and AdSense load after the page renders (see `Layout.astro`); don't move them back into `<head>`. Custom events go through `track()`, which drops any value that is not a short lowercase slug. Never send anything a user typed, pasted, uploaded or connected to: no pasted text, file names, hostnames, endpoints, headers, queries or error messages. Send only tool ids, action names, export formats and bucketed sizes (`sizeBucket`, `countBucket`).

### Schema Explorer (flagship tool)

`src/lib/schema-parser.ts` is a hand-rolled, dialect-tolerant SQL DDL parser (Postgres/MySQL/Oracle/SQL Server/DB2/SQLite: quoting styles, dollar-quotes, ALTER/COMMENT ON attachment, per-table source-statement capture). `src/lib/schema-export.ts` generates Markdown/Mermaid/comment-SQL/JSON from the parsed schema plus user annotations (localStorage, keyed by a structure fingerprint so they survive comment edits). The page (`schema-explorer.astro`) renders a hub-and-spoke SVG ERD with hand-rolled pan/zoom/drag: natural scroll pans, ⌘/pinch zooms. Keep that convention for any future canvas tool.

## Design rules

- **No horizontal scroll**, unless absolutely necessary.
- **Responsive**: every page must work from phone screens to UHD monitors.
- **Compact vertically**, without cramping the layout.
- **Accent** indigo-600 (#4f46e5) with purple undertones, on a white/slate base, with `dark:` variants on everything.
- **Layout**: left sidebar navigation with grouped tools. On desktop it is always visible and sticky; on mobile it is an overlay opened by the hamburger menu.
- Match existing tool pages rather than inventing new patterns.

## Implementation priorities

Apply these whenever implementing or materially changing a tool, page or feature. Paths are relative to `astro-migration/`.

1. **Treat SEO as a primary product requirement.**
   - Research current search intent and terminology before choosing the page title, H1, description, headings and supporting copy.
   - Add an accurate title, canonical URL, meta description, social metadata and appropriate structured data.
   - Use target terms naturally in useful explanatory copy. Never keyword-stuff or add generic filler.
   - Create or improve practical guides that demonstrate the capability, and add contextual internal links between the tool, related tools and guides.
   - Make new crawlable pages discoverable through the sitemap, index and RSS feed as appropriate.

2. **Make sharing a first-class, highly visible capability.**
   - Users should immediately notice that a useful result can be shared.
   - Prefer a prominent, clearly labeled share action near the result or primary workflow over a secondary menu.
   - Shared links must restore a useful, safe representation of the result and must not expose secrets or unrelated input.

3. **Build a polished, spacious, real-estate-efficient UI.**
   - Avoid oversized hero sections, cramped controls, excessive warnings and unnecessary prose above the working area.
   - Keep the primary task visible early, use responsive layouts, and make the interface approachable on desktop and mobile.

4. **Ship tools that actually work.**
   - Test realistic success, failure, malformed-input, boundary, sharing and export flows as applicable.
   - Add automated unit/integration and real-browser coverage proportional to the feature.
   - Verify desktop and mobile behavior, accessibility basics and the production build before publishing.

5. **NEVER break a URL that has ever been public.** This rule is strict and has no exceptions.
   - Assume any URL that was ever deployed, listed in a sitemap, linked or shared has been crawled and indexed, even years ago and even if it looks unused. Bug Days has lost Angular-era URLs to a silent homepage fallback before; do not repeat it.
   - Do not rename, move or delete a page, and do not change a route's slug or trailing-slash form, unless the same change adds a permanent redirect for the old URL.
   - Redirects live only in `public/_redirects` as real edge `301`s: list both the slash and no-slash source, and point straight at the closest equivalent tool with its trailing slash. Never point at the homepage or a category page when a matching tool exists, never chain redirects, and never use meta-refresh or `Astro.redirect` stub pages (in this static build those emit a `200`).
   - Never delete or repoint a line in `public/_redirects` unless the user explicitly asks. Retired URLs keep receiving traffic indefinitely.
   - Fixing a broken internal link does not retire the URL it pointed at. If a deployed page ever linked to a path, even one that never existed, crawlers may have indexed it, so add a 301 for that path in the same change.
   - Unknown paths must return the real `404` page (`src/pages/404.astro`). Never add a catch-all or SPA fallback that answers missing URLs with `200`.
   - Link internally only to canonical URLs, never to a redirect source. Page URLs end with a trailing slash (`/json-formatter/`), matching canonicals and the sitemap; a slashless link costs every visitor and crawler a redirect. Keep canonicals, sitemap entries and share links pointing at live pages.
   - Before every deploy that touches routes, pages or `public/_redirects`, run `npm run build && npm run test:urls`. It fails if any URL in the live sitemap or ever linked in git history has no page and no redirect, a redirect misses or chains, or an internal link breaks or redirects. Treat a failure as blocking and do not bypass it with `SKIP_LIVE_SITEMAP=1`.
   - After deploying, verify each changed or retired URL in production with `curl -sI https://bugdays.com/<path>`: expect a single `301` to the final page, which returns `200`.

6. **Treat Core Web Vitals and loading performance as SEO requirements.**
   - Keep initial JavaScript and asset weight low, avoid unnecessary dependencies, reserve layout space to prevent shifts, and defer non-critical work.
   - Nothing that appears late may become the largest element on a short page (a delayed cookie banner once made mobile LCP 6+ seconds).
   - Check for regressions in loading, rendering, responsiveness and mobile layout before release.

Before calling an implementation complete: build it, run the relevant automated and browser tests, review the public files for secrets, commit and push when authorized, deploy when the request includes production delivery, and verify the live URLs rather than relying only on the deploy command.

## Infrastructure notes (outside the repo)

These live in Cloudflare, not in code, so check there before assuming.
- **www → apex** is a zone-level Single Redirect rule (dashboard: Rules → Redirect Rules), not `_redirects`, which cannot match hostnames.
- **api.bugdays.com has no DNS record of its own.** It resolves through the `*.bugdays.com` wildcard. Before removing that wildcard, add a proxied `api` record (AAAA `100::`), or every stored share link breaks.
- The free-plan zone's hostname and status breakdowns are only available through the GraphQL Analytics API (`httpRequestsAdaptiveGroups`), not the dashboard.

## Strategy context

`astro-migration/GROWTH.md` is the private growth and SEO roadmap: positioning, differentiators, content priorities, and what's deliberately out of scope (e.g. anything that breaks the no-upload privacy promise). It is gitignored and local only. Consult it before proposing new tools or SEO changes, and never stage or publish it.
