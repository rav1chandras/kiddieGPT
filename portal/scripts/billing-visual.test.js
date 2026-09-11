const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("admin refund controls and history render and work on desktop and mobile", { skip: !process.env.PLAYWRIGHT_MODULE }, async () => {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kg-billing-visual-"));
  Object.assign(process.env, { DB_DRIVER: "file", DATA_DIR: dir, DATA_PATH: path.join(dir, "state.json"), ADMIN_EMAIL: "admin@gmail.com", ADMIN_PASSWORD: "test-password", REQUIRE_AUTH: "true", STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "", POSTMARK_SERVER_TOKEN: "", SMTP_HOST: "", AUTOPILOT_ENABLED: "false" });
  const { app, initPersistence } = require("../lib/app");
  await initPersistence();
  const db = JSON.parse(fs.readFileSync(process.env.DATA_PATH));
  db.families.push({ id: "visual-family", email: "billing.preview@gmail.com", parentName: "Billing Preview", plan: "Family Monthly", subscriptionStatus: "active", paymentStatus: "paid", stripeSubscriptionId: "sub_mock_preview", stripePaymentId: "pi_mock_preview", lastPaymentAt: new Date().toISOString(), lastPaymentAmountCents: 1900, currentPeriodEnd: new Date(Date.now()+86400000*25).toISOString(), children: [], refunds: [] });
  db.payments.push({ id: "preview-pay", paymentId: "pi_mock_preview", familyId: "visual-family", email: "billing.preview@gmail.com", amountCents: 1900, status: "paid", type: "invoice.paid", createdAt: new Date().toISOString() });
  fs.writeFileSync(process.env.DATA_PATH, JSON.stringify(db));
  const server = app.listen(0);
  await new Promise(r => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    const auth = await (await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@gmail.com", password: "test-password", role: "admin" }) })).json();
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(token => { localStorage.setItem("kiddiegptAdminToken", token); localStorage.setItem("kiddiegptAdminView", "billing"); }, auth.token);
    await page.goto(base + "/admin.html");
    await page.locator("[data-admin-view='billing']").click();
    await page.locator("#payment-search").fill("billing.preview");
    await page.locator("[data-payment-expand='refund']").click();
    await page.locator("[data-refund-type]").selectOption("partial");
    await page.locator("[data-refund-amount]").fill("5");
    await page.locator("[data-refund-reason]").fill("Goodwill refund for support review");
    await page.locator(".refund-confirm-box").scrollIntoViewIfNeeded();
    await page.screenshot({ path: "/tmp/kiddiegpt-refund-desktop.png", fullPage: true });
    await page.locator("[data-payment-action='refund']").click();
    await page.locator("[data-refund-status]").filter({ hasText: "Refund completed" }).waitFor();
    await page.locator("[data-payment-table='refunds']").click();
    await page.locator("#refund-search").fill("billing.preview");
    assert.match(await page.locator("#refund-table").innerText(), /\$5(?:\.00)?\s/);
    await page.screenshot({ path: "/tmp/kiddiegpt-refund-history.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "/tmp/kiddiegpt-refund-mobile.png", fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true });
  }
});
