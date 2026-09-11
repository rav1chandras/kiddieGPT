async function executeUpgrade({ stripe, op, save }) {
  const terms = op.terms;
  const request = step => ({ idempotencyKey: op.id + "_" + step });
  const metadata = { app: "KiddieGPT", familyId: op.familyId, parentEmail: op.email,
    billingOperation: op.id, yearlyUpgrade: "true", upgradeBillingMode: terms.trialing ? "trial_offer" : "paid_upgrade",
    accessMonths: String(terms.accessMonths), paidAccessUntil: terms.trialing ? "" : String(terms.endsAt) };
  if (!op.scheduleId && Date.now() - Date.parse(op.createdAt) > 23 * 3600000) {
    throw new Error("This upgrade needs reconciliation in Stripe before retrying.");
  }
  if (!op.priceId) {
    const price = await stripe.prices.retrieve(terms.priceId);
    const product = typeof price.product === "object" ? price.product.id : price.product;
    const initial = await stripe.prices.create({ currency: price.currency, product,
      unit_amount: terms.amountCents,
      metadata }, request("offer-price"));
    op.priceId = initial.id;
    await save(op);
  }
  if (terms.trialing) {
    if (!op.scheduleId) {
      const sub = await stripe.subscriptions.retrieve(op.monthlySubscriptionId, { expand: ["schedule"] });
      if (sub.schedule) throw new Error("This trial already has a billing schedule. Contact support to change it.");
      const schedule = await stripe.subscriptionSchedules.create({ from_subscription: sub.id }, request("trial-schedule"));
      op.scheduleId = schedule.id;
      op.scheduleStart = schedule.phases[0].start_date;
      op.trialPriceId = sub.items.data[0].price.id;
      await save(op);
    }
    const schedule = await stripe.subscriptionSchedules.update(op.scheduleId, {
      end_behavior: "release", proration_behavior: "none",
      phases: [
        { start_date: op.scheduleStart, end_date: terms.startsAt, trial_end: terms.startsAt,
          items: [{ price: op.trialPriceId }], metadata, proration_behavior: "none" },
        { start_date: terms.startsAt, end_date: terms.endsAt, trial_end: terms.endsAt,
          items: [{ price: terms.priceId }], add_invoice_items: [{ price: op.priceId, quantity: 1 }],
          metadata: { ...metadata, paidAccessUntil: String(terms.endsAt) }, proration_behavior: "none" },
        { start_date: terms.endsAt, iterations: 1, items: [{ price: terms.priceId }],
          metadata: { ...metadata, upgradeBillingMode: "standard_yearly", paidAccessUntil: "" }, proration_behavior: "none" }
      ], expand: ["subscription"]
    }, request("trial-offer"));
    op.subscriptionId = typeof schedule.subscription === "object" ? schedule.subscription.id : schedule.subscription;
    await save(op);
    return { subscriptionId: op.subscriptionId, invoice: null };
  }
  if (!op.scheduleId) {
    // A one-time invoice pays for the whole extended term. The recurring price
    // is deferred to its exact end, so carry-over days never cause a second bill.
    const schedule = await stripe.subscriptionSchedules.create({ customer: op.customerId, start_date: "now", end_behavior: "release",
      default_settings: op.paymentMethod ? { default_payment_method: op.paymentMethod } : {}, metadata,
      phases: [
        { end_date: terms.endsAt, trial_end: terms.endsAt, items: [{ price: terms.priceId }],
          add_invoice_items: [{ price: op.priceId, quantity: 1 }], metadata, proration_behavior: "none" },
        { iterations: 1, items: [{ price: terms.priceId }],
          metadata: { ...metadata, upgradeBillingMode: "standard_yearly", paidAccessUntil: "" }, proration_behavior: "none" }
      ], expand: ["subscription.latest_invoice"]
    }, request("paid-schedule"));
    const sub = schedule.subscription;
    op.scheduleId = schedule.id;
    op.subscriptionId = typeof sub === "object" ? sub.id : sub;
    op.invoiceId = typeof sub?.latest_invoice === "object" ? sub.latest_invoice.id : sub?.latest_invoice;
    await save(op);
  }
  let sub = await stripe.subscriptions.retrieve(op.subscriptionId, { expand: ["latest_invoice"] });
  const invoiceId = op.invoiceId || (typeof sub.latest_invoice === "object" ? sub.latest_invoice.id : sub.latest_invoice);
  if (!invoiceId) throw new Error("The yearly invoice is not ready. Retry to check payment.");
  op.invoiceId = invoiceId;
  await save(op);
  let invoice = await stripe.invoices.retrieve(invoiceId);
  if (invoice.status === "draft") invoice = await stripe.invoices.finalizeInvoice(invoiceId, {}, request("finalize"));
  if (invoice.status === "open") {
    try { invoice = await stripe.invoices.pay(invoiceId, {}, request("pay")); }
    catch (error) {
      // Re-read after an uncertain response. A declined payment must not leave
      // another subscription waiting to bill the parent later.
      invoice = await stripe.invoices.retrieve(invoiceId);
      if (invoice.status !== "paid" && (error.type === "StripeCardError" || error.type === "card_error")) {
        await stripe.subscriptionSchedules.cancel(op.scheduleId);
        if (invoice.status === "open") await stripe.invoices.voidInvoice(invoiceId);
        op.state = "failed";
        await save(op);
      }
      if (invoice.status !== "paid") throw error;
    }
  }
  if (invoice.status !== "paid") throw new Error("Yearly payment is not confirmed. Monthly billing has not been changed.");
  op.paid = true;
  await save(op);
  await stripe.subscriptions.update(op.monthlySubscriptionId, { cancel_at_period_end: true }, request("stop-monthly"));
  return { subscriptionId: op.subscriptionId, invoice };
}

module.exports = { executeUpgrade };
