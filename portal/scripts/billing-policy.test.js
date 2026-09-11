const { test } = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../lib/billing-policy");
const { executeRefund } = require("../lib/billing-refund");
const { acquireBillingLock } = require("../lib/billing-lock");
const { executeUpgrade } = require("../lib/billing-upgrade");

test("24-hour refund window applies to every captured subscription payment, never a trial", () => {
  const now = Date.parse("2026-09-09T12:00:00Z");
  const f = { lastPaymentAt: new Date(now - 3600000).toISOString(), lastPaymentAmountCents: 1900, paymentStatus: "paid" };
  assert.equal(policy.refundWindow(f, now).eligible, true);
  assert.equal(policy.refundWindow(f, now + 23 * 3600000).eligible, false);
  assert.equal(policy.refundWindow({ ...f, paymentStatus: "trial" }, now).eligible, false);
  assert.equal(policy.refundWindow({ ...f, lastPaymentAmountCents: 0 }, now).eligible, false);
});
test("only two unique completed refund cancellations within 30 days start the 24-hour pause", () => {
  const now = Date.now(), f = {};
  policy.recordRefundCancellation(f, "p1", now);
  policy.recordRefundCancellation(f, "p1", now + 1000);
  assert.equal(policy.purchaseCooldown(f, now), null);
  policy.recordRefundCancellation(f, "p2", now + 2000);
  const until = f.purchasePausedUntil;
  policy.recordRefundCancellation(f, "p2", now + 9000);
  assert.equal(f.purchasePausedUntil, until);
  assert.ok(policy.purchaseCooldown(f, now + 3000));
  assert.equal(policy.purchaseCooldown(f, now + 86402000), null);
});
test("upgrade carries paid time and configured bonus months with calendar-safe dates", () => {
  const now = Date.parse("2026-01-10T12:00:00Z");
  const pricing = { yearly: { amount: 149, stripePriceId: "price_year" }, yearlyUpgrade: { enabled: true, bonusMonths: 3, discountAmount: 20 } };
  const terms = policy.upgradeTerms({ currentPeriodEnd: "2026-01-31T12:00:00Z", subscriptionStatus: "active" }, pricing, now);
  assert.equal(new Date(terms.endsAt * 1000).toISOString(), "2027-04-30T12:00:00.000Z");
  assert.equal(terms.amountCents, 12900);
  assert.equal(policy.upgradeTerms({ currentPeriodEnd: "2026-01-31", subscriptionStatus: "active" }, { ...pricing, yearlyUpgrade: { enabled: false, bonusMonths: 3 } }, now).bonusMonths, 0);
});
test("yearly refund restores original monthly IDs and paid dates without bonus accumulation", () => {
  const f = { yearlyUpgrade: { status: "scheduled", monthlyEndsAt: (Date.now()+86400000)/1000, monthlySubscriptionIds: ["sub_month"], monthlyPaymentId: "in_month", monthlyPaymentAmountCents: 1900 } };
  assert.equal(policy.restoreMonthly(f), true);
  assert.equal(f.stripeSubscriptionId, "sub_month");
  assert.equal(f.stripePaymentId, "in_month");
  assert.equal(f.subscriptionStatus, "cancel_scheduled");
  assert.equal(policy.restoreMonthly(f), false);
});
test("refund retry resumes cancellation without creating another refund; pending refunds do not remove access", async () => {
  const op = { id: "r1", createdAt: new Date().toISOString(), target: { payment_intent: "pi_1" }, amountCents: 1900, endAccess: true };
  let creates = 0, cancels = 0, finalized = 0;
  const stripe = { refunds: { list: async () => ({ data: [] }), create: async () => { creates++; return { id: "re_1", status: "pending" }; }, retrieve: async () => ({ id: "re_1", status: "succeeded" }) } };
  const args = { op, stripe, save: async () => {}, cancel: async () => { if (++cancels === 1) throw Error("Stripe timeout"); }, finalize: async () => { finalized++; return { ok: true }; } };
  assert.equal((await executeRefund(args)).status, "pending");
  assert.equal(finalized, 0);
  await assert.rejects(executeRefund(args), /timeout/);
  assert.deepEqual(await executeRefund(args), { ok: true });
  await executeRefund(args);
  assert.equal(creates, 1);
  assert.equal(finalized, 1);
});
test("concurrent billing operations cannot obtain the same lock", async () => {
  const release = await acquireBillingLock(null, "family");
  assert.equal(await acquireBillingLock(null, "family"), null);
  await release();
  await (await acquireBillingLock(null, "family"))();
});
test("paid Stripe upgrade invoices once and defers standard renewal until exact paid-through date", async () => {
  let schedulePayload, monthlyChanges = 0, schedules = 0;
  const invoice = { id: "in_year", status: "paid", amount_paid: 7500 };
  const stripe = {
    prices: { retrieve: async () => ({ product: "prod", currency: "usd" }), create: async () => ({ id: "offer" }) },
    subscriptionSchedules: { create: async payload => { schedules++; schedulePayload = payload; return { id: "sched", subscription: { id: "sub_year", latest_invoice: invoice } }; } },
    subscriptions: { retrieve: async () => ({ latest_invoice: invoice }), update: async () => { monthlyChanges++; } },
    invoices: { retrieve: async () => invoice }
  };
  const op = { id: "upgrade", createdAt: new Date().toISOString(), terms: { priceId: "year", amountCents: 7500, endsAt: 1900000000, accessMonths: 15 }, monthlySubscriptionId: "sub_month" };
  await executeUpgrade({ stripe, op, save: async () => {} });
  await executeUpgrade({ stripe, op, save: async () => {} });
  assert.equal(schedules, 1);
  assert.equal(schedulePayload.phases[0].trial_end, 1900000000);
  assert.equal(schedulePayload.phases[0].add_invoice_items[0].price, "offer");
  assert.equal(schedulePayload.phases[1].items[0].price, "year");
  assert.equal(schedulePayload.phases[1].start_date, undefined, "Stripe create infers the next phase start from the preceding end");
  assert.ok(monthlyChanges);
});
test("unconfirmed yearly invoice never changes the monthly subscription", async () => {
  const op = { id: "u", createdAt: new Date().toISOString(), terms: {}, priceId: "p", scheduleId: "s", subscriptionId: "y", invoiceId: "i" };
  const stripe = { subscriptions: { retrieve: async () => ({}), update: async () => assert.fail("must not change monthly") }, invoices: { retrieve: async () => ({ status: "uncollectible" }) } };
  await assert.rejects(executeUpgrade({ stripe, op, save: async () => {} }), /not confirmed/);
});

test("trial upgrade keeps the original deadline and bills the offer once with standard yearly renewal", async () => {
  let payload, price;
  const stripe = {
    prices: { retrieve: async () => ({ product: "prod", currency: "usd" }), create: async input => { price = input; return { id: "offer" }; } },
    subscriptions: { retrieve: async () => ({ id: "monthly", items: { data: [{ price: { id: "price_month" } }] } }) },
    subscriptionSchedules: { create: async () => ({ id: "schedule", phases: [{ start_date: 1700000000 }] }), update: async (id, input) => { payload = input; return { subscription: "monthly" }; } }
  };
  const op = { id: "trial-switch", createdAt: new Date().toISOString(), terms: { trialing: true, amountCents: 7500, priceId: "year", startsAt: 1700604800, endsAt: 1740000000 }, monthlySubscriptionId: "monthly" };
  await executeUpgrade({ stripe, op, save: async () => {} });
  assert.equal(price.unit_amount, 7500);
  assert.equal(price.recurring, undefined);
  assert.equal(payload.phases[0].trial_end, op.terms.startsAt);
  assert.equal(payload.phases[1].add_invoice_items[0].price, "offer");
  assert.equal(payload.phases[1].trial_end, op.terms.endsAt);
  assert.equal(payload.phases[2].items[0].price, "year");
});

test("a confirmed card decline removes the failed yearly schedule without touching monthly", async () => {
  let cancelled = 0, voided = 0;
  const op = { id: "declined", createdAt: new Date().toISOString(), priceId: "offer", terms: {}, scheduleId: "sched", subscriptionId: "year", invoiceId: "in_year" };
  const stripe = {
    subscriptions: { retrieve: async () => ({}), update: async () => assert.fail("Monthly must be unchanged") },
    subscriptionSchedules: { cancel: async () => { cancelled++; } },
    invoices: { retrieve: async () => ({ id: "in_year", status: "open" }), pay: async () => { throw Object.assign(Error("Card declined"), { type: "StripeCardError" }); }, voidInvoice: async () => { voided++; } }
  };
  await assert.rejects(executeUpgrade({ stripe, op, save: async () => {} }), /declined/);
  assert.equal(op.state, "failed");
  assert.equal(cancelled, 1); assert.equal(voided, 1);
});
