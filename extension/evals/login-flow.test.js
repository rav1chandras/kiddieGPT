const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../sidepanel.js'), 'utf8');
const nodes = new Map();
function node(selector) {
  if (!nodes.has(selector)) nodes.set(selector, {
    value: selector === '#kg-gate-email' ? 'student@gmail.com' : '',
    disabled: false, listeners: {}, classList: { add() {}, remove() {} },
    addEventListener(type, callback) { this.listeners[type] = callback; },
    querySelector: node, focus() { this.focused = true; }
  });
  return nodes.get(selector);
}
let html = '';
const gate = { querySelector: node, classList: { add() {}, remove() {} },
  set innerHTML(value) { html = value; nodes.clear(); }, get innerHTML() { return html; } };
const box = {
  setTimeout, clearTimeout, AbortController, Date,
  otpState: { step: 'email' }, authConfig: {}, gateMethod: 'code',
  PORTAL_EMAIL_KEY: 'email', portalBaseUrl: () => 'https://example.test',
  fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
  storageSet: () => new Promise(() => {}), // A stalled storage callback must not hold the screen.
  storageGet: async () => ({}), ensureGateStyles() {}, portalGateEl: () => gate,
  escapeHtml: String, isReviewEmail: () => false, startResendCountdown() {},
  dismissGateToHome() {}, friendlyError: String, reportIssue() {},
  PortalError: class extends Error { constructor(code) { super(code); this.code = code; } }
};
vm.createContext(box);
vm.runInContext(source.slice(source.indexOf('async function requestOtp('), source.indexOf('async function verifyOtp(')), box);
vm.runInContext(source.slice(source.indexOf('function renderPortalGate('), source.indexOf('function renderPortalState(')), box);
(async () => {
  box.renderPortalGate('login', '');
  assert.match(html, /Email me a code/);
  await node('#kg-gate-form').listeners.submit({ preventDefault() {} });
  assert.equal(box.otpState.step, 'code');
  assert.match(html, /Enter your code/);
  assert.match(html, /id="kg-gate-code"/);
  assert.match(html, /Verify code/);
  assert.equal(node('#kg-gate-code').focused, true);
  node('#kg-gate-changeemail').listeners.click();
  assert.equal(box.otpState.step, 'email');
  assert.match(html, /Email me a code/);
  console.log('Login flow passed: submit -> code entry + focus -> change email.');
})().catch(error => { console.error(error); process.exitCode = 1; });
