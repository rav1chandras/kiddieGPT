# KiddieGPT

Monorepo for the KiddieGPT product — a kid-safe AI learning assistant.

## Structure

```
.
├── extension/   Chrome MV3 side-panel app for kids (math, tutor, quiz, flashcards)
└── portal/      Parent + admin web portal and backend (Express, Stripe, JSON-file DB, Docker)
```

The two talk to each other over a small HTTP contract: the extension authenticates
a parent session against the portal, streams AI calls through the portal's proxy
(so the OpenAI key never lives in the extension), and syncs student progress and
usage back to the parent portal.

## Getting started

### Portal
```bash
cd portal
cp .env.example .env          # fill in secrets (Stripe, Postmark/SMTP, AUTH_TOKEN_SECRET)
docker compose up -d --build  # serves on http://localhost:8080
```

### Extension
```bash
cd extension
cp local-settings.example.js local-settings.js   # add your local portal URL (and dev key if needed)
```
Load `extension/` as an unpacked extension at `chrome://extensions` (Developer mode).

## Secrets

Never committed (see `.gitignore`):

- `extension/local-settings.js` — local OpenAI key / portal URL override
- `portal/.env` — Stripe, email provider, `AUTH_TOKEN_SECRET`
- `portal/data/kiddiegpt-db.json` — live runtime DB (API keys + parent/child PII)

Redacted/example variants are committed to show shape.
