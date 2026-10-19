const { test } = require("node:test");
const assert = require("node:assert/strict");
const { executeUpgrade } = require("../lib/billing-upgrade");
const { stopBilling, recoveryCandidates } = require("../lib/billing-stop");

test("bank verification is returned without cancelling yearly or modifying monthly, then completes once paid", async () => {
  let monthlyChanges = 0, payCalls = 0;
  let invoice = { id: "i", status: "open", payment_intent: { status: "requires_action" }, hosted_invoice_url: "https://invoice.stripe.com/test" };
  const op = { id: "auth", terms: {}, priceId: "p", scheduleId: "s", subscriptionId: "year", invoiceId: "i" };
  const stripe = {
    subscriptions: { retrieve: async () => ({}), update: async () => { monthlyChanges++; } },
    invoices: { retrieve: async () => invoice, pay: async () => { payCalls++; throw Error("Must not charge while authentication pending"); } },
    subscriptionSchedules: { cancel: async () => assert.fail("Must preserve pending authentication") }
  };
  const args = { stripe, op, save: async () => {} };
  const result = await executeUpgrade(args);
  assert.equal(result.requiresAction, true);
  assert.equal(result.paymentUrl, invoice.hosted_invoice_url);
  assert.equal(op.state, "requires_action");
  await executeUpgrade(args);
  assert.equal(monthlyChanges, 0); assert.equal(payCalls, 0);
  invoice = { ...invoice, status: "paid", amount_paid: 7500 };
  await executeUpgrade(args);
  assert.equal(monthlyChanges, 1);
});

test("authentication-required error from the first payment attempt is not treated as a decline", async () => {
  let attempted = false;
  const op = { id: "auth-first", terms: {}, priceId: "p", scheduleId: "s", subscriptionId: "year", invoiceId: "i" };
  const stripe = {
    subscriptions: { retrieve: async () => ({}), update: async () => assert.fail("Monthly unchanged") },
    invoices: {
      retrieve: async () => ({ status: "open", hosted_invoice_url: "https://invoice.stripe.com/test", payment_intent: { status: attempted ? "requires_action" : "requires_confirmation" } }),
      pay: async () => { attempted = true; throw Object.assign(Error("Authentication required"), { type: "StripeCardError" }); }
    }
  };
  assert.equal((await executeUpgrade({ stripe, op, save: async () => {} })).requiresAction, true);
});

test("billing stop voids unpaid invoices, releases schedules, deduplicates and cancels all subscriptions", async () => {
  const calls = [];
  const stripe = {
    invoices: { retrieve: async () => ({ status: "open" }), voidInvoice: async id => calls.push("void:" + id) },
    subscriptions: { retrieve: async id => ({ status: id === "ended" ? "canceled" : "active", schedule: id === "year" ? "schedule" : null }),
      cancel: async id => calls.push("cancel:" + id) },
    subscriptionSchedules: { release: async id => calls.push("release:" + id) }
  };
  await stopBilling({ stripe, subscriptionIds: ["month", "year", "month", "ended", "sub_mock_ignore"], invoiceId: "invoice" });
  assert.deepEqual(calls, ["void:invoice", "cancel:month", "release:schedule", "cancel:year"]);
  stripe.subscriptions.retrieve = async () => { throw Error("Stripe unavailable"); };
  await assert.rejects(stopBilling({ stripe, subscriptionIds: ["month"] }), /unavailable/);
});

test("recovery rotates unresolved accounts fairly and throttles parent refresh retries", () => {
  const now = Date.now();
  const families = Array.from({ length: 8 }, (_, i) => ({ email: "parent" + i, pendingUpgradeOperation: "op" + i }));
  for (const f of recoveryCandidates(families, now).slice(0, 5)) f.billingRecoveryAttemptAt = new Date(now).toISOString();
  assert.deepEqual(recoveryCandidates(families, now + 1000).map(f => f.email), ["parent5", "parent6", "parent7"]);
  assert.deepEqual(recoveryCandidates(families, now + 86400000).slice(0, 3).map(f => f.email), ["parent5", "parent6", "parent7"]);
  assert.equal(recoveryCandidates(families, now + 1000, "parent0").length, 0);
  assert.equal(recoveryCandidates(families, now + 61000, "parent0").length, 1);
});
