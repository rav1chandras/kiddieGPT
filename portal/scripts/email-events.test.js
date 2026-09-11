const { test } = require("node:test");
const assert = require("node:assert/strict");
const { emailEvents } = require("../lib/email-events");
const { enqueueEmail, retryDelay, drainPostgres } = require("../lib/email-outbox");
const family = { id: "f1", email: "parent@example.com", parentName: "Parent", plan: "Family Monthly", currentPeriodEnd: "2027-01-01", parentalConsent: { acceptedAt: "2026-01-01", policyVersion: "v1" } };

test("account and billing audit events map to the intended templates", () => {
  for (const [action, key] of Object.entries({ "account.password.change": "password_changed", "auth.password_reset.complete": "password_changed", "privacy.parental_consent.accepted": "consent_receipt", "account.delete.request": "deletion_requested", "subscription.resume": "renewal_resumed", "subscription.upgrade_yearly": "yearly_upgrade", "subscription.cancel_requested": "cancellation_scheduled", "goal.completed": "goal_completed", "support.message": "op_new_support" })) {
    assert.equal(emailEvents(action, {}, family, "event")[0].key, key);
  }
  assert.deepEqual(emailEvents("auth.signup.otp_verified", {}, family, "event").map(x => x.key), ["welcome", "consent_receipt"]);
  assert.deepEqual(emailEvents("auth.login", {}, family, "event"), []);
});
test("email change notifies the old address", () => {
  assert.equal(emailEvents("account.email_change.complete", { oldEmail: "old@example.com", newEmail: "new@example.com" }, family, "event")[0].data.email, "old@example.com");
});
test("yearly refund sends refund and remaining-monthly details", () => {
  const events = emailEvents("subscription.cancel_refunded", { refundId: "r1", revertedToMonthlyUntil: "2027-01-01" }, family, "event");
  assert.deepEqual(events.map(x => x.key), ["refund_full", "monthly_restored"]);
  assert.equal(events[1].data.nextDate, "2027-01-01");
});
test("duplicate events share identity; pending messages remain queued", () => {
  const db = {};
  for (let i=0;i<2;i++) for (const e of emailEvents("refund.create", { refundId: "r1", amountCents: 100 }, family, String(i))) enqueueEmail(db, e);
  assert.equal(db.emailOutbox.length, 1);
  assert.equal(db.emailOutbox[0].state, "pending");
  assert.ok(retryDelay(2) > retryDelay(1));
});
test("Postgres delivery failure schedules retry instead of marking sent", async () => {
  const calls = [];
  const pool = { query: async (sql, args) => { calls.push({ sql, args }); return { rows: calls.length === 1 ? [{ id: "m1", payload: {}, attempts: 0 }] : [] }; } };
  assert.equal(await drainPostgres(pool, async () => { throw new Error("provider down"); }, 1), 0);
  assert.match(calls[1].sql, /state='pending'/);
  assert.ok(calls[1].args[1] > 0);
});
test("Postgres successful delivery removes recipient and body", async () => {
  const calls = [];
  const pool = { query: async (sql, args) => { calls.push({ sql, args }); return { rows: calls.length === 1 ? [{ id: "m1", payload: {}, attempts: 0 }] : [] }; } };
  assert.equal(await drainPostgres(pool, async () => {}, 1), 1);
  assert.match(calls[1].sql, /state='sent',payload='\{\}'/);
});
