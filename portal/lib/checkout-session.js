async function createCheckoutSession(stripe, payload, onMissingCustomer) {
  try {
    return await stripe.checkout.sessions.create(payload);
  } catch (error) {
    // Only a confirmed missing customer permits checkout with a fresh identity.
    const missingCustomer = payload.customer && error.code === "resource_missing" &&
      (error.param === "customer" || /^No such customer:/.test(error.message || ""));
    if (!missingCustomer) throw error;
    await onMissingCustomer(payload.customer);
    const retry = { ...payload, customer_email: payload.metadata.parentEmail || undefined };
    delete retry.customer;
    return stripe.checkout.sessions.create(retry);
  }
}

module.exports = { createCheckoutSession };
