// Business events are mapped independently of delivery, so webhook retries and
// API retries resolve to the same notification identity.
function emailEvents(action, p, family = {}, eventId) {
  const id = family.id || p.familyId || p.email;
  const data = { parentName: family.parentName || "there", email: family.email || p.email,
    planName: family.plan, nextDate: family.cancelAccessUntil || family.currentPeriodEnd || "",
    trialEndsAt: family.trialEndsAt, cardOnFile: Boolean(family.stripeSubscriptionId),
    bonusMonths: family.yearlyUpgrade?.bonusMonths || 0, ...p };
  const result = [];
  const add = (key, identity = eventId, extra = {}) => result.push({ key, id: `${key}:${id}:${identity}`, data: { ...data, ...extra } });
  switch (action) {
    case "auth.signup.otp_verified":
    case "family.create.google":
      add("welcome", "welcome");
      if (family.parentalConsent?.acceptedAt) add("consent_receipt", family.parentalConsent.acceptedAt, family.parentalConsent);
      break;
    case "privacy.parental_consent.accepted": add("consent_receipt", family.parentalConsent?.acceptedAt, family.parentalConsent); break;
    case "auth.password_reset.complete":
    case "account.password.change": add("password_changed"); break;
    case "account.email_change.complete": add("email_changed", eventId, { email: p.oldEmail }); break;
    case "account.delete.request": add("deletion_requested", family.deletionRequestedAt); break;
    case "subscription.cancel_requested":
    case "subscription.cancel":
    case "subscription.cancel.mock":
    case "subscription.cancel_requested.mock": add("cancellation_scheduled", family.cancelAccessUntil); break;
    case "subscription.trial_cancelled":
    case "subscription.end_now":
    case "subscription.end_now.mock":
    case "cancellation.finalise":
    case "reconcile.cancel": add("subscription_ended", family.stripeSubscriptionId || family.cancelledAt); break;
    case "subscription.resume":
    case "subscription.keep":
    case "subscription.keep.mock": add("renewal_resumed", family.currentPeriodEnd || eventId); break;
    case "subscription.upgrade_yearly":
    case "subscription.upgrade_yearly.mock":
    case "subscription.trial_switch_yearly":
    case "subscription.trial_switch_yearly.mock":
      add("yearly_upgrade", p.yearlySubscriptionId || p.subscriptionId || family.yearlyUpgrade?.yearlySubscriptionId || eventId); break;
    case "subscription.cancel_refunded": {
      const refund = family.refunds?.find(r => r.refundId === p.refundId);
      add("refund_full", p.refundId, { amountCents: refund?.amountCents });
      if (p.revertedToMonthlyUntil) add("monthly_restored", p.refundId, { nextDate: p.revertedToMonthlyUntil });
      break;
    }
    case "refund.create":
    case "refund.mock": add(p.fullRefund === false ? "refund_partial" : "refund_full", p.refundId || eventId); break;
    case "billing_exception.partial_refund": add("refund_partial", p.refundId); break;
    case "trial.create": add("trial_started", family.trialEndsAt, { trialDays: p.days }); break;
    case "support.message": add("op_new_support", p.id, { operator: true }); break;
    case "goal.completed": add("goal_completed", p.goalId); break;
  }
  return result;
}

module.exports = { emailEvents };
