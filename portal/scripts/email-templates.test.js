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
vm.runInContext(source.slice(source.indexOf("function escHtml(value)"), source.indexOf("// Only lifecycle/marketing emails")), box);
const render = (key, data) => box.renderTemplate(key, data);
const sample = vm.runInContext("EMAIL_SAMPLE", box);
const keys = vm.runInContext("EMAIL_TEMPLATES.map(t => t.key)", box);

test("all 33 templates render HTML and meaningful plain text", () => {
  assert.equal(keys.length, 33);
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
