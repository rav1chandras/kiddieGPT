const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCheckoutSession } = require('../lib/checkout-session');

test('missing customer retries checkout using parent email and preserves pricing', async () => {
  const payload = { customer: 'cus_deleted', metadata: { parentEmail: 'parent@example.com' }, line_items: [{ price: 'price_monthly' }], discounts: [{ coupon: 'promo' }] };
  const calls = [];
  let removed;
  const stripe = { checkout: { sessions: { create: async value => {
    calls.push(value);
    if (calls.length === 1) throw Object.assign(new Error('No such customer: cus_deleted'), { code: 'resource_missing', param: 'customer' });
    return { url: 'https://checkout.stripe.com/test' };
  } } } };
  await createCheckoutSession(stripe, payload, id => { removed = id; });
  assert.equal(removed, 'cus_deleted');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].customer, undefined);
  assert.equal(calls[1].customer_email, 'parent@example.com');
  assert.deepEqual(calls[1].discounts, payload.discounts);
  assert.deepEqual(calls[1].line_items, payload.line_items);
});

test('missing price and network failures never remove the customer or retry', async () => {
  for (const error of [Object.assign(new Error('No such price'), { code: 'resource_missing', param: 'line_items[0][price]' }), new Error('Network failure')]) {
    let calls = 0;
    const stripe = { checkout: { sessions: { create: async () => { calls++; throw error; } } } };
    await assert.rejects(createCheckoutSession(stripe, { customer: 'cus_valid' }, () => assert.fail('Must preserve customer')), error);
    assert.equal(calls, 1);
  }
});
