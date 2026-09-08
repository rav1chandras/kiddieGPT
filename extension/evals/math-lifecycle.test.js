const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../sidepanel.js'), 'utf8');
function section(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}
const solveCode = section('async function ensureMathProblemSolved(', 'async function solveMathWithAI(');
function context() {
  const box = {
    console: { warn() {} }, AbortController, setTimeout, clearTimeout,
    mathSolveState: { problems: [{ status: 'idle', equation: 'x=1' }], index: 0 },
    lastMathSolve: { transcript: [{}], gradeBand: '6-8' }, mathSolveToken: 1,
    getOpenAISettings: async () => ({}), renderMathSolution() {},
    mathTranscriptSource: () => '', getMathVisionParts: () => [], mathSingleSolveNote: () => '',
    normalizeMathProblems: () => [{ lines: [{ math: 'x=1' }], answer: '1' }],
    applyMathChoiceGuard() {}, saveMathSession() {}, friendlyError: String
  };
  vm.createContext(box);
  vm.runInContext(solveCode, box);
  return box;
}
(async () => {
  const box = context();
  let calls = 0;
  box.solveMathOnce = async () => { calls++; return {}; };
  await vm.runInContext('ensureMathProblemSolved(0)', box);
  assert.equal(calls, 1, 'Next must launch a solve');
  await vm.runInContext('ensureMathProblemSolved(0)', box);
  assert.equal(calls, 1, 'Ready problems are reused');
  box.mathSolveState.problems[0].status = 'idle';
  box.solveMathOnce = async () => { calls++; throw new DOMException('Cancelled', 'AbortError'); };
  await vm.runInContext('solveMathProblemInPlace({index:0,token:1})', box);
  assert.equal(calls, 2, 'Cancellation must not retry');
  assert.equal(box.mathSolveState.problems[0].status, 'idle');

  Object.assign(box, {
    learningOwner: 'student-a', currentLearningOwner: () => box.learningOwner,
    MATH_SESSION_KEY: 'math', MATH_SESSION_TTL_MS: 86400000,
    mathCorrectionAttempts: new Map(), mathAnswersRevealed: true,
    storageGet: async () => ({ 'math:student-a': {
      owner: 'student-a', savedAt: Date.now(), problems: [{ status: 'solving' }], index: 0
    } })
  });
  vm.runInContext(section('async function restoreMathSession()', 'async function clearMathSession()'), box);
  assert.equal(await box.restoreMathSession(), true);
  assert.equal(box.mathSolveState.problems[0].status, 'idle', 'Reopened requests must be retryable');
  box.learningOwner = 'student-b';
  assert.equal(await box.restoreMathSession(), false, 'Another student cannot restore this worksheet');

  const savedActivity = {};
  Object.assign(box, {
    learningOwner: 'student-a', activityStorageKey: 'kiddiegptActivity:student-a',
    activityCache: { today: { lessons: 2 } }, activitySaveTimer: 0, activitySyncTimer: 0,
    mathBackgroundAbortController: null, pruneActivity: value => value,
    currentLearningOwner: () => 'student-b',
    storageSet: async value => Object.assign(savedActivity, value),
    loadActivity: async () => ({ today: { lessons: 5 } }),
    restoreMathSession: async () => false, renderActivityDashboard() {}
  });
  vm.runInContext(section('async function switchLearningOwner()', 'let activityCache ='), box);
  await box.switchLearningOwner();
  assert.equal(savedActivity['kiddiegptActivity:student-a'].today.lessons, 2);
  assert.equal(box.activityStorageKey, 'kiddiegptActivity:student-b');
  assert.equal(box.activityCache.today.lessons, 5, 'Switch loads only the selected student activity');
  assert.equal(box.mathSolveState.problems.length, 0);

  Object.assign(box, {
    portalToken: 'real', OTP_TEST_TOKEN: 'test', portalSession: {}, MODELS: { defaultText: 'test' },
    portalBaseUrl: () => 'https://example.test', toolForCurrentView: () => 'math',
    fetch: async (_, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')));
    })
  });
  vm.runInContext(section('async function callOpenAIJson(', '// ---- Parent sign-in gate'), box);
  await assert.rejects(box.callOpenAIJson({ settings: {}, text: '', maxOutputTokens: 1,
    timeoutMs: 10, signal: new AbortController().signal }), { name: 'AbortError' });
  console.log('Math lifecycle regressions passed: Next, reuse, cancellation, restore ownership, timeout.');
})().catch(error => { console.error(error); process.exitCode = 1; });
