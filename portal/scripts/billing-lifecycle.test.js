const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("parent and admin routes preserve trials, rollback monthly access, enforce cooldown and partial refunds", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kg-billing-"));
  Object.assign(process.env, { DB_DRIVER: "file", DATA_DIR: dir, DATA_PATH: path.join(dir, "state.json"), ADMIN_EMAIL: "admin@gmail.com", ADMIN_PASSWORD: "test-password", REQUIRE_AUTH: "true", STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "", POSTMARK_SERVER_TOKEN: "", SMTP_HOST: "", AUTOPILOT_ENABLED: "false", ACTIVITY_LOG: "off" });
  const { app, initPersistence, runLifecycleSweep } = require("../lib/app");
  await initPersistence();
  const server = app.listen(0);
  await new Promise(r => server.once("listening", r));
  const state = () => JSON.parse(fs.readFileSync(process.env.DATA_PATH));
  const edit = fn => { const db = state(); fn(db); fs.writeFileSync(process.env.DATA_PATH, JSON.stringify(db)); };
  const call = async (url, body, token, status = 200) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}` + url, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body) });
    const data = await res.json(); assert.equal(res.status, status, JSON.stringify(data)); return data;
  };
  try {
    await call("/api/auth/signup", { email: "billing@gmail.com", name: "Billing Parent", password: "test-password", parentalConsent: true });
    const code = state().emailLogs[0].preview.match(/\b\d{6}\b/)[0];
    const { token } = await call("/api/auth/verify-otp", { email: "billing@gmail.com", otp: code });
    const family = () => state().families.find(f => f.email === "billing@gmail.com");
    const seedMonthly = () => edit(db => {
      const f = db.families.find(f => f.email === "billing@gmail.com");
      Object.assign(f, { plan: "Family Monthly", subscriptionStatus: "active", paymentStatus: "paid", stripeSubscriptionId: "sub_mock_month", stripePaymentId: "pi_mock_month", lastPaymentAmountCents: 1900, lastPaymentAt: new Date(Date.now()-10*86400000).toISOString(), currentPeriodEnd: new Date(Date.now()+20*86400000).toISOString(), trialUsedAt: new Date().toISOString() });
      db.pricing.yearly.stripePriceId = "price_year";
      db.pricing.yearlyUpgrade = { enabled: true, bonusMonths: 3, discountAmount: 10, note: "Family offer" };
    });
    seedMonthly();
    const originalEnd = family().currentPeriodEnd;
    const upgraded = await call("/api/stripe/upgrade-yearly", { bonusMonths: 999, yearlyPriceId: "tampered" }, token);
    assert.equal(upgraded.bonusMonths, 3);
    assert.equal(family().yearlyUpgrade.monthlyPaymentId, "pi_mock_month");
    await call("/api/stripe/upgrade-yearly", {}, token, 409);
    const refund = await call("/api/stripe/request-cancellation", { reason: "Changed mind" }, token);
    assert.equal(refund.refunded, true);
    assert.equal(family().stripeSubscriptionId, "sub_mock_month");
    assert.equal(Date.parse(family().currentPeriodEnd), Math.floor(Date.parse(originalEnd) / 1000) * 1000);
    assert.equal(family().subscriptionStatus, "cancel_scheduled");
    await call("/api/stripe/webhook", { id: "evt_old_year_deleted", type: "customer.subscription.deleted", data: { object: { id: upgraded.yearlySubscriptionId || "sub_mock_old_year", customer: family().stripeCustomerId, metadata: { familyId: family().id }, status: "canceled" } } });
    assert.equal(family().stripeSubscriptionId, "sub_mock_month");
    assert.equal(family().subscriptionStatus, "cancel_scheduled");
    const repeated = await call("/api/stripe/request-cancellation", {}, token);
    assert.equal(repeated.alreadyScheduled, true);
    await call("/api/stripe/resume-subscription", {}, token);
    assert.equal(family().subscriptionStatus, "active");
    await call("/api/stripe/upgrade-yearly", {}, token);
    await call("/api/stripe/request-cancellation", {}, token);
    assert.equal(family().refundCancellationHistory.length, 2);
    await call("/api/stripe/upgrade-yearly", {}, token, 429);
    await call("/api/stripe/create-checkout-session", { parentEmail: "billing@gmail.com", planName: "Family Monthly" }, token, 429);
    await call("/api/stripe/resume-subscription", {}, token);
    assert.equal(family().subscriptionStatus, "active");
    const admin = await call("/api/auth/login", { email: "admin@gmail.com", password: "test-password", role: "admin" });
    const partial = { email: "billing@gmail.com", paymentIntentId: "pi_mock_month", fullRefund: false, amountCents: 500, requestId: "partial-1", reason: "Goodwill" };
    await call("/api/stripe/refund", partial, admin.token);
    const count = family().refunds.length;
    await call("/api/stripe/refund", partial, admin.token);
    assert.equal(family().refunds.length, count);
    assert.equal(family().subscriptionStatus, "active");
    await call("/api/stripe/refund", { ...partial, amountCents: 2000, requestId: "too-much" }, admin.token, 502);
    const partialRecord = family().refunds[0];
    await call("/api/stripe/webhook", { id: "evt_partial", type: "charge.refunded", data: { object: { id: "ch_mock_month", object: "charge", metadata: { familyId: family().id }, payment_intent: "pi_mock_month", amount: 1900, amount_refunded: 500, refunds: { data: [{ id: partialRecord.refundId, status: "succeeded", amount: 500 }] } } } });
    assert.equal(family().subscriptionStatus, "active");
    // Trial switch preserves the trial deadline, configured offer and no charge.
    edit(db => {
      const f = db.families.find(f => f.email === "billing@gmail.com");
      Object.assign(f, { plan: "Family Monthly", subscriptionStatus: "trialing", paymentStatus: "trial", trialEndsAt: new Date(Date.now()+3*86400000).toISOString(), yearlyUpgrade: null, purchasePausedUntil: "", pendingRefundOperation: "", refundedAt: "" });
    });
    const trialEnd = family().trialEndsAt;
    const trial = await call("/api/stripe/upgrade-yearly", {}, token);
    assert.equal(trial.trialing, true);
    assert.equal(family().trialEndsAt, trialEnd);
    assert.equal(family().paymentStatus, "trial");
    assert.equal(family().yearlyUpgrade.bonusMonths, 3);
    const cancelTrial = await call("/api/stripe/request-cancellation", {}, token);
    assert.equal(cancelTrial.refunded, false);
    assert.equal(family().subscriptionStatus, "cancelled");
    const checkout = await call("/api/stripe/create-checkout-session", { parentEmail: "billing@gmail.com", planName: "Family Monthly" }, token);
    assert.equal(checkout.trialDays, 0);
    seedMonthly();
    edit(db => {
      const f = db.families.find(f => f.email === "billing@gmail.com");
      f.yearlyUpgrade = null; f.subscriptionStatus = "cancel_scheduled";
      f.cancelAccessUntil = new Date(Date.now()-1000).toISOString();
      f.cancellationAccessUntil = f.cancelAccessUntil;
      f.currentPeriodEnd = f.cancelAccessUntil;
    });
    await runLifecycleSweep("test");
    assert.equal(family().subscriptionStatus, "cancelled");
  } finally {
    await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true });
  }
});
