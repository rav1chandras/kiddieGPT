const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createPersistenceReady } = require("../lib/persistence-ready");

test("concurrent requests share initialization and successful readiness", async () => {
  let calls = 0;
  const ready = createPersistenceReady(async () => { calls++; });
  await Promise.all([ready(), ready(), ready()]);
  await ready();
  assert.equal(calls, 1);
});

test("a transient failure recovers after cooldown without a retry storm", async () => {
  let calls = 0;
  let time = 0;
  const ready = createPersistenceReady(async () => {
    if (++calls === 1) throw new Error("Invalid database credentials");
  }, { now: () => time, cooldownMs: 2000 });
  await assert.rejects(ready(), /Invalid database credentials/);
  await assert.rejects(ready(), /Invalid database credentials/);
  assert.equal(calls, 1);
  time = 2000;
  await Promise.all([ready(), ready()]);
  assert.equal(calls, 2);
});

test("a transient connection timeout retries within the same request", async () => {
  let calls = 0;
  const ready = createPersistenceReady(async () => {
    if (++calls < 3) throw new Error("Authentication timed out");
  }, { sleep: async () => {} });
  await ready();
  assert.equal(calls, 3);
});

test("persistent connection timeouts stop after three attempts", async () => {
  let calls = 0;
  const ready = createPersistenceReady(async () => {
    calls++;
    throw new Error("Connection terminated due to connection timeout");
  }, { sleep: async () => {} });
  await assert.rejects(ready(), /connection timeout/);
  assert.equal(calls, 3);
});
