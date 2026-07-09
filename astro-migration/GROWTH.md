# Bug Days — Growth & SEO Playbook

Written 2026-07-01. Context: solid technical SEO baseline already exists (static HTML via
Astro, sitemap, canonicals, JSON-LD WebApplication/FAQ/Breadcrumb, robots.txt). The gap is
**differentiation, content depth, and distribution** — not markup.

## 1. Positioning: what actually makes Bug Days different

"Free online dev tools, runs in your browser" is table stakes — every competitor says it.
Lean on things competitors can't easily copy:

- **Shareable tool state.** A link that reproduces someone's exact diff/formatting session is
  rare among dev-tool sites. Market it explicitly: *"Debugging with a teammate? Send them your
  exact session as a link."* Put this sentence on tool pages, not just in a corner.
- **Schema Explorer** (new). In-browser ER diagram from pasted DDL, no signup, no DSL to learn
  (dbdiagram.io makes you learn theirs; most competitors force accounts). This is the current
  flagship wedge — promote it on the homepage.
- **Niche tools with zero competition:** DBeaver password decrypter, TOON converter, bulk API
  invoker, in-browser gRPC/SOAP/WebSocket/SSE clients, holy-cors. Niche tools rank fast because
  nobody else targets those queries. Keep shipping these.
- **Speed:** Cmd+K palette + static pages. "The fastest way from problem to tool."

## 2. On-page SEO (highest ROI first)

1. **Reference content under each tool.** 300–600 words of genuinely useful material below the
   fold: common cron expressions table on /cron-parser, chmod cheat sheet on /unix-permissions,
   Base64 padding rules, etc. Thin pages don't rank; tools with reference content become the
   page people bookmark. Add FAQ JSON-LD wherever FAQs are added (pattern already exists on
   /json-formatter).
2. **Related-tools block** at the bottom of every tool page (drive internal links + session
   depth). The registry in `src/lib/tools.ts` makes this a one-component job.
3. **Long-tail intent pages** that preload the tool with a concrete example:
   "/cron-parser#every-5-minutes"-style anchors or dedicated pages ("epoch to IST",
   "chmod 755 explained"). Only where you can render real, distinct content — no doorway pages.
4. **Per-tool OG images** (generated at build with satori/astro-og-canvas) — better social CTR.
5. **Watch AdSense vs Core Web Vitals.** The adsbygoogle script is the most likely LCP/CLS
   killer on otherwise-static pages. Reserve ad slots with fixed dimensions; consider dropping
   ads entirely until traffic justifies them — rankings compound, ad pennies don't.
6. **Search Console hygiene:** verify GSC (Bing auth file exists already), submit sitemap,
   review "queries with impressions but no clicks" monthly — those are title/description fixes.

## 3. Distribution (the real bottleneck at low traffic)

Backlinks and mentions move the needle more than any on-page tweak now:

- **Show HN / Product Hunt launches** for launchable units: Schema Explorer, holy-cors,
  the shareable-state feature. One launch per unit, written as "I built X because Y".
- **dev.to / Hashnode posts** that solve a problem and happen to use the tool
  ("Documenting a legacy Oracle schema in 10 minutes — without DBA access").
- **GitHub presence:** holy-cors is open source — submit it to awesome-lists
  (awesome-devtools, awesome-cors, awesome-selfhosted where applicable). Each list = a durable backlink.
- **Answer real questions** (StackOverflow, Reddit r/dataengineering, r/webdev) where a tool is
  the honest answer. Sparingly — value first, link second.

## 4. Schema Explorer roadmap (differentiator track)

- **Phase 1 (shipped):** paste DDL → interactive ERD, annotations, Markdown/Mermaid/SQL exports.
  100% client-side; works for Postgres, MySQL, Oracle, SQL Server, DB2, SQLite.
- **Phase 1.5:** accept `information_schema` query output (CSV/JSON paste) as an alternative
  input for users who can't run dump tools; provide the copy-paste query per engine.
- **Phase 2:** live connection via a local connector — extend holy-cors into a small signed
  binary that connects to the DB on localhost and serves schema metadata to the browser over
  localhost HTTP. Pitch: *"Explore your real database — schema never leaves your machine."*
  No competitor does this without an account or an Electron app.
- **Phase 2.5:** persist/share annotated diagrams via the existing share infrastructure
  (kv: server share) → collaborative schema documentation, the retention feature.

## 5. Measure

- GA4 events already exist; add events for: palette opened, palette search → tool navigated,
  share clicked, share method chosen, schema explored (table count bucket), export format used.
- Weekly: GSC queries/impressions; monthly: which tools earn organic entrances → build more
  reference content for winners, more niche tools like them.
