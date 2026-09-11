const { test } = require("node:test");
const assert = require("node:assert/strict");
const Stripe = require("stripe");
const { executeUpgrade } = require("../lib/billing-upgrade");
const { executeRefund } = require("../lib/billing-refund");
const { upgradeTerms } = require("../lib/billing-policy");

test("Stripe sandbox: paid upgrade, refund restoration, trial offer and standard renewal schedule", { skip: !process.env.BILLING_STRIPE_TEST_KEY, timeout: 240000 }, async () => {
  const key = process.env.BILLING_STRIPE_TEST_KEY;
  if (!key.startsWith("sk_test_")) throw Error("Only Stripe test-mode keys are allowed.");
  const stripe = Stripe(key, { maxNetworkRetries: 1, timeout: 20000 });
  const now = Math.floor(Date.now()/1000);
  const tag = "kg-billing-test-" + now;
  const clocks = [], prices = [], customers = [];
  let product;
  try {
    product = await stripe.products.create({ name: tag, metadata: { isolatedBillingTest: "true" } });
    const month = await stripe.prices.create({ product: product.id, unit_amount: 1900, currency: "usd", recurring: { interval: "month" } });
    const year = await stripe.prices.create({ product: product.id, unit_amount: 14900, currency: "usd", recurring: { interval: "year" } });
    prices.push(month.id, year.id);
    const clock = await stripe.testHelpers.testClocks.create({ frozen_time: now, name: tag }); clocks.push(clock.id);
    const createMonthly = async trial => {
      const customer = await stripe.customers.create({ name: tag, test_clock: clock.id, metadata: { isolatedBillingTest: "true" } }); customers.push(customer.id);
      const pm = await stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id });
      await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: pm.id } });
      const sub = await stripe.subscriptions.create({ customer: customer.id, default_payment_method: pm.id, items: [{ price: month.id }], ...(trial ? { trial_end: now+7*86400 } : {}) });
      return { customer, pm, sub };
    };
    const pricing = { yearly: { amount: 149, stripePriceId: year.id }, yearlyUpgrade: { enabled: true, bonusMonths: 3, discountAmount: 74, note: "Sandbox" } };
    const paid = await createMonthly(false);
    const terms = upgradeTerms({ subscriptionStatus: "active", currentPeriodEnd: new Date(paid.sub.current_period_end*1000).toISOString() }, pricing, now*1000);
    const op = { id: tag+"paid", familyId: tag, email: "", createdAt: new Date().toISOString(), terms, customerId: paid.customer.id, monthlySubscriptionId: paid.sub.id, paymentMethod: paid.pm.id };
    const result = await executeUpgrade({ stripe, op, save: async () => {} }); prices.push(op.priceId);
    assert.equal(result.invoice.status, "paid"); assert.equal(result.invoice.amount_paid, 7500);
    const upgraded = await stripe.subscriptions.retrieve(result.subscriptionId);
    assert.equal(upgraded.trial_end, terms.endsAt);
    assert.equal((await stripe.subscriptions.retrieve(paid.sub.id)).cancel_at_period_end, true);
    const beforeInvoices = await stripe.invoices.list({ customer: paid.customer.id, limit: 20 });
    await executeUpgrade({ stripe, op, save: async () => {} });
    assert.equal((await stripe.invoices.list({ customer: paid.customer.id, limit: 20 })).data.length, beforeInvoices.data.length);
    const invoice = await stripe.invoices.retrieve(result.invoice.id, { expand: ["payment_intent"] });
    const pi = typeof invoice.payment_intent === "string" ? invoice.payment_intent : invoice.payment_intent.id;
    const refundOp = { id: tag+"refund", createdAt: new Date().toISOString(), target: { payment_intent: pi }, amountCents: 7500, endAccess: true };
    const refund = await executeRefund({ stripe, op: refundOp, save: async () => {}, cancel: async () => {
      await stripe.subscriptionSchedules.release(op.scheduleId);
      await stripe.subscriptions.cancel(result.subscriptionId);
    }, finalize: async () => ({ refunded: true }) });
    assert.equal(refund.refunded, true);
    assert.equal((await stripe.subscriptions.retrieve(paid.sub.id)).status, "active");
    await stripe.subscriptions.update(paid.sub.id, { cancel_at_period_end: false });
    assert.equal((await stripe.subscriptions.retrieve(paid.sub.id)).cancel_at_period_end, false);
    const trial = await createMonthly(true);
    const trialTerms = upgradeTerms({ subscriptionStatus: "trialing", trialEndsAt: new Date(trial.sub.trial_end*1000).toISOString() }, pricing, now*1000);
    const trialOp = { id: tag+"trial", familyId: tag+"trial", createdAt: new Date().toISOString(), terms: trialTerms, customerId: trial.customer.id, monthlySubscriptionId: trial.sub.id, paymentMethod: trial.pm.id };
    await executeUpgrade({ stripe, op: trialOp, save: async () => {} }); prices.push(trialOp.priceId);
    assert.equal((await stripe.subscriptions.retrieve(trial.sub.id)).trial_end, trial.sub.trial_end);
    const waitClock = async () => {
      for (let n=0; n<60; n++) {
        const current = await stripe.testHelpers.testClocks.retrieve(clock.id);
        if (current.status === "ready") return;
        await new Promise(r => setTimeout(r, 1000));
      }
      throw Error("Test clock did not become ready.");
    };
    await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: now+7*86400+7200 });
    await waitClock();
    const converted = await stripe.subscriptions.retrieve(trial.sub.id, { expand: ["latest_invoice"] });
    const firstBill = converted.latest_invoice;
    assert.equal(firstBill.amount_due, 7500);
    if (firstBill.status === "draft") await stripe.invoices.finalizeInvoice(firstBill.id);
    const convertedInvoice = await stripe.invoices.retrieve(firstBill.id);
    if (convertedInvoice.status === "open") await stripe.invoices.pay(firstBill.id);
    assert.equal((await stripe.invoices.retrieve(firstBill.id)).amount_paid, 7500);
    assert.equal(converted.trial_end, trialTerms.endsAt);
    const schedule = await stripe.subscriptionSchedules.retrieve(trialOp.scheduleId);
    assert.equal(schedule.phases.at(-1).items[0].price, year.id);
    assert.equal(schedule.phases.at(-1).start_date, trialTerms.endsAt);
  } finally {
    for (const id of clocks) await stripe.testHelpers.testClocks.del(id).catch(() => {});
    for (const id of customers) await stripe.customers.del(id).catch(() => {});
    for (const id of prices) await stripe.prices.update(id, { active: false }).catch(() => {});
    if (product) await stripe.products.update(product.id, { active: false }).catch(() => {});
  }
});
