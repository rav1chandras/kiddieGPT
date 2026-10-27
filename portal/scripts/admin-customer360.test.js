const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../webapp/webapp.js"), "utf8");

function loadFunction(startMarker, endMarker, values) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start);
  const context = { ...values };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return context;
}

test("Customer 360 latest payment belongs to the exact family", () => {
  const family = { id: "fam_one", email: "kiddiegpt@gmail.com", stripeCustomerId: "cus_one", stripeSubscriptionId: "sub_one" };
  const context = loadFunction("    function latestPaymentForFamily(family)", "    function familyForPayment(payment, families)", {
    paymentsCache: [
      { familyId: "fam_two", email: "parent.kiddiegpt@gmail.com", amountCents: 1000, status: "paid" },
      { familyId: "fam_one", amountCents: 1000, status: "failed" }
    ],
    familyRowId: (item) => item.id,
    normalizeEmail: (email) => email.toLowerCase()
  });
  assert.equal(context.latestPaymentForFamily(family), null);
  context.paymentsCache.push({ familyId: "fam_one", amountCents: 13400, status: "paid", createdAt: "2026-11-01" });
  assert.equal(context.latestPaymentForFamily(family).amountCents, 13400);
});

test("a normally ended trial is not an error risk", () => {
  const context = loadFunction("    function familyHealth(family)", "    function nextStep(family)", {
    daysSinceActivity: () => 30
  });
  const result = context.familyHealth({ subscriptionStatus: "cancelled", paymentStatus: "trial" });
  assert.equal(result.label, "Plan ended");
  assert.equal(result.status, "ready");
});

test("Customer 360 email requires a composed message and shows delivery state", () => {
  assert.match(source, /data-customer-email-subject/);
  assert.match(source, /data-customer-email-message/);
  assert.match(source, /Email was not sent\. Configure Postmark or SMTP/);
  assert.match(source, /template: "Admin parent email", subject: subject, message: message/);
});
