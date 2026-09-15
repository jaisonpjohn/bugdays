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

To refresh the database snapshot:

```sh
npm run refresh:ip-ranges
npm run generate:ip-database
npx wrangler d1 migrations apply bugdays-ip-intelligence --remote
npx wrangler d1 execute bugdays-ip-intelligence --remote --file=/tmp/bugdays-ip-intelligence.sql
```

The generated `data/ip-ranges.json` is intentionally ignored. Data comes from official operator feeds and RIPEstat BGP-origin prefixes defined in `src/lib/ip-datasets.ts`.

## Deployment

```sh
npm run build
npx wrangler pages deploy dist --project-name=bugdays --branch=main
```

Never commit API tokens, account credentials, local Wrangler state, production payloads, or user-submitted data. See `AGENTS.md` for implementation and release expectations.
