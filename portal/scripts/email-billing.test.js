const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { emailEvents } = require("../lib/email-events");
const { enqueueEmail } = require("../lib/email-outbox");
const policy = require("../lib/email-delivery-policy");

test("operation transitions queue authentication, pending refund, failure and decline notices once", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../lib/app.js"), "utf8");
  const db = { families: [{ id: "f", email: "parent@gmail.com", parentName: "Parent" }] };
  const context = { pgPool: null, mutateDb: fn => fn(db), queueTemplate: (store, key, data, id) => enqueueEmail(store, { id, key, ...data }) };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf("async function saveBillingOperation(op)"), source.indexOf("function billingKey(")), context);
  const cases = [
    { type: "upgrade", state: "requires_action", invoiceId: "in_auth", paymentUrl: "https://invoice.stripe.com/test" },
    { type: "upgrade", state: "failed", paymentDeclined: true },
    { type: "refund", state: "pending", refund: { id: "re_pending" }, amountCents: 1900 },
    { type: "refund", state: "failed", refund: { id: "re_failed" } }
  ];
  for (const [index, item] of cases.entries()) for (let n = 0; n < 2; n++) await context.saveBillingOperation({ id: "op"+index, familyId: "f", ...item });
  assert.deepEqual(db.emailOutbox.map(x => x.key), ["payment_verification", "yearly_upgrade_failed", "refund_pending", "op_refund_failed"]);
  assert.equal(db.emailOutbox[0].paymentUrl, cases[0].paymentUrl);
  assert.equal(db.emailOutbox[3].operator, true);
  await context.saveBillingOperation({ id: "abandoned", familyId: "f", type: "upgrade", state: "failed" });
  assert.equal(db.emailOutbox.length, 4, "User abandonment is not a declined charge");
});

test("promotions require separate routing and consent without suppressing transactional notices", () => {
  assert.throws(() => policy.messageStream("winback", {}), /broadcast/);
  assert.throws(() => policy.messageStream("low_usage", { POSTMARK_BROADCAST_STREAM: "outbound" }), /separate/);
  assert.equal(policy.messageStream("winback", { POSTMARK_BROADCAST_STREAM: "promotions" }), "promotions");
  assert.equal(policy.messageStream("payment_verification", {}), "outbound");
  assert.equal(policy.promotionalAllowed({}), false);
  assert.equal(policy.promotionalAllowed({ marketingConsent: { acceptedAt: "2026-10-01" } }), true);
  assert.equal(policy.promotionalAllowed({ marketingConsent: { acceptedAt: "2026-10-01", revokedAt: "2026-10-02" } }), false);
});

test("dispute notices use stable dispute/status identities", () => {
  const first = emailEvents("stripe.dispute", { disputeId: "dp1", status: "won" }, { id: "f" }, "evt1")[0];
  const retry = emailEvents("stripe.dispute", { disputeId: "dp1", status: "won" }, { id: "f" }, "evt2")[0];
  assert.equal(first.id, retry.id);
  assert.equal(first.data.operator, true);
});
