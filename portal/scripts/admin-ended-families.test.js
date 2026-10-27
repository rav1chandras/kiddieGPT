const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const script = fs.readFileSync(path.join(__dirname, "../webapp/webapp.js"), "utf8");
const start = script.indexOf("    function isEndedFamily(family)");
const end = script.indexOf("    function hasEverPaid(family)", start);
assert.ok(start >= 0 && end > start);

function endedView(payments = []) {
  const context = {
    endedSearch: { value: "" },
    endedHistoryFilter: { value: "all" },
    familyDeleted: (family) => Boolean(family.deletedAt),
    hasEverPaid: (family) => Boolean(family.lastPaymentAt || ["paid", "refunded", "partial_refunded"].includes(family.paymentStatus) || payments.some((payment) => payment.familyId === family.id && payment.amountCents > 0)),
    childrenOf: (family) => family.children || []
  };
  vm.createContext(context);
  vm.runInContext(script.slice(start, end), context);
  return context;
}

test("ended view includes only ended, undeleted families", () => {
  const view = endedView();
  const families = [
    { id: "trial", subscriptionStatus: "cancelled", trialUsedAt: "2026-10-20", cancelledAt: "2026-10-22" },
    { id: "expired", subscriptionStatus: "expired", trialStartedAt: "2026-10-10", trialEndedAt: "2026-10-17" },
    { id: "live", subscriptionStatus: "trialing" },
    { id: "scheduled", subscriptionStatus: "cancel_scheduled" },
    { id: "deleted", subscriptionStatus: "cancelled", deletedAt: "2026-10-21" }
  ];
  assert.deepEqual(Array.from(view.filteredEndedFamilies(families), (family) => family.id), ["trial", "expired"]);
  assert.deepEqual(Array.from(view.endedPlanHistory(families[0])), ["Trial only"]);
});

test("history tags require a successful payment, even for a yearly trial", () => {
  const view = endedView();
  const trial = { plan: "Family Yearly", trialUsedAt: "2026-10-20", paymentStatus: "trial", yearlyUpgrade: { status: "trialing" } };
  const monthly = { plan: "Family Monthly", paymentStatus: "refunded" };
  const yearly = { plan: "Family Yearly", paymentStatus: "paid" };
  const upgraded = { plan: "Family Yearly", paymentStatus: "paid", yearlyUpgrade: { status: "ended", monthlyPaymentAt: "2026-09-01" } };
  assert.deepEqual(Array.from(view.endedPlanHistory(trial)), ["Trial only"]);
  assert.deepEqual(Array.from(view.endedPlanHistory(monthly)), ["Monthly"]);
  assert.deepEqual(Array.from(view.endedPlanHistory(yearly)), ["Yearly"]);
  assert.deepEqual(Array.from(view.endedPlanHistory(upgraded)), ["Monthly", "Yearly"]);
});

test("ended search and history filter include child names and past upgrades", () => {
  const view = endedView();
  view.endedSearch.value = "ava";
  view.endedHistoryFilter.value = "monthly";
  const families = [
    { id: "a", parentName: "Maya", email: "maya@example.com", subscriptionStatus: "expired", plan: "Family Yearly", paymentStatus: "paid", yearlyUpgrade: { monthlyPaymentAt: "2026-09-01" }, children: [{ studentName: "Ava" }] },
    { id: "b", parentName: "Lee", email: "lee@example.com", subscriptionStatus: "expired", plan: "Family Yearly", paymentStatus: "paid", children: [{ studentName: "Ava" }] }
  ];
  assert.deepEqual(Array.from(view.filteredEndedFamilies(families), (family) => family.id), ["a"]);
});
