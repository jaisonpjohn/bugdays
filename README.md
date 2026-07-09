<p align="center">
  <a href="https://bugdays.com">
    <img src=".github/banner.svg" alt="Bug Days — free developer tools that run entirely in your browser" width="800" />
  </a>
</p>

<p align="center">
  <a href="https://bugdays.com"><img src="https://img.shields.io/badge/live-bugdays.com-6366f1" alt="Live site" /></a>
  <img src="https://img.shields.io/badge/privacy-100%25%20client--side-22c55e" alt="100% client-side" />
  <img src="https://img.shields.io/badge/tools-60%2B-818cf8" alt="60+ tools" />
  <img src="https://img.shields.io/badge/signup-never-0ea5e9" alt="No signup" />
</p>

---

**[Bug Days](https://bugdays.com)** is a box of free developer tools — format, diff, decode, convert, explore. The twist: **everything runs in your browser**. Nothing you paste is ever uploaded, so it's safe for the stuff you actually work with — tokens, configs, production schemas, customer data.

## ✨ The good stuff

🪄 **[Paste Anything](https://bugdays.com)** — the magic box on the homepage. Paste any mystery blob — a JWT, base64, gzipped payload, epoch timestamp, URL-encoded mess — and it figures out what it is (even chains like `Base64 → GZip → JSON`), shows a preview, and opens the right tool with your data already loaded.

🗺️ **[Schema Explorer](https://bugdays.com/schema-explorer)** — paste your database DDL (Postgres, MySQL, Oracle, SQL Server, DB2, SQLite) and get an interactive ER diagram: hub-and-spoke layout, follow relationships, annotate tables and columns, export a data dictionary as Markdown, Mermaid, or `COMMENT` SQL.

🔗 **Shareable sessions** — hit Share on any tool and send a colleague a link that reproduces your exact session. Small payloads live entirely inside the URL; you choose before anything is ever stored.

⌨️ **Fast to reach** — `⌘K` opens a command palette over all 60+ tools. Muscle memory friendly.

🌓 Dark mode, mobile friendly, no ads in your way, no accounts, no cookies-walls.

## 🧰 What's in the box

Formatters and diffs for **JSON · YAML · TOML · XML · text**, encoders for **Base64 · URL · GZip · JWT · images**, converters for **CSV, Protobuf, Avro, TOON, colors, timestamps, cron, chmod**, generators for **UUIDs, passwords, hashes, QR codes**, and network tools including an **API client, WebSocket/SSE clients, gRPC & SOAP clients, and a CIDR calculator**. Browse them all at [bugdays.com/developer-tools](https://bugdays.com/developer-tools).

## 🐞 Found a bug? (fitting, right?)

Use the **Feedback** button on any page, or [open an issue](https://github.com/jaisonpjohn/bugdays/issues) here.

<details>
<summary>🔧 Development &amp; repo layout</summary>

<br/>

| Directory | What it is |
|---|---|
| `astro-migration/` | The website — Astro 5 + Tailwind 4, fully static |
| `astro-migration/workers/share/` | Cloudflare Worker (KV) storing large shared sessions, 30-day TTL |
| `workers/contact/` | Cloudflare Worker (D1) for the contact/feedback form |

```sh
cd astro-migration
npm install
npm run dev       # local dev at localhost:4321

npm run build     # static build to dist/
wrangler pages deploy dist --project-name=bugdays   # deploy (Cloudflare Pages)
```

Adding a tool: one `.astro` page in `astro-migration/src/pages/` plus an entry in
`astro-migration/src/lib/tools.ts` (feeds the sidebar and the ⌘K palette).

</details>

<p align="center"><sub>Made with 🐛 by <a href="https://github.com/jaisonpjohn">@jaisonpjohn</a> · © 2024–2026 Bug Days</sub></p>
