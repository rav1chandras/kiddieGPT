# Subscription and refund policy

- One seven-day, card-upfront free trial per account. No subscription charge during the trial; cancellation ends trial access immediately.
- Switching a monthly trial to yearly preserves its original trial end. The accepted yearly offer is billed at that time, including the configured bonus months.
- A paid monthly upgrade charges the yearly offer now. Its first renewal is the original monthly paid-through date plus 12 calendar months plus bonus months. There is no additional monthly credit or refund.
- Every captured subscription payment has a 24-hour self-service accidental-charge refund window, including the first post-trial charge, renewals and upgrades. There is no separate seven-day money-back window.
- Otherwise cancellation turns off renewal and retains paid access. Keep my plan is available before expiration; a monthly plan scheduled to cancel can still upgrade.
- A full yearly-upgrade refund removes its yearly/bonus term and restores only remaining, separately paid monthly access, with renewal off. Keep my plan resumes the original monthly subscription. Historical and partial refunds do not remove current access.
- After two distinct completed refund cancellations in a rolling 30-day window, new purchases and upgrades pause for 24 hours. Repeated clicks, partial goodwill refunds and ordinary renewal cancellations do not count. Cancellation and resume are not blocked.
- Bonus months apply only to the first yearly term. Accepted price, note, bonus months and renewal price are snapshotted. A refunded upgrade cannot accumulate bonus months on retry. Returning accounts do not get another trial.

## Implementation

`billing-policy.js` contains dates, refund eligibility and cooldown rules. `billing-upgrade.js` and `billing-refund.js` execute resumable Stripe operations with stable idempotency keys.

The extended paid term uses a one-time invoice item and defers the standard recurring yearly price to the exact paid-through date. Stripe reports this deferral as `trialing`; the portal distinguishes a paid deferral from an introductory free trial using the confirmed upgrade record. Offers exceeding Stripe's 730-day deferral ceiling are rejected before billing.

`billing_operations` stores operation progress in Postgres; the file driver uses `billingOperations`. A separate advisory-lock connection pool serializes billing per parent across instances without exhausting the data connection pool. State writes merge changed fields under a row lock so a concurrent profile save cannot overwrite completed billing changes. API requests refresh the cached state.

Refunds stop renewal first, but access is not removed until Stripe confirms refund success and the necessary cancellation succeeds. Pending/failed operations remain visible for admin review. The lifecycle sweep retries recoverable operations. An ambiguous request older than Stripe's idempotency retention window requires reconciliation instead of a new charge/refund.

Admin > Billing > Payments supports full-remaining and partial refunds with a required reason. Billing > Refunds provides searchable history, pending statuses and review/retry. Refund notices are queued only after completion. Both admin refund entry points use the same service as parent cancellation.

## Verification

Run `node --test scripts/*.test.js` from `portal` for the isolated route and service tests.

Optional tests:

- `BILLING_TEST_DATABASE_URL=... node --test scripts/billing-postgres.test.js` uses a disposable local Postgres database and two server processes. Do not point it at application data.
- `PLAYWRIGHT_MODULE=... node --test scripts/billing-visual.test.js` checks the admin refund UI against isolated local fixtures on desktop/mobile.
- `BILLING_STRIPE_TEST_KEY=... node --test scripts/billing-stripe-sandbox.test.js` creates disposable Stripe test customers and a test clock, then cleans them up. Only test-mode keys are accepted.

Verified on September 10, 2026: isolated service/route tests, two-server Postgres locking, desktop/mobile refund controls, and real Stripe test-mode paid upgrades, repeat-request invoice deduplication, full upgrade refunds with the monthly subscription retained, trial conversion at the original deadline, and the scheduled standard yearly renewal price/date.

Before production rollout, complete sandbox acceptance for zero-price offers, payments requiring authentication, declined cards, partial/pending refunds, delayed webhooks, month-end carry-over, and collection of the eventual standard renewal. Some of these paths have local fake-service coverage, but that does not certify Stripe account configuration, tax settings or actual payment processing.
