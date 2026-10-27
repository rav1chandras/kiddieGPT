const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../sidepanel.js'), 'utf8');
const box = {
  AbortSignal, portalToken: 'session', OTP_TEST_TOKEN: 'test',
  PORTAL_EMAIL_KEY: 'email', PORTAL_CHILD_KEY: 'child',
  portalSession: { entitled: false }, mathBackgroundPaused: false,
  storageGet: async () => ({ email: 'parent@example.test', child: '1' }),
  normalizeChildren: list => list || [], pickChildId: () => '1',
  persistDefaultChild: async () => {}, switchLearningOwner: async () => {},
  renderPlanBanner() {}, renderChildSelect() {}, renderAuthButton() {},
  hidePortalGate() { box.closed = true; }
};
vm.createContext(box);
vm.runInContext(source.slice(source.indexOf('async function refreshEntitlement()'), source.indexOf('async function getUsageLimits()')), box);
(async () => {
  let requests = 0;
  box.portalFetch = async () => { requests++; return { active: true, childAccessAllowed: true }; };
  await Promise.all([box.syncOpenPanelAccess(), box.syncOpenPanelAccess()]);
  assert.equal(requests, 1, 'Concurrent refreshes are deduplicated');
  assert.equal(box.closed, true, 'Enrollment dismisses the gate');
  assert.equal(box.portalSession.entitled, true);
  box.portalFetch = async () => { throw new Error('Offline'); };
  await box.syncOpenPanelAccess();
  assert.equal(box.portalSession.entitled, true, 'Offline is not expiration');
  assert.equal(vm.runInContext('entitlementCheckFailed', box), true);
  box.portalFetch = async () => ({ active: false, childAccessAllowed: false, status: 'expired' });
  await box.syncOpenPanelAccess();
  assert.equal(box.portalSession.entitled, false);
  assert.equal(box.mathBackgroundPaused, true);
  console.log('Access refresh passed: enrollment, deduplication, offline, expiration.');
})().catch(error => { console.error(error); process.exitCode = 1; });
