const promotionalKeys = new Set(["winback", "low_usage", "finish_setup"]);
const isPromotional = key => promotionalKeys.has(key);
function messageStream(key, env = process.env) {
  const transactional = env.POSTMARK_MESSAGE_STREAM || "outbound";
  if (!isPromotional(key)) return transactional;
  const broadcast = env.POSTMARK_BROADCAST_STREAM;
  if (!broadcast || broadcast === transactional) throw new Error("Configure a separate Postmark broadcast stream before sending promotions.");
  return broadcast;
}
function promotionalAllowed(family) {
  return Boolean(family?.marketingConsent?.acceptedAt && !family.marketingConsent.revokedAt && !family.deletionRequestedAt && !family.anonymizedAt);
}
module.exports = { isPromotional, messageStream, promotionalAllowed };
