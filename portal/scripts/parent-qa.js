// Parent-journey QA sweep. Every account is created fresh under a qa.<stamp>
// prefix so no existing family is touched. Run against the local portal only.
const BASE = process.env.BASE || "http://localhost:8080";
const PW = "kiddiegpt123";
const stamp = Date.now().toString(36);

const results = [];
let seq = 0;

function record(area, scenario, expected, actual, pass, note) {
  results.push({ area, scenario, expected, actual, pass, note: note || "" });
}

async function api(path, { method = "GET", token, body } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let payload = null;
  const text = await res.text();
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text.slice(0, 120) }; }
  return { status: res.status, body: payload || {} };
}

async function newFamily(label, overrides = {}) {
  const email = `qa.${label}.${stamp}.${++seq}@gmail.com`;
  const created = await api("/api/families", {
    method: "POST",
    body: { email, parentName: `QA ${label}`, password: PW, ...overrides }
  });
  const login = await api("/api/auth/login", { method: "POST", body: { email, password: PW, role: "parent" } });
  return { email, familyId: created.body.id, token: login.body.token, created, login };
}

// Mock checkout: create session, then confirm it (mirrors the webhook).
// NOTE: the server grants the card-upfront trial to every trial-eligible
// family — `wantsTrial` is not consulted. To test a straight paid
// subscription the family must first be marked as having used its trial.
async function checkout(fam, planName, { trial = false } = {}) {
  if (!trial) await setFlag(fam.email, "trialUsedAt", new Date(Date.now() - 60 * 86400000).toISOString());
  const session = await api("/api/stripe/create-checkout-session", {
    method: "POST", token: fam.token,
    body: { planName, email: fam.email, familyId: fam.familyId, wantsTrial: trial }
  });
  const sessionId = session.body.sessionId || session.body.id;
  if (!sessionId) return { session, confirm: null };
  const confirm = await api("/api/stripe/confirm-checkout-session", {
    method: "POST", token: fam.token, body: { sessionId, email: fam.email }
  });
  return { session, confirm };
}

const ent = async (fam) => (await api("/api/entitlements/me", { token: fam.token })).body;

async function main() {
  // ---- 1. Signup + entitlement gating -----------------------------------
  {
    const fam = await newFamily("signup");
    const e = await ent(fam);
    record("Signup", "New account has no entitlement", "active=false", `active=${e.active}`, e.active === false);
    record("Signup", "Login returns a token", "token", fam.token ? "token" : "none", Boolean(fam.token));
  }

  // ---- 2. Monthly checkout ----------------------------------------------
  {
    const fam = await newFamily("monthly");
    const { confirm } = await checkout(fam, "Family Monthly");
    const e = await ent(fam);
    record("Subscribe", "Monthly checkout activates", "active=true status=active",
      `active=${e.active} status=${e.status}`, e.active === true && e.status === "active");
    record("Subscribe", "Monthly plan recorded", "Family Monthly", String(e.plan), String(e.plan).includes("Monthly"));
    record("Subscribe", "Renewal date is sane (<40d)", "<40 days",
      renewalDays(e.renewalAt), renewalDays(e.renewalAt) !== "none" && parseInt(renewalDays(e.renewalAt)) <= 40);
    fam._confirm = confirm;
  }

  // ---- 3. Yearly checkout ------------------------------------------------
  {
    const fam = await newFamily("yearly");
    await checkout(fam, "Family Yearly");
    const e = await ent(fam);
    record("Subscribe", "Yearly checkout activates", "active=true", `active=${e.active}`, e.active === true);
    record("Subscribe", "Yearly plan recorded", "Family Yearly", String(e.plan), String(e.plan).includes("Yearly"));
  }

  // ---- 4. Card-upfront trial --------------------------------------------
  {
    const fam = await newFamily("trial");
    await checkout(fam, "Family Monthly", { trial: true });
    const e = await ent(fam);
    const trialing = e.status === "trialing" || (e.trial && e.trial.active);
    record("Trial", "Trial checkout entitles the child", "active=true", `active=${e.active}`, e.active === true);
    record("Trial", "Status reflects trialing", "trialing", `${e.status}`, Boolean(trialing));

    // one trial per account
    const second = await checkout(fam, "Family Monthly", { trial: true, keepTrialFlag: true });
    const trialDays = second.session.body.trialDays;
    record("Trial", "Second trial refused (one per account)", "trialDays=0",
      `trialDays=${trialDays}`, !trialDays);
  }

  // ---- 5. Cancel inside the refund window --------------------------------
  {
    const fam = await newFamily("refundcancel");
    await checkout(fam, "Family Monthly");
    const cancel = await api("/api/stripe/request-cancellation", { method: "POST", token: fam.token, body: {} });
    const e = await ent(fam);
    record("Cancel", "Fresh payment is inside refund window", "eligible=true",
      `eligible=${cancel.body.refundWindow?.eligible}`, cancel.body.refundWindow?.eligible === true);
    record("Cancel", "Cancelling refunds in full", "refunded=true",
      `refunded=${cancel.body.refunded}`, cancel.body.refunded === true);
    record("Cancel", "Access ends immediately on refund", "active=false",
      `active=${e.active}`, e.active === false);
  }

  // ---- 6. Cancel outside the refund window -------------------------------
  {
    const fam = await newFamily("latecancel");
    await checkout(fam, "Family Monthly");
    await backdatePayment(fam.email, 10);
    const cancel = await api("/api/stripe/request-cancellation", { method: "POST", token: fam.token, body: {} });
    const e = await ent(fam);
    record("Cancel", "Old payment is outside refund window", "eligible=false",
      `eligible=${cancel.body.refundWindow?.eligible}`, cancel.body.refundWindow?.eligible === false);
    record("Cancel", "No refund after the window", "refunded=false",
      `refunded=${cancel.body.refunded}`, cancel.body.refunded === false);
    record("Cancel", "Access continues to period end", "active=true",
      `active=${e.active}`, e.active === true);
    record("Cancel", "Status is cancel_scheduled", "cancel_scheduled",
      `${cancel.body.status}`, cancel.body.status === "cancel_scheduled");

    // ---- 7. Resume (undo the cancellation) -------------------------------
    const resume = await api("/api/stripe/resume-subscription", { method: "POST", token: fam.token, body: {} });
    const e2 = await ent(fam);
    record("Auto-renew", "Resume restores auto-renewal", "status=active",
      `${resume.body.status || resume.status}`, resume.body.status === "active");
    record("Auto-renew", "Access retained after resume", "active=true",
      `active=${e2.active}`, e2.active === true);
  }

  // ---- 8. Retention discount --------------------------------------------
  {
    const fam = await newFamily("retention");
    await checkout(fam, "Family Monthly");
    await backdatePayment(fam.email, 10);
    const applied = await api("/api/stripe/apply-retention-discount", { method: "POST", token: fam.token, body: {} });
    const e = await ent(fam);
    record("Retention", "Discount applies without cancelling", "ok + active",
      `status=${applied.status} active=${e.active}`, applied.status === 200 && e.active === true);
    const again = await api("/api/stripe/apply-retention-discount", { method: "POST", token: fam.token, body: {} });
    record("Retention", "Re-applying is idempotent", "no error",
      `status=${again.status}`, again.status === 200);
  }

  // ---- 9. Upgrade monthly -> yearly --------------------------------------
  {
    const fam = await newFamily("upgrade");
    await checkout(fam, "Family Monthly");
    await backdatePayment(fam.email, 10);
    const up = await api("/api/stripe/upgrade-yearly", { method: "POST", token: fam.token, body: {} });
    const e = await ent(fam);
    record("Upgrade", "Monthly upgrades to yearly", "ok",
      `status=${up.status}`, up.status === 200);
    record("Upgrade", "Carry-over is capped at one month", "<=31 days",
      `${up.body.proratedDays} days`, Number(up.body.proratedDays) <= 31);
    record("Upgrade", "Still entitled after upgrade", "active=true",
      `active=${e.active}`, e.active === true);
    record("Upgrade", "Renewal ~1 year out", "300-460 days",
      renewalDays(e.renewalAt), inRange(renewalDays(e.renewalAt), 300, 460));

    // ---- 10. Cancel the upgrade inside its window ------------------------
    const cancel = await api("/api/stripe/request-cancellation", { method: "POST", token: fam.token, body: {} });
    const e2 = await ent(fam);
    record("Upgrade", "Upgrade refunds inside the window", "refunded=true",
      `refunded=${cancel.body.refunded}`, cancel.body.refunded === true);
    record("Upgrade", "Paid monthly time is not forfeited", "active=true",
      `active=${e2.active}`, e2.active === true);
    record("Upgrade", "Back on the monthly plan", "Monthly",
      String(e2.plan), String(e2.plan).includes("Monthly"));
  }

  // ---- 11. Re-subscribe after a full cancellation ------------------------
  {
    const fam = await newFamily("resub");
    await checkout(fam, "Family Monthly");
    await api("/api/stripe/request-cancellation", { method: "POST", token: fam.token, body: {} });
    const gone = await ent(fam);
    const { confirm } = await checkout(fam, "Family Monthly");
    const back = await ent(fam);
    record("Re-subscribe", "Cancelled account can enrol again", "active false -> true",
      `${gone.active} -> ${back.active}`, gone.active === false && back.active === true);
  }

  // ---- 12. Account actions ----------------------------------------------
  {
    const fam = await newFamily("account");
    await checkout(fam, "Family Monthly");
    const support = await api("/api/support/message", {
      method: "POST", token: fam.token, body: { category: "Billing", message: "QA sweep test message" }
    });
    record("Account", "Support message accepted", "ok", `status=${support.status}`, support.status === 200);

    const controls = await api("/api/account/controls", { method: "PUT", token: fam.token, body: { dailyMinutes: 45 } });
    record("Account", "Parental controls save", "ok", `status=${controls.status}`, controls.status === 200);

    const pw = await api("/api/account/change-password", {
      method: "POST", token: fam.token, body: { currentPassword: PW, newPassword: "kiddiegpt456" }
    });
    record("Account", "Password change accepted", "ok", `status=${pw.status}`, pw.status === 200);
    const relogin = await api("/api/auth/login", { method: "POST", body: { email: fam.email, password: "kiddiegpt456", role: "parent" } });
    record("Account", "New password works", "token", relogin.body.token ? "token" : "none", Boolean(relogin.body.token));
    const oldpw = await api("/api/auth/login", { method: "POST", body: { email: fam.email, password: PW, role: "parent" } });
    record("Account", "Old password rejected", "no token", oldpw.body.token ? "token" : "rejected", !oldpw.body.token);
  }

  // ---- 13. Auth boundaries ----------------------------------------------
  {
    const noAuth = await api("/api/entitlements/me");
    record("Auth", "Entitlements need a token", "401", `${noAuth.status}`, noAuth.status === 401);
    const bad = await api("/api/support/messages", { token: "not-a-real-token" });
    record("Auth", "Forged token rejected", "401", `${bad.status}`, bad.status === 401);
    const unknown = await api("/api/auth/login", { method: "POST", body: { email: `qa.ghost.${stamp}@gmail.com`, password: PW, role: "parent" } });
    record("Auth", "Unknown email cannot log in", "404/401", `${unknown.status}`, unknown.status === 404 || unknown.status === 401);
  }

  // ---- 14. Locked account ------------------------------------------------
  {
    const fam = await newFamily("locked");
    await checkout(fam, "Family Monthly");
    await setFlag(fam.email, "accountLocked", true);
    const login = await api("/api/auth/login", { method: "POST", body: { email: fam.email, password: PW, role: "parent" } });
    const call = await api("/api/support/messages", { token: fam.token });
    record("Locked", "Locked account blocked (login or API)", "423",
      `login=${login.status} api=${call.status}`, login.status === 423 || call.status === 423);
  }

  print();
}

// --- helpers that poke the DB directly (test scaffolding only) ------------
const fs = require("fs");
const DB = "/app/data/kiddiegpt-db.json";
function editFamily(email, fn) {
  const db = JSON.parse(fs.readFileSync(DB, "utf8"));
  const fam = db.families.find((f) => f.email === email);
  if (fam) fn(fam);
  fs.writeFileSync(DB, JSON.stringify(db, null, 2));
}
async function backdatePayment(email, days) {
  const when = new Date(Date.now() - days * 86400000).toISOString();
  editFamily(email, (f) => { f.lastPaymentAt = when; f.paidAt = when; });
  await api("/api/pricing"); // nudge a read so the server reloads from disk
}
async function setFlag(email, key, value) {
  editFamily(email, (f) => { f[key] = value; });
  await api("/api/pricing");
}

function renewalDays(iso) {
  if (!iso) return "none";
  const d = Math.round((new Date(iso).getTime() - Date.now()) / 86400000);
  return Number.isFinite(d) ? String(d) : "none";
}
function inRange(v, lo, hi) { const n = parseInt(v); return Number.isFinite(n) && n >= lo && n <= hi; }

function print() {
  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  let area = "";
  console.log("");
  for (const r of results) {
    if (r.area !== area) { area = r.area; console.log(`\n== ${area} ==`); }
    console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${pad(r.scenario, 46)} expected ${pad(r.expected, 26)} got ${r.actual}`);
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log("\nFAILURES:");
    for (const f of failed) console.log(`  [${f.area}] ${f.scenario} -> expected ${f.expected}, got ${f.actual}`);
  }
}

main().catch((e) => { console.error("harness error:", e); process.exit(1); });
