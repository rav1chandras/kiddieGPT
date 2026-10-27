const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function hasEverPaidFor(paymentsCache, family) {
  const source = fs.readFileSync(path.join(__dirname, "../webapp/webapp.js"), "utf8");
  const start = source.indexOf("    function hasEverPaid(family)");
  const end = source.indexOf("    function paymentStatus(family)", start);
  assert.ok(start >= 0 && end > start);
  const context = {
    paymentsCache,
    familyRowId: (item) => item.id,
    normalizeEmail: (value) => String(value || "").trim().toLowerCase()
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return context.hasEverPaid(family);
}

test("billing review only attributes payments to their actual family", () => {
  const family = { id: "fam_new", email: "parent@example.com", parentName: "Parent", subscriptionStatus: "pending" };
  assert.equal(hasEverPaidFor([{ familyId: "fam_old", email: family.email, amountCents: 1000 }], family), false);
  assert.equal(hasEverPaidFor([{ familyId: "fam_old", parentName: "Parent", amountCents: 1000 }], family), false);
  assert.equal(hasEverPaidFor([{ familyId: family.id, amountCents: 0 }], family), false);
  assert.equal(hasEverPaidFor([{ familyId: family.id, amountCents: 1000 }], family), true);
  assert.equal(hasEverPaidFor([{ email: "PARENT@example.com", amountCents: 1000 }], family), true);
});

test("launch-priced trial cancellation shows the real first charge without a second offer", () => {
  const source = fs.readFileSync(path.join(__dirname, "../webapp/webapp.js"), "utf8");
  const billingStart = source.indexOf("    function trialBillingText()");
  const billingEnd = source.indexOf("    // Refunding a yearly UPGRADE", billingStart);
  const cancelStart = source.indexOf("    function prepareCancellationFlow()");
  const cancelEnd = source.indexOf("    function invalidateEntitlementSync()", cancelStart);
  assert.ok(billingStart >= 0 && billingEnd > billingStart && cancelStart >= 0 && cancelEnd > cancelStart);
  const classes = () => ({ values: {}, toggle(name, value) { this.values[name] = value; } });
  const ui = {
    parentEntitlement: { retentionOfferAvailable: false, trial: { firstChargeCents: 1000, regularChargeCents: 1499, launchDiscountApplied: true } },
    trialEndsText: () => "November 1, 2026",
    moneyFromCents: cents => "$" + (cents / 100).toFixed(cents % 100 ? 2 : 0),
    isYearlySubscription: () => false,
    refundWindow: () => null,
    inRefundWindow: () => false,
    onStripeTrial: () => true,
    cancellationPromoConfig: () => ({ enabled: true, amountOff: 5, renewalsLabel: "next renewal" }),
    cancellationYearlyOption: { classList: classes() },
    cancelFlowLabel: {}, cancelFlowTitle: {}, cancelFlowCopy: {},
    acceptDiscount: { classList: classes() }, confirmCancel: {}, saveOffer: { classList: classes() }
  };
  vm.createContext(ui);
  vm.runInContext(source.slice(billingStart, billingEnd) + source.slice(cancelStart, cancelEnd), ui);
  ui.prepareCancellationFlow();
  assert.equal(ui.cancelFlowTitle.textContent, "End your free trial");
  assert.equal(ui.acceptDiscount.classList.values.hidden, true);
  assert.match(ui.cancelFlowCopy.textContent, /first charge is \$10 on November 1, 2026/);
  assert.match(ui.cancelFlowCopy.textContent, /\$14\.99\/month/);
  assert.doesNotMatch(ui.cancelFlowCopy.textContent, /get \$5 off/);
});

test("signup plan cards wait for entitlement and exclude card-based trials", () => {
  const source = fs.readFileSync(path.join(__dirname, "../webapp/webapp.js"), "utf8");
  const start = source.indexOf("    function needsInitialCheckout()");
  const end = source.indexOf("    function renderSubscriptionState()", start);
  assert.ok(start >= 0 && end > start);
  const ui = { parentEntitlement: null, onNoCardTrial: () => false, yearlyUpgradeScheduled: false };
  vm.createContext(ui);
  vm.runInContext(source.slice(start, end), ui);
  assert.equal(ui.needsInitialCheckout(), false, "Do not show checkout before the server responds");
  ui.parentEntitlement = { active: true, status: "trialing", trial: { cardOnFile: true } };
  assert.equal(ui.needsInitialCheckout(), false, "A card-based trial is already subscribed");
  assert.equal(ui.canShowYearlyUpgrade("monthly", false), true, "A monthly trial can still upgrade to yearly");
  assert.equal(ui.canShowYearlyUpgrade("yearly", false), false);
  assert.equal(ui.canShowYearlyUpgrade("monthly", true), false);
  ui.parentEntitlement = { active: false, status: "pending" };
  assert.equal(ui.needsInitialCheckout(), true);
  ui.parentEntitlement = { active: false, status: "past_due" };
  assert.equal(ui.needsInitialCheckout(), false, "A failed payment needs recovery, not a new checkout");
  ui.parentEntitlement = { active: true, status: "trial" };
  ui.onNoCardTrial = () => true;
  assert.equal(ui.needsInitialCheckout(), true, "A complimentary trial still needs a plan");
});

test("subscription keeps the legacy plan picker hidden through loading and trial states", () => {
  const html = fs.readFileSync(path.join(__dirname, "../webapp/index.html"), "utf8");
  const source = fs.readFileSync(path.join(__dirname, "../webapp/webapp.js"), "utf8");
  const renderStart = source.indexOf("    function renderSubscriptionState()");
  const loadingBranch = source.slice(renderStart, source.indexOf("      var hasSubscribedPlan", renderStart));
  assert.match(html, /class="plan-tile-grid hidden"/);
  assert.ok(loadingBranch.indexOf('planTileGrid.classList.add("hidden")') < loadingBranch.indexOf("if (!entitlementKnown)"));
  assert.match(source, /var yearlyTrial = onStripeTrial\(\) && plan\.key === "yearly"/);
  assert.match(source, /upgradeYearlyTileButton\.disabled = true;\s*upgradeYearlyTileButton\.innerHTML = "<i data-lucide='check'><\/i>Current plan · Free trial"/);
});

test("unverified subscription shows configured prices and a distinct retry state", () => {
  const source = fs.readFileSync(path.join(__dirname, "../webapp/webapp.js"), "utf8");
  const start = source.indexOf("    function renderSubscriptionState()");
  const end = source.indexOf("    // Card-upfront Stripe trial state", start);
  assert.ok(start >= 0 && end > start);
  const element = () => ({ textContent: "", innerHTML: "", hidden: false, disabled: false, classList: { add() {}, toggle() {}, remove() {} } });
  const oldYearlyPrice = element();
  const ui = {
    parentEntitlement: null,
    entitlementLoadError: "",
    planTileGrid: element(),
    currentPackageName: element(),
    currentPackageMode: element(),
    currentPackageCard: element(),
    upgradeYearlyName: element(),
    retrySubscriptionCheck: element(),
    currentPackagePrice: element(),
    currentPackageNote: element(),
    upgradeYearlyPrice: element(),
    upgradeYearlyBonus: element(),
    upgradeYearlyBillingNote: element(),
    upgradeYearly: element(),
    upgradeYearlyTileButton: element(),
    subscriptionJourneyTitle: element(),
    subscriptionJourneyCopy: element(),
    subscriptionJourneyNote: element(),
    document: { getElementById(id) { return id === "upgrade-yearly-old-price" ? oldYearlyPrice : element(); } },
    readPricing: () => ({ monthly: { amount: 14.99 }, yearly: { amount: 149 } }),
    configuredPromotionForPlan: key => ({ description: "Starter offer", [key + "Amount"]: key === "monthly" ? 10 : 120 }),
    promotionAmountForPlan: (promo, key) => promo[key + "Amount"],
    signupPromotionBillingCopy: (promo, first, regular, interval) => `First payment $${first}; renews at $${regular}/${interval}.`,
    moneyStr: amount => String(amount),
    renderIcons() {}
  };
  vm.createContext(ui);
  vm.runInContext(source.slice(start, end), ui);
  ui.renderSubscriptionState();
  assert.equal(ui.currentPackagePrice.textContent, "$10");
  assert.equal(ui.upgradeYearlyPrice.textContent, "$120");
  assert.equal(oldYearlyPrice.textContent, "$149");
  assert.equal(ui.upgradeYearly.disabled, true);
  ui.entitlementLoadError = "Subscription data is temporarily unavailable.";
  ui.renderSubscriptionState();
  assert.match(ui.currentPackageNote.textContent, /Retry the check/);
  assert.match(ui.upgradeYearly.innerHTML, /Status unavailable/);
});

test("trial charge formatter is available to the parent portal", () => {
  const source = fs.readFileSync(path.join(__dirname, "../webapp/webapp.js"), "utf8");
  const start = source.indexOf("  function moneyFromCents(amountCents)");
  const end = source.indexOf("  function authedHeaders(", start);
  assert.ok(start >= 0 && end > start && end < source.indexOf("  function setupParentPortal()"));
  const ui = {};
  vm.createContext(ui);
  vm.runInContext(source.slice(start, end), ui);
  assert.equal(ui.moneyFromCents(1000), "$10");
  assert.equal(ui.moneyFromCents(1499), "$14.99");
});

test("launch offer copy names the first charge and regular renewal", () => {
  const source = fs.readFileSync(path.join(__dirname, "../webapp/webapp.js"), "utf8");
  const start = source.indexOf("    function signupPromotionBillingCopy(");
  const end = source.indexOf("      function applySignupPlanCards(", start);
  assert.ok(start >= 0 && end > start);
  const ui = { moneyStr: amount => String(amount) };
  vm.createContext(ui);
  vm.runInContext(source.slice(start, end), ui);
  assert.equal(ui.signupPromotionBillingCopy({ description: "Limited-time family starter offer" }, 10, 14.99, "month"),
    "First payment $10; renews at $14.99/month.");
  assert.equal(ui.signupPromotionBillingCopy({ description: "Intro price on the first payment only; standard rate applies at renewal." }, 120, 149, "year"),
    "First payment $120; renews at $149/year.");
  assert.equal(ui.signupPromotionBillingCopy({ description: "Back-to-school offer" }, 10, 14.99, "month"),
    "Back-to-school offer");
});
