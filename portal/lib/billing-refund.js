// Refund creation and subscription cancellation are separate, retryable steps.
async function executeRefund({ op, stripe, save, cancel, finalize }) {
  if (op.state === "completed") return op.result;
  if (!op.refund) {
    // After an uncertain response, reconcile by metadata before retrying a POST.
    if (stripe) {
      const listed = await stripe.refunds.list({ ...op.target, limit: 100 });
      op.refund = listed.data.find(r => r.metadata?.billingOperation === op.id);
      if (!op.refund) {
        if (Date.now() - Date.parse(op.createdAt) > 23 * 3600000) throw new Error("This refund needs manual reconciliation in Stripe before retrying.");
        op.refund = await stripe.refunds.create({ ...op.target, amount: op.amountCents,
          metadata: { billingOperation: op.id, familyId: op.familyId } }, { idempotencyKey: op.id });
      }
    } else op.refund = { id: "re_mock_" + op.id, amount: op.amountCents, status: "succeeded" };
    await save(op);
  } else if (stripe && op.refund.status !== "succeeded") {
    op.refund = await stripe.refunds.retrieve(op.refund.id);
    await save(op);
  }
  if (op.refund.status !== "succeeded") {
    op.state = ["failed", "canceled"].includes(op.refund.status) ? "failed" : "pending";
    await save(op);
    return { refundId: op.refund.id, status: op.refund.status, refunded: false,
      message: op.state === "failed" ? "Refund failed. Review the payment in Stripe." : "Refund pending. Access has not been removed. Refresh to check its status." };
  }
  if (op.endAccess && !op.cancelled) {
    await cancel(op);
    op.cancelled = true;
    await save(op);
  }
  op.result = await finalize(op);
  op.state = "completed";
  await save(op);
  return op.result;
}

module.exports = { executeRefund };
