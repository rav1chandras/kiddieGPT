const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function consentUi() {
  const source = fs.readFileSync(path.join(__dirname, "../webapp/webapp.js"), "utf8");
  const start = source.indexOf("    function setParentalConsentState(consent)");
  const end = source.indexOf("    function showParentGate", start);
  assert.ok(start >= 0 && end > start);
  const context = {
    studentWorkspace: { classList: { toggle: () => {} } },
    parentalConsentPanel: {}, parentalConsentCheckbox: {}, acceptParentalConsent: {},
    parentalConsentStatus: {}, addChild: {}, finish: {},
    loadParentFamily: async () => {}
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return context;
}

test("portal shows consent and blocks profile controls until accepted", () => {
  const ui = consentUi();
  ui.setParentalConsentState(null);
  assert.equal(ui.parentalConsentPanel.hidden, false);
  assert.equal(ui.parentalConsentCheckbox.checked, false);
  assert.equal(ui.acceptParentalConsent.disabled, true);
  assert.equal(ui.addChild.disabled, true);
  assert.equal(ui.finish.disabled, true);
  ui.setParentalConsentState({ acceptedAt: "2026-10-24T12:00:00Z" });
  assert.equal(ui.parentalConsentPanel.hidden, true);
  assert.equal(ui.addChild.disabled, false);
  assert.equal(ui.finish.disabled, false);
});

test("portal requires explicit checkbox and server evidence to unlock profiles", async () => {
  const ui = consentUi();
  ui.setParentalConsentState(null);
  ui.parentAuthFetch = async () => assert.fail("Unchecked consent must not be sent");
  await ui.acceptParentalConsentAndContinue();
  ui.parentalConsentCheckbox.checked = true;
  ui.parentAuthFetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
  await ui.acceptParentalConsentAndContinue();
  assert.equal(ui.parentalConsentPanel.hidden, false);
  assert.equal(ui.addChild.disabled, true);
  assert.match(ui.parentalConsentStatus.textContent, /not recorded/);
  ui.parentAuthFetch = async () => ({ ok: true, json: async () => ({ parentalConsent: { acceptedAt: "2026-10-24T12:00:00Z" } }) });
  await ui.acceptParentalConsentAndContinue();
  assert.equal(ui.parentalConsentPanel.hidden, true);
  assert.equal(ui.addChild.disabled, false);
});
