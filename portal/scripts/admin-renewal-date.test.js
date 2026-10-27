const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const client = fs.readFileSync(path.join(__dirname, "../webapp/webapp.js"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "../lib/app.js"), "utf8");

function extract(source, from, to, context) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start);
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return context;
}

test("monthly renewal ignores a canceled trial's yearly date", () => {
  const ui = extract(client, "    function nextBillingDate(family)", "    // Cancel-scheduled accounts", {
    family: null
  });
  const family = {
    subscriptionStatus: "active", plan: "Family Monthly", stripeSubscriptionId: "sub_new_monthly",
    currentPeriodEnd: "2026-11-26T13:23:05.000Z",
    yearlyUpgrade: { status: "trialing", yearlySubscriptionId: "sub_old_trial", yearlyNextRenewalAt: 1833048392 }
  };
  assert.equal(ui.nextBillingDate(family), family.currentPeriodEnd);
  family.yearlyUpgrade.status = "scheduled";
  assert.equal(ui.nextBillingDate(family), family.currentPeriodEnd, "an older yearly subscription must not override monthly billing");
});

test("a live yearly upgrade keeps its scheduled renewal", () => {
  const ui = extract(client, "    function nextBillingDate(family)", "    // Cancel-scheduled accounts", {});
  const family = {
    subscriptionStatus: "active", plan: "Family Yearly", stripeSubscriptionId: "sub_yearly",
    currentPeriodEnd: "2026-11-26T13:23:05.000Z",
    yearlyUpgrade: { status: "scheduled", yearlySubscriptionId: "sub_yearly", yearlyNextRenewalAt: 1833048392 }
  };
  assert.equal(ui.nextBillingDate(family), 1833048392);
});

test("Stripe item period ends take precedence over the legacy subscription field", () => {
  const billing = extract(server, "function subscriptionPeriodEnd(subscription)", "// Accepts either a unix-seconds", {
    unixToIso: (seconds) => seconds ? new Date(Number(seconds) * 1000).toISOString() : ""
  });
  assert.equal(billing.subscriptionPeriodEnd({
    current_period_end: 1833048392,
    items: { data: [{ current_period_end: 1795699385 }] }
  }), "2026-11-26T13:23:05.000Z");
});

test("a fresh checkout retires an uncharged yearly trial", () => {
  const billing = extract(server, "function retireYearlyUpgrade(family", "function markSubscriptionEndedNow", {
    nowIso: () => "2026-10-26T13:23:05.000Z"
  });
  const family = { yearlyUpgrade: { status: "trialing", yearlySubscriptionId: "sub_old_trial" } };
  billing.retireYearlyUpgrade(family);
  assert.equal(family.yearlyUpgrade.status, "ended");
});
