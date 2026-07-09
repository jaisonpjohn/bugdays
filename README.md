# Bug Days — bugdays.com

Free online developer tools. Everything runs in the browser; no data leaves your machine.

## Repository layout

| Directory | What it is |
|---|---|
| `astro-migration/` | The website (Astro 5 + Tailwind 4). Deployed to Cloudflare Pages, project `bugdays`. |
| `astro-migration/workers/share/` | `bugdays-share` Cloudflare Worker (KV) — server-side storage for large shared tool states, served at `api.bugdays.com`. |
| `workers/contact/` | `bugdays-contact` Cloudflare Worker (D1) — contact form + feedback storage. |
| `holy-cors/` | Holy CORS — open-source local CORS proxy (Rust), used by the API client tools. |

## Develop

```sh
cd astro-migration
npm install
npm run dev
```

## Deploy

```sh
# Site (Cloudflare Pages)
cd astro-migration
npm run build
wrangler pages deploy dist --project-name=bugdays

# Workers (only when their code changes)
cd astro-migration/workers/share && wrangler deploy
cd workers/contact && wrangler deploy
```

The original Angular version of this site lived at the repo root until July 2026; it was
fully replaced by `astro-migration/` and removed (recoverable from git history).
