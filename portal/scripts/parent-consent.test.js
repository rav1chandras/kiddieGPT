const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("recorded consent gates child profiles and learning tools across the full lifecycle", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kg-consent-test-"));
  Object.assign(process.env, {
    DB_DRIVER: "file", DATA_DIR: dir, DATA_PATH: path.join(dir, "state.json"),
    ADMIN_EMAIL: "admin@gmail.com", ADMIN_PASSWORD: "test-password",
    REQUIRE_AUTH: "true", STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "",
    POSTMARK_SERVER_TOKEN: "", SMTP_HOST: "", AUTOPILOT_ENABLED: "false", ACTIVITY_LOG: "off"
  });
  const { app, initPersistence } = require("../lib/app");
  await initPersistence();
  const server = app.listen(0);
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = () => JSON.parse(fs.readFileSync(process.env.DATA_PATH, "utf8"));
  const call = async (url, body, token, method = "POST", status = 200) => {
    const response = await fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(method !== "GET" ? { body: JSON.stringify(body || {}) } : {})
    });
    const data = await response.json();
    assert.equal(response.status, status, `${url}: ${JSON.stringify(data)}`);
    return data;
  };
  try {
    await call("/api/auth/signup", { email: "parent@gmail.com", name: "Test Parent", password: "test-password" });
    const otp = state().emailLogs[0].preview.match(/\b\d{6}\b/)[0];
    const parent = await call("/api/auth/verify-otp", { email: "parent@gmail.com", otp });
    const family = state().families.find(item => item.email === "parent@gmail.com");
    const profile = { children: [{ studentName: "Lena", grade: 5 }] };
    const entitlement = () => call("/api/entitlements/me", undefined, parent.token, "GET");
    const consent = () => call("/api/auth/me", undefined, parent.token, "GET");

    assert.equal((await consent()).family.parentalConsent.status, "pending");
    await call("/api/parent/family/profile", profile, parent.token, "PUT", 403);
    await call("/api/ai/responses", { tool: "math", input: "2+2" }, parent.token, "POST", 403);
    await call("/api/stripe/create-checkout-session", { planName: "Family Monthly" }, parent.token, "POST", 403);
    await call("/api/parent/consent", { accepted: true }, parent.token);
    assert.equal((await consent()).family.parentalConsent.status, "accepted");
    await call("/api/parent/family/profile", profile, parent.token, "PUT");
    assert.equal((await entitlement()).parentalConsent.status, "accepted");
    const childId = state().families.find(item => item.id === family.id).children[0].id;
    const capture = await call("/api/capture/session", { childId }, parent.token);

    const old = state();
    old.families.find(item => item.id === family.id).parentalConsent.policyVersion = "v1";
    fs.writeFileSync(process.env.DATA_PATH, JSON.stringify(old));
    assert.equal((await consent()).family.parentalConsent.status, "reconsent_required");
    await call("/api/ai/responses", { tool: "math", input: "2+2" }, parent.token, "POST", 403);
    await call("/api/parent/consent", { accepted: true }, parent.token);
    assert.equal((await consent()).family.parentalConsent.status, "accepted");

    await call("/api/parent/consent/withdraw", {}, parent.token);
    assert.equal((await consent()).family.parentalConsent.status, "withdrawn");
    assert.equal((state().emailOutbox || []).filter(item => item.key === "consent_withdrawn").length, 1);
    assert.equal((await entitlement()).childAccessAllowed, false);
    await call("/api/parent/family/profile", profile, parent.token, "PUT", 403);
    await call("/api/ai/responses", { tool: "math", input: "2+2" }, parent.token, "POST", 403);
    await call(`/api/capture/${capture.token}/image`, { image: "not-an-image" }, undefined, "POST", 403);
    assert.equal((await call("/api/parent/privacy", undefined, parent.token, "GET")).children.length, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
