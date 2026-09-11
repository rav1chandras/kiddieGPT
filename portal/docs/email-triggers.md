# Email trigger map

All templates use the shared grayscale HTML layout and a plain-text alternative.

| Template | Trigger |
| --- | --- |
| verify_email | Signup or resend verification code |
| sign_in_code | Extension/passwordless sign-in code request |
| welcome | Successful signup verification or new Google account |
| password_reset | Password-reset code request |
| password_changed | Successful reset or account password change |
| confirm_new_email | Request to change email |
| email_changed | Successful email change; sent to the old address |
| consent_receipt | Signup verification or explicit parental consent acceptance |
| payment_receipt | Positive paid Stripe invoice, deduplicated by invoice ID |
| yearly_upgrade | Successful yearly upgrade or monthly-trial switch to yearly |
| payment_failed | Failed Stripe invoice |
| payment_retry | Existing dunning reminder schedule |
| access_paused | Dunning suspension |
| renewal_reminder | Active auto-renewing plan within three days of its period end |
| refund_full | Full refund from cancellation, admin action, or refund webhook |
| refund_partial | Partial refund from admin action or refund webhook |
| monthly_restored | Yearly refund with remaining monthly access |
| renewal_resumed | Parent/admin keep-plan action or Stripe renewal re-enabled; once per period |
| weekly_summary | Existing weekly schedule and parent opt-in; actual family usage |
| finish_setup | Existing setup-nudge schedule |
| low_usage | Active account with no recorded activity for 14 days; at most every 30 days |
| goal_completed | Goal changes to completed on profile save; deduplicated by child/goal/reward |
| cancellation_scheduled | Parent/admin cancellation or Stripe cancellation scheduled |
| subscription_ended | Immediate end, finalized cancellation, Stripe deletion, or reconciliation |
| winback | Existing post-cancellation winback schedule; no invented discount |
| support_reply | Admin reply; failures are queued for retry |
| deletion_requested | Parent requests account deletion |
| deletion_completed | Admin anonymization; final notice goes to the original address |
| trial_started | Admin trial grant or card-upfront checkout trial |
| trial_ending | Existing trial-ending reminder schedule |
| trial_ended | No-card trial expires |
| op_new_paid | First positive paid invoice per family |
| op_new_support | New parent support message |

## Delivery

- OTPs send immediately, never enter the retry queue, and keep their existing expiry.
- Notifications are queued alongside their business mutation. Mutating requests and the lifecycle sweep drain the queue. Mock mode leaves queued notifications pending.
- Production uses an `email_deliveries` Postgres table with a unique notification ID and atomic claims. The local file driver uses `emailOutbox`.
- Failed notifications retry with bounded exponential backoff when another drain runs. The cron schedule determines retry frequency when there is no traffic.
- Sent Postgres entries retain deduplication IDs but clear recipient/body payloads. Old queued learning notifications are suppressed after anonymization.
- Delivery is at-least-once: a provider accepting an email followed by a lost response or process crash can still cause a duplicate. It is not an exactly-once guarantee.
- Operator notices use `ADMIN_NOTIFY_EMAIL`, falling back to `ADMIN_EMAIL`.
- Configure Postmark token, verified sender, correct `PUBLIC_ORIGIN`, and cron before live validation. Engagement/winback traffic must use an appropriate provider stream and consent/preferences policy before commercial launch.

## Verification

`node --test scripts/email-templates.test.js scripts/email-events.test.js scripts/email-integration.test.js`

These tests do not contact Postmark or live Stripe. The integration test uses an isolated temporary file database and mock webhooks. Real inbox/client rendering and a real Postgres delivery acceptance test remain release checks.
