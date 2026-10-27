const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("launch-priced trials show the first charge and cannot replace it with a save offer", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kg-trial-price-"));
  Object.assign(process.env, {
    DB_DRIVER: "file", DATA_DIR: dir, DATA_PATH: path.join(dir, "state.json"),
    REQUIRE_AUTH: "true", STRIPE_SECRET_KEY: "", POSTMARK_SERVER_TOKEN: "",
    SMTP_HOST: "", AUTOPILOT_ENABLED: "false", ACTIVITY_LOG: "off"
  });
  const { app, initPersistence } = require("../lib/app");
  await initPersistence();
  const server = app.listen(0);
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = () => JSON.parse(fs.readFileSync(process.env.DATA_PATH));
  const post = async (url, body, token, expected = 200) => {
    const response = await fetch(base + url, {
      method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    assert.equal(response.status, expected, JSON.stringify(data));
    return data;
  };
  try {
    const db = state();
    db.pricing.monthly.amount = 15;
    db.pricing.promotion.monthlyAmount = 10;
    db.pricing.cancellationPromo.amountOff = 5;
    fs.writeFileSync(process.env.DATA_PATH, JSON.stringify(db));
    await post("/api/auth/signup", { email: "trial.price@gmail.com", name: "Trial Parent", password: "test-password" });
    const code = state().emailLogs[0].preview.match(/\b\d{6}\b/)[0];
    const { token } = await post("/api/auth/verify-otp", { email: "trial.price@gmail.com", otp: code });
    await post("/api/parent/consent", { accepted: true }, token);
    const checkout = await post("/api/stripe/create-checkout-session", { planName: "Family Monthly" }, token);
    await post("/api/stripe/confirm-checkout-session", { sessionId: checkout.sessionId });
    const response = await fetch(base + "/api/entitlements/me", { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    const entitlement = await response.json();
    assert.equal(entitlement.status, "trialing");
    assert.equal(entitlement.trial.firstChargeCents, 1000);
    assert.equal(entitlement.trial.regularChargeCents, 1500);
    assert.equal(entitlement.trial.launchDiscountApplied, true);
    assert.equal(entitlement.retentionOfferAvailable, false);
    await post("/api/stripe/apply-retention-discount", {}, token, 409);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
