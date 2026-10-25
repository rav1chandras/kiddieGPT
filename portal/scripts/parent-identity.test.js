const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("signed-in family name replaces the old placeholder in overview and support", () => {
  const html = fs.readFileSync(path.join(__dirname, "../webapp/index.html"), "utf8");
  assert.doesNotMatch(html, /Maya Patel|Good evening, Maya/);
  const source = fs.readFileSync(path.join(__dirname, "../webapp/webapp.js"), "utf8");
  const start = source.indexOf("    function formValue(name)");
  const end = source.indexOf("    function resetSubscriptionPanel()", start);
  assert.ok(start >= 0 && end > start);
  const nodes = Object.fromEntries(["live-page-title", "support-account-name", "support-account-email", "support-account-initials"]
    .map(id => [id, { textContent: "" }]));
  const context = {
    form: { elements: { parentName: { value: "Maya Patel" }, email: { value: "parent.kiddiegpt@gmail.com" } } },
    panels: [{ dataset: { parentPanel: "overview" }, classList: { contains: name => name === "is-active" } }],
    document: { getElementById: id => nodes[id] }
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  context.showParentIdentity("Alex Rivera", "alex@gmail.com");
  assert.equal(context.form.elements.parentName.value, "Alex Rivera");
  assert.equal(context.form.elements.email.value, "alex@gmail.com");
  assert.equal(nodes["live-page-title"].textContent, "Good evening, Alex");
  assert.equal(nodes["support-account-name"].textContent, "Alex Rivera");
  assert.equal(nodes["support-account-email"].textContent, "alex@gmail.com");
  assert.equal(nodes["support-account-initials"].textContent, "AR");
});
