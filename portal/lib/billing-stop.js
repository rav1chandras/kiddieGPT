// Stop invoices first, then schedules/subscriptions. Every step is retryable;
// callers must keep the account usable if Stripe cannot confirm termination.
async function stopBilling({ stripe, subscriptionIds = [], invoiceId }) {
  if (!stripe) return;
  if (invoiceId) {
    try {
      const invoice = await stripe.invoices.retrieve(invoiceId);
      if (invoice.status === "draft") await stripe.invoices.del(invoiceId);
      else if (invoice.status === "open" || invoice.status === "uncollectible") await stripe.invoices.voidInvoice(invoiceId);
    } catch (error) { if (error.code !== "resource_missing") throw error; }
  }
  for (const id of [...new Set(subscriptionIds.filter(id => id && !id.startsWith("sub_mock")))]) {
    let sub;
    try { sub = await stripe.subscriptions.retrieve(id); }
    catch (error) { if (error.code === "resource_missing") continue; throw error; }
    if (["canceled", "incomplete_expired"].includes(sub.status)) continue;
    if (sub.schedule) {
      const scheduleId = typeof sub.schedule === "string" ? sub.schedule : sub.schedule.id;
      await stripe.subscriptionSchedules.release(scheduleId);
    }
    await stripe.subscriptions.cancel(id, { invoice_now: false, prorate: false });
  }
}

function recoveryCandidates(families, now = Date.now(), email) {
  return families.filter(f => (!email || f.email === email) && (f.pendingRefundOperation || f.pendingUpgradeOperation)
    && now - (Date.parse(f.billingRecoveryAttemptAt) || 0) >= 60000)
    .sort((a, b) => (Date.parse(a.billingRecoveryAttemptAt) || 0) - (Date.parse(b.billingRecoveryAttemptAt) || 0));
}

module.exports = { stopBilling, recoveryCandidates };
