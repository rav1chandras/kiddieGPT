const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("upgrade verification redirects to Stripe without displaying a paid yearly plan", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../webapp/webapp.js"), "utf8");
  const start = source.indexOf("    async function performYearlyUpgrade()");
  const end = source.indexOf("    // Same buttons serve both states", start);
  assert.ok(start >= 0 && end > start);
  let redirect;
  const context = {
    planByKey: () => ({}), upgradeYearly: {}, paymentState: {}, completionText: {}, completionTitle: {},
    formValue: () => "", yearlyUpgradeOffer: () => ({}), preview: () => {},
    parentAuthFetch: async () => ({ ok: true, json: async () => ({ requiresAction: true, paymentUrl: "https://invoice.stripe.com/test", message: "Verify with your bank" }) }),
    window: { location: { assign: url => { redirect = url; } } },
    setPaidPlan: () => assert.fail("Verification is not successful payment"),
    invalidateEntitlementSync: () => assert.fail("Do not mark the upgrade completed")
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  await context.performYearlyUpgrade();
  assert.equal(redirect, "https://invoice.stripe.com/test");
  assert.equal(context.upgradeYearly.disabled, false);
  assert.equal(context.paymentState.textContent, "Payment verification needed");
});
