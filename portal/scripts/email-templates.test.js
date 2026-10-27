const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const appPath = path.join(__dirname, "../lib/app.js");
const source = fs.readFileSync(appPath, "utf8");
const box = { require: createRequire(appPath), process: { env: { PUBLIC_ORIGIN: "https://example.test", EMAIL_OTP_TTL_MINUTES: "10" } } };
vm.createContext(box);
vm.runInContext(source.slice(source.indexOf("function escHtml(value)"), source.indexOf("// Optional engagement emails")), box);
const render = (key, data) => box.renderTemplate(key, data);
const sample = vm.runInContext("EMAIL_SAMPLE", box);
const keys = vm.runInContext("EMAIL_TEMPLATES.map(t => t.key)", box);

test("all 42 templates render HTML and meaningful plain text", () => {
  assert.equal(keys.length, 42);
  for (const key of keys) {
    const result = render(key, sample);
    assert.ok(result.text.length > 100, key);
    assert.ok(result.html.includes("/webapp/assets/email-logo.png"), key);
    assert.doesNotMatch(result.html + result.text, /undefined|\[object Object\]/, key);
    const outsidePill = result.html.replace(/<span style="display:inline-block;padding:7px 10px[\s\S]*?<\/span>/, "");
    for (const [hex] of outsidePill.matchAll(/#[\da-f]{6}\b|#[\da-f]{3}\b/gi)) {
      const color = hex.slice(1);
      const parts = color.length === 3 ? [...color] : color.match(/../g);
      assert.ok(parts.every(c => c === parts[0]), `${key}: non-grayscale ${hex}`);
    }
  }
});

test("real renders do not inherit preview identities or discounts", () => {
  const result = render("winback", { parentName: "Jordan" });
  assert.doesNotMatch(result.text, /Meena|Ava|20%|August|0%/);
  assert.match(result.text, /Jordan/);
});

test("zero bonus months are hidden and positive months are accurate", () => {
  assert.doesNotMatch(render("yearly_upgrade", { bonusMonths: 0 }).text, /bonus month/);
  assert.match(render("yearly_upgrade", { bonusMonths: 2 }).text, /2 bonus months/);
});

test("trial steps and both billing paths have complete text", () => {
  const data = { ...sample, cardOnFile: true };
  assert.match(render("trial_started", data).text, /1. Sign in to the parent portal/);
  assert.match(render("trial_started", data).text, /card will be charged/);
  assert.doesNotMatch(render("trial_started", data).text, /no card needed/);
  assert.doesNotMatch(render("trial_started", { ...data, cardOnFile: false }).text, /card will be charged/);
  assert.match(render("trial_ending", data).text, /August 28, 2026/);
  assert.match(render("trial_ended", data).text, /choose a plan/i);
});

test("dynamic text is escaped and verification text includes the full code", () => {
  const result = render("verify_email", { parentName: '<img src=x onerror="bad()">', code: "123456" });
  assert.doesNotMatch(result.html, /<img src=x/);
  assert.match(result.text, /123456/);
  assert.match(result.text, /10 minutes/);
});

test("trial upgrade, deletion and reminder wording matches actual billing behavior", () => {
  const trial = render("yearly_upgrade", { trialing: true, trialEndsAt: "2026-10-10", effectivePrice: 75 });
  assert.match(trial.subject, /after your trial/);
  assert.match(trial.text, /No yearly payment has been collected/);
  assert.match(trial.text, /75.00/);
  assert.match(render("deletion_requested", {}).text, /Future subscription billing has stopped/);
  assert.doesNotMatch(render("payment_retry", {}).text, /tried your payment again/);
  const reminder = render("renewal_reminder", { upcomingAmount: "$149.00", nextDate: "2027-01-01", offerEndsAt: "2027-01-01" });
  assert.match(reminder.text, /149.00/);
  assert.match(reminder.text, /introductory offer ends/);
  assert.match(render("winback", {}).text, /pm:unsubscribe/);
  assert.doesNotMatch(render("payment_receipt", {}).text, /pm:unsubscribe/);
});
