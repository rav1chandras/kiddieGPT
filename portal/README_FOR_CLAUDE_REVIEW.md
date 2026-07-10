# KiddieGPT Portal V1 Review Bundle

This bundle contains the parent/admin portal source, Docker config, frontend assets, and sanitized runtime examples.

Included for review:
- `server.js` backend API and Stripe/Postmark/auth flow
- `webapp/` parent and admin portal UI
- `docker-compose.yml`, `Dockerfile`, `package.json`
- `.env.example` and `.env.redacted` for config shape
- `data/kiddiegpt-db.example.json` for empty seed shape
- `data/kiddiegpt-db.redacted.json` for current local state shape with secrets, PII, and Stripe IDs scrubbed

Not included:
- raw `.env`
- raw `data/kiddiegpt-db.json`
- `node_modules`, `.git`, previous zip snapshots

Suggested review focus:
1. Subscription lifecycle correctness: checkout, upgrade, cancellation, refunds, admin overrides.
2. Auth/session safety and account deletion/anonymization flow.
3. Stripe webhook idempotency and failure handling.
4. Admin console usability for a solo operator.
5. Production readiness gaps before launch.
