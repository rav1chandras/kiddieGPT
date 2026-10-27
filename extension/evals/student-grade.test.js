const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../sidepanel.js'), 'utf8');
const box = {
  portalSession: { childId: 'a', children: [{ id: 'a', grade: 'Grade 2' }, { id: 'b', grade: 'Grade 10' }] },
  MODELS: { defaultText: 'test' }, storageFallback: 'settings',
  extensionApi: { storage: { local: { get: (defaults, cb) => cb({ ...defaults, gradeBand: '9-12' }) } } },
  localStorage: { getItem: () => JSON.stringify({ gradeBand: 'K-2' }) }
};
vm.createContext(box);
vm.runInContext(source.slice(source.indexOf('function selectedStudentGradeBand()'), source.indexOf('function saveSettings(')), box);
(async () => {
  assert.equal((await box.getSettings()).gradeBand, 'K-2', 'Portal grade overrides old Chrome storage');
  box.portalSession.childId = 'b';
  assert.equal((await box.getSettings()).gradeBand, '9-12', 'Switching students updates the band');
  box.extensionApi = null;
  assert.equal((await box.getSettings()).gradeBand, '9-12', 'Portal grade overrides browser fallback storage');
  for (const [grade, band] of [['Kindergarten','K-2'],['Grade 3','3-5'],['5','3-5'],['Grade 6','6-8'],['Grade 8','6-8'],['Grade 12','9-12'],['K-2','K-2'],['3-5','3-5'],['','6-8']]) {
    box.portalSession.children[1].grade = grade;
    assert.equal(box.selectedStudentGradeBand(), band, grade);
  }
  console.log('Student grade passed: portal priority, student switching, grade mapping, storage fallbacks.');
})().catch(error => { console.error(error); process.exitCode = 1; });
