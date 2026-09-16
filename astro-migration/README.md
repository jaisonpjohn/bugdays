# Bug Days

Open-source browser tools for debugging, API testing, data conversion, JVM diagnostics, certificates, and network investigations. The production site is [bugdays.com](https://bugdays.com/).

## Local development

```sh
npm install
npm run dev
npm run build
npm run test:traffic
npx playwright test
```

The Astro site is static. Cloudflare Pages Functions under `functions/` provide the small number of server-side endpoints, and `wrangler.toml` declares their bindings.

## IP intelligence data

The cloud and hosting IP lookup uses a D1 prefix index. Browsers send batches of normalized IP addresses to `/api/ip-lookup`; the API returns only matching ranges. The multi-megabyte global catalog is not included in the deployed static site.

For a single IP address—or an address a user deliberately opens from a bulk report—the browser adds live ISP, ASN, organization, approximate location, timezone, and reverse DNS data from the no-key IPWhois.io endpoint and Cloudflare DNS over HTTPS. `/api/ip-enrich` is a same-origin fallback for restrictive networks and does not write results to D1. Private and other special-use addresses never reach either external service. A paid IPWhois.io account can be enabled for the fallback with the Cloudflare secret `IPWHOIS_API_KEY`; never put that key in source control or a public environment variable.

To refresh the database snapshot:

```sh
npm run refresh:ip-ranges
npm run generate:ip-database
npx wrangler d1 execute bugdays-ip-intelligence --remote --file=/tmp/bugdays-ip-intelligence-delta.sql
npm run accept:ip-database-snapshot
```

Commit the updated `data/ip-ranges.baseline.json.gz` after the remote SQL succeeds. The generator compares fresh data with that compressed baseline, writes only the delta, and aborts above 80,000 projected D1 row writes so a refresh cannot casually consume the 100,000-row free daily allowance. Do not accept the candidate baseline before D1 confirms the import.

The generated `data/ip-ranges.json` is intentionally ignored and never deployed. Data comes from official operator feeds and RIPEstat BGP-origin prefixes defined in `src/lib/ip-datasets.ts`.

## Deployment

```sh
npm run build
npx wrangler pages deploy dist --project-name=bugdays --branch=main
```

Never commit API tokens, account credentials, local Wrangler state, production payloads, or user-submitted data. See `AGENTS.md` for implementation and release expectations.
