const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../../portal/lib/app.js'), 'utf8');
const handlers = {};
const family = { children: [{ id: 'child1', studentName: 'Student', learningGoals: [{ goal: 'Read', reward: 'Movie', completed: false }] }] };
const db = { families: [family], users: [] };
const box = { crypto: require('node:crypto'), requireParent() {}, requireParentalConsent() {},
  app: { post: (url, ...args) => handlers[url] = args.at(-1), put: (url, ...args) => handlers[url] = args.at(-1) },
  readDb: () => db, mutateDb: fn => fn(db), parentFamilyForIdentity: () => family, makeId: () => 'id', audit() {} };
vm.createContext(box);
vm.runInContext(source.slice(source.indexOf('function learningGoalId('), source.indexOf('// Parents explicitly consent')), box);
function call(url, body) { let result; let status=200; handlers[url]({body,auth:{}},{status(n){status=n;return this;},json(data){result=data;}}); return {status,result}; }
const goalId = box.learningGoalId('child1', family.children[0].learningGoals[0]);
assert.equal(call('/api/student/goals/status',{childId:'other',goalId,status:'in_progress'}).status,404);
assert.equal(call('/api/student/goals/status',{childId:'child1',goalId,status:'completed'}).status,400);
for (const status of ['in_progress','pending_review']) {
  assert.equal(call('/api/student/goals/status',{childId:'child1',goalId,status}).result.goals[0].status,status);
}
family.children[0].learningGoals[0].completed=true;
const payload = JSON.parse(JSON.stringify({children:family.children}));
call('/api/parent/family/profile',payload);
call('/api/parent/family/profile',payload);
assert.equal(family.goalStars.child1.length,1,'Parent saves must award exactly one star');
assert.equal(box.studentGoals(family,family.children[0])[0].status,'completed');
console.log('Student goals passed: ownership, transitions, parent completion, star deduplication.');
