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

5. Preserve existing URLs and accumulated search value.
   - Do not rename, remove, or break an existing public route casually.
   - When a URL must change, add and verify a permanent redirect, update canonicals and internal links, and retain the old URL as an entry point.

6. Treat Core Web Vitals and loading performance as SEO requirements.
   - Keep initial JavaScript and asset weight low, avoid unnecessary dependencies, reserve layout space to prevent shifts, and defer non-critical work.
   - Check for regressions in loading, rendering, responsiveness, and mobile layout before release.

Before calling an implementation complete, build it, run relevant automated and browser tests, review the public files for secrets, commit and push the changes when authorized, deploy when the request includes production delivery, and verify the live URLs rather than relying only on the deployment command.
