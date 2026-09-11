const DAY = 86400000;
const HOUR = 3600000;

function refundWindow(family, now = Date.now()) {
  const chargedAt = family?.lastPaymentAt || "";
  const charged = Date.parse(chargedAt);
  const ends = charged + 24 * HOUR;
  return {
    eligible: Number.isFinite(charged) && charged <= now && now < ends
      && Number(family.lastPaymentAmountCents || 0) > 0
      && !["refunded", "trial", "pending"].includes(family.paymentStatus),
    hours: 24, chargedAt, endsAt: Number.isFinite(ends) ? new Date(ends).toISOString() : "",
    amountCents: Number(family?.lastPaymentAmountCents || 0),
    isRenewal: Boolean(family?.firstPaymentAt && charged > Date.parse(family.firstPaymentAt) + 60000),
    upgrade: family?.yearlyUpgrade?.status === "scheduled"
  };
}

function recordRefundCancellation(family, paymentId, now = Date.now()) {
  const history = family.refundCancellationHistory || [];
  if (!history.some(item => item.paymentId === paymentId)) history.push({ paymentId, at: new Date(now).toISOString() });
  family.refundCancellationHistory = history.filter(item => Date.parse(item.at) > now - 30 * DAY);
  if (family.refundCancellationHistory.length >= 2) {
    // Duplicate delivery must not extend the pause.
    const last = Math.max(...family.refundCancellationHistory.map(item => Date.parse(item.at)));
    family.purchasePausedUntil = new Date(last + DAY).toISOString();
  }
}

function purchaseCooldown(family, now = Date.now()) {
  const until = family?.purchasePausedUntil;
  return until && Date.parse(until) > now ? { until, untilMs: Date.parse(until) } : null;
}

function addMonths(timestamp, months) {
  const date = new Date(timestamp);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.getTime();
}

function upgradeTerms(family, pricing, now = Date.now()) {
  const promo = pricing.yearlyUpgrade || {};
  const bonusMonths = promo.enabled === false ? 0 : Math.min(24, Math.max(0, Math.trunc(Number(promo.bonusMonths) || 0)));
  const discount = promo.enabled === false ? 0 : Math.max(0, Number(promo.discountAmount) || 0);
  const amountCents = Math.max(0, Math.round((Number(pricing.yearly.amount) - discount) * 100));
  const trialing = family.subscriptionStatus === "trialing";
  const end = Date.parse(trialing ? family.trialEndsAt : family.currentPeriodEnd);
  if (!Number.isFinite(end) || end <= now) throw new Error("Refresh the subscription: its paid-through or trial end date is missing or expired.");
  const endsAt = Math.floor(addMonths(end, 12 + bonusMonths) / 1000);
  if (!Number.isSafeInteger(amountCents)) throw new Error("The yearly offer price is invalid.");
  if (endsAt * 1000 - (trialing ? end : now) > 730 * DAY) throw new Error("The configured offer exceeds Stripe's 730-day billing deferral limit. Reduce the bonus months.");
  return { bonusMonths, accessMonths: 12 + bonusMonths, amountCents,
    priceId: pricing.yearly.stripePriceId, note: promo.enabled === false ? "" : String(promo.note || ""),
    monthlyEndsAt: Math.floor(end / 1000),
    startsAt: Math.floor((trialing ? end : now) / 1000),
    endsAt,
    trialing };
}

function restoreMonthly(family, now = Date.now()) {
  const old = family.yearlyUpgrade;
  if (!old || old.status !== "scheduled") return false;
  const end = typeof old.monthlyEndsAt === "number" ? old.monthlyEndsAt * 1000 : Date.parse(old.monthlyEndsAt);
  if (!(end > now) || !old.monthlySubscriptionIds?.length) return false;
  family.yearlyUpgrade = { ...old, status: "ended", endedAt: new Date(now).toISOString() };
  family.plan = "Family Monthly";
  family.stripeSubscriptionId = old.monthlySubscriptionIds[0];
  family.stripePaymentId = old.monthlyPaymentId || "";
  family.lastPaymentAt = old.monthlyPaymentAt || "";
  family.lastPaymentAmountCents = old.monthlyPaymentAmountCents || 0;
  family.paymentStatus = "paid";
  family.currentPeriodEnd = new Date(end).toISOString();
  family.subscriptionStatus = "cancel_scheduled";
  family.cancellationRequested = true;
  family.cancellationStatus = "scheduled";
  family.cancelAtPeriodEnd = true;
  family.cancelAccessUntil = family.currentPeriodEnd;
  family.cancellationAccessUntil = family.currentPeriodEnd;
  family.cancellationSubscriptionId = family.stripeSubscriptionId;
  return true;
}

module.exports = { refundWindow, recordRefundCancellation, purchaseCooldown, addMonths, upgradeTerms, restoreMonthly };
