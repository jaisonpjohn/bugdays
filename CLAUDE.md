# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

bugdays.com — 60+ free developer tools that run entirely in the browser (privacy is the brand promise: pasted data must never be uploaded). The active codebase is **`astro-migration/`**; the directory name is historical, the Angular era it migrated from is gone. `workers/contact/` (Cloudflare D1) and `astro-migration/workers/share/` (Cloudflare KV, served at api.bugdays.com) are small deployed workers. `holy-cors/` is a separate git repo (gitignored here) — don't touch it as part of site work.

## Commands

All site work happens in `astro-migration/`:

```sh
npm run dev        # local dev at localhost:4321
npm run build      # static build to dist/ (66+ pages; treat any build error as blocking)
npm run preview    # serve dist/ locally — use this + curl to smoke-test pages before deploying
```

There is no test suite or linter. To test pure logic in `src/lib/` (parser, detectors, exporters), write a throwaway script in the scratchpad and run it with `npx tsx <file>.mts` — use the `.mts` extension (top-level await fails under `.ts`/cjs).

### Deploy (manual, no CI)

```sh
# Site — MUST be run with local git branch `main` checked out:
# Cloudflare Pages maps branch name → environment; any other branch deploys a PREVIEW, not production.
cd astro-migration && npm run build && wrangler pages deploy dist --project-name=bugdays --commit-dirty=true

# Workers — only when their code changes:
cd astro-migration/workers/share && wrangler deploy   # KV share storage
cd workers/contact && wrangler deploy                  # D1 contact/feedback (schema.sql alongside)
```

Deploy cautions learned the hard way:
- **Batch changes into one deploy.** Rapid back-to-back deploys open a propagation window where an edge node serves the new HTML but 404s the new hashed CSS — and that 404 gets browser-cached for 4h under the asset URL (breaks the site for those visitors until the hash changes).
- Verify production after deploy with `curl https://bugdays.com/...` — check content, not just status. `cf-cache-status` lag means give it ~30s before concluding something is wrong.
- Unhashed assets (e.g. `favicon.ico`) need a `?v=N` bump in `Layout.astro` when replaced.

### Git

Canonical remote is `bugdays` (github.com/jaisonpjohn/bugdays, public). Push with `git push bugdays HEAD:main`. The `origin` remote and local `legacy-main`/`master` branches are the pre-2026 Angular archive — never push new work there.

## Architecture

Astro 5 + Tailwind 4, fully static, no frontend framework: each tool page carries its own vanilla-TS `<script>` (bundled per-page by Astro, so heavy deps only load where used). Pages re-init on `astro:after-swap` — any script attaching listeners must handle re-runs (see the `dataset.init` guard pattern in `CommandPalette.astro`).

### Adding a tool (the most common task)

1. Create `src/pages/<tool-name>.astro` — copy the shape of an existing tool (e.g. `json-formatter.astro`): `<Layout>` with `title`/`description`/`keywords`/`breadcrumb`/`toolId`/`jsonLd` (WebApplication + FAQPage schemas), then markup + inline script.
2. Register it in `src/lib/tools.ts` — the **single registry** that drives the sidebar, the ⌘K command palette (names/keywords/descriptions are its search index), and dedup for "Popular".
3. Add internal links: the category page in `src/pages/*-tools.astro`, plus `index.astro` and `developer-tools.astro` if it deserves homepage placement. The sitemap picks it up automatically.
4. SEO-sensitive URLs: renamed tools keep a 301 stub page (`return Astro.redirect('/new-url', 301)` — see `line-dedupe.astro`). Always link canonical URLs internally, never the redirect stubs.

### Share-state system (`src/lib/share.ts`) — powers three features

Tool state is collected from any element carrying `data-share-key` (and the last-clicked `data-share-action` is replayed on load). One mechanism serves:
- **Share button**: state → LZString → `#lz:<compressed>` URL hash (client-only), or `#kv:<id>` via the share worker for large payloads — the user always chooses which.
- **Magic box** (`src/lib/detect.ts` + `MagicBox.astro` on the homepage): detectors identify pasted blobs (JWT, base64→gzip→JSON chains, DDL, epoch…) and deep-link into tools by constructing the same `#lz:` hash with preloaded data. A new tool becomes magic-box-routable just by having `data-share-key` inputs.
- Tools with non-DOM state register hooks via `ShareManager.register({ tool, actions, customCollect, customRestore })` — see `schema-explorer.astro`.

If you rename a `data-share-key` or `toolId`, old share links break silently — treat them as public API.

### Schema Explorer (flagship tool)

`src/lib/schema-parser.ts` is a hand-rolled, dialect-tolerant SQL DDL parser (Postgres/MySQL/Oracle/SQL Server/DB2/SQLite — quoting styles, dollar-quotes, ALTER/COMMENT ON attachment, per-table source-statement capture). `src/lib/schema-export.ts` generates Markdown/Mermaid/comment-SQL/JSON from the parsed schema plus user annotations (localStorage, keyed by a structure fingerprint so they survive comment edits). The page itself (`schema-explorer.astro`) renders a hub-and-spoke SVG ERD with hand-rolled pan/zoom/drag — natural scroll pans, ⌘/pinch zooms; keep that convention for any future canvas tool.

### Design rules

See `astro-migration/CLAUDE.md`: indigo-600 accent, white/slate palette with dark: variants on everything, no horizontal scroll, compact vertical layout, responsive phone→UHD. Match existing tool pages rather than inventing new patterns.

### Strategy context

`astro-migration/GROWTH.md` is the growth/SEO playbook (positioning, differentiators, content priorities, feature roadmap). Consult it before proposing new tools or SEO changes — it explains *why* the flagship features exist and what's deliberately out of scope (e.g. anything that breaks the no-upload privacy promise).
