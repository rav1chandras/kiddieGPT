const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const path = require("path");
const Stripe = require("stripe");
const nodemailer = require("nodemailer");

const app = express();
const port = process.env.PORT || 80;
// This module lives in lib/, so the project root (which holds webapp/ and data/)
// is one level up. It must stay out of the project root: Vercel auto-detects a
// root-level .js entrypoint and rejects this module for exporting an object
// rather than a handler ("The default export must be a function or server").
const projectRoot = path.join(__dirname, "..");
const publicDir = projectRoot;
const dataDir = process.env.DATA_DIR || path.join(projectRoot, "data");
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
// ---- AI request bounds ------------------------------------------------------
// The extension's own caps are cosmetic: maxlength is a DOM attribute and any
// client value can be forged, so the ceiling has to be enforced here. Counts
// TEXT only — base64 image payloads (QR capture) are exempt or screenshots break.
const AI_MAX_INPUT_CHARS = Number(process.env.AI_MAX_INPUT_CHARS || 8000);
const AI_MAX_OUTPUT_TOKENS = Number(process.env.AI_MAX_OUTPUT_TOKENS || 2000);
// OpenAI's TTS endpoint rejects >4096 characters, so stay just under it.
const TTS_MAX_INPUT_CHARS = Number(process.env.TTS_MAX_INPUT_CHARS || 4000);

// Sum the text an OpenAI Responses `input` carries, ignoring image parts.
function aiInputTextLength(input) {
  if (typeof input === "string") return input.length;
  if (Array.isArray(input)) {
    return input.reduce((sum, item) => {
      if (typeof item === "string") return sum + item.length;
      if (item && typeof item === "object") {
        if (typeof item.text === "string") return sum + item.text.length;
        if (Array.isArray(item.content)) return sum + aiInputTextLength(item.content);
      }
      return sum;
    }, 0);
  }
  if (input && typeof input === "object" && Array.isArray(input.content)) return aiInputTextLength(input.content);
  return 0;
}
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
      enabled: true,
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
      discountAmount: 0,    // dollars off the yearly price for upgraders
      note: ""              // e.g. "July 4th sale — limited time"
    },
    cancellationPromo: {
      enabled: true,
      amountOff: 0,
      duration: "once",
      description: "Keep your plan and save on the next renewal."
    }
  };
}

// Discounts used to be stored as percentages. An install that upgrades with a
// percentage still in its DB would read `amountOff` as 0 and silently stop
// discounting, so convert the legacy field against the plan price on read. A
// save then writes the dollar shape and the old field stops being consulted.
function legacyAmountOff(amount, legacyPercent, planAmount) {
  const dollars = Math.max(0, Number(amount) || 0);
  if (dollars > 0) return dollars;
  const percent = Math.max(0, Math.min(100, Number(legacyPercent) || 0));
  const base = Math.max(0, Number(planAmount) || 0);
  if (percent <= 0 || base <= 0) return 0;
  return Math.round(base * percent) / 100;
}

function normalisePricing(pricing = {}) {
  const defaults = defaultPricing();
  const monthly = { ...defaults.monthly, ...(pricing.monthly || {}) };
  const yearly = { ...defaults.yearly, ...(pricing.yearly || {}) };
  const rawPromotion = pricing.promotion || {};
  const promotion = { ...defaults.promotion, ...rawPromotion };
  const hasMonthlyAmount = Object.prototype.hasOwnProperty.call(rawPromotion, "monthlyAmount");
  const hasYearlyAmount = Object.prototype.hasOwnProperty.call(rawPromotion, "yearlyAmount");
  const hasLegacyPrice = Object.prototype.hasOwnProperty.call(rawPromotion, "price") && rawPromotion.price !== "";
  const legacyPlanKey = rawPromotion.planKey === "yearly" ? "yearly" : "monthly";
  // Keep old one-plan records readable, but retain independent override prices
  // once both fields are present. The admin form writes both fields on every save.
  if (!hasMonthlyAmount && !hasYearlyAmount && hasLegacyPrice) {
    promotion.monthlyAmount = legacyPlanKey === "monthly" ? Number(rawPromotion.price || 0) : 0;
    promotion.yearlyAmount = legacyPlanKey === "yearly" ? Number(rawPromotion.price || 0) : 0;
  } else {
    promotion.monthlyAmount = hasMonthlyAmount ? Number(rawPromotion.monthlyAmount || 0) : Number(promotion.monthlyAmount || 0);
    promotion.yearlyAmount = hasYearlyAmount ? Number(rawPromotion.yearlyAmount || 0) : Number(promotion.yearlyAmount || 0);
  }
  // `price` and `planKey` remain as compatibility fields for older clients.
  promotion.planKey = promotion.planKey === "yearly" ? "yearly" : "monthly";
  promotion.price = promotion.planKey === "yearly" ? promotion.yearlyAmount : promotion.monthlyAmount;
  if (Number(promotion.monthlyAmount || 0) <= 0 && Number(promotion.yearlyAmount || 0) > 0) promotion.planKey = "yearly";
  promotion.enabled = promotion.enabled !== false;
  // Each plan carries its own code. Records written before the split have a
  // single `code`, which seeds both so an existing promotion keeps working.
  promotion.monthlyCode = String(rawPromotion.monthlyCode || rawPromotion.code || "").trim();
  promotion.yearlyCode = String(rawPromotion.yearlyCode || rawPromotion.code || "").trim();
  promotion.code = promotion.monthlyCode || promotion.yearlyCode;
  delete promotion.discountPercent;
  delete promotion.endDate;
  const rawUpgrade = pricing.yearlyUpgrade || {};
  const yearlyUpgrade = {
    bonusMonths: Math.max(0, Math.round(Number(rawUpgrade.bonusMonths ?? defaults.yearlyUpgrade.bonusMonths) || 0)),
    discountAmount: legacyAmountOff(rawUpgrade.discountAmount, rawUpgrade.discountPercent, yearly.amount),
    note: String(rawUpgrade.note || "")
  };
  const rawCancellationPromo = pricing.cancellationPromo || {};
  const cancellationPromo = {
    enabled: rawCancellationPromo.enabled !== false,
    amountOff: legacyAmountOff(rawCancellationPromo.amountOff, rawCancellationPromo.percentOff, monthly.amount),
    duration: rawCancellationPromo.duration === "repeating" ? "repeating" : "once",
    description: String(rawCancellationPromo.description || defaults.cancellationPromo.description),
    stripeCouponId: String(rawCancellationPromo.stripeCouponId || ""),
    stripeCouponPercentOff: Number(rawCancellationPromo.stripeCouponPercentOff || 0)
  };
  return {
    monthly,
    yearly,
    promotion,
    yearlyUpgrade,
    cancellationPromo
  };
}

// ---- Tutor voice (TTS) --------------------------------------------------
// Text-model routing (openaiModel) is SEPARATE from the tutor voice below.
// The TTS model is pinned to gpt-4o-mini-tts for now; admins control which
// voices are available and which is the default. Students pick from the
// admin-approved shortlist in the extension.
const TTS_MODEL = "gpt-4o-mini-tts";
const SUPPORTED_TTS_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"];
// Preferred order for middle school; also the non-empty fallback shortlist.
const PREFERRED_TTS_VOICES = ["marin", "cedar", "sage"];
const TTS_INSTRUCTION = "Speak like a calm, supportive middle-school tutor. Soothing, clear, steady pace, warm but not childish. Add gentle pauses between ideas. Keep energy relaxed and reassuring.";

// Speech models the admin may choose from (A/B testing without an extension
// release). Anything outside this list falls back to the default TTS_MODEL.
const SUPPORTED_TTS_MODELS = ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"];

// Grade bands supported across the product. 9-12 is a real, selectable band
// (the extension UI has the tab and math already handles it).
const GRADE_BANDS = ["K-2", "3-5", "6-8", "9-12"];

// Spoken-word budget per narration minute — converts the admin's max-minutes
// knob into a hard word cap for Explain narration.
const WORDS_PER_MINUTE = 150;

// Bump when SPEECH_STYLES changes so the extension's audio cache invalidates.
const SPEECH_STYLE_VERSION = "v2";

// Per-band Explain length model. The admin-set number is the DEEP DIVE max words
// for that band (also the hard ceiling — nothing exceeds it). Standard mode is a
// fraction of that (tutorStandardFraction). Deep Dive is offered for the bands in
// DEEP_DIVE_BANDS only; K-2 is always Standard.
const DEFAULT_EXPLAIN_MAX_WORDS = {
  "K-2": 160,
  "3-5": 400,
  "6-8": 700,
  "9-12": 1000
};
const DEFAULT_STANDARD_FRACTION = 0.5;
const DEEP_DIVE_BANDS = ["3-5", "6-8", "9-12"];

// Spoken-style presets by tutor mode + grade band. Resolved server-side in the
// speech proxy so the client can never inject arbitrary TTS instructions.
const SPEECH_STYLES = {
  read: {
    "K-2": "Read gently, clearly, and slightly slowly. Pause between ideas.",
    "3-5": "Read clearly at a comfortable pace with a warm tone.",
    "6-8": "Read naturally, clearly, and confidently.",
    "9-12": "Read naturally and fluently, like a clear audiobook narrator, at a normal pace."
  },
  explain: {
    "K-2": "Sound warm and playful. Speak slowly with clear pauses, like reading to a young child.",
    "3-5": "Sound like a patient elementary teacher. Emphasize key ideas and keep a warm, encouraging pace.",
    "6-8": "Speak like a calm, supportive middle-school tutor. Soothing, clear, steady pace, warm but not childish.",
    "9-12": "Sound like a knowledgeable, respectful high-school teacher. Concise and direct; do not over-simplify or sound childish."
  }
};

function normaliseGradeBand(band) {
  const b = String(band || "").trim();
  return GRADE_BANDS.includes(b) ? b : "6-8";
}

// The instruction spoken by the TTS model, chosen by tutor mode + grade band.
function resolveSpeechInstruction(mode, gradeBand) {
  const m = mode === "read" ? "read" : "explain";
  const band = normaliseGradeBand(gradeBand);
  return (SPEECH_STYLES[m] && SPEECH_STYLES[m][band]) || TTS_INSTRUCTION;
}

function normaliseTtsModel(requested) {
  const model = String(requested || "").trim();
  return SUPPORTED_TTS_MODELS.includes(model) ? model : TTS_MODEL;
}

// Clamp/validate the per-band Deep Dive max words. Missing bands fall back to
// defaults; sane bounds keep a misconfigured value from running up TTS cost.
function normaliseMaxWords(raw) {
  const out = {};
  for (const band of GRADE_BANDS) {
    let n = Math.round(Number(raw && raw[band]));
    if (!Number.isFinite(n) || n <= 0) n = DEFAULT_EXPLAIN_MAX_WORDS[band];
    out[band] = Math.min(Math.max(40, n), 4000);
  }
  return out;
}

// Standard mode is this fraction of the band's Deep Dive max. Clamped 0.3..0.9.
function normaliseStandardFraction(value) {
  const f = Number(value);
  if (!Number.isFinite(f)) return DEFAULT_STANDARD_FRACTION;
  return Math.min(0.9, Math.max(0.3, f));
}

// Effective hard word cap for a lesson given band + depth. Deep Dive (non-K-2)
// = the full band max; Standard (and all of K-2) = fraction of the band max.
function effectiveExplainMaxWords(settings, gradeBand, depth) {
  const band = normaliseGradeBand(gradeBand);
  const maxWords = settings.tutorExplainMaxWords || DEFAULT_EXPLAIN_MAX_WORDS;
  const bandMax = maxWords[band] || DEFAULT_EXPLAIN_MAX_WORDS[band];
  const isDeep = depth === "deep" && DEEP_DIVE_BANDS.includes(band);
  const fraction = Number(settings.tutorStandardFraction) || DEFAULT_STANDARD_FRACTION;
  return isDeep ? bandMax : Math.round(bandMax * fraction);
}

function countWords(value) {
  return String(value || "").trim().split(/\s+/).filter(Boolean).length;
}

function splitSentences(value) {
  return String(value || "").split(/(?<=[.!?])\s+/).filter(Boolean);
}

// Trim narration to <= maxWords, ending on a sentence boundary where possible.
function clampNarrationWords(value, maxWords) {
  if (countWords(value) <= maxWords) return value;
  const sentences = splitSentences(value);
  let out = "";
  let words = 0;
  for (const sentence of sentences) {
    const w = countWords(sentence);
    if (words + w > maxWords) break;
    out = out ? `${out} ${sentence}` : sentence;
    words += w;
  }
  if (!out) {
    // First sentence alone exceeds the cap — hard-cut on a word boundary.
    out = String(value || "").trim().split(/\s+/).slice(0, maxWords).join(" ");
  }
  return out.trim();
}

// Short version token over the tutor length config; folded into the extension's
// transcript cache key so admin edits auto-invalidate stale transcripts.
function tutorConfigVersion(maxWords, fraction) {
  const payload = JSON.stringify({ maxWords, fraction });
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 12);
}

// Keep only supported, de-duped voices; never allow an empty list.
function normaliseAllowedVoices(list) {
  const filtered = (Array.isArray(list) ? list : []).filter((v) => SUPPORTED_TTS_VOICES.includes(v));
  const unique = [...new Set(filtered)];
  return unique.length ? unique : [...PREFERRED_TTS_VOICES];
}

// If the default isn't in the allowed list, fall back to the first preferred
// voice that is allowed (marin -> cedar -> sage), else the first allowed voice.
function normaliseDefaultVoice(requested, allowed) {
  if (requested && allowed.includes(requested)) return requested;
  return PREFERRED_TTS_VOICES.find((v) => allowed.includes(v)) || allowed[0];
}

// Resolve the voice for a TTS call: student pick if allowed, else admin
// default, else fallback order (marin -> cedar -> sage), else first allowed.
function resolveTtsVoice(requested, settings) {
  const allowed = normaliseAllowedVoices(settings.ttsAllowedVoices);
  if (requested && allowed.includes(requested)) return requested;
  const def = normaliseDefaultVoice(settings.ttsDefaultVoice, allowed);
  if (def) return def;
  return PREFERRED_TTS_VOICES.find((v) => allowed.includes(v)) || allowed[0] || "marin";
}

function defaultAiSettings() {
  return {
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    openaiModel: process.env.OPENAI_MODEL || "gpt-5.6-luna",
    mathProblemsPerUserDaily: 20,
    tutorVoiceMinutesPerUserDaily: 10,
    // Account-wide daily token ceiling across every child and every tool. The
    // per-child math/voice caps only bound those two tools, so writing and
    // follow-up chat were previously unlimited. 0 = no ceiling.
    tokensPerFamilyDaily: 60000,
    tutorVoiceEnabled: true,
    ttsModel: TTS_MODEL,
    ttsDefaultVoice: "marin",
    ttsAllowedVoices: [...PREFERRED_TTS_VOICES],
    tutorExplainMaxWords: { ...DEFAULT_EXPLAIN_MAX_WORDS },
    tutorStandardFraction: DEFAULT_STANDARD_FRACTION,
    updatedAt: "",
    updatedBy: ""
  };
}

function normaliseAiSettings(settings = {}) {
  const defaults = defaultAiSettings();
  const ttsAllowedVoices = normaliseAllowedVoices(settings.ttsAllowedVoices ?? defaults.ttsAllowedVoices);
  const ttsDefaultVoice = normaliseDefaultVoice(String(settings.ttsDefaultVoice || defaults.ttsDefaultVoice || ""), ttsAllowedVoices);
  const tutorExplainMaxWords = normaliseMaxWords(settings.tutorExplainMaxWords ?? defaults.tutorExplainMaxWords);
  const tutorStandardFraction = normaliseStandardFraction(settings.tutorStandardFraction ?? defaults.tutorStandardFraction);
  return {
    ...defaults,
    ...settings,
    openaiApiKey: typeof settings.openaiApiKey === "string" ? settings.openaiApiKey : defaults.openaiApiKey,
    openaiModel: String(settings.openaiModel || defaults.openaiModel || "gpt-5.6-luna"),
    mathProblemsPerUserDaily: Math.max(0, Number(settings.mathProblemsPerUserDaily ?? defaults.mathProblemsPerUserDaily) || 0),
    tutorVoiceMinutesPerUserDaily: Math.max(0, Number(settings.tutorVoiceMinutesPerUserDaily ?? defaults.tutorVoiceMinutesPerUserDaily) || 0),
    tokensPerFamilyDaily: Math.max(0, Number(settings.tokensPerFamilyDaily ?? defaults.tokensPerFamilyDaily) || 0),
    tutorVoiceEnabled: settings.tutorVoiceEnabled !== false,
    // Speech model is admin-configurable, validated against SUPPORTED_TTS_MODELS.
    ttsModel: normaliseTtsModel(settings.ttsModel),
    ttsAllowedVoices,
    ttsDefaultVoice,
    tutorExplainMaxWords,
    tutorStandardFraction,
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
    tokensPerFamilyDaily: normalised.tokensPerFamilyDaily,
    tutorVoiceEnabled: normalised.tutorVoiceEnabled,
    ttsModel: normalised.ttsModel,
    supportedTtsModels: SUPPORTED_TTS_MODELS,
    ttsDefaultVoice: normalised.ttsDefaultVoice,
    ttsAllowedVoices: normalised.ttsAllowedVoices,
    supportedTtsVoices: SUPPORTED_TTS_VOICES,
    tutorExplainMaxWords: normalised.tutorExplainMaxWords,
    tutorStandardFraction: normalised.tutorStandardFraction,
    deepDiveBands: DEEP_DIVE_BANDS,
    wordsPerMinute: WORDS_PER_MINUTE,
    speechStyleVersion: SPEECH_STYLE_VERSION,
    tutorConfigVersion: tutorConfigVersion(normalised.tutorExplainMaxWords, normalised.tutorStandardFraction),
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
  const code = String((key === "yearly" ? promo.yearlyCode : promo.monthlyCode) || promo.code || "").trim();
  const promoPrice = Number((key === "yearly" ? promo.yearlyAmount : promo.monthlyAmount) || 0);
  const basePrice = Number(plan?.amount || 0);
  if (!plan || promo.enabled === false || !code || !promoPrice || !basePrice || promoPrice >= basePrice) return null;
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

// Chrome Web Store reviewer account: the only email that ever gets its sign-in
// code back in the API response (shown on-screen since the reviewer has no inbox).
const REVIEW_EMAIL = normalizeEmail(process.env.REVIEW_EMAIL || process.env.PARENT_TEST_EMAIL || "parent.kiddiegpt@gmail.com");

function parentAccountExists(db, email) {
  return db.users.some((u) => u.email === email && u.role === "parent")
    || db.families.some((f) => f.email === email);
}

function isAllowedParentEmail(email) {
  return allowedParentEmailDomains.includes(emailDomain(email));
}

function parentEmailError(email) {
  const supported = "Supported email providers: Gmail, Yahoo, AOL, Outlook, and Hotmail.";
  if (!normalizeEmail(email)) return `Email is required. ${supported}`;
  return supported;
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
  // Keep the local parent demo usable even if its seeded family was removed
  // while testing account deletion/anonymization. The fixture is intentionally
  // scoped to PARENT_TEST_EMAIL; real parent accounts are never recreated here.
  let demoParentFamily = db.families.find((family) => family.email === parentEmail);
  if (!demoParentFamily && parentEmail === REVIEW_EMAIL && !process.env.VERCEL && !String(process.env.STRIPE_SECRET_KEY || "").startsWith("sk_live")) {
    const fixture = normaliseFamily({
      ...demoFamilies()[0],
      id: "fam_demo_parent",
      parentName: "Demo Parent",
      email: parentEmail,
      loginType: "Email"
    });
    db.families.unshift(fixture);
    demoParentFamily = fixture;
    changed = true;
  }
  const demoParentUser = db.users.find((user) => user.role === "parent" && user.email === parentEmail);
  if (demoParentUser && demoParentFamily && demoParentUser.familyId !== demoParentFamily.id) {
    demoParentUser.familyId = demoParentFamily.id;
    changed = true;
  }
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
  db.captureSessions = db.captureSessions || [];
  db.emailSettings = db.emailSettings || {};
  db.mockCheckouts = db.mockCheckouts || [];
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
  // Login type is shown to the operator, so it names the credential actually
  // used: "Google" for OAuth, "Email" for password/OTP. "Parent" was the old
  // catch-all and carries no information — fold it into Email.
  next.loginType = next.loginType && next.loginType !== "Parent" ? next.loginType : "Email";
  next.trialEndsAt = next.trialEndsAt || "";
  next.trialDays = Math.max(0, Number(next.trialDays) || 0);
  next.trialStartedAt = next.trialStartedAt || "";
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
      age: next.age || "",
      grade: next.grade,
      readingLevel: next.readingLevel,
      goal: next.goal,
      reward: next.reward,
      learningGoals: next.learningGoals || []
    }];
  }
  const primary = next.children[0] || {};
  next.studentName = next.studentName || primary.studentName || "";
  next.age = next.age || primary.age || "";
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
  // An existing bucket written before `tools` was tracked (or by a partial write)
  // has no tools map, and bucket.tools[tool] below would throw — failing the whole
  // AI call with a 502 after OpenAI had already been paid for.
  bucket.tools = bucket.tools || {};
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

// ---- Abuse signals ----------------------------------------------------------
// Three things a normal student never trips: exhausting the account-wide token
// ceiling, sending an oversized prompt (only possible by bypassing the client's
// caps), and tripping moderation. Counted per family so the operator can see who
// to look at, and dismissible once reviewed.
function recordAbuseSignal(db, familyId, kind) {
  const fam = (db.families || []).find((item) => item.id === familyId);
  if (!fam) return;
  fam.abuse = { capHits: 0, oversized: 0, moderation: 0, lastAt: "", dismissedAt: "", ...(fam.abuse || {}) };
  if (kind === "cap") fam.abuse.capHits += 1;
  else if (kind === "oversized") fam.abuse.oversized += 1;
  else if (kind === "moderation") fam.abuse.moderation += 1;
  fam.abuse.lastAt = nowIso();
}

// Flagged while there are signals newer than the operator's last dismissal.
function abuseFlagged(family) {
  const abuse = family?.abuse;
  if (!abuse || !abuse.lastAt) return false;
  if (!abuse.dismissedAt) return true;
  return new Date(abuse.lastAt).getTime() > new Date(abuse.dismissedAt).getTime();
}

// Tokens the whole account has spent today, summed across every child.
function familyTokensToday(family) {
  const day = usageDayKey();
  return (family?.children || []).reduce((sum, child) => {
    const bucket = ((child.usage || {}).daily || {})[day] || {};
    return sum + (Number(bucket.tokens) || 0);
  }, 0);
}

// Account-wide daily token ceiling. Unlike the per-child math/voice caps this
// covers every tool — including writing and follow-up chat, which had no limit
// at all — and every child, so adding children cannot multiply the spend.
// A cap of 0 means unlimited.
function familyTokenBudget(family, settings) {
  const cap = Math.max(0, Number(settings.tokensPerFamilyDaily) || 0);
  const used = familyTokensToday(family);
  return { cap, used, remaining: cap ? Math.max(0, cap - used) : Infinity, exhausted: cap > 0 && used >= cap };
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
  const pricing = normalisePricing(db.pricing);
  const promo = pricing.cancellationPromo || defaultPricing().cancellationPromo;
  const envConfigured = process.env.STRIPE_RETENTION_COUPON_ID || "";
  const configured = envConfigured || promo.stripeCouponId || db.pricing?.promotion?.retentionCouponId;
  const configuredAmount = Number(promo.stripeCouponAmountOff || 0);
  if (envConfigured || (configured && configuredAmount === Number(promo.amountOff || 0))) return configured;

  const coupon = await stripe.coupons.create({
    amount_off: Math.round(Number(promo.amountOff || 0) * 100),
    currency: "usd",
    duration: promo.duration === "repeating" ? "repeating" : "once",
    ...(promo.duration === "repeating" ? { duration_in_months: 1 } : {}),
    name: "KiddieGPT cancellation save offer",
    metadata: {
      app: "KiddieGPT",
      offer: "cancellation_promo",
      amountOff: String(promo.amountOff || 0)
    }
  });

  mutateDb((nextDb) => {
    nextDb.pricing = nextDb.pricing || defaultPricing();
    nextDb.pricing.cancellationPromo = nextDb.pricing.cancellationPromo || {};
    nextDb.pricing.cancellationPromo.stripeCouponId = coupon.id;
    nextDb.pricing.cancellationPromo.stripeCouponAmountOff = Number(promo.amountOff || 0);
    audit(nextDb, "stripe.cancellation_promo_coupon.create", { couponId: coupon.id, amountOff: Number(promo.amountOff || 0) });
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

// Accepts either a unix-seconds timestamp or a date string and normalises to
// ISO. Anything that does not parse comes back empty rather than "Invalid Date".
function isoDateOrEmpty(value) {
  if (!value) return "";
  if (typeof value === "number" || /^\d+$/.test(String(value).trim())) return unixToIso(value);
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function cancellationStillActive(family) {
  if (family?.subscriptionStatus !== "cancel_scheduled") return false;
  const accessUntil = new Date(family.cancelAccessUntil || family.cancellationAccessUntil || 0).getTime();
  return Number.isFinite(accessUntil) && accessUntil > Date.now();
}

// Refund policy (monthly and yearly alike): cancelling within REFUND_WINDOW_DAYS
// of the most recent payment is a full refund and access ends immediately.
// After that there is no refund — access runs to the end of the paid period and
// simply does not renew. The window re-opens on every payment (each renewal).
const REFUND_WINDOW_DAYS = Math.max(0, Number(process.env.REFUND_WINDOW_DAYS || 3));

// ---- Stripe card-upfront free trial ----------------------------------------
// Self-serve signups get a card-upfront trial: Stripe collects the card at
// Checkout, bills nothing for TRIAL_PERIOD_DAYS, then charges automatically
// unless the parent cancels. Distinct from the admin-granted no-card trial,
// which carries subscriptionStatus "trial"; a Stripe trial is "trialing", so
// the local sweep that expires no-card trials never touches one Stripe owns.
const TRIAL_PERIOD_DAYS = Math.max(0, Number(process.env.TRIAL_PERIOD_DAYS || 7));
// How many days before a trial ends to warn the parent that billing starts.
const TRIAL_ENDING_NOTICE_DAYS = Math.max(1, Number(process.env.TRIAL_ENDING_NOTICE_DAYS || 2));

// Map a Stripe subscription status onto ours. Stripe is the source of truth for
// anything it bills, so this is a direct translation rather than a judgement.
function statusFromStripeSubscription(stripeStatus) {
  switch (String(stripeStatus || "")) {
    case "trialing": return "trialing";
    case "active": return "active";
    case "past_due": return "past_due";
    case "unpaid": return "past_due";
    case "canceled": return "cancelled";
    case "incomplete_expired": return "cancelled";
    default: return "";
  }
}

// A Stripe trial entitles the family until trial_end. Access during the trial is
// the whole point, so this counts as entitled.
function stripeTrialActive(family) {
  if (family?.subscriptionStatus !== "trialing") return false;
  const endsAt = new Date(family.trialEndsAt || 0).getTime();
  // No end date recorded yet (webhook race) — trust the trialing status.
  if (!Number.isFinite(endsAt) || !endsAt) return true;
  return endsAt > Date.now();
}

// The trial is only for genuinely new subscriptions. A family that has paid
// before, or already has a live Stripe subscription, is reactivating or
// upgrading and must not get another free week.
function eligibleForTrial(family) {
  if (!TRIAL_PERIOD_DAYS) return false;
  if (!family) return true;
  if (family.lastPaymentAt) return false;
  if (family.stripeSubscriptionId) return false;
  // One free trial per account, of EITHER kind. An admin-granted no-card trial
  // (trialStartedAt) counts just as much as a Stripe one (trialUsedAt) —
  // otherwise a comped family gets a second free week at checkout. The admin can
  // still grant another by hand from the console; this only governs self-serve.
  if (family.trialUsedAt || family.trialStartedAt || family.trialEndedAt) return false;
  if (["paid", "refunded", "partial_refunded"].includes(family.paymentStatus)) return false;
  return true;
}

function refundWindowFor(family) {
  const paidAt = family?.lastPaymentAt || family?.createdAt || "";
  const paidMs = paidAt ? new Date(paidAt).getTime() : NaN;
  if (!Number.isFinite(paidMs)) {
    return { eligible: false, windowDays: REFUND_WINDOW_DAYS, paidAt: "", endsAt: "", daysLeft: 0 };
  }
  const endsMs = paidMs + REFUND_WINDOW_DAYS * 86400000;
  const msLeft = endsMs - Date.now();
  return {
    eligible: msLeft > 0,
    windowDays: REFUND_WINDOW_DAYS,
    paidAt,
    endsAt: new Date(endsMs).toISOString(),
    daysLeft: Math.max(0, Math.ceil(msLeft / 86400000))
  };
}

function markCancellationScheduled(family, subscription, reason = "") {
  if (!family) return family;
  // A yearly upgrade is paid in full up front and bundles bonus months plus the
  // unused days carried over from the monthly plan. Stripe's period end on the
  // subscription being cancelled can still be the old monthly boundary, so take
  // the LATEST paid-through date — otherwise cancelling silently forfeits time
  // the parent has already paid for.
  const candidates = [
    unixToIso(subscription?.current_period_end || subscription?.cancel_at || 0),
    hasConfirmedYearlyUpgrade(family) ? unixToIso(family.yearlyUpgrade.yearlyNextRenewalAt) || family.yearlyUpgrade.yearlyNextRenewalAt : "",
    family.currentPeriodEnd,
    family.cancelAccessUntil,
    family.cancellationAccessUntil
  ].filter(Boolean).map((value) => ({ value, at: new Date(value).getTime() }))
   .filter((item) => Number.isFinite(item.at));
  const accessUntil = candidates.length
    ? candidates.reduce((latest, item) => (item.at > latest.at ? item : latest)).value
    : "";
  family.subscriptionStatus = "cancel_scheduled";
  // Do not invent a payment. Cancelling during a trial charges nothing, so
  // forcing "paid" here would both lose the trial state and drop the family into
  // the paying book (and revenue) for money that was never collected.
  family.paymentStatus = family.paymentStatus === "failed" ? "failed"
    : family.paymentStatus === "trial" ? "trial"
    : "paid";
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

// A confirmed monthly->yearly upgrade must be retired once the subscription it
// belongs to ends, or a new one supersedes it. Left "scheduled",
// hasConfirmedYearlyUpgrade() stays true forever and normaliseFamily() keeps
// forcing plan back to "Family Yearly" and stripeSubscriptionId back to the
// dead subscription — which silently breaks re-enrolment.
function retireYearlyUpgrade(family, at = nowIso()) {
  if (family?.yearlyUpgrade && family.yearlyUpgrade.status === "scheduled") {
    family.yearlyUpgrade = { ...family.yearlyUpgrade, status: "ended", endedAt: at };
  }
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
  retireYearlyUpgrade(family, endedAt);
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

// Resolve a stored payment reference (cs_/in_/pi_/ch_) into Stripe refund params.
// Returns null when the payment has no refundable PaymentIntent/Charge yet.
async function stripeRefundParamsFor(stripe, paymentId, amountCents) {
  let resolvedPaymentId = String(paymentId || "");
  if (resolvedPaymentId.startsWith("cs_")) {
    const session = await stripe.checkout.sessions.retrieve(resolvedPaymentId, { expand: ["subscription.latest_invoice.payment_intent", "payment_intent"] });
    resolvedPaymentId = await checkoutSessionPaymentIntentId(stripe, session);
  } else if (resolvedPaymentId.startsWith("in_")) {
    const invoice = await stripe.invoices.retrieve(resolvedPaymentId, { expand: ["payment_intent"] });
    resolvedPaymentId = stripeId(invoice.payment_intent);
  }
  const params = { amount: amountCents ? Number(amountCents) : undefined };
  if (resolvedPaymentId.startsWith("pi_")) params.payment_intent = resolvedPaymentId;
  else if (resolvedPaymentId.startsWith("ch_")) params.charge = resolvedPaymentId;
  else return null;
  return { params, resolvedPaymentId };
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
    monthlySubscriptionIds,
    initialAmountCents,
    promotionCode
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
      promotionCode: promotionCode || "",
      replacedMonthlySubscriptions: monthlySubscriptionIds.join(",")
    },
    phases: [
      {
        items: [
          {
            price_data: {
              currency: yearlyPrice.currency,
              product: productId,
              unit_amount: Number(initialAmountCents || yearlyPrice.unit_amount),
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
          promotionCode: promotionCode || "",
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
          promotionCode: promotionCode || "",
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

async function applySubscriptionCoupon(stripe, subscriptionId, couponId, amountOff = 0) {
  try {
    return await stripe.subscriptions.update(subscriptionId, {
      discounts: [{ coupon: couponId }],
      metadata: {
        retentionOfferAccepted: "true",
        retentionOffer: `${amountOff}_off_next_invoice`
      }
    });
  } catch (error) {
    if (!String(error.message || "").includes("discounts")) throw error;
    return stripe.subscriptions.update(subscriptionId, {
      coupon: couponId,
      metadata: {
        retentionOfferAccepted: "true",
        retentionOffer: `${amountOff}_off_next_invoice`
      }
    });
  }
}

// Email settings (Postmark token + From) can be entered in the admin Emails
// screen and stored in the DB; those take priority over env vars.
function defaultEmailSettings() {
  return { postmarkToken: "", fromEmail: "", messageStream: "outbound", updatedAt: "", updatedBy: "" };
}
function normaliseEmailSettings(settings = {}) {
  const d = defaultEmailSettings();
  return {
    ...d,
    ...settings,
    postmarkToken: typeof settings.postmarkToken === "string" ? settings.postmarkToken : "",
    fromEmail: String(settings.fromEmail || ""),
    messageStream: String(settings.messageStream || "outbound"),
    updatedAt: settings.updatedAt || "",
    updatedBy: settings.updatedBy || ""
  };
}
function safeEmailSettings(settings = {}) {
  const n = normaliseEmailSettings(settings);
  return {
    hasPostmarkToken: Boolean(n.postmarkToken),
    maskedPostmarkToken: maskedSecret(n.postmarkToken),
    fromEmail: n.fromEmail,
    updatedAt: n.updatedAt,
    updatedBy: n.updatedBy
  };
}
function storedEmailSettings() {
  try { return normaliseEmailSettings(readDb().emailSettings); } catch (e) { return defaultEmailSettings(); }
}
function activePostmarkToken() {
  return storedEmailSettings().postmarkToken || process.env.POSTMARK_SERVER_TOKEN || "";
}
function postmarkFromEmail() {
  return storedEmailSettings().fromEmail || process.env.POSTMARK_FROM_EMAIL || process.env.FROM_EMAIL || "";
}

function postmarkConfigured() {
  return Boolean(activePostmarkToken() && postmarkFromEmail());
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
  if (stripe) {
    // Live Stripe: signature verification is mandatory. If the webhook secret
    // is missing we must FAIL CLOSED — the endpoint is public, so accepting an
    // unsigned body would let anyone forge "checkout.session.completed" and mint
    // free subscriptions. Never fall through to the trust-the-payload branch.
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      mutateDb((db) => monitor(db, "error", "stripe", "Webhook rejected: STRIPE_WEBHOOK_SECRET not set while Stripe is live", {}));
      return res.status(500).json({ error: "Webhook signing secret is not configured." });
    }
    try {
      event = stripe.webhooks.constructEvent(req.body, req.get("stripe-signature"), process.env.STRIPE_WEBHOOK_SECRET);
    } catch (error) {
      mutateDb((db) => monitor(db, "error", "stripe", "Invalid Stripe webhook signature", { detail: error.message }));
      return res.status(400).json({ error: "Invalid Stripe webhook signature." });
    }
  } else {
    // Mock/dev only: no STRIPE_SECRET_KEY at all, so there is no signature to
    // verify. Never reached in production (production always has a Stripe key).
    try {
      event = JSON.parse(req.body.toString("utf8") || "{}");
    } catch (error) {
      mutateDb((db) => monitor(db, "error", "stripe", "Invalid Stripe webhook payload", { detail: error.message }));
      return res.status(400).json({ error: "Invalid Stripe webhook payload." });
    }
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

  // A chargeback ends the relationship: stop the Stripe subscription so it cannot
  // bill the disputed card again. A second charge almost always becomes a second
  // dispute, and each one carries a fee and counts against the dispute ratio that
  // Stripe polices. A won dispute is rare enough that re-subscribing is the right
  // trade against that risk.
  let disputeCancellationResult = [];
  if (event.type === "charge.dispute.created" && stripe && process.env.STRIPE_SECRET_KEY) {
    const disputedFamily = findFamilyForStripeObject(readDb(), webhookObject);
    disputeCancellationResult = await cancelStripeSubscriptionsNow(stripe, disputedFamily);
  }

  // checkout.session.completed carries only a subscription id, but whether that
  // subscription is trialing decides whether we may mark the family paid.
  // Resolve it here (async) so the synchronous mutateDb below can just read it.
  let subscriptionObject = null;
  if (event.type === "checkout.session.completed") {
    const embedded = webhookObject.subscription;
    if (embedded && typeof embedded === "object") {
      subscriptionObject = embedded;
    } else if (embedded && stripe && process.env.STRIPE_SECRET_KEY) {
      try {
        subscriptionObject = await stripe.subscriptions.retrieve(String(embedded));
      } catch (error) {
        mutateDb((db) => monitor(db, "warning", "stripe", "Could not resolve subscription for checkout session", { detail: error.message }));
      }
    }
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
      // A fresh Checkout supersedes any earlier yearly upgrade; retire it first
      // so normaliseFamily() does not overwrite the new plan/subscription id.
      retireYearlyUpgrade(family);
      // Checkout completing means the card was collected, NOT that money moved.
      // On a trial nothing is charged until trial_end, so marking paid here would
      // report revenue that does not exist and put the family in the paying book.
      // Only invoice.payment_succeeded marks paid.
      const trialing = subscriptionObject
        ? subscriptionObject.status === "trialing"
        : Boolean(object.trial_end);
      if (trialing) {
        family.subscriptionStatus = "trialing";
        family.paymentStatus = "trial";
        family.trialUsedAt = family.trialUsedAt || nowIso();
        const trialEnd = unixToIso(subscriptionObject?.trial_end || object.trial_end || 0);
        if (trialEnd) family.trialEndsAt = trialEnd;
      } else {
        family.subscriptionStatus = "active";
        family.paymentStatus = family.paymentStatus === "paid" ? "paid" : "pending";
      }
      family.plan = metadata.planName || family.pendingPlanName || family.plan;
      delete family.pendingPlanName;
      family.stripeCustomerId = stripeId(object.customer) || family.stripeCustomerId;
      family.stripeSubscriptionId = stripeId(object.subscription) || family.stripeSubscriptionId;
      family.lastLoginAt = family.lastLoginAt || nowIso();
    }

    // Subscription lifecycle: Stripe owns these transitions (trialing -> active
    // when the first invoice is paid, -> past_due on failure, -> cancelled), so
    // mirror its status rather than inferring one.
    if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      const mapped = statusFromStripeSubscription(object.status);
      if (object.trial_end) family.trialEndsAt = unixToIso(object.trial_end) || family.trialEndsAt;
      if (object.status === "trialing") {
        family.paymentStatus = "trial";
        family.trialUsedAt = family.trialUsedAt || nowIso();
      }
      if (mapped && !object.cancel_at_period_end && event.type !== "customer.subscription.deleted") {
        family.subscriptionStatus = mapped;
      }
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
      // A renewal actually charged, so any pending cancellation is moot — Stripe
      // would not bill a subscription that was ending. Clearing these stops a
      // resumed subscription carrying a stale "cancels on ..." date after it has
      // plainly renewed.
      family.cancellationRequested = false;
      family.cancellationStatus = "";
      family.cancelAtPeriodEnd = false;
      family.cancelAccessUntil = "";
      family.cancellationAccessUntil = "";
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
        // Status itself is set above from statusFromStripeSubscription(), which
        // also covers trialing/past_due — this branch only clears the
        // cancellation flags once the subscription is genuinely active again.
        if (family.subscriptionStatus === "active") {
          family.cancellationRequested = false;
          family.cancellationStatus = "";
          family.cancelAtPeriodEnd = false;
          family.cancelAccessUntil = "";
          family.cancellationAccessUntil = "";
        }
      }
    }
    // A chargeback means the bank has pulled the money back. Access stops and the
    // operator is alerted immediately — otherwise the first you hear of it is a
    // Stripe email, days later, while the account keeps being served.
    if (event.type.startsWith("charge.dispute.")) {
      family.dispute = {
        status: object.status || event.type.replace("charge.dispute.", ""),
        reason: object.reason || "",
        amountCents: Number(object.amount || 0),
        chargeId: stripeId(object.charge) || "",
        openedAt: family.dispute?.openedAt || nowIso(),
        updatedAt: nowIso()
      };
      const won = object.status === "won";
      const lost = object.status === "lost";
      if (event.type === "charge.dispute.created" || (!won && !lost)) {
        // The Stripe subscription was cancelled above, so record that here too —
        // leaving it "past_due" would imply Stripe is still retrying, and the
        // renewals table would keep forecasting revenue that cannot arrive.
        markSubscriptionEndedNow(family, "Chargeback opened", effectiveFamilySubscriptionId(family) || family.stripeSubscriptionId || "");
        family.paymentStatus = "disputed";
        family.dispute.subscriptionCancelled = true;
      } else if (won) {
        // Bank found for us: put the family back where they were.
        family.subscriptionStatus = "active";
        family.paymentStatus = "paid";
        delete family.dispute;
      } else if (lost) {
        family.paymentStatus = "disputed";
        markSubscriptionEndedNow(family, "Chargeback lost", effectiveFamilySubscriptionId(family) || family.stripeSubscriptionId || "");
      }
      monitor(db, "error", "billing",
        won ? "Chargeback resolved in our favour" : lost ? "Chargeback lost — subscription ended" : "Chargeback opened — access suspended",
        { email: family.email, reason: object.reason || "", amountCents: Number(object.amount || 0) }, family.email);
      audit(db, "stripe.dispute", { familyId: family.id, email: family.email, type: event.type, status: object.status || "", stripeCancellation: disputeCancellationResult }, "stripe");
    }
    if (refundWebhook) {
      // Only a FULL refund ends the subscription. A partial/goodwill refund
      // (e.g. issued from the Stripe Dashboard) must leave access intact.
      const refunded = Number(webhookObject.amount_refunded ?? object.amount_refunded ?? 0);
      const charged = Number(webhookObject.amount ?? object.amount ?? 0);
      const fullRefund = !charged || refunded >= charged;
      family.paymentStatus = fullRefund ? "refunded" : "partial_refunded";
      family.refundedAt = nowIso();
      if (fullRefund) {
        markSubscriptionEndedNow(family, "Payment refunded", effectiveFamilySubscriptionId(family) || family.stripeSubscriptionId || "");
      }
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

// 6mb accommodates base64 image payloads (AI vision calls + phone capture uploads);
// the capture page downscales photos client-side so real uploads stay well under this.
app.use(express.json({ limit: "6mb" }));

async function sendEmail({ to, template, message, subject: subjectArg, html }) {
  const recipient = normalizeEmail(to || process.env.TEST_EMAIL_TO || "");
  if (!isAllowedParentEmail(recipient)) {
    throw new Error(parentEmailError(recipient));
  }
  const templateName = template || "Welcome parent";
  const subject = subjectArg || templateName || "KiddieGPT";
  const text = message || `KiddieGPT: ${templateName}`;

  if (postmarkConfigured()) {
    const response = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": activePostmarkToken()
      },
      body: JSON.stringify({
        From: postmarkFromEmail(),
        To: recipient,
        Subject: subject,
        TextBody: text,
        ...(html ? { HtmlBody: html } : {}),
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
    from: postmarkFromEmail() || process.env.FROM_EMAIL || process.env.SMTP_USER,
    to: recipient,
    subject,
    text,
    ...(html ? { html } : {})
  });
  return { mode: "smtp", to: recipient, subject, messageId: info.messageId };
}

// ---- Styled email templates -------------------------------------------------
// One shared HTML shell (logo + wordmark + chip, title, body/steps, dark CTA,
// footer) reused by every lifecycle email, so real sends and admin previews
// share a single source of truth.
function escHtml(value) {
  return String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function emailBaseUrl() {
  return String(process.env.PUBLIC_ORIGIN || "https://app.kiddiegpt.com").replace(/\/+$/, "");
}
// Templates receive ISO timestamps from live sends but friendly strings from the
// preview sample, so render ISO readably and pass anything else through.
function emailDate(value) {
  const text = String(value || "");
  const time = Date.parse(text);
  if (!/^\d{4}-\d{2}-\d{2}/.test(text) || Number.isNaN(time)) return text;
  return new Date(time).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}
const EMAIL_SIGNOFF = "— The KiddieGPT Team";

function renderEmailShell(o) {
  const base = emailBaseUrl();
  const chip = o.chip ? `<span style="display:inline-block;padding:6px 12px;border-radius:999px;background:#e9f7ef;color:#0f6e56;font-size:12px;font-weight:700">${escHtml(o.chip)}</span>` : "";
  const code = o.code ? `<div style="margin:6px 0 20px;padding:16px;border:1px dashed #cfe0dc;border-radius:12px;text-align:center;font-size:30px;font-weight:800;letter-spacing:8px;color:#004f48;font-family:monospace">${escHtml(o.code)}</div>` : "";
  const stepsRows = (o.steps || []).map((s, i) => `<tr><td style="vertical-align:top;padding:0 12px 16px 0;width:20px;color:#9aa7a4;font-weight:700;font-size:14px">${i + 1}</td><td style="padding:0 0 16px 0"><div style="font-weight:700;color:#16332d;font-size:15px">${escHtml(s.title)}</div><div style="color:#6a827d;font-size:14px;line-height:1.5;margin-top:2px">${escHtml(s.text)}</div></td></tr>`).join("");
  const steps = stepsRows ? `<table role="presentation" width="100%" style="border-collapse:collapse;margin:6px 0 20px">${stepsRows}</table>` : "";
  const paras = (o.paragraphs || []).map((p) => `<p style="margin:0 0 14px;color:#33474a;font-size:15px;line-height:1.6">${p}</p>`).join("");
  const cta = o.ctaText ? `<div style="margin:6px 0 22px"><a href="${escHtml(o.ctaUrl || base)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 22px;border-radius:12px">${escHtml(o.ctaText)} &rarr;</a></div>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body style="margin:0;background:#f4f6f5;font-family:-apple-system,'Segoe UI',Inter,Arial,sans-serif">
<table role="presentation" width="100%" style="border-collapse:collapse;background:#f4f6f5"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #e6ece9;border-radius:16px;border-collapse:separate">
<tr><td style="padding:26px 30px 24px">
<table role="presentation" width="100%" style="border-collapse:collapse"><tr>
<td style="vertical-align:middle"><img src="${base}/icons/logo-mascot.png" width="32" height="32" alt="" style="vertical-align:middle;border-radius:8px">&nbsp;<span style="font-weight:800;color:#004f48;font-size:16px;vertical-align:middle">KiddieGPT</span>&nbsp;<span style="color:#9aa7a4;font-size:12px;vertical-align:middle">Your learning copilot</span></td>
<td align="right">${chip}</td></tr></table>
<h1 style="margin:22px 0 14px;color:#16332d;font-size:24px;font-weight:800">${escHtml(o.title)}</h1>
${o.greeting ? `<p style="margin:0 0 14px;color:#33474a;font-size:15px;line-height:1.6">${escHtml(o.greeting)}</p>` : ""}
${paras}${code}${steps}${cta}
${o.signoff ? `<p style="margin:8px 0 0;color:#6a827d;font-size:14px">${escHtml(o.signoff)}</p>` : ""}
</td></tr>
<tr><td style="padding:18px 30px;border-top:1px solid #eef3f1">
<p style="margin:0;color:#9aa7a4;font-size:12px;line-height:1.5">This email was sent by KiddieGPT. If you weren't expecting it, you can safely ignore it.</p>
<p style="margin:8px 0 0;color:#9aa7a4;font-size:12px">KiddieGPT &middot; kiddiegpt.com &middot; support@kiddiegpt.com</p>
</td></tr></table></td></tr></table></body></html>`;
}

const EMAIL_SAMPLE = {
  parentName: "Meena Ravi", childName: "Ava", planName: "Family Monthly", amount: "$19.00",
  date: "August 14, 2026", nextDate: "August 14, 2027", code: "402913", bonusMonths: 3,
  discountPercent: 20, email: "meena@example.com", trialDays: 14, trialEndsAt: "August 28, 2026", cardOnFile: true,
  supportReply: "Yes — the Family plan covers up to 3 children. Open the Student tab to add another profile."
};

const EMAIL_TEMPLATES = [
  { key: "verify_email", name: "Verify your email", stage: "Account & access", subject: () => "Verify your KiddieGPT email",
    build: (d) => ({ chip: "Verify", title: "Confirm your email", greeting: `Hi ${d.parentName},`, paragraphs: ["Enter this code in KiddieGPT to finish creating your account. It expires in 10 minutes."], code: d.code }) },
  { key: "sign_in_code", name: "Sign-in code", stage: "Account & access", subject: () => "Your KiddieGPT sign-in code",
    build: (d) => ({ chip: "Sign in", title: "Your sign-in code", greeting: `Hi ${d.parentName},`, paragraphs: ["Use this code to sign in. It expires shortly. If you didn't request it, you can ignore this email."], code: d.code }) },
  { key: "welcome", name: "Welcome / you're all set", stage: "Account & access", subject: () => "You're all set on KiddieGPT",
    build: (d) => ({ chip: "You're in", title: "You're all set!", greeting: `Hi ${d.parentName},`, paragraphs: ["Welcome to KiddieGPT — your child's calm, safe learning copilot. Here's how to get started:"], steps: [{ title: "Add your child's profile", text: "Set their name, grade, and reading level." }, { title: "Set learning goals", text: "Pick goals and rewards that motivate them." }, { title: "Get the Chrome extension", text: "Install it so your child can start learning." }], ctaText: "Open KiddieGPT", ctaUrl: emailBaseUrl() }) },
  { key: "password_reset", name: "Password reset code", stage: "Account & access", subject: () => "Reset your KiddieGPT password",
    build: (d) => ({ chip: "Security", title: "Reset your password", greeting: `Hi ${d.parentName},`, paragraphs: ["Enter this code in KiddieGPT to set a new password. It expires shortly."], code: d.code }) },
  { key: "password_changed", name: "Password changed", stage: "Account & access", subject: () => "Your KiddieGPT password was changed",
    build: (d) => ({ chip: "Security", title: "Your password was changed", greeting: `Hi ${d.parentName},`, paragraphs: ["This confirms your KiddieGPT password was just changed. If this wasn't you, reset it right away and contact support."], ctaText: "Review account", ctaUrl: emailBaseUrl() }) },
  { key: "confirm_new_email", name: "Confirm new email", stage: "Account & access", subject: () => "Confirm your new email",
    build: (d) => ({ chip: "Security", title: "Confirm your new email", greeting: `Hi ${d.parentName},`, paragraphs: ["Enter this code in KiddieGPT to confirm your new email address."], code: d.code }) },

  { key: "payment_receipt", name: "Payment receipt", stage: "Payments & billing", subject: () => "Your KiddieGPT receipt",
    build: (d) => ({ chip: "Receipt", title: "Payment received", greeting: `Hi ${d.parentName},`, paragraphs: [`Thanks! We received your payment of <b>${escHtml(d.amount)}</b> for <b>${escHtml(d.planName)}</b> on ${escHtml(d.date)}.`, "Your child's access stays unlocked. Manage billing anytime from the parent portal."], ctaText: "View billing", ctaUrl: emailBaseUrl() }) },
  { key: "yearly_upgrade", name: "Yearly upgrade confirmed", stage: "Payments & billing", subject: () => "You're on the yearly plan",
    build: (d) => ({ chip: "Upgraded", title: "You're on the yearly plan", greeting: `Hi ${d.parentName},`, paragraphs: [`You've switched to the yearly plan with <b>${escHtml(String(d.bonusMonths))} bonus months</b>. Your unused days this month carried over — you lost nothing.`, `Your plan renews on ${escHtml(d.nextDate)}.`], ctaText: "View billing", ctaUrl: emailBaseUrl() }) },
  { key: "payment_failed", name: "Payment failed", stage: "Payments & billing", subject: () => "Your KiddieGPT payment didn't go through",
    build: (d) => ({ chip: "Action needed", title: "Your payment didn't go through", greeting: `Hi ${d.parentName},`, paragraphs: [`We couldn't process your payment for <b>${escHtml(d.planName)}</b>. Please update your payment method to keep your child's access.`], ctaText: "Update payment", ctaUrl: emailBaseUrl() }) },
  { key: "payment_retry", name: "Payment retry reminder", stage: "Payments & billing", subject: () => "Reminder: update your payment method",
    build: (d) => ({ chip: "Reminder", title: "Still can't reach your card", greeting: `Hi ${d.parentName},`, paragraphs: ["We tried your payment again and it didn't go through. Update your card soon to avoid losing access."], ctaText: "Update payment", ctaUrl: emailBaseUrl() }) },
  { key: "access_paused", name: "Access paused — unpaid", stage: "Payments & billing", subject: () => "Your KiddieGPT access is paused",
    build: (d) => ({ chip: "Paused", title: "Your access is paused", greeting: `Hi ${d.parentName},`, paragraphs: ["Because the payment is still unpaid, we've paused access for now. Update your payment method to turn everything back on right away."], ctaText: "Restore access", ctaUrl: emailBaseUrl() }) },
  { key: "renewal_reminder", name: "Renewal reminder", stage: "Payments & billing", subject: () => "Your KiddieGPT plan renews soon",
    build: (d) => ({ chip: "Heads up", title: "Your plan renews soon", greeting: `Hi ${d.parentName},`, paragraphs: [`A quick heads-up: your <b>${escHtml(d.planName)}</b> renews on ${escHtml(d.nextDate)}. No action needed — we'll charge your card on file.`], ctaText: "Manage plan", ctaUrl: emailBaseUrl() }) },

  { key: "weekly_summary", name: "Weekly progress summary", stage: "Engagement", subject: (d) => `${d.childName}'s week on KiddieGPT`,
    build: (d) => ({ chip: "Weekly", title: `${d.childName}'s week on KiddieGPT`, greeting: `Hi ${d.parentName},`, paragraphs: [`Here's how ${escHtml(d.childName)} did this week:`], steps: [{ title: "Flashcards & quizzes", text: "Reviewed and practiced across the week." }, { title: "Math problems solved", text: "Worked through problems step by step." }, { title: "Goals in progress", text: "Making steady progress toward rewards." }], ctaText: "See full progress", ctaUrl: emailBaseUrl() }) },
  { key: "finish_setup", name: "Finish setup nudge", stage: "Engagement", subject: () => "Finish setting up KiddieGPT",
    build: (d) => ({ chip: "Almost there", title: "Finish setting up KiddieGPT", greeting: `Hi ${d.parentName},`, paragraphs: ["You're one step away. Complete setup so your child can start learning:"], steps: [{ title: "Complete checkout", text: "Pick a plan to unlock the tools." }, { title: "Add the extension", text: "Install KiddieGPT in Chrome." }], ctaText: "Finish setup", ctaUrl: emailBaseUrl() }) },
  { key: "low_usage", name: "Low-usage rescue", stage: "Engagement", subject: (d) => `We miss ${d.childName}!`,
    build: (d) => ({ chip: "Check-in", title: `We miss ${d.childName}!`, greeting: `Hi ${d.parentName},`, paragraphs: [`It's been a quiet week — ${escHtml(d.childName)} hasn't used KiddieGPT lately. Try the Tutor or Math tool for a quick 10-minute win.`], ctaText: "Open KiddieGPT", ctaUrl: emailBaseUrl() }) },
  { key: "goal_completed", name: "Goal completed", stage: "Engagement", subject: (d) => `${d.childName} earned a reward!`,
    build: (d) => ({ chip: "Reward", title: `${d.childName} earned a reward!`, greeting: `Hi ${d.parentName},`, paragraphs: [`Great news — ${escHtml(d.childName)} just completed a learning goal and earned their reward. Time to celebrate!`], ctaText: "See progress", ctaUrl: emailBaseUrl() }) },

  { key: "cancellation_scheduled", name: "Cancellation scheduled", stage: "Cancellation & winback", subject: () => "Your KiddieGPT plan is set to cancel",
    build: (d) => ({ chip: "Scheduled", title: "Your plan is set to cancel", greeting: `Hi ${d.parentName},`, paragraphs: [`Your subscription is scheduled to cancel. Your child keeps access until <b>${escHtml(d.nextDate)}</b>. Change your mind anytime before then.`], ctaText: "Keep my plan", ctaUrl: emailBaseUrl() }) },
  { key: "subscription_ended", name: "Subscription ended", stage: "Cancellation & winback", subject: () => "Your KiddieGPT plan has ended",
    build: (d) => ({ chip: "Ended", title: "Your plan has ended", greeting: `Hi ${d.parentName},`, paragraphs: ["Your subscription has ended and the extension tools are now locked. Your child's profiles and progress are saved — reactivate anytime to pick up where they left off."], ctaText: "Reactivate", ctaUrl: emailBaseUrl() }) },
  { key: "winback", name: "Winback offer", stage: "Cancellation & winback", subject: () => "Come back to KiddieGPT",
    build: (d) => ({ chip: "Come back", title: "We'd love to have you back", greeting: `Hi ${d.parentName},`, paragraphs: [`Ready to give it another go? Reactivate now and get <b>${escHtml(String(d.discountPercent))}% off</b> your next month.`], ctaText: "Reactivate & save", ctaUrl: emailBaseUrl() }) },

  { key: "support_reply", name: "Support reply", stage: "Support & account", subject: () => "Reply from KiddieGPT support",
    build: (d) => ({ chip: "Support", title: "Reply from KiddieGPT support", greeting: `Hi ${d.parentName},`, paragraphs: [escHtml(d.supportReply), "Just reply to this email if you need anything else."], ctaText: "Open support", ctaUrl: emailBaseUrl() }) },
  { key: "deletion_requested", name: "Deletion requested", stage: "Support & account", subject: () => "We received your deletion request",
    build: (d) => ({ chip: "Account", title: "We received your request", greeting: `Hi ${d.parentName},`, paragraphs: ["We've received your account deletion request. Extension access is now locked while we process it. Billing records are kept only as required for support and tax.", "If this was a mistake, contact support and we'll stop the deletion."], ctaText: "Contact support", ctaUrl: emailBaseUrl() }) },

  { key: "trial_started", name: "Free trial started", stage: "Free trial", subject: (d) => `Your ${d.trialDays}-day KiddieGPT trial is live`,
    build: (d) => ({ chip: "Trial", title: `Your ${escHtml(String(d.trialDays))}-day trial starts now`, greeting: `Hi ${d.parentName},`, paragraphs: [`Full access to every KiddieGPT tool is unlocked until <b>${escHtml(emailDate(d.trialEndsAt))}</b> — no card needed.`, "Add your child's profile and set a learning goal to get the most out of it."], steps: ["Sign in to the parent portal", "Add a student profile", "Install the Chrome extension"], ctaText: "Start setting up", ctaUrl: emailBaseUrl() }) },
  { key: "trial_ending", name: "Free trial ending soon", stage: "Free trial", subject: () => "Your KiddieGPT trial ends soon",
    build: (d) => ({ chip: "Ending soon", title: "Your trial ends in a few days", greeting: `Hi ${d.parentName},`, paragraphs: [d.cardOnFile ? `Your free trial ends on <b>${escHtml(emailDate(d.trialEndsAt))}</b>, and your card will be charged for the plan you chose unless you cancel before then. Nothing has been charged so far.` : `Your free trial ends on <b>${escHtml(emailDate(d.trialEndsAt))}</b>. Pick a plan to keep your child's tools unlocked — their profiles and progress stay exactly as they are.`], ctaText: d.cardOnFile ? "Review your plan" : "Choose a plan", ctaUrl: emailBaseUrl() }) },
  { key: "trial_ended", name: "Free trial ended", stage: "Free trial", subject: () => "Your KiddieGPT trial has ended",
    build: (d) => ({ chip: "Ended", title: "Your free trial has ended", greeting: `Hi ${d.parentName},`, paragraphs: ["The extension tools are locked for now. Your child's profiles, goals, and progress are saved — choose a plan anytime to pick up where they left off."], ctaText: "Choose a plan", ctaUrl: emailBaseUrl() }) },
  { key: "op_new_paid", name: "New paid family (internal)", stage: "Operator", subject: () => "New paid family on KiddieGPT",
    build: (d) => ({ chip: "New", title: "New paid family 🎉", paragraphs: [`<b>${escHtml(d.parentName)}</b> (${escHtml(d.email)}) just subscribed to <b>${escHtml(d.planName)}</b>.`], ctaText: "Open admin", ctaUrl: `${emailBaseUrl()}/admin.html` }) },
  { key: "op_new_support", name: "New support message (internal)", stage: "Operator", subject: () => "New support message",
    build: (d) => ({ chip: "Support", title: "New support message", paragraphs: [`<b>${escHtml(d.parentName)}</b> (${escHtml(d.email)}) sent a new support message. Open the admin console to reply.`], ctaText: "Open support", ctaUrl: `${emailBaseUrl()}/admin.html` }) }
];

function renderTemplate(key, data) {
  const t = EMAIL_TEMPLATES.find((x) => x.key === key);
  if (!t) return null;
  const d = { ...EMAIL_SAMPLE, ...(data || {}) };
  const opts = t.build(d);
  if (!opts.signoff && opts.stage !== "Operator" && t.stage !== "Operator") opts.signoff = EMAIL_SIGNOFF;
  return { key: t.key, name: t.name, stage: t.stage, subject: t.subject(d), html: renderEmailShell(opts) };
}

// ---- Admin: email settings + template gallery -------------------------------
app.get("/api/admin/email-settings", requireAdmin, (req, res) => {
  res.json({ ...safeEmailSettings(readDb().emailSettings), provider: emailMode(), configured: postmarkConfigured() || smtpConfigured() });
});
app.put("/api/admin/email-settings", requireAdmin, (req, res) => {
  const body = req.body || {};
  const updated = mutateDb((db) => {
    const next = normaliseEmailSettings(db.emailSettings);
    if (Object.prototype.hasOwnProperty.call(body, "postmarkToken")) {
      const tok = String(body.postmarkToken || "").trim();
      if (tok) next.postmarkToken = tok;
    }
    if (body.clearPostmarkToken) next.postmarkToken = "";
    if (Object.prototype.hasOwnProperty.call(body, "fromEmail")) next.fromEmail = String(body.fromEmail || "").trim();
    next.updatedAt = nowIso();
    next.updatedBy = req.auth?.email || "admin";
    db.emailSettings = next;
    audit(db, "email_settings.update", { hasPostmarkToken: Boolean(next.postmarkToken), fromEmail: next.fromEmail }, req.auth?.email || "admin");
    return safeEmailSettings(db.emailSettings);
  });
  res.json({ ...updated, provider: emailMode(), configured: postmarkConfigured() || smtpConfigured() });
});
app.get("/api/admin/email-templates", requireAdmin, (req, res) => {
  res.json({
    provider: emailMode(),
    configured: postmarkConfigured() || smtpConfigured(),
    templates: EMAIL_TEMPLATES.map((t) => renderTemplate(t.key))
  });
});
app.post("/api/admin/email-templates/:key/test", requireAdmin, async (req, res) => {
  const rendered = renderTemplate(req.params.key);
  if (!rendered) return res.status(404).json({ error: "unknown_template" });
  const to = normalizeEmail((req.body && req.body.to) || req.auth?.email || process.env.ADMIN_NOTIFY_EMAIL || "");
  try {
    const result = await sendEmail({ to, template: rendered.name, subject: `[Test] ${rendered.subject}`, html: rendered.html, message: `Preview of the "${rendered.name}" email.` });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

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

// One-click demo logins carry a shared password, so they must never reach a real
// deployment — anyone could click straight into an account. Off by default on
// Vercel or with a live Stripe key; DEMO_LOGINS forces it either way.
function demoLoginsEnabled() {
  if (process.env.DEMO_LOGINS === "true") return true;
  if (process.env.DEMO_LOGINS === "false") return false;
  if (process.env.VERCEL) return false;
  if (String(process.env.STRIPE_SECRET_KEY || "").startsWith("sk_live")) return false;
  return true;
}

// Seeded fixtures covering each subscription state, surfaced as login tiles so
// they can be switched between without retyping credentials.
const DEMO_LOGIN_ACCOUNTS = [
  { email: "parent.kiddiegpt@gmail.com", label: "Parent demo", note: "Monthly card trial", icon: "user-round" },
  // Fresh and trial-eligible — use these to run a real Stripe Checkout with the
  // 7-day card-upfront trial.
  { email: "stripe.new1@gmail.com", label: "New · monthly", note: "Eligible for trial", icon: "credit-card" },
  { email: "stripe.new2@gmail.com", label: "New · yearly", note: "Eligible for trial", icon: "badge-dollar-sign" },
  // Trial already used — checkout charges immediately, no free week.
  { email: "stripe.used@gmail.com", label: "Trial used", note: "Charges immediately", icon: "clock-alert" },
  // Display fixtures for UI states (no Stripe objects behind them).
  { email: "trial.active@gmail.com", label: "Trial active", note: "Comped, no card", icon: "clock" },
  { email: "paid.monthly@gmail.com", label: "Monthly paid", note: "Active subscription", icon: "wallet" },
  { email: "paid.yearly@gmail.com", label: "Yearly paid", note: "Active subscription", icon: "wallet" },
  { email: "trial.ended@gmail.com", label: "Trial ended", note: "Access expired", icon: "ban" }
];

app.get("/api/auth/config", (req, res) => {
  const demoEnabled = demoLoginsEnabled();
  const db = demoEnabled ? readDb() : null;
  res.json({
    allowedParentEmailDomains,
    googleClientId: process.env.GOOGLE_CLIENT_ID || "",
    googleConfigured: Boolean(process.env.GOOGLE_CLIENT_ID),
    demoLogins: demoEnabled,
    // Only advertise fixtures that actually exist, so the tiles cannot offer a
    // login that will fail.
    demoAccounts: demoEnabled
      ? DEMO_LOGIN_ACCOUNTS
          .filter((account) => (db.families || []).some((family) => family.email === account.email))
          .map((account) => ({ ...account, password: process.env.PARENT_TEST_PASSWORD || "kiddiegpt123" }))
      : []
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
    // A Google-only account has no password at all, so "invalid email or
    // password" sends the parent off hunting for a typo that does not exist.
    // Naming the provider discloses that an account exists, which signup already
    // does via its 409 — and it is the difference between a dead end and a
    // signpost.
    if (user && user.authProvider === "google" && !user.passwordHash) {
      mutateDb((dbToUpdate) => monitor(dbToUpdate, "info", "auth", "Password login attempted on a Google account", { email: normalizedEmail }, normalizedEmail));
      return res.status(409).json({
        ok: false,
        authProvider: "google",
        error: "This account uses Google sign-in. Continue with Google, or use \"Forgot password\" to set a password."
      });
    }
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
  // Login is for existing accounts only; unknown emails are routed to sign-up by the client.
  if (email !== REVIEW_EMAIL && !parentAccountExists(readDb(), email)) {
    return res.status(404).json({ ok: false, error: "no_account" });
  }
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
  // Only the reviewer account gets its code back in the response (shown on-screen).
  return res.json({ ok: true, mode, ...(email === REVIEW_EMAIL ? { testCode: otp } : {}) });
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
      // Login no longer mints accounts; new users go through /api/auth/signup.
      // The reviewer account is the only one allowed to be auto-provisioned here.
      if (email !== REVIEW_EMAIL) return { error: "no_account" };
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
        age: child.age || "",
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

// Parent profile edits are deliberately separate from onboarding and billing.
// Saving a child goal should never be able to rewrite plan or subscription
// fields, and it should not depend on Stripe entitlement timing.
app.put("/api/parent/family/profile", requireParent, (req, res) => {
  const body = req.body || {};
  const inputChildren = Array.isArray(body.children) ? body.children.slice(0, 3) : [];
  if (!inputChildren.length) {
    return res.status(400).json({ error: "Add at least one student profile before saving." });
  }

  const children = inputChildren.map((child) => {
    const studentName = String(child.studentName || "").trim().slice(0, 25);
    const rawGrade = String(child.grade || "").match(/\d+/)?.[0] || "5";
    const grade = Math.min(12, Math.max(1, Number(rawGrade) || 5));
    const goals = Array.isArray(child.learningGoals) ? child.learningGoals.slice(0, 7).map((goal) => ({
      goal: String(goal?.goal || "").trim().slice(0, 75),
      reward: String(goal?.reward || "").trim().slice(0, 75),
      completed: Boolean(goal?.completed)
    })).filter((goal) => goal.goal || goal.reward) : [];
    const firstGoal = goals.find((goal) => !goal.completed) || goals[0] || { goal: "", reward: "" };
    return {
      id: String(child.id || makeId("child")).slice(0, 100),
      studentName,
      grade: `Grade ${grade}`,
      readingLevel: String(child.readingLevel || "").trim().slice(0, 30),
      goal: firstGoal.goal,
      reward: firstGoal.reward,
      learningGoals: goals
    };
  });

  if (children.some((child) => !child.studentName)) {
    return res.status(400).json({ error: "Each student profile needs a name before saving." });
  }

  const saved = mutateDb((db) => {
    const family = parentFamilyForIdentity(db, req.auth);
    if (!family) return null;
    family.children = children;
    const primary = children[0];
    family.studentName = primary.studentName;
    family.grade = primary.grade;
    family.readingLevel = primary.readingLevel;
    family.goal = primary.goal;
    family.reward = primary.reward;
    family.learningGoals = primary.learningGoals;
    if (String(body.parentName || "").trim()) family.parentName = String(body.parentName).trim().slice(0, 100);
    const user = db.users.find((item) => item.id === req.auth.sub && item.role === "parent");
    if (user && family.parentName) user.name = family.parentName;
    audit(db, "family.profile.update", { familyId: family.id, childCount: children.length }, family.email);
    return family;
  });

  if (!saved) return res.status(404).json({ error: "Family account not found." });
  return res.json({ ok: true, family: saved });
});

app.delete("/api/parent/family/children/:childId", requireParent, (req, res) => {
  const result = mutateDb((db) => {
    const family = parentFamilyForIdentity(db, req.auth);
    if (!family) return { error: "Family account not found.", status: 404 };
    const children = Array.isArray(family.children) ? family.children : [];
    if (children.length <= 1) return { error: "A family account must keep at least one student profile.", status: 400 };
    const index = children.findIndex((child) => String(child.id || "") === String(req.params.childId || ""));
    if (index < 0) return { removed: false, notFound: true };
    const [removed] = children.splice(index, 1);
    family.children = children;
    const primary = children[0] || {};
    family.studentName = primary.studentName || "";
    family.grade = primary.grade || "";
    family.readingLevel = primary.readingLevel || "";
    family.goal = primary.goal || "";
    family.reward = primary.reward || "";
    family.learningGoals = Array.isArray(primary.learningGoals) ? primary.learningGoals : [];
    audit(db, "family.child.delete", { familyId: family.id, childId: removed.id, studentName: removed.studentName || "" }, family.email);
    return { removed: true, childId: removed.id, familyId: family.id };
  });
  if (result?.error) return res.status(result.status || 400).json({ error: result.error });
  return res.json({ ok: true, ...result });
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
      // accountLocked is the single access control; the billing status is left
      // alone so the operator can still see what the account was.
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

// ---- Free trials ------------------------------------------------------------
// Operator-granted trial: creates (or converts) a family that is entitled until
// trialEndsAt, with no card on file. The nightly sweep expires it; entitlement
// also checks the timestamp directly so access ends on time regardless.
const TRIAL_DAY_OPTIONS = [7, 14];

app.post("/api/admin/trials", requireAdmin, async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const email = normalizeEmail(req.body?.email);
  const days = TRIAL_DAY_OPTIONS.includes(Number(req.body?.days)) ? Number(req.body.days) : 0;
  if (!name) return res.status(400).json({ error: "Name is required." });
  if (!isAllowedParentEmail(email)) return res.status(400).json({ error: parentEmailError(email) });
  if (!days) return res.status(400).json({ error: `Trial length must be one of: ${TRIAL_DAY_OPTIONS.join(", ")} days.` });

  const startedAt = nowIso();
  const endsAt = new Date(Date.now() + days * 86400000).toISOString();
  const result = mutateDb((db) => {
    const existing = db.families.find((item) => item.email === email);
    if (existing && !existing.anonymizedAt) {
      // Never silently downgrade a paying customer into a trial.
      if (existing.subscriptionStatus === "active") return { error: "That account already has an active subscription." };
      if (trialStillActive(existing)) return { error: "That account is already on a trial." };
    }
    const family = existing && !existing.anonymizedAt ? existing : normaliseFamily({ parentName: name, email, loginType: "Email" });
    family.parentName = name || family.parentName;
    family.plan = "Free Trial";
    family.subscriptionStatus = "trial";
    family.paymentStatus = "trial";
    family.accountLocked = false;
    family.trialStartedAt = startedAt;
    family.trialEndsAt = endsAt;
    family.trialDays = days;
    if (!existing || existing.anonymizedAt) db.families.unshift(family);
    if (!db.users.some((item) => item.email === email && item.role === "parent")) {
      db.users.push({
        id: makeId("usr"),
        role: "parent",
        name,
        email,
        familyId: family.id,
        emailVerified: true,
        passwordHash: hashPassword(crypto.randomBytes(18).toString("hex")),
        createdAt: startedAt
      });
    }
    audit(db, "trial.create", { familyId: family.id, email, days, endsAt }, req.auth?.email);
    monitor(db, "info", "billing", "Free trial granted", { email, days, endsAt }, email);
    return { family };
  });
  if (result.error) return res.status(409).json({ error: result.error });

  const tpl = renderTemplate("trial_started", { parentName: name, trialDays: days, trialEndsAt: endsAt });
  try {
    await sendEmail({ to: email, template: "Trial started", subject: tpl.subject, html: tpl.html, message: tpl.text });
  } catch (error) {
    mutateDb((db) => monitor(db, "warning", "email", "Trial start email failed", { email, detail: String(error.message || error) }, email));
  }
  return res.json({ ok: true, familyId: result.family.id, email, days, trialEndsAt: endsAt });
});

// Remove a trial account outright. Trials have no billing history to preserve,
// so this is a hard delete rather than the anonymise path real customers get.
// Guarded: refuses anything that has ever paid, so a converted trial is safe.
app.delete("/api/admin/trials/:familyId", requireAdmin, (req, res) => {
  const familyId = String(req.params.familyId || "");
  const result = mutateDb((db) => {
    const family = (db.families || []).find((item) => item.id === familyId);
    if (!family) return { error: "not_found" };
    if (!family.trialStartedAt) return { error: "Not a trial account." };
    if (family.subscriptionStatus === "active" || family.lastPaymentAt || family.stripeSubscriptionId) {
      return { error: "That account has billing history — cancel or anonymize it instead." };
    }
    const email = family.email;
    db.families = db.families.filter((item) => item.id !== familyId);
    db.users = (db.users || []).filter((item) => item.email !== email || item.role !== "parent");
    db.sessions = (db.sessions || []).filter((item) => item.email !== email);
    audit(db, "trial.delete", { familyId, email }, req.auth?.email);
    monitor(db, "info", "account", "Trial account deleted", { email }, req.auth?.email);
    return { email };
  });
  if (result.error === "not_found") return res.status(404).json({ error: "Trial account not found." });
  if (result.error) return res.status(409).json({ error: result.error });
  res.json({ ok: true, email: result.email });
});

// Dismiss abuse alerts. Marks signals reviewed rather than deleting them: the
// counters stay for history, and a family only re-flags on a NEW signal.
// Pass { familyId } to clear one account, omit it to clear all flagged ones.
app.post("/api/admin/abuse-alerts/dismiss", requireAdmin, (req, res) => {
  const familyId = String(req.body?.familyId || "").trim();
  const at = nowIso();
  const cleared = mutateDb((db) => {
    const targets = (db.families || []).filter((family) =>
      abuseFlagged(family) && (!familyId || family.id === familyId)
    );
    targets.forEach((family) => { family.abuse = { ...(family.abuse || {}), dismissedAt: at }; });
    audit(db, "abuse.alerts.dismiss", { familyId: familyId || "all", cleared: targets.length }, req.auth?.email);
    return targets.length;
  });
  res.json({ ok: true, cleared, dismissedAt: at });
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
    if (Object.prototype.hasOwnProperty.call(body, "tokensPerFamilyDaily")) {
      next.tokensPerFamilyDaily = Math.max(0, Number(body.tokensPerFamilyDaily) || 0);
    }
    if (Object.prototype.hasOwnProperty.call(body, "tutorVoiceEnabled")) {
      next.tutorVoiceEnabled = body.tutorVoiceEnabled !== false;
    }
    // Tutor voice shortlist + default + speech model + narration length.
    // normaliseAiSettings re-validates everything below: only supported voices,
    // never empty, default must be allowed (auto-fixed to marin -> cedar -> sage),
    // ttsModel constrained to SUPPORTED_TTS_MODELS, word targets/minutes clamped.
    if (Object.prototype.hasOwnProperty.call(body, "ttsModel")) {
      next.ttsModel = normaliseTtsModel(body.ttsModel);
    }
    if (Object.prototype.hasOwnProperty.call(body, "ttsAllowedVoices")) {
      next.ttsAllowedVoices = normaliseAllowedVoices(body.ttsAllowedVoices);
    }
    if (Object.prototype.hasOwnProperty.call(body, "ttsDefaultVoice")) {
      next.ttsDefaultVoice = String(body.ttsDefaultVoice || "");
    }
    if (Object.prototype.hasOwnProperty.call(body, "tutorExplainMaxWords")) {
      next.tutorExplainMaxWords = body.tutorExplainMaxWords;
    }
    if (Object.prototype.hasOwnProperty.call(body, "tutorStandardFraction")) {
      next.tutorStandardFraction = body.tutorStandardFraction;
    }
    next.updatedAt = nowIso();
    next.updatedBy = req.auth?.email || "admin";
    db.aiSettings = normaliseAiSettings(next);
    audit(db, "ai_settings.update", {
      hasOpenAIKey: Boolean(db.aiSettings.openaiApiKey),
      mathProblemsPerUserDaily: db.aiSettings.mathProblemsPerUserDaily,
      tutorVoiceMinutesPerUserDaily: db.aiSettings.tutorVoiceMinutesPerUserDaily,
      tutorVoiceEnabled: db.aiSettings.tutorVoiceEnabled,
      ttsModel: db.aiSettings.ttsModel,
      ttsDefaultVoice: db.aiSettings.ttsDefaultVoice,
      ttsAllowedVoices: db.aiSettings.ttsAllowedVoices,
      tutorExplainMaxWords: db.aiSettings.tutorExplainMaxWords,
      tutorStandardFraction: db.aiSettings.tutorStandardFraction
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
    // Account-wide daily token ceiling (all children, all tools). cap 0 = unlimited.
    accountTokens: (() => {
      const budget = familyTokenBudget(family, settings);
      return {
        cap: budget.cap,
        used: budget.used,
        remaining: budget.remaining === Infinity ? null : budget.remaining,
        exhausted: budget.exhausted
      };
    })(),
    requireSteps: limits.requireSteps,
    controls: limits.controls,
    aiConfigured: Boolean(settings.openaiApiKey),
    // Admin-controlled tutor voice policy — the student picks from `allowed`.
    voice: {
      allowed: settings.ttsAllowedVoices,
      default: settings.ttsDefaultVoice,
      model: settings.ttsModel
    },
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
      // Keep the weekly snapshot focused, but let the parent see the latest
      // meaningful activity even after a quiet week. Dates are intentionally
      // omitted by the portal UI; this is only the activity history source.
      activityHistory: progressRowsForChild(db, child.id),
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
  const hasWindow = days !== undefined && days !== null && days !== "" && Number.isFinite(Number(days));
  const cutoff = hasWindow ? Date.now() - Math.min(90, Math.max(1, Number(days))) * 86400000 : 0;
  return (db.studentProgress || [])
    .filter((r) => r.childId === childId)
    .filter((r) => {
      if (!cutoff) return true;
      const t = new Date((r.date || "") + "T00:00:00").getTime();
      return !t || t >= cutoff;
    })
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
    // Keep enough history to show a meaningful activity after a quiet season.
    // The parent UI only displays activity names, not historical dates.
    const cutoff = Date.now() - 730 * 86400000;
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
    .slice(0, 50)
    // Replies go out by email only, so strip them here too: the portal must not
    // become a chat surface, and reply text should not sit in a client payload.
    .map(({ replies, ...rest }) => rest);
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
  // Email is the ONLY way this reply reaches the parent — the portal shows no
  // thread. A silent failure would mean the operator believes they answered
  // while the parent hears nothing, so surface it instead of swallowing it.
  const tpl = renderTemplate("support_reply", { parentName: updated.parentName || "there", supportReply: reply });
  let delivery;
  try {
    delivery = await sendEmail({
      to: updated.email,
      template: "Support reply",
      subject: tpl.subject,
      html: tpl.html,
      message: tpl.text
    });
  } catch (error) {
    delivery = { mode: "failed", error: String(error.message || error) };
  }
  const delivered = Boolean(delivery) && delivery.mode !== "failed" && delivery.mode !== "mock";
  if (!delivered) {
    mutateDb((db) => {
      const entry = (db.supportMessages || []).find((m) => m.id === req.params.id);
      if (entry) { entry.deliveryFailed = true; entry.deliveryError = delivery?.error || delivery?.mode || "unknown"; }
      monitor(db, "error", "support", "Support reply email was not delivered", { id: req.params.id, email: updated.email, mode: delivery?.mode || "unknown", detail: delivery?.error || "" }, updated.email);
    });
    return res.json({
      ok: true,
      delivered: false,
      message: updated,
      warning: delivery?.mode === "mock"
        ? "Reply saved, but NO email was sent: no email provider is configured. Set the Postmark token in Emails."
        : `Reply saved, but the email failed to send (${delivery?.error || "unknown error"}). The parent has not been notified.`
    });
  }
  mutateDb((db) => {
    const entry = (db.supportMessages || []).find((m) => m.id === req.params.id);
    if (entry) { delete entry.deliveryFailed; delete entry.deliveryError; }
  });
  res.json({ ok: true, delivered: true, message: updated });
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
  // Email is the ONLY way this reply reaches the parent — the portal shows no
  // thread — so a failed send must not look like success.
  const tpl = renderTemplate("support_reply", { parentName: target.parentName || "there", supportReply: reply });
  let delivery;
  try {
    delivery = await sendEmail({ to: email, template: "Support reply", subject: tpl.subject, html: tpl.html, message: tpl.text });
  } catch (error) {
    delivery = { mode: "failed", error: String(error.message || error) };
  }
  const delivered = Boolean(delivery) && delivery.mode !== "failed" && delivery.mode !== "mock";
  mutateDb((db) => {
    const entry = (db.supportMessages || []).find((m) => m.id === target.id);
    if (entry) {
      if (delivered) { delete entry.deliveryFailed; delete entry.deliveryError; }
      else { entry.deliveryFailed = true; entry.deliveryError = delivery?.error || delivery?.mode || "unknown"; }
    }
    if (!delivered) monitor(db, "error", "support", "Support reply email was not delivered", { email, mode: delivery?.mode || "unknown", detail: delivery?.error || "" }, email);
  });
  if (!delivered) {
    return res.json({
      ok: true,
      delivered: false,
      warning: delivery?.mode === "mock"
        ? "Reply saved, but NO email was sent: no email provider is configured. Set the Postmark token in Emails."
        : `Reply saved, but the email failed to send (${delivery?.error || "unknown error"}). The parent has not been notified.`
    });
  }
  res.json({ ok: true, delivered: true });
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
          model: settings.openaiModel || "gpt-5.6-luna",
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
// A free trial entitles the family until trialEndsAt. The nightly sweep flips
// expired trials to "expired", but entitlement is checked against the timestamp
// too so access ends on time even if the sweep has not run yet.
function trialStillActive(family) {
  if (family?.subscriptionStatus !== "trial") return false;
  const endsAt = new Date(family.trialEndsAt || 0).getTime();
  return Number.isFinite(endsAt) && endsAt > Date.now();
}

function isFamilyEntitled(family) {
  if (!family || family.accountLocked) return false;
  return family.subscriptionStatus === "active" || cancellationStillActive(family) || trialStillActive(family) || stripeTrialActive(family) || hasActiveOverride(family);
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
  // Account-wide ceiling, checked for EVERY tool. The per-child math cap above
  // left writing and follow-up chat unbounded.
  const budget = familyTokenBudget(family, settings);
  if (budget.exhausted) {
    mutateDb((store) => recordAbuseSignal(store, family?.id, "cap"));
    return res.status(429).json({ error: "cap_reached", scope: "account_tokens", cap: budget.cap, used: budget.used });
  }
  // Bound the prompt server-side. `instructions` is client-supplied too, so it
  // counts against the same budget — capping only `input` would just move an
  // injection into the other field.
  const promptChars = aiInputTextLength(body.input) + String(body.instructions || "").length;
  if (promptChars > AI_MAX_INPUT_CHARS) {
    mutateDb((store) => monitor(store, "warning", "ai", "Oversized AI prompt rejected", { chars: promptChars, limit: AI_MAX_INPUT_CHARS, tool }, req.auth.email));
    mutateDb((store) => recordAbuseSignal(store, family?.id, "oversized"));
    return res.status(413).json({ error: "input_too_large", limit: AI_MAX_INPUT_CHARS, received: promptChars });
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
        model: body.model || settings.openaiModel || "gpt-5.6-luna",
        instructions,
        input: body.input,
        // Clamp rather than trust: the client's value was previously not
        // forwarded at all, so nothing bounded output length. A modified client
        // can send any number, so take the smaller of theirs and our ceiling.
        max_output_tokens: Math.min(
          Math.max(1, Number(body.max_output_tokens) || AI_MAX_OUTPUT_TOKENS),
          AI_MAX_OUTPUT_TOKENS
        )
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(response.status || 502).json({ error: "openai_error", detail: data });
    // Backstop: cap Tutor Explain narration server-side so a stale/modified
    // extension can't run up TTS cost. The tutor returns { title, script } as JSON
    // output text; clamp `script` to the admin word budget on a sentence boundary.
    if (tool === "tutor") {
      const maxWords = effectiveExplainMaxWords(settings, body.gradeBand, body.explainDepth);
      const parsed = safeParseJson(extractOutputText(data));
      if (parsed && typeof parsed.script === "string" && countWords(parsed.script) > maxWords) {
        parsed.script = clampNarrationWords(parsed.script, maxWords);
        data.output_text = JSON.stringify(parsed);
        delete data.output;
      }
    }
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
  const speechBudget = familyTokenBudget(family, settings);
  if (speechBudget.exhausted) {
    mutateDb((store) => recordAbuseSignal(store, family?.id, "cap"));
    return res.status(429).json({ error: "cap_reached", scope: "account_tokens", cap: speechBudget.cap, used: speechBudget.used });
  }
  const text = String(body.text || "").trim();
  if (!text) return res.status(400).json({ error: "empty_text" });
  // The tutor script is already word-clamped server-side, but a modified client
  // can post arbitrary text straight to this route.
  if (text.length > TTS_MAX_INPUT_CHARS) {
    mutateDb((store) => monitor(store, "warning", "ai", "Oversized TTS text rejected", { chars: text.length, limit: TTS_MAX_INPUT_CHARS }, req.auth.email));
    mutateDb((store) => recordAbuseSignal(store, family?.id, "oversized"));
    return res.status(413).json({ error: "input_too_large", limit: TTS_MAX_INPUT_CHARS, received: text.length });
  }
  // Resolve the voice server-side: student pick if allowed, else admin default,
  // else fallback order (marin -> cedar -> sage). Never trust a raw client voice.
  const voice = resolveTtsVoice(body.voice, settings);
  try {
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.openaiApiKey}` },
      body: JSON.stringify({
        model: settings.ttsModel,
        voice,
        input: text,
        // Spoken style resolved server-side from tutor mode + grade band, so the
        // client can't inject arbitrary TTS instructions.
        instructions: resolveSpeechInstruction(body.mode, body.gradeBand),
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

// Content safety for the extension, which screens both student input and model
// output through here before showing anything.
//
// Deliberately returns 503 — not 200 { flagged: false } — when the check cannot
// run. The extension fails CLOSED on a non-OK response, so collapsing an outage
// into "clean" would silently let unscreened text through, which is the opposite
// of what a kids product wants. Moderation does not count against usage caps: a
// safety check should never be rationed.
app.post("/api/ai/moderations", requireParent, async (req, res) => {
  const input = String(req.body?.input || "").trim();
  if (!input) return res.json({ flagged: false, categories: [] });
  const db = readDb();
  const settings = normaliseAiSettings(db.aiSettings);
  const family = parentFamilyForIdentity(db, req.auth);
  if (!settings.openaiApiKey) return res.status(503).json({ error: "ai_not_configured" });
  if (!isFamilyEntitled(family)) return res.status(402).json({ error: "subscription_inactive" });
  try {
    const { flagged, categories } = await moderationCheck(settings.openaiApiKey, input);
    if (flagged) {
      mutateDb((store) => {
        monitor(store, "warning", "safety", "Moderation flagged content", { email: family?.email || "", categories }, family?.email || "");
        recordAbuseSignal(store, family?.id, "moderation");
      });
    }
    return res.json({ flagged, categories });
  } catch (error) {
    mutateDb((store) => monitor(store, "error", "safety", "Moderation check failed", { detail: String(error.message || error) }, req.auth.email));
    return res.status(503).json({ error: "moderation_unavailable" });
  }
});

// ---- QR phone-capture --------------------------------------------------------
// A student photographs a physical-book math problem with their phone; the portal
// transcribes the image -> text (vision only, no solving) and hands the text to
// the extension's existing solve pipeline. The raw image is transient — never
// persisted; only the short transcription is stored, briefly, against a token.
const CAPTURE_TTL_MS = 5 * 60 * 1000;                 // token lifetime (~5 min)
const CAPTURE_MAX_IMAGE_BYTES = 5 * 1024 * 1024;      // ~5 MB decoded
const CAPTURE_RATE_WINDOW_MS = 60 * 1000;
const CAPTURE_RATE_MAX = 5;                           // sessions per family per window
const CAPTURE_TRANSCRIBE_INSTRUCTION = "You are KiddieGPT's math reader. Your only job is to read the image exactly and write down each math problem as text — do NOT solve anything. Read EVERY number, label, and angle. If there is a diagram, describe it completely: every side length, every angle with its value and vertex, which side or label is the unknown, and where each label sits. If the source has no readable math problem (blank, too blurry, or not math), return {\"noMath\": true, \"reason\": \"<one short kind sentence>\"} and nothing else. Return only valid JSON.";

function captureOrigin(req) {
  // Phones can't reach localhost; prod sets PUBLIC_ORIGIN, dev can set it to a
  // LAN IP or tunnel. Falls back to the request host.
  return process.env.PUBLIC_ORIGIN || process.env.CAPTURE_PUBLIC_ORIGIN || `${req.protocol}://${req.get("host")}`;
}
function pruneCaptureSessions(db) {
  const cutoff = Date.now() - 30 * 60 * 1000; // keep 30 min for late polls, then drop
  db.captureSessions = (db.captureSessions || []).filter((s) => new Date(s.createdAt || 0).getTime() >= cutoff).slice(0, 500);
}
function findCaptureSession(db, token) {
  return (db.captureSessions || []).find((s) => s.token === token) || null;
}
function captureExpired(session) {
  return !session || Date.now() > Number(session.expiresAt || 0);
}
function safeParseJson(raw) {
  if (!raw) return null;
  const text = String(raw).trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(text); } catch { return null; }
}
// Throws if the check could not be performed. Callers that must fail CLOSED
// (POST /api/ai/moderations) have to tell "checked and clean" apart from "could
// not check" — moderationFlagged() below deliberately collapses that distinction.
async function moderationCheck(apiKey, text) {
  if (!apiKey) throw new Error("moderation_not_configured");
  const r = await fetch("https://api.openai.com/v1/moderations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "omni-moderation-latest", input: String(text).slice(0, 4000) })
  });
  if (!r.ok) throw new Error(`moderation_upstream_${r.status}`);
  const d = await r.json().catch(() => ({}));
  const result = d.results && d.results[0];
  if (!result) throw new Error("moderation_malformed_response");
  return {
    flagged: Boolean(result.flagged),
    categories: Object.keys(result.categories || {}).filter((key) => result.categories[key])
  };
}

async function moderationFlagged(apiKey, text) {
  if (!apiKey || !text) return false;
  try {
    return (await moderationCheck(apiKey, text)).flagged;
  } catch { return false; } // fail-open: don't block a kid's math on a moderation outage
}

function renderCapturePage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>KiddieGPT — Scan your problem</title>
<style>
  *{box-sizing:border-box} body{margin:0;font-family:-apple-system,Inter,Arial,sans-serif;background:#eef5f1;color:#173c36;
    min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
  .card{width:100%;max-width:400px;background:#fff;border-radius:22px;padding:26px;text-align:center;
    box-shadow:0 20px 50px rgba(0,60,50,.14);display:flex;flex-direction:column;gap:14px}
  h1{margin:0;font-size:22px;color:#004f48} p{margin:0;font-size:15px;color:#4f6b67;line-height:1.45}
  button{padding:14px;border:none;border-radius:999px;font-size:16px;font-weight:800;cursor:pointer}
  .cam{display:flex;align-items:center;justify-content:center;gap:8px;padding:16px;border-radius:16px;
    background:#004f48;color:#fff;font-size:17px;font-weight:800;cursor:pointer}
  .stage{position:relative;width:100%;border-radius:14px;overflow:hidden;border:1px solid #d6e6e1;
    touch-action:none;user-select:none;cursor:crosshair}
  #preview{width:100%;display:block;-webkit-user-drag:none}
  .crop{position:absolute;border:2px dashed #fff;box-shadow:0 0 0 9999px rgba(0,0,0,.45);border-radius:3px;pointer-events:auto;cursor:move;touch-action:none}
  .handle{position:absolute;width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,.95);border:2px solid #0f8a63;pointer-events:auto;touch-action:none}
  .handle.tl{left:-16px;top:-16px} .handle.tr{right:-16px;top:-16px} .handle.bl{left:-16px;bottom:-16px} .handle.br{right:-16px;bottom:-16px}
  .actions{display:flex;gap:10px}
  #send{flex:1;background:#0f8a63;color:#fff} #send:disabled,#retake:disabled{opacity:.6}
  .ghost{background:#eef3f1;color:#004f48}
  .link{background:none;border:none;color:#4f6b67;text-decoration:underline;font-size:13px;font-weight:600;padding:0;cursor:pointer}
  .done{font-size:44px} #status{min-height:18px;font-weight:600}
  [hidden]{display:none!important}
  #camera{display:flex;flex-direction:column;gap:12px;align-items:center}
  .viewfinder{position:relative;width:100%;background:#000;border-radius:14px;overflow:hidden;max-height:62vh}
  #video{width:100%;display:block;max-height:62vh;object-fit:cover}
  .shutter{width:74px;height:74px;border-radius:50%;background:#fff;border:5px solid #0f8a63;box-shadow:0 4px 14px rgba(0,0,0,.2);margin:2px auto 0;padding:0}
  .shutter:active{transform:scale(.94)}
  .brand{align-self:flex-start;font-size:15px;font-weight:800;color:#004f48;letter-spacing:.2px}
</style></head>
<body><div class="card" id="card">
  <div class="brand">KiddieGPT</div>
  <h1 id="title" hidden></h1>
  <p id="hint"></p>
  <div id="camera" hidden>
    <div class="viewfinder"><video id="video" playsinline muted autoplay></video></div>
    <button id="shutter" class="shutter" type="button" aria-label="Take photo"></button>
  </div>
  <label class="cam" id="fallback" hidden><input id="file" type="file" accept="image/*" capture="environment" hidden><span>📷 Take photo</span></label>
  <div id="editor" hidden>
    <div class="stage" id="stage"><img id="preview" alt="" draggable="false"><div class="crop" id="crop" hidden><div class="handle tl" data-h="tl"></div><div class="handle tr" data-h="tr"></div><div class="handle bl" data-h="bl"></div><div class="handle br" data-h="br"></div></div></div>
    <div class="actions"><button id="send" type="button">Crop &amp; Send</button><button id="retake" class="ghost" type="button">Retake</button></div>
  </div>
  <p id="status"></p>
</div>
<script>
(function(){
  var parts=location.pathname.split("/").filter(Boolean);
  var uploadUrl="/api/capture/"+parts[parts.length-1]+"/image";
  var $=function(id){return document.getElementById(id);};
  var hint=$("hint"),camera=$("camera"),video=$("video"),shutter=$("shutter"),
      fallback=$("fallback"),file=$("file"),editor=$("editor"),stage=$("stage"),
      preview=$("preview"),cropEl=$("crop"),sendBtn=$("send"),retakeBtn=$("retake"),
      title=$("title"),statusEl=$("status");
  var stream=null,srcUrl="",srcImg=new Image(),crop=null,drag=null,usingCamera=false;
  function setStatus(m,err){statusEl.textContent=m||"";statusEl.style.color=err?"#b23a48":"#4f6b67";}
  var stageW=0,stageH=0,mode=null,activeCorner=null,last=null;
  function measure(){var r=stage.getBoundingClientRect();stageW=r.width;stageH=r.height;return r;}
  function drawCrop(){
    if(!crop){cropEl.hidden=true;return;}
    cropEl.style.left=crop.x+"px";cropEl.style.top=crop.y+"px";cropEl.style.width=crop.w+"px";cropEl.style.height=crop.h+"px";
    cropEl.hidden=false;
  }
  // Pre-fill an adjustable crop box (centered band) the user nudges to frame one problem.
  function initCrop(){
    measure();
    var w=Math.round(stageW*0.82),h=Math.round(stageH*0.34);
    crop={x:Math.round((stageW-w)/2),y:Math.round((stageH-h)/2),w:w,h:h};
    drawCrop();
  }
  function view(which){
    camera.hidden=which!=="camera";fallback.hidden=which!=="fallback";editor.hidden=which!=="editor";
    var t=which==="editor"?"Crop your math problem":which==="fallback"?"Snap your math problem":"";
    title.textContent=t; title.hidden=!t;
    hint.textContent=which==="camera"?"Point at one problem and click."
      :which==="fallback"?"Take a photo of one problem from the book."
      :"Make sure it's sharp and clear.";
  }
  function stopCamera(){if(stream){try{stream.getTracks().forEach(function(t){t.stop();});}catch(e){}stream=null;}}
  function startCamera(){
    setStatus("Starting camera…");
    navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"}},audio:false})
      .then(function(s){stream=s;video.srcObject=s;var p=video.play();if(p&&p.catch)p.catch(function(){});view("camera");setStatus("");})
      .catch(function(){usingCamera=false;view("fallback");setStatus("Camera not available — use the button.",true);});
  }
  function downscale(el,w,h){
    var max=1600,scale=Math.min(1,max/Math.max(w,h));
    var dw=Math.round(w*scale),dh=Math.round(h*scale);
    var c=document.createElement("canvas");c.width=dw;c.height=dh;
    c.getContext("2d").drawImage(el,0,0,dw,dh);
    return c.toDataURL("image/jpeg",0.85);
  }
  function useImage(url){
    srcUrl=url; srcImg.src=url;
    preview.onload=function(){view("editor");initCrop();setStatus("");};
    preview.src=url;
  }
  shutter.addEventListener("click",function(){
    if(!video.videoWidth){setStatus("Camera is still starting…");return;}
    var url=downscale(video,video.videoWidth,video.videoHeight);stopCamera();useImage(url);
  });
  file.addEventListener("change",function(){
    var f=file.files&&file.files[0]; if(!f)return;
    var reader=new FileReader();
    reader.onload=function(){
      var img=new Image();
      img.onload=function(){useImage(downscale(img,img.width,img.height));};
      img.onerror=function(){setStatus("Couldn't read that photo. Try again.",true);};
      img.src=reader.result;
    };
    reader.onerror=function(){setStatus("Couldn't read that photo. Try again.",true);};
    reader.readAsDataURL(f);
  });
  function pt(e){var r=measure();return{x:Math.min(Math.max(e.clientX-r.left,0),stageW),y:Math.min(Math.max(e.clientY-r.top,0),stageH)};}
  Array.prototype.forEach.call(cropEl.querySelectorAll(".handle"),function(hEl){
    hEl.addEventListener("pointerdown",function(e){e.preventDefault();e.stopPropagation();try{stage.setPointerCapture(e.pointerId);}catch(x){}mode="resize";activeCorner=hEl.getAttribute("data-h");});
  });
  cropEl.addEventListener("pointerdown",function(e){e.preventDefault();try{stage.setPointerCapture(e.pointerId);}catch(x){}mode="move";last=pt(e);});
  stage.addEventListener("pointermove",function(e){
    if(!mode||!crop)return; e.preventDefault(); var p=pt(e);
    if(mode==="resize"){
      var minS=28,left=crop.x,top=crop.y,right=crop.x+crop.w,bottom=crop.y+crop.h;
      if(activeCorner.indexOf("l")>=0)left=Math.min(p.x,right-minS);
      if(activeCorner.indexOf("r")>=0)right=Math.max(p.x,left+minS);
      if(activeCorner.indexOf("t")>=0)top=Math.min(p.y,bottom-minS);
      if(activeCorner.indexOf("b")>=0)bottom=Math.max(p.y,top+minS);
      crop={x:left,y:top,w:right-left,h:bottom-top};
    }else if(mode==="move"&&last){
      var dx=p.x-last.x,dy=p.y-last.y; last=p;
      crop.x=Math.min(Math.max(crop.x+dx,0),stageW-crop.w);
      crop.y=Math.min(Math.max(crop.y+dy,0),stageH-crop.h);
    }
    drawCrop();
  });
  stage.addEventListener("pointerup",function(){mode=null;activeCorner=null;last=null;});
  retakeBtn.addEventListener("click",function(){crop=null;drawCrop();if(usingCamera){startCamera();}else{file.value="";file.click();}});
  function outputDataUrl(){
    if(crop&&crop.w>=12&&crop.h>=12){
      var r=stage.getBoundingClientRect();
      var sc=srcImg.naturalWidth/r.width;
      var sx=Math.round(crop.x*sc),sy=Math.round(crop.y*sc),sw=Math.max(1,Math.round(crop.w*sc)),sh=Math.max(1,Math.round(crop.h*sc));
      var cn=document.createElement("canvas");cn.width=sw;cn.height=sh;
      cn.getContext("2d").drawImage(srcImg,sx,sy,sw,sh,0,0,sw,sh);
      return cn.toDataURL("image/jpeg",0.85);
    }
    return srcUrl;
  }
  sendBtn.addEventListener("click",function(){
    if(!srcUrl)return; sendBtn.disabled=true;retakeBtn.disabled=true;setStatus("Sending…");
    fetch(uploadUrl,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({image:outputDataUrl()})})
      .then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d};});})
      .then(function(res){
        if(res.ok){document.getElementById("card").innerHTML="<div class='done'>✅</div><h1>Sent!</h1><p>Check your KiddieGPT extension on your laptop.</p>";}
        else{sendBtn.disabled=false;retakeBtn.disabled=false;setStatus((res.d&&res.d.error==="already_used")?"Already sent. Make a new QR in KiddieGPT.":"Couldn't send. Try again.",true);}
      })
      .catch(function(){sendBtn.disabled=false;retakeBtn.disabled=false;setStatus("No connection. Try again.",true);});
  });
  // Live camera needs a secure context (HTTPS or localhost). On plain HTTP the
  // camera API is blocked by the browser, so fall back to the native photo button.
  if(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia){usingCamera=true;startCamera();}
  else{usingCamera=false;view("fallback");}
})();
</script></body></html>`;
}

function renderCaptureExpiredPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>KiddieGPT</title>
<style>body{margin:0;font-family:-apple-system,Inter,Arial,sans-serif;background:#eef5f1;color:#173c36;min-height:100vh;
  display:flex;align-items:center;justify-content:center;padding:20px}
  .card{max-width:360px;background:#fff;border-radius:22px;padding:28px;text-align:center;box-shadow:0 20px 50px rgba(0,60,50,.14)}
  h1{margin:0 0 8px;color:#004f48;font-size:22px}p{margin:0;color:#4f6b67;line-height:1.45}</style></head>
<body><div class="card"><div style="font-size:40px">⏳</div><h1>This link expired</h1>
<p>Generate a new QR code in your KiddieGPT extension and scan again.</p></div></body></html>`;
}

// 1) Mint a short-lived, single-use capture token bound to {family, child}.
app.post("/api/capture/session", requireParent, (req, res) => {
  const body = req.body || {};
  const result = mutateDb((db) => {
    const family = parentFamilyForIdentity(db, req.auth);
    if (!family) return { error: "family_not_found" };
    const child = ownedChild(family, body.childId);
    if (!child) return { error: "not_your_child" };
    pruneCaptureSessions(db);
    const recent = (db.captureSessions || []).filter((s) => s.familyId === family.id && Date.now() - new Date(s.createdAt || 0).getTime() < CAPTURE_RATE_WINDOW_MS);
    if (recent.length >= CAPTURE_RATE_MAX) return { error: "rate_limited" };
    const session = {
      token: "cap_" + crypto.randomBytes(24).toString("hex"),
      familyId: family.id,
      childId: child.id,
      gradeBand: String(body.gradeBand || child.grade || "6-8").slice(0, 12),
      status: "waiting",
      problems: null,
      reason: "",
      createdAt: nowIso(),
      expiresAt: Date.now() + CAPTURE_TTL_MS,
      used: false
    };
    db.captureSessions.unshift(session);
    return { ok: true, token: session.token, expiresAt: session.expiresAt };
  });
  if (result.error === "family_not_found") return res.status(404).json({ error: "family_not_found" });
  if (result.error === "not_your_child") return res.status(403).json({ error: "not_your_child" });
  if (result.error === "rate_limited") return res.status(429).json({ error: "rate_limited" });
  res.json({ token: result.token, captureUrl: `${captureOrigin(req)}/capture/${result.token}`, expiresAt: result.expiresAt });
});

// 2) Mobile capture page (no auth — the token IS the scoped credential).
app.get("/capture/:token", (req, res) => {
  const session = findCaptureSession(readDb(), req.params.token);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(!session || session.used || captureExpired(session) ? renderCaptureExpiredPage() : renderCapturePage());
});

// 3) Phone uploads the photo -> transcribe -> moderate -> store text (image is transient).
app.post("/api/capture/:token/image", async (req, res) => {
  const token = req.params.token;
  // Claim the token single-use and flip to "solving" atomically.
  const claim = mutateDb((db) => {
    const session = findCaptureSession(db, token);
    if (!session) return { error: "not_found" };
    if (captureExpired(session)) { session.status = "expired"; return { error: "expired" }; }
    if (session.used) return { error: "used" };
    session.used = true;
    session.status = "solving";
    return { ok: true, gradeBand: session.gradeBand };
  });
  if (claim.error === "not_found" || claim.error === "expired") return res.status(410).json({ error: claim.error });
  if (claim.error === "used") return res.status(409).json({ error: "already_used" });

  const setSession = (patch) => mutateDb((db) => { const s = findCaptureSession(db, token); if (s) Object.assign(s, patch); });
  const dataUrl = String((req.body && req.body.image) || "");
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(dataUrl);
  if (!match) { setSession({ status: "error", reason: "That didn't look like a photo. Try again." }); return res.status(400).json({ error: "bad_image" }); }
  if (Buffer.byteLength(match[2], "base64") > CAPTURE_MAX_IMAGE_BYTES) { setSession({ status: "error", reason: "That photo is too large. Try again." }); return res.status(413).json({ error: "too_large" }); }

  const settings = normaliseAiSettings(readDb().aiSettings);
  if (!settings.openaiApiKey) { setSession({ status: "error", reason: "The tutor isn't set up yet. Ask a parent." }); return res.json({ ok: true }); }
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.openaiApiKey}` },
      body: JSON.stringify({
        model: settings.openaiModel,
        instructions: CAPTURE_TRANSCRIBE_INSTRUCTION,
        input: [{ role: "user", content: [
          { type: "input_text", text: `Read this photo and list every math problem in reading order, up to 15. Grade band: ${claim.gradeBand}. Return JSON with a problems array. Each item: statement (full question in plain words), meta (short topic like "Geometry · right triangle"), diagram (complete text description of any figure so it can be solved without the image, or "" if none).` },
          { type: "input_image", image_url: dataUrl }
        ] }]
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setSession({ status: "error", reason: "Couldn't read that photo. Try a clearer picture." });
      mutateDb((store) => monitor(store, "error", "ai", "Capture transcription failed", { detail: String(data?.error?.message || "") }));
      return res.json({ ok: true });
    }
    const parsed = safeParseJson(extractOutputText(data));
    if (!parsed || parsed.noMath) { setSession({ status: "error", reason: (parsed && parsed.reason) || "I couldn't find a math problem in that photo." }); return res.json({ ok: true }); }
    const problems = (Array.isArray(parsed.problems) ? parsed.problems : []).slice(0, 15).map((p) => Object.assign({
      statement: String(p.statement || p.equation || "").slice(0, 1000),
      diagram: String(p.diagram || "").slice(0, 1500),
      meta: String(p.meta || "").slice(0, 120)
    }, p.figure ? { figure: p.figure } : {})).filter((p) => p.statement);
    if (!problems.length) { setSession({ status: "error", reason: "I couldn't find a math problem in that photo." }); return res.json({ ok: true }); }
    if (await moderationFlagged(settings.openaiApiKey, problems.map((p) => p.statement + " " + p.diagram).join("\n"))) {
      setSession({ status: "error", reason: "That doesn't look like schoolwork." });
      return res.json({ ok: true });
    }
    setSession({ status: "ready", problems, reason: "" });
    res.json({ ok: true });
  } catch (error) {
    setSession({ status: "error", reason: "Something went wrong. Try again." });
    mutateDb((store) => monitor(store, "error", "ai", "Capture transcription error", { detail: String(error.message || error) }));
    res.json({ ok: true });
  }
});

// 4) Extension polls for the transcription (must own the session).
app.get("/api/capture/:token/result", requireParent, (req, res) => {
  const db = readDb();
  const family = parentFamilyForIdentity(db, req.auth);
  const session = findCaptureSession(db, req.params.token);
  if (!session) return res.json({ status: "expired" });
  if (!family || session.familyId !== family.id) return res.status(403).json({ error: "not_your_session" });
  if (session.status === "ready") return res.json({ status: "ready", problems: session.problems || [] });
  if (session.status === "error") return res.json({ status: "error", reason: session.reason || "Couldn't read that photo." });
  if (captureExpired(session) && session.status !== "solving") return res.json({ status: "expired" });
  return res.json({ status: session.status === "solving" ? "solving" : "waiting" });
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
  // Single source of truth — this used to re-implement the rule inline and drifted
  // (it missed free trials, so a trialling family reported active: false).
  const active = isFamilyEntitled(family);
  // Admin-controlled tutor voice policy — the extension builds its student voice
  // picker (shortlist + default) from these fields on the session.
  const voiceSettings = normaliseAiSettings(readDb().aiSettings);
  res.json({
    active,
    status: family.subscriptionStatus,
    locked: family.accountLocked,
    plan: effectiveFamilyPlan(family),
    familyId: family.id,
    // The extension builds its student picker from this. Children are stored with
    // `studentName`/`grade`; expose the { id, name, grade } shape it expects.
    children: (Array.isArray(family.children) ? family.children : []).map((c) => ({
      id: c.id,
      name: c.studentName || c.name || "",
      grade: c.grade || ""
    })),
    ttsAllowedVoices: voiceSettings.ttsAllowedVoices,
    ttsDefaultVoice: voiceSettings.ttsDefaultVoice,
    ttsModel: voiceSettings.ttsModel,
    // Tutor length + style config the extension folds into its prompt + cache keys.
    speechStyleVersion: SPEECH_STYLE_VERSION,
    tutorExplainMaxWords: voiceSettings.tutorExplainMaxWords,
    tutorStandardFraction: voiceSettings.tutorStandardFraction,
    deepDiveBands: DEEP_DIVE_BANDS,
    wordsPerMinute: WORDS_PER_MINUTE,
    tutorConfigVersion: tutorConfigVersion(voiceSettings.tutorExplainMaxWords, voiceSettings.tutorStandardFraction),
    createdAt: family.createdAt || "",
    paymentStatus: family.paymentStatus || "",
    overrideUntil: family.entitlementOverrideUntil || "",
    // yearlyNextRenewalAt is unix seconds (straight off Stripe) while the other
    // two are ISO strings. Emitting the raw mix made the client do
    // new Date(1900000000) -> "January 23, 1970"; always hand back ISO.
    // Only a *live* upgrade supplies the renewal date. A retired one (refunded,
    // cancelled, downgraded) kept its yearly date on record, so a family back on
    // monthly billing was told "Renews monthly - next on <the dead yearly date>".
    renewalAt: isoDateOrEmpty((hasConfirmedYearlyUpgrade(family) && family.yearlyUpgrade.yearlyNextRenewalAt) || family.currentPeriodEnd || family.nextRenewalAt || ""),
    cancelAccessUntil: family.cancelAccessUntil || family.cancellationAccessUntil || "",
    cancellationStatus: family.cancellationStatus || "",
    cancelReason: family.cancelReason || "",
    // Lets the portal tell the parent what cancelling will actually do before
    // they confirm: full refund + access ends now, or access to the period end.
    refundWindow: refundWindowFor(family),
    // Card-upfront Stripe trial: the portal shows the end date and when billing
    // starts; the extension only needs `active`, which already covers trialing.
    trial: {
      // Still reported while a cancelled trial runs out its term: the status has
      // moved to cancel_scheduled, but the family is in a trial until trial_end
      // and must keep seeing "you will not be charged" rather than billing copy.
      // "trial"    = admin-granted, no card, parent still needs to subscribe.
      // "trialing" = Stripe card-upfront trial (kept while a cancelled one runs
      //              out its term, which is why the second clause exists — but
      //              it requires a Stripe subscription so a comped trial never
      //              matches it).
      status: family.subscriptionStatus === "trial"
        ? "trial"
        : (family.subscriptionStatus === "trialing" ||
           (family.stripeSubscriptionId && family.paymentStatus === "trial" && !family.lastPaymentAt &&
            new Date(family.trialEndsAt || 0).getTime() > Date.now()))
          ? "trialing"
          : "",
      endsAt: family.trialEndsAt || "",
      days: Number(family.trialDays) || TRIAL_PERIOD_DAYS,
      cardOnFile: Boolean(family.stripeSubscriptionId),
      // Whether a NEW self-serve trial would be granted at checkout — lets the
      // portal avoid promising a free week to someone who has already had one.
      eligible: eligibleForTrial(family),
      // Whether a NEW self-serve trial would be granted at checkout.
      eligible: eligibleForTrial(family)
    },
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
        // A family already on a trial keeps its status until Stripe confirms the
        // payment. Flipping it to "pending" here would revoke access the moment
        // they opened Checkout — before they had paid anything.
        const onTrialNow = trialStillActive(family) || family.subscriptionStatus === "trialing";
        if (alreadyActive || onTrialNow) {
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

  // A yearly upgrade is not a new subscription; neither is a reactivation.
  const trialEligible = !req.body?.yearlyUpgrade && eligibleForTrial(checkoutFamily);

  if (!process.env.STRIPE_SECRET_KEY) {
    // Demo checkout: record the session so confirm-checkout-session can activate
    // the family the way the Stripe webhook does in production. Without this the
    // parent bounces back to "Choose a family plan" and can never enrol.
    const mockSessionId = "cs_mock_" + crypto.randomBytes(9).toString("hex");
    mutateDb((db) => {
      db.mockCheckouts.unshift({
        sessionId: mockSessionId,
        familyId: checkoutFamilyId || "",
        email: parentEmail || "",
        planName: planName || "",
        trialDays: trialEligible ? TRIAL_PERIOD_DAYS : 0,
        promoCode: checkoutPromotion?.code || promoCode || "",
        amountCents: Math.round(Number(checkoutPromotion?.promoPrice || selectedPlan?.amount || 0) * 100),
        createdAt: nowIso()
      });
      db.mockCheckouts = db.mockCheckouts.slice(0, 50);
      audit(db, "stripe.checkout.mock_create", { sessionId: mockSessionId, familyId: checkoutFamilyId, parentEmail, planName: planName || "" });
    });
    return res.json({
      mode: "mock",
      sessionId: mockSessionId,
      url: successUrl
        ? String(successUrl).replace("{CHECKOUT_SESSION_ID}", mockSessionId)
        : `/index.html?stripe=success&session_id=${mockSessionId}`,
      message: "Stripe secret key is not configured. Demo checkout was simulated.",
      promotion: checkoutPromotion,
      trialDays: trialEligible ? TRIAL_PERIOD_DAYS : 0
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
        },
        // Card-upfront trial: Stripe still collects the card at Checkout (the
        // default for subscription mode — payment_method_collection is
        // deliberately left alone so it is NOT "if_required"), bills nothing for
        // the trial, then charges automatically unless the parent cancels.
        // Applies to monthly and yearly alike; skipped for upgrades/reactivations.
        ...(trialEligible ? { trial_period_days: TRIAL_PERIOD_DAYS } : {})
      }
    };
    if (couponId) {
      sessionPayload.discounts = [{ coupon: couponId }];
    } else {
      sessionPayload.allow_promotion_codes = true;
    }
    const session = await stripe.checkout.sessions.create(sessionPayload);
    mutateDb((db) => audit(db, "stripe.checkout.create", { sessionId: session.id, familyId: checkoutFamilyId, parentEmail, promoCode: checkoutPromotion?.code || "" }));
    return res.json({ mode: "stripe", sessionId: session.id, url: session.url, promotion: checkoutPromotion, trialDays: trialEligible ? TRIAL_PERIOD_DAYS : 0 });
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
    // Mirror the webhook's checkout.session.completed side-effects so the demo
    // flow can actually enrol (and re-enrol after a cancellation/refund).
    const activated = mutateDb((db) => {
      const pending = db.mockCheckouts.find((item) => item.sessionId === sessionId);
      const email = normalizeEmail(pending?.email || req.body?.parentEmail || req.body?.email || "");
      const family = db.families.find((item) =>
        (pending?.familyId && item.id === pending.familyId) || (email && item.email === email)
      );
      if (!family) return null;
      const trialDays = Math.max(0, Number(pending?.trialDays || 0));
      const trialing = trialDays > 0;
      const trialEndsAt = trialing
        ? new Date(Date.now() + trialDays * 86400000).toISOString()
        : "";
      const paymentId = trialing ? "" : "pi_mock_" + crypto.randomBytes(6).toString("hex");
      family.subscriptionStatus = trialing ? "trialing" : "active";
      family.paymentStatus = trialing ? "trial" : "paid";
      family.plan = pending?.planName || family.pendingPlanName || family.plan;
      delete family.pendingPlanName;
      family.stripeCustomerId = family.stripeCustomerId || "cus_mock_" + crypto.randomBytes(6).toString("hex");
      family.stripeSubscriptionId = "sub_mock_" + crypto.randomBytes(6).toString("hex");
      family.stripePaymentId = paymentId;
      family.trialDays = trialDays;
      family.trialUsedAt = trialing ? nowIso() : family.trialUsedAt || "";
      family.trialEndsAt = trialEndsAt;
      if (trialing) {
        delete family.lastPaymentAt;
        delete family.lastPaymentAmountCents;
        delete family.lastPaymentCurrency;
      } else {
        family.lastPaymentAt = nowIso();
      }
      // Only the real Stripe webhook used to set this, so in mock mode - which
      // is every install without STRIPE_SECRET_KEY - a parent who had just
      // subscribed was shown no renewal date at all. Derive it from the plan.
      const periodStart = new Date();
      const nextPeriodEnd = new Date(periodStart);
      if (trialing && trialEndsAt) {
        nextPeriodEnd.setTime(new Date(trialEndsAt).getTime());
      } else if (String(family.plan || "").toLowerCase().includes("year")) {
        nextPeriodEnd.setFullYear(nextPeriodEnd.getFullYear() + 1);
      } else {
        nextPeriodEnd.setMonth(nextPeriodEnd.getMonth() + 1);
      }
      family.currentPeriodEnd = nextPeriodEnd.toISOString();
      // Starting a new subscription clears any prior cancellation/refund state.
      family.cancellationRequested = false;
      family.cancellationStatus = "";
      family.cancelAtPeriodEnd = false;
      family.cancelReason = "";
      family.cancelAccessUntil = "";
      family.cancellationAccessUntil = "";
      family.cancelledAt = "";
      delete family.refundedAt;
      if (!trialing) {
        recordStripePayment(db, {
          id: `mock_${sessionId}`,
          type: "checkout.session.completed"
        }, {
          id: paymentId,
          amount_total: Number(pending?.amountCents || 0),
          currency: "usd",
          customer: family.stripeCustomerId,
          subscription: family.stripeSubscriptionId,
          status: "paid",
          created: Math.floor(Date.now() / 1000),
          metadata: { parentEmail: family.email, planName: family.plan, promoCode: pending?.promoCode || "" }
        }, family);
      }
      retireYearlyUpgrade(family);
      db.mockCheckouts = db.mockCheckouts.filter((item) => item.sessionId !== sessionId);
      audit(db, "stripe.checkout.mock_confirm", { sessionId, familyId: family.id, email: family.email, plan: family.plan });
      return family;
    });
    if (!activated) {
      return res.json({ mode: "mock", active: false, message: "Demo checkout session not found." });
    }
    return res.json({ mode: "mock", active: true, plan: activated.plan, message: "Demo checkout was simulated." });
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
      // Upgrading is an explicit renewal, so any pending cancellation is off.
      next.cancellationRequested = false;
      next.cancellationStatus = "";
      next.cancelAtPeriodEnd = false;
      next.cancelAccessUntil = "";
      next.cancellationAccessUntil = "";
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

app.post("/api/stripe/apply-retention-discount", requireParent, async (req, res) => {
  const email = normalizeEmail(req.auth?.email || req.body?.email || req.body?.parentEmail || "");
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
  const cancellationPromo = normalisePricing(readDb().pricing).cancellationPromo;
  if (!cancellationPromo.enabled || Number(cancellationPromo.amountOff || 0) <= 0) {
    return res.status(400).json({ error: "The cancellation save offer is not currently available." });
  }
  const trialing = existingFamily.subscriptionStatus === "trialing";
  if (!trialing && existingFamily.subscriptionStatus !== "active") {
    return res.status(400).json({ error: "A cancellation save offer can only be applied to an active subscription or card-upfront trial." });
  }
  if (!process.env.STRIPE_SECRET_KEY || !existingFamily.stripeSubscriptionId || existingFamily.stripeSubscriptionId.startsWith("sub_mock")) {
    if (existingFamily.retentionOffer?.status === "accepted") {
      return res.json({
        mode: existingFamily.retentionOffer.mode || "stored",
        alreadyApplied: true,
        familyId: existingFamily.id,
        couponId: existingFamily.retentionOffer.stripeCouponId || "",
        amountOff: cancellationPromo.amountOff,
        message: `The $${cancellationPromo.amountOff} save offer is already applied to the next invoice.`
      });
    }
    const updated = mutateDb((db) => {
      const family = db.families.find((item) => item.email === email);
      if (!family) return null;
      family.subscriptionStatus = trialing ? "trialing" : "active";
      family.paymentStatus = trialing ? "trial" : (family.paymentStatus || "paid");
      family.retentionOffer = {
        status: "accepted",
        mode: "mock",
        amountOff: cancellationPromo.amountOff,
        duration: cancellationPromo.duration,
        appliesTo: "next_invoice",
        description: cancellationPromo.description,
        reason,
        acceptedAt: nowIso()
      };
      audit(db, "retention.discount.mock", { familyId: family.id, email, reason });
      return family;
    });
    return res.json({
      mode: "mock",
      familyId: updated?.id || existingFamily.id,
      amountOff: cancellationPromo.amountOff,
      message: `The $${cancellationPromo.amountOff} save offer was recorded for the next renewal. Stripe discount application was simulated.`
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
      updatedSubscriptions.push(await applySubscriptionCoupon(stripe, subscription.id, couponId, cancellationPromo.amountOff));
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
      family.subscriptionStatus = trialing ? "trialing" : "active";
      family.paymentStatus = trialing ? "trial" : (family.paymentStatus || "paid");
      family.stripeCustomerId = primarySubscription.customer || family.stripeCustomerId;
      family.stripeSubscriptionId = primarySubscription.id || family.stripeSubscriptionId;
      family.stripeDuplicateSubscriptionIds = duplicateSubscriptionIds;
      family.retentionOffer = {
        status: "accepted",
        mode: "stripe",
        amountOff: cancellationPromo.amountOff,
        duration: cancellationPromo.duration,
        appliesTo: "next_invoice",
        description: cancellationPromo.description,
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
      amountOff: cancellationPromo.amountOff,
      message: duplicateSubscriptionIds.length
          ? `The $${cancellationPromo.amountOff} save offer was applied, but multiple active Stripe subscriptions exist for this parent email.`
          : toUpdate.length
          ? `The $${cancellationPromo.amountOff} save offer was applied to the next Stripe invoice.`
          : `The $${cancellationPromo.amountOff} save offer is already applied to the next invoice.`
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
  // past_due is deliberately included: a parent whose card is failing is exactly
  // who needs a clean exit, or a chargeback becomes their only option.
  if (!["active", "cancel_scheduled", "trialing", "trial", "past_due"].includes(existingFamily.subscriptionStatus)) {
    return res.status(400).json({ error: "This subscription cannot be cancelled." });
  }

  // Inside the refund window this is a full refund + immediate end, not a
  // scheduled cancellation. Outside it, fall through to cancel-at-period-end.
  // A trial has not been charged, so there is nothing to refund — cancelling
  // during one simply stops it at trial_end.
  const refundWindow = existingFamily.subscriptionStatus === "trialing"
    ? { eligible: false, windowDays: REFUND_WINDOW_DAYS, paidAt: "", endsAt: "", daysLeft: 0 }
    : refundWindowFor(existingFamily);
  if (refundWindow.eligible && existingFamily.subscriptionStatus === "active") {
    const mockRefund = !process.env.STRIPE_SECRET_KEY
      || !existingFamily.stripePaymentId
      || String(existingFamily.stripePaymentId).startsWith("pi_mock");
    let refundId = "re_mock_kiddiegpt";
    let refundAmount = 0;
    if (!mockRefund) {
      try {
        const stripe = stripeClient();
        const resolved = await stripeRefundParamsFor(stripe, existingFamily.stripePaymentId);
        if (!resolved) throw new Error("No refundable PaymentIntent for this payment.");
        const refund = await stripe.refunds.create(resolved.params);
        refundId = refund.id;
        refundAmount = Number(refund.amount || 0);
        await cancelStripeSubscriptionsNow(stripe, existingFamily);
      } catch (error) {
        mutateDb((db) => monitor(db, "error", "stripe", "Refund-window cancellation failed", { email, detail: error.message }, email));
        return res.status(500).json({ error: "Unable to refund and cancel with Stripe. Contact support." });
      }
    }
    const updated = mutateDb((db) => {
      const family = db.families.find((item) => item.email === email);
      if (!family) return null;
      family.paymentStatus = "refunded";
      family.refundedAt = nowIso();
      family.refunds = Array.isArray(family.refunds) ? family.refunds : [];
      family.refunds.unshift({ refundId, paymentId: family.stripePaymentId || "", amountCents: refundAmount, status: "succeeded", reason: "refund_window", createdAt: nowIso() });
      // Refunding a yearly UPGRADE only undoes the upgrade — the monthly period
      // underneath it was paid for separately and earlier, so ending access now
      // would confiscate time the parent already owns. Fall back to the monthly
      // plan and let it run out its term instead.
      const monthlyEndsIso = hasConfirmedYearlyUpgrade(family)
        ? (unixToIso(family.yearlyUpgrade.monthlyEndsAt) || family.yearlyUpgrade.monthlyEndsAt || "")
        : "";
      const monthlyRemaining = monthlyEndsIso && new Date(monthlyEndsIso).getTime() > Date.now();
      if (monthlyRemaining) {
        retireYearlyUpgrade(family);
        family.plan = "Family Monthly";
        family.currentPeriodEnd = monthlyEndsIso;
        family.subscriptionStatus = "cancel_scheduled";
        family.cancellationRequested = true;
        family.cancellationStatus = "scheduled";
        family.cancelAtPeriodEnd = true;
        family.cancelReason = reason || "Yearly upgrade refunded";
        family.cancelAccessUntil = monthlyEndsIso;
        family.cancellationAccessUntil = monthlyEndsIso;
      } else {
        markSubscriptionEndedNow(family, reason || "Cancelled within refund window", effectiveFamilySubscriptionId(family) || family.stripeSubscriptionId || "");
      }
      audit(db, "subscription.cancel_refunded", { familyId: family.id, email, refundId, windowDays: refundWindow.windowDays, paidAt: refundWindow.paidAt, revertedToMonthlyUntil: monthlyRemaining ? monthlyEndsIso : "" }, email);
      monitor(db, "info", "billing", "Cancelled inside refund window — full refund issued", { email, refundId, windowDays: refundWindow.windowDays }, email);
      return family;
    });
    return res.json({
      mode: mockRefund ? "mock" : "stripe",
      refunded: true,
      refundId,
      familyId: updated?.id || existingFamily.id,
      status: updated?.subscriptionStatus || "cancelled",
      cancelAccessUntil: updated?.cancelAccessUntil || "",
      refundWindow,
      message: updated?.subscriptionStatus === "cancel_scheduled"
        ? `Your yearly upgrade was refunded in full. Your monthly plan continues until ${updated.cancelAccessUntil ? new Date(updated.cancelAccessUntil).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "the end of the paid period"}, then access ends.`
        : `Cancelled within the ${refundWindow.windowDays}-day refund window. Your payment has been refunded in full and access has ended.`
    });
  }

  if (!process.env.STRIPE_SECRET_KEY || !existingFamily.stripeSubscriptionId || existingFamily.stripeSubscriptionId.startsWith("sub_mock")) {
    // End of the CURRENT period: use the known period end, else anchor on the
    // billing start (last payment / account creation) + interval and roll
    // forward to the next boundary — not simply "now + one interval".
    const isYearly = String(existingFamily.plan || "").toLowerCase().includes("year");
    let mockPeriodEnd;
    if (existingFamily.subscriptionStatus === "trialing" && existingFamily.trialEndsAt) {
      // During a trial the current period ends at trial_end, not one billing
      // interval away — otherwise cancelling mid-trial would hand out a free
      // extra month. (Real Stripe reports this correctly in current_period_end.)
      mockPeriodEnd = new Date(existingFamily.trialEndsAt);
    } else if (existingFamily.currentPeriodEnd) {
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
      refunded: false,
      refundWindow,
      // Cancelling during a trial just stops it at trial_end — the portal shows
      // "trial ends on X" instead of refund or save-offer messaging.
      trialing: existingFamily.subscriptionStatus === "trialing",
      trialEndsAt: existingFamily.trialEndsAt || "",
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
      refunded: false,
      refundWindow,
      // Cancelling during a trial just stops it at trial_end — the portal shows
      // "trial ends on X" instead of refund or save-offer messaging.
      trialing: existingFamily.subscriptionStatus === "trialing",
      trialEndsAt: existingFamily.trialEndsAt || "",
      message: `Cancellation is scheduled. Extension access remains active until ${updated?.cancelAccessUntil || "the end of the paid period"}.`
    });
  } catch (error) {
    mutateDb((db) => monitor(db, "error", "stripe", "Cancellation request failed", { email, detail: error.message, subscriptionId: existingFamily.stripeSubscriptionId }, email));
    return res.status(500).json({ error: "Unable to schedule cancellation with Stripe." });
  }
});

// Undo a scheduled cancellation while the paid period is still running. This is
// the cheapest revenue there is: the parent already has the plan and simply
// changed their mind, so make it one click rather than "wait to lapse, then buy
// again".
app.post("/api/stripe/resume-subscription", requireParent, async (req, res) => {
  const email = normalizeEmail(req.auth?.email || req.body?.email || "");
  if (!email) return res.status(400).json({ error: "Missing parent email." });
  const existing = readDb().families.find((item) => item.email === email);
  if (!existing) return res.status(404).json({ error: "Family account not found." });
  if (existing.subscriptionStatus !== "cancel_scheduled") {
    return res.status(400).json({ error: "This plan is not scheduled to cancel." });
  }
  if (!cancellationStillActive(existing)) {
    return res.status(409).json({ error: "This plan has already ended. Choose a plan to start again." });
  }

  const subscriptionId = effectiveFamilySubscriptionId(existing) || existing.stripeSubscriptionId || "";
  if (process.env.STRIPE_SECRET_KEY && subscriptionId && !subscriptionId.startsWith("sub_mock")) {
    try {
      await stripeClient().subscriptions.update(subscriptionId, { cancel_at_period_end: false });
    } catch (error) {
      mutateDb((db) => monitor(db, "error", "stripe", "Resume subscription failed", { email, detail: error.message }, email));
      return res.status(502).json({ error: "Could not resume the subscription with Stripe." });
    }
  }

  const updated = mutateDb((db) => {
    const family = db.families.find((item) => item.email === email);
    if (!family) return null;
    // A trial that was cancelled goes back to trialing, not active — it has not
    // been charged yet, and forcing "active" would invent a payment.
    family.subscriptionStatus = family.paymentStatus === "trial" ? "trialing" : "active";
    family.cancellationRequested = false;
    family.cancellationStatus = "";
    family.cancelAtPeriodEnd = false;
    family.cancelReason = "";
    family.cancelAccessUntil = "";
    family.cancellationAccessUntil = "";
    delete family.cancelledAt;
    audit(db, "subscription.resume", { familyId: family.id, email }, email);
    monitor(db, "info", "billing", "Parent resumed a scheduled cancellation", { email }, email);
    return family;
  });
  res.json({ ok: true, status: updated.subscriptionStatus, plan: updated.plan, message: "Your plan will continue. Auto-renewal is back on." });
});

app.post("/api/stripe/upgrade-yearly", requireParent, async (req, res) => {
  const email = normalizeEmail(req.auth?.email || req.body?.email || req.body?.parentEmail || "");
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
  const trialing = family.subscriptionStatus === "trialing";
  // A family that has cancelled but still has paid access left is the best
  // win-back audience there is — let them upgrade instead of waiting to lapse.
  // Upgrading is an explicit renewal, so it clears the pending cancellation.
  const cancellingWithAccess = family.subscriptionStatus === "cancel_scheduled" && cancellationStillActive(family);
  if (!trialing && !cancellingWithAccess && family.subscriptionStatus !== "active") {
    return res.status(400).json({ error: "Yearly upgrade requires an active monthly subscription or card-upfront trial." });
  }

  const yearlyPlan = dbSnapshot.pricing?.yearly || defaultPricing().yearly;
  const monthlyPlan = dbSnapshot.pricing?.monthly || defaultPricing().monthly;
  const yearlyPriceId = req.body?.yearlyPriceId || yearlyPlan.stripePriceId;
  const normalisedPricing = normalisePricing(dbSnapshot.pricing);
  const upgradeConfig = normalisedPricing.yearlyUpgrade;
  const upgradeDiscountAmount = Number(upgradeConfig.discountAmount || 0);
  // Monthly-to-yearly upgrades use their dedicated offer. The generic yearly
  // promotion is reserved for new sign-ups and must not replace the upgrade's
  // configured bonus months or upgrade discount.
  const yearlyPromotion = null;
  const bonusMonths = Number(req.body?.bonusMonths ?? upgradeConfig.bonusMonths ?? process.env.YEARLY_UPGRADE_BONUS_MONTHS ?? 3);
  const upgradeNote = String(upgradeConfig.note || "");
  const initialPrice = yearlyPromotion
    ? Number(yearlyPromotion.promoPrice || yearlyPlan.amount || 0)
    : upgradeDiscountAmount > 0
    // Floor at zero: a discount larger than the plan price must not invert it.
    ? Math.max(0, Math.round((Number(yearlyPlan.amount || 0) - upgradeDiscountAmount) * 100) / 100)
    : Number(yearlyPlan.amount || 0);
  const initialAmountCents = Math.round(initialPrice * 100);
  const promotionCode = yearlyPromotion?.code || "";
  const effectiveOfferNote = yearlyPromotion?.description || upgradeNote;

  if (!yearlyPriceId) {
    return res.status(400).json({ error: "Missing yearly Stripe Price ID." });
  }

  // A card-upfront trial already has a Stripe subscription. Change its price
  // in place so the trial end date is preserved and the parent is never given
  // a second overlapping subscription or a second trial.
  if (trialing && family.stripeSubscriptionId) {
    if (!process.env.STRIPE_SECRET_KEY || family.stripeSubscriptionId.startsWith("sub_mock")) {
      const trialEnd = new Date(family.trialEndsAt || Date.now() + 7 * 86400000);
      const updated = mutateDb((db) => {
        const next = db.families.find((item) => item.email === email);
        if (!next) return null;
        next.plan = yearlyPlan.label || "Family Yearly";
        next.pendingPlanName = "";
        next.subscriptionStatus = "trialing";
        next.paymentStatus = "trial";
        next.currentPeriodEnd = trialEnd.toISOString();
        next.yearlyUpgrade = {
          status: "trialing",
          mode: "mock",
          billingMode: "trial_price_switch",
          bonusMonths: 0,
          accessMonths: 12,
          trialEndsAt: trialEnd.toISOString(),
          yearlyNextRenewalAt: new Date(trialEnd.getFullYear() + 1, trialEnd.getMonth(), trialEnd.getDate()).toISOString(),
          yearlySubscriptionId: next.stripeSubscriptionId,
          promoCode: promotionCode,
          effectivePrice: initialPrice,
          acceptedAt: nowIso()
        };
        audit(db, "subscription.trial_switch_yearly.mock", { familyId: next.id, email, trialEndsAt: trialEnd.toISOString() }, email);
        return next;
      });
      return res.json({
        mode: "mock",
        familyId: updated?.id || family.id,
        plan: yearlyPlan.label || "Family Yearly",
        trialing: true,
        trialEndsAt: trialEnd.toISOString(),
        yearlyNextRenewalAt: updated?.yearlyUpgrade?.yearlyNextRenewalAt || "",
        promoCode: promotionCode,
        effectivePrice: initialPrice,
        message: `Yearly billing is selected. Your first yearly charge starts when the trial ends on ${trialEnd.toLocaleDateString()}.`
      });
    }

    try {
      const stripe = stripeClient();
      const subscription = await stripe.subscriptions.retrieve(family.stripeSubscriptionId, { expand: ["items.data"] });
      const item = subscription.items?.data?.[0];
      if (!item) return res.status(400).json({ error: "The trial subscription has no billable item to upgrade." });
      const trialCouponId = yearlyPromotion ? await ensurePromotionCoupon(stripe, yearlyPromotion) : "";
      const updatedSubscription = await stripe.subscriptions.update(family.stripeSubscriptionId, {
        items: [{ id: item.id, price: yearlyPriceId }],
        proration_behavior: "none",
        ...(trialCouponId ? { discounts: [{ coupon: trialCouponId }] } : {}),
        metadata: { yearlyUpgrade: "true", upgradeBillingMode: "trial_price_switch", promotionCode, app: "KiddieGPT" }
      });
      const trialEnd = unixToIso(updatedSubscription.trial_end || subscription.trial_end || 0) || family.trialEndsAt || "";
      const updated = mutateDb((db) => {
        const next = db.families.find((entry) => entry.email === email);
        if (!next) return null;
        next.plan = yearlyPlan.label || "Family Yearly";
        next.pendingPlanName = "";
        next.subscriptionStatus = "trialing";
        next.paymentStatus = "trial";
        next.trialEndsAt = trialEnd || next.trialEndsAt;
        next.currentPeriodEnd = unixToIso(updatedSubscription.current_period_end || 0) || next.currentPeriodEnd;
        next.yearlyUpgrade = {
          status: "trialing",
          mode: "stripe",
          billingMode: "trial_price_switch",
          bonusMonths: 0,
          accessMonths: 12,
          trialEndsAt: trialEnd,
          yearlySubscriptionId: updatedSubscription.id,
          promoCode: promotionCode,
          effectivePrice: initialPrice,
          acceptedAt: nowIso()
        };
        audit(db, "subscription.trial_switch_yearly", { familyId: next.id, email, subscriptionId: updatedSubscription.id, trialEndsAt: trialEnd }, email);
        return next;
      });
      return res.json({
        mode: "stripe",
        familyId: updated?.id || family.id,
        plan: yearlyPlan.label || "Family Yearly",
        subscriptionId: updatedSubscription.id,
        trialing: true,
        trialEndsAt: trialEnd,
        promoCode: promotionCode,
        effectivePrice: initialPrice,
        message: `Yearly billing is selected. Your first yearly charge starts when the trial ends on ${trialEnd ? new Date(trialEnd).toLocaleDateString() : "the trial end date"}.`
      });
    } catch (error) {
      mutateDb((db) => monitor(db, "error", "stripe", "Trial yearly switch failed", { email, detail: error.message, subscriptionId: family.stripeSubscriptionId }, email));
      return res.status(500).json({ error: "Unable to switch the trial subscription to yearly." });
    }
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
    // A monthly plan cannot hold more than a month of unused time. Without this
    // cap a wrong currentPeriodEnd compounds: the bogus remainder is carried
    // into the yearly date, which becomes the next currentPeriodEnd, and the
    // following upgrade carries a bigger one still (seen in the wild at 1859
    // days, pushing a renewal out to 2032).
    const MAX_CARRY_DAYS = String(family.plan || "").toLowerCase().includes("year") ? 366 : 31;
    const rawProratedDays = Math.max(0, Math.ceil((periodEnd.getTime() - now) / 86400000));
    const proratedDays = Math.min(rawProratedDays, MAX_CARRY_DAYS);
    if (rawProratedDays > MAX_CARRY_DAYS) {
      mutateDb((db) => monitor(db, "warning", "billing",
        "Prorated carry-over capped — currentPeriodEnd looks wrong",
        { familyId: family.id, rawProratedDays, cappedTo: MAX_CARRY_DAYS, currentPeriodEnd: family.currentPeriodEnd }, family.email));
    }
    const accessMonths = 12 + bonusMonths;
    const accessEnd = new Date(now);
    accessEnd.setMonth(accessEnd.getMonth() + accessMonths);
    accessEnd.setDate(accessEnd.getDate() + proratedDays);
    const effectivePrice = initialPrice;
    const accessEndUnix = Math.floor(accessEnd.getTime() / 1000);
    const mockYearlySubscriptionId = "sub_mock_yearly_" + crypto.randomBytes(6).toString("hex");
    const updated = mutateDb((db) => {
      const next = db.families.find((item) => item.email === email);
      if (!next) return null;
      const monthlySubscriptionIds = next.stripeSubscriptionId ? [next.stripeSubscriptionId] : [];
      next.plan = yearlyPlan.label || "Family Yearly";
      next.subscriptionStatus = "active";
      // Upgrading is an explicit renewal, so any pending cancellation is off.
      next.cancellationRequested = false;
      next.cancellationStatus = "";
      next.cancelAtPeriodEnd = false;
      next.cancelAccessUntil = "";
      next.cancellationAccessUntil = "";
      next.paymentStatus = "paid";
      next.stripeCustomerId = next.stripeCustomerId || "cus_mock_" + crypto.randomBytes(6).toString("hex");
      next.stripePreviousMonthlySubscriptionIds = monthlySubscriptionIds;
      next.stripeSubscriptionId = mockYearlySubscriptionId;
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
        monthlySubscriptionIds,
        yearlySubscriptionId: mockYearlySubscriptionId,
        monthlyCancelledAtPeriodEnd: false,
        discountAmount: Math.max(0, Math.round((Number(yearlyPlan.amount || 0) - effectivePrice) * 100) / 100),
        promoCode: promotionCode,
        effectivePrice,
        note: effectiveOfferNote,
        acceptedAt: nowIso()
      };
      recordStripePayment(db, {
        id: `upgrade_mock_${next.id}_${accessEndUnix}`,
        type: "invoice.paid"
      }, {
        id: "pi_mock_yearly_" + crypto.randomBytes(6).toString("hex"),
        amount_paid: Math.round(effectivePrice * 100),
        currency: "usd",
        customer: next.stripeCustomerId,
        subscription: mockYearlySubscriptionId,
        status: "paid",
        created: Math.floor(now / 1000),
        metadata: { parentEmail: next.email, planName: next.plan, upgradeBillingMode: "immediate_15_month", promoCode: promotionCode }
      }, next);
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
      promoCode: promotionCode,
      yearlySubscriptionId: updated?.yearlyUpgrade?.yearlySubscriptionId || "",
      note: effectiveOfferNote,
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
      monthlySubscriptionIds: monthlyIds,
      initialAmountCents,
      promotionCode
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
      // Upgrading is an explicit renewal, so any pending cancellation is off.
      next.cancellationRequested = false;
      next.cancellationStatus = "";
      next.cancelAtPeriodEnd = false;
      next.cancelAccessUntil = "";
      next.cancellationAccessUntil = "";
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
        promoCode: promotionCode,
        effectivePrice: initialPrice,
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
        promoCode: promotionCode,
        effectivePrice: initialPrice,
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
      effectivePrice: initialPrice,
      promoCode: promotionCode,
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
        if (action === "pause") { family.accountLocked = true; family.pausedAt = nowIso(); }
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
        if (action === "pause") { family.accountLocked = true; family.pausedAt = nowIso(); }
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
    const resolved = await stripeRefundParamsFor(stripe, paymentIntentId, amountCents);
    if (!resolved) {
      return res.status(400).json({ error: "This payment does not have a refundable Stripe PaymentIntent yet. Refresh the payment from Stripe and try again." });
    }
    const resolvedPaymentId = resolved.resolvedPaymentId;
    const refund = await stripe.refunds.create(resolved.params);
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
        // The Stripe pause_collection call above is the billing side; locally we
        // lock rather than inventing a "paused" status that duplicates it.
        if (action === "pause_billing") next.accountLocked = true;
        else next.subscriptionStatus = "cancelled";
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

app.get("/parent-portal-mockup.html", (req, res) => {
  res.sendFile(path.join(publicDir, "webapp", "parent-portal-mockup.html"));
});

app.use(express.static(publicDir, {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
  }
}));

// NOTE: do not initialise persistence at module load. Requiring this module must
// stay side-effect free: on Vercel the filesystem is read-only, so a top-level
// ensureDb() crashed the function with EROFS before DB_DRIVER was ever consulted.
// Both entry points initialise explicitly instead — startServer() locally and
// api/index.js on Vercel, each via initPersistence(), which picks file vs postgres.

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

function trialEndedMessage(family) {
  return renderTemplate("trial_ended", { parentName: family?.parentName || "there", trialEndsAt: family?.trialEndsAt || "" }).text;
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
    let trialsEnded = 0;
    let trialNotices = 0;
    (db.families || []).forEach((family) => {
      if (family.anonymizedAt || family.deletionRequestedAt) return;

      // --- Free trial ending reminder ---
      // A card-upfront trial charges automatically on day 7. Charging with no
      // warning is one of the most common reasons a parent disputes rather than
      // cancels, so tell them first. Sent once, flagged so a re-run cannot repeat it.
      const trialingNow = family.subscriptionStatus === "trialing" || family.subscriptionStatus === "trial";
      if (trialingNow && family.trialEndsAt && !family.trialEndingNoticeAt) {
        const endsAt = new Date(family.trialEndsAt).getTime();
        const daysToEnd = Math.ceil((endsAt - now) / 86400000);
        if (Number.isFinite(endsAt) && endsAt > now && daysToEnd <= TRIAL_ENDING_NOTICE_DAYS) {
          family.trialEndingNoticeAt = nowIso();
          trialNotices += 1;
          const tpl = renderTemplate("trial_ending", {
            parentName: family.parentName || "there",
            trialEndsAt: family.trialEndsAt,
            // Only a card-upfront trial actually bills; a comped one just ends.
            cardOnFile: Boolean(family.stripeSubscriptionId)
          });
          audit(db, "trial.ending_notice", { familyId: family.id, email: family.email, trialEndsAt: family.trialEndsAt }, "autopilot");
          queueEmail(family, "Trial ending", tpl.text);
        }
      }

      // --- Free trial expiry ---
      // Trials end themselves: no card is on file, so there is nothing to charge
      // and the account simply loses access.
      if (family.subscriptionStatus === "trial" && family.trialEndsAt && new Date(family.trialEndsAt).getTime() <= now) {
        family.subscriptionStatus = "expired";
        family.paymentStatus = "unpaid";
        family.trialEndedAt = nowIso();
        trialsEnded += 1;
        audit(db, "trial.expired", { familyId: family.id, email: family.email }, "autopilot");
        queueEmail(family, "Trial ended", trialEndedMessage(family));
        return;
      }

      // --- Dunning ---
      if (family.dunning && family.dunning.failedAt) {
        const daysSince = daysBetween(family.dunning.failedAt);
        if (daysSince >= rules.dunningSuspendDays && !family.dunning.suspendedAt) {
          family.subscriptionStatus = "past_due";
          // Deliberately NOT accountLocked: that blocks login, so a parent whose
          // card failed could neither fix the card nor cancel, leaving a
          // chargeback as their only exit. past_due already removes entitlement.
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
    return { trigger, reconciled, remindersSent, suspended, cancelsFinalised, nudged, winbacks, summaries, trialsEnded, trialNotices, emailsQueued: emailsToSend.length };
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
    if (family.dispute && family.dispute.status !== "won") {
      items.push({ ...base, priority: 0, category: "dispute", title: "Chargeback opened", detail: "Respond in Stripe before the deadline.", since: family.dispute.openedAt || "" });
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
