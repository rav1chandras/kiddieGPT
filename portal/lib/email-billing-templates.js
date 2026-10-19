module.exports = ({ escHtml: esc, emailBaseUrl: base, emailAmount: money }) => {
  const parent = (d, chip, title, paragraphs, ctaText = "View billing", ctaUrl = base()) => ({ chip, title,
    greeting: `Hi ${d.parentName},`, paragraphs, ctaText, ctaUrl });
  const operator = (d, title, detail) => ({ chip: "Action needed", title,
    paragraphs: [`Account: <b>${esc(d.email)}</b>`, esc(detail)], ctaText: "Review billing", ctaUrl: `${base()}/admin.html` });
  return [
    { key: "payment_verification", name: "Payment verification required", stage: "Payments & billing", subject: () => "Verify your KiddieGPT payment",
      build: d => parent(d, "Action needed", "Your bank needs verification", ["Your payment needs an extra verification step. Complete it securely in Stripe.", d.upgrade ? "Your monthly plan stays unchanged until the yearly payment succeeds." : "Your payment is not confirmed yet. Review your billing page for your current access status."], "Verify payment", d.paymentUrl || base()) },
    { key: "refund_pending", name: "Refund pending", stage: "Payments & billing", subject: () => "Your KiddieGPT refund is pending",
      build: d => parent(d, "Pending", "Your refund is being processed", [`Your refund of <b>${esc(money(d.amountCents, d.currency))}</b> is pending. We'll send confirmation when it completes.`, "This notice does not confirm that funds have reached your account. Check your billing page for access and renewal details."]) },
    { key: "op_refund_failed", name: "Refund failed (internal)", stage: "Operator", subject: () => "Action needed: KiddieGPT refund failed",
      build: d => operator(d, "Refund needs attention", `Refund ${d.refundId || d.operationId || ""} did not complete. Review it in Stripe before attempting another refund.`) },
    { key: "yearly_upgrade_failed", name: "Yearly upgrade failed", stage: "Payments & billing", subject: () => "Your yearly upgrade did not complete",
      build: d => parent(d, "Action needed", "Your yearly upgrade did not complete", ["The yearly payment failed. This upgrade did not change your monthly subscription or its renewal setting.", "Update your payment method in the parent portal before trying again."]) },
    { key: "op_billing_stuck", name: "Billing operation needs attention (internal)", stage: "Operator", subject: () => "Action needed: KiddieGPT billing operation",
      build: d => operator(d, "Billing needs review", `${d.issue || "A billing operation could not finish."} Check the account's billing history and pending operations before retrying.`) },
    { key: "support_received", name: "Support request received", stage: "Support & account", subject: () => "We received your KiddieGPT support request",
      build: d => parent(d, "Support", "We received your message", [`Reference: <b>${esc(d.ticketId || "")}</b>`, "Our team usually replies within one business day. We'll respond by email."], "Open support") },
    { key: "op_dispute", name: "Dispute update (internal)", stage: "Operator", subject: () => "KiddieGPT payment dispute update",
      build: d => operator(d, "Payment dispute update", `Dispute ${d.disputeId || ""}: ${d.disputeStatus || "updated"}. Review the Stripe dashboard for details and any response deadline.`) },
    { key: "access_restored", name: "Payment recovered / access restored", stage: "Payments & billing", subject: () => "Your KiddieGPT payment is resolved",
      build: d => parent(d, "Resolved", "Your payment is resolved", ["Your outstanding subscription payment has succeeded and the payment-related access restriction is cleared.", "Any separate account restrictions still apply. View your current status in the parent portal."]) }
  ];
};
