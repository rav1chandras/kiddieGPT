const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const path = require("node:path");
const { Pool } = require("pg");
const { acquireBillingLock } = require("../lib/billing-lock");

// Opt-in: point only at a disposable database, never the application's database.
test("Postgres advisory locks and two server instances preserve upgrade/refund state", { skip: !process.env.BILLING_TEST_DATABASE_URL }, async () => {
  const url = process.env.BILLING_TEST_DATABASE_URL;
  if (!/localhost|127\.0\.0\.1/.test(url)) throw Error("Use a disposable local database.");
  const pool = new Pool({ connectionString: url });
  const children = [];
  try {
    const release = await acquireBillingLock(pool, "pg-test");
    const other = await pool.connect();
    const locked = await other.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", ["billing:pg-test"]);
    assert.equal(locked.rows[0].locked, false);
    other.release(); await release();
    const start = async () => {
      const script = `const a=require(${JSON.stringify(path.resolve(__dirname, "../lib/app"))}); a.initPersistence().then(()=>{const h=require(${JSON.stringify(require.resolve("express"))})();h.use((req,res,next)=>{const end=res.end.bind(res);res.end=(...args)=>{a.flushPending().then(()=>end(...args));return res;};next();});h.use(a.app);const s=h.listen(0,()=>process.send({port:s.address().port}));process.on('message',()=>s.close(()=>process.exit(0)));}).catch(e=>{console.error(e);process.exit(1)});`;
      const child = spawn(process.execPath, ["-e", script], { env: { ...process.env, DB_DRIVER: "postgres", DATABASE_URL: url, POSTGRES_URL: url, REQUIRE_AUTH: "true", ADMIN_EMAIL: "admin@gmail.com", ADMIN_PASSWORD: "test-password", STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "", POSTMARK_SERVER_TOKEN: "", SMTP_HOST: "", AUTOPILOT_ENABLED: "false" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      children.push(child);
      const [msg] = await once(child, "message");
      return `http://127.0.0.1:${msg.port}`;
    };
    const first = await start(), second = await start();
    const call = async (base, route, body, token) => {
      const response = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    };
    const email = `postgres.billing.${Date.now()}@gmail.com`;
    let result = await call(first, "/api/auth/signup", { email, name: "PG Parent", password: "test-password", parentalConsent: true });
    assert.equal(result.status, 200);
    const data = async () => (await pool.query("SELECT data FROM app_state WHERE id=1")).rows[0].data;
    const code = (await data()).emailLogs[0].preview.match(/\b\d{6}\b/)[0];
    const token = (await call(first, "/api/auth/verify-otp", { email, otp: code })).data.token;
    const db = await data();
    const f = db.families.find(f => f.email === email);
    Object.assign(f, { subscriptionStatus: "active", paymentStatus: "paid", plan: "Family Monthly", stripeSubscriptionId: "sub_mock_pg", stripePaymentId: "pi_mock_pg", lastPaymentAt: new Date(Date.now()-5*86400000).toISOString(), lastPaymentAmountCents: 1900, currentPeriodEnd: new Date(Date.now()+20*86400000).toISOString() });
    db.pricing.yearly.stripePriceId = "price_year";
    await pool.query("UPDATE app_state SET data=$1::jsonb WHERE id=1", [JSON.stringify(db)]);
    const results = await Promise.all([call(first, "/api/stripe/upgrade-yearly", {}, token), call(second, "/api/stripe/upgrade-yearly", {}, token)]);
    assert.equal(results.filter(r => r.status === 200).length, 1, JSON.stringify(results));
    assert.equal(results.filter(r => r.status === 409).length, 1);
    assert.equal((await data()).families.find(x => x.id === f.id).plan, "Family Yearly");
    result = await call(second, "/api/stripe/request-cancellation", {}, token);
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.data.refunded, true);
    const restored = (await data()).families.find(x => x.id === f.id);
    assert.equal(restored.stripeSubscriptionId, "sub_mock_pg");
    assert.equal(restored.subscriptionStatus, "cancel_scheduled");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM billing_operations WHERE data->>'state'='completed' AND data->>'familyId'=$1", [f.id])).rows[0].n, 2);
  } finally {
    for (const child of children) { child.send("stop"); await once(child, "exit"); }
    await pool.end();
  }
});
