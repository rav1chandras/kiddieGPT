const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("each child may save at most two open goals while keeping completed goals", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kg-goal-limit-"));
  Object.assign(process.env, {
    DB_DRIVER: "file", DATA_DIR: dir, DATA_PATH: path.join(dir, "state.json"),
    ADMIN_EMAIL: "admin@gmail.com", ADMIN_PASSWORD: "test-password", REQUIRE_AUTH: "true",
    STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "", POSTMARK_SERVER_TOKEN: "",
    SMTP_HOST: "", AUTOPILOT_ENABLED: "false", ACTIVITY_LOG: "off"
  });
  const { app, initPersistence } = require("../lib/app");
  await initPersistence();
  const server = app.listen(0);
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = () => JSON.parse(fs.readFileSync(process.env.DATA_PATH, "utf8"));
  const call = async (url, body, token, method = "POST") => {
    const response = await fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    await call("/api/auth/signup", { email: "goals@gmail.com", name: "Goals Parent", password: "test-password" });
    const otp = state().emailLogs[0].preview.match(/\b\d{6}\b/)[0];
    const verified = await call("/api/auth/verify-otp", { email: "goals@gmail.com", otp });
    const token = verified.body.token;
    assert.equal((await call("/api/parent/consent", { accepted: true }, token)).status, 200);
    const longName = await call("/api/parent/family/profile", { children: [{ studentName: "Alice" }] }, token, "PUT");
    assert.equal(longName.status, 400);
    assert.match(longName.body.error, /up to 4 characters/);
    const defaultGrade = await call("/api/parent/family/profile", { children: [{ studentName: "Mia" }] }, token, "PUT");
    assert.equal(defaultGrade.status, 200);
    assert.equal(defaultGrade.body.family.children[0].grade, "Grade 7");
    const legacy = state();
    const legacyChild = legacy.families.find(item => item.email === "goals@gmail.com").children[0];
    legacyChild.studentName = "Alice";
    fs.writeFileSync(process.env.DATA_PATH, JSON.stringify(legacy));
    const unchangedLegacyName = await call("/api/parent/family/profile", {
      children: [{ id: legacyChild.id, studentName: "Alice", grade: 7 }]
    }, token, "PUT");
    assert.equal(unchangedLegacyName.status, 200);
    assert.equal(unchangedLegacyName.body.family.children[0].studentName, "Alice");
    const goal = (name, completed = false) => ({ goal: name, reward: "Family time", completed });
    const profile = learningGoals => ({ children: [{ studentName: "Lena", grade: 5, learningGoals }] });

    const valid = await call("/api/parent/family/profile", profile([goal("Reading"), goal("Math"), goal("Practice", true)]), token, "PUT");
    assert.equal(valid.status, 200);
    assert.equal(valid.body.family.children[0].learningGoals.length, 3);

    const invalid = await call("/api/parent/family/profile", profile([goal("Reading"), goal("Math"), goal("Practice")]), token, "PUT");
    assert.equal(invalid.status, 400);
    assert.match(invalid.body.error, /Only 2 open goals/);
    assert.equal(state().families.find(item => item.email === "goals@gmail.com").children[0].learningGoals[2].completed, true);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
