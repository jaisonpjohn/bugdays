# Bug Days implementation priorities

Apply these requirements whenever implementing or materially changing a Bug Days tool, page, or feature.

1. Treat SEO as a primary product requirement.
   - Research current search intent and terminology before choosing the page title, H1, description, headings, and supporting copy.
   - Add accurate title, canonical URL, meta description, social metadata, and appropriate structured data.
   - Use target terms naturally in useful explanatory copy. Never keyword-stuff or add generic filler.
   - Create or improve practical guides/articles that demonstrate the capability, and add contextual internal links between the tool, related tools, and guides.
   - Ensure new crawlable pages are discoverable through the appropriate sitemap, index, and RSS/feed mechanisms.

2. Make sharing a first-class, highly visible capability.
   - Users should immediately notice that a useful result can be shared.
   - Prefer a prominent, clearly labeled share action near the result or primary workflow instead of hiding it in a secondary menu.
   - Shared links must restore a useful, safe representation of the result and must not expose secrets or unrelated input.

3. Build a polished, spacious, real-estate-efficient UI.
   - Avoid oversized hero sections, cramped controls, excessive warnings, and unnecessary prose above the working area.
   - Keep the primary task visible early, use responsive layouts, and make the interface feel useful and approachable on desktop and mobile.

4. Ship tools that actually work.
   - Test realistic success, failure, malformed-input, boundary, sharing, and export flows as applicable.
   - Add automated unit/integration and real-browser coverage proportional to the feature.
   - Verify desktop and mobile behavior, accessibility basics, and the production build before publishing.

5. NEVER break a URL that has ever been public. This rule is strict and has no exceptions.
   - Assume any URL that was ever deployed, listed in a sitemap, linked, or shared has been crawled and indexed, even years ago and even if it looks unused. Bug Days has lost Angular-era URLs to a silent homepage fallback before; do not repeat it.
   - Do not rename, move, or delete a page, and do not change a route's slug or trailing-slash form, unless the same change adds a permanent redirect for the old URL.
   - Redirects live only in `public/_redirects` as real edge `301`s: list both the slash and no-slash source, and point straight at the closest equivalent tool with its trailing slash. Never point at the homepage or a category page when a matching tool exists, never chain redirects, and never use meta-refresh or `Astro.redirect` stub pages.
   - Never delete or repoint a line in `public/_redirects` unless the user explicitly asks. Retired URLs keep receiving traffic indefinitely.
   - Fixing a broken internal link does not retire the URL it pointed at. If a deployed page ever linked to a path, even one that never existed, crawlers may have indexed it, so add a 301 for that path in the same change.
   - Unknown paths must return the real `404` page (`src/pages/404.astro`). Never add a catch-all or SPA fallback that answers missing URLs with `200`.
   - Link internally only to canonical URLs, never to a redirect source. Keep canonicals, sitemap entries, and share links pointing at live pages.
   - Before every deploy that touches routes, pages, or `public/_redirects`, run `npm run build && npm run test:urls`. It fails if any URL in the live sitemap or ever linked in git history has no page and no redirect, a redirect misses or chains, or an internal link breaks. Treat a failure as blocking and do not bypass it with `SKIP_LIVE_SITEMAP=1`.
   - After deploying, verify each changed or retired URL in production with `curl -sI https://bugdays.com/<path>`: expect a single `301` to the final page, which returns `200`.

6. Treat Core Web Vitals and loading performance as SEO requirements.
   - Keep initial JavaScript and asset weight low, avoid unnecessary dependencies, reserve layout space to prevent shifts, and defer non-critical work.
   - Check for regressions in loading, rendering, responsiveness, and mobile layout before release.

Before calling an implementation complete, build it, run relevant automated and browser tests, review the public files for secrets, commit and push the changes when authorized, deploy when the request includes production delivery, and verify the live URLs rather than relying only on the deployment command.
