const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const path = require("path");
const Stripe = require("stripe");
const nodemailer = require("nodemailer");

const app = express();
const port = process.env.PORT || 80;
const publicDir = __dirname;
const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const dbPath = process.env.DATA_PATH || path.join(dataDir, "kiddiegpt-db.json");
const tokenSecret = process.env.AUTH_TOKEN_SECRET || "dev_kiddiegpt_change_me";
const tokenTtlMs = Number(process.env.AUTH_TOKEN_TTL_HOURS || 24) * 60 * 60 * 1000;
const allowedParentEmailDomains = (process.env.ALLOWED_PARENT_EMAIL_DOMAINS || "gmail.com,yahoo.com,aol.com,outlook.com,hotmail.com")
  .split(",")
  .map((domain) => domain.trim().toLowerCase())
  .filter(Boolean);
// The Chrome extension calls the portal cross-origin (chrome-extension://<id>).
// Configure allowed origins via ALLOWED_EXTENSION_ORIGINS (comma-separated) or use
// "*" for local dev. No cookies are used, so "*" is safe (auth is a Bearer token).
const allowedExtensionOrigins = (process.env.ALLOWED_EXTENSION_ORIGINS || "*")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const USAGE_RETENTION_DAYS = Number(process.env.USAGE_RETENTION_DAYS || 30);
// ---- Autopilot (lifecycle sweep + dunning) --------------------------------
const AUTOPILOT_ENABLED = process.env.AUTOPILOT_ENABLED !== "false";
// Days after the first failed payment on which to send a reminder email.
const DUNNING_REMINDER_DAYS = String(process.env.DUNNING_REMINDER_DAYS || "0,3,7")
  .split(",")
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isFinite(n))
  .sort((a, b) => a - b);
// Day after first failure on which access is auto-suspended if still unpaid.
const DUNNING_SUSPEND_DAYS = Number(process.env.DUNNING_SUSPEND_DAYS || 10);
// How often the background sweep runs (minutes).
const SWEEP_INTERVAL_MINUTES = Number(process.env.SWEEP_INTERVAL_MINUTES || 360);

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function defaultPricing() {
  return {
    monthly: {
      label: "Family Monthly",
      amount: 19,
      interval: "mo",
      stripePriceId: process.env.STRIPE_MONTHLY_PRICE_ID || "price_demo_monthly",
      familyMemberCount: 3,
      active: true
    },
    yearly: {
      label: "Family Yearly",
      amount: 149,
      interval: "yr",
      stripePriceId: process.env.STRIPE_YEARLY_PRICE_ID || "price_demo_yearly",
      familyMemberCount: 3,
      active: true
    },
    promotion: {
      code: "SAVE50",
      monthlyAmount: 10,
      yearlyAmount: 75,
      planKey: "monthly",
      price: "",
      description: "Limited-time family starter offer",
      showAfterDays: 3,
      durationDays: 7
    },
    yearlyUpgrade: {
      bonusMonths: 3,       // extra months granted on top of 12
      discountPercent: 0,   // discount on the yearly price for upgraders
      note: ""              // e.g. "July 4th sale — limited time"
    }
  };
}

function normalisePricing(pricing = {}) {
  const defaults = defaultPricing();
  const monthly = { ...defaults.monthly, ...(pricing.monthly || {}) };
  const yearly = { ...defaults.yearly, ...(pricing.yearly || {}) };
  const rawPromotion = pricing.promotion || {};
  const promotion = { ...defaults.promotion, ...rawPromotion };
  const hasRawPlanKey = Object.prototype.hasOwnProperty.call(rawPromotion, "planKey");
  promotion.planKey = promotion.planKey === "yearly" ? "yearly" : "monthly";
  if (!hasRawPlanKey && Number(promotion.monthlyAmount || 0) <= 0 && Number(promotion.yearlyAmount || 0) > 0) {
    promotion.planKey = "yearly";
  }
  const hasExplicitPrice = Object.prototype.hasOwnProperty.call(rawPromotion, "price") && rawPromotion.price !== "";
  if (!hasExplicitPrice) {
    promotion.price = promotion.planKey === "yearly" ? promotion.yearlyAmount : promotion.monthlyAmount;
  }
  if (Number(promotion.price || 0) <= 0 && Number(rawPromotion.discountPercent || 0) > 0) {
    const plan = promotion.planKey === "yearly" ? yearly : monthly;
    promotion.price = Number(plan.amount || 0) * (1 - Number(rawPromotion.discountPercent || 0) / 100);
  }
  if (promotion.planKey === "yearly") {
    promotion.yearlyAmount = Number(promotion.price || promotion.yearlyAmount || 0);
  } else {
    promotion.monthlyAmount = Number(promotion.price || promotion.monthlyAmount || 0);
  }
  delete promotion.discountPercent;
  delete promotion.endDate;
  const rawUpgrade = pricing.yearlyUpgrade || {};
  const yearlyUpgrade = {
    bonusMonths: Math.max(0, Math.round(Number(rawUpgrade.bonusMonths ?? defaults.yearlyUpgrade.bonusMonths) || 0)),
    discountPercent: Math.min(90, Math.max(0, Number(rawUpgrade.discountPercent) || 0)),
    note: String(rawUpgrade.note || "")
  };
  return {
    monthly,
    yearly,
    promotion,
    yearlyUpgrade
  };
}

function defaultAiSettings() {
  return {
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    openaiModel: process.env.OPENAI_MODEL || "gpt-4.1",
    mathProblemsPerUserDaily: 20,
    tutorVoiceMinutesPerUserDaily: 10,
    tutorVoiceEnabled: true,
    updatedAt: "",
    updatedBy: ""
  };
}

function normaliseAiSettings(settings = {}) {
  const defaults = defaultAiSettings();
  return {
    ...defaults,
    ...settings,
    openaiApiKey: typeof settings.openaiApiKey === "string" ? settings.openaiApiKey : defaults.openaiApiKey,
    openaiModel: String(settings.openaiModel || defaults.openaiModel || "gpt-4.1"),
    mathProblemsPerUserDaily: Math.max(0, Number(settings.mathProblemsPerUserDaily ?? defaults.mathProblemsPerUserDaily) || 0),
    tutorVoiceMinutesPerUserDaily: Math.max(0, Number(settings.tutorVoiceMinutesPerUserDaily ?? defaults.tutorVoiceMinutesPerUserDaily) || 0),
    tutorVoiceEnabled: settings.tutorVoiceEnabled !== false,
    updatedAt: settings.updatedAt || "",
    updatedBy: settings.updatedBy || ""
  };
}

function maskedSecret(value) {
  const secret = String(value || "").trim();
  if (!secret) return "";
  if (secret.length <= 10) return "Stored key";
  return `${secret.slice(0, 7)}...${secret.slice(-4)}`;
}

function safeAiSettings(settings = {}) {
  const normalised = normaliseAiSettings(settings);
  return {
    hasOpenAIKey: Boolean(normalised.openaiApiKey),
    maskedOpenAIKey: maskedSecret(normalised.openaiApiKey),
    openaiModel: normalised.openaiModel,
    mathProblemsPerUserDaily: normalised.mathProblemsPerUserDaily,
    tutorVoiceMinutesPerUserDaily: normalised.tutorVoiceMinutesPerUserDaily,
    tutorVoiceEnabled: normalised.tutorVoiceEnabled,
    updatedAt: normalised.updatedAt,
    updatedBy: normalised.updatedBy
  };
}

function planKeyForName(planName) {
  return String(planName || "").toLowerCase().includes("year") ? "yearly" : "monthly";
}

function promotionForPlan(pricing, planName) {
  const key = planKeyForName(planName);
  const plan = pricing[key];
  const promo = pricing.promotion || {};
  const code = String(promo.code || "").trim();
  const promoPrice = Number(promo.price || (key === "yearly" ? promo.yearlyAmount : promo.monthlyAmount) || 0);
  const basePrice = Number(plan?.amount || 0);
  if (!plan || !code || promo.planKey !== key || !promoPrice || !basePrice || promoPrice >= basePrice) return null;
  return {
    key,
    code,
    description: promo.description || "",
    promoPrice,
    basePrice,
    amountOffCents: Math.round((basePrice - promoPrice) * 100)
  };
}

function couponIdForPromotion(promo) {
  const raw = `kgpt_once_${promo.key}_${promo.code}_${promo.amountOffCents}`;
  return raw.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 80);
}

async function ensurePromotionCoupon(stripe, promo) {
  if (!stripe || !promo || promo.amountOffCents <= 0) return "";
  const id = couponIdForPromotion(promo);
  try {
    const coupon = await stripe.coupons.create({
      id,
      name: `KiddieGPT ${promo.code}`,
      amount_off: promo.amountOffCents,
      currency: "usd",
      duration: "once",
      metadata: {
        app: "KiddieGPT",
        planKey: promo.key,
        promoCode: promo.code,
        promoPrice: String(promo.promoPrice),
        basePrice: String(promo.basePrice)
      }
    });
    return coupon.id;
  } catch (error) {
    if (error?.code === "resource_already_exists") return id;
    throw error;
  }
}

function demoFamilies() {
  return [
    {
      id: makeId("fam"),
      parentName: "Ravi Parent",
      email: "parent.kiddiegpt@gmail.com",
      loginType: "Parent",
      studentName: "Ava",
      readingLevel: "On track",
      grade: "Grade 5",
      goal: "Build confidence in math word problems",
      reward: "Movie night",
      children: [
        { id: "child_demo_1", studentName: "Ava", readingLevel: "On track", grade: "Grade 5", goal: "Build confidence in math word problems", reward: "Movie night", learningGoals: [{ goal: "Build confidence in math word problems", reward: "Movie night", completed: false }] }
      ],
      plan: "Family Monthly",
      subscriptionStatus: "active",
      paymentStatus: "paid",
      accountLocked: false,
      lastActivityDays: 1,
      favoriteTool: "Math Step Tutor",
      supportNote: "Ask for testimonial after next math goal.",
      emailVerified: true,
      createdAt: nowIso()
    }
  ];
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 100000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  return hashPassword(password, salt).split(":")[1] === hash;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function emailDomain(email) {
  return normalizeEmail(email).split("@")[1] || "";
}

function isAllowedParentEmail(email) {
  return allowedParentEmailDomains.includes(emailDomain(email));
}

function parentEmailError(email) {
  const domainText = allowedParentEmailDomains.join(", ");
  if (!normalizeEmail(email)) return `Email is required. Use one of: ${domainText}.`;
  return `Use a parent email from one of these domains: ${domainText}.`;
}

function generateOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

function hashOtp(email, otp) {
  return crypto.createHmac("sha256", tokenSecret).update(`${normalizeEmail(email)}:${String(otp).trim()}`).digest("hex");
}

function otpExpiryIso() {
  return new Date(Date.now() + Number(process.env.EMAIL_OTP_TTL_MINUTES || 10) * 60 * 1000).toISOString();
}

function cleanupOtps(db) {
  const now = Date.now();
  db.emailOtps = (db.emailOtps || []).filter((item) => new Date(item.expiresAt).getTime() > now && Number(item.attempts || 0) < 5);
}

function defaultDb() {
  const adminEmail = process.env.ADMIN_EMAIL || "admin@kiddiegpt.demo";
  const adminPassword = process.env.ADMIN_PASSWORD || "admin123";
  const parentEmail = process.env.PARENT_TEST_EMAIL || "parent.kiddiegpt@gmail.com";
  const parentPassword = process.env.PARENT_TEST_PASSWORD || "kiddiegpt123";
  const families = demoFamilies().map(normaliseFamily);
  return {
    version: 1,
    deletedUserSequence: 0,
    pricing: defaultPricing(),
    aiSettings: defaultAiSettings(),
    users: [
      {
        id: makeId("usr"),
        role: "admin",
        name: "KiddieGPT Admin",
        email: adminEmail,
        passwordHash: hashPassword(adminPassword),
        createdAt: nowIso()
      },
      {
        id: makeId("usr"),
        role: "parent",
        name: "Demo Parent",
        email: parentEmail,
        passwordHash: hashPassword(parentPassword),
        familyId: families[0]?.id || "",
        emailVerified: true,
        createdAt: nowIso()
      }
    ],
    families,
    auditLogs: [],
    monitorEvents: [],
    emailLogs: [],
    emailOtps: [],
    payments: [],
    sessions: []
  };
}

function ensureDb() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify(defaultDb(), null, 2));
  }
}

// --- Persistence driver ------------------------------------------------------
// DB_DRIVER=file (default): the atomic JSON-file DB used by local Docker — this
//   path is unchanged.
// DB_DRIVER=postgres: store the whole DB as a single JSONB row, for serverless
//   hosts (Vercel) where the filesystem is ephemeral. readDb/writeDb stay
//   synchronous by serving from an in-memory cache that initPersistence()
//   preloads; writes are mirrored to Postgres and can be awaited via
//   flushPending() before a serverless response finishes.
const DB_DRIVER = (process.env.DB_DRIVER || "file").toLowerCase();
let pgPool = null;
let stateCache = null;
let pgWriteChain = Promise.resolve();

function pgSslFor(connectionString) {
  if (/sslmode=disable/.test(connectionString)) return false;
  if (/@(localhost|127\.0\.0\.1)[:/]/.test(connectionString)) return false;
  return { rejectUnauthorized: false };
}

async function initPersistence() {
  if (DB_DRIVER !== "postgres") { ensureDb(); return; }
  const { Pool } = require("pg"); // lazy require: only the postgres path needs it
  const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DB_DRIVER=postgres but POSTGRES_URL (or DATABASE_URL) is not set");
  pgPool = new Pool({ connectionString, ssl: pgSslFor(connectionString), max: Number(process.env.PG_POOL_MAX || 3) });
  await pgPool.query(
    "CREATE TABLE IF NOT EXISTS app_state (id INT PRIMARY KEY DEFAULT 1, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), CHECK (id = 1))"
  );
  const { rows } = await pgPool.query("SELECT data FROM app_state WHERE id = 1");
  if (rows.length) {
    stateCache = rows[0].data;
  } else {
    stateCache = defaultDb();
    await pgPool.query("INSERT INTO app_state (id, data) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING", [JSON.stringify(stateCache)]);
  }
}

function persistReadRaw() {
  if (DB_DRIVER === "postgres") {
    if (!stateCache) throw new Error("Persistence not initialised — call initPersistence() first");
    return JSON.parse(JSON.stringify(stateCache)); // fresh clone each read, mirroring the file driver
  }
  ensureDb();
  return JSON.parse(fs.readFileSync(dbPath, "utf8"));
}

function persistWriteRaw(db) {
  if (DB_DRIVER === "postgres") {
    stateCache = db;
    const snapshot = JSON.stringify(db);
    pgWriteChain = pgWriteChain
      .then(() => pgPool.query(
        "INSERT INTO app_state (id, data, updated_at) VALUES (1, $1::jsonb, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()",
        [snapshot]
      ))
      .catch((error) => console.error("Postgres write failed:", error.message));
    return;
  }
  fs.mkdirSync(dataDir, { recursive: true });
  // Write to a temp file then atomically rename so a crash mid-write can never
  // leave a truncated/corrupt database on disk.
  const tmpPath = `${dbPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(db, null, 2));
  fs.renameSync(tmpPath, dbPath);
}

// Await any queued Postgres write (no-op for the file driver).
async function flushPending() {
  await pgWriteChain;
}

function readDb() {
  const db = persistReadRaw();
  let changed = false;
  db.pricing = normalisePricing(db.pricing);
  db.aiSettings = normaliseAiSettings(db.aiSettings);
  db.deletedUserSequence = Number(db.deletedUserSequence || 0);
  db.users = db.users || [];
  const adminEmail = process.env.ADMIN_EMAIL || "admin@kiddiegpt.demo";
  const parentEmail = process.env.PARENT_TEST_EMAIL || "parent.kiddiegpt@gmail.com";
  if (!db.users.some((user) => user.role === "admin" && user.email === adminEmail)) {
    db.users.push({
      id: makeId("usr"),
      role: "admin",
      name: "KiddieGPT Admin",
      email: adminEmail,
      passwordHash: hashPassword(process.env.ADMIN_PASSWORD || "admin123"),
      createdAt: nowIso()
    });
    changed = true;
  }
  if (!db.users.some((user) => user.role === "parent" && user.email === parentEmail)) {
    db.users.push({
      id: makeId("usr"),
      role: "parent",
      name: "Demo Parent",
      email: parentEmail,
      passwordHash: hashPassword(process.env.PARENT_TEST_PASSWORD || "kiddiegpt123"),
      emailVerified: true,
      createdAt: nowIso()
    });
    changed = true;
  }
  db.families = (db.families || []).map(normaliseFamily);
  db.auditLogs = db.auditLogs || [];
  db.monitorEvents = db.monitorEvents || [];
  db.emailLogs = db.emailLogs || [];
  db.emailOtps = db.emailOtps || [];
  cleanupOtps(db);
  db.payments = db.payments || [];
  db.families.forEach((family) => {
    if (!hasConfirmedYearlyUpgrade(family)) return;
    const yearlyPayment = db.payments
      .filter((payment) =>
        payment.familyId === family.id &&
        payment.subscriptionId === family.yearlyUpgrade.yearlySubscriptionId &&
        Number(payment.amountCents || 0) > 0 &&
        payment.status === "paid"
      )
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0];
    if (!yearlyPayment) return;
    if (family.stripePaymentId !== yearlyPayment.paymentId || Number(family.lastPaymentAmountCents || 0) !== Number(yearlyPayment.amountCents || 0)) {
      family.stripePaymentId = yearlyPayment.paymentId;
      family.lastPaymentAmountCents = yearlyPayment.amountCents;
      family.lastPaymentCurrency = yearlyPayment.currency || "usd";
      family.lastPaymentAt = yearlyPayment.createdAt;
      changed = true;
    }
  });
  db.sessions = db.sessions || [];
  db.processedWebhookEvents = db.processedWebhookEvents || [];
  db.issues = db.issues || [];
  db.supportMessages = db.supportMessages || [];
  if (changed) writeDb(db);
  return db;
}

function writeDb(db) {
  persistWriteRaw(db);
}

function mutateDb(updater) {
  const db = readDb();
  const result = updater(db);
  writeDb(db);
  return result;
}

function normaliseFamily(family) {
  const next = { ...family };
  next.id = next.id || makeId("fam");
  next.parentName = next.parentName || "Parent";
  next.email = String(next.email || "").toLowerCase();
  next.loginType = next.loginType || "Parent";
  next.plan = next.plan || "Family Monthly";
  next.subscriptionStatus = next.subscriptionStatus || "pending";
  next.paymentStatus = next.paymentStatus || (next.subscriptionStatus === "active" ? "paid" : "pending");
  next.accountLocked = Boolean(next.accountLocked);
  next.cancellationRequested = Boolean(next.cancellationRequested);
  next.cancellationStatus = next.cancellationStatus || "";
  next.cancelAtPeriodEnd = Boolean(next.cancelAtPeriodEnd);
  next.cancelReason = next.cancelReason || "";
  next.cancelAccessUntil = next.cancelAccessUntil || next.cancellationAccessUntil || "";
  next.cancellationAccessUntil = next.cancellationAccessUntil || next.cancelAccessUntil || "";
  next.cancellationSubscriptionId = next.cancellationSubscriptionId || "";
  if (hasConfirmedYearlyUpgrade(next)) {
    next.plan = "Family Yearly";
    next.stripeSubscriptionId = next.yearlyUpgrade.yearlySubscriptionId || next.stripeSubscriptionId;
  }
  next.children = Array.isArray(next.children) ? next.children : [];
  if (!next.children.length && next.studentName) {
    next.children = [{
      id: makeId("child"),
      studentName: next.studentName,
      grade: next.grade,
      readingLevel: next.readingLevel,
      goal: next.goal,
      reward: next.reward,
      learningGoals: next.learningGoals || []
    }];
  }
  const primary = next.children[0] || {};
  next.studentName = next.studentName || primary.studentName || "";
  next.grade = next.grade || primary.grade || "";
  next.readingLevel = next.readingLevel || primary.readingLevel || "";
  next.createdAt = next.createdAt || nowIso();
  next.lastLoginAt = next.lastLoginAt || new Date(Date.now() - 3600000).toISOString();
  // lastExtensionUseAt is set only by real usage reports (no mock default).
  next.lastExtensionUseAt = next.lastExtensionUseAt || "";
  next.controls = normaliseParentControls(next.controls);
  return next;
}

// Per-family parental controls, set from the parent portal and enforced by the
// extension via /api/ai/usage-limits and the AI proxy.
function normaliseParentControls(controls = {}) {
  const source = controls && typeof controls === "object" ? controls : {};
  const rawCap = source.mathDailyCap;
  const cap = rawCap === null || rawCap === "" || rawCap === undefined ? null : Math.max(0, Number(rawCap) || 0);
  return {
    requireSteps: source.requireSteps !== false, // default on: no direct answers
    voiceEnabled: source.voiceEnabled !== false, // default on
    mathDailyCap: cap,                            // null = defer to admin cap
    weeklySummary: source.weeklySummary !== false // default on
  };
}

// Combine admin AI caps with a family's parental-control overrides.
function effectiveLimits(settings, family) {
  const controls = normaliseParentControls(family && family.controls);
  const adminMath = Math.max(0, Number(settings.mathProblemsPerUserDaily) || 0);
  const mathCap = controls.mathDailyCap === null ? adminMath : Math.min(adminMath, controls.mathDailyCap);
  return {
    mathProblemsPerUserDaily: mathCap,
    tutorVoiceMinutesPerUserDaily: Math.max(0, Number(settings.tutorVoiceMinutesPerUserDaily) || 0),
    tutorVoiceEnabled: settings.tutorVoiceEnabled !== false && controls.voiceEnabled,
    requireSteps: controls.requireSteps,
    controls
  };
}

// ---- Extension usage telemetry -------------------------------------------
// Replaces the mock "last extension use / favorite tool / tool adoption" fields
// with real per-child data reported by the extension via POST /api/usage/report.
const USAGE_TOOL_LABELS = {
  math: "Math Step Tutor",
  voice: "Tutor Voice",
  pdf: "PDF Helper",
  read: "Read Aloud",
  write: "Writing Coach",
  quiz: "Quiz",
  flashcard: "Flashcards"
};

function usageDayKey(date = new Date()) {
  return new Date(date).toISOString().slice(0, 10);
}

function emptyUsage() {
  return { daily: {}, totals: { mathProblems: 0, voiceSeconds: 0, tools: {} }, lastExtensionUseAt: "" };
}

function pruneUsageBuckets(usage) {
  const cutoff = Date.now() - USAGE_RETENTION_DAYS * 86400000;
  Object.keys(usage.daily || {}).forEach((day) => {
    if (new Date(`${day}T00:00:00Z`).getTime() < cutoff) delete usage.daily[day];
  });
}

function childForUsage(family, childId) {
  const children = Array.isArray(family?.children) ? family.children : [];
  if (childId) {
    const match = children.find((child) => child.id === childId);
    if (match) return match;
  }
  return children[0] || null;
}

function favoriteToolFromUsage(child) {
  const tools = child?.usage?.totals?.tools || {};
  let best = "";
  let bestCount = 0;
  Object.entries(tools).forEach(([name, count]) => {
    if (Number(count) > bestCount) {
      best = name;
      bestCount = Number(count);
    }
  });
  return USAGE_TOOL_LABELS[best] || "";
}

function recordChildUsage(family, { childId, tool, mathProblems = 0, voiceSeconds = 0, tokens = 0, at } = {}) {
  const child = childForUsage(family, childId);
  if (!child) return null;
  child.usage = { ...emptyUsage(), ...(child.usage || {}) };
  const usage = child.usage;
  usage.daily = usage.daily || {};
  usage.totals = usage.totals || { mathProblems: 0, voiceSeconds: 0, tokens: 0, tools: {} };
  usage.totals.tools = usage.totals.tools || {};
  const day = usageDayKey(at ? new Date(at) : new Date());
  const bucket = usage.daily[day] || { mathProblems: 0, voiceSeconds: 0, tokens: 0, tools: {} };
  const math = Math.max(0, Number(mathProblems) || 0);
  const voice = Math.max(0, Number(voiceSeconds) || 0);
  const tok = Math.max(0, Number(tokens) || 0);
  bucket.mathProblems += math;
  bucket.voiceSeconds += voice;
  bucket.tokens = (bucket.tokens || 0) + tok;
  if (tool) bucket.tools[tool] = (bucket.tools[tool] || 0) + 1;
  usage.daily[day] = bucket;
  usage.totals.mathProblems += math;
  usage.totals.voiceSeconds += voice;
  usage.totals.tokens = (usage.totals.tokens || 0) + tok;
  if (tool) usage.totals.tools[tool] = (usage.totals.tools[tool] || 0) + 1;
  usage.lastExtensionUseAt = nowIso();
  pruneUsageBuckets(usage);
  family.lastExtensionUseAt = nowIso();
  family.favoriteTool = favoriteToolFromUsage(child) || family.favoriteTool || "";
  return child;
}

function usageRemaining(family, settings, childId) {
  const child = childForUsage(family, childId);
  const day = usageDayKey();
  const bucket = (child?.usage?.daily || {})[day] || { mathProblems: 0, voiceSeconds: 0 };
  const limits = effectiveLimits(settings, family);
  const voiceCapMinutes = limits.tutorVoiceEnabled ? limits.tutorVoiceMinutesPerUserDaily : 0;
  return {
    mathProblems: Math.max(0, limits.mathProblemsPerUserDaily - (Number(bucket.mathProblems) || 0)),
    voiceMinutes: Math.max(0, voiceCapMinutes - Math.floor((Number(bucket.voiceSeconds) || 0) / 60))
  };
}

// Sum a child's usage across the trailing `days` window (default 7).
function usageWindow(child, days = 7) {
  const daily = (child && child.usage && child.usage.daily) || {};
  const cutoff = Date.now() - (days - 1) * 86400000;
  let math = 0;
  let voiceSeconds = 0;
  let tokens = 0;
  let activeDays = 0;
  Object.keys(daily).forEach((day) => {
    if (new Date(`${day}T00:00:00Z`).getTime() < cutoff) return;
    const bucket = daily[day] || {};
    const m = Number(bucket.mathProblems) || 0;
    const v = Number(bucket.voiceSeconds) || 0;
    const t = Number(bucket.tokens) || 0;
    math += m;
    voiceSeconds += v;
    tokens += t;
    if (m || v || t) activeDays += 1;
  });
  return { math, voiceMinutes: Math.round(voiceSeconds / 60), tokens, activeDays, avgDailyTokens: Math.round(tokens / days) };
}

function audit(db, action, payload, actor) {
  db.auditLogs.unshift({
    id: makeId("log"),
    action,
    payload,
    actor: actor || payload?.actor || payload?.adminEmail || payload?.email || "system",
    createdAt: nowIso()
  });
}

function monitor(db, severity, category, message, payload, actor) {
  db.monitorEvents = db.monitorEvents || [];
  db.monitorEvents.unshift({
    id: makeId("mon"),
    severity: severity || "info",
    category: category || "system",
    message,
    payload: payload || {},
    actor: actor || payload?.email || payload?.parentEmail || "system",
    createdAt: nowIso()
  });
  db.monitorEvents = db.monitorEvents.slice(0, 250);
}

function findFamilyForStripeObject(db, object) {
  const metadata = object.metadata || {};
  const familyId = metadata.familyId;
  const email = String(
    metadata.parentEmail ||
    object.customer_email ||
    object.customer_details?.email ||
    object.receipt_email ||
    object.customer_email ||
    ""
  ).toLowerCase();
  const customerId = object.customer;
  const subscriptionId = typeof object.subscription === "string" ? object.subscription : object.subscription?.id;
  return db.families.find((item) =>
    (familyId && item.id === familyId) ||
    (email && item.email === email) ||
    (customerId && item.stripeCustomerId === customerId) ||
    (subscriptionId && item.stripeSubscriptionId === subscriptionId)
  );
}

function stripeObjectEmail(object) {
  const metadata = object.metadata || {};
  return String(metadata.parentEmail || object.customer_email || object.customer_details?.email || object.receipt_email || "").toLowerCase();
}

function stripeId(value) {
  return typeof value === "string" ? value : value?.id || "";
}

async function checkoutSessionPaymentIntentId(stripe, session) {
  const directPaymentIntent = stripeId(session.payment_intent);
  if (directPaymentIntent) return directPaymentIntent;

  const subscription = session.subscription && typeof session.subscription === "object" ? session.subscription : null;
  const invoice = subscription?.latest_invoice && typeof subscription.latest_invoice === "object" ? subscription.latest_invoice : null;
  const invoicePaymentIntent = stripeId(invoice?.payment_intent);
  if (invoicePaymentIntent) return invoicePaymentIntent;

  const subscriptionId = stripeId(session.subscription);
  if (!stripe || !subscriptionId) return "";
  const hydrated = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["latest_invoice.payment_intent"] });
  return stripeId(hydrated.latest_invoice?.payment_intent);
}

function recordStripePayment(db, event, object, family) {
  const amountCents = Number(object.amount_paid || object.amount_total || object.amount_received || object.amount || object.amount_due || 0);
  const paymentId = stripeId(object.payment_intent) || stripeId(object.latest_charge) || stripeId(object.charge) || stripeId(object.id) || event.id;
  const subscriptionId = stripeId(object.subscription);
  const customerId = stripeId(object.customer);
  const replacedMonthlyIds = Array.isArray(family?.yearlyUpgrade?.monthlySubscriptionIds) ? family.yearlyUpgrade.monthlySubscriptionIds : [];
  const isReplacedMonthlyPayment = subscriptionId && replacedMonthlyIds.includes(subscriptionId);
  const status = event.type.includes("failed")
    ? "failed"
    : event.type.includes("refund")
    ? "refunded"
    : object.status === "paid" || object.status === "succeeded" || object.paid || event.type === "checkout.session.completed" || event.type.includes("invoice.paid")
    ? "paid"
    : object.status || "pending";
  const existingIndex = db.payments.findIndex((payment) => payment.stripeEventId === event.id || payment.paymentId === paymentId);
  const record = {
    id: existingIndex >= 0 ? db.payments[existingIndex].id : makeId("pay"),
    stripeEventId: event.id,
    paymentId,
    type: event.type,
    status,
    amountCents,
    currency: object.currency || "usd",
    email: family?.email || stripeObjectEmail(object),
    familyId: family?.id || "",
    customerId: customerId || family?.stripeCustomerId || "",
    subscriptionId: subscriptionId || family?.stripeSubscriptionId || "",
    createdAt: object.created ? unixToIso(object.created) : nowIso()
  };
  if (existingIndex >= 0) db.payments[existingIndex] = record;
  else db.payments.unshift(record);
  if (family && !isReplacedMonthlyPayment) {
    family.stripePaymentId = paymentId || family.stripePaymentId;
    family.lastPaymentAmountCents = amountCents || family.lastPaymentAmountCents;
    family.lastPaymentCurrency = record.currency;
    family.lastPaymentAt = record.createdAt;
  }
  return record;
}

function signToken(payload) {
  const issuedAt = Date.now();
  const body = Buffer.from(JSON.stringify({ ...payload, iat: issuedAt, exp: issuedAt + tokenTtlMs })).toString("base64url");
  const sig = crypto.createHmac("sha256", tokenSecret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", tokenSecret).update(body).digest("base64url");
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (payload.exp && Number(payload.exp) < Date.now()) return null;
    return payload;
  } catch (error) {
    return null;
  }
}

function sessionPayload(user, provider = "password") {
  return {
    sub: user.id,
    role: user.role,
    email: user.email,
    provider,
    iat: Date.now()
  };
}

// Stateless tokens are revoked by bumping the user's sessionsRevokedAt: any token
// issued before that instant is rejected. Call revokeUserSessions on password
// change, email change, lock, deletion, and anonymization.
function revokeUserSessions(user) {
  if (user) user.sessionsRevokedAt = nowIso();
}

function sessionRevokedForAuth(db, auth) {
  if (!auth || !auth.sub) return false;
  const user = (db.users || []).find((item) => item.id === auth.sub);
  if (!user) return auth.role === "parent"; // parent user gone (deleted) → reject
  if (!user.sessionsRevokedAt) return false;
  const issuedAt = Number(auth.iat || 0);
  return !issuedAt || issuedAt < new Date(user.sessionsRevokedAt).getTime();
}

function createAuthSession(user, provider = "password") {
  return mutateDb((dbToUpdate) => {
    dbToUpdate.sessions.unshift({ id: makeId("ses"), userId: user.id, role: user.role, email: user.email, provider, createdAt: nowIso() });
    const family = dbToUpdate.families.find((item) => item.email === user.email);
    if (family) family.lastLoginAt = nowIso();
    audit(dbToUpdate, "auth.login", { userId: user.id, role: user.role, email: user.email, provider }, user.email);
    return signToken(sessionPayload(user, provider));
  });
}

function authFromRequest(req) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return verifyToken(token);
}

function parentFamilyForIdentity(db, identity) {
  if (!identity || identity.role !== "parent") return null;
  return db.families.find((family) =>
    (identity.familyId && family.id === identity.familyId) ||
    (identity.email && family.email === normalizeEmail(identity.email))
  ) || null;
}

function parentLockedResponse(res) {
  return res.status(423).json({
    ok: false,
    accountLocked: true,
    error: "This parent account is locked. Contact KiddieGPT support to restore access."
  });
}

function nextDeletedEmail(db) {
  db.deletedUserSequence = Number(db.deletedUserSequence || 0) + 1;
  return `deleted_user_${String(db.deletedUserSequence).padStart(5, "0")}@deleted.local`;
}

function scrubText(value, replacements) {
  if (typeof value !== "string") return value;
  return replacements.reduce((next, item) => {
    if (!item.from) return next;
    return next.split(item.from).join(item.to);
  }, value);
}

function scrubValue(value, replacements) {
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, replacements));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubValue(item, replacements)]));
  }
  return scrubText(value, replacements);
}

function requireAdmin(req, res, next) {
  if (process.env.REQUIRE_AUTH !== "true") return next();
  const auth = authFromRequest(req);
  if (!auth || auth.role !== "admin") {
    return res.status(401).json({ error: "Admin authentication required." });
  }
  if (sessionRevokedForAuth(readDb(), auth)) {
    return res.status(401).json({ error: "Session expired. Please sign in again." });
  }
  req.auth = auth;
  return next();
}

function requireParent(req, res, next) {
  const auth = authFromRequest(req);
  if (!auth || auth.role !== "parent") {
    mutateDb((db) => monitor(db, "warning", "auth", "Parent authentication required", { path: req.path }));
    return res.status(401).json({ error: "Parent authentication required." });
  }
  const db = readDb();
  if (sessionRevokedForAuth(db, auth)) {
    return res.status(401).json({ error: "Session expired. Please sign in again." });
  }
  const family = parentFamilyForIdentity(db, auth);
  if (family?.accountLocked) {
    mutateDb((dbToUpdate) => monitor(dbToUpdate, "warning", "auth", "Locked parent token blocked", { email: auth.email, path: req.path }, auth.email));
    return parentLockedResponse(res);
  }
  req.auth = auth;
  return next();
}

function stripeMode() {
  const key = process.env.STRIPE_SECRET_KEY || "";
  if (!key) return "mock";
  return key.startsWith("sk_test_") ? "test" : "live";
}

function stripeClient() {
  return process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
}

function checkoutStripeError(error, priceId) {
  if (error?.code === "resource_missing" && error?.param === "price") {
    return `Stripe Price ID ${priceId} was not found for the current Stripe secret key. Create test prices in Admin or paste a valid price_... ID from the same Stripe account.`;
  }
  if (error?.type === "StripeAuthenticationError") {
    return "Stripe secret key is invalid. Check STRIPE_SECRET_KEY in local Docker env.";
  }
  if (error?.type === "StripePermissionError") {
    return "Stripe key does not have permission to create Checkout Sessions.";
  }
  return "Unable to create Stripe Checkout Session.";
}

async function retentionCouponId(stripe, db) {
  const configured = process.env.STRIPE_RETENTION_COUPON_ID || db.pricing?.promotion?.retentionCouponId;
  if (configured) return configured;

  const coupon = await stripe.coupons.create({
    percent_off: 50,
    duration: "once",
    name: "KiddieGPT retention save offer",
    metadata: {
      app: "KiddieGPT",
      offer: "50_percent_next_invoice"
    }
  });

  mutateDb((nextDb) => {
    nextDb.pricing = nextDb.pricing || defaultPricing();
    nextDb.pricing.promotion = nextDb.pricing.promotion || {};
    nextDb.pricing.promotion.retentionCouponId = coupon.id;
    audit(nextDb, "stripe.retention_coupon.create", { couponId: coupon.id });
  });

  return coupon.id;
}

async function activeStripeSubscriptionsForEmail(stripe, email) {
  if (!email) return [];
  const customers = await stripe.customers.list({ email, limit: 20 });
  const activeStatuses = new Set(["active", "trialing", "past_due", "unpaid"]);
  const subscriptions = [];

  for (const customer of customers.data) {
    const result = await stripe.subscriptions.list({
      customer: customer.id,
      limit: 20,
      expand: ["data.discount", "data.items.data.price", "data.latest_invoice.payment_intent", "data.schedule"]
    });
    result.data.forEach((subscription) => {
      if (activeStatuses.has(subscription.status)) subscriptions.push(subscription);
    });
  }

  return subscriptions.sort((a, b) => b.created - a.created);
}

function subscriptionHasInterval(subscription, interval, fallbackPriceId = "") {
  return Boolean(subscription?.items?.data?.some((item) => {
    const price = item.price || {};
    return price.recurring?.interval === interval || (fallbackPriceId && price.id === fallbackPriceId);
  }));
}

function subscriptionPrimaryItem(subscription) {
  return subscription?.items?.data?.[0] || null;
}

function addMonthsUnix(timestamp, months) {
  const date = new Date(Number(timestamp) * 1000);
  date.setUTCMonth(date.getUTCMonth() + months);
  return Math.floor(date.getTime() / 1000);
}

function unixToIso(timestamp) {
  const seconds = Number(timestamp || 0);
  return seconds ? new Date(seconds * 1000).toISOString() : "";
}

function cancellationStillActive(family) {
  if (family?.subscriptionStatus !== "cancel_scheduled") return false;
  const accessUntil = new Date(family.cancelAccessUntil || family.cancellationAccessUntil || 0).getTime();
  return Number.isFinite(accessUntil) && accessUntil > Date.now();
}

function markCancellationScheduled(family, subscription, reason = "") {
  if (!family) return family;
  const accessUntil = unixToIso(subscription?.current_period_end || subscription?.cancel_at || 0) || family.cancelAccessUntil || family.cancellationAccessUntil || "";
  family.subscriptionStatus = "cancel_scheduled";
  family.paymentStatus = family.paymentStatus === "failed" ? "failed" : "paid";
  family.cancellationRequested = true;
  family.cancellationStatus = "scheduled";
  family.cancelAtPeriodEnd = true;
  family.cancelRequestedAt = family.cancelRequestedAt || nowIso();
  family.cancelReason = reason || family.cancelReason || "";
  family.cancelAccessUntil = accessUntil;
  family.cancellationAccessUntil = accessUntil;
  family.cancellationSubscriptionId = stripeId(subscription?.id) || family.stripeSubscriptionId || "";
  family.accountLocked = false;
  return family;
}

function markSubscriptionEndedNow(family, reason = "", subscriptionId = "") {
  if (!family) return family;
  const endedAt = nowIso();
  family.subscriptionStatus = "cancelled";
  family.cancelAtPeriodEnd = false;
  family.cancellationRequested = false;
  family.cancellationStatus = "completed";
  family.cancelReason = reason || family.cancelReason || "Subscription ended";
  family.cancelledAt = endedAt;
  family.cancellationCompletedAt = endedAt;
  family.cancelAccessUntil = endedAt;
  family.cancellationAccessUntil = endedAt;
  family.cancellationSubscriptionId = subscriptionId || effectiveFamilySubscriptionId(family) || family.stripeSubscriptionId || "";
  return family;
}

function hasConfirmedYearlyUpgrade(family) {
  return Boolean(family?.yearlyUpgrade && family.yearlyUpgrade.status === "scheduled" && family.yearlyUpgrade.yearlySubscriptionId);
}

function effectiveFamilyPlan(family) {
  return hasConfirmedYearlyUpgrade(family) ? "Family Yearly" : family?.plan || "Family Monthly";
}

function effectiveFamilySubscriptionId(family) {
  return hasConfirmedYearlyUpgrade(family) ? family.yearlyUpgrade.yearlySubscriptionId : family?.stripeSubscriptionId || "";
}

async function scheduleStripeCancellationAtPeriodEnd(stripe, subscriptionId) {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["schedule"] });
  const scheduleId = stripeId(subscription.schedule);
  if (scheduleId) {
    await stripe.subscriptionSchedules.release(scheduleId);
  }
  return stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
}

async function cancelStripeSubscriptionsNow(stripe, family) {
  if (!stripe || !family) return [];
  const ids = [
    effectiveFamilySubscriptionId(family),
    family.stripeSubscriptionId,
    family.yearlyUpgrade?.yearlySubscriptionId
  ].filter((id, index, list) => id && !String(id).startsWith("sub_mock") && list.indexOf(id) === index);
  const results = [];
  for (const id of ids) {
    try {
      const subscription = await stripe.subscriptions.cancel(id);
      results.push({ id, status: subscription.status || "cancelled" });
    } catch (error) {
      results.push({ id, error: error.message || "Unable to cancel subscription" });
    }
  }
  return results;
}

async function createImmediateYearlyUpgradeSchedule(stripe, options) {
  const {
    customerId,
    yearlyPriceId,
    defaultPaymentMethod,
    email,
    bonusMonths,
    monthlySubscriptionIds
  } = options;
  const yearlyPrice = await stripe.prices.retrieve(yearlyPriceId);
  const productId = stripeId(yearlyPrice.product);
  const accessMonths = 12 + Number(bonusMonths || 0);
  if (!yearlyPrice.unit_amount || !yearlyPrice.currency || !productId) {
    throw new Error("Yearly Stripe Price must have a fixed amount, currency, and product.");
  }

  const defaultSettings = {};
  if (typeof defaultPaymentMethod === "string" && defaultPaymentMethod) {
    defaultSettings.default_payment_method = defaultPaymentMethod;
  }

  return stripe.subscriptionSchedules.create({
    customer: customerId,
    start_date: "now",
    end_behavior: "release",
    default_settings: defaultSettings,
    metadata: {
      app: "KiddieGPT",
      parentEmail: email,
      yearlyUpgrade: "true",
      upgradeBillingMode: "immediate_15_month",
      bonusMonths: String(bonusMonths),
      accessMonths: String(accessMonths),
      replacedMonthlySubscriptions: monthlySubscriptionIds.join(",")
    },
    phases: [
      {
        items: [
          {
            price_data: {
              currency: yearlyPrice.currency,
              product: productId,
              unit_amount: yearlyPrice.unit_amount,
              recurring: {
                interval: "month",
                interval_count: accessMonths
              }
            },
            quantity: 1
          }
        ],
        iterations: 1,
        metadata: {
          app: "KiddieGPT",
          parentEmail: email,
          yearlyUpgrade: "true",
          upgradeBillingMode: "immediate_15_month",
          bonusMonths: String(bonusMonths),
          accessMonths: String(accessMonths),
          replacedMonthlySubscriptions: monthlySubscriptionIds.join(",")
        }
      },
      {
        items: [{ price: yearlyPriceId, quantity: 1 }],
        metadata: {
          app: "KiddieGPT",
          parentEmail: email,
          yearlyUpgrade: "true",
          upgradeBillingMode: "standard_yearly",
          replacedMonthlySubscriptions: monthlySubscriptionIds.join(",")
        }
      }
    ],
    expand: ["subscription", "subscription.latest_invoice.payment_intent", "subscription.items.data.price"]
  });
}

async function settleStripeInvoice(stripe, invoice) {
  if (!stripe || !invoice) return null;
  const invoiceId = stripeId(invoice);
  if (!invoiceId) return null;
  let next = typeof invoice === "object" ? invoice : await stripe.invoices.retrieve(invoiceId, { expand: ["payment_intent"] });
  if (next.status === "draft") {
    next = await stripe.invoices.finalizeInvoice(invoiceId, { expand: ["payment_intent"] });
  }
  if (next.status === "open") {
    next = await stripe.invoices.pay(invoiceId, { expand: ["payment_intent"] });
  }
  return next;
}

function addMonthsIso(value, months) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime()) || date.getTime() < Date.now()) {
    date.setTime(Date.now());
  }
  date.setUTCMonth(date.getUTCMonth() + Number(months || 0));
  return date.toISOString();
}

function addDaysIso(value, days) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime()) || date.getTime() < Date.now()) {
    date.setTime(Date.now());
  }
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString();
}

function hasActiveOverride(family) {
  return Boolean(family?.entitlementOverrideUntil && new Date(family.entitlementOverrideUntil).getTime() > Date.now());
}

function subscriptionHasCoupon(subscription, couponId, discountId) {
  if (!subscription) return false;
  if (subscription.discount) {
    const discountCouponId = typeof subscription.discount.coupon === "string"
      ? subscription.discount.coupon
      : subscription.discount.coupon?.id;
    if ((couponId && discountCouponId === couponId) || (discountId && subscription.discount.id === discountId)) {
      return true;
    }
  }
  return Array.isArray(subscription.discounts) && subscription.discounts.some((discount) => {
    if (typeof discount === "string") return discountId && discount === discountId;
    const discountCouponId = typeof discount.coupon === "string" ? discount.coupon : discount.coupon?.id;
    return (couponId && discountCouponId === couponId) || (discountId && discount.id === discountId);
  });
}

async function applySubscriptionCoupon(stripe, subscriptionId, couponId) {
  try {
    return await stripe.subscriptions.update(subscriptionId, {
      discounts: [{ coupon: couponId }],
      metadata: {
        retentionOfferAccepted: "true",
        retentionOffer: "50_percent_next_invoice"
      }
    });
  } catch (error) {
    if (!String(error.message || "").includes("discounts")) throw error;
    return stripe.subscriptions.update(subscriptionId, {
      coupon: couponId,
      metadata: {
        retentionOfferAccepted: "true",
        retentionOffer: "50_percent_next_invoice"
      }
    });
  }
}

function postmarkFromEmail() {
  return process.env.POSTMARK_FROM_EMAIL || process.env.FROM_EMAIL || "";
}

function postmarkConfigured() {
  return Boolean(process.env.POSTMARK_SERVER_TOKEN && postmarkFromEmail());
}

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function emailMode() {
  if (postmarkConfigured()) return "postmark";
  if (smtpConfigured()) return "smtp";
  return "mock";
}

// CORS for the browser extension. Runs before all routes. Bearer-token auth only,
// so credentials are never sent and a wildcard origin is acceptable.
app.use((req, res, next) => {
  const origin = req.get("origin");
  if (origin) {
    const allowAll = allowedExtensionOrigins.includes("*");
    if (allowAll) {
      res.setHeader("Access-Control-Allow-Origin", "*");
    } else if (allowedExtensionOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  return next();
});

function webhookAlreadyProcessed(db, eventId) {
  if (!eventId) return false;
  return (db.processedWebhookEvents || []).some((entry) => entry.id === eventId);
}

function markWebhookProcessed(db, eventId, type) {
  if (!eventId) return;
  db.processedWebhookEvents = db.processedWebhookEvents || [];
  if (db.processedWebhookEvents.some((entry) => entry.id === eventId)) return;
  db.processedWebhookEvents.unshift({ id: eventId, type: type || "", at: nowIso() });
  if (db.processedWebhookEvents.length > 500) db.processedWebhookEvents.length = 500;
}

app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const stripe = stripeClient();
  let event;
  try {
    if (stripe && process.env.STRIPE_WEBHOOK_SECRET) {
      event = stripe.webhooks.constructEvent(req.body, req.get("stripe-signature"), process.env.STRIPE_WEBHOOK_SECRET);
    } else {
      event = JSON.parse(req.body.toString("utf8") || "{}");
    }
  } catch (error) {
    mutateDb((db) => monitor(db, "error", "stripe", "Invalid Stripe webhook payload", { detail: error.message }));
    return res.status(400).json({ error: "Invalid Stripe webhook signature or payload." });
  }

  // Idempotency: Stripe retries deliver the same event.id. Skip if already
  // handled so side-effects (refund cancellation, status changes) run once.
  if (event.id && webhookAlreadyProcessed(readDb(), event.id)) {
    return res.json({ received: true, duplicate: true });
  }

  const webhookObject = event.data && event.data.object ? event.data.object : {};
  const refundWebhook = event.type.includes("refund");
  let webhookCancellationResult = [];
  if (refundWebhook && stripe && process.env.STRIPE_SECRET_KEY) {
    const family = findFamilyForStripeObject(readDb(), webhookObject);
    webhookCancellationResult = await cancelStripeSubscriptionsNow(stripe, family);
  }

  mutateDb((db) => {
    markWebhookProcessed(db, event.id, event.type);
    const object = webhookObject;
    const metadata = object.metadata || {};
    const familyId = metadata.familyId;
    const email = stripeObjectEmail(object);
    let family = findFamilyForStripeObject(db, object);
    if (!family && event.type === "checkout.session.completed" && email) {
      family = normaliseFamily({
        id: familyId || makeId("fam"),
        parentName: metadata.parentName || "Parent",
        email,
        loginType: "Parent",
        studentName: metadata.studentName || "",
        grade: metadata.grade || "",
        readingLevel: metadata.readingLevel || "",
        plan: metadata.planName || "Family Monthly",
        subscriptionStatus: "active",
        paymentStatus: "paid",
        stripeCustomerId: stripeId(object.customer) || "",
        stripeSubscriptionId: stripeId(object.subscription) || ""
      });
      db.families.unshift(family);
      db.users.push({
        id: makeId("usr"),
        role: "parent",
        name: family.parentName,
        email: family.email,
        passwordHash: hashPassword(process.env.PARENT_TEST_PASSWORD || "kiddiegpt123"),
        familyId: family.id,
        createdAt: nowIso()
      });
      audit(db, "family.create.from_stripe", { familyId: family.id, email: family.email });
    }
    if (!family) {
      recordStripePayment(db, event, object, null);
      audit(db, "stripe.webhook.unmatched", { type: event.type, familyId, email });
      monitor(db, "warning", "stripe", "Stripe webhook did not match a family", { type: event.type, familyId, email }, email || "stripe");
      return null;
    }

    if (event.type === "checkout.session.completed") {
      family.subscriptionStatus = "active";
      family.paymentStatus = "paid";
      family.plan = metadata.planName || family.pendingPlanName || family.plan;
      delete family.pendingPlanName;
      family.stripeCustomerId = stripeId(object.customer) || family.stripeCustomerId;
      family.stripeSubscriptionId = stripeId(object.subscription) || family.stripeSubscriptionId;
      family.lastLoginAt = family.lastLoginAt || nowIso();
    }
    if (event.type === "invoice.payment_failed") {
      family.paymentStatus = "failed";
      family.subscriptionStatus = family.subscriptionStatus === "active" ? "active" : "pending";
      startDunning(db, family);
    }
    if (event.type === "invoice.payment_succeeded" || event.type === "invoice.paid" || event.type === "invoice_payment.paid") {
      family.paymentStatus = "paid";
      family.subscriptionStatus = "active";
      clearDunning(family); // payment recovered — stop dunning, restore access
      family.stripePaymentId = stripeId(object.payment_intent) || stripeId(object.charge) || stripeId(object.id) || family.stripePaymentId;
      family.stripeCustomerId = stripeId(object.customer) || family.stripeCustomerId;
      family.stripeSubscriptionId = stripeId(object.subscription) || family.stripeSubscriptionId;
      family.lastPaymentAt = nowIso();
      const periodEnd = object.period_end || (object.lines && object.lines.data && object.lines.data[0] && object.lines.data[0].period && object.lines.data[0].period.end);
      if (periodEnd) family.currentPeriodEnd = unixToIso(periodEnd) || family.currentPeriodEnd;
      delete family.nextRenewalDiscountCents; // one-time discount consumed on this invoice
    }
    if (event.type === "customer.subscription.deleted") {
      family.subscriptionStatus = "cancelled";
      family.cancellationStatus = family.cancellationStatus === "scheduled" ? "completed" : family.cancellationStatus;
      family.cancelledAt = nowIso();
    }
    if (event.type === "customer.subscription.updated") {
      if (object.current_period_end) family.currentPeriodEnd = unixToIso(object.current_period_end) || family.currentPeriodEnd;
      if (object.cancel_at_period_end) {
        markCancellationScheduled(family, object);
      } else {
        family.subscriptionStatus = object.status === "active" ? "active" : family.subscriptionStatus;
        if (family.subscriptionStatus === "active") {
          family.cancellationRequested = false;
          family.cancellationStatus = "";
          family.cancelAtPeriodEnd = false;
          family.cancelAccessUntil = "";
          family.cancellationAccessUntil = "";
        }
      }
    }
    if (refundWebhook) {
      family.paymentStatus = "refunded";
      family.refundedAt = nowIso();
      markSubscriptionEndedNow(family, "Payment refunded", effectiveFamilySubscriptionId(family) || family.stripeSubscriptionId || "");
    }
    if (event.type.includes("checkout.session") || event.type.includes("invoice") || event.type.includes("payment_intent") || event.type.includes("charge")) {
      recordStripePayment(db, event, object, family);
    }
    audit(db, "stripe.webhook", { type: event.type, familyId: family.id, webhookCancellationResult });
    return family;
  });

  res.json({ received: true, mode: process.env.STRIPE_WEBHOOK_SECRET ? "verified" : "mock" });
  // Kick an immediate sweep so dunning emails / suspensions act without waiting
  // for the next cron tick.
  if (AUTOPILOT_ENABLED && /invoice|subscription/.test(event.type)) {
    runLifecycleSweep("webhook").catch(() => {});
  }
});

app.use(express.json());

async function sendEmail({ to, template, message }) {
  const recipient = normalizeEmail(to || process.env.TEST_EMAIL_TO || "");
  if (!isAllowedParentEmail(recipient)) {
    throw new Error(parentEmailError(recipient));
  }
  const templateName = template || "Welcome parent";
  const subject = `KiddieGPT test: ${templateName}`;
  const text = message || `This is a KiddieGPT developer-mode test email for "${templateName}".`;

  if (postmarkConfigured()) {
    const response = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": process.env.POSTMARK_SERVER_TOKEN
      },
      body: JSON.stringify({
        From: postmarkFromEmail(),
        To: recipient,
        Subject: subject,
        TextBody: text,
        MessageStream: process.env.POSTMARK_MESSAGE_STREAM || "outbound",
        Tag: templateName.slice(0, 100),
        Metadata: {
          app: "kiddiegpt",
          template: templateName
        }
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.Message || payload.message || "Postmark email failed.");
    }
    return { mode: "postmark", to: recipient, subject, messageId: payload.MessageID || payload.MessageId || "" };
  }

  if (!smtpConfigured()) {
    return {
      mode: "mock",
      to: recipient,
      subject,
      preview: text,
      message: "Email provider is not configured. Email send was simulated."
    };
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
  const info = await transporter.sendMail({
    from: process.env.FROM_EMAIL || process.env.SMTP_USER,
    to: recipient,
    subject,
    text
  });
  return { mode: "smtp", to: recipient, subject, messageId: info.messageId };
}

app.get("/api/dev/status", (req, res) => {
  const db = readDb();
  res.json({
    persistence: { mode: "json", path: dbPath, families: db.families.length },
    stripe: {
      configured: Boolean(process.env.STRIPE_SECRET_KEY),
      mode: stripeMode(),
      webhookConfigured: Boolean(process.env.STRIPE_WEBHOOK_SECRET)
    },
    email: {
      configured: emailMode() !== "mock",
      mode: emailMode(),
      fromConfigured: Boolean(postmarkFromEmail())
    },
    login: {
      adminConfigured: Boolean(process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD),
      tokenAuth: true,
      tokenTtlHours: Number(process.env.AUTH_TOKEN_TTL_HOURS || 24),
      allowedParentEmailDomains,
      googleConfigured: Boolean(process.env.GOOGLE_CLIENT_ID)
    }
  });
});

app.get("/api/auth/config", (req, res) => {
  res.json({
    allowedParentEmailDomains,
    googleClientId: process.env.GOOGLE_CLIENT_ID || "",
    googleConfigured: Boolean(process.env.GOOGLE_CLIENT_ID)
  });
});

app.post("/api/auth/login", (req, res) => {
  const { email, password, role } = req.body || {};
  const requestedRole = role || "parent";
  const normalizedEmail = normalizeEmail(email);
  if (requestedRole === "parent" && !isAllowedParentEmail(normalizedEmail)) {
    return res.status(400).json({ ok: false, error: parentEmailError(normalizedEmail) });
  }
  const db = readDb();
  let user = db.users.find((item) => item.email === normalizedEmail && item.role === requestedRole);
  if (!user && requestedRole === "parent") {
    const family = db.families.find((item) => item.email === normalizedEmail);
    if (family && password) {
      user = {
        id: family.id,
        role: "parent",
        name: family.parentName,
        email: family.email,
        passwordHash: hashPassword(process.env.PARENT_TEST_PASSWORD || "kiddiegpt123")
      };
    }
  }
  if (!user || !verifyPassword(password, user.passwordHash)) {
    mutateDb((dbToUpdate) => monitor(dbToUpdate, "warning", "auth", "Failed login", { email: normalizedEmail, role: requestedRole }, normalizedEmail));
    return res.status(401).json({ ok: false, error: "Invalid email or password." });
  }
  if (requestedRole === "parent" && user.emailVerified === false) {
    mutateDb((dbToUpdate) => monitor(dbToUpdate, "warning", "auth", "Unverified parent login blocked", { email: user.email }, user.email));
    return res.status(403).json({ ok: false, pendingVerification: true, email: user.email, error: "Verify your email with the 6-digit code before signing in." });
  }
  if (requestedRole === "parent") {
    const family = parentFamilyForIdentity(db, user);
    if (family?.accountLocked || user.accountLocked) {
      mutateDb((dbToUpdate) => monitor(dbToUpdate, "warning", "auth", "Locked parent login blocked", { email: user.email, familyId: family?.id || "" }, user.email));
      return parentLockedResponse(res);
    }
  }
  const token = createAuthSession(user, "password");
  res.json({ ok: true, token, user: { id: user.id, role: user.role, name: user.name, email: user.email } });
});

async function verifyGoogleIdToken(idToken) {
  if (!idToken) throw new Error("Missing Google credential.");
  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  const profile = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(profile.error_description || profile.error || "Google credential could not be verified.");
  if (process.env.GOOGLE_CLIENT_ID && profile.aud !== process.env.GOOGLE_CLIENT_ID) {
    throw new Error("Google credential audience does not match this app.");
  }
  if (String(profile.email_verified) !== "true") {
    throw new Error("Google email is not verified.");
  }
  return {
    googleSub: profile.sub,
    email: normalizeEmail(profile.email),
    name: profile.name || profile.given_name || "Parent"
  };
}

app.post("/api/auth/google", async (req, res) => {
  try {
    const requestedRole = req.body?.role || "parent";
    if (requestedRole !== "parent") {
      return res.status(400).json({ ok: false, error: "Google sign-in is enabled for parent accounts only." });
    }
    const profile = await verifyGoogleIdToken(req.body?.credential || req.body?.idToken);
    if (!isAllowedParentEmail(profile.email)) {
      return res.status(400).json({ ok: false, error: parentEmailError(profile.email) });
    }
    const existingFamily = readDb().families.find((item) => item.email === profile.email);
    if (existingFamily?.accountLocked) {
      mutateDb((db) => monitor(db, "warning", "auth", "Locked parent Google sign-in blocked", { email: profile.email, familyId: existingFamily.id }, profile.email));
      return parentLockedResponse(res);
    }
    const user = mutateDb((db) => {
      let family = db.families.find((item) => item.email === profile.email);
      if (!family) {
        family = normaliseFamily({
          parentName: profile.name,
          email: profile.email,
          loginType: "Google",
          subscriptionStatus: "pending",
          paymentStatus: "pending",
          accountLocked: false
        });
        db.families.unshift(family);
        audit(db, "family.create.google", { familyId: family.id, email: family.email }, profile.email);
      } else {
        family.parentName = family.parentName || profile.name;
        family.loginType = "Google";
      }
      let parentUser = db.users.find((item) => item.email === profile.email && item.role === "parent");
      if (!parentUser) {
        parentUser = {
          id: makeId("usr"),
          role: "parent",
          name: profile.name,
          email: profile.email,
          familyId: family.id,
          authProvider: "google",
          googleSub: profile.googleSub,
          emailVerified: true,
          createdAt: nowIso()
        };
        db.users.push(parentUser);
      } else {
        parentUser.name = parentUser.name || profile.name;
        parentUser.familyId = parentUser.familyId || family.id;
        parentUser.authProvider = "google";
        parentUser.googleSub = profile.googleSub;
        parentUser.emailVerified = true;
      }
      audit(db, "auth.google.upsert", { familyId: family.id, email: profile.email }, profile.email);
      return parentUser;
    });
    const token = createAuthSession(user, "google");
    return res.json({ ok: true, token, user: { id: user.id, role: user.role, name: user.name, email: user.email } });
  } catch (error) {
    return res.status(401).json({ ok: false, error: error.message || "Google sign-in failed." });
  }
});

async function sendSignupOtp(email, otp) {
  return sendAndLogEmail({
    to: email,
    template: "Verify parent email",
    message: `Your KiddieGPT verification code is ${otp}. It expires in ${process.env.EMAIL_OTP_TTL_MINUTES || 10} minutes.`
  });
}

async function sendPasswordResetOtp(email, otp) {
  return sendAndLogEmail({
    to: email,
    template: "Reset parent password",
    message: `Your KiddieGPT password reset code is ${otp}. It expires in ${process.env.EMAIL_OTP_TTL_MINUTES || 10} minutes.`
  });
}

async function sendEmailChangeOtp(email, otp) {
  return sendAndLogEmail({
    to: email,
    template: "Confirm new parent email",
    message: `Your KiddieGPT email change code is ${otp}. It expires in ${process.env.EMAIL_OTP_TTL_MINUTES || 10} minutes.`
  });
}

app.post("/api/auth/signup", async (req, res) => {
  const name = String(req.body?.name || req.body?.parentName || "Parent").trim() || "Parent";
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");
  if (!isAllowedParentEmail(email)) {
    return res.status(400).json({ ok: false, error: parentEmailError(email) });
  }
  if (password.length < 8) {
    return res.status(400).json({ ok: false, error: "Password must be at least 8 characters." });
  }

  const otp = generateOtp();
  const pending = mutateDb((db) => {
    cleanupOtps(db);
    const existingUser = db.users.find((item) => item.email === email && item.role === "parent");
    if (existingUser && existingUser.emailVerified !== false) return { existing: true, user: existingUser };

    let family = db.families.find((item) => item.email === email);
    if (!family) {
      family = normaliseFamily({
        parentName: name,
        email,
        loginType: "Parent",
        subscriptionStatus: "pending",
        paymentStatus: "pending",
        accountLocked: false
      });
      db.families.unshift(family);
      audit(db, "family.create.signup", { familyId: family.id, email }, email);
    } else {
      family.parentName = name || family.parentName;
    }

    const parentUser = existingUser || {
      id: makeId("usr"),
      role: "parent",
      email,
      familyId: family.id,
      createdAt: nowIso()
    };
    parentUser.name = name;
    parentUser.passwordHash = hashPassword(password);
    parentUser.familyId = family.id;
    parentUser.authProvider = "password";
    parentUser.emailVerified = false;
    if (!existingUser) db.users.push(parentUser);

    family.emailVerified = false;
    db.emailOtps = (db.emailOtps || []).filter((item) => !(item.email === email && item.purpose === "signup"));
    db.emailOtps.unshift({
      id: makeId("otp"),
      email,
      userId: parentUser.id,
      purpose: "signup",
      otpHash: hashOtp(email, otp),
      attempts: 0,
      expiresAt: otpExpiryIso(),
      createdAt: nowIso()
    });
    audit(db, existingUser ? "auth.signup.otp_resend" : "auth.signup.otp_create", { familyId: family.id, email }, email);
    return { existing: false, user: parentUser };
  });

  if (pending.existing) {
    return res.status(409).json({ ok: false, error: "Account already exists. Sign in instead." });
  }
  try {
    await sendSignupOtp(email, otp);
  } catch (error) {
    mutateDb((db) => monitor(db, "error", "email", "Signup verification email failed", { email, detail: error.message }, email));
    return res.status(500).json({ ok: false, pendingVerification: true, email, error: "Account created, but the verification email could not be sent.", detail: error.message });
  }
  return res.json({ ok: true, pendingVerification: true, email, message: "Verification code sent. Enter the 6-digit code to finish signup." });
});

app.post("/api/auth/resend-otp", async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!isAllowedParentEmail(email)) {
    return res.status(400).json({ ok: false, error: parentEmailError(email) });
  }
  const otp = generateOtp();
  const pending = mutateDb((db) => {
    cleanupOtps(db);
    const user = db.users.find((item) => item.email === email && item.role === "parent");
    if (!user) return null;
    if (user.emailVerified !== false) return { alreadyVerified: true, user };
    db.emailOtps = (db.emailOtps || []).filter((item) => !(item.email === email && item.purpose === "signup"));
    db.emailOtps.unshift({
      id: makeId("otp"),
      email,
      userId: user.id,
      purpose: "signup",
      otpHash: hashOtp(email, otp),
      attempts: 0,
      expiresAt: otpExpiryIso(),
      createdAt: nowIso()
    });
    audit(db, "auth.signup.otp_resend", { email }, email);
    return { user };
  });
  if (!pending) return res.status(404).json({ ok: false, error: "No pending signup found for this email." });
  if (pending.alreadyVerified) return res.status(409).json({ ok: false, error: "Email is already verified. Sign in instead." });
  try {
    await sendSignupOtp(email, otp);
  } catch (error) {
    mutateDb((db) => monitor(db, "error", "email", "Signup OTP resend failed", { email, detail: error.message }, email));
    return res.status(500).json({ ok: false, error: "Unable to resend verification email.", detail: error.message });
  }
  return res.json({ ok: true, pendingVerification: true, email, message: "New verification code sent." });
});

app.post("/api/auth/verify-otp", (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const otp = String(req.body?.otp || "").trim();
  if (!isAllowedParentEmail(email)) {
    return res.status(400).json({ ok: false, error: parentEmailError(email) });
  }
  if (!/^\d{6}$/.test(otp)) {
    return res.status(400).json({ ok: false, error: "Enter the 6-digit verification code." });
  }

  const verified = mutateDb((db) => {
    cleanupOtps(db);
    const record = (db.emailOtps || []).find((item) => item.email === email && item.purpose === "signup");
    if (!record) return { error: "Verification code expired. Request a new code." };
    if (record.otpHash !== hashOtp(email, otp)) {
      record.attempts = Number(record.attempts || 0) + 1;
      return { error: record.attempts >= 5 ? "Too many attempts. Request a new code." : "Verification code is incorrect." };
    }
    const user = db.users.find((item) => item.id === record.userId && item.role === "parent");
    if (!user) return { error: "Parent account not found." };
    user.emailVerified = true;
    const family = db.families.find((item) => item.email === email);
    if (family) family.emailVerified = true;
    db.emailOtps = (db.emailOtps || []).filter((item) => item.id !== record.id);
    audit(db, "auth.signup.otp_verified", { userId: user.id, familyId: family?.id || "", email }, email);
    return { user };
  });

  if (verified.error) {
    mutateDb((db) => monitor(db, "warning", "auth", "Signup OTP verification failed", { email, reason: verified.error }, email));
    return res.status(400).json({ ok: false, error: verified.error });
  }
  const token = createAuthSession(verified.user, "email_otp");
  return res.json({ ok: true, token, user: { id: verified.user.id, role: verified.user.role, name: verified.user.name, email: verified.user.email } });
});

// Passwordless email-OTP login (used by the browser extension). Returns a real
// portal token so the extension can call the entitlement + AI proxy endpoints.
app.post("/api/auth/otp/request", async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!isAllowedParentEmail(email)) return res.status(400).json({ ok: false, error: parentEmailError(email) });
  const otp = generateOtp();
  mutateDb((db) => {
    cleanupOtps(db);
    db.emailOtps = (db.emailOtps || []).filter((item) => !(item.email === email && item.purpose === "login"));
    db.emailOtps.unshift({ id: makeId("otp"), email, purpose: "login", otpHash: hashOtp(email, otp), attempts: 0, expiresAt: otpExpiryIso(), createdAt: nowIso() });
    audit(db, "auth.login_otp.request", { email }, email);
  });
  let mode = "mock";
  try {
    const result = await sendEmail({ to: email, template: "Sign-in code", message: `Your KiddieGPT sign-in code is ${otp}. It expires shortly.` });
    mode = result.mode || "mock";
  } catch (error) {
    mutateDb((db) => monitor(db, "warning", "auth", "Login OTP email failed", { email, detail: String(error.message || error) }, email));
  }
  // In mock/dev (no email provider) return the code so the extension can show it.
  return res.json({ ok: true, mode, ...(mode === "mock" ? { testCode: otp } : {}) });
});

app.post("/api/auth/otp/verify", (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const otp = String(req.body?.otp || req.body?.code || "").trim();
  if (!isAllowedParentEmail(email)) return res.status(400).json({ ok: false, error: parentEmailError(email) });
  if (!/^\d{6}$/.test(otp)) return res.status(400).json({ ok: false, error: "Enter the 6-digit code." });
  const result = mutateDb((db) => {
    cleanupOtps(db);
    const record = (db.emailOtps || []).find((item) => item.email === email && item.purpose === "login");
    if (!record) return { error: "Code expired. Request a new one." };
    if (record.otpHash !== hashOtp(email, otp)) {
      record.attempts = Number(record.attempts || 0) + 1;
      return { error: record.attempts >= 5 ? "Too many attempts. Request a new code." : "Incorrect code." };
    }
    let user = db.users.find((item) => item.email === email && item.role === "parent");
    if (!user) {
      const fam = db.families.find((item) => item.email === email);
      user = { id: makeId("usr"), role: "parent", name: fam?.parentName || "Parent", email, familyId: fam?.id || "", emailVerified: true, passwordHash: hashPassword(crypto.randomBytes(18).toString("hex")), createdAt: nowIso() };
      db.users.push(user);
    }
    user.emailVerified = true;
    const family = parentFamilyForIdentity(db, { role: "parent", email, familyId: user.familyId });
    if (family?.accountLocked) return { locked: true };
    db.emailOtps = (db.emailOtps || []).filter((item) => item.id !== record.id);
    audit(db, "auth.login_otp.verified", { userId: user.id, email }, email);
    return { user };
  });
  if (result.locked) return parentLockedResponse(res);
  if (result.error) {
    mutateDb((db) => monitor(db, "warning", "auth", "Login OTP verification failed", { email, reason: result.error }, email));
    return res.status(400).json({ ok: false, error: result.error });
  }
  const token = createAuthSession(result.user, "email_otp_login");
  return res.json({ ok: true, token, user: { id: result.user.id, role: result.user.role, name: result.user.name, email: result.user.email } });
});

app.post("/api/auth/request-password-reset", async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!isAllowedParentEmail(email)) {
    return res.status(400).json({ ok: false, error: parentEmailError(email) });
  }
  const otp = generateOtp();
  const pending = mutateDb((db) => {
    cleanupOtps(db);
    const user = db.users.find((item) => item.email === email && item.role === "parent");
    if (!user) {
      monitor(db, "warning", "auth", "Password reset requested for unknown parent", { email }, email);
      return null;
    }
    db.emailOtps = (db.emailOtps || []).filter((item) => !(item.email === email && item.purpose === "password_reset"));
    db.emailOtps.unshift({
      id: makeId("otp"),
      email,
      userId: user.id,
      purpose: "password_reset",
      otpHash: hashOtp(email, otp),
      attempts: 0,
      expiresAt: otpExpiryIso(),
      createdAt: nowIso()
    });
    audit(db, "auth.password_reset.request", { email }, email);
    return user;
  });

  if (!pending) {
    return res.json({ ok: true, message: "If an account exists, a reset code was sent." });
  }
  try {
    await sendPasswordResetOtp(email, otp);
  } catch (error) {
    mutateDb((db) => monitor(db, "error", "email", "Password reset email failed", { email, detail: error.message }, email));
    return res.status(500).json({ ok: false, error: "Unable to send password reset email.", detail: error.message });
  }
  return res.json({ ok: true, email, message: "Password reset code sent." });
});

app.post("/api/auth/reset-password", (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const otp = String(req.body?.otp || "").trim();
  const newPassword = String(req.body?.newPassword || req.body?.password || "");
  if (!isAllowedParentEmail(email)) {
    return res.status(400).json({ ok: false, error: parentEmailError(email) });
  }
  if (!/^\d{6}$/.test(otp)) {
    return res.status(400).json({ ok: false, error: "Enter the 6-digit reset code." });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ ok: false, error: "New password must be at least 8 characters." });
  }

  const reset = mutateDb((db) => {
    cleanupOtps(db);
    const record = (db.emailOtps || []).find((item) => item.email === email && item.purpose === "password_reset");
    if (!record) return { error: "Reset code expired. Request a new code." };
    if (record.otpHash !== hashOtp(email, otp)) {
      record.attempts = Number(record.attempts || 0) + 1;
      monitor(db, "warning", "auth", "Password reset OTP failed", { email, attempts: record.attempts }, email);
      return { error: record.attempts >= 5 ? "Too many attempts. Request a new code." : "Reset code is incorrect." };
    }
    const user = db.users.find((item) => item.id === record.userId && item.role === "parent");
    if (!user) return { error: "Parent account not found." };
    const family = parentFamilyForIdentity(db, user);
    if (family?.accountLocked || user.accountLocked) {
      monitor(db, "warning", "auth", "Locked parent password reset sign-in blocked", { email, familyId: family?.id || "" }, email);
      return { locked: true };
    }
    user.passwordHash = hashPassword(newPassword);
    user.emailVerified = true;
    if (family) family.emailVerified = true;
    db.emailOtps = (db.emailOtps || []).filter((item) => item.id !== record.id);
    audit(db, "auth.password_reset.complete", { userId: user.id, familyId: family?.id || "", email }, email);
    monitor(db, "info", "auth", "Parent password reset completed", { email }, email);
    return { user };
  });

  if (reset.locked) return parentLockedResponse(res);
  if (reset.error) return res.status(400).json({ ok: false, error: reset.error });
  const token = createAuthSession(reset.user, "password_reset");
  return res.json({ ok: true, token, user: { id: reset.user.id, role: reset.user.role, name: reset.user.name, email: reset.user.email } });
});

app.get("/api/auth/me", (req, res) => {
  const auth = authFromRequest(req);
  if (!auth) return res.status(401).json({ error: "Not signed in." });
  if (auth.role === "parent") {
    const db = readDb();
    const family = parentFamilyForIdentity(db, auth);
    const user = db.users.find((item) => item.id === auth.sub && item.role === "parent");
    if (family?.accountLocked || user?.accountLocked) {
      mutateDb((dbToUpdate) => monitor(dbToUpdate, "warning", "auth", "Locked parent session blocked", { email: auth.email, familyId: family?.id || "" }, auth.email));
      return parentLockedResponse(res);
    }
    const familyPublic = family ? {
      id: family.id,
      parentName: family.parentName || "",
      email: family.email || "",
      plan: family.plan || "",
      children: (Array.isArray(family.children) ? family.children : []).map((child) => ({
        id: child.id,
        studentName: child.studentName || "",
        grade: child.grade || "",
        readingLevel: child.readingLevel || "",
        goal: child.goal || "",
        reward: child.reward || "",
        learningGoals: Array.isArray(child.learningGoals) ? child.learningGoals : []
      }))
    } : null;
    return res.json({ user: auth, family: familyPublic });
  }
  res.json({ user: auth });
});

app.post("/api/account/change-password", requireParent, (req, res) => {
  const currentPassword = String(req.body?.currentPassword || "");
  const newPassword = String(req.body?.newPassword || "");
  if (newPassword.length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters." });
  }
  const updated = mutateDb((db) => {
    const user = db.users.find((item) => item.id === req.auth.sub && item.role === "parent");
    if (!user || !verifyPassword(currentPassword, user.passwordHash)) {
      monitor(db, "warning", "auth", "Change password failed", { email: req.auth.email }, req.auth.email);
      return null;
    }
    user.passwordHash = hashPassword(newPassword);
    revokeUserSessions(user); // invalidate all existing tokens
    db.sessions = (db.sessions || []).filter((session) => session.userId !== user.id);
    audit(db, "account.password.change", { userId: user.id, email: user.email }, user.email);
    monitor(db, "info", "auth", "Parent password changed", { email: user.email }, user.email);
    return user;
  });
  if (!updated) return res.status(400).json({ error: "Current password is incorrect." });
  // Issue a fresh token so the caller stays signed in after revoking old ones.
  const token = createAuthSession(updated, "password_change");
  res.json({ ok: true, message: "Password updated.", token });
});

app.post("/api/account/request-email-change", requireParent, async (req, res) => {
  const newEmail = normalizeEmail(req.body?.newEmail);
  if (!isAllowedParentEmail(newEmail)) {
    return res.status(400).json({ error: parentEmailError(newEmail) });
  }
  if (newEmail === normalizeEmail(req.auth.email)) {
    return res.status(400).json({ error: "New email must be different from the current email." });
  }
  const otp = generateOtp();
  const pending = mutateDb((db) => {
    cleanupOtps(db);
    const duplicate = db.users.some((item) => item.role === "parent" && item.email === newEmail && item.id !== req.auth.sub);
    if (duplicate || db.families.some((family) => family.email === newEmail)) {
      return { error: "That parent email is already in use." };
    }
    const user = db.users.find((item) => item.id === req.auth.sub && item.role === "parent");
    if (!user) return { error: "Parent account not found." };
    db.emailOtps = (db.emailOtps || []).filter((item) => !(item.userId === user.id && item.purpose === "email_change"));
    db.emailOtps.unshift({
      id: makeId("otp"),
      email: newEmail,
      userId: user.id,
      purpose: "email_change",
      otpHash: hashOtp(newEmail, otp),
      attempts: 0,
      expiresAt: otpExpiryIso(),
      metadata: { oldEmail: user.email, newEmail },
      createdAt: nowIso()
    });
    audit(db, "account.email_change.request", { userId: user.id, oldEmail: user.email, newEmail }, user.email);
    return { user };
  });
  if (pending.error) return res.status(400).json({ error: pending.error });
  try {
    await sendEmailChangeOtp(newEmail, otp);
  } catch (error) {
    mutateDb((db) => monitor(db, "error", "email", "Email change verification failed to send", { newEmail, detail: error.message }, req.auth.email));
    return res.status(500).json({ error: "Unable to send email change code.", detail: error.message });
  }
  res.json({ ok: true, email: newEmail, message: "Verification code sent to the new email." });
});

app.post("/api/account/confirm-email-change", requireParent, (req, res) => {
  const newEmail = normalizeEmail(req.body?.newEmail);
  const otp = String(req.body?.otp || "").trim();
  if (!isAllowedParentEmail(newEmail)) {
    return res.status(400).json({ error: parentEmailError(newEmail) });
  }
  if (!/^\d{6}$/.test(otp)) {
    return res.status(400).json({ error: "Enter the 6-digit verification code." });
  }
  const updated = mutateDb((db) => {
    cleanupOtps(db);
    const record = (db.emailOtps || []).find((item) => item.userId === req.auth.sub && item.email === newEmail && item.purpose === "email_change");
    if (!record) return { error: "Email change code expired. Request a new code." };
    if (record.otpHash !== hashOtp(newEmail, otp)) {
      record.attempts = Number(record.attempts || 0) + 1;
      monitor(db, "warning", "auth", "Email change OTP failed", { newEmail, attempts: record.attempts }, req.auth.email);
      return { error: record.attempts >= 5 ? "Too many attempts. Request a new code." : "Verification code is incorrect." };
    }
    const user = db.users.find((item) => item.id === req.auth.sub && item.role === "parent");
    if (!user) return { error: "Parent account not found." };
    const oldEmail = normalizeEmail(user.email);
    if (db.users.some((item) => item.role === "parent" && item.email === newEmail && item.id !== user.id)) {
      return { error: "That parent email is already in use." };
    }
    user.email = newEmail;
    user.emailVerified = true;
    const family = db.families.find((item) => item.id === user.familyId || item.email === oldEmail);
    if (family) {
      family.email = newEmail;
      family.emailVerified = true;
      family.loginType = family.loginType || "Parent";
    }
    revokeUserSessions(user); // old tokens (old email) can no longer be used
    db.sessions = (db.sessions || []).filter((session) => session.userId !== user.id);
    db.emailOtps = (db.emailOtps || []).filter((item) => item.id !== record.id);
    audit(db, "account.email_change.complete", { userId: user.id, oldEmail, newEmail, familyId: family?.id || "" }, newEmail);
    monitor(db, "info", "auth", "Parent email changed", { oldEmail, newEmail }, newEmail);
    return { user };
  });
  if (updated.error) return res.status(400).json({ error: updated.error });
  const token = createAuthSession(updated.user, "email_change");
  res.json({ ok: true, token, user: { id: updated.user.id, role: updated.user.role, name: updated.user.name, email: updated.user.email }, message: "Email updated." });
});

app.post("/api/account/delete-request", requireParent, (req, res) => {
  const result = mutateDb((db) => {
    const user = db.users.find((item) => item.id === req.auth.sub && item.role === "parent");
    if (!user) return null;
    user.deletionRequestedAt = nowIso();
    revokeUserSessions(user);
    db.sessions = (db.sessions || []).filter((session) => session.userId !== user.id);
    const family = db.families.find((item) => item.id === user.familyId || item.email === user.email);
    if (family) {
      family.deletionRequestedAt = user.deletionRequestedAt;
      family.accountLocked = true;
      family.subscriptionStatus = family.subscriptionStatus === "active" ? "paused" : family.subscriptionStatus;
    }
    audit(db, "account.delete.request", { userId: user.id, familyId: family?.id || "", email: user.email }, user.email);
    monitor(db, "warning", "account", "Parent requested account deletion", { email: user.email, familyId: family?.id || "" }, user.email);
    return { user, family };
  });
  if (!result) return res.status(404).json({ error: "Parent account not found." });
  res.json({ ok: true, message: "Account deletion request recorded. Access is locked while you review the request." });
});

app.get("/api/admin/state", requireAdmin, (req, res) => {
  const db = readDb();
  res.json({ families: db.families, pricing: db.pricing, deletedUserSequence: Number(db.deletedUserSequence || 0), payments: db.payments.slice(0, 100), auditLogs: db.auditLogs.slice(0, 300), emailLogs: db.emailLogs.slice(0, 100), monitorEvents: (db.monitorEvents || []).slice(0, 100) });
});

app.post("/api/admin/state", requireAdmin, (req, res) => {
  const { families, pricing } = req.body || {};
  const updated = mutateDb((db) => {
    if (Array.isArray(families)) db.families = families.map(normaliseFamily);
    if (pricing) db.pricing = pricing;
    audit(db, "admin.state.save", { families: db.families.length });
    return { families: db.families, pricing: db.pricing };
  });
  res.json(updated);
});

app.get("/api/pricing", (req, res) => {
  res.json(normalisePricing(readDb().pricing));
});

app.put("/api/pricing", requireAdmin, (req, res) => {
  const pricing = normalisePricing(req.body || {});
  const updated = mutateDb((db) => {
    db.pricing = pricing;
    audit(db, "pricing.update", pricing);
    return db.pricing;
  });
  res.json(updated);
});

app.get("/api/admin/ai-settings", requireAdmin, (req, res) => {
  const db = readDb();
  res.json(safeAiSettings(db.aiSettings));
});

app.put("/api/admin/ai-settings", requireAdmin, (req, res) => {
  const body = req.body || {};
  const updated = mutateDb((db) => {
    const current = normaliseAiSettings(db.aiSettings);
    const next = { ...current };
    if (Object.prototype.hasOwnProperty.call(body, "openaiApiKey")) {
      const incomingKey = String(body.openaiApiKey || "").trim();
      if (incomingKey) next.openaiApiKey = incomingKey;
    }
    if (body.clearOpenAIKey) next.openaiApiKey = "";
    if (Object.prototype.hasOwnProperty.call(body, "openaiModel")) {
      const model = String(body.openaiModel || "").trim();
      if (model) next.openaiModel = model;
    }
    if (Object.prototype.hasOwnProperty.call(body, "mathProblemsPerUserDaily")) {
      next.mathProblemsPerUserDaily = Math.max(0, Number(body.mathProblemsPerUserDaily) || 0);
    }
    if (Object.prototype.hasOwnProperty.call(body, "tutorVoiceMinutesPerUserDaily")) {
      next.tutorVoiceMinutesPerUserDaily = Math.max(0, Number(body.tutorVoiceMinutesPerUserDaily) || 0);
    }
    if (Object.prototype.hasOwnProperty.call(body, "tutorVoiceEnabled")) {
      next.tutorVoiceEnabled = body.tutorVoiceEnabled !== false;
    }
    next.updatedAt = nowIso();
    next.updatedBy = req.auth?.email || "admin";
    db.aiSettings = normaliseAiSettings(next);
    audit(db, "ai_settings.update", {
      hasOpenAIKey: Boolean(db.aiSettings.openaiApiKey),
      mathProblemsPerUserDaily: db.aiSettings.mathProblemsPerUserDaily,
      tutorVoiceMinutesPerUserDaily: db.aiSettings.tutorVoiceMinutesPerUserDaily,
      tutorVoiceEnabled: db.aiSettings.tutorVoiceEnabled
    }, req.auth?.email || "admin");
    return safeAiSettings(db.aiSettings);
  });
  res.json(updated);
});

app.get("/api/ai/usage-limits", requireParent, (req, res) => {
  const db = readDb();
  const settings = normaliseAiSettings(db.aiSettings);
  const family = parentFamilyForIdentity(db, req.auth);
  const childId = String(req.query.childId || "");
  const limits = effectiveLimits(settings, family);
  res.json({
    // Effective values already fold in the family's parental controls.
    mathProblemsPerUserDaily: limits.mathProblemsPerUserDaily,
    tutorVoiceMinutesPerUserDaily: limits.tutorVoiceMinutesPerUserDaily,
    tutorVoiceEnabled: limits.tutorVoiceEnabled,
    requireSteps: limits.requireSteps,
    controls: limits.controls,
    aiConfigured: Boolean(settings.openaiApiKey),
    remaining: family
      ? usageRemaining(family, settings, childId)
      : { mathProblems: limits.mathProblemsPerUserDaily, voiceMinutes: limits.tutorVoiceMinutesPerUserDaily }
  });
});

// Parent-facing view of each child's real learning activity.
app.get("/api/account/progress", requireParent, (req, res) => {
  const db = readDb();
  const settings = normaliseAiSettings(db.aiSettings);
  const family = parentFamilyForIdentity(db, req.auth);
  if (!family) return res.status(404).json({ error: "Family not found." });
  const limits = effectiveLimits(settings, family);
  const children = (Array.isArray(family.children) ? family.children : []).map((child) => {
    const today = usageToday(child);
    const week = usageWindow(child, 7);
    const goals = Array.isArray(child.learningGoals) ? child.learningGoals : [];
    const totals = (child.usage && child.usage.totals) || { mathProblems: 0, voiceSeconds: 0, tools: {} };
    const tools = totals.tools || {};
    const LEARN = ["pdf", "read", "write", "explain", "tutor", "mission", "screenshot"];
    return {
      id: child.id,
      name: child.studentName || "",
      grade: child.grade || "",
      today,
      week,
      totals,
      stats: {
        flashcards: Number(tools.flashcard || 0),
        quiz: Number(tools.quiz || 0),
        math: Number(totals.mathProblems || 0),
        topics: LEARN.reduce((sum, t) => sum + Number(tools[t] || 0), 0)
      },
      progress: progressRowsForChild(db, child.id, 7),
      favoriteTool: favoriteToolFromUsage(child) || "",
      lastExtensionUseAt: (child.usage && child.usage.lastExtensionUseAt) || "",
      remaining: usageRemaining(family, settings, child.id),
      goals: { total: goals.length, completed: goals.filter((g) => g && g.completed).length }
    };
  });
  res.json({
    plan: effectiveFamilyPlan(family),
    active: family.subscriptionStatus === "active" || cancellationStillActive(family) || hasActiveOverride(family),
    caps: {
      mathProblemsPerUserDaily: limits.mathProblemsPerUserDaily,
      tutorVoiceMinutesPerUserDaily: limits.tutorVoiceMinutesPerUserDaily,
      tutorVoiceEnabled: limits.tutorVoiceEnabled
    },
    controls: limits.controls,
    children
  });
});

function usageToday(child) {
  const day = usageDayKey();
  const bucket = (child && child.usage && child.usage.daily && child.usage.daily[day]) || {};
  return { math: Number(bucket.mathProblems) || 0, voiceMinutes: Math.round((Number(bucket.voiceSeconds) || 0) / 60) };
}

app.get("/api/account/controls", requireParent, (req, res) => {
  const family = parentFamilyForIdentity(readDb(), req.auth);
  if (!family) return res.status(404).json({ error: "Family not found." });
  res.json({ controls: normaliseParentControls(family.controls) });
});

app.put("/api/account/controls", requireParent, (req, res) => {
  const body = req.body || {};
  const result = mutateDb((db) => {
    const family = parentFamilyForIdentity(db, req.auth);
    if (!family) return null;
    const current = normaliseParentControls(family.controls);
    family.controls = normaliseParentControls({
      requireSteps: Object.prototype.hasOwnProperty.call(body, "requireSteps") ? body.requireSteps : current.requireSteps,
      voiceEnabled: Object.prototype.hasOwnProperty.call(body, "voiceEnabled") ? body.voiceEnabled : current.voiceEnabled,
      mathDailyCap: Object.prototype.hasOwnProperty.call(body, "mathDailyCap") ? body.mathDailyCap : current.mathDailyCap,
      weeklySummary: Object.prototype.hasOwnProperty.call(body, "weeklySummary") ? body.weeklySummary : current.weeklySummary
    });
    audit(db, "account.controls.update", { familyId: family.id, controls: family.controls }, req.auth.email);
    return family.controls;
  });
  if (!result) return res.status(404).json({ error: "Family not found." });
  res.json({ ok: true, controls: result });
});

// Extension reports a metered action after it happens (used when the extension
// calls OpenAI, or to record non-AI tool opens). AI proxy routes below record
// usage automatically, so the extension should not double-report those.
// ---- Student progress sync (rich per-day activity from the extension) -------
// The extension debounces and re-POSTs the whole day bucket as activity grows,
// so writes are idempotent: last write for a (childId, date) wins. Buckets hold
// counts, quiz titles, and question text only — never student name/email.
function clampProgressInt(value, max = 100000) {
  const n = Math.floor(Number(value) || 0);
  return n < 0 ? 0 : n > max ? max : n;
}
function clampProgressStr(value, len) {
  return String(value == null ? "" : value).slice(0, len);
}
function sanitizeProgressBucket(raw) {
  const b = raw && typeof raw === "object" ? raw : {};
  const out = {
    lessons: clampProgressInt(b.lessons),
    cardsReviewed: clampProgressInt(b.cardsReviewed),
    mathSolved: clampProgressInt(b.mathSolved),
    tutorLessons: clampProgressInt(b.tutorLessons),
    explains: clampProgressInt(b.explains),
    writingChecks: clampProgressInt(b.writingChecks)
  };
  if (b.lastLesson) out.lastLesson = clampProgressStr(b.lastLesson, 100);
  const quizzes = Array.isArray(b.quizzes) ? b.quizzes.slice(0, 12) : [];
  out.quizzes = quizzes.map((raw) => {
    const quiz = raw && typeof raw === "object" ? raw : {};
    const missed = Array.isArray(quiz.missed) ? quiz.missed.slice(0, 12) : [];
    return {
      title: clampProgressStr(quiz.title || "Quiz", 100),
      score: clampProgressInt(quiz.score, 10000),
      total: clampProgressInt(quiz.total, 10000),
      ts: Number(quiz.ts) || Date.now(),
      missed: missed.map((raw) => {
        const item = raw && typeof raw === "object" ? raw : {};
        return {
          q: clampProgressStr(item.q, 100),
          answer: clampProgressStr(item.answer, 60),
          chosen: clampProgressStr(item.chosen || "(blank)", 60)
        };
      })
    };
  });
  return out;
}
function progressRowsForChild(db, childId, days) {
  const cutoff = Date.now() - Math.min(90, Math.max(1, Number(days) || 7)) * 86400000;
  return (db.studentProgress || [])
    .filter((r) => r.childId === childId)
    .filter((r) => { const t = new Date((r.date || "") + "T00:00:00").getTime(); return !t || t >= cutoff; })
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .map((r) => ({ date: r.date, bucket: r.bucket }));
}
// A provided childId MUST belong to this parent (never silently fall back to
// another child, or a tampered id could write/read someone else's data). Only
// when no childId is supplied do we attribute to the family's first child.
function ownedChild(family, childId) {
  const children = Array.isArray(family?.children) ? family.children : [];
  if (childId) return children.find((c) => c.id === childId) || null;
  return children[0] || null;
}

app.post("/api/progress", requireParent, (req, res) => {
  const body = req.body || {};
  const date = String(body.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "bad_date" });
  const result = mutateDb((db) => {
    const family = parentFamilyForIdentity(db, req.auth);
    if (!family) return { error: "family_not_found" };
    const child = ownedChild(family, body.childId);
    if (!child) return { error: "not_your_child" };
    db.studentProgress = Array.isArray(db.studentProgress) ? db.studentProgress : [];
    const bucket = sanitizeProgressBucket(body.bucket);
    const idx = db.studentProgress.findIndex((r) => r.childId === child.id && r.date === date);
    const row = { childId: child.id, date, bucket, updatedAt: nowIso() };
    if (idx >= 0) db.studentProgress[idx] = row; else db.studentProgress.unshift(row);
    // Prune: drop buckets older than 120 days and cap total rows.
    const cutoff = Date.now() - 120 * 86400000;
    db.studentProgress = db.studentProgress
      .filter((r) => { const t = new Date((r.date || "") + "T00:00:00").getTime(); return !t || t >= cutoff; })
      .slice(0, 2000);
    return { ok: true };
  });
  if (result.error === "family_not_found") return res.status(404).json({ error: "family_not_found" });
  if (result.error === "not_your_child") return res.status(403).json({ error: "not_your_child" });
  res.json({ ok: true });
});

app.get("/api/progress", requireParent, (req, res) => {
  const db = readDb();
  const family = parentFamilyForIdentity(db, req.auth);
  if (!family) return res.status(404).json({ error: "family_not_found" });
  const child = ownedChild(family, String(req.query.childId || ""));
  if (!child) return res.status(403).json({ error: "not_your_child" });
  res.json({ days: progressRowsForChild(db, child.id, req.query.days) });
});

app.post("/api/usage/report", requireParent, (req, res) => {
  const body = req.body || {};
  const tool = String(body.tool || "").trim();
  const result = mutateDb((db) => {
    const family = parentFamilyForIdentity(db, req.auth);
    if (!family) return { error: "family_not_found" };
    const settings = normaliseAiSettings(db.aiSettings);
    const child = recordChildUsage(family, {
      childId: body.childId,
      tool,
      mathProblems: body.mathProblems,
      voiceSeconds: body.voiceSeconds,
      at: body.at
    });
    if (!child) return { error: "no_child" };
    audit(db, "usage.report", {
      familyId: family.id,
      childId: child.id,
      tool,
      mathProblems: Math.max(0, Number(body.mathProblems) || 0),
      voiceSeconds: Math.max(0, Number(body.voiceSeconds) || 0)
    }, req.auth.email);
    return { ok: true, remaining: usageRemaining(family, settings, child.id) };
  });
  if (result.error === "family_not_found") return res.status(404).json({ ok: false, error: "Family not found." });
  if (result.error === "no_child") return res.status(400).json({ ok: false, error: "No student profile to attribute usage to." });
  res.json(result);
});

// ---- Parent support messages ----------------------------------------------
const SUPPORT_CATEGORIES = new Set(["Billing", "Login", "Math tool", "Extension", "Other"]);

app.post("/api/support/message", requireParent, async (req, res) => {
  const body = req.body || {};
  const message = String(body.message || "").trim();
  if (!message) return res.status(400).json({ error: "Enter a message." });
  if (message.length > 300) return res.status(400).json({ error: "Message must be 300 characters or fewer." });
  const category = SUPPORT_CATEGORIES.has(String(body.category)) ? String(body.category) : "Other";
  const created = mutateDb((db) => {
    const family = parentFamilyForIdentity(db, req.auth);
    const entry = {
      id: makeId("sup"),
      familyId: family?.id || "",
      email: req.auth.email,
      name: family?.parentName || req.auth.email,
      category,
      message,
      status: "open",
      replies: [],
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    db.supportMessages.unshift(entry);
    if (db.supportMessages.length > 1000) db.supportMessages.length = 1000;
    audit(db, "support.message", { id: entry.id, email: entry.email, category }, entry.email);
    monitor(db, "warning", "support", "New parent support message", { email: entry.email, category }, entry.email);
    return entry;
  });
  // Notify the operator (best effort; only if an email provider is configured).
  try {
    await sendEmail({ to: process.env.ADMIN_NOTIFY_EMAIL || "", template: "Support message", message: `New ${category} message from ${created.email}:\n\n${message}` });
  } catch (error) { /* ignore — visible in the admin console regardless */ }
  res.json({ ok: true, message: created });
});

app.get("/api/support/messages", requireParent, (req, res) => {
  const db = readDb();
  const email = normalizeEmail(req.auth.email);
  // Only show the parent messages from the last 30 days (auto-hide older ones).
  const cutoff = Date.now() - 30 * 86400000;
  const mine = (db.supportMessages || [])
    .filter((m) => m.email === email && new Date(m.updatedAt || m.createdAt).getTime() >= cutoff)
    .slice(0, 50);
  res.json({ messages: mine });
});

app.get("/api/admin/support", requireAdmin, (req, res) => {
  res.json({ messages: (readDb().supportMessages || []).slice(0, 200) });
});

app.post("/api/admin/support/:id/reply", requireAdmin, async (req, res) => {
  const reply = String(req.body?.message || "").trim().slice(0, 2000);
  if (!reply) return res.status(400).json({ error: "Enter a reply." });
  const updated = mutateDb((db) => {
    const entry = (db.supportMessages || []).find((m) => m.id === req.params.id);
    if (!entry) return null;
    entry.replies = entry.replies || [];
    entry.replies.push({ from: "admin", message: reply, at: nowIso() });
    entry.status = "replied";
    entry.updatedAt = nowIso();
    audit(db, "support.reply", { id: entry.id, email: entry.email }, req.auth?.email || "admin");
    return entry;
  });
  if (!updated) return res.status(404).json({ error: "Message not found." });
  // Email the parent their reply (best effort).
  try {
    await sendEmail({ to: updated.email, template: "Support reply", message: `Reply from KiddieGPT support:\n\n${reply}` });
  } catch (error) { /* ignore */ }
  res.json({ ok: true, message: updated });
});

app.post("/api/admin/support/:id/resolve", requireAdmin, (req, res) => {
  const updated = mutateDb((db) => {
    const entry = (db.supportMessages || []).find((m) => m.id === req.params.id);
    if (!entry) return null;
    entry.status = entry.status === "resolved" ? "open" : "resolved";
    entry.updatedAt = nowIso();
    audit(db, "support.resolve", { id: entry.id, status: entry.status }, req.auth?.email || "admin");
    return entry;
  });
  if (!updated) return res.status(404).json({ error: "Message not found." });
  res.json({ ok: true, message: updated });
});

// Helpdesk view: one conversation per parent, messages + replies flattened into
// chronological turns (parent = incoming, admin = outgoing).
app.get("/api/admin/support/conversations", requireAdmin, (req, res) => {
  const db = readDb();
  const byEmail = {};
  (db.supportMessages || []).forEach((m) => {
    const conv = byEmail[m.email] || (byEmail[m.email] = { email: m.email, name: m.name || m.email, familyId: m.familyId || "", turns: [], statuses: [], categories: {} });
    conv.name = conv.name || m.name;
    conv.categories[m.category] = true;
    conv.turns.push({ from: "parent", message: m.message, at: m.createdAt, category: m.category });
    (m.replies || []).forEach((r) => conv.turns.push({ from: r.from === "admin" ? "admin" : "parent", message: r.message, at: r.at }));
    conv.statuses.push(m.status);
  });
  const conversations = Object.values(byEmail).map((c) => {
    c.turns.sort((a, b) => new Date(a.at) - new Date(b.at));
    const last = c.turns[c.turns.length - 1] || {};
    return {
      email: c.email, name: c.name, familyId: c.familyId, turns: c.turns,
      categories: Object.keys(c.categories),
      lastAt: last.at || "", lastMessage: last.message || "", lastFrom: last.from || "",
      open: c.statuses.some((s) => s !== "resolved")
    };
  }).sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
  res.json({ conversations, openCount: conversations.filter((c) => c.open).length });
});

app.post("/api/admin/support/reply", requireAdmin, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const reply = String(req.body?.message || "").trim().slice(0, 2000);
  if (!email || !reply) return res.status(400).json({ error: "Missing email or message." });
  const target = mutateDb((db) => {
    const msgs = (db.supportMessages || []).filter((m) => m.email === email);
    if (!msgs.length) return null;
    const latest = msgs.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
    latest.replies = latest.replies || [];
    latest.replies.push({ from: "admin", message: reply, at: nowIso() });
    latest.status = "replied";
    latest.updatedAt = nowIso();
    audit(db, "support.reply", { email }, req.auth?.email || "admin");
    return latest;
  });
  if (!target) return res.status(404).json({ error: "No messages from that parent." });
  try { await sendEmail({ to: email, template: "Support reply", message: `Reply from KiddieGPT support:\n\n${reply}` }); } catch (error) { /* ignore */ }
  res.json({ ok: true });
});

app.post("/api/admin/support/resolve", requireAdmin, (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const result = mutateDb((db) => {
    const msgs = (db.supportMessages || []).filter((m) => m.email === email);
    if (!msgs.length) return null;
    const resolving = msgs.some((m) => m.status !== "resolved");
    msgs.forEach((m) => { m.status = resolving ? "resolved" : "open"; m.updatedAt = nowIso(); });
    audit(db, "support.resolve", { email, resolved: resolving }, req.auth?.email || "admin");
    return { resolving };
  });
  if (!result) return res.status(404).json({ error: "No messages from that parent." });
  res.json({ ok: true, resolved: result.resolving });
});

// ---- Issue reporting (from the extension) ---------------------------------
// No auth: login failures happen before a token exists. CORS-allowed so the
// extension can post from any signed-in or signed-out state.
const ISSUE_TYPES = new Set(["login_failed", "api_key", "math_feedback", "extension_error", "other"]);
const ISSUE_LABELS = {
  login_failed: "Login failed",
  api_key: "API key / AI not working",
  math_feedback: "Math tool: “didn't work”",
  extension_error: "Extension error",
  other: "Other"
};

app.post("/api/issues/report", (req, res) => {
  const body = req.body || {};
  const type = ISSUE_TYPES.has(String(body.type)) ? String(body.type) : "other";
  const detail = String(body.detail || "").slice(0, 500);
  const email = normalizeEmail(body.email || "");
  const auth = authFromRequest(req);
  mutateDb((db) => {
    db.issues = db.issues || [];
    db.issues.unshift({
      id: makeId("iss"),
      type,
      label: ISSUE_LABELS[type],
      detail,
      email: email || auth?.email || "",
      source: String(body.source || "extension").slice(0, 40),
      context: (body.context && typeof body.context === "object") ? body.context : {},
      status: "open",
      createdAt: nowIso()
    });
    if (db.issues.length > 500) db.issues.length = 500;
    monitor(db, type === "math_feedback" ? "info" : "warning", "issue", ISSUE_LABELS[type], { detail, email: email || auth?.email || "" }, email || auth?.email || "extension");
    return null;
  });
  res.json({ ok: true });
});

app.get("/api/admin/issues", requireAdmin, (req, res) => {
  const db = readDb();
  res.json({ issues: (db.issues || []).slice(0, 200), labels: ISSUE_LABELS });
});

app.post("/api/admin/issues/:id/resolve", requireAdmin, (req, res) => {
  const updated = mutateDb((db) => {
    const issue = (db.issues || []).find((item) => item.id === req.params.id);
    if (!issue) return null;
    issue.status = issue.status === "resolved" ? "open" : "resolved";
    issue.resolvedAt = issue.status === "resolved" ? nowIso() : "";
    audit(db, "issue.resolve", { id: issue.id, type: issue.type, status: issue.status }, req.auth?.email || "admin");
    return issue;
  });
  if (!updated) return res.status(404).json({ error: "Issue not found." });
  res.json({ ok: true, issue: updated });
});

function extractOutputText(data) {
  if (!data) return "";
  if (data.output_text) return String(data.output_text).trim();
  return (data.output || [])
    .flatMap((item) => item.content || [])
    .map((content) => content.text || "")
    .join("\n")
    .trim();
}

// ---- Weekly log digest: group the last N days of signals for the operator ---
// Extension-facing problems (crashes, login, AI failures) are surfaced first
// because they directly break the kid-facing product. Works without AI (the
// grouping is deterministic); when an OpenAI key is configured it also returns
// a short written brief.
const DIGEST_BUCKETS = [
  { key: "extension_error", title: "Extension errors", hint: "Runtime crashes or failed requests inside the Chrome extension." },
  { key: "login_failed", title: "Login & auth failures", hint: "Parents or kids unable to sign in from the extension." },
  { key: "api_key", title: "AI / API failures", hint: "OpenAI proxy errors or a missing key — the AI tools stop working." },
  { key: "math_feedback", title: "Math tool feedback", hint: "Kids marked a math answer as unhelpful." },
  { key: "billing", title: "Billing & payments", hint: "Failed charges, webhook or Stripe problems." },
  { key: "email", title: "Email delivery", hint: "Lifecycle or support emails that failed to send." },
  { key: "other", title: "Other signals", hint: "Everything else worth a glance." }
];

app.get("/api/admin/logs/digest", requireAdmin, async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
  const since = Date.now() - days * 86400000;
  const db = readDb();
  const inWindow = (iso) => { const t = new Date(iso || 0).getTime(); return t && t >= since; };

  const groups = {};
  DIGEST_BUCKETS.forEach((d) => { groups[d.key] = { ...d, count: 0, errors: 0, users: new Set(), lastAt: "", samples: [] }; });
  const bump = (key, sev, detail, email, at) => {
    const g = groups[key] || groups.other;
    g.count += 1;
    if (sev === "error") g.errors += 1;
    if (email && email !== "system" && email !== "extension") g.users.add(email);
    if (!g.lastAt || new Date(at).getTime() > new Date(g.lastAt).getTime()) g.lastAt = at;
    if (g.samples.length < 4 && detail) g.samples.push({ detail: String(detail).slice(0, 160), email: email || "", at });
  };

  // Reported issues (mostly from the extension) → typed buckets.
  (db.issues || []).filter((i) => inWindow(i.createdAt)).forEach((i) => {
    const key = ["extension_error", "login_failed", "api_key", "math_feedback"].includes(i.type) ? i.type : "other";
    bump(key, i.type === "math_feedback" ? "info" : "warning", i.detail || i.label, i.email, i.createdAt);
  });

  // Monitor events → buckets by category. Skip the "issue" category (already
  // represented above) and info-level noise.
  (db.monitorEvents || []).filter((e) => inWindow(e.createdAt)).forEach((e) => {
    if (e.category === "issue" || e.severity === "info") return;
    let key = "other";
    if (e.category === "ai") key = "api_key";
    else if (e.category === "auth" || e.category === "entitlement") key = "login_failed";
    else if (["billing", "stripe", "webhook", "payment"].includes(e.category)) key = "billing";
    else if (e.category === "email") key = "email";
    bump(key, e.severity, e.message + (e.payload && e.payload.detail ? " — " + e.payload.detail : ""), e.actor, e.createdAt);
  });

  const sevRank = { error: 3, warning: 2, info: 1, none: 0 };
  const list = DIGEST_BUCKETS.map((d) => {
    const g = groups[d.key];
    return {
      key: g.key, title: g.title, hint: g.hint,
      count: g.count, errors: g.errors,
      users: Array.from(g.users), userCount: g.users.size,
      lastAt: g.lastAt,
      severity: g.errors > 0 ? "error" : g.count > 0 ? "warning" : "none",
      samples: g.samples
    };
  }).filter((g) => g.count > 0)
    .sort((a, b) => (sevRank[b.severity] - sevRank[a.severity]) || (b.count - a.count));

  const allUsers = new Set();
  list.forEach((g) => g.users.forEach((u) => allUsers.add(u)));
  const extKeys = ["extension_error", "login_failed", "api_key"];
  const totals = {
    signals: list.reduce((s, g) => s + g.count, 0),
    errors: list.reduce((s, g) => s + g.errors, 0),
    affectedUsers: allUsers.size,
    extensionSignals: list.filter((g) => extKeys.includes(g.key)).reduce((s, g) => s + g.count, 0)
  };

  let aiSummary = null;
  const settings = normaliseAiSettings(db.aiSettings);
  if (settings.openaiApiKey && list.length) {
    try {
      const compact = list.map((g) => ({ group: g.title, count: g.count, errors: g.errors, users: g.userCount, examples: g.samples.map((s) => s.detail) }));
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.openaiApiKey}` },
        body: JSON.stringify({
          model: settings.openaiModel || "gpt-4.1-mini",
          instructions: `You are an operations assistant for KiddieGPT, a kids' learning Chrome extension. You are given grouped error/issue data from the last ${days} days. Write a short brief (max 120 words) for a solo founder. Lead with extension-facing problems (crashes, login failures, AI failures) because those directly break the product for kids. Name the single most urgent group, the likely root cause, and one concrete next action. Plain text, no markdown headings, no fluff.`,
          input: JSON.stringify(compact)
        })
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) aiSummary = extractOutputText(data) || null;
    } catch (error) { aiSummary = null; }
  }

  res.json({ windowDays: days, since: new Date(since).toISOString(), totals, groups: list, aiSummary, aiConfigured: Boolean(settings.openaiApiKey) });
});

// ---- AI proxy (portal holds the OpenAI key; extension never sees it) --------
function isFamilyEntitled(family) {
  if (!family || family.accountLocked) return false;
  return family.subscriptionStatus === "active" || cancellationStillActive(family) || hasActiveOverride(family);
}

app.post("/api/ai/responses", requireParent, async (req, res) => {
  const body = req.body || {};
  const tool = String(body.tool || "").trim();
  const db = readDb();
  const settings = normaliseAiSettings(db.aiSettings);
  const family = parentFamilyForIdentity(db, req.auth);
  if (!settings.openaiApiKey) return res.status(503).json({ error: "ai_not_configured", message: "AI is not configured. Add an OpenAI key in the admin console." });
  if (!isFamilyEntitled(family)) return res.status(402).json({ error: "subscription_inactive" });
  const isMath = tool === "math";
  if (isMath && usageRemaining(family, settings, body.childId).mathProblems <= 0) {
    return res.status(429).json({ error: "cap_reached", scope: "math" });
  }
  // Enforce the "require step-by-step" parental control server-side so it can't
  // be bypassed by the client.
  let instructions = body.instructions;
  if (isMath && effectiveLimits(settings, family).requireSteps) {
    instructions = `${instructions || ""}\n\nIMPORTANT PARENTAL CONTROL: Never reveal the final numeric answer directly. Guide the student through the steps one at a time and prompt them to try each step themselves.`;
  }
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.openaiApiKey}` },
      body: JSON.stringify({
        model: body.model || settings.openaiModel || "gpt-4.1",
        instructions,
        input: body.input
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(response.status || 502).json({ error: "openai_error", detail: data });
    const tokens = Number(data.usage?.total_tokens || data.usage?.input_tokens + data.usage?.output_tokens || 0) || 0;
    mutateDb((store) => {
      const fam = parentFamilyForIdentity(store, req.auth);
      if (fam) recordChildUsage(fam, { childId: body.childId, tool: tool || "ai", mathProblems: isMath ? Math.max(1, Number(body.mathProblems) || 1) : 0, tokens });
    });
    res.json(data);
  } catch (error) {
    mutateDb((store) => monitor(store, "error", "ai", "OpenAI responses proxy failed", { detail: String(error.message || error) }, req.auth.email));
    res.status(502).json({ error: "openai_unreachable" });
  }
});

app.post("/api/ai/speech", requireParent, async (req, res) => {
  const body = req.body || {};
  const db = readDb();
  const settings = normaliseAiSettings(db.aiSettings);
  const family = parentFamilyForIdentity(db, req.auth);
  if (!settings.openaiApiKey) return res.status(503).json({ error: "ai_not_configured" });
  if (!isFamilyEntitled(family)) return res.status(402).json({ error: "subscription_inactive" });
  // Voice may be off at the admin level or by the family's parental controls.
  if (!effectiveLimits(settings, family).tutorVoiceEnabled) return res.status(403).json({ error: "voice_disabled" });
  if (usageRemaining(family, settings, body.childId).voiceMinutes <= 0) {
    return res.status(429).json({ error: "cap_reached", scope: "voice" });
  }
  const text = String(body.text || "").trim();
  if (!text) return res.status(400).json({ error: "empty_text" });
  const gradeBand = body.gradeBand || "6-8";
  const pace = gradeBand === "K-2"
    ? "Speak slowly and gently for a young child."
    : gradeBand === "3-5"
      ? "Speak at a calm, clear pace."
      : "Speak at a natural, encouraging pace.";
  try {
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.openaiApiKey}` },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice: body.voice || "sage",
        input: text,
        instructions: `Speak like a warm, patient tutor. ${pace} Clear, encouraging, not childish. Add gentle pauses between sentences.`,
        response_format: "mp3"
      })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return res.status(response.status || 502).json({ error: "openai_error", detail });
    }
    const seconds = Math.max(1, Number(body.estSeconds) || Math.ceil(text.length / 14));
    mutateDb((store) => {
      const fam = parentFamilyForIdentity(store, req.auth);
      if (fam) recordChildUsage(fam, { childId: body.childId, tool: "voice", voiceSeconds: seconds });
    });
    const audio = Buffer.from(await response.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(audio);
  } catch (error) {
    mutateDb((store) => monitor(store, "error", "ai", "OpenAI speech proxy failed", { detail: String(error.message || error) }, req.auth.email));
    res.status(502).json({ error: "openai_unreachable" });
  }
});

app.post("/api/families", (req, res) => {
  const family = normaliseFamily(req.body || {});
  if (!isAllowedParentEmail(family.email)) {
    return res.status(400).json({ error: parentEmailError(family.email) });
  }
  const saved = mutateDb((db) => {
    const existingIndex = db.families.findIndex((item) => item.email === family.email);
    if (existingIndex >= 0) {
      db.families[existingIndex] = { ...db.families[existingIndex], ...family, id: db.families[existingIndex].id };
      audit(db, "family.update", { familyId: db.families[existingIndex].id, email: family.email });
      return db.families[existingIndex];
    }
    db.families.unshift(family);
    db.users.push({
      id: makeId("usr"),
      role: "parent",
      name: family.parentName,
      email: family.email,
      passwordHash: hashPassword(req.body.password || process.env.PARENT_TEST_PASSWORD || "kiddiegpt123"),
      familyId: family.id,
      createdAt: nowIso()
    });
    audit(db, "family.create", { familyId: family.id, email: family.email });
    return family;
  });
  res.json(saved);
});

app.patch("/api/admin/families/:id", requireAdmin, (req, res) => {
  const updated = mutateDb((db) => {
    const family = db.families.find((item) => item.id === req.params.id);
    if (!family) return null;
    Object.assign(family, req.body || {});
    audit(db, "family.patch", { familyId: family.id, fields: Object.keys(req.body || {}) });
    return family;
  });
  if (!updated) return res.status(404).json({ error: "Family not found." });
  res.json(updated);
});

app.post("/api/admin/users/:id/lock", requireAdmin, (req, res) => {
  const updated = mutateDb((db) => {
    const family = db.families.find((item) => item.id === req.params.id);
    if (!family) return null;
    family.accountLocked = Boolean(req.body.locked);
    family[family.accountLocked ? "lockedAt" : "unlockedAt"] = nowIso();
    const parentUser = db.users.find((user) =>
      user.role === "parent" &&
      (user.familyId === family.id || user.email === family.email)
    );
    if (parentUser) {
      parentUser.accountLocked = family.accountLocked;
      parentUser.familyId = parentUser.familyId || family.id;
      parentUser[parentUser.accountLocked ? "lockedAt" : "unlockedAt"] = nowIso();
      if (!parentUser.accountLocked) delete parentUser.lockedAt;
      if (family.accountLocked) revokeUserSessions(parentUser);
    }
    if (family.accountLocked) {
      db.sessions = (db.sessions || []).filter((session) => session.userId !== parentUser?.id && session.email !== family.email);
    }
    audit(db, family.accountLocked ? "account.lock" : "account.unlock", { familyId: family.id, email: family.email, userId: parentUser?.id || "" });
    monitor(db, family.accountLocked ? "warning" : "info", "account", family.accountLocked ? "Parent account locked by admin" : "Parent account unlocked by admin", { familyId: family.id, email: family.email }, family.email);
    return family;
  });
  if (!updated) return res.status(404).json({ error: "Family not found." });
  res.json(updated);
});

app.post("/api/admin/users/:id/subscription-toggle", requireAdmin, async (req, res) => {
  const action = req.body?.action === "start" ? "start" : "end";
  const existingFamily = readDb().families.find((item) => item.id === req.params.id);
  if (!existingFamily) return res.status(404).json({ error: "Family not found." });

  let stripeResult = [];
  if (action === "end" && process.env.STRIPE_SECRET_KEY) {
    stripeResult = await cancelStripeSubscriptionsNow(stripeClient(), existingFamily);
  }

  const updated = mutateDb((db) => {
    const family = db.families.find((item) => item.id === req.params.id);
    if (!family) return null;
    if (action === "start") {
      family.subscriptionStatus = "active";
      family.paymentStatus = "paid";
      family.accountLocked = false;
      family.manualSubscriptionStartedAt = nowIso();
      family.cancellationRequested = false;
      family.cancellationStatus = "";
      family.cancelAtPeriodEnd = false;
      family.cancelAccessUntil = "";
      family.cancellationAccessUntil = "";
      family.cancelReason = "";
    } else {
      markSubscriptionEndedNow(family, "Admin ended subscription immediately");
      family.paymentStatus = family.paymentStatus || "cancelled";
      family.manualSubscriptionEndedAt = nowIso();
    }
    audit(db, action === "start" ? "subscription.start.manual" : "subscription.end.immediate", {
      familyId: family.id,
      email: family.email,
      stripeResult
    }, req.auth?.email || "admin");
    monitor(db, action === "start" ? "info" : "warning", "billing", action === "start" ? "Subscription manually started by admin" : "Subscription ended immediately by admin", { familyId: family.id, email: family.email, stripeResult }, req.auth?.email || "admin");
    return family;
  });
  if (!updated) return res.status(404).json({ error: "Family not found." });
  res.json({ ok: true, action, family: updated, stripeResult });
});

app.post("/api/admin/users/:id/anonymize", requireAdmin, (req, res) => {
  const result = mutateDb((db) => {
    const family = db.families.find((item) => item.id === req.params.id);
    if (!family) return null;
    if (family.anonymizedAt) {
      return { alreadyAnonymized: true, family };
    }

    const oldEmail = normalizeEmail(family.email);
    const oldParentName = family.parentName || "";
    const oldStudentNames = (family.children || []).map((child) => child.studentName).filter(Boolean);
    const deletedEmail = nextDeletedEmail(db);
    const deletedName = `Deleted user ${String(db.deletedUserSequence).padStart(5, "0")}`;
    const anonymizedAt = nowIso();
    const parentUser = db.users.find((user) =>
      user.role === "parent" &&
      (user.familyId === family.id || user.email === oldEmail)
    );
    const replacements = [
      { from: oldEmail, to: deletedEmail },
      { from: oldParentName, to: deletedName },
      ...oldStudentNames.map((name) => ({ from: name, to: "Deleted student" }))
    ].filter((item) => item.from);

    family.parentName = deletedName;
    family.email = deletedEmail;
    family.loginType = "Deleted";
    family.studentName = "";
    family.grade = "";
    family.readingLevel = "";
    family.goal = "";
    family.reward = "";
    family.children = [];
    family.learningGoals = [];
    family.guardrails = {};
    family.supportNote = "";
    family.favoriteTool = "";
    family.accountLocked = true;
    family.subscriptionStatus = "deleted";
    family.paymentStatus = "deleted";
    family.anonymizedAt = anonymizedAt;
    family.deletionCompletedAt = anonymizedAt;
    family.deletedEmail = deletedEmail;
    delete family.emailVerified;

    if (parentUser) {
      parentUser.name = deletedName;
      parentUser.email = deletedEmail;
      parentUser.accountLocked = true;
      parentUser.anonymizedAt = anonymizedAt;
      parentUser.deletionCompletedAt = anonymizedAt;
      parentUser.deletedEmail = deletedEmail;
      parentUser.passwordHash = hashPassword(crypto.randomBytes(24).toString("hex"));
      parentUser.familyId = family.id;
      revokeUserSessions(parentUser);
      delete parentUser.googleSub;
      delete parentUser.emailVerified;
      delete parentUser.authProvider;
    }

    db.sessions = (db.sessions || []).filter((session) => session.userId !== parentUser?.id && session.email !== oldEmail && session.email !== deletedEmail);
    db.emailOtps = (db.emailOtps || []).filter((otp) => otp.userId !== parentUser?.id && otp.email !== oldEmail && otp.email !== deletedEmail);
    db.payments = (db.payments || []).map((payment) => {
      if (payment.email === oldEmail || payment.familyId === family.id) {
        return { ...payment, email: deletedEmail, anonymizedAt };
      }
      return payment;
    });
    db.emailLogs = (db.emailLogs || []).map((log) => scrubValue(log, replacements));
    db.auditLogs = (db.auditLogs || []).map((log) => scrubValue(log, replacements));
    db.monitorEvents = (db.monitorEvents || []).map((event) => scrubValue(event, replacements));

    audit(db, "account.anonymize", { familyId: family.id, deletedEmail, userId: parentUser?.id || "" }, req.auth?.email || "admin");
    monitor(db, "warning", "account", "Parent account anonymized by admin", { familyId: family.id, deletedEmail }, req.auth?.email || "admin");
    return { family, deletedEmail, sequence: db.deletedUserSequence };
  });

  if (!result) return res.status(404).json({ error: "Family not found." });
  res.json(result);
});

app.get("/api/entitlements/me", (req, res) => {
  const auth = authFromRequest(req);
  if (process.env.REQUIRE_AUTH === "true" && !auth) {
    mutateDb((db) => monitor(db, "warning", "entitlement", "Extension entitlement check missing auth", { path: "/api/entitlements/me" }));
    return res.status(401).json({ active: false, reason: "auth_required" });
  }
  const email = normalizeEmail(auth?.role === "parent" ? auth.email : req.query.email || auth?.email || "");
  if (!isAllowedParentEmail(email)) {
    mutateDb((db) => monitor(db, "warning", "entitlement", "Entitlement check blocked by email domain", { email }, email));
    return res.status(400).json({ active: false, reason: "email_domain_blocked", error: parentEmailError(email) });
  }
  const family = readDb().families.find((item) => item.email === email);
  if (!family) {
    mutateDb((db) => monitor(db, "warning", "entitlement", "Entitlement check could not find family", { email }, email));
    return res.status(404).json({ active: false, reason: "family_not_found" });
  }
  const overrideActive = hasActiveOverride(family);
  const active = (family.subscriptionStatus === "active" || cancellationStillActive(family) || overrideActive) && !family.accountLocked;
  res.json({
    active,
    status: family.subscriptionStatus,
    locked: family.accountLocked,
    plan: effectiveFamilyPlan(family),
    familyId: family.id,
    createdAt: family.createdAt || "",
    paymentStatus: family.paymentStatus || "",
    overrideUntil: family.entitlementOverrideUntil || "",
    renewalAt: (family.yearlyUpgrade && family.yearlyUpgrade.yearlyNextRenewalAt) || family.currentPeriodEnd || family.nextRenewalAt || "",
    cancelAccessUntil: family.cancelAccessUntil || family.cancellationAccessUntil || "",
    cancellationStatus: family.cancellationStatus || "",
    cancelReason: family.cancelReason || "",
    stripeSubscriptionId: effectiveFamilySubscriptionId(family),
    yearlyUpgrade: family.yearlyUpgrade ? {
      status: family.yearlyUpgrade.status || "",
      billingMode: family.yearlyUpgrade.billingMode || "",
      bonusMonths: Number(family.yearlyUpgrade.bonusMonths || 0),
      accessMonths: Number(family.yearlyUpgrade.accessMonths || 0),
      monthlyEndsAt: family.yearlyUpgrade.monthlyEndsAt || null,
      yearlyNextRenewalAt: family.yearlyUpgrade.yearlyNextRenewalAt || null,
      chargedAt: family.yearlyUpgrade.chargedAt || "",
      yearlySubscriptionId: family.yearlyUpgrade.yearlySubscriptionId || ""
    } : null,
    reason: active ? overrideActive ? "override_active" : "active" : family.accountLocked ? "locked" : family.subscriptionStatus
  });
});

app.post("/api/stripe/create-checkout-session", async (req, res) => {
  const { planName, promoCode, familyId, successUrl, cancelUrl } = req.body || {};
  const parentEmail = normalizeEmail(req.body?.parentEmail || req.body?.email || "");
  if (parentEmail && !isAllowedParentEmail(parentEmail)) {
    return res.status(400).json({ error: parentEmailError(parentEmail) });
  }
  let checkoutFamilyId = familyId || "";
  if (parentEmail) {
    checkoutFamilyId = mutateDb((db) => {
      let family = db.families.find((item) => item.id === familyId || item.email === String(parentEmail).toLowerCase());
      if (!family) {
        family = normaliseFamily({
          parentName: req.body?.parentName || "Parent",
          email: parentEmail,
          loginType: "Parent",
          studentName: req.body?.studentName || "",
          grade: req.body?.grade || "",
          readingLevel: req.body?.readingLevel || "",
          plan: planName || "Family Monthly",
          subscriptionStatus: "pending",
          paymentStatus: "pending",
          accountLocked: false
        });
        db.families.unshift(family);
        db.users.push({
          id: makeId("usr"),
          role: "parent",
          name: family.parentName,
          email: family.email,
          passwordHash: hashPassword(req.body?.password || process.env.PARENT_TEST_PASSWORD || "kiddiegpt123"),
          familyId: family.id,
          createdAt: nowIso()
        });
        audit(db, "family.create.checkout_draft", { familyId: family.id, email: family.email });
      } else {
        family.parentName = req.body?.parentName || family.parentName;
        family.studentName = req.body?.studentName || family.studentName;
        family.grade = req.body?.grade || family.grade;
        family.readingLevel = req.body?.readingLevel || family.readingLevel;
        const alreadyActive = family.subscriptionStatus === "active" && family.paymentStatus === "paid";
        if (alreadyActive) {
          family.pendingPlanName = planName || family.pendingPlanName || family.plan;
        } else {
          family.plan = planName || family.plan;
          family.subscriptionStatus = "pending";
          family.paymentStatus = "pending";
        }
        audit(db, "family.update.checkout_draft", { familyId: family.id, email: family.email });
      }
      return family.id;
    });
  }
  const pricing = normalisePricing(readDb().pricing);
  const selectedPlan = Object.values(pricing || {}).find((plan) => plan && plan.label === planName);
  const effectivePriceId = req.body?.priceId || selectedPlan?.stripePriceId || "";
  const checkoutPromotion = promotionForPlan(pricing, planName);
  const checkoutFamily = parentEmail
    ? readDb().families.find((item) => item.id === checkoutFamilyId || item.email === String(parentEmail).toLowerCase())
    : null;

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.json({
      mode: "mock",
      sessionId: "cs_test_kiddiegpt_mock",
      url: successUrl || "/index.html?stripe=success&session_id=cs_test_kiddiegpt_mock",
      message: "Stripe secret key is not configured. Demo checkout was simulated.",
      promotion: checkoutPromotion
    });
  }

  if (!effectivePriceId) {
    return res.status(400).json({ error: "Missing Stripe Price ID for selected plan." });
  }

  if (
    checkoutFamily &&
    checkoutFamily.subscriptionStatus === "active" &&
    checkoutFamily.paymentStatus === "paid" &&
    checkoutFamily.stripeSubscriptionId &&
    !req.body?.allowNewSubscription
  ) {
    return res.status(409).json({
      error: "This family already has an active subscription. Use the billing portal or a subscription update flow instead of starting a new Checkout subscription.",
      familyId: checkoutFamily.id,
      subscriptionId: checkoutFamily.stripeSubscriptionId
    });
  }

  try {
    const stripe = stripeClient();
    const couponId = checkoutPromotion ? await ensurePromotionCoupon(stripe, checkoutPromotion) : "";
    const sessionPayload = {
      mode: "subscription",
      customer: checkoutFamily?.stripeCustomerId || undefined,
      customer_email: checkoutFamily?.stripeCustomerId ? undefined : parentEmail || undefined,
      line_items: [{ price: effectivePriceId, quantity: 1 }],
      success_url: successUrl || `${req.protocol}://${req.get("host")}/index.html?stripe=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl || `${req.protocol}://${req.get("host")}/index.html?stripe=cancelled`,
      metadata: {
        app: "KiddieGPT",
        familyId: checkoutFamilyId || "",
        parentEmail: parentEmail || "",
        parentName: req.body?.parentName || "",
        studentName: req.body?.studentName || "",
        grade: req.body?.grade || "",
        readingLevel: req.body?.readingLevel || "",
        planName: planName || "",
        promoCode: checkoutPromotion?.code || promoCode || "",
        promoPrice: checkoutPromotion ? String(checkoutPromotion.promoPrice) : ""
      },
      subscription_data: {
        metadata: {
          app: "KiddieGPT",
          familyId: checkoutFamilyId || "",
          parentEmail: parentEmail || "",
          promoCode: checkoutPromotion?.code || ""
        }
      }
    };
    if (couponId) {
      sessionPayload.discounts = [{ coupon: couponId }];
    } else {
      sessionPayload.allow_promotion_codes = true;
    }
    const session = await stripe.checkout.sessions.create(sessionPayload);
    mutateDb((db) => audit(db, "stripe.checkout.create", { sessionId: session.id, familyId: checkoutFamilyId, parentEmail, promoCode: checkoutPromotion?.code || "" }));
    return res.json({ mode: "stripe", sessionId: session.id, url: session.url, promotion: checkoutPromotion });
  } catch (error) {
    const safeError = checkoutStripeError(error, effectivePriceId);
    mutateDb((db) => monitor(db, "error", "stripe", "Stripe Checkout creation failed", { parentEmail, planName, priceId: effectivePriceId, detail: error.message, code: error.code || "", requestId: error.requestId || "" }, parentEmail));
    return res.status(500).json({ error: safeError, stripeCode: error.code || "", stripeRequestId: error.requestId || "" });
  }
});

app.post("/api/stripe/confirm-checkout-session", async (req, res) => {
  const sessionId = String(req.body?.sessionId || "").trim();
  if (!sessionId) return res.status(400).json({ error: "Missing Stripe Checkout Session ID." });
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.json({ mode: "mock", active: false, message: "Stripe secret key is not configured." });
  }

  try {
    const stripe = stripeClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["subscription", "subscription.latest_invoice.payment_intent"] });
    const subscription = session.subscription && typeof session.subscription === "object" ? session.subscription : null;
    const paid = session.payment_status === "paid" || subscription?.status === "active" || subscription?.status === "trialing";
    if (!paid) {
      return res.json({ mode: "stripe", active: false, paymentStatus: session.payment_status || subscription?.status || "pending" });
    }
    const paymentIntentId = await checkoutSessionPaymentIntentId(stripe, session);
    if (paymentIntentId) session.payment_intent = paymentIntentId;

    const metadata = session.metadata || {};
    const email = stripeObjectEmail(session);
    const family = mutateDb((db) => {
      let next = findFamilyForStripeObject(db, session);
      if (!next && email) {
        next = normaliseFamily({
          id: metadata.familyId || makeId("fam"),
          parentName: metadata.parentName || "Parent",
          email,
          loginType: "Parent",
          studentName: metadata.studentName || "",
          grade: metadata.grade || "",
          readingLevel: metadata.readingLevel || "",
          plan: metadata.planName || "Family Monthly",
          subscriptionStatus: "active",
          paymentStatus: "paid",
          stripeCustomerId: stripeId(session.customer) || "",
          stripeSubscriptionId: stripeId(subscription?.id || session.subscription) || ""
        });
        db.families.unshift(next);
        db.users.push({
          id: makeId("usr"),
          role: "parent",
          name: next.parentName,
          email: next.email,
          passwordHash: hashPassword(process.env.PARENT_TEST_PASSWORD || "kiddiegpt123"),
          familyId: next.id,
          createdAt: nowIso(),
          emailVerified: true
        });
      }
      if (!next) return null;
      next.subscriptionStatus = "active";
      next.paymentStatus = "paid";
      const keepYearlyUpgrade = hasConfirmedYearlyUpgrade(next);
      next.plan = keepYearlyUpgrade ? "Family Yearly" : metadata.planName || next.pendingPlanName || next.plan;
      next.stripeCustomerId = stripeId(session.customer) || next.stripeCustomerId;
      next.stripeSubscriptionId = keepYearlyUpgrade
        ? next.yearlyUpgrade.yearlySubscriptionId
        : stripeId(subscription?.id || session.subscription) || next.stripeSubscriptionId;
      next.stripeCheckoutSessionId = session.id;
      next.lastLoginAt = next.lastLoginAt || nowIso();
      delete next.pendingPlanName;
      recordStripePayment(db, { id: `confirm_${session.id}`, type: "checkout.session.completed" }, session, next);
      audit(db, "stripe.checkout.confirm", { sessionId: session.id, familyId: next.id, email: next.email });
      return next;
    });

    if (!family) return res.status(404).json({ error: "Paid Stripe session could not be matched to a family." });
    return res.json({
      mode: "stripe",
      active: true,
      familyId: family.id,
      plan: effectiveFamilyPlan(family),
      status: family.subscriptionStatus,
      paymentStatus: family.paymentStatus
    });
  } catch (error) {
    mutateDb((db) => monitor(db, "error", "stripe", "Stripe Checkout confirmation failed", { sessionId, detail: error.message, code: error.code || "", requestId: error.requestId || "" }));
    return res.status(500).json({ error: checkoutStripeError(error, sessionId), stripeCode: error.code || "", stripeRequestId: error.requestId || "" });
  }
});

app.post("/api/stripe/create-customer-portal-session", async (req, res) => {
  const email = normalizeEmail(req.body?.email || req.body?.parentEmail || "");
  if (email && !isAllowedParentEmail(email)) {
    return res.status(400).json({ error: parentEmailError(email) });
  }
  const returnUrl = req.body?.returnUrl || `${req.protocol}://${req.get("host")}/index.html`;
  const family = readDb().families.find((item) => item.email === email);

  if (!family) {
    return res.status(404).json({ error: "Family account not found." });
  }

  if (!process.env.STRIPE_SECRET_KEY || !family.stripeCustomerId) {
    return res.json({
      mode: "mock",
      message: "Stripe Customer Portal would open here when a Stripe customer exists for this family."
    });
  }

  try {
    const stripe = stripeClient();
    const session = await stripe.billingPortal.sessions.create({
      customer: family.stripeCustomerId,
      return_url: returnUrl
    });
    mutateDb((db) => audit(db, "stripe.portal.create", { familyId: family.id, email }));
    return res.json({ mode: "stripe", url: session.url });
  } catch (error) {
    mutateDb((db) => monitor(db, "error", "stripe", "Stripe billing portal creation failed", { email, detail: error.message }, email));
    return res.status(500).json({ error: "Unable to open Stripe Customer Portal. Make sure Customer Portal is enabled in Stripe." });
  }
});

app.post("/api/stripe/apply-retention-discount", async (req, res) => {
  const email = normalizeEmail(req.body?.email || req.body?.parentEmail || "");
  if (email && !isAllowedParentEmail(email)) {
    return res.status(400).json({ error: parentEmailError(email) });
  }
  const reason = String(req.body?.reason || "Cancellation save offer");
  if (!email) {
    return res.status(400).json({ error: "Missing parent email." });
  }

  const existingFamily = readDb().families.find((item) => item.email === email);
  if (!existingFamily) {
    return res.status(404).json({ error: "Family account not found." });
  }
  if (existingFamily.subscriptionStatus !== "active") {
    return res.status(400).json({ error: "A retention discount can only be applied to an active subscription." });
  }
  if (!process.env.STRIPE_SECRET_KEY || !existingFamily.stripeSubscriptionId || existingFamily.stripeSubscriptionId.startsWith("sub_mock")) {
    if (existingFamily.retentionOffer?.status === "accepted") {
      return res.json({
        mode: existingFamily.retentionOffer.mode || "stored",
        alreadyApplied: true,
        familyId: existingFamily.id,
        couponId: existingFamily.retentionOffer.stripeCouponId || "",
        message: "The 50% save offer is already applied to the next invoice."
      });
    }
    const updated = mutateDb((db) => {
      const family = db.families.find((item) => item.email === email);
      if (!family) return null;
      family.subscriptionStatus = "active";
      family.retentionOffer = {
        status: "accepted",
        mode: "mock",
        percentOff: 50,
        duration: "once",
        appliesTo: "next_invoice",
        reason,
        acceptedAt: nowIso()
      };
      audit(db, "retention.discount.mock", { familyId: family.id, email, reason });
      return family;
    });
    return res.json({
      mode: "mock",
      familyId: updated?.id || existingFamily.id,
      message: "The 50% save offer was recorded. Stripe discount application was simulated."
    });
  }

  try {
    const stripe = stripeClient();
    const couponId = await retentionCouponId(stripe, readDb());
    let subscriptions = await activeStripeSubscriptionsForEmail(stripe, email);
    if (!subscriptions.some((subscription) => subscription.id === existingFamily.stripeSubscriptionId)) {
      const storedSubscription = await stripe.subscriptions.retrieve(existingFamily.stripeSubscriptionId, { expand: ["discount"] });
      if (storedSubscription && ["active", "trialing", "past_due", "unpaid"].includes(storedSubscription.status)) {
        subscriptions.push(storedSubscription);
      }
    }
    subscriptions = subscriptions.filter((subscription, index, list) =>
      list.findIndex((item) => item.id === subscription.id) === index
    );
    if (!subscriptions.length) {
      return res.status(404).json({ error: "No active Stripe subscription found for this parent email." });
    }

    const previousDiscountId = existingFamily.retentionOffer?.stripeDiscountId || "";
    const toUpdate = subscriptions.filter((subscription) => !subscriptionHasCoupon(subscription, couponId, previousDiscountId));
    const updatedSubscriptions = [];
    for (const subscription of toUpdate) {
      updatedSubscriptions.push(await applySubscriptionCoupon(stripe, subscription.id, couponId));
    }

    const updatedById = new Map(updatedSubscriptions.map((subscription) => [subscription.id, subscription]));
    const verifiedSubscriptions = subscriptions.map((subscription) => updatedById.get(subscription.id) || subscription);
    const primarySubscription = verifiedSubscriptions.slice().sort((a, b) => b.created - a.created)[0];
    const appliedSubscriptionIds = verifiedSubscriptions
      .filter((subscription) => subscriptionHasCoupon(subscription, couponId, previousDiscountId))
      .map((subscription) => subscription.id);
    const duplicateSubscriptionIds = subscriptions.map((subscription) => subscription.id).filter((id) => id !== primarySubscription.id);
    const discountId =
      primarySubscription.discount?.id ||
      (Array.isArray(primarySubscription.discounts) ? primarySubscription.discounts[0]?.id || primarySubscription.discounts[0] : "") ||
      previousDiscountId;

    mutateDb((db) => {
      const family = db.families.find((item) => item.email === email);
      if (!family) return null;
      family.subscriptionStatus = "active";
      family.stripeCustomerId = primarySubscription.customer || family.stripeCustomerId;
      family.stripeSubscriptionId = primarySubscription.id || family.stripeSubscriptionId;
      family.stripeDuplicateSubscriptionIds = duplicateSubscriptionIds;
      family.retentionOffer = {
        status: "accepted",
        mode: "stripe",
        percentOff: 50,
        duration: "once",
        appliesTo: "next_invoice",
        reason,
        stripeCouponId: couponId,
        stripeDiscountId: discountId,
        appliedSubscriptionIds,
        duplicateSubscriptionIds,
        acceptedAt: nowIso()
      };
      audit(db, "retention.discount.apply", {
        familyId: family.id,
        email,
        subscriptionIds: appliedSubscriptionIds,
        duplicateSubscriptionIds,
        couponId,
        discountId
      });
      return family;
    });

    return res.json({
      mode: "stripe",
      alreadyApplied: toUpdate.length === 0,
      familyId: existingFamily.id,
      subscriptionId: primarySubscription.id,
      appliedSubscriptionIds,
      duplicateSubscriptionIds,
      couponId,
      discountId,
      message: duplicateSubscriptionIds.length
        ? "The 50% save offer was applied, but multiple active Stripe subscriptions exist for this parent email."
        : toUpdate.length
          ? "The 50% save offer was applied to the next Stripe invoice."
          : "The 50% save offer is already applied to the next invoice."
    });
  } catch (error) {
    mutateDb((db) => monitor(db, "error", "stripe", "Retention discount failed", { email, detail: error.message }, email));
    return res.status(500).json({ error: "Unable to apply the Stripe retention discount." });
  }
});

app.post("/api/stripe/request-cancellation", requireParent, async (req, res) => {
  const email = normalizeEmail(req.auth?.email || req.body?.email || req.body?.parentEmail || "");
  const reason = String(req.body?.reason || "Parent requested cancellation");
  if (!email) return res.status(400).json({ error: "Missing parent email." });

  const existingFamily = readDb().families.find((item) => item.email === email);
  if (!existingFamily) return res.status(404).json({ error: "Family account not found." });
  if (existingFamily.subscriptionStatus !== "active" && existingFamily.subscriptionStatus !== "cancel_scheduled") {
    return res.status(400).json({ error: "Only active subscriptions can be scheduled for cancellation." });
  }

  if (!process.env.STRIPE_SECRET_KEY || !existingFamily.stripeSubscriptionId || existingFamily.stripeSubscriptionId.startsWith("sub_mock")) {
    // End of the CURRENT period: use the known period end, else anchor on the
    // billing start (last payment / account creation) + interval and roll
    // forward to the next boundary — not simply "now + one interval".
    const isYearly = String(existingFamily.plan || "").toLowerCase().includes("year");
    let mockPeriodEnd;
    if (existingFamily.currentPeriodEnd) {
      mockPeriodEnd = new Date(existingFamily.currentPeriodEnd);
    } else {
      mockPeriodEnd = new Date(existingFamily.lastPaymentAt || existingFamily.createdAt || Date.now());
      const advance = () => isYearly ? mockPeriodEnd.setFullYear(mockPeriodEnd.getFullYear() + 1) : mockPeriodEnd.setMonth(mockPeriodEnd.getMonth() + 1);
      advance();
      while (mockPeriodEnd.getTime() <= Date.now()) advance();
    }
    const updated = mutateDb((db) => {
      const family = db.families.find((item) => item.email === email);
      markCancellationScheduled(family, { id: family?.stripeSubscriptionId || "sub_mock_kiddiegpt", current_period_end: Math.floor(mockPeriodEnd.getTime() / 1000) }, reason);
      audit(db, "subscription.cancel_requested.mock", { familyId: family?.id || "", email, reason, accessUntil: family?.cancelAccessUntil || "" }, email);
      return family;
    });
    return res.json({
      mode: "mock",
      familyId: updated?.id || existingFamily.id,
      status: updated?.subscriptionStatus || "cancel_scheduled",
      cancelAccessUntil: updated?.cancelAccessUntil || "",
      message: `Cancellation is scheduled. Extension access remains active until ${updated?.cancelAccessUntil || "the end of the paid period"}.`
    });
  }

  try {
    const stripe = stripeClient();
    const subscription = await scheduleStripeCancellationAtPeriodEnd(stripe, existingFamily.stripeSubscriptionId);
    const updated = mutateDb((db) => {
      const family = db.families.find((item) => item.email === email);
      markCancellationScheduled(family, subscription, reason);
      audit(db, "subscription.cancel_requested", { familyId: family?.id || "", email, subscriptionId: subscription.id, reason, accessUntil: family?.cancelAccessUntil || "" }, email);
      return family;
    });
    return res.json({
      mode: "stripe",
      familyId: updated?.id || existingFamily.id,
      subscriptionId: subscription.id,
      status: updated?.subscriptionStatus || "cancel_scheduled",
      cancelAccessUntil: updated?.cancelAccessUntil || "",
      message: `Cancellation is scheduled. Extension access remains active until ${updated?.cancelAccessUntil || "the end of the paid period"}.`
    });
  } catch (error) {
    mutateDb((db) => monitor(db, "error", "stripe", "Cancellation request failed", { email, detail: error.message, subscriptionId: existingFamily.stripeSubscriptionId }, email));
    return res.status(500).json({ error: "Unable to schedule cancellation with Stripe." });
  }
});

app.post("/api/stripe/upgrade-yearly", async (req, res) => {
  const email = normalizeEmail(req.body?.email || req.body?.parentEmail || "");
  if (email && !isAllowedParentEmail(email)) {
    return res.status(400).json({ error: parentEmailError(email) });
  }
  if (!email) {
    return res.status(400).json({ error: "Missing parent email." });
  }

  const dbSnapshot = readDb();
  const family = dbSnapshot.families.find((item) => item.email === email);
  if (!family) {
    return res.status(404).json({ error: "Family account not found." });
  }
  if (family.subscriptionStatus !== "active") {
    return res.status(400).json({ error: "Yearly upgrade requires an active monthly subscription." });
  }

  const yearlyPlan = dbSnapshot.pricing?.yearly || defaultPricing().yearly;
  const monthlyPlan = dbSnapshot.pricing?.monthly || defaultPricing().monthly;
  const yearlyPriceId = req.body?.yearlyPriceId || yearlyPlan.stripePriceId;
  const upgradeConfig = normalisePricing(dbSnapshot.pricing).yearlyUpgrade;
  const bonusMonths = Number(req.body?.bonusMonths ?? upgradeConfig.bonusMonths ?? process.env.YEARLY_UPGRADE_BONUS_MONTHS ?? 3);
  const upgradeDiscountPercent = Number(upgradeConfig.discountPercent || 0);
  const upgradeNote = String(upgradeConfig.note || "");

  if (!yearlyPriceId) {
    return res.status(400).json({ error: "Missing yearly Stripe Price ID." });
  }

  if (!process.env.STRIPE_SECRET_KEY || !family.stripeSubscriptionId || family.stripeSubscriptionId.startsWith("sub_mock")) {
    // Proration: end the monthly plan and start yearly now. Total access =
    // 12 months + admin bonus months + the days left in the current month.
    const now = Date.now();
    let periodEnd;
    if (family.currentPeriodEnd) {
      periodEnd = new Date(family.currentPeriodEnd);
    } else {
      periodEnd = new Date(family.lastPaymentAt || family.createdAt || now);
      do { periodEnd.setMonth(periodEnd.getMonth() + 1); } while (periodEnd.getTime() <= now);
    }
    const proratedDays = Math.max(0, Math.ceil((periodEnd.getTime() - now) / 86400000));
    const accessMonths = 12 + bonusMonths;
    const accessEnd = new Date(now);
    accessEnd.setMonth(accessEnd.getMonth() + accessMonths);
    accessEnd.setDate(accessEnd.getDate() + proratedDays);
    const effectivePrice = Math.round(Number(yearlyPlan.amount || 0) * (1 - upgradeDiscountPercent / 100) * 100) / 100;
    const accessEndUnix = Math.floor(accessEnd.getTime() / 1000);
    const updated = mutateDb((db) => {
      const next = db.families.find((item) => item.email === email);
      if (!next) return null;
      next.plan = yearlyPlan.label || "Family Yearly";
      next.subscriptionStatus = "active";
      next.paymentStatus = "paid";
      next.lastPaymentAt = nowIso();
      next.currentPeriodEnd = accessEnd.toISOString();
      next.yearlyUpgrade = {
        status: "scheduled",
        mode: "mock",
        billingMode: "immediate_prorated",
        bonusMonths,
        accessMonths,
        proratedDays,
        monthlyEndsAt: Math.floor(periodEnd.getTime() / 1000),
        yearlyNextRenewalAt: accessEndUnix,
        monthlyCancelledAtPeriodEnd: true,
        discountPercent: upgradeDiscountPercent,
        effectivePrice,
        note: upgradeNote,
        acceptedAt: nowIso()
      };
      audit(db, "subscription.upgrade_yearly.mock", { familyId: next.id, email, bonusMonths, proratedDays, accessMonths }, email);
      return next;
    });
    return res.json({
      mode: "mock",
      familyId: updated?.id || family.id,
      plan: yearlyPlan.label || "Family Yearly",
      bonusMonths,
      accessMonths,
      proratedDays,
      yearlyNextRenewalAt: accessEndUnix,
      monthlyEndsAt: Math.floor(periodEnd.getTime() / 1000),
      effectivePrice,
      note: upgradeNote,
      message: `Yearly active now: 12 months + ${bonusMonths} bonus month${bonusMonths === 1 ? "" : "s"} + ${proratedDays} remaining day${proratedDays === 1 ? "" : "s"} from your current month. Next renewal ${accessEnd.toLocaleDateString()}.`
    });
  }

  try {
    const stripe = stripeClient();
    const subscriptions = await activeStripeSubscriptionsForEmail(stripe, email);
    const monthlySubscriptions = subscriptions.filter((subscription) =>
      subscriptionHasInterval(subscription, "month", monthlyPlan.stripePriceId) &&
      subscription.metadata?.upgradeBillingMode !== "immediate_15_month" &&
      !subscription.metadata?.accessMonths
    );
    const yearlySubscriptions = subscriptions.filter((subscription) =>
      subscriptionHasInterval(subscription, "year", yearlyPriceId)
    );
    const immediateUpgradeSubscriptions = subscriptions.filter((subscription) =>
      subscription.metadata?.upgradeBillingMode === "immediate_15_month" ||
      subscription.metadata?.accessMonths === String(12 + bonusMonths)
    );
    const deferredUpgradeSubscriptions = yearlySubscriptions.filter((subscription) =>
      subscription.status === "trialing" &&
      subscription.metadata?.yearlyUpgrade === "true" &&
      subscription.metadata?.upgradeBillingMode !== "immediate_15_month"
    );
    for (const deferred of deferredUpgradeSubscriptions) {
      await stripe.subscriptions.cancel(deferred.id);
    }

    if (immediateUpgradeSubscriptions.length) {
      const existingYearly = immediateUpgradeSubscriptions[0];
      const settledInvoice = await settleStripeInvoice(stripe, existingYearly.latest_invoice);
      const monthlyIds = monthlySubscriptions.map((subscription) => subscription.id);
      const monthlyEndsAt = monthlySubscriptions.length
        ? Math.max(...monthlySubscriptions.map((subscription) => subscription.current_period_end || 0))
        : null;
      for (const monthly of monthlySubscriptions) {
        if (!monthly.cancel_at_period_end) {
          await stripe.subscriptions.update(monthly.id, {
            cancel_at_period_end: true,
            metadata: {
              yearlyUpgrade: "true",
              yearlyUpgradeReplacement: existingYearly.id
            }
          });
        }
      }
      mutateDb((db) => {
        const next = db.families.find((item) => item.email === email);
        if (!next) return null;
        next.plan = yearlyPlan.label || "Family Yearly";
        next.stripeSubscriptionId = existingYearly.id;
        next.stripeCustomerId = existingYearly.customer || next.stripeCustomerId;
        next.yearlyUpgrade = {
          status: "scheduled",
          mode: "stripe",
          alreadyScheduled: true,
          billingMode: "immediate_15_month",
          bonusMonths,
          accessMonths: Number(existingYearly.metadata?.accessMonths || 12 + bonusMonths),
          monthlySubscriptionIds: monthlyIds,
          yearlySubscriptionId: existingYearly.id,
          yearlyScheduleId: stripeId(existingYearly.schedule),
          yearlyNextRenewalAt: existingYearly.current_period_end || null,
          monthlyEndsAt,
          chargedAt: settledInvoice?.status === "paid" ? nowIso() : next.yearlyUpgrade?.chargedAt || "",
          acceptedAt: nowIso()
        };
        if (settledInvoice && Number(settledInvoice.amount_paid || 0) > 0) {
          recordStripePayment(db, { id: `upgrade_${settledInvoice.id}`, type: "invoice.paid" }, settledInvoice, next);
        }
        audit(db, "subscription.upgrade_yearly.exists", { familyId: next.id, email, yearlySubscriptionId: existingYearly.id, monthlySubscriptionIds: monthlyIds });
        return next;
      });
      return res.json({
        mode: "stripe",
        alreadyScheduled: true,
        plan: yearlyPlan.label || "Family Yearly",
        bonusMonths,
        accessMonths: Number(existingYearly.metadata?.accessMonths || 12 + bonusMonths),
        yearlySubscriptionId: existingYearly.id,
        yearlyScheduleId: stripeId(existingYearly.schedule),
        monthlySubscriptionIds: monthlyIds,
        monthlyEndsAt,
        yearlyNextRenewalAt: existingYearly.current_period_end || null,
        paymentStatus: settledInvoice?.status || existingYearly.latest_invoice?.status || "",
        message: "Yearly has already been charged and the next renewal is set after the bonus period."
      });
    }

    if (!monthlySubscriptions.length) {
      return res.status(404).json({ error: "No active monthly Stripe subscription found for this parent email." });
    }

    const primaryMonthly = monthlySubscriptions.slice().sort((a, b) => b.current_period_end - a.current_period_end)[0];
    const monthlyEndsAt = Math.max(...monthlySubscriptions.map((subscription) => subscription.current_period_end || primaryMonthly.current_period_end));
    const defaultPaymentMethod =
      primaryMonthly.default_payment_method ||
      primaryMonthly.default_source ||
      undefined;

    for (const monthly of monthlySubscriptions) {
      await stripe.subscriptions.update(monthly.id, {
        cancel_at_period_end: true,
        metadata: {
          yearlyUpgrade: "true",
          yearlyUpgradeBonusMonths: String(bonusMonths)
        }
      });
    }

    const monthlyIds = monthlySubscriptions.map((subscription) => subscription.id);
    const yearlySchedule = await createImmediateYearlyUpgradeSchedule(stripe, {
      customerId: primaryMonthly.customer,
      yearlyPriceId,
      defaultPaymentMethod,
      email,
      bonusMonths,
      monthlySubscriptionIds: monthlyIds
    });
    const yearlySubscription = yearlySchedule.subscription && typeof yearlySchedule.subscription === "object" ? yearlySchedule.subscription : null;
    if (!yearlySubscription) {
      throw new Error("Stripe did not return the yearly upgrade subscription.");
    }
    const latestInvoice = yearlySubscription.latest_invoice && typeof yearlySubscription.latest_invoice === "object"
      ? yearlySubscription.latest_invoice
      : null;
    const settledInvoice = await settleStripeInvoice(stripe, latestInvoice);

    mutateDb((db) => {
      const next = db.families.find((item) => item.email === email);
      if (!next) return null;
      next.plan = yearlyPlan.label || "Family Yearly";
      next.subscriptionStatus = "active";
      next.paymentStatus = "paid";
      next.stripeCustomerId = primaryMonthly.customer || next.stripeCustomerId;
      next.stripeSubscriptionId = yearlySubscription.id;
      next.stripePreviousMonthlySubscriptionIds = monthlyIds;
      next.yearlyUpgrade = {
        status: "scheduled",
        mode: "stripe",
        billingMode: "immediate_15_month",
        bonusMonths,
        accessMonths: 12 + bonusMonths,
        monthlySubscriptionIds: monthlyIds,
        yearlySubscriptionId: yearlySubscription.id,
        yearlyScheduleId: yearlySchedule.id,
        yearlyNextRenewalAt: yearlySubscription.current_period_end || yearlySchedule.current_phase?.end_date || null,
        monthlyEndsAt,
        chargedAt: settledInvoice?.status === "paid" ? nowIso() : "",
        acceptedAt: nowIso()
      };
      if (settledInvoice && Number(settledInvoice.amount_paid || 0) > 0) {
        recordStripePayment(db, { id: `upgrade_${settledInvoice.id}`, type: "invoice.paid" }, settledInvoice, next);
      }
      audit(db, "subscription.upgrade_yearly", {
        familyId: next.id,
        email,
        monthlySubscriptionIds: monthlyIds,
        yearlySubscriptionId: yearlySubscription.id,
        yearlyScheduleId: yearlySchedule.id,
        bonusMonths,
        accessMonths: 12 + bonusMonths,
        nextRenewalAt: yearlySubscription.current_period_end || yearlySchedule.current_phase?.end_date || null
      });
      return next;
    });

    return res.json({
      mode: "stripe",
      plan: yearlyPlan.label || "Family Yearly",
      bonusMonths,
      accessMonths: 12 + bonusMonths,
      monthlySubscriptionIds: monthlyIds,
      yearlySubscriptionId: yearlySubscription.id,
      yearlyScheduleId: yearlySchedule.id,
      yearlyNextRenewalAt: yearlySubscription.current_period_end || yearlySchedule.current_phase?.end_date || null,
      monthlyEndsAt,
      paymentStatus: settledInvoice?.status || "",
      message: `Yearly is charged now and includes ${12 + bonusMonths} months before the next renewal. Monthly renewal is cancelled at period end.`
    });
  } catch (error) {
    mutateDb((db) => monitor(db, "error", "stripe", "Yearly upgrade failed", { email, detail: error.message }, email));
    return res.status(500).json({ error: "Unable to upgrade this family to yearly billing." });
  }
});

app.post("/api/dev/test-email", async (req, res) => {
  try {
    return res.json(await sendAndLogEmail(req.body || {}));
  } catch (error) {
    mutateDb((db) => monitor(db, "error", "email", "Test email failed", { detail: error.message, to: req.body?.to || "" }));
    return res.status(500).json({ error: "Unable to send test email.", detail: error.message });
  }
});

app.post("/api/dev/stripe/bootstrap-prices", requireAdmin, async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(400).json({ error: "Stripe secret key is not configured." });
  }
  try {
    const dbSnapshot = readDb();
    const pricing = dbSnapshot.pricing || defaultPricing();
    const stripe = stripeClient();
    const product = await stripe.products.create({
      name: "KiddieGPT Family Plan",
      metadata: { app: "KiddieGPT", environment: stripeMode() }
    });
    const monthlyAmount = Math.round(Number(pricing.monthly?.amount || 19) * 100);
    const yearlyAmount = Math.round(Number(pricing.yearly?.amount || 149) * 100);
    const monthly = await stripe.prices.create({
      product: product.id,
      currency: "usd",
      unit_amount: monthlyAmount,
      recurring: { interval: "month" },
      nickname: "KiddieGPT monthly",
      metadata: { app: "KiddieGPT", plan: "monthly" }
    });
    const yearly = await stripe.prices.create({
      product: product.id,
      currency: "usd",
      unit_amount: yearlyAmount,
      recurring: { interval: "year" },
      nickname: "KiddieGPT yearly",
      metadata: { app: "KiddieGPT", plan: "yearly" }
    });
    const updated = mutateDb((db) => {
      db.pricing = db.pricing || defaultPricing();
      db.pricing.monthly = { ...(db.pricing.monthly || defaultPricing().monthly), stripePriceId: monthly.id };
      db.pricing.yearly = { ...(db.pricing.yearly || defaultPricing().yearly), stripePriceId: yearly.id };
      audit(db, "stripe.prices.bootstrap", { productId: product.id, monthlyPriceId: monthly.id, yearlyPriceId: yearly.id }, req.auth?.email || "admin");
      monitor(db, "info", "stripe", "Stripe test prices created", { productId: product.id, monthlyPriceId: monthly.id, yearlyPriceId: yearly.id }, req.auth?.email || "admin");
      return db.pricing;
    });
    res.json({
      ok: true,
      mode: stripeMode(),
      productId: product.id,
      monthlyPriceId: monthly.id,
      yearlyPriceId: yearly.id,
      pricing: updated
    });
  } catch (error) {
    mutateDb((db) => monitor(db, "error", "stripe", "Stripe price bootstrap failed", { detail: error.message, code: error.code || "", requestId: error.requestId || "" }, req.auth?.email || "admin"));
    res.status(500).json({ error: "Unable to create Stripe test prices.", detail: error.message, stripeCode: error.code || "", stripeRequestId: error.requestId || "" });
  }
});

async function sendAndLogEmail(input) {
  const result = await sendEmail(input);
  mutateDb((db) => {
    db.emailLogs.unshift({ id: makeId("eml"), ...result, template: input.template || "", createdAt: nowIso() });
    audit(db, "email.send", { to: result.to, template: input.template || "" });
  });
  return result;
}

app.post("/api/admin/trigger-email", requireAdmin, async (req, res) => {
  try {
    return res.json(await sendAndLogEmail(req.body || {}));
  } catch (error) {
    mutateDb((db) => monitor(db, "error", "email", "Admin email trigger failed", { detail: error.message, to: req.body?.to || "" }, req.auth?.email || "admin"));
    return res.status(500).json({ error: "Unable to trigger email.", detail: error.message });
  }
});

app.post("/api/admin/subscription-action", requireAdmin, async (req, res) => {
  const { action, subscriptionId, email } = req.body || {};
  const allowed = new Set(["pause", "cancel"]);
  if (!allowed.has(action)) {
    return res.status(400).json({ error: "Unsupported subscription action." });
  }

  if (!process.env.STRIPE_SECRET_KEY || !subscriptionId || subscriptionId.startsWith("sub_mock")) {
    const updated = mutateDb((db) => {
      const family = db.families.find((item) => item.email === String(email || "").toLowerCase());
      if (family) {
        if (action === "pause") family.subscriptionStatus = "paused";
        else {
          const mockPeriodEnd = new Date();
          mockPeriodEnd.setMonth(mockPeriodEnd.getMonth() + (String(family.plan || "").toLowerCase().includes("year") ? 12 : 1));
          markCancellationScheduled(family, { id: subscriptionId || "sub_mock_kiddiegpt", current_period_end: Math.floor(mockPeriodEnd.getTime() / 1000) }, "Admin scheduled cancellation");
        }
      }
      audit(db, `subscription.${action}.mock`, { subscriptionId, email });
      return family;
    });
    return res.json({
      mode: "mock",
      action,
      subscriptionId: subscriptionId || "sub_mock_kiddiegpt",
      email,
      family: updated,
      message: `${action} subscription was simulated.`
    });
  }

  try {
    const stripe = stripeClient();
    const subscription = action === "pause"
      ? await stripe.subscriptions.update(subscriptionId, { pause_collection: { behavior: "void" } })
      : await scheduleStripeCancellationAtPeriodEnd(stripe, subscriptionId);
    mutateDb((db) => {
      const family = db.families.find((item) => item.stripeSubscriptionId === subscriptionId || item.email === String(email || "").toLowerCase());
      if (family) {
        if (action === "pause") family.subscriptionStatus = "paused";
        else markCancellationScheduled(family, subscription, "Admin scheduled cancellation");
      }
      audit(db, `subscription.${action}`, { subscriptionId, email });
    });
    return res.json({ mode: "stripe", action, subscriptionId: subscription.id, status: subscription.status });
  } catch (error) {
    return res.status(500).json({ error: "Unable to update Stripe subscription." });
  }
});

app.post("/api/stripe/refund", requireAdmin, async (req, res) => {
  const { paymentIntentId, amountCents, email } = req.body || {};
  if (!paymentIntentId) {
    return res.status(400).json({ error: "Missing Stripe payment intent ID." });
  }

  if (!process.env.STRIPE_SECRET_KEY || paymentIntentId.startsWith("pi_mock")) {
    const result = {
      mode: "mock",
      refundId: "re_mock_kiddiegpt",
      paymentIntentId,
      email,
      message: "Refund was simulated."
    };
    mutateDb((db) => {
      const family = db.families.find((item) => item.email === String(email || "").toLowerCase() || item.stripePaymentId === paymentIntentId);
      if (family) {
        family.paymentStatus = "refunded";
        family.refundedAt = nowIso();
        markSubscriptionEndedNow(family, "Payment refunded", family.stripeSubscriptionId || family.cancellationSubscriptionId || "");
      }
      audit(db, "refund.mock", { paymentIntentId, email, amountCents });
    });
    return res.json(result);
  }

  try {
    const stripe = stripeClient();
    let resolvedPaymentId = String(paymentIntentId);
    const refundParams = {
      amount: amountCents ? Number(amountCents) : undefined
    };
    if (resolvedPaymentId.startsWith("cs_")) {
      const session = await stripe.checkout.sessions.retrieve(resolvedPaymentId, { expand: ["subscription.latest_invoice.payment_intent", "payment_intent"] });
      resolvedPaymentId = await checkoutSessionPaymentIntentId(stripe, session);
    } else if (resolvedPaymentId.startsWith("in_")) {
      const invoice = await stripe.invoices.retrieve(resolvedPaymentId, { expand: ["payment_intent"] });
      resolvedPaymentId = stripeId(invoice.payment_intent);
    }
    if (resolvedPaymentId.startsWith("pi_")) {
      refundParams.payment_intent = resolvedPaymentId;
    } else if (resolvedPaymentId.startsWith("ch_")) {
      refundParams.charge = resolvedPaymentId;
    } else {
      return res.status(400).json({ error: "This payment does not have a refundable Stripe PaymentIntent yet. Refresh the payment from Stripe and try again." });
    }

    const refund = await stripe.refunds.create(refundParams);
    const preRefundDb = readDb();
    const preSourcePayment = preRefundDb.payments.find((payment) => payment.paymentId === paymentIntentId || payment.paymentId === resolvedPaymentId);
    const preFamily = preRefundDb.families.find((item) =>
      item.email === String(email || "").toLowerCase() ||
      item.stripePaymentId === paymentIntentId ||
      item.stripePaymentId === resolvedPaymentId ||
      (preSourcePayment?.familyId && item.id === preSourcePayment.familyId)
    );
    const refundAmount = Number(refund.amount || amountCents || 0);
    const fullRefund = preSourcePayment?.amountCents
      ? refundAmount >= Number(preSourcePayment.amountCents)
      : true;
    const stripeCancellationResult = fullRefund ? await cancelStripeSubscriptionsNow(stripe, preFamily) : [];
    mutateDb((db) => {
      const sourcePayment = db.payments.find((payment) => payment.paymentId === paymentIntentId || payment.paymentId === resolvedPaymentId);
      const family = db.families.find((item) =>
        item.email === String(email || "").toLowerCase() ||
        item.stripePaymentId === paymentIntentId ||
        item.stripePaymentId === resolvedPaymentId ||
        (sourcePayment?.familyId && item.id === sourcePayment.familyId)
      );
      const refundStatus = sourcePayment?.amountCents && refundAmount > 0 && refundAmount < Number(sourcePayment.amountCents)
        ? "partial_refunded"
        : "refunded";
      if (sourcePayment) {
        sourcePayment.status = refundStatus;
        sourcePayment.refundId = refund.id;
        sourcePayment.refundedAt = nowIso();
      }
      if (family) {
        family.paymentStatus = refundStatus;
        family.refundedAt = nowIso();
        family.stripePaymentId = resolvedPaymentId;
        family.refunds = Array.isArray(family.refunds) ? family.refunds : [];
        family.refunds.unshift({ refundId: refund.id, paymentId: resolvedPaymentId, amountCents: refundAmount, status: refund.status, createdAt: nowIso() });
        if (refundStatus === "refunded") {
          markSubscriptionEndedNow(family, "Payment refunded", effectiveFamilySubscriptionId(family) || family.stripeSubscriptionId || "");
        }
      }
      audit(db, "refund.create", { paymentIntentId, resolvedPaymentId, email, refundId: refund.id, amountCents: refundAmount, fullRefund, stripeCancellationResult });
    });
    return res.json({ mode: "stripe", refundId: refund.id, paymentIntentId: resolvedPaymentId, status: refund.status, subscriptionEnded: fullRefund, stripeCancellationResult });
  } catch (error) {
    return res.status(500).json({ error: "Unable to create Stripe refund." });
  }
});

app.post("/api/admin/billing-exception", requireAdmin, async (req, res) => {
  const action = String(req.body?.action || "");
  const email = String(req.body?.email || req.body?.parentEmail || "").toLowerCase();
  const familyId = req.body?.familyId || "";
  const reason = String(req.body?.reason || "Admin exception");
  const allowed = new Set([
    "partial_refund",
    "credit_next_invoice",
    "add_free_months",
    "apply_discount",
    "discount_next_renewal",
    "pause_billing",
    "cancel_period_end",
    "extend_access",
    "send_save_email"
  ]);

  if (!allowed.has(action)) return res.status(400).json({ error: "Unsupported billing exception." });

  const dbSnapshot = readDb();
  const family = dbSnapshot.families.find((item) =>
    (familyId && item.id === familyId) || (email && item.email === email)
  );
  if (!family) return res.status(404).json({ error: "Family account not found." });

  const result = {
    mode: process.env.STRIPE_SECRET_KEY ? "stripe" : "mock",
    action,
    familyId: family.id,
    email: family.email,
    reason
  };

  try {
    const stripe = stripeClient();

    if (action === "partial_refund") {
      const paymentIntentId = req.body?.paymentIntentId || family.stripePaymentId || "";
      const amountCents = Math.max(1, Number(req.body?.amountCents || 1000));
      if (stripe && paymentIntentId && !paymentIntentId.startsWith("pi_mock")) {
        const refund = await stripe.refunds.create({ payment_intent: paymentIntentId, amount: amountCents });
        result.refundId = refund.id;
        result.status = refund.status;
      } else {
        result.mode = "mock";
        result.refundId = "re_mock_exception";
        result.status = "succeeded";
      }
      mutateDb((db) => {
        const next = db.families.find((item) => item.id === family.id);
        if (!next) return null;
        next.paymentStatus = "partial_refunded";
        next.partialRefundedAt = nowIso();
        next.billingExceptions = next.billingExceptions || [];
        next.billingExceptions.unshift({ action, amountCents, reason, resultId: result.refundId, createdAt: nowIso() });
        audit(db, "billing_exception.partial_refund", { familyId: next.id, email: next.email, amountCents, refundId: result.refundId, reason });
        return next;
      });
      result.amountCents = amountCents;
      result.message = `Partial refund of $${(amountCents / 100).toFixed(2)} recorded.`;
      return res.json(result);
    }

    if (action === "credit_next_invoice") {
      const creditCents = Math.max(1, Number(req.body?.creditCents || 1500));
      if (stripe && family.stripeCustomerId) {
        const transaction = await stripe.customers.createBalanceTransaction(family.stripeCustomerId, {
          amount: -creditCents,
          currency: "usd",
          description: `KiddieGPT admin credit: ${reason}`,
          metadata: { app: "KiddieGPT", familyId: family.id, reason }
        });
        result.balanceTransactionId = transaction.id;
      } else {
        result.mode = "mock";
        result.balanceTransactionId = "cbtxn_mock_exception";
      }
      mutateDb((db) => {
        const next = db.families.find((item) => item.id === family.id);
        if (!next) return null;
        next.billingCreditCents = Number(next.billingCreditCents || 0) + creditCents;
        next.billingExceptions = next.billingExceptions || [];
        next.billingExceptions.unshift({ action, creditCents, reason, resultId: result.balanceTransactionId, createdAt: nowIso() });
        audit(db, "billing_exception.credit_next_invoice", { familyId: next.id, email: next.email, creditCents, balanceTransactionId: result.balanceTransactionId, reason });
        return next;
      });
      result.creditCents = creditCents;
      result.message = `$${(creditCents / 100).toFixed(2)} credit added to next invoice.`;
      return res.json(result);
    }

    if (action === "add_free_months" || action === "extend_access") {
      const months = action === "add_free_months" ? Math.max(1, Number(req.body?.months || 1)) : 0;
      const days = action === "extend_access" ? Math.max(1, Number(req.body?.days || 14)) : 0;
      let until = action === "add_free_months"
        ? addMonthsIso(family.entitlementOverrideUntil, months)
        : addDaysIso(family.entitlementOverrideUntil, days);
      const planAmountDollars = family.plan === dbSnapshot?.pricing?.yearly?.label
        ? Number(dbSnapshot.pricing.yearly.amount || 0) / 12
        : Number(dbSnapshot.pricing?.monthly?.amount || defaultPricing().monthly.amount);
      const freeMonthCreditCents = action === "add_free_months" ? Math.round(planAmountDollars * months * 100) : 0;

      if (stripe && family.stripeSubscriptionId && !family.stripeSubscriptionId.startsWith("sub_mock")) {
        await stripe.subscriptions.update(family.stripeSubscriptionId, {
          metadata: {
            adminAccessOverrideUntil: until,
            adminAccessOverrideReason: reason
          }
        });
        if (action === "add_free_months" && family.stripeCustomerId && freeMonthCreditCents > 0) {
          const transaction = await stripe.customers.createBalanceTransaction(family.stripeCustomerId, {
            amount: -freeMonthCreditCents,
            currency: "usd",
            description: `KiddieGPT ${months} free month${months === 1 ? "" : "s"}: ${reason}`,
            metadata: { app: "KiddieGPT", familyId: family.id, reason, months: String(months) }
          });
          result.balanceTransactionId = transaction.id;
        }
      } else {
        result.mode = "mock";
      }

      mutateDb((db) => {
        const next = db.families.find((item) => item.id === family.id);
        if (!next) return null;
        until = action === "add_free_months"
          ? addMonthsIso(next.entitlementOverrideUntil, months)
          : addDaysIso(next.entitlementOverrideUntil, days);
        next.entitlementOverrideUntil = until;
        next.entitlementOverrideReason = reason;
        if (freeMonthCreditCents) next.billingCreditCents = Number(next.billingCreditCents || 0) + freeMonthCreditCents;
        next.billingExceptions = next.billingExceptions || [];
        next.billingExceptions.unshift({ action, months, days, until, creditCents: freeMonthCreditCents, resultId: result.balanceTransactionId || "", reason, createdAt: nowIso() });
        audit(db, `billing_exception.${action}`, { familyId: next.id, email: next.email, months, days, until, creditCents: freeMonthCreditCents, balanceTransactionId: result.balanceTransactionId || "", reason });
        return next;
      });
      result.overrideUntil = until;
      result.creditCents = freeMonthCreditCents;
      result.message = action === "add_free_months"
        ? `${months} free month${months === 1 ? "" : "s"} added with a $${(freeMonthCreditCents / 100).toFixed(2)} invoice credit.`
        : `Access extended until ${until}.`;
      return res.json(result);
    }

    if (action === "apply_discount") {
      const percentOff = Math.min(100, Math.max(1, Number(req.body?.percentOff || 50)));
      if (!stripe || !family.stripeSubscriptionId || family.stripeSubscriptionId.startsWith("sub_mock")) {
        mutateDb((db) => {
          const next = db.families.find((item) => item.id === family.id);
          if (!next) return null;
          next.billingExceptions = next.billingExceptions || [];
          next.billingExceptions.unshift({ action, percentOff, reason, createdAt: nowIso(), mode: "mock" });
          audit(db, "billing_exception.discount.mock", { familyId: next.id, email: next.email, percentOff, reason });
          return next;
        });
        return res.json({ ...result, mode: "mock", percentOff, message: `${percentOff}% next-invoice discount simulated.` });
      }
      const coupon = await stripe.coupons.create({
        percent_off: percentOff,
        duration: "once",
        name: `KiddieGPT admin ${percentOff}% save`,
        metadata: { app: "KiddieGPT", familyId: family.id, reason }
      });
      const subscriptions = await activeStripeSubscriptionsForEmail(stripe, family.email);
      const updated = [];
      for (const subscription of subscriptions) {
        updated.push(await applySubscriptionCoupon(stripe, subscription.id, coupon.id));
      }
      mutateDb((db) => {
        const next = db.families.find((item) => item.id === family.id);
        if (!next) return null;
        next.billingExceptions = next.billingExceptions || [];
        next.billingExceptions.unshift({ action, percentOff, couponId: coupon.id, subscriptionIds: updated.map((subscription) => subscription.id), reason, createdAt: nowIso() });
        audit(db, "billing_exception.discount", { familyId: next.id, email: next.email, percentOff, couponId: coupon.id, subscriptionIds: updated.map((subscription) => subscription.id), reason });
        return next;
      });
      result.percentOff = percentOff;
      result.couponId = coupon.id;
      result.subscriptionIds = updated.map((subscription) => subscription.id);
      result.message = `${percentOff}% discount applied to the next invoice.`;
      return res.json(result);
    }

    if (action === "discount_next_renewal") {
      // Fixed $ off the next renewal. Stripe: a one-time amount_off coupon on the
      // subscription auto-applies to the next invoice.
      const amountCents = Math.max(50, Math.round(Number(req.body?.amountCents || 1000)));
      const dollars = (amountCents / 100).toFixed(2);
      if (!stripe || !family.stripeSubscriptionId || family.stripeSubscriptionId.startsWith("sub_mock")) {
        mutateDb((db) => {
          const next = db.families.find((item) => item.id === family.id);
          if (!next) return null;
          next.nextRenewalDiscountCents = amountCents;
          next.billingExceptions = next.billingExceptions || [];
          next.billingExceptions.unshift({ action, amountCents, reason, createdAt: nowIso(), mode: "mock" });
          audit(db, "billing_exception.next_renewal_discount.mock", { familyId: next.id, email: next.email, amountCents, reason });
          monitor(db, "info", "billing", "Next-renewal discount applied", { email: next.email, amountCents, reason }, req.auth?.email || "admin");
          return next;
        });
        return res.json({ ...result, mode: "mock", amountCents, message: `$${dollars} off the next renewal (simulated — applies on next Stripe invoice in production).` });
      }
      const coupon = await stripe.coupons.create({
        amount_off: amountCents,
        currency: "usd",
        duration: "once",
        name: `KiddieGPT admin $${dollars} save`,
        metadata: { app: "KiddieGPT", familyId: family.id, reason }
      });
      const subscriptions = await activeStripeSubscriptionsForEmail(stripe, family.email);
      const updated = [];
      for (const subscription of subscriptions) {
        updated.push(await applySubscriptionCoupon(stripe, subscription.id, coupon.id));
      }
      mutateDb((db) => {
        const next = db.families.find((item) => item.id === family.id);
        if (!next) return null;
        next.nextRenewalDiscountCents = amountCents;
        next.billingExceptions = next.billingExceptions || [];
        next.billingExceptions.unshift({ action, amountCents, couponId: coupon.id, subscriptionIds: updated.map((s) => s.id), reason, createdAt: nowIso() });
        audit(db, "billing_exception.next_renewal_discount", { familyId: next.id, email: next.email, amountCents, couponId: coupon.id, reason });
        monitor(db, "info", "billing", "Next-renewal discount applied", { email: next.email, amountCents, couponId: coupon.id }, req.auth?.email || "admin");
        return next;
      });
      result.amountCents = amountCents;
      result.couponId = coupon.id;
      result.subscriptionIds = updated.map((s) => s.id);
      result.message = `$${dollars} discount applied to the next renewal.`;
      return res.json(result);
    }

    if (action === "pause_billing" || action === "cancel_period_end") {
      const subscriptionId = family.stripeSubscriptionId || req.body?.subscriptionId || "";
      if (stripe && subscriptionId && !subscriptionId.startsWith("sub_mock")) {
        const subscription = action === "pause_billing"
          ? await stripe.subscriptions.update(subscriptionId, { pause_collection: { behavior: "void" } })
          : await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
        result.subscriptionId = subscription.id;
        result.status = subscription.status;
      } else {
        result.mode = "mock";
        result.subscriptionId = subscriptionId || "sub_mock_exception";
      }
      mutateDb((db) => {
        const next = db.families.find((item) => item.id === family.id);
        if (!next) return null;
        next.subscriptionStatus = action === "pause_billing" ? "paused" : "cancelled";
        next[action === "pause_billing" ? "pausedAt" : "cancelledAt"] = nowIso();
        next.billingExceptions = next.billingExceptions || [];
        next.billingExceptions.unshift({ action, subscriptionId: result.subscriptionId, reason, createdAt: nowIso() });
        audit(db, `billing_exception.${action}`, { familyId: next.id, email: next.email, subscriptionId: result.subscriptionId, reason });
        return next;
      });
      result.message = action === "pause_billing" ? "Billing paused and logged." : "Cancellation at period end scheduled and logged.";
      return res.json(result);
    }

    if (action === "send_save_email") {
      const emailResult = await sendAndLogEmail({
        to: family.email,
        template: "Admin save exception",
        message: req.body?.message || `Hi ${family.parentName}, I made a billing adjustment on your KiddieGPT account. Thanks for giving us the chance to make this right.`
      });
      mutateDb((db) => {
        const next = db.families.find((item) => item.id === family.id);
        if (!next) return null;
        next.billingExceptions = next.billingExceptions || [];
        next.billingExceptions.unshift({ action, reason, resultId: emailResult.messageId || emailResult.mode, createdAt: nowIso() });
        audit(db, "billing_exception.email", { familyId: next.id, email: next.email, reason });
        return next;
      });
      return res.json({ ...result, email: emailResult, message: "Save email sent or simulated." });
    }

    return res.status(400).json({ error: "Unhandled billing exception." });
  } catch (error) {
    return res.status(500).json({ error: "Unable to apply billing exception.", detail: error.message });
  }
});

app.post("/api/dev/test-login", (req, res) => {
  const { role, email, password } = req.body || {};
  const requestedRole = role || "parent";
  const normalizedEmail = normalizeEmail(email);
  if (requestedRole === "parent" && !isAllowedParentEmail(normalizedEmail)) {
    return res.status(400).json({ ok: false, role: requestedRole, error: parentEmailError(normalizedEmail) });
  }
  const db = readDb();
  let user = db.users.find((item) => item.email === normalizedEmail && item.role === requestedRole);
  if (!user && requestedRole === "parent") {
    const family = db.families.find((item) => item.email === normalizedEmail);
    if (family) {
      user = {
        id: family.id,
        role: "parent",
        name: family.parentName,
        email: family.email,
        passwordHash: hashPassword(process.env.PARENT_TEST_PASSWORD || "kiddiegpt123")
      };
    }
  }
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ ok: false, role: requestedRole, error: "Invalid credentials." });
  }
  return res.json({
    ok: true,
    role: requestedRole,
    token: signToken({ sub: user.id, role: user.role, email: user.email }),
    message: `${requestedRole} login succeeded with backend auth.`
  });
});

app.get(["/", "/index.html", "/onboarding"], (req, res) => {
  res.sendFile(path.join(publicDir, "webapp", "index.html"));
});

app.get(["/admin", "/admin.html"], (req, res) => {
  res.sendFile(path.join(publicDir, "webapp", "admin.html"));
});

app.use(express.static(publicDir, {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
  }
}));

ensureDb();

// ---- Autopilot engine ------------------------------------------------------
function defaultAutopilotRules() {
  return {
    dunningSuspendDays: DUNNING_SUSPEND_DAYS,
    convertNudgeDays: [1, 3, 7],       // nudge unconverted signups on these days
    winbackAfterDays: 14,               // days after cancel to send a win-back
    weeklySummaryEnabled: true,
    autoRefundMaxCents: 0,              // 0 = never auto-refund; always escalate
    autoRefundWithinDays: 14
  };
}

function readAutopilotRules(db) {
  const defaults = defaultAutopilotRules();
  const raw = (db && db.autopilotRules) || {};
  return {
    dunningSuspendDays: Math.max(1, Number(raw.dunningSuspendDays) || defaults.dunningSuspendDays),
    convertNudgeDays: Array.isArray(raw.convertNudgeDays) && raw.convertNudgeDays.length ? raw.convertNudgeDays.map(Number).filter(Number.isFinite).sort((a, b) => a - b) : defaults.convertNudgeDays,
    winbackAfterDays: Math.max(1, Number(raw.winbackAfterDays) || defaults.winbackAfterDays),
    weeklySummaryEnabled: raw.weeklySummaryEnabled !== false,
    autoRefundMaxCents: Math.max(0, Number(raw.autoRefundMaxCents) || 0),
    autoRefundWithinDays: Math.max(0, Number(raw.autoRefundWithinDays) || defaults.autoRefundWithinDays)
  };
}

function convertNudgeMessage(stage) {
  return stage >= 2
    ? "Your KiddieGPT account is ready, but there's no active plan yet. Choose a plan to unlock your child's tutor tools."
    : "Welcome to KiddieGPT! Finish setup by choosing a family plan to unlock the learning tools.";
}

function winbackMessage() {
  return "We'd love to have your family back on KiddieGPT. Reactivate any time to restore your child's tools — their profiles and goals are still saved.";
}

function weeklySummaryMessage(family) {
  const lines = (Array.isArray(family.children) ? family.children : []).map((child) => {
    const week = usageWindow(child, 7);
    return `${child.studentName || "Your child"}: ${week.math} math problems, ${week.voiceMinutes} min tutor voice, active ${week.activeDays} day(s).`;
  });
  return `Here's ${family.parentName || "your family"}'s KiddieGPT week:\n${lines.length ? lines.join("\n") : "No activity this week — a quick session keeps the streak going!"}`;
}

// Stripe reconciliation: pull each subscription's real status and correct any
// local drift from missed/out-of-order webhooks. No-op when Stripe isn't set up.
async function reconcileWithStripe() {
  const stripe = stripeClient();
  if (!stripe) return { reconciled: 0, skipped: "no_stripe" };
  const targets = (readDb().families || [])
    .filter((family) => family.stripeSubscriptionId && !family.anonymizedAt)
    .slice(0, 100);
  const observed = [];
  for (const family of targets) {
    try {
      const sub = await stripe.subscriptions.retrieve(family.stripeSubscriptionId);
      observed.push({ id: family.id, status: sub.status });
    } catch (error) {
      observed.push({ id: family.id, status: error?.code === "resource_missing" ? "canceled" : "" });
    }
  }
  return mutateDb((db) => {
    let reconciled = 0;
    observed.forEach((obs) => {
      const family = db.families.find((item) => item.id === obs.id);
      if (!family || !obs.status) return;
      const stripeActive = obs.status === "active" || obs.status === "trialing";
      const stripeCanceled = obs.status === "canceled" || obs.status === "incomplete_expired";
      if (stripeCanceled && !["cancelled", "deleted"].includes(family.subscriptionStatus)) {
        family.subscriptionStatus = "cancelled";
        family.cancellationStatus = "completed";
        family.cancelledAt = family.cancelledAt || nowIso();
        reconciled += 1;
        audit(db, "reconcile.cancel", { familyId: family.id }, "autopilot");
      } else if (stripeActive && ["cancelled", "past_due"].includes(family.subscriptionStatus) && !family.deletionRequestedAt) {
        family.subscriptionStatus = "active";
        family.paymentStatus = "paid";
        clearDunning(family);
        reconciled += 1;
        audit(db, "reconcile.reactivate", { familyId: family.id }, "autopilot");
      } else if ((obs.status === "past_due" || obs.status === "unpaid") && !family.dunning) {
        startDunning(db, family);
        reconciled += 1;
      }
    });
    if (reconciled) monitor(db, "info", "autopilot", "Stripe reconciliation corrected drift", { reconciled });
    return { reconciled };
  });
}

function dunningReminderMessage(stage) {
  if (stage <= 1) {
    return "We couldn't process your KiddieGPT payment. Please update your card so your child keeps access. It only takes a minute.";
  }
  return `Reminder ${stage}: your KiddieGPT payment is still failing. Update your card soon to avoid an interruption to your child's learning tools.`;
}

function dunningSuspendMessage() {
  return "Your KiddieGPT access has been paused because we couldn't collect payment. Update your card any time to restore your child's tools right away.";
}

async function sendLifecycleEmail(family, template, message) {
  if (!family || !isAllowedParentEmail(family.email)) return null;
  try {
    const result = await sendEmail({ to: family.email, template, message });
    mutateDb((db) => {
      db.emailLogs.unshift({ id: makeId("eml"), ...result, template, familyId: family.id, automated: true, createdAt: nowIso() });
    });
    return result;
  } catch (error) {
    mutateDb((db) => monitor(db, "error", "email", "Lifecycle email failed", { template, email: family.email, detail: String(error.message || error) }, family.email));
    return null;
  }
}

// Time-based automation. Reconciles with Stripe, advances dunning, self-heals
// lapsed cancellations, and sends convert-nudge / win-back / weekly-summary
// emails — all idempotent via per-family stage/timestamp tracking.
const SWEEP_EMAIL_CAP = 300; // safety cap on emails sent per sweep
async function runLifecycleSweep(trigger = "cron") {
  let reconciled = 0;
  try {
    reconciled = (await reconcileWithStripe()).reconciled || 0;
  } catch (error) {
    mutateDb((db) => monitor(db, "error", "autopilot", "Stripe reconciliation failed", { detail: String(error.message || error) }));
  }
  const emailsToSend = [];
  const queueEmail = (family, template, message) => {
    if (emailsToSend.length < SWEEP_EMAIL_CAP) emailsToSend.push({ family: { id: family.id, email: family.email }, template, message });
  };
  const summary = mutateDb((db) => {
    const now = Date.now();
    const rules = readAutopilotRules(db);
    const daysBetween = (iso) => Math.floor((now - new Date(iso || now).getTime()) / 86400000);
    let remindersSent = 0;
    let suspended = 0;
    let cancelsFinalised = 0;
    let nudged = 0;
    let winbacks = 0;
    let summaries = 0;
    (db.families || []).forEach((family) => {
      if (family.anonymizedAt || family.deletionRequestedAt) return;

      // --- Dunning ---
      if (family.dunning && family.dunning.failedAt) {
        const daysSince = daysBetween(family.dunning.failedAt);
        if (daysSince >= rules.dunningSuspendDays && !family.dunning.suspendedAt) {
          family.subscriptionStatus = "past_due";
          family.accountLocked = true;
          family.dunning.suspendedAt = nowIso();
          suspended += 1;
          audit(db, "dunning.suspend", { familyId: family.id, email: family.email }, "autopilot");
          monitor(db, "warning", "billing", "Auto-suspended after failed payments", { email: family.email, daysSince }, family.email);
          queueEmail(family, "Payment failed", dunningSuspendMessage());
        } else if (!family.dunning.suspendedAt) {
          const remindersDue = DUNNING_REMINDER_DAYS.filter((d) => daysSince >= d).length;
          if (remindersDue > (family.dunning.stage || 0)) {
            family.dunning.stage = remindersDue;
            family.dunning.lastEmailAt = nowIso();
            remindersSent += 1;
            audit(db, "dunning.reminder", { familyId: family.id, email: family.email, stage: remindersDue }, "autopilot");
            queueEmail(family, "Payment failed", dunningReminderMessage(remindersDue));
          }
        }
      }

      // --- Cancellation grace self-heal ---
      if (family.subscriptionStatus === "cancel_scheduled") {
        const until = new Date(family.cancelAccessUntil || family.cancellationAccessUntil || 0).getTime();
        if (until && now > until) {
          family.subscriptionStatus = "cancelled";
          family.cancellationStatus = "completed";
          family.cancelledAt = family.cancelledAt || nowIso();
          cancelsFinalised += 1;
          audit(db, "cancellation.finalise", { familyId: family.id, email: family.email }, "autopilot");
        }
      }

      // --- Convert nudge (signed up, never activated) ---
      if (["pending", ""].includes(family.subscriptionStatus || "") && !family.accountLocked) {
        const due = rules.convertNudgeDays.filter((d) => daysBetween(family.createdAt) >= d).length;
        if (due > (family.convertNudgeStage || 0)) {
          family.convertNudgeStage = due;
          nudged += 1;
          queueEmail(family, "Trial rescue", convertNudgeMessage(due));
        }
      }

      // --- Win-back (cancelled a while ago, once) ---
      if (family.subscriptionStatus === "cancelled" && !family.winbackSentAt) {
        const cancelledMs = new Date(family.cancelledAt || family.cancelAccessUntil || 0).getTime();
        if (cancelledMs && now - cancelledMs >= rules.winbackAfterDays * 86400000) {
          family.winbackSentAt = nowIso();
          winbacks += 1;
          queueEmail(family, "Trial rescue", winbackMessage());
        }
      }

      // --- Weekly progress summary (active, opted-in) ---
      const active = family.subscriptionStatus === "active" || cancellationStillActive(family);
      if (rules.weeklySummaryEnabled && active && !family.accountLocked && normaliseParentControls(family.controls).weeklySummary !== false) {
        const lastMs = new Date(family.lastWeeklySummaryAt || family.createdAt || 0).getTime();
        if (lastMs && now - lastMs >= 7 * 86400000) {
          family.lastWeeklySummaryAt = nowIso();
          summaries += 1;
          queueEmail(family, "Weekly progress", weeklySummaryMessage(family));
        }
      }
    });
    monitor(db, "info", "autopilot", "Lifecycle sweep ran", { trigger, reconciled, remindersSent, suspended, cancelsFinalised, nudged, winbacks, summaries });
    return { trigger, reconciled, remindersSent, suspended, cancelsFinalised, nudged, winbacks, summaries, emailsQueued: emailsToSend.length };
  });
  for (const item of emailsToSend) {
    await sendLifecycleEmail(item.family, item.template, item.message);
  }
  return summary;
}

// Start/clear dunning on a family record (called from the webhook mutation).
function startDunning(db, family) {
  if (!family.dunning || !family.dunning.failedAt) {
    family.dunning = { failedAt: nowIso(), stage: 0 };
    monitor(db, "warning", "billing", "Payment failed — dunning started", { email: family.email }, family.email);
  }
}

function clearDunning(family) {
  if (family.dunning) {
    // If dunning had auto-suspended access, restore it now that payment cleared.
    if (family.dunning.suspendedAt) family.accountLocked = false;
    delete family.dunning;
  }
}

app.get("/api/admin/autopilot-rules", requireAdmin, (req, res) => {
  res.json({ rules: readAutopilotRules(readDb()) });
});

app.put("/api/admin/autopilot-rules", requireAdmin, (req, res) => {
  const body = req.body || {};
  const rules = mutateDb((db) => {
    const current = readAutopilotRules(db);
    db.autopilotRules = {
      ...current,
      ...(Object.prototype.hasOwnProperty.call(body, "dunningSuspendDays") ? { dunningSuspendDays: Math.max(1, Number(body.dunningSuspendDays) || current.dunningSuspendDays) } : {}),
      ...(Array.isArray(body.convertNudgeDays) ? { convertNudgeDays: body.convertNudgeDays.map(Number).filter(Number.isFinite) } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "winbackAfterDays") ? { winbackAfterDays: Math.max(1, Number(body.winbackAfterDays) || current.winbackAfterDays) } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "weeklySummaryEnabled") ? { weeklySummaryEnabled: body.weeklySummaryEnabled !== false } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "autoRefundMaxCents") ? { autoRefundMaxCents: Math.max(0, Number(body.autoRefundMaxCents) || 0) } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "autoRefundWithinDays") ? { autoRefundWithinDays: Math.max(0, Number(body.autoRefundWithinDays) || current.autoRefundWithinDays) } : {})
    };
    audit(db, "autopilot.rules.update", { rules: db.autopilotRules }, req.auth?.email || "admin");
    return readAutopilotRules(db);
  });
  res.json({ ok: true, rules });
});

// Exceptions queue: only the items that genuinely need a human decision.
app.get("/api/admin/action-queue", requireAdmin, (req, res) => {
  const db = readDb();
  const now = Date.now();
  const items = [];
  (db.families || []).forEach((family) => {
    if (family.anonymizedAt) return;
    const base = { familyId: family.id, email: family.email, parentName: family.parentName || "" };
    if (family.deletionRequestedAt && !family.deletionCompletedAt) {
      items.push({ ...base, priority: 1, category: "deletion", title: "Account deletion requested", detail: "Review and anonymize or restore.", since: family.deletionRequestedAt });
    }
    if (family.dunning && family.dunning.suspendedAt) {
      items.push({ ...base, priority: 1, category: "payment_suspended", title: "Access suspended for non-payment", detail: "Reach out, comp, or cancel.", since: family.dunning.suspendedAt });
    } else if (family.dunning && family.dunning.failedAt) {
      items.push({ ...base, priority: 2, category: "dunning", title: "Payment failing (dunning in progress)", detail: `Reminder stage ${family.dunning.stage || 0}. Auto-suspends if unpaid.`, since: family.dunning.failedAt });
    }
    if (family.paymentStatus === "refunded" || family.paymentStatus === "partial_refunded") {
      items.push({ ...base, priority: 3, category: "refund", title: "Refund on record", detail: "Confirm resolution / watch for dispute.", since: family.refundedAt || family.updatedAt || "" });
    }
    if (family.subscriptionStatus === "cancel_scheduled") {
      items.push({ ...base, priority: 3, category: "cancel_scheduled", title: "Cancellation scheduled", detail: "Optional save outreach before access ends.", since: family.cancelAccessUntil || "" });
    }
  });
  items.sort((a, b) => a.priority - b.priority || new Date(a.since || 0) - new Date(b.since || 0));
  res.json({ count: items.length, generatedAt: new Date(now).toISOString(), items });
});

app.post("/api/admin/run-sweep", requireAdmin, async (req, res) => {
  const summary = await runLifecycleSweep("manual");
  res.json({ ok: true, ...summary });
});

// Serverless hosts (Vercel) have no long-lived process, so the lifecycle sweep
// runs via a scheduled Cron hit to this endpoint instead of setInterval. Guard
// it with CRON_SECRET (sent by Vercel Cron as an Authorization: Bearer header).
app.all("/api/cron/sweep", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const provided = (req.get("authorization") || "").replace(/^Bearer\s+/i, "") ||
      req.get("x-cron-secret") || req.query.secret || "";
    if (provided !== secret) return res.status(401).json({ error: "unauthorized" });
  }
  try {
    const summary = await runLifecycleSweep("cron");
    await flushPending();
    res.json({ ok: true, ...summary });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Start a long-lived server only when run directly (local/Docker). When the file
// is imported by the serverless entry (api/index.js), we export the app instead
// and let the platform invoke it per request.
async function startServer() {
  await initPersistence();
  app.listen(port, () => {
    console.log(`KiddieGPT portal listening on ${port}`);
    console.log(`KiddieGPT persistence: ${DB_DRIVER === "postgres" ? "postgres" : dbPath}`);
    if (AUTOPILOT_ENABLED) {
      runLifecycleSweep("startup").catch((error) => console.error("Sweep failed:", error.message));
      setInterval(() => {
        runLifecycleSweep("cron").catch((error) => console.error("Sweep failed:", error.message));
      }, Math.max(5, SWEEP_INTERVAL_MINUTES) * 60000);
      console.log(`Autopilot on — lifecycle sweep every ${SWEEP_INTERVAL_MINUTES} min`);
    }
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("Startup failed:", error.message);
    process.exit(1);
  });
}

module.exports = { app, initPersistence, flushPending, runLifecycleSweep };
