const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("admin cancel renewal preserves current access and can be reversed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kg-admin-renewal-"));
  Object.assign(process.env, {
    DB_DRIVER: "file", DATA_DIR: dir, DATA_PATH: path.join(dir, "state.json"),
    ADMIN_EMAIL: "admin@gmail.com", ADMIN_PASSWORD: "test-password",
    REQUIRE_AUTH: "true", STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "",
    POSTMARK_SERVER_TOKEN: "", SMTP_HOST: "", AUTOPILOT_ENABLED: "false", ACTIVITY_LOG: "off"
  });
  const { app, initPersistence } = require("../lib/app");
  await initPersistence();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const state = () => JSON.parse(fs.readFileSync(process.env.DATA_PATH));
  const call = async (route, body, token, expectedStatus = 200) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body)
    });
    const result = await response.json();
    assert.equal(response.status, expectedStatus, JSON.stringify(result));
    return result;
  };
  try {
    await call("/api/auth/signup", { email: "renewal@gmail.com", name: "Renewal Parent", password: "test-password", parentalConsent: true });
    const admin = await call("/api/auth/login", { email: "admin@gmail.com", password: "test-password", role: "admin" });
    const db = state();
    const family = db.families.find((item) => item.email === "renewal@gmail.com");
    const periodEnd = new Date(Date.now() + 30 * 86400000).toISOString();
    Object.assign(family, {
      plan: "Family Monthly", subscriptionStatus: "active", paymentStatus: "paid",
      stripeSubscriptionId: "sub_mock_renewal", currentPeriodEnd: periodEnd
    });
    fs.writeFileSync(process.env.DATA_PATH, JSON.stringify(db));

    const canceled = await call("/api/admin/subscription-action", { action: "cancel", email: family.email }, admin.token);
    assert.equal(canceled.action, "cancel");
    assert.equal(state().families.find((item) => item.id === family.id).subscriptionStatus, "cancel_scheduled");
    assert.equal(Date.parse(state().families.find((item) => item.id === family.id).cancelAccessUntil), Date.parse(periodEnd));
    await call("/api/admin/subscription-action", { action: "cancel", email: family.email }, admin.token, 409);

    await call("/api/admin/subscription-action", { action: "keep", email: family.email }, admin.token);
    assert.equal(state().families.find((item) => item.id === family.id).subscriptionStatus, "active");
    await call("/api/admin/subscription-action", { action: "keep", email: family.email }, admin.token, 409);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
