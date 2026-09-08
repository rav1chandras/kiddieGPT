const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../webapp/webapp.js'), 'utf8');
const checkout = source.slice(source.indexOf('    var checkoutInProgress = false;'), source.indexOf('      planInputs.forEach(function (input) {', source.indexOf('    var checkoutInProgress = false;')));

function fixture(request) {
  const status = { hidden: true, textContent: '' };
  const buttons = [{ disabled: false }, { disabled: false }];
  const context = {
    document: { getElementById: () => status },
    validateParentEmail: () => true,
    parentEmailHint: () => 'Unsupported email provider',
    selectedPlan: () => ({ key: 'monthly', name: 'Family Monthly', stripePriceId: 'price_monthly' }),
    formValue: (name) => name === 'email' ? 'test@gmail.com' : '',
    parentAuthFetch: request,
    childProfiles: () => { throw new Error('Unfinished child profile'); },
    localStorage: { setItem() {}, removeItem() {} },
    PENDING_CHECKOUT_PLAN_KEY: 'pending',
    paymentState: {}, completionTitle: {}, completionText: {},
    upgradeYearly: buttons[0], upgradeYearlyTileButton: buttons[1],
    window: { location: { href: '' } }, preview() {}
  };
  vm.createContext(context);
  vm.runInContext(checkout, context);
  return { context, status, buttons, run: () => context.startStripeCheckout() };
}

test('monthly checkout redirects without requiring a completed child profile', async () => {
  const f = fixture(async (url, options) => {
    assert.equal(url, '/api/stripe/create-checkout-session');
    assert.equal(JSON.parse(options.body).priceId, 'price_monthly');
    return { ok: true, json: async () => ({ url: 'https://checkout.stripe.com/test' }) };
  });
  await f.run();
  assert.equal(f.context.window.location.href, 'https://checkout.stripe.com/test');
});

test('failed checkout shows the server error and allows retry', async () => {
  const f = fixture(async () => ({ ok: false, status: 400, json: async () => ({ error: 'The selected price is unavailable.' }) }));
  await f.run();
  assert.equal(f.status.hidden, false);
  assert.equal(f.status.textContent, 'The selected price is unavailable.');
  assert.ok(f.buttons.every(button => !button.disabled));
  assert.equal(f.context.window.location.href, '');
});

test('repeated clicks create only one checkout request while pending', async () => {
  let resolve;
  let requests = 0;
  const f = fixture(() => { requests++; return new Promise(done => { resolve = done; }); });
  const first = f.run();
  await f.run();
  assert.equal(requests, 1);
  assert.ok(f.buttons.every(button => button.disabled));
  resolve({ ok: true, json: async () => ({ url: 'https://checkout.stripe.com/test' }) });
  await first;
});
