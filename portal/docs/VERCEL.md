# Deploying the portal to Vercel

The portal runs two ways from the same code:

- **Local / Docker** — long-lived Express server + atomic JSON-file DB (`DB_DRIVER=file`, the default). Nothing here changes your local workflow: `docker compose up -d --build` still works exactly as before.
- **Vercel** — the Express app runs as one serverless function (`api/index.js`), the DB lives in Postgres (`DB_DRIVER=postgres`), and the lifecycle sweep runs via Vercel Cron instead of `setInterval`.

## One-time setup

1. **Create the Vercel project**
   - Import the `kiddieGPT` repo.
   - Set **Root Directory = `portal`** (this monorepo holds `extension/`, `portal/`, `web/`).
   - Framework preset: **Other**. Vercel picks up `vercel.json` (function + rewrites + cron).

2. **Create the database**
   - Vercel dashboard → **Storage → Create → Postgres** (Neon-backed).
   - It exposes a `POSTGRES_URL` env var automatically. The app auto-creates its
     single `app_state` table on first boot — no migrations to run.

3. **Set environment variables** (Project → Settings → Environment Variables):

   | Var | Value |
   |-----|-------|
   | `DB_DRIVER` | `postgres` |
   | `POSTGRES_URL` | (auto-added by Vercel Postgres) |
   | `CRON_SECRET` | a long random string |
   | `AUTH_TOKEN_SECRET` | a strong secret (not the dev default) |
   | `OPENAI_API_KEY` | your rotated key |
   | `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | live values |
   | `POSTMARK_SERVER_TOKEN` / `POSTMARK_FROM_EMAIL` | email provider |
   | `ADMIN_EMAIL` / `ADMIN_PASSWORD` | operator login |
   | `ALLOWED_EXTENSION_ORIGINS` | `chrome-extension://<published-id>` |

   Everything else falls back to the same defaults as local.

4. **Domain** — add `app.kiddiegpt.com` to the project. Vercel shows the CNAME
   target (`cname.vercel-dns.com`); add it at your DNS host. (The apex
   `kiddiegpt.com` stays on Hostinger.)

## How it maps

| Concern | Local (file) | Vercel (postgres) |
|--------|--------------|-------------------|
| Server | `app.listen` (Docker) | `api/index.js` serverless function |
| DB | `data/kiddiegpt-db.json` | `app_state` JSONB row in Postgres |
| Sweep | `setInterval` on boot | Vercel Cron → `GET /api/cron/sweep` (hourly, guarded by `CRON_SECRET`) |
| Static assets | Express | Express (via the same function) |

## Notes / follow-ups

- **Concurrency:** the Postgres driver mirrors the file DB's whole-document
  read-modify-write (last write wins). That's safe within a single invocation;
  across many concurrent serverless invocations it has the same last-writer-wins
  semantics the file DB always had. Fine for launch scale; revisit with per-entity
  tables if write concurrency grows.
- **Stripe webhook:** it uses `express.raw` for signature verification. Confirm the
  raw body survives on the first deploy (send a Stripe test event) — no code change
  expected, just verify.
- **Migrating existing data:** to seed prod from a local DB, `INSERT` your
  `data/kiddiegpt-db.json` contents into `app_state (id, data) VALUES (1, …)`.
