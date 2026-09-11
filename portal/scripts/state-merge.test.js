const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mergeState } = require("../lib/state-merge");
test("a stale profile writer preserves completed billing changes and other families", () => {
  const before = { families: [{ id: "one", name: "Old", status: "active" }], billingOperations: {} };
  const after = { ...before, families: [{ ...before.families[0], name: "New" }] };
  const current = { families: [{ id: "one", name: "Old", status: "cancelled", refundId: "r" }, { id: "two" }], billingOperations: { r: { status: "done" } } };
  assert.deepEqual(mergeState(before, after, current), { ...current, families: [{ id: "one", name: "New", status: "cancelled", refundId: "r" }, { id: "two" }] });
});
test("explicit removals, additions and nested changes are retained", () => {
  assert.deepEqual(mergeState({ a: 1, b: 2, rows: [{ id: "x" }] }, { a: 3, rows: [{ id: "y" }] }, { a: 1, b: 2, c: 4, rows: [{ id: "x" }, { id: "z" }] }), { a: 3, c: 4, rows: [{ id: "y" }, { id: "z" }] });
});
