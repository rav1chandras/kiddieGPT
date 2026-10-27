const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("parent and admin immediate cancellations refund a recent payment, but scheduled cancellation does not", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kg-admin-refund-"));
  Object.assign(process.env, {
    DB_DRIVER: "file", DATA_DIR: dir, DATA_PATH: path.join(dir, "state.json"),
    ADMIN_EMAIL: "admin@gmail.com", ADMIN_PASSWORD: "test-password", REQUIRE_AUTH: "true",
    STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "", POSTMARK_SERVER_TOKEN: "",
    SMTP_HOST: "", AUTOPILOT_ENABLED: "false", ACTIVITY_LOG: "off"
  });
  const { app, initPersistence } = require("../lib/app");
  await initPersistence();
  const server = app.listen(0);
  await new Promise(resolve => server.once("listening", resolve));
  const state = () => JSON.parse(fs.readFileSync(process.env.DATA_PATH));
  const family = () => state().families.find(item => item.email === "billing@gmail.com");
  const call = async (url, body, token) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body)
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  const seed = (paymentId, hoursAgo = 1) => {
    const db = state();
    const item = db.families.find(entry => entry.email === "billing@gmail.com");
    Object.assign(item, {
      plan: "Family Monthly", subscriptionStatus: "active", paymentStatus: "paid",
      stripeSubscriptionId: `sub_mock_${paymentId}`, stripePaymentId: `pi_mock_${paymentId}`,
      lastPaymentAt: new Date(Date.now() - hoursAgo * 3600000).toISOString(),
      lastPaymentAmountCents: 1000, currentPeriodEnd: new Date(Date.now() + 29 * 86400000).toISOString(),
      trialUsedAt: new Date(Date.now() - 10 * 86400000).toISOString(),
      refunds: [], pendingRefundOperation: "", refundPending: null,
      cancellationStatus: "", cancellationRequested: false, cancelAtPeriodEnd: false
    });
    fs.writeFileSync(process.env.DATA_PATH, JSON.stringify(db));
  };
  try {
    await call("/api/auth/signup", { email: "billing@gmail.com", name: "Billing Parent", password: "test-password", parentalConsent: true }, "");
    const code = state().emailLogs[0].preview.match(/\b\d{6}\b/)[0];
    const parent = await call("/api/auth/verify-otp", { email: "billing@gmail.com", otp: code }, "");
    const admin = await call("/api/auth/login", { email: "admin@gmail.com", password: "test-password", role: "admin" }, "");

    seed("parent");
    const parentResult = await call("/api/stripe/request-cancellation", { reason: "Changed mind" }, parent.token);
    assert.equal(parentResult.refunded, true);
    assert.equal(family().paymentStatus, "refunded");
    assert.equal(family().subscriptionStatus, "cancelled");

    seed("admin_toggle");
    const toggle = await call(`/api/admin/users/${family().id}/subscription-toggle`, { action: "end" }, admin.token);
    assert.equal(toggle.refund.refunded, true);
    assert.equal(family().refunds.length, 1);
    assert.equal(family().subscriptionStatus, "cancelled");

    seed("admin_action");
    const immediate = await call("/api/admin/subscription-action", { email: "billing@gmail.com", action: "end_now" }, admin.token);
    assert.equal(immediate.refund.refunded, true);
    assert.equal(family().paymentStatus, "refunded");

    seed("scheduled");
    await call("/api/admin/subscription-action", { email: "billing@gmail.com", action: "cancel" }, admin.token);
    assert.equal(family().subscriptionStatus, "cancel_scheduled");
    assert.equal(family().refunds.length, 0);
    assert.equal(family().paymentStatus, "paid");

    seed("old", 25);
    const outside = await call(`/api/admin/users/${family().id}/subscription-toggle`, { action: "end" }, admin.token);
    assert.equal(outside.refund, undefined);
    assert.equal(family().refunds.length, 0);
    assert.equal(family().subscriptionStatus, "cancelled");

    const oldCheckout = { id: "cs_mock_old", customer: "cus_mock_old", subscription: "sub_mock_old",
      customer_email: "billing@gmail.com", metadata: { familyId: family().id, planName: "Family Monthly" } };
    await call("/api/stripe/webhook", {
      id: "evt_old_checkout_after_admin_end", type: "checkout.session.completed",
      created: Math.floor(Date.parse(family().cancelledAt) / 1000) - 60,
      data: { object: oldCheckout }
    }, "");
    assert.equal(family().subscriptionStatus, "cancelled", "An earlier checkout cannot restart an ended plan");
    await call("/api/stripe/webhook", {
      id: "evt_old_active_after_admin_end", type: "customer.subscription.updated",
      created: Math.floor(Date.parse(family().cancelledAt) / 1000) - 30,
      data: { object: { id: family().stripeSubscriptionId, status: "active", customer: family().stripeCustomerId } }
    }, "");
    assert.equal(family().subscriptionStatus, "cancelled", "An earlier active event cannot restart an ended plan");
    await call("/api/stripe/webhook", {
      id: "evt_old_trial_after_payment", type: "customer.subscription.updated",
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: family().stripeSubscriptionId, status: "trialing", customer: family().stripeCustomerId } }
    }, "");
    assert.equal(family().subscriptionStatus, "cancelled", "A late trial event cannot erase a paid cancellation");
    const entitlementResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/entitlements/me`, {
      headers: { Authorization: `Bearer ${parent.token}` }
    });
    const entitlement = await entitlementResponse.json();
    assert.equal(entitlement.active, false);
    assert.equal(entitlement.trial.status, "");
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
