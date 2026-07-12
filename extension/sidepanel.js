const panels = {
  dashboard: "dashboardPanel",
  pdf: "pdfPanel",
  read: "readPanel",
  math: "mathPanel",
  write: "writePanel",
  screenshot: "screenshotPanel",
  page: "screenshotPanel",
  settings: "settingsPanel"
};

const legacySettingsViews = new Set(["classroom", "assignments", "insights", "safety", "admin"]);

const extensionApi = typeof chrome !== "undefined" ? chrome : null;
const storageFallback = "kiddiegptSettings";

// ---- Portal client --------------------------------------------------------
// The extension authenticates as a parent against the KiddieGPT portal, checks
// entitlement, and routes all AI calls through the portal proxy (the OpenAI key
// lives server-side and never ships in the extension).
const PORTAL_TOKEN_KEY = "kiddiegptPortalToken";
const PORTAL_EMAIL_KEY = "kiddiegptPortalEmail";
const PORTAL_CHILD_KEY = "kiddiegptPortalChildId";
function portalBaseUrl() {
  const override = (globalThis.KIDDIEGPT_LOCAL_SETTINGS || {}).portalBaseUrl;
  return String(override || "https://app.kiddiegpt.com").replace(/\/+$/, "");
}
let portalToken = "";
let portalSession = null; // { email, entitled, status, plan, familyId, childId, children, locked }
let currentView = "dashboard";

class PortalError extends Error {
  constructor(code, status, data) {
    super(code || "portal_error");
    this.code = code || "portal_error";
    this.status = status || 0;
    this.data = data || null;
  }
}

function storageGet(keys) {
  return new Promise(resolve => {
    if (extensionApi?.storage?.local) { extensionApi.storage.local.get(keys, resolve); return; }
    const list = Array.isArray(keys) ? keys : Object.keys(keys);
    const out = {};
    list.forEach(key => { const value = localStorage.getItem(key); if (value !== null) out[key] = value; });
    resolve(out);
  });
}
function storageSet(obj) {
  return new Promise(resolve => {
    if (extensionApi?.storage?.local) { extensionApi.storage.local.set(obj, resolve); return; }
    Object.entries(obj).forEach(([key, value]) => localStorage.setItem(key, value));
    resolve();
  });
}
function storageRemove(keys) {
  return new Promise(resolve => {
    if (extensionApi?.storage?.local) { extensionApi.storage.local.remove(keys, resolve); return; }
    (Array.isArray(keys) ? keys : [keys]).forEach(key => localStorage.removeItem(key));
    resolve();
  });
}

async function loadPortalToken() {
  const data = await storageGet([PORTAL_TOKEN_KEY, PORTAL_EMAIL_KEY, PORTAL_CHILD_KEY]);
  portalToken = data[PORTAL_TOKEN_KEY] || "";
  return {
    token: portalToken,
    email: data[PORTAL_EMAIL_KEY] || "",
    childId: data[PORTAL_CHILD_KEY] || ""
  };
}

async function portalFetch(path, { method = "GET", body, raw = false } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (portalToken) headers.Authorization = `Bearer ${portalToken}`;
  const response = await fetch(`${portalBaseUrl()}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  if (response.status === 401) { await portalSignOut(); throw new PortalError("auth_required", 401); }
  if (raw) {
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new PortalError(text || "request_failed", response.status);
    }
    return response;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new PortalError(data.error || data.reason || "request_failed", response.status, data);
  return data;
}

async function portalSignIn(email, password) {
  const response = await fetch(`${portalBaseUrl()}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: String(email || "").trim(), password })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.token) throw new PortalError(data.error || "login_failed", response.status, data);
  portalToken = data.token;
  await storageSet({ [PORTAL_TOKEN_KEY]: data.token, [PORTAL_EMAIL_KEY]: String(email || "").trim() });
  return data;
}

const OTP_TEST_CODE = "1234";
const OTP_TEST_TOKEN = "test-otp-token";
let otpState = { step: "email", email: "", sentCode: "" };

// ---- Model routing (from benchmark results) ----------------------------------
// Text tools default to Luna. Terra is a faster / harder-math fallback. Sol is
// premium/deep only, never the default. Voice (TTS) and moderation are separate,
// fixed models. gpt-4.1 is no longer the default for anything.
const MODELS = {
  defaultText: "gpt-5.6-luna", // tutor explain, mission/flashcards/quizzes, explain, writing
  math: "gpt-5.6-luna",        // math solve / check / transcribe
  hardMath: "gpt-5.6-terra",   // optional faster / harder-math fallback
  premiumDeep: "gpt-5.6-sol",  // premium "deep" mode only, opt-in
  tts: "gpt-4o-mini-tts",      // tutor voice
  moderation: "omni-moderation-latest"
};

// Resolve the text model for a call. mode: "default" | "hard" | "deep".
// Callers can also pass an explicit model to override routing.
function modelForText(mode = "default") {
  if (mode === "deep") return MODELS.premiumDeep;
  if (mode === "hard") return MODELS.hardMath;
  return MODELS.defaultText;
}

// ---- Tutor voice (TTS) --------------------------------------------------------
// Students pick from the admin-approved voice list only. The extension never
// shows the full OpenAI voice set. Voice is separate from the text model routing.
const SUPPORTED_TTS_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"];
const DEFAULT_ALLOWED_VOICES = ["marin", "cedar", "sage"]; // offline/dev shortlist
const DEFAULT_VOICE = "marin";
const VOICE_LABELS = {
  marin: "Marin - calm tutor",
  cedar: "Cedar - steady tutor",
  sage: "Sage - gentle guide"
};
const TTS_INSTRUCTION = "Speak like a calm, supportive middle-school tutor. Soothing, clear, steady pace, warm but not childish. Add gentle pauses between ideas. Keep energy relaxed and reassuring.";

function voiceLabel(voice) {
  const v = String(voice || "").trim().toLowerCase();
  return VOICE_LABELS[v] || (v ? v.charAt(0).toUpperCase() + v.slice(1) : v);
}

// Admin-approved, client-sanitized allowed voices. Source order: portal session
// -> local-settings (dev) -> default shortlist. Removes unsupported voices,
// de-dupes, and never returns empty.
function allowedVoices() {
  const local = globalThis.KIDDIEGPT_LOCAL_SETTINGS || {};
  const raw = (Array.isArray(portalSession?.ttsAllowedVoices) && portalSession.ttsAllowedVoices.length)
    ? portalSession.ttsAllowedVoices
    : (Array.isArray(local.ttsAllowedVoices) && local.ttsAllowedVoices.length)
      ? local.ttsAllowedVoices
      : DEFAULT_ALLOWED_VOICES;
  const list = [...new Set(raw.map(v => String(v || "").trim().toLowerCase()))].filter(v => SUPPORTED_TTS_VOICES.includes(v));
  return list.length ? list : DEFAULT_ALLOWED_VOICES.slice();
}

// The default voice: admin default if allowed, else marin -> cedar -> sage if
// allowed, else the first allowed voice. Always returns an allowed voice.
function defaultVoice() {
  const list = allowedVoices();
  const local = globalThis.KIDDIEGPT_LOCAL_SETTINGS || {};
  const adminDefault = String(portalSession?.ttsDefaultVoice || local.ttsDefaultVoice || "").trim().toLowerCase();
  if (adminDefault && list.includes(adminDefault)) return adminDefault;
  for (const v of [DEFAULT_VOICE, "cedar", "sage"]) if (list.includes(v)) return v;
  return list[0];
}

// Single voice-resolution helper for every TTS call: the student's choice if it
// is still allowed, otherwise the (admin) default voice.
function resolveVoice(studentVoice) {
  const chosen = String(studentVoice || "").trim().toLowerCase();
  return allowedVoices().includes(chosen) ? chosen : defaultVoice();
}

async function requestOtp(email) {
  const clean = String(email || "").trim();
  const response = await fetch(`${portalBaseUrl()}/api/auth/otp/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: clean })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new PortalError(data.error || "otp_request_failed", response.status, data);
  // testCode is only returned in mock/dev mode (no email provider configured).
  otpState = { step: "code", email: clean, sentCode: data.testCode || "" };
  await storageSet({ [PORTAL_EMAIL_KEY]: clean });
  return { ok: true, testCode: data.testCode || "" };
}

async function verifyOtp(email, code) {
  const clean = String(email || "").trim();
  const response = await fetch(`${portalBaseUrl()}/api/auth/otp/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: clean, otp: String(code || "").trim() })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.token) throw new PortalError(data.error || "bad_code", response.status, data);
  portalToken = data.token; // real portal bearer token
  await storageSet({ [PORTAL_TOKEN_KEY]: portalToken, [PORTAL_EMAIL_KEY]: clean });
  otpState = { step: "email", email: "", sentCode: "" };
  return { token: portalToken };
}

async function portalSignOut() {
  portalToken = "";
  portalSession = null;
  otpState = { step: "email", email: "", sentCode: "" };
  await storageRemove([PORTAL_TOKEN_KEY]);
}

// The parent's students. Real list comes from the portal entitlement response;
// for local testing, configure KIDDIEGPT_LOCAL_SETTINGS.children in local-settings.js.
function normalizeChildren(list) {
  return (Array.isArray(list) ? list : [])
    .map((child, index) => ({
      id: String(child.id || child.childId || `child_${index + 1}`),
      // Portal stores the name as `studentName`; also accept name/firstName.
      name: String(child.name || child.studentName || child.firstName || `Student ${index + 1}`),
      grade: String(child.grade || child.gradeBand || "")
    }))
    .filter(child => child.id);
}

// Pick the active child: the stored one if it still exists, else the first.
function pickChildId(stored, children) {
  if (stored && children.some(child => child.id === stored)) return stored;
  return children[0]?.id || stored || "";
}

// On first load nothing is stored, so pickChildId defaults to the first child.
// Persist that default so the selection sticks and childId is always sent to the
// portal (otherwise the server silently attributes usage to its own first child).
async function persistDefaultChild(storedChildId) {
  if (!storedChildId && portalSession?.childId) {
    await storageSet({ [PORTAL_CHILD_KEY]: portalSession.childId });
  }
}

async function refreshEntitlement() {
  if (!portalToken) { portalSession = null; return null; }
  const stored = await storageGet([PORTAL_EMAIL_KEY, PORTAL_CHILD_KEY]);
  if (portalToken === OTP_TEST_TOKEN) {
    const configured = normalizeChildren(globalThis.KIDDIEGPT_LOCAL_SETTINGS?.children);
    const children = configured.length ? configured : [
      { id: "child_1", name: "Test Student", grade: "6-8" }
    ];
    portalSession = { email: stored[PORTAL_EMAIL_KEY] || "", entitled: true, status: "test", plan: "test", familyId: "", childId: pickChildId(stored[PORTAL_CHILD_KEY], children), children, locked: false };
    await persistDefaultChild(stored[PORTAL_CHILD_KEY]);
    return portalSession;
  }
  try {
    const ent = await portalFetch("/api/entitlements/me");
    const children = normalizeChildren(ent.children);
    portalSession = {
      email: stored[PORTAL_EMAIL_KEY] || "",
      entitled: Boolean(ent.active),
      status: ent.status || ent.reason || "",
      plan: ent.plan || null,
      familyId: ent.familyId || "",
      children,
      childId: pickChildId(stored[PORTAL_CHILD_KEY], children),
      // Admin-approved tutor voices (sanitized at use-time by allowedVoices()).
      ttsAllowedVoices: ent.ttsAllowedVoices,
      ttsDefaultVoice: ent.ttsDefaultVoice,
      ttsModel: ent.ttsModel,
      locked: Boolean(ent.locked)
    };
    await persistDefaultChild(stored[PORTAL_CHILD_KEY]);
    return portalSession;
  } catch (error) {
    if (error.status === 401) { portalSession = null; return null; }
    // Family exists but not active, locked, or blocked — keep a marker so the
    // gate can explain it rather than silently failing.
    portalSession = {
      email: stored[PORTAL_EMAIL_KEY] || "",
      entitled: false,
      status: error.code,
      locked: error.status === 423,
      childId: stored[PORTAL_CHILD_KEY] || ""
    };
    return portalSession;
  }
}

async function getUsageLimits() {
  if (portalToken === OTP_TEST_TOKEN) return { ok: true, test: true };
  const query = portalSession?.childId ? `?childId=${encodeURIComponent(portalSession.childId)}` : "";
  return portalFetch(`/api/ai/usage-limits${query}`);
}

async function reportUsage(payload) {
  if (!portalToken || portalToken === OTP_TEST_TOKEN) return null;
  try {
    return await portalFetch("/api/usage/report", {
      method: "POST",
      body: { childId: portalSession?.childId || undefined, ...payload }
    });
  } catch (error) {
    console.warn("usage report failed", error);
    return null;
  }
}

// Best-effort issue reporting to the portal (works signed out too, e.g. login
// failures). Never throws — reporting must not disrupt the user.
async function reportIssue(type, detail, context) {
  try {
    const stored = await storageGet([PORTAL_EMAIL_KEY]);
    await fetch(`${portalBaseUrl()}/api/issues/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(portalToken ? { Authorization: `Bearer ${portalToken}` } : {}) },
      body: JSON.stringify({
        type,
        detail: String(detail || "").slice(0, 500),
        email: stored[PORTAL_EMAIL_KEY] || "",
        source: "extension",
        context: context || {}
      })
    });
  } catch (error) { /* best effort */ }
}

// Report uncaught extension errors so the admin can see failures in the field.
if (typeof window !== "undefined") {
  window.addEventListener("error", (event) => {
    const msg = (event.error && event.error.message) || event.message || "";
    if (!msg || /ResizeObserver loop/.test(msg)) return; // ignore benign noise
    reportIssue("extension_error", (msg + (event.filename ? " @ " + event.filename : "")).slice(0, 200));
  });
  // Student flags a math answer as wrong → report WITH the problem + answer so
  // the admin's "Reported problems" view is actionable, not just a count.
  document.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-math-feedback]");
    if (!btn || btn.disabled) return;
    const problem = mathSolveState.problems[mathSolveState.index] || {};
    const readable = value => latexToReadable(cleanMathText(value || ""));
    reportIssue(
      "math_feedback",
      `Student flagged a wrong math answer. Problem: "${readable(problem.equation)}" · Answer shown: "${readable(problem.answer)}"`,
      { tool: "math", problem: readable(problem.equation), answerShown: readable(problem.answer), goal: readable(problem.goal) }
    );
    btn.textContent = "Thanks — we'll review this";
    btn.disabled = true;
  });
}

// Map the active tool view to a metering label the portal understands.
function toolForCurrentView() {
  const map = { math: "math", pdf: "pdf", read: "read", write: "write", screenshot: "math" };
  return map[currentView] || "";
}

let selectedPdfFile = null;
let currentStudyPack = null;
let selectedMathCapture = null;
let selectedMathFile = null;
let mathShowNotes = true;
let mathAnswerGate = true;
let mathParentPinHash = "";
let mathPinPromptOpen = false;
let mathAnswersRevealed = false;
let lastMathSolve = null;

async function hashPin(pin) {
  const data = new TextEncoder().encode(`kiddiegpt-pin:${pin}`);
  const buffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buffer)).map(byte => byte.toString(16).padStart(2, "0")).join("");
}
let selectedExplainCapture = null;
let tutorAudioUrl = "";
let tutorMode = "read";
let tutorPlaybackRate = 1;
let tutorSentences = [];
let tutorSentenceBounds = [];
let tutorCurrentSentence = -1;
let missionReadSeconds = 0;
let missionReadTimerId = 0;
let missionReadDone = false;
let activeMissionStep = "study";
const maxStudyFileBytes = 5 * 1024 * 1024;
const maxStudyPdfPages = 20;
const maxScannedPdfPages = 5;
const maxTabChars = 30000;        // active-tab text extraction cap
const maxTutorReadChars = 30000;  // read-aloud verbatim, ~30 min of audio
const maxTutorExplainChars = 13500; // generated lesson script, ~15 min of audio
const maxTutorExplainSourceChars = 24000; // source text fed in to teach from
const ttsChunkChars = 3800;       // stay under OpenAI's ~4096-char TTS limit per request
const acceptedStudyTypes = ["application/pdf", "text/plain", "image/jpeg", "image/png"];
const sourceState = {
  pdf: "file",
  read: "file",
  math: "paste",
  explain: "page"
};
// Mission and Tutor share one source + one extracted text so nothing is read twice.
let currentSourceText = "";
let currentSourceLabel = "";
let currentSourceKey = "";
const missionMaxSets = 4;
let missionQuizSets = [];
let missionCardSets = [];
const missionQuizState = {
  answers: {},
  submitted: false,
  setNumber: 1
};
const missionCardsState = {
  index: 0,
  flipped: false,
  promptMode: "meaning",
  helpOpen: false,
  helpText: "",
  setNumber: 1
};
const writingState = {
  action: "assignment",
  review: null,       // { text, issues:[{text,type,why,fix,applied,dismissed}] }
  activeIssue: null   // index of the issue whose detail is open
};
const mathSolveState = {
  index: 0,
  problems: []
};

const toolDetails = {
  pdf: {
    title: "Study Mission",
    description: "Upload a homework PDF, worksheet, or notes packet. KiddieGPT turns it into a study mission with must-know facts, quiz practice, flashcards, and read-aloud review.",
    points: [["▣", "Open It", "Worksheet or chapter"], ["≡", "Find Big Ideas", "Notes kids can read"], ["✓", "Practice", "Quiz and cards"]]
  },
  read: {
    title: "Tutor Mode",
    description: "Turn a Study Mission or active lesson page into a short teacher-style audio explanation students can play inside KiddieGPT.",
    points: [["▶", "Pick Source", "Mission or active tab"], ["≡", "Teacher Script", "Simple lesson"], ["?", "Recall Check", "Say it back"]]
  },
  math: {
    title: "Math Step Tutor",
    description: "Capture a math problem from the page, confirm the OCR result, then solve with hint-first step checking. The final answer appears only after student work.",
    points: [["▧", "Input Problem", "Screenshot or file"], ["⌕", "Read the Math", "Equation or diagram"], ["∑", "Learn Steps", "Teacher-style solution"]]
  },
  write: {
    title: "Writing Studio",
    description: "Help students understand a prompt, check their own draft, or fix grammar without writing the assignment for them.",
    points: [["?", "Assignment", "Understand the task"], ["✎", "Draft", "Find what to add"], ["✓", "Grammar", "Clean up sentences"]]
  },
  screenshot: {
    title: "Explain This",
    description: "Explain the active page, selected text, screenshot, diagram, or worksheet in grade-safe language.",
    points: [["⌕", "Pick Source", "Active page or screenshot"], ["≡", "Understand It", "Simple explanation"], ["?", "Ask Follow-up", "Keep learning"]]
  },
  page: {
    title: "Explain This",
    description: "Explain the active page, selected text, screenshot, diagram, or worksheet in grade-safe language.",
    points: [["⌕", "Pick Source", "Active page or screenshot"], ["≡", "Understand It", "Simple explanation"], ["?", "Ask Follow-up", "Keep learning"]]
  }
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[char]));
}

function getSettings() {
  return new Promise(resolve => {
    const localDefaults = globalThis.KIDDIEGPT_LOCAL_SETTINGS || {};
    const defaults = { openaiDemoEnabled: false, openaiApiKey: "", openaiModel: MODELS.defaultText, activeView: "dashboard", gradeBand: "6-8", explanationStyle: "Balanced", mathAnswerGate: true, mathParentPin: "", tutorMode: "read", tutorPlaybackRate: 1, studentVoice: "", ...localDefaults };
    if (extensionApi?.storage?.local) {
      extensionApi.storage.local.get(defaults, data => {
        resolve({
          ...data,
          openaiApiKey: data.openaiApiKey || localDefaults.openaiApiKey || "",
          openaiDemoEnabled: Boolean(data.openaiApiKey || localDefaults.openaiApiKey) ? true : Boolean(data.openaiDemoEnabled),
          openaiModel: data.openaiModel || localDefaults.openaiModel || MODELS.defaultText
        });
      });
      return;
    }
    try {
      const data = { ...defaults, ...JSON.parse(localStorage.getItem(storageFallback) || "{}") };
      resolve({
        ...data,
        openaiApiKey: data.openaiApiKey || localDefaults.openaiApiKey || "",
        openaiDemoEnabled: Boolean(data.openaiApiKey || localDefaults.openaiApiKey) ? true : Boolean(data.openaiDemoEnabled),
        openaiModel: data.openaiModel || localDefaults.openaiModel || MODELS.defaultText
      });
    } catch {
      resolve(defaults);
    }
  });
}

function saveSettings(values) {
  return new Promise(resolve => {
    if (extensionApi?.storage?.local) {
      extensionApi.storage.local.set(values, resolve);
      return;
    }
    getSettings().then(current => {
      localStorage.setItem(storageFallback, JSON.stringify({ ...current, ...values }));
      resolve();
    });
  });
}

const activityStorageKey = "kiddiegptActivity";
let activityCache = {};
let activitySaveTimer = 0;
let activitySyncTimer = 0;

function activityDayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function last7DayKeys() {
  const keys = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = new Date();
    date.setDate(date.getDate() - offset);
    keys.push(activityDayKey(date));
  }
  return keys;
}

function pruneActivity(activity) {
  const keep = new Set(last7DayKeys());
  const out = {};
  Object.entries(activity || {}).forEach(([day, bucket]) => {
    if (keep.has(day)) out[day] = bucket;
  });
  return out;
}

function loadActivity() {
  return new Promise(resolve => {
    if (extensionApi?.storage?.local) {
      extensionApi.storage.local.get({ [activityStorageKey]: {} }, data => resolve(pruneActivity(data[activityStorageKey] || {})));
      return;
    }
    try {
      resolve(pruneActivity(JSON.parse(localStorage.getItem(activityStorageKey) || "{}")));
    } catch {
      resolve({});
    }
  });
}

function persistActivity() {
  renderStars();
  clearTimeout(activitySaveTimer);
  activitySaveTimer = setTimeout(() => {
    const pruned = pruneActivity(activityCache);
    activityCache = pruned;
    if (extensionApi?.storage?.local) {
      extensionApi.storage.local.set({ [activityStorageKey]: pruned });
    } else {
      try { localStorage.setItem(activityStorageKey, JSON.stringify(pruned)); } catch {}
    }
  }, 400);
  scheduleActivitySync();
}

// Mirror the day's activity to the portal so the parent progress screen can show
// it — local storage is device-only. Debounced upsert of the whole day bucket:
// idempotent, offline-tolerant, and a no-op when signed out or in test mode.
function scheduleActivitySync() {
  if (!portalToken || portalToken === OTP_TEST_TOKEN) return;
  clearTimeout(activitySyncTimer);
  activitySyncTimer = setTimeout(syncActivityToPortal, 1500);
}

async function syncActivityToPortal() {
  const date = activityDayKey();
  const bucket = activityCache[date];
  if (!bucket) return;
  try {
    // TODO(backend): POST /api/progress { childId, date, bucket } upserts this
    // student's day. Parent portal reads GET /api/progress?childId&days=7.
    await portalFetch("/api/progress", {
      method: "POST",
      body: { childId: portalSession?.childId || undefined, date, bucket }
    });
  } catch (error) {
    console.warn("progress sync failed", error); // best effort; retries on next event
  }
}

function todaysActivityBucket() {
  const key = activityDayKey();
  if (!activityCache[key]) activityCache[key] = { lessons: 0, cardsReviewed: 0, quizzes: [] };
  return activityCache[key];
}

function logLesson(title) {
  const bucket = todaysActivityBucket();
  bucket.lessons = (bucket.lessons || 0) + 1;
  bucket.lastLesson = title || "Study mission";
  awardStars(5); // built a mission
  persistActivity();
  renderActivityDashboard();
}

function logCardsReviewed(count = 1) {
  const bucket = todaysActivityBucket();
  const before = bucket.cardsReviewed || 0;
  bucket.cardsReviewed = before + count;
  awardStars(Math.floor(bucket.cardsReviewed / 5) - Math.floor(before / 5)); // 1 per 5 cards
  persistActivity();
}

// Generic per-day counter for tool usage (math problems solved, tutor lessons,
// explains, writing checks). Keeps the activity model open to new tools.
function bumpActivity(field, count = 1) {
  const bucket = todaysActivityBucket();
  bucket[field] = (bucket[field] || 0) + count;
  persistActivity();
  renderActivityDashboard();
}

function logQuizAttempt(title, score, total, missed = []) {
  const bucket = todaysActivityBucket();
  bucket.quizzes = bucket.quizzes || [];
  bucket.quizzes.push({
    title: title || "Quiz",
    score,
    total,
    ts: Date.now(),
    // keep the missed questions (trimmed) so a parent sees WHAT was struggled with
    missed: (Array.isArray(missed) ? missed : []).slice(0, 12).map(item => ({
      q: String(item.q || "").slice(0, 100),
      answer: String(item.answer || "").slice(0, 60),
      chosen: String(item.chosen || "(blank)").slice(0, 60)
    }))
  });
  awardStars(3 + (total && score / total >= 0.8 ? 2 : 0)); // took a quiz (+bonus for a strong score)
  persistActivity();
  renderActivityDashboard();
}

function renderActivityDashboard() {
  const stats = document.getElementById("activityStats");
  if (!stats) return;
  const days = last7DayKeys();
  const totals = { lessons: 0, cardsReviewed: 0, mathSolved: 0, tutorLessons: 0, explains: 0, writingChecks: 0 };
  const quizzes = [];
  const perDay = days.map(key => {
    const bucket = activityCache[key] || {};
    Object.keys(totals).forEach(field => { totals[field] += bucket[field] || 0; });
    (bucket.quizzes || []).forEach(quiz => quizzes.push(quiz));
    const actions = (bucket.lessons || 0) + (bucket.cardsReviewed || 0) + (bucket.mathSolved || 0)
      + (bucket.tutorLessons || 0) + (bucket.explains || 0) + (bucket.writingChecks || 0) + (bucket.quizzes || []).length;
    return { key, actions };
  });
  stats.innerHTML = `
    <div class="activity-stat"><b>${totals.lessons}</b><small>Missions built</small></div>
    <div class="activity-stat"><b>${totals.cardsReviewed}</b><small>Flashcards reviewed</small></div>
    <div class="activity-stat"><b>${quizzes.length}</b><small>Quizzes taken</small></div>
    <div class="activity-stat"><b>${totals.mathSolved}</b><small>Math problems solved</small></div>
    <div class="activity-stat"><b>${totals.tutorLessons}</b><small>Tutor lessons</small></div>
    <div class="activity-stat"><b>${totals.explains + totals.writingChecks}</b><small>Explain &amp; Writing</small></div>`;

  const week = document.getElementById("activityWeek");
  if (week) {
    const maxActions = Math.max(1, ...perDay.map(day => day.actions));
    week.innerHTML = `<span class="activity-heading">Daily activity</span><div class="activity-week-bars">${perDay.map(day => {
      const pct = day.actions ? Math.max(10, Math.round((day.actions / maxActions) * 100)) : 0;
      const label = new Date(`${day.key}T00:00:00`).toLocaleDateString(undefined, { weekday: "short" }).slice(0, 1);
      return `<div class="activity-day"><div class="activity-day-track"><span style="height:${pct}%"></span></div><small>${label}</small></div>`;
    }).join("")}</div>`;
  }

  const quizEl = document.getElementById("activityQuizzes");
  if (quizEl) {
    const recent = quizzes.slice(-8).reverse();
    quizEl.innerHTML = recent.length
      ? `<span class="activity-heading">Recent quiz scores</span>${recent.map(quiz => {
          const pct = quiz.total ? Math.round((quiz.score / quiz.total) * 100) : 0;
          const tone = pct >= 80 ? "good" : pct >= 50 ? "ok" : "low";
          const when = new Date(quiz.ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
          const missed = Array.isArray(quiz.missed) ? quiz.missed : [];
          const review = missed.length
            ? `<details class="activity-missed"><summary>${missed.length} to review</summary>${missed.map(item => (
                `<div class="activity-missed-item"><p>${escapeHtml(item.q)}</p><small>Answer: <b>${escapeHtml(item.answer)}</b>${item.chosen && item.chosen !== "(blank)" ? ` · chose ${escapeHtml(item.chosen)}` : " · left blank"}</small></div>`
              )).join("")}</details>`
            : "";
          return `<div class="activity-quiz-row"><div><b>${escapeHtml(quiz.title)}</b><small>${when}</small></div><span class="activity-score ${tone}">${quiz.score}/${quiz.total}</span></div>${review}`;
        }).join("")}`
      : `<div class="activity-empty">No quizzes yet this week. Build a mission and take a quiz to see scores here.</div>`;
  }
}

function showPanel(name) {
  const normalizedName = legacySettingsViews.has(name) ? "settings" : name;
  const panelName = panels[normalizedName] ? normalizedName : "dashboard";
  const panelId = panels[panelName];

  document.querySelectorAll(".view-panel").forEach(panel => {
    panel.classList.toggle("active", panel.id === panelId);
  });
  document.querySelectorAll(".side-link[data-view]").forEach(button => {
    button.classList.toggle("active", button.dataset.view === panelName);
  });

  if (toolDetails[panelName]) {
    selectTool(panelName);
  }
  if (panelName === "settings") { renderChildSelect(); renderVoiceSelect(); renderParentPinArea(); }
  if (panelName === "dashboard") renderStars();
  if (panelName !== "math") stopPhoneCapture(); // don't keep polling off-screen

  currentView = panelName;
  saveSettings({ activeView: panelName });
  document.querySelector(".workspace-main")?.scrollTo({ top: 0, behavior: "smooth" });
}

function selectTool(name) {
  const detail = toolDetails[name] || toolDetails.pdf;

  document.querySelectorAll("[data-tool]").forEach(tile => {
    tile.classList.toggle("active", tile.dataset.tool === name);
  });

  renderDashboardToolDetail(detail, name);
}

function renderDashboardToolDetail(detail, name) {
  const detailCard = document.getElementById("dashboardToolDetail");
  if (!detailCard) return;

  if (name === "pdf") {
    detailCard.innerHTML = `
      <div class="dash-detail-head">
        <span class="mission-eyebrow">Study Pack</span>
        <h3>Study Mission flow</h3>
        <p>Start with a source, review the must-know ideas, then practice in the right order.</p>
      </div>
      <div class="dash-study-flow dash-branch-flow">
        <button class="dash-flow-start" data-open-mission-step="study" type="button">
          <span>1</span>
          <div><b>Build Mission</b><small>Use a file or active tab</small></div>
        </button>
        <div class="flow-connectors" aria-hidden="true"><i></i><i></i></div>
        <div class="dash-branch-stack">
          <button class="kg-tool-tile dash-mini-tile" data-open-mission-step="cards" type="button">
            <div class="kg-tool-top"><span class="kg-tool-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="7" width="13" height="10" rx="2"></rect><path d="M8 7V5.8c0-1 .8-1.8 1.8-1.8H17c1 0 1.8.8 1.8 1.8V13"></path><path d="M8 11h7"></path><path d="M8 14h4"></path></svg></span><span class="status">Step 2</span></div>
            <div class="kg-tool-body"><h3>Flashcards</h3><p>Review terms first</p></div>
            <div class="kg-tile-art"><span class="kg-bubble">Term</span><span class="kg-bubble">Meaning</span></div>
          </button>
          <button class="kg-tool-tile lime dash-mini-tile" data-open-mission-step="quiz" type="button">
            <div class="kg-tool-top"><span class="kg-tool-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6"></path><path d="M10 21h4"></path><path d="M8 14c-1.2-1.1-2-2.7-2-4.4A6 6 0 0 1 18 9.6c0 1.7-.8 3.3-2 4.4-.7.6-1 1.3-1 2H9c0-.7-.3-1.4-1-2Z"></path><path d="M12 7.5a1.7 1.7 0 0 1 1.8 1.7c0 1.4-1.8 1.5-1.8 2.8"></path><path d="M12 15h.01"></path></svg></span><span class="status blue">Step 3</span></div>
            <div class="kg-tool-body"><h3>Quiz Me</h3><p>Check confidence</p></div>
            <div class="kg-tile-art kg-text-row"><span>15 Qs</span><span>Test</span></div>
          </button>
        </div>
      </div>
      <button class="small-button primary-action dash-detail-launch" data-open-mission-step="study" type="button">Start Study Mission</button>
    `;
    return;
  }

  detailCard.innerHTML = `
    <div class="dash-detail-head">
      <span class="mission-eyebrow">Tool Flow</span>
      <h3>${escapeHtml(detail.title)}</h3>
      <p>${escapeHtml(detail.description)}</p>
    </div>
    <div class="tool-detail-points dash-tool-flow">
      ${detail.points.map(([icon, label, value]) => (
        `<div class="tool-flow-step"><i class="tool-flow-dot" data-icon="${escapeHtml(icon)}"></i><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`
      )).join("")}
    </div>
    <button class="small-button primary-action dash-detail-launch" data-launch="${escapeHtml(name)}" type="button">Launch ${escapeHtml(detail.title)}</button>
  `;
}

function setGrade(button) {
  button.parentElement.querySelectorAll("button").forEach(tab => tab.classList.toggle("active", tab === button));
  saveSettings({ gradeBand: button.textContent.trim() });
}

function setPreferenceTab(button) {
  const group = button.closest("[data-preference-group]");
  if (!group) return;
  group.querySelectorAll("button").forEach(tab => tab.classList.toggle("active", tab === button));
  saveSettings({ [group.dataset.preferenceGroup]: button.dataset.preferenceValue || button.textContent.trim() });
}

function setToolSource(tool, source) {
  if (!sourceState[tool]) return;
  // Mission (pdf) and Tutor (read) share one source: setting one sets both.
  const shared = tool === "pdf" || tool === "read";
  if (shared && !["file", "browser"].includes(source)) source = "file";
  const groups = shared ? ["pdf", "read"] : [tool];
  groups.forEach(group => {
    sourceState[group] = source;
    document.querySelectorAll(`[data-source-group="${group}"] [data-source-option]`).forEach(button => {
      button.classList.toggle("active", button.dataset.sourceOption === source);
    });
  });
  document.querySelectorAll(`[data-source-card^="${tool}-"]`).forEach(card => {
    card.classList.toggle("active", card.dataset.sourceCard === `${tool}-${source}`);
  });
  const labelMap = { browser: "Active tab", file: "Local file", mission: "Study Mission", pdf: "Uploaded PDF", page: "Active page", screenshot: "Screenshot" };
  const status = document.querySelector(`[data-source-status="${tool}"]`);
  if (status) status.textContent = labelMap[source] || "Active tab";
  if (shared) {
    hideMissionFollowup();
    updatePdfSourceMode();
    updateTutorSourceSummary();
    saveSettings({ pdfSource: source, readSource: source });
    return;
  }
  if (tool === "math") updateMathSourceMode();
  if (tool === "explain") updateExplainSourceMode();
  saveSettings({ [`${tool}Source`]: source });
}


function missionSetPointers(currentSet, generatedCount, kind) {
  const pct = Math.round((generatedCount / missionMaxSets) * 100);
  let dots = "";
  for (let i = 1; i <= missionMaxSets; i += 1) {
    const generated = i <= generatedCount;
    const cls = `mission-dot${generated ? " done" : ""}${i === currentSet ? " current" : ""}`;
    const attr = generated ? `data-${kind}-set="${i}"` : "disabled";
    dots += `<button type="button" class="${cls}" ${attr} aria-label="${kind === "quiz" ? "Quiz" : "Card"} set ${i}${generated ? "" : " (not made yet)"}">${i}</button>`;
  }
  const label = currentSet >= missionMaxSets
    ? "You made every set — great work!"
    : `${kind === "quiz" ? "Quiz" : "Card"} set ${currentSet} of ${missionMaxSets} · tap a number to jump back`;
  return `<div class="mission-progress"><div class="mission-progress-bar"><span style="width:${pct}%"></span></div><div class="mission-dots">${dots}</div><small>${label}</small></div>`;
}

function goToQuizSet(setNumber) {
  const set = missionQuizSets[setNumber - 1];
  if (!set || !currentStudyPack) return;
  currentStudyPack.quiz = set;
  missionQuizState.setNumber = setNumber;
  missionQuizState.answers = {};
  missionQuizState.submitted = false;
  renderMissionQuiz();
}

function goToCardSet(setNumber) {
  const set = missionCardSets[setNumber - 1];
  if (!set || !currentStudyPack) return;
  currentStudyPack.flashcards = set;
  missionCardsState.setNumber = setNumber;
  missionCardsState.index = 0;
  missionCardsState.flipped = false;
  missionCardsState.helpOpen = false;
  missionCardsState.helpText = "";
  renderMissionCards();
}

function missionEmptyState(kind) {
  return `<div class="mission-empty"><b>No ${kind} yet</b><p>Build a study mission first, then ${kind === "flashcards" ? "review key terms" : "test yourself"} here.</p><button class="small-button primary-action" data-mission-step="study" type="button">Build a study mission</button></div>`;
}

function formatMissionReadTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function updateMissionReadUi() {
  const panel = document.getElementById("missionReadingPanel");
  const timer = document.getElementById("missionReadTimer");
  const status = document.getElementById("missionReadStatus");
  const toggle = document.getElementById("missionReadToggleButton");
  const done = document.getElementById("missionReadDoneButton");
  const next = document.getElementById("missionReadNext");
  const mainIdea = document.getElementById("missionReadMainIdea");
  if (panel) panel.hidden = !currentStudyPack || activeMissionStep !== "study";
  const missionIntro = document.getElementById("missionIntro");
  if (missionIntro) missionIntro.hidden = Boolean(currentStudyPack) || activeMissionStep !== "study";
  if (timer) timer.textContent = formatMissionReadTime(missionReadSeconds);
  if (mainIdea && currentStudyPack) mainIdea.textContent = currentStudyPack.mainIdea || "Read the mission first, then turn it into practice.";
  const isRunning = Boolean(missionReadTimerId);
  if (status) {
    status.textContent = missionReadDone ? "Read" : isRunning ? "Reading" : missionReadSeconds ? "Paused" : "Not started";
    status.className = `status ${missionReadDone ? "blue" : ""}`.trim();
  }
  if (toggle) {
    toggle.textContent = isRunning ? "Pause Reading" : missionReadSeconds ? "Resume Reading" : "Start Reading";
    toggle.disabled = missionReadDone;
  }
  if (done) {
    done.textContent = missionReadDone ? "Reading done" : "I read this";
    done.classList.toggle("primary-action", missionReadDone);
  }
  if (next) next.hidden = !missionReadDone;
}

function setMissionReadTimer(active) {
  if (missionReadTimerId) {
    clearInterval(missionReadTimerId);
    missionReadTimerId = 0;
  }
  if (active && !missionReadDone) {
    missionReadTimerId = setInterval(() => {
      missionReadSeconds += 1;
      updateMissionReadUi();
    }, 1000);
  }
  updateMissionReadUi();
}

function resetMissionReading() {
  setMissionReadTimer(false);
  missionReadSeconds = 0;
  missionReadDone = false;
  updateMissionReadUi();
}

function markMissionReadDone() {
  missionReadDone = true;
  setMissionReadTimer(false);
  setPdfStatus("Nice work. Flashcards and quiz are ready for practice.", "blue");
}

function showMissionStep(step = "study") {
  const stepName = ["study", "cards", "quiz"].includes(step) ? step : "study";
  activeMissionStep = stepName;
  if (stepName !== "study" && missionReadTimerId) setMissionReadTimer(false);
  document.querySelectorAll("[data-mission-step]").forEach(button => {
    button.classList.toggle("active", button.dataset.missionStep === stepName);
  });
  const panelMap = {
    study: "pdfUploadPanel",
    cards: "missionCardsPanel",
    quiz: "missionQuizPanel"
  };
  Object.entries(panelMap).forEach(([name, id]) => {
    const panel = document.getElementById(id);
    if (panel) panel.hidden = name !== stepName;
  });
  if (stepName === "cards") renderMissionCards();
  if (stepName === "quiz") renderMissionQuiz();
  if ((stepName === "cards" || stepName === "quiz") && currentStudyPack && !missionReadDone) {
    setPdfStatus("Tip: spend a few focused minutes reading the mission first, then practice.", "blue");
  }
  updateMissionReadUi();
}

function renderMissionCards() {
  const preview = document.getElementById("missionFlashcardPreview");
  const status = document.getElementById("missionCardsStatus");
  const modeToggle = document.getElementById("missionCardsModeToggle");
  const cards = currentStudyPack?.flashcards || [];
  if (!cards.length) {
    if (status) status.textContent = "No cards yet";
    if (modeToggle) modeToggle.innerHTML = "";
    if (preview) preview.innerHTML = missionEmptyState("flashcards");
    return;
  }
  missionCardsState.index = Math.min(Math.max(missionCardsState.index, 0), Math.max(cards.length - 1, 0));
  if (status) status.textContent = `${missionCardsState.index + 1} of ${cards.length || 1} cards`;
  if (!preview) return;
  const card = cards[missionCardsState.index] || { term: "Key term", meaning: "A definition will appear after generating cards." };
  const guessTerm = missionCardsState.promptMode === "meaning";
  if (modeToggle) {
    modeToggle.innerHTML = `
      <button type="button" data-card-mode="meaning" class="${guessTerm ? "active" : ""}" aria-pressed="${guessTerm}">Clue → term</button>
      <button type="button" data-card-mode="term" class="${!guessTerm ? "active" : ""}" aria-pressed="${!guessTerm}">Term → clue</button>
    `;
  }
  const promptLabel = guessTerm ? "Guess the term" : "Explain the idea";
  const promptText = guessTerm ? card.meaning : card.term;
  const revealTitle = guessTerm ? card.term : card.meaning;
  const revealText = guessTerm ? card.meaning : card.term;
  preview.innerHTML = `
    <div class="mission-card-stage">
      <div class="mission-card-shell">
        <div class="mission-flip-card ${missionCardsState.flipped ? "flipped" : ""}" aria-live="polite">
          <div class="mission-card-side mission-card-front">
            <button class="mission-card-fold" data-card-flip="true" type="button" aria-label="Flip card to reveal answer">
              <span>Flip</span>
            </button>
            <div class="mission-card-face">
              <small>${escapeHtml(promptLabel)}</small>
              <b>${escapeHtml(promptText)}</b>
              <p>Say your answer first, then tap the folded corner.</p>
            </div>
          </div>
          <div class="mission-card-side mission-card-back">
            <button class="mission-card-fold" data-card-flip="true" type="button" aria-label="Flip card back">
              <span>Back</span>
            </button>
            <div class="mission-card-answer">
              <small>Answer</small>
              <b>${escapeHtml(revealTitle)}</b>
              <p>${escapeHtml(revealText)}</p>
            </div>
          </div>
        </div>
      </div>
      <div class="mission-card-nav-row">
        <button class="card-nav-button" id="missionCardPrev" type="button" aria-label="Previous card" ${missionCardsState.index <= 0 ? "disabled" : ""}>‹</button>
        <button class="card-nav-button" id="missionCardNext" type="button" aria-label="Next card" ${missionCardsState.index >= cards.length - 1 ? "disabled" : ""}>›</button>
      </div>
      ${missionSetPointers(missionCardsState.setNumber, missionCardSets.length, "cards")}
      <div class="mission-card-actions">
        <button class="small-button" id="missionCardExplainButton" type="button">Ask about this card</button>
        ${missionCardSets.length < missionMaxSets ? `<button class="small-button primary-action" id="missionGenerateCardsButton" type="button">New cards</button>` : ""}
      </div>
      <div class="mission-card-help" id="missionCardHelp" ${missionCardsState.helpOpen ? "" : "hidden"}>${escapeHtml(missionCardsState.helpText || "Get a simpler clue, example, and memory trick for this card.")}</div>
    </div>
  `;
}

async function explainMissionCard() {
  const cards = currentStudyPack?.flashcards || [];
  if (!cards.length) return;
  const card = cards[missionCardsState.index] || { term: "Key term", meaning: "A definition will appear after generating cards." };
  missionCardsState.helpOpen = true;
  missionCardsState.helpText = "Explaining this card...";
  renderMissionCards();
  try {
    const settings = await getOpenAISettings();
    if (!settings) {
      missionCardsState.helpText = `${card.term}: ${card.meaning} Memory trick: connect the word to one short picture in your mind.`;
      renderMissionCards();
      return;
    }
    const result = await callOpenAIJson({
      settings,
      instructions: "You are KiddieGPT Flashcard Helper for K-8 students. Explain one flashcard briefly. Return only valid JSON.",
      text: `Term: ${card.term}\nMeaning: ${card.meaning}\nReturn JSON with simple string, example string, memoryTrick string. Keep each under 18 words.`
    });
    missionCardsState.helpText = `${result.simple || card.meaning} Example: ${result.example || "Use it in one sentence from class."} Memory trick: ${result.memoryTrick || "Picture the idea clearly."}`;
  } catch (error) {
    console.warn("Card explanation failed", error);
    missionCardsState.helpText = `${card.term}: ${card.meaning} Try making your own example sentence.`;
  }
  renderMissionCards();
}

function getMissionQuizQuestions() {
  return (currentStudyPack?.quiz || []).filter(item => item?.question && Array.isArray(item.choices) && item.answer);
}

async function generateMoreMissionQuiz() {
  if (!currentStudyPack || missionQuizSets.length >= missionMaxSets) return;
  const settings = await getOpenAISettings();
  if (!settings) {
    setPdfStatus("Add your OpenAI key in Settings to make new questions.", "warn");
    return;
  }
  const button = document.getElementById("missionQuizNewSetButton");
  if (button) {
    button.disabled = true;
    button.textContent = "Making new questions…";
  }
  try {
    const existing = (currentStudyPack.quiz || []).map(item => item.question).join(" | ").slice(0, 800);
    const result = await callOpenAIJson({
      settings,
      instructions: "You are KiddieGPT quiz maker for K-8 students. Make fresh multiple-choice questions from the study material only, never general knowledge. Return only valid JSON.",
      text: `Study material:\n${getCurrentStudyPackText()}\nMake 12 NEW multiple-choice questions about this material for a grade ${settings.gradeBand || "6-8"} student. Do not repeat these earlier questions: ${existing}. Return JSON with a quiz array of 12 objects: question string, choices array of 4 strings, answer string (must exactly match one choice).`
    });
    const quiz = (Array.isArray(result.quiz) ? result.quiz : []).filter(item => item?.question && Array.isArray(item.choices) && item.answer).slice(0, 15);
    if (!quiz.length) throw new Error("No new questions were returned.");
    missionQuizSets.push(quiz);
    currentStudyPack.quiz = quiz;
    missionQuizState.answers = {};
    missionQuizState.submitted = false;
    missionQuizState.setNumber = missionQuizSets.length;
    renderMissionQuiz();
  } catch (error) {
    console.warn("New quiz failed", error);
    if (button) {
      button.disabled = false;
      button.textContent = "New questions";
    }
    setPdfStatus(`Could not make new questions: ${friendlyError(error)}`, "warn");
  }
}

async function generateMoreMissionFlashcards() {
  if (!currentStudyPack || missionCardSets.length >= missionMaxSets) return;
  const settings = await getOpenAISettings();
  if (!settings) {
    setPdfStatus("Add your OpenAI key in Settings to make new cards.", "warn");
    return;
  }
  const button = document.getElementById("missionGenerateCardsButton");
  if (button) {
    button.disabled = true;
    button.textContent = "Making new cards…";
  }
  try {
    const existing = (currentStudyPack.flashcards || []).map(card => card.term).join(", ").slice(0, 400);
    const result = await callOpenAIJson({
      settings,
      instructions: "You are KiddieGPT flashcard maker for K-8 students. Make fresh flashcards from the study material only, never general knowledge. Return only valid JSON.",
      text: `Study material:\n${getCurrentStudyPackText()}\nMake 10 NEW flashcards about this material for a grade ${settings.gradeBand || "6-8"} student. Focus on different terms than these: ${existing}. Return JSON with a flashcards array of 10 objects: term string, meaning string.`
    });
    const cards = (Array.isArray(result.flashcards) ? result.flashcards : []).filter(card => card?.term && card?.meaning).slice(0, 12);
    if (!cards.length) throw new Error("No new cards were returned.");
    missionCardSets.push(cards);
    currentStudyPack.flashcards = cards;
    missionCardsState.index = 0;
    missionCardsState.flipped = false;
    missionCardsState.helpOpen = false;
    missionCardsState.helpText = "";
    missionCardsState.setNumber = missionCardSets.length;
    renderMissionCards();
  } catch (error) {
    console.warn("New cards failed", error);
    if (button) {
      button.disabled = false;
      button.textContent = "New cards";
    }
    setPdfStatus(`Could not make new cards: ${friendlyError(error)}`, "warn");
  }
}

function renderMissionQuiz() {
  const questions = getMissionQuizQuestions();
  const list = document.getElementById("missionQuizList");
  const bar = document.getElementById("missionQuizAnsweredBar");
  const meta = document.getElementById("missionQuizAnsweredMeta");
  const status = document.getElementById("missionQuizStatus");
  const feedback = document.getElementById("missionQuizFeedback");
  const submit = document.getElementById("missionQuizSubmitButton");
  if (!list) return;

  if (!questions.length) {
    if (status) status.textContent = "No quiz yet";
    if (bar) bar.style.width = "0%";
    if (meta) meta.textContent = "";
    if (submit) submit.hidden = true;
    if (feedback) { feedback.hidden = true; feedback.innerHTML = ""; }
    list.innerHTML = missionEmptyState("quiz");
    return;
  }
  if (submit) submit.hidden = false;

  const answered = Object.keys(missionQuizState.answers).length;
  if (status) status.textContent = `${questions.length} questions`;
  if (bar) bar.style.width = `${questions.length ? (answered / questions.length) * 100 : 0}%`;
  if (meta) meta.textContent = `${answered} of ${questions.length} answered`;
  if (submit) submit.disabled = missionQuizState.submitted;

  list.innerHTML = questions.map((item, index) => {
    const selected = missionQuizState.answers[index];
    const choices = (item.choices || []).slice(0, 4).map((choice, choiceIndex) => {
      const checked = selected === choice ? "checked" : "";
      const answeredClass = selected === choice ? "answered" : "";
      return `<label class="choice radio ${answeredClass}"><input type="radio" name="mission-quiz-q-${index}" value="${escapeHtml(choice)}" data-mission-quiz-index="${index}" ${checked} ${missionQuizState.submitted ? "disabled" : ""}><span>${String.fromCharCode(65 + choiceIndex)}. ${escapeHtml(choice)}</span></label>`;
    }).join("");
    return `<article class="quiz-question-card mission-question-card"><div class="mission-question-head"><span>Q${index + 1}</span><h4>${escapeHtml(item.question)}</h4></div><div class="choice-list">${choices}</div></article>`;
  }).join("");

  if (!feedback) return;
  if (!missionQuizState.submitted) {
    feedback.hidden = true;
    feedback.innerHTML = "";
    return;
  }
  const wrong = questions
    .map((item, index) => ({ item, picked: missionQuizState.answers[index] }))
    .filter(({ item, picked }) => picked && picked !== item.answer);
  const score = questions.filter((item, index) => missionQuizState.answers[index] === item.answer).length;
  feedback.hidden = false;
  const canGenerate = missionQuizSets.length < missionMaxSets;
  feedback.innerHTML = `<h3>${score}/${questions.length} correct</h3><p>${wrong.length ? "Review these and try again after flashcards." : "Great work. You are ready for the next mission step."}</p>${missionSetPointers(missionQuizState.setNumber, missionQuizSets.length, "quiz")}<div class="quiz-feedback-actions"><button class="small-button" id="missionQuizRetakeButton" type="button">Retake quiz</button>${canGenerate ? `<button class="small-button primary-action" id="missionQuizNewSetButton" type="button">New questions</button>` : ""}</div>${wrong.length ? wrong.map(({ item, picked }) => `<article><b>${escapeHtml(item.question)}</b><span>Your answer: ${escapeHtml(picked)}</span><span>Correct: ${escapeHtml(item.answer)}</span></article>`).join("") : ""}`;
}

function setScreenshotStatus(text, tone = "") {
  const status = document.getElementById("screenshotStatus");
  if (!status) return;
  status.textContent = text;
  status.className = `status ${tone}`.trim();
}

function renderScreenshot(src) {
  const preview = document.getElementById("screenshotPreview");
  const observation = document.getElementById("screenshotObservation");
  if (!preview || !observation) return;
  selectedExplainCapture = src;

  if (preview.classList.contains("explain-input-box")) {
    preview.classList.add("captured");
    preview.innerHTML = `<i>✓</i><div><b>Screenshot captured</b><small>Click Explain to turn the image into a simple explanation.</small></div>`;
  } else {
    preview.innerHTML = `<img src="${src}" alt="Captured visible tab screenshot">`;
  }
  observation.textContent = "Screenshot captured. KiddieGPT would identify the visible question, diagram labels, and confusing parts before offering a grade-safe explanation.";
  setScreenshotStatus("Captured");
  saveSettings({ lastScreenshotAt: Date.now() });
}

function updateSettingsStatus(message, tone = "") {
  const status = document.getElementById("settingsStatus");
  if (!status) return;
  status.textContent = message;
  status.className = `settings-note settings-status-line ${tone}`.trim();
  status.hidden = !message;
}

async function loadSettingsForm() {
  const settings = await getSettings();
  const toggle = document.getElementById("openaiDemoToggle");
  const keyInput = document.getElementById("openaiApiKeyInput");
  const modelInput = document.getElementById("openaiModelInput");
  if (toggle) toggle.checked = Boolean(settings.openaiDemoEnabled);
  if (keyInput) keyInput.value = settings.openaiApiKey || "";
  if (modelInput) modelInput.value = settings.openaiModel || MODELS.defaultText;
}

async function saveSettingsForm() {
  const keyInput = document.getElementById("openaiApiKeyInput");
  // The demo-key UI was removed; the key now comes from local-settings/portal.
  // Only touch OpenAI settings when that UI is actually present (dev builds).
  if (keyInput) {
    const key = keyInput.value.trim();
    const model = document.getElementById("openaiModelInput")?.value.trim() || MODELS.defaultText;
    const enabled = Boolean(document.getElementById("openaiDemoToggle")?.checked);
    await saveSettings({ openaiDemoEnabled: enabled, openaiApiKey: key, openaiModel: model });
    updateSettingsStatus(key ? "Settings saved." : "Saved. Add a key before using OpenAI demo mode.", key ? "" : "warn");
    return;
  }
  // Student preferences (grade, style, math gate) already auto-save on change.
  updateSettingsStatus("Settings saved.", "");
}

async function clearOpenAISettings() {
  document.getElementById("openaiApiKeyInput").value = "";
  document.getElementById("openaiDemoToggle").checked = false;
  await saveSettings({ openaiDemoEnabled: false, openaiApiKey: "" });
  updateSettingsStatus("OpenAI demo key cleared.");
}

async function testOpenAIKey() {
  updateSettingsStatus("Checking KiddieGPT connection...", "blue");
  try {
    await loadPortalToken();
    if (!portalToken) {
      updateSettingsStatus("Sign in with your parent account to connect.", "warn");
      renderPortalGate("login", "");
      return;
    }
    const session = await refreshEntitlement();
    if (!session) {
      updateSettingsStatus("Your session expired. Please sign in again.", "warn");
      renderPortalGate("login", "");
      return;
    }
    if (!session.entitled) {
      updateSettingsStatus("Signed in, but this account has no active plan.", "warn");
      return;
    }
    const limits = await getUsageLimits().catch(() => null);
    applyPortalControls(limits);
    if (limits && !limits.aiConfigured) {
      updateSettingsStatus("Connected, but AI isn't configured on the server yet.", "warn");
      return;
    }
    const remaining = limits?.remaining;
    updateSettingsStatus(remaining
      ? `Connected. ${remaining.mathProblems} math and ${remaining.voiceMinutes} voice min left today.`
      : "Connected to KiddieGPT.");
  } catch (error) {
    updateSettingsStatus(`Connection check failed: ${friendlyError(error)}`, "warn");
  }
}

const PORTAL_ERROR_MESSAGES = {
  cap_reached: "You've reached today's KiddieGPT limit. It resets tomorrow.",
  subscription_inactive: "This KiddieGPT plan isn't active. Manage the subscription in the parent portal.",
  voice_disabled: "Tutor voice is turned off for this account.",
  ai_not_configured: "KiddieGPT AI isn't set up yet. Please try again later.",
  auth_required: "Please sign in again to keep using KiddieGPT.",
  openai_error: "The tutor had trouble responding. Please try again.",
  openai_unreachable: "Couldn't reach the tutor. Check your connection and try again.",
  content_blocked: "That can't be shown here. Try asking about your schoolwork in a different way."
};

// Kid-safety net: screen AI output (and student free-text) for unsafe content.
// Uses the portal moderation proxy in production; falls back to a direct OpenAI
// moderation call when a local dev key is present. Fails OPEN — a moderation
// outage never blocks legitimate schoolwork, since the grade-safe prompts are
// the primary guard and this is defense-in-depth.
async function moderateFlagged(settings, text) {
  const input = String(text || "").trim().slice(0, 4000);
  if (!input) return false;
  try {
    if (settings?.openaiApiKey) {
      const res = await fetch("https://api.openai.com/v1/moderations", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.openaiApiKey}` },
        body: JSON.stringify({ model: MODELS.moderation, input })
      });
      if (!res.ok) return false;
      const data = await res.json().catch(() => ({}));
      return Boolean(data?.results?.some(result => result.flagged));
    }
    // TODO(backend): POST /api/ai/moderations { input } -> { flagged: boolean }.
    const res = await fetch(`${portalBaseUrl()}/api/ai/moderations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(portalToken ? { Authorization: `Bearer ${portalToken}` } : {}) },
      body: JSON.stringify({ input, childId: portalSession?.childId || undefined })
    });
    if (!res.ok) return false; // endpoint not live yet -> fail open
    const data = await res.json().catch(() => ({}));
    return Boolean(data?.flagged ?? data?.results?.some(result => result.flagged));
  } catch {
    return false;
  }
}

function friendlyError(error) {
  if (error && error.name === "AbortError") {
    return "The tutor took too long to respond. Try a smaller file or check your connection.";
  }
  if (error && error.code && PORTAL_ERROR_MESSAGES[error.code]) return PORTAL_ERROR_MESSAGES[error.code];
  const message = (error && error.message) || "";
  try {
    const parsed = JSON.parse(message);
    const code = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
    if (code && PORTAL_ERROR_MESSAGES[code]) return PORTAL_ERROR_MESSAGES[code];
    return parsed.error?.message || (typeof parsed.error === "string" ? parsed.error : "") || message || "Something went wrong.";
  } catch {
    return message || "Something went wrong.";
  }
}

// Returns an AI context when the parent is signed in AND entitled; otherwise
// null so existing callers fall back to their offline/degraded behaviour. Local
// preferences (gradeBand, voice, etc.) are carried through unchanged.
async function getOpenAISettings() {
  const settings = await getSettings();
  if (!portalToken || !portalSession?.entitled) return null;
  return { ...settings, portal: true };
}

async function callOpenAISpeech({ settings, text, voice, gradeBand = "6-8" }) {
  // All AI goes through the portal proxy so usage/tokens are recorded and the
  // OpenAI key stays server-side.
  // Screen what will be spoken aloud before generating audio.
  if (await moderateFlagged(settings, text)) throw new PortalError("content_blocked", 200);
  // Single voice-resolution point: student's choice if still admin-approved, else default.
  const useVoice = resolveVoice(voice);
  // Test mode: call OpenAI TTS directly with the local dev key (no portal backend).
  if (portalToken === OTP_TEST_TOKEN && settings?.openaiApiKey) {
    const direct = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.openaiApiKey}` },
      body: JSON.stringify({ model: MODELS.tts, voice: useVoice, input: text, instructions: TTS_INSTRUCTION, response_format: "mp3" })
    });
    if (!direct.ok) {
      const detail = await direct.json().catch(() => ({}));
      throw new PortalError(detail?.error?.message || "openai_error", direct.status, detail);
    }
    return direct.blob();
  }
  const response = await fetch(`${portalBaseUrl()}/api/ai/speech`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(portalToken ? { Authorization: `Bearer ${portalToken}` } : {})
    },
    body: JSON.stringify({
      text,
      voice: useVoice,
      model: MODELS.tts,
      instructions: TTS_INSTRUCTION,
      gradeBand,
      childId: portalSession?.childId || undefined,
      estSeconds: Math.ceil(String(text || "").length / 14)
    })
  });
  if (response.status === 401) { await portalSignOut(); throw new PortalError("auth_required", 401); }
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    const code = detail.error || "openai_error";
    if (code === "ai_not_configured") reportIssue("api_key", "AI not configured (voice)");
    else if (!["cap_reached", "subscription_inactive", "voice_disabled", "auth_required"].includes(code)) reportIssue("extension_error", "Voice request failed: " + code);
    throw new PortalError(code, response.status, detail);
  }
  return response.blob();
}

async function callOpenAIJson({ settings, instructions, text, parts = [], tool, timeoutMs = 90000, moderate = true, model }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const content = [{ type: "input_text", text }, ...parts];
  // Model routing: an explicit per-call model wins, then any local override,
  // then the benchmark default (Luna). gpt-4.1 is no longer a fallback.
  const useModel = model || settings?.openaiModel || MODELS.defaultText;
  // Test mode (dummy OTP + a local dev key): call OpenAI directly, since there is
  // no portal backend to proxy through. Production uses a real token with no
  // local key, so this branch never fires there.
  if (portalToken === OTP_TEST_TOKEN && settings?.openaiApiKey) {
    const direct = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.openaiApiKey}` },
      body: JSON.stringify({ model: useModel, instructions, input: [{ role: "user", content }] })
    }).finally(() => clearTimeout(timeoutId));
    const directData = await direct.json().catch(() => ({}));
    if (!direct.ok) throw new PortalError(directData?.error?.message || "openai_error", direct.status, directData);
    const directText = extractOutputText(directData);
    if (moderate && await moderateFlagged(settings, directText)) throw new PortalError("content_blocked", 200);
    return parseOpenAIJson(directText);
  }
  const response = await fetch(`${portalBaseUrl()}/api/ai/responses`, {
    method: "POST",
    signal: controller.signal,
    headers: {
      "Content-Type": "application/json",
      ...(portalToken ? { Authorization: `Bearer ${portalToken}` } : {})
    },
    body: JSON.stringify({
      tool: tool || toolForCurrentView(),
      childId: portalSession?.childId || undefined,
      model: useModel,
      instructions,
      input: [{ role: "user", content }]
    })
  }).finally(() => clearTimeout(timeoutId));
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) { await portalSignOut(); throw new PortalError("auth_required", 401); }
  if (!response.ok) {
    const code = data.error || "openai_error";
    if (code === "ai_not_configured") reportIssue("api_key", "AI not configured (tutor request)");
    else if (!["cap_reached", "subscription_inactive", "voice_disabled", "auth_required"].includes(code)) reportIssue("extension_error", "AI request failed: " + code);
    throw new PortalError(code, response.status, data);
  }
  const outputText = extractOutputText(data);
  // Screen the model's response before the student ever sees it.
  if (moderate && await moderateFlagged(settings, outputText)) {
    throw new PortalError("content_blocked", 200);
  }
  return parseOpenAIJson(outputText);
}

// ---- Parent sign-in gate (injected; no HTML/CSS file changes needed) ------
let portalLimits = null;
let portalRequireSteps = false; // set from the family's parental controls

// Reflect the parent's controls (from /api/ai/usage-limits) into the extension.
// Voice-off and daily caps are also enforced server-side; this mirrors them in UI.
function applyPortalControls(limits) {
  portalLimits = limits || null;
  portalRequireSteps = Boolean(limits && limits.requireSteps);
}

function ensureGateStyles() {
  if (document.getElementById("kg-gate-styles")) return;
  const style = document.createElement("style");
  style.id = "kg-gate-styles";
  style.textContent = `
    #kg-portal-gate .kg-gate-backdrop{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;
      justify-content:center;padding:20px;background:rgba(0,45,41,.55);backdrop-filter:blur(6px);
      font-family:Inter,Arial,sans-serif;}
    #kg-portal-gate .kg-gate-card{width:100%;max-width:320px;background:#fff;border-radius:20px;padding:24px;
      display:flex;flex-direction:column;gap:12px;box-shadow:0 24px 60px rgba(0,0,0,.28);text-align:center;}
    #kg-portal-gate .kg-gate-logo{width:52px;height:52px;margin:0 auto;}
    #kg-portal-gate h2{margin:0;color:#004f48;font-size:20px;font-weight:800;}
    #kg-portal-gate p{margin:0;color:#3f5a56;font-size:13px;line-height:1.4;}
    #kg-portal-gate label{display:flex;flex-direction:column;gap:4px;text-align:left;font-size:12px;
      font-weight:700;color:#004f48;}
    #kg-portal-gate input{padding:10px 12px;border:1px solid #cfe0dc;border-radius:10px;font-size:14px;}
    #kg-portal-gate input:focus{outline:none;border-color:#004f48;}
    #kg-portal-gate .kg-gate-primary{margin-top:4px;padding:11px 14px;border:none;border-radius:999px;
      background:#004f48;color:#fff;font-weight:800;font-size:14px;cursor:pointer;text-decoration:none;
      display:inline-block;}
    #kg-portal-gate .kg-gate-primary:hover{background:#01605a;}
    #kg-portal-gate .kg-gate-link{background:none;border:none;color:#4f6b67;font-size:12px;cursor:pointer;
      text-decoration:underline;}
    #kg-portal-gate .kg-gate-status{min-height:16px;color:#b23a48;font-weight:600;}
    #kg-portal-gate .kg-gate-footer{margin-top:8px;padding-top:12px;border-top:1px dashed #cfe0dc;display:flex;
      flex-direction:column;gap:2px;align-items:center;}
    #kg-portal-gate .kg-gate-footer span{color:#6b8079;font-size:11px;font-weight:600;}
    #kg-portal-gate .kg-gate-footer b{color:#004f48;font-size:22px;font-weight:800;letter-spacing:6px;}`;
  document.head.appendChild(style);
}

function portalGateEl() {
  let el = document.getElementById("kg-portal-gate");
  if (!el) {
    el = document.createElement("div");
    el.id = "kg-portal-gate";
    document.body.appendChild(el);
  }
  return el;
}

function hidePortalGate() {
  const el = document.getElementById("kg-portal-gate");
  if (el) el.remove();
}

function renderPortalGate(mode, message) {
  ensureGateStyles();
  const el = portalGateEl();
  const base = portalBaseUrl();
  const inactive = mode === "inactive";
  const codeStep = !inactive && otpState.step === "code";
  el.innerHTML = `
    <div class="kg-gate-backdrop">
      <form class="kg-gate-card" id="kg-gate-form">
        <img src="icons/logo-mascot.png" alt="" class="kg-gate-logo">
        <h2>${inactive ? "Subscription needed" : "Parent sign in"}</h2>
        <p>${inactive
          ? "This account doesn't have an active KiddieGPT plan yet."
          : codeStep
            ? `Enter the code we sent to <b>${escapeHtml(otpState.email)}</b>.`
            : "Sign in with your parent email. We'll send you a one-time code."}</p>
        ${inactive ? "" : codeStep ? `
        <label>Verification code<input type="text" id="kg-gate-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="1234" required></label>
        <button type="submit" class="kg-gate-primary">Verify code</button>
        <button type="button" class="kg-gate-link" id="kg-gate-resend">Resend code</button>
        <button type="button" class="kg-gate-link" id="kg-gate-changeemail">Use a different email</button>` : `
        <label>Email<input type="email" id="kg-gate-email" autocomplete="username" required></label>
        <button type="submit" class="kg-gate-primary">Send code</button>`}
        ${inactive ? `
        <a class="kg-gate-primary" href="${base}" target="_blank" rel="noopener">Manage subscription</a>
        <button type="button" class="kg-gate-link" id="kg-gate-signout">Use a different account</button>` : ""}
        <p class="kg-gate-status" id="kg-gate-status">${message || ""}</p>
        ${codeStep && otpState.sentCode ? `<div class="kg-gate-footer"><span>Testing mode — your code is</span><b>${escapeHtml(otpState.sentCode)}</b></div>` : ""}
      </form>
    </div>`;
  const form = el.querySelector("#kg-gate-form");
  const status = el.querySelector("#kg-gate-status");
  if (!inactive && form && !codeStep) {
    storageGet([PORTAL_EMAIL_KEY]).then(data => {
      const input = el.querySelector("#kg-gate-email");
      if (input && data[PORTAL_EMAIL_KEY]) input.value = data[PORTAL_EMAIL_KEY];
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const email = el.querySelector("#kg-gate-email").value.trim();
      if (!email) { status.textContent = "Enter your parent email."; return; }
      status.textContent = "Sending code…";
      try {
        await requestOtp(email);
        renderPortalGate("login", "");
      } catch (error) {
        status.textContent = friendlyError(error) || "Could not send the code.";
        reportIssue("login_failed", "OTP request failed: " + (friendlyError(error) || "unknown"), { email });
      }
    });
  }
  if (!inactive && form && codeStep) {
    el.querySelector("#kg-gate-code")?.focus();
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      status.textContent = "Checking…";
      try {
        await verifyOtp(otpState.email, el.querySelector("#kg-gate-code").value);
        await refreshEntitlement();
        renderPortalState();
      } catch (error) {
        status.textContent = "That code didn't match. Check your email (testing code: 1234).";
        reportIssue("login_failed", "OTP verify failed for " + (otpState.email || ""), { email: otpState.email });
      }
    });
    el.querySelector("#kg-gate-resend")?.addEventListener("click", async () => {
      await requestOtp(otpState.email);
      renderPortalGate("login", "New code sent.");
    });
    el.querySelector("#kg-gate-changeemail")?.addEventListener("click", () => {
      otpState = { step: "email", email: "", sentCode: "" };
      renderPortalGate("login", "");
    });
  }
  const signout = el.querySelector("#kg-gate-signout");
  if (signout) {
    signout.addEventListener("click", async () => {
      await portalSignOut();
      renderPortalGate("login", "");
    });
  }
}

function renderPortalState() {
  if (portalToken && portalSession?.entitled) {
    hidePortalGate();
    renderChildSelect(); // refresh the student dropdown once the session is ready
    getUsageLimits().then(applyPortalControls).catch(() => {});
    return;
  }
  if (portalToken && portalSession && !portalSession.entitled) {
    renderPortalGate("inactive", portalSession.locked ? "This account is locked. Contact KiddieGPT support." : "");
    return;
  }
  renderPortalGate("login", "");
}

async function bootstrapPortal() {
  await loadPortalToken();
  await refreshEntitlement();
  renderPortalState();
}

function getCurrentStudyPackText() {
  const pack = currentStudyPack;
  if (!pack) return "";
  return [
    `Main idea: ${pack.mainIdea}`,
    `Remember: ${pack.rememberThis}`,
    `Key terms: ${(pack.keyTerms || []).join(", ")}`,
    `Read aloud: ${pack.readAloud}`
  ].join("\n");
}

function setTutorStatus(message, tone = "") {
  const status = document.getElementById("tutorStatus");
  if (!status) return;
  status.textContent = message;
  status.className = tone;
}

function tutorSourceMode() {
  return sourceState.read || "mission";
}

function splitTutorSentences(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const parts = clean.match(/[^.!?]+[.!?]*(?:\s|$)/g) || [clean];
  return parts.map(part => part.trim()).filter(Boolean);
}

async function updateTutorSourceSummary() {
  const title = document.getElementById("tutorSourceTitle");
  const copy = document.getElementById("tutorSourceCopy");
  const summary = document.getElementById("tutorSourceSummary");
  const mode = tutorSourceMode();
  if (title) title.textContent = mode === "file" ? "Read your study file" : "Read from the active tab";
  if (copy) copy.textContent = mode === "file"
    ? "Uses the same file as your Study Mission — pick it once, use it in both."
    : "Great for articles, stories, and reading passages.";
  if (!summary) return;
  if (mode === "file") {
    summary.innerHTML = selectedPdfFile
      ? `<i class="tutor-src-icon">▤</i><div><b>${escapeHtml(selectedPdfFile.name)}</b><small>${currentStudyPack ? "Study mission built — reused here, no extra tokens." : "Ready to read aloud or explain."}</small></div>`
      : `<i class="tutor-src-icon">▤</i><div><b>No file chosen yet</b><small>Choose a file to read, or switch to Active tab.</small></div><button class="tutor-choose-file" id="tutorChooseFile" type="button">Choose file</button>`;
    return;
  }
  summary.innerHTML = `<i class="tutor-src-icon">◷</i><div><b>Reading the active tab…</b><small>Checking the page you have open.</small></div>`;
  try {
    const context = await getActiveTabContext();
    if (!context.usable) {
      summary.innerHTML = `<i class="tutor-src-icon">!</i><div><b>Can't read this tab</b><small>${escapeHtml(activeTabIssueMessage(context.reason))}</small></div>`;
      return;
    }
    const snippet = (context.text || "").slice(0, 150).trim();
    summary.innerHTML = `<i class="tutor-src-icon">▤</i><div><b>${escapeHtml(context.title || "Active tab")}</b><small>${escapeHtml(snippet ? snippet + "…" : "KiddieGPT will read the page text.")}</small></div>`;
  } catch {
    summary.innerHTML = `<i class="tutor-src-icon">▤</i><div><b>Active tab</b><small>KiddieGPT will read the page text when you generate.</small></div>`;
  }
}

function setTutorMode(mode) {
  tutorMode = mode === "explain" ? "explain" : "read";
  document.querySelectorAll("[data-tutor-mode]").forEach(card => {
    card.classList.toggle("active", card.dataset.tutorMode === tutorMode);
  });
  const button = document.getElementById("tutorGenerateButton");
  if (button && !button.disabled) button.textContent = tutorMode === "read" ? "Read it aloud" : "Explain it aloud";
  saveSettings({ tutorMode });
}

function studyFileKey(file) {
  return file ? `file:${file.name}:${file.size}` : "";
}

// Read a file's text once, cache it, and reuse it for Tutor + Mission (no double read).
async function getSharedFileText(file, settings) {
  const key = studyFileKey(file);
  if (currentSourceKey === key && currentSourceText) {
    return { label: currentSourceLabel || file.name, text: currentSourceText };
  }
  const fileData = await readFileAsDataUrl(file);
  const part = getOpenAIStudySourcePart(file, fileData);
  const result = await callOpenAIJson({
    settings,
    parts: [part],
    instructions: "You are KiddieGPT. Read the study source and return its readable text so a student can hear it. Return only valid JSON.",
    text: `Return JSON with a title string and a text string. text is the main readable passage or notes in the original words, cleaned of page numbers and clutter, up to about 1500 words. Filename: ${file.name}`
  });
  currentSourceKey = key;
  currentSourceLabel = result.title || file.name;
  currentSourceText = result.text || "";
  return { label: currentSourceLabel, text: currentSourceText };
}

async function getTutorReadAloudText() {
  if (tutorSourceMode() === "file") {
    if (!selectedPdfFile) return { label: "Local file", text: "" };
    const settings = await getOpenAISettings();
    if (!settings) return { label: "Local file", text: "" };
    const source = await getSharedFileText(selectedPdfFile, settings);
    return { label: source.label, text: (source.text || "").slice(0, maxTutorReadChars) };
  }
  const context = await getActiveTabContext();
  if (!context.usable) return { label: context.title || "Active tab", text: "", issue: context.reason };
  currentSourceKey = `tab:${context.url}`;
  currentSourceLabel = context.title || "Active tab";
  currentSourceText = context.text || "";
  return { label: currentSourceLabel, text: (context.text || "").slice(0, maxTutorReadChars) };
}

async function getTutorExplainSource() {
  if (tutorSourceMode() === "file") {
    if (currentStudyPack) return { label: "Study mission", text: getCurrentStudyPackText() };
    if (!selectedPdfFile) return { label: "Local file", text: "" };
    const settings = await getOpenAISettings();
    if (!settings) return { label: "Local file", text: "" };
    const source = await getSharedFileText(selectedPdfFile, settings);
    return { label: source.label, text: (source.text || "").slice(0, maxTutorExplainSourceChars) };
  }
  const context = await getActiveTabContext();
  if (!context.usable) return { label: context.title || "Active tab", text: "", issue: context.reason };
  return { label: context.title || "Active tab", text: `Title: ${context.title}\nText: ${(context.text || "").slice(0, maxTutorExplainSourceChars)}` };
}

function showTutorPlayer(show) {
  const player = document.getElementById("tutorPlayerPanel");
  const intro = document.getElementById("tutorIntro");
  if (player) player.hidden = !show;
  if (intro) intro.hidden = show;
}

function formatTutorTime(seconds) {
  const value = Number.isFinite(seconds) ? seconds : 0;
  const minutes = Math.floor(value / 60);
  const secs = Math.floor(value % 60);
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function updateTutorPlayButton(playing) {
  const button = document.getElementById("tutorPlayButton");
  if (!button) return;
  button.textContent = playing ? "❚❚" : "▶";
  button.setAttribute("aria-label", playing ? "Pause" : "Play");
}

function updateTutorTime() {
  const audio = document.getElementById("tutorAudioPlayer");
  const time = document.getElementById("tutorTime");
  const fill = document.getElementById("tutorProgressFill");
  if (!audio) return;
  if (time) time.textContent = `${formatTutorTime(audio.currentTime)} / ${formatTutorTime(audio.duration)}`;
  if (fill) fill.style.width = `${audio.duration ? (audio.currentTime / audio.duration) * 100 : 0}%`;
}

function renderTutorTranscript() {
  const el = document.getElementById("tutorTranscript");
  if (!el) return;
  el.innerHTML = tutorSentences
    .map((sentence, index) => `<span class="tutor-sentence${index === tutorCurrentSentence ? " reading" : ""}" data-sentence="${index}">${escapeHtml(sentence)} </span>`)
    .join("");
}

function updateTutorHighlight() {
  const audio = document.getElementById("tutorAudioPlayer");
  if (!audio || !audio.duration || !tutorSentenceBounds.length) return;
  const progress = audio.currentTime / audio.duration;
  let index = tutorSentenceBounds.findIndex(bound => progress >= bound.start && progress < bound.end);
  if (index === -1) index = progress >= 1 ? tutorSentenceBounds.length - 1 : 0;
  if (index === tutorCurrentSentence) return;
  tutorCurrentSentence = index;
  const el = document.getElementById("tutorTranscript");
  if (!el) return;
  el.querySelectorAll(".tutor-sentence").forEach((span, i) => span.classList.toggle("reading", i === index));
  el.querySelector(`.tutor-sentence[data-sentence="${index}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function setupTutorPlayback(transcript, title) {
  tutorSentences = splitTutorSentences(transcript);
  const totalChars = tutorSentences.reduce((sum, sentence) => sum + sentence.length, 0) || 1;
  let cumulative = 0;
  tutorSentenceBounds = tutorSentences.map(sentence => {
    const start = cumulative / totalChars;
    cumulative += sentence.length;
    return { start, end: cumulative / totalChars };
  });
  tutorCurrentSentence = -1;
  const audio = document.getElementById("tutorAudioPlayer");
  if (audio) {
    audio.src = tutorAudioUrl;
    audio.playbackRate = tutorPlaybackRate;
    audio.load();
  }
  const download = document.getElementById("tutorDownloadLink");
  if (download) {
    const safe = (title || "tutor-lesson").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "tutor-lesson";
    download.href = tutorAudioUrl;
    download.download = `kiddiegpt-${safe}.mp3`;
  }
  const chapter = document.getElementById("tutorChapter");
  if (chapter) chapter.textContent = title || "";
  renderTutorTranscript();
  showTutorPlayer(true);
  updateTutorPlayButton(false);
  updateTutorTime();
}

function chunkForTts(text, maxChars = ttsChunkChars) {
  const sentences = splitTutorSentences(text);
  const chunks = [];
  let current = "";
  sentences.forEach(sentence => {
    let piece = sentence;
    // A single sentence longer than the limit gets hard-split.
    while (piece.length > maxChars) {
      if (current) { chunks.push(current.trim()); current = ""; }
      chunks.push(piece.slice(0, maxChars));
      piece = piece.slice(maxChars);
    }
    if ((current + " " + piece).trim().length > maxChars && current) {
      chunks.push(current.trim());
      current = piece;
    } else {
      current = current ? `${current} ${piece}` : piece;
    }
  });
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text.slice(0, maxChars)];
}

// Long transcripts exceed OpenAI's ~4096-char TTS limit, so synthesize in chunks
// and stitch the MP3 blobs into one track (one audio element = one read-along).
async function synthesizeTutorSpeech({ settings, text, voice, gradeBand, onProgress }) {
  const chunks = chunkForTts(text);
  const blobs = [];
  for (let i = 0; i < chunks.length; i += 1) {
    onProgress?.(i + 1, chunks.length);
    blobs.push(await callOpenAISpeech({ settings, text: chunks[i], voice, gradeBand }));
  }
  return new Blob(blobs, { type: "audio/mpeg" });
}

async function generateTutorVoice() {
  const button = document.getElementById("tutorGenerateButton");
  const setBusy = (busy, label) => {
    if (!button) return;
    button.disabled = busy;
    button.textContent = label;
  };
  setBusy(true, tutorMode === "read" ? "Getting text…" : "Writing lesson…");
  setTutorStatus(tutorMode === "read" ? "Getting the passage ready…" : "Writing the lesson…", "blue");
  try {
    const settings = await getOpenAISettings();
    if (!settings) {
      setTutorStatus("Add your OpenAI key in Settings to generate the tutor voice.", "warn");
      return;
    }
    const gradeBand = settings.gradeBand || "6-8";
    let transcript = "";
    let title = "";
    if (tutorMode === "read") {
      const source = await getTutorReadAloudText();
      transcript = (source.text || "").slice(0, maxTutorReadChars);
      title = source.label;
      if (!transcript || transcript.trim().length < 4) {
        setTutorStatus(tutorSourceMode() === "file"
          ? "Choose a file to read, or switch to Active tab."
          : activeTabIssueMessage(source.issue || "empty"), "warn");
        return;
      }
    } else {
      const source = await getTutorExplainSource();
      if (tutorSourceMode() === "browser" && (!source.text || source.text.trim().length < 4)) {
        setTutorStatus(activeTabIssueMessage(source.issue || "empty"), "warn");
        return;
      }
      const words = gradeBand === "K-2" ? "80-200" : gradeBand === "3-5" ? "200-600" : "600-1800";
      const result = await callOpenAIJson({
        settings,
        instructions: `You are KiddieGPT Tutor Mode for a grade ${gradeBand} student. Create a spoken lesson about the source. Sound like a calm, warm teacher, not a textbook. Do not read the source word for word; teach it in your own simple words, section by section. Return only valid JSON.`,
        text: `Source: ${source.label}\n${source.text}\nReturn JSON with title string and script string. The script should be about ${words} words, walk through the whole source in grade ${gradeBand} language, add a memory trick or two, and end with one recall question. Only make it long if the source has enough to cover; do not pad or repeat.`
      });
      transcript = (result.script || "").slice(0, maxTutorExplainChars);
      title = result.title || source.label;
      if (!transcript) {
        setTutorStatus("Couldn't write a lesson from that source. Try another page.", "warn");
        return;
      }
    }
    setBusy(true, "Making audio…");
    const blob = await synthesizeTutorSpeech({
      settings,
      text: transcript,
      voice: resolveVoice(settings.studentVoice),
      gradeBand,
      onProgress: (index, total) => setTutorStatus(total > 1 ? `Making audio… (part ${index} of ${total})` : "Generating the tutor voice…", "blue")
    });
    if (tutorAudioUrl) URL.revokeObjectURL(tutorAudioUrl);
    tutorAudioUrl = URL.createObjectURL(blob);
    setupTutorPlayback(transcript, title);
    bumpActivity("tutorLessons", 1);
    awardStars(3);
    setTutorStatus(tutorMode === "read" ? "Press play and follow along." : "Press play to hear the lesson.", "blue");
  } catch (error) {
    console.warn("Tutor voice failed", error);
    setTutorStatus(`Could not generate: ${friendlyError(error)}`, "warn");
  } finally {
    setBusy(false, tutorMode === "read" ? "Read it aloud" : "Explain it aloud");
  }
}

function activeTabIssueMessage(reason) {
  if (reason === "pdf") return "This tab is a PDF. Download it, then add it as a Local file so KiddieGPT can read it properly.";
  if (reason === "empty") return "KiddieGPT couldn't find readable text on this tab. Open a page with an article or story, or add a Local file.";
  return "KiddieGPT can't read this tab. Open a normal web page, or add a Local file.";
}

function getActiveTabContext() {
  return new Promise(resolve => {
    const sidePanelText = (document.body?.innerText || "").slice(0, 8000);
    if (!extensionApi?.tabs?.query || !extensionApi?.scripting?.executeScript) {
      // Dev/preview (no extension APIs): use the panel's own text as a stand-in.
      resolve({ title: document.title || "Active tab", url: location.href, text: sidePanelText, usable: sidePanelText.trim().length >= 40, reason: sidePanelText.trim().length >= 40 ? "" : "empty" });
      return;
    }
    extensionApi.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs?.[0];
      const url = tab?.url || "";
      if (!tab?.id || !url || /^chrome:|^edge:|^about:/i.test(url)) {
        resolve({ title: tab?.title || "Active tab", url, text: "", usable: false, reason: "restricted" });
        return;
      }
      if (/\.pdf($|[?#])/i.test(url) || /^file:/i.test(url)) {
        // Browser-rendered PDF or a local file page: the DOM has no readable text.
        resolve({ title: tab.title || "PDF", url, text: "", usable: false, reason: /\.pdf($|[?#])/i.test(url) ? "pdf" : "restricted" });
        return;
      }
      extensionApi.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const isPdf = document.contentType === "application/pdf"
            || !!document.querySelector('embed[type="application/pdf"], embed[type="application/x-google-chrome-pdf"]');
          // Prefer the main article region so we skip nav menus, sidebars, and footers.
          const main = document.querySelector(
            "#mw-content-text .mw-parser-output, #mw-content-text, main, article, [role='main'], #bodyContent, #content, #main, .article-body, .post-content, .entry-content"
          ) || document.body;
          const selection = String(getSelection?.() || "").trim();
          const text = (main.innerText || document.body?.innerText || "")
            .replace(/\[\d+\]/g, "")
            .replace(/\[edit\]/gi, "")
            .replace(/[ \t]+/g, " ")
            .replace(/\n{2,}/g, "\n")
            .trim();
          return { title: document.title, url: location.href, selection, text: text.slice(0, 40000), isPdf };
        }
      }, results => {
        if (extensionApi.runtime.lastError || !results?.[0]?.result) {
          resolve({ title: tab.title || "Active tab", url, text: "", usable: false, reason: "restricted" });
          return;
        }
        const result = results[0].result;
        const best = (result.selection || result.text || "").slice(0, maxTabChars);
        const usable = !result.isPdf && best.trim().length >= 40;
        resolve({
          title: result.title || tab.title || "Active tab",
          url: result.url || url,
          text: best,
          usable,
          reason: result.isPdf ? "pdf" : (usable ? "" : "empty")
        });
      });
    });
  });
}

function setPdfStatus(message, tone = "") {
  const status = document.getElementById("pdfBuildStatus");
  if (!status) return;
  status.textContent = message;
  status.hidden = !message;
  status.className = `pdf-status ${tone}`.trim();
}

function setToolUploadStatus(tool, message, tone = "") {
  const status = document.getElementById(`${tool}UploadStatus`);
  if (status) {
    status.textContent = message;
    status.className = `pdf-status ${tone}`.trim();
    return;
  }
  setPdfStatus(message, tone);
}

function setPdfBusy(isBusy) {
  const button = document.getElementById("pdfBuildButton");
  const progress = document.getElementById("pdfProgress");
  if (button) {
    button.disabled = isBusy;
    button.textContent = isBusy ? "Generating..." : "Generate Study Aids";
  }
  if (progress) {
    progress.hidden = !isBusy;
  }
}

function getMissionChallenge() {
  const value = Number(document.getElementById("missionChallengeSlider")?.value || 2);
  const labels = { 1: "Less", 2: "Balanced", 3: "More" };
  return labels[value] || "Balanced";
}

function updateMissionChallengeLabel() {
  const label = document.getElementById("missionChallengeLabel");
  if (label) label.textContent = getMissionChallenge();
}

function setUploadCollapsed(collapsed) {
  const panel = document.getElementById("pdfUploadPanel");
  const button = document.getElementById("uploadCollapseButton");
  if (!panel || !button) return;
  panel.classList.toggle("collapsed", collapsed);
  button.setAttribute("aria-expanded", String(!collapsed));
  button.setAttribute("aria-label", collapsed ? "Show upload area" : "Hide upload area");
}

function updatePdfSourceMode() {
  const panel = document.getElementById("pdfUploadPanel");
  const fileBody = document.getElementById("pdfFileSourceBody");
  const browserBody = document.getElementById("pdfBrowserSourceBody");
  const title = document.getElementById("pdfBuilderTitle");
  const copy = document.getElementById("pdfBuilderCopy");
  if (!panel || !fileBody || !title || !copy) return;
  const isFileMode = sourceState.pdf === "file";
  fileBody.hidden = !isFileMode;
  if (browserBody) browserBody.hidden = true;
  if (isFileMode) {
    title.textContent = "Build from a local file";
    copy.textContent = "Drop in a worksheet, notes page, or image and KiddieGPT turns it into one focused study pack.";
  } else {
    title.textContent = "Build from the active tab";
    copy.textContent = "Use the lesson page you are viewing now, then generate the same quiz, cards, and read-aloud aids.";
    setUploadCollapsed(false);
  }
}

function choosePdfFile() {
  setUploadCollapsed(false);
  document.getElementById("pdfFileInput")?.click();
}

function handlePdfFileChange(event) {
  const file = event.target.files?.[0];
  handleStudyFile(file, "pdf");
}

async function handleStudyFile(file, tool = "pdf") {
  if (!file) return;
  const isAcceptedType = acceptedStudyTypes.includes(file.type) || /\.(pdf|txt|jpe?g|png)$/i.test(file.name);
  if (!isAcceptedType) {
    setToolUploadStatus(tool, "Use a PDF, TXT, JPG, or PNG file.", "warn");
    return;
  }
  if (file.size > maxStudyFileBytes) {
    setToolUploadStatus(tool, "File is too large. Please use a file under 5 MB.", "warn");
    return;
  }
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
    const { pages, scanned } = await inspectPdf(file);
    const cap = scanned ? maxScannedPdfPages : maxStudyPdfPages;
    if (pages > cap) {
      selectedPdfFile = null;
      setToolUploadStatus(tool, scanned
        ? `This looks like a scanned PDF with ${pages} pages. Scanned pages are slower and cost more to read, so please use up to ${maxScannedPdfPages} pages at a time.`
        : `That PDF has ${pages} pages. Please use up to ${maxStudyPdfPages} pages (one chapter or section) at a time.`, "warn");
      return;
    }
  }
  selectedPdfFile = file;
  // New file: drop the shared cached text and the old built pack so nothing stale is reused.
  currentSourceText = "";
  currentSourceLabel = "";
  currentSourceKey = "";
  currentStudyPack = null;
  document.getElementById(`${tool}UploadZone`)?.classList.remove("dragging");
  const fileName = document.getElementById(`${tool}FileName`);
  const fileMeta = document.getElementById(`${tool}FileMeta`);
  if (fileName) fileName.textContent = file.name;
  if (fileMeta) fileMeta.textContent = `${formatBytes(file.size)} selected · ${fileKindLabel(file)} · ready`;
  setToolUploadStatus(tool, `${fileKindLabel(file)} selected. Ready to generate.`, "blue");
  if (tool === "pdf") {
    hideMissionFollowup();
    setPdfStatus(`${fileKindLabel(file)} selected. Press Generate Study Aids when ready.`, "blue");
  }
  updateTutorSourceSummary();
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function fileKindLabel(file) {
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) return "PDF";
  if (file.type === "text/plain" || /\.txt$/i.test(file.name)) return "Text file";
  return "Image file";
}

function isImageFile(file) {
  return file.type.startsWith("image/") || /\.(jpe?g|png)$/i.test(file.name);
}

function getOpenAIStudySourcePart(file, fileData) {
  if (isImageFile(file)) {
    return {
      type: "input_image",
      image_url: fileData
    };
  }
  return {
    type: "input_file",
    filename: file.name,
    file_data: fileData
  };
}

function initUploadDropZone(tool = "pdf") {
  const zone = document.getElementById(`${tool}UploadZone`);
  if (!zone) return;
  ["dragenter", "dragover"].forEach(type => {
    zone.addEventListener(type, event => {
      event.preventDefault();
      zone.classList.add("dragging");
    });
  });
  ["dragleave", "drop"].forEach(type => {
    zone.addEventListener(type, event => {
      event.preventDefault();
      zone.classList.remove("dragging");
    });
  });
  zone.addEventListener("drop", event => {
    handleStudyFile(event.dataTransfer?.files?.[0], tool);
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Could not read PDF."));
    reader.readAsDataURL(file);
  });
}

let missionProgressTimer = 0;
const missionProgressMessages = [
  "Reading your source…",
  "Finding the big ideas…",
  "Writing the key terms and summary…",
  "Building flashcards and a quiz…",
  "Almost ready…"
];

function startMissionProgress() {
  const label = document.querySelector("#pdfProgress b");
  let index = 0;
  if (label) label.textContent = missionProgressMessages[0];
  clearInterval(missionProgressTimer);
  missionProgressTimer = setInterval(() => {
    index = (index + 1) % missionProgressMessages.length;
    if (label) label.textContent = missionProgressMessages[index];
  }, 2600);
}

function stopMissionProgress() {
  clearInterval(missionProgressTimer);
  missionProgressTimer = 0;
}

async function buildPdfStudyPack() {
  const settings = await getOpenAISettings();
  if (!settings) {
    setPdfStatus(portalToken
      ? "This account needs an active KiddieGPT plan to build a study mission."
      : "Sign in to your parent account to build a study mission.", "warn");
    if (!portalToken) renderPortalGate("login", "");
    return;
  }
  const useFileSource = sourceState.pdf === "file";
  if (useFileSource && !selectedPdfFile) {
    setPdfStatus("Choose a file first, or switch to Active tab.", "warn");
    return;
  }
  let activeContext = null;
  if (!useFileSource) {
    activeContext = await getActiveTabContext();
    if (!activeContext.usable) {
      setPdfStatus(activeTabIssueMessage(activeContext.reason), "warn");
      return;
    }
  }
  const challenge = getMissionChallenge();
  const gradeBand = settings.gradeBand || "6-8";
  setPdfBusy(true);
  startMissionProgress();
  try {
    const pack = useFileSource
      ? await buildPdfWithOpenAI(selectedPdfFile, settings, challenge, gradeBand)
      : await buildStudyPackFromActiveTab(settings, challenge, gradeBand, activeContext);
    currentStudyPack = pack;
    missionQuizSets = [pack.quiz];
    missionCardSets = [pack.flashcards];
    missionQuizState.answers = {};
    missionQuizState.submitted = false;
    missionQuizState.setNumber = 1;
    missionCardsState.index = 0;
    missionCardsState.flipped = false;
    missionCardsState.helpOpen = false;
    missionCardsState.helpText = "";
    missionCardsState.setNumber = 1;
    resetMissionReading();
    renderPdfStudyPack(pack);
    renderMissionCards();
    renderMissionQuiz();
    setUploadCollapsed(true);
    logLesson(pack.mainIdea ? pack.mainIdea.slice(0, 60) : (useFileSource ? selectedPdfFile?.name : "Active tab"));
    setPdfStatus("Study mission ready. Read it first, then practice.", "blue");
  } catch (error) {
    setPdfStatus(`Could not build study mission: ${friendlyError(error)}`, "warn");
  } finally {
    stopMissionProgress();
    setPdfBusy(false);
  }
}

function initPdfTool() {
  document.getElementById("pdfChooseButton")?.addEventListener("click", choosePdfFile);
  document.getElementById("pdfBuildButton")?.addEventListener("click", buildPdfStudyPack);
  document.getElementById("missionChallengeSlider")?.addEventListener("input", updateMissionChallengeLabel);
  document.getElementById("missionReadToggleButton")?.addEventListener("click", () => {
    setMissionReadTimer(!missionReadTimerId);
  });
  document.getElementById("missionReadDoneButton")?.addEventListener("click", markMissionReadDone);
  document.getElementById("uploadCollapseButton")?.addEventListener("click", () => {
    const panel = document.getElementById("pdfUploadPanel");
    setUploadCollapsed(!panel?.classList.contains("collapsed"));
  });
  document.getElementById("pdfFileInput")?.addEventListener("change", handlePdfFileChange);
  initUploadDropZone("pdf");
  updateMissionChallengeLabel();
  updatePdfSourceMode();
  updateMissionReadUi();
}

function initCardsTool() {
  document.getElementById("missionCardsModeToggle")?.addEventListener("click", event => {
    const target = event.target.closest("button[data-card-mode]");
    if (!target) return;
    missionCardsState.promptMode = target.dataset.cardMode;
    missionCardsState.flipped = false;
    missionCardsState.helpOpen = false;
    missionCardsState.helpText = "";
    renderMissionCards();
  });
  document.getElementById("missionFlashcardPreview")?.addEventListener("click", event => {
    const target = event.target.closest("button");
    if (!target) return;
    const cardsSet = target.closest("[data-cards-set]");
    if (cardsSet) {
      goToCardSet(Number(cardsSet.dataset.cardsSet));
      return;
    }
    if (target.id === "missionCardPrev") missionCardsState.index -= 1;
    if (target.id === "missionCardNext") { missionCardsState.index += 1; reportUsage({ tool: "flashcard" }); }
    if (target.id === "missionCardPrev" || target.id === "missionCardNext") {
      missionCardsState.flipped = false;
      missionCardsState.helpOpen = false;
      missionCardsState.helpText = "";
    }
    if (target.dataset.cardFlip === "true") {
      missionCardsState.flipped = !missionCardsState.flipped;
      if (missionCardsState.flipped) logCardsReviewed(1);
    }
    if (target.dataset.cardMode) {
      missionCardsState.promptMode = target.dataset.cardMode;
      missionCardsState.flipped = false;
      missionCardsState.helpOpen = false;
      missionCardsState.helpText = "";
    }
    if (target.id === "missionCardExplainButton") {
      explainMissionCard();
      return;
    }
    if (target.id === "missionGenerateCardsButton") {
      generateMoreMissionFlashcards();
      return;
    }
    renderMissionCards();
  });
  document.getElementById("missionQuizList")?.addEventListener("change", event => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.type !== "radio" || missionQuizState.submitted) return;
    const index = Number(target.dataset.missionQuizIndex);
    if (Number.isNaN(index)) return;
    const firstAnswer = missionQuizState.answers[index] === undefined;
    missionQuizState.answers[index] = target.value;
    if (firstAnswer) reportUsage({ tool: "quiz" }); // count each question once
    renderMissionQuiz();
  });
  document.getElementById("missionQuizSubmitButton")?.addEventListener("click", () => {
    if (missionQuizState.submitted) return;
    missionQuizState.submitted = true;
    const questions = getMissionQuizQuestions();
    const score = questions.filter((item, index) => missionQuizState.answers[index] === item.answer).length;
    const missed = [];
    questions.forEach((item, index) => {
      if (missionQuizState.answers[index] !== item.answer) {
        missed.push({ q: item.question, answer: item.answer, chosen: missionQuizState.answers[index] || "(blank)" });
      }
    });
    logQuizAttempt(currentStudyPack?.mainIdea ? currentStudyPack.mainIdea.slice(0, 50) : "Quiz", score, questions.length, missed);
    renderMissionQuiz();
  });
  document.getElementById("missionQuizFeedback")?.addEventListener("click", event => {
    const target = event.target.closest("button");
    if (!target) return;
    const quizSet = target.closest("[data-quiz-set]");
    if (quizSet) {
      goToQuizSet(Number(quizSet.dataset.quizSet));
      return;
    }
    if (target.id === "missionQuizRetakeButton") {
      missionQuizState.answers = {};
      missionQuizState.submitted = false;
      renderMissionQuiz();
    }
    if (target.id === "missionQuizNewSetButton") {
      generateMoreMissionQuiz();
    }
  });
  renderMissionCards();
  renderMissionQuiz();
}

function renderRightTriangleSvg(fig) {
  const top = [66, 34];
  const corner = [66, 168];
  const right = [214, 168];
  const isUnknown = role => fig.unknown === role;
  const edge = (a, b, role) => `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${isUnknown(role) ? "#2f8f2e" : "#0b2d43"}" stroke-width="${isUnknown(role) ? 5 : 2.5}" stroke-linecap="round"/>`;
  const label = (x, y, text, role) => text ? `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" font-size="16" font-weight="800" fill="${isUnknown(role) ? "#2f6f22" : "#0b2d43"}" font-family="Inter,Arial,sans-serif">${escapeHtml(text)}</text>` : "";
  return `<svg viewBox="0 0 260 210" role="img" aria-label="Right triangle diagram">
    ${edge(top, corner, "legVertical")}
    ${edge(top, right, "hypotenuse")}
    ${edge(corner, right, "legBase")}
    <path d="M ${corner[0]} ${corner[1] - 17} L ${corner[0] + 17} ${corner[1] - 17} L ${corner[0] + 17} ${corner[1]}" fill="none" stroke="#0b2d43" stroke-width="2"/>
    ${label(45, 101, fig.legVertical, "legVertical")}
    ${label(152, 86, fig.hypotenuse, "hypotenuse")}
    ${label(140, 189, fig.legBase, "legBase")}
    ${label(85, 53, fig.angleTop)}
    ${label(189, 155, fig.angleBase)}
  </svg>`;
}

function renderMathFigure(current) {
  const wrap = document.getElementById("mathFigure");
  if (!wrap) return;
  const fig = current.figure;
  if (fig && fig.type === "rightTriangle") {
    wrap.hidden = false;
    wrap.className = "math-figure drawn";
    wrap.innerHTML = `<span>Picture</span><div class="math-figure-canvas">${renderRightTriangleSvg(fig)}</div>${fig.caption ? `<small>${escapeHtml(fig.caption)}</small>` : ""}`;
    return;
  }
  wrap.hidden = true;
  wrap.innerHTML = "";
}

function renderMathSolution() {
  const problems = mathSolveState.problems;
  if (!problems.length) {
    showMathIntro();
    return;
  }
  hideMathNotice();
  hideMathIntro();
  const current = problems[mathSolveState.index] || problems[0];
  renderMathFigure(current);
  const title = document.getElementById("mathProblemTitle");
  const count = document.getElementById("mathProblemCount");
  const equation = document.getElementById("mathEquationDisplay");
  const meta = document.getElementById("mathProblemMeta");
  const tags = document.getElementById("mathSkillTags");
  const steps = document.getElementById("mathStepList");
  const continueSteps = document.getElementById("mathContinueSteps");
  const warning = document.getElementById("mathWarningText");
  const answerCard = document.getElementById("mathAnswerCard");
  const prev = document.getElementById("mathPrevProblem");
  const next = document.getElementById("mathNextProblem");
  if (title) title.textContent = current.title;
  if (count) count.textContent = `${mathSolveState.index + 1} / ${problems.length}`;
  if (equation) equation.innerHTML = renderMathHtml(current.equation);
  if (meta) meta.textContent = current.meta;
  const pending = current.status === "solving" || current.status === "error";
  const gateOn = mathAnswerGate || portalRequireSteps || Boolean(mathParentPinHash);
  const gated = gateOn && !pending && !mathAnswersRevealed;
  // The answer, verification badge, watch-out, reveal control and feedback are
  // now rendered together in one .math-answer-panel inside the step list.
  if (tags) {
    tags.innerHTML = (current.tags || []).map(tag => `<span>${escapeHtml(tag)}</span>`).join("");
  }
  if (steps) {
    if (current.status === "solving") {
      steps.innerHTML = `<div class="math-pending"><div class="math-thinking-orb" aria-hidden="true"><span></span><span></span><span></span></div><div><b>Solving this problem…</b><small>KiddieGPT is working through it now. It will appear here in a moment.</small></div></div>`;
    } else if (current.status === "error") {
      steps.innerHTML = `<div class="math-pending error"><div><b>Couldn't solve this one.</b><small>Try “Didn't capture it right? Fix it” above, or press Solve & Explain again.</small></div></div>`;
    } else {
      const givens = (current.givens || []).filter(Boolean);
      const lines = Array.isArray(current.lines) && current.lines.length ? current.lines : [];
      const check = current.check;
      const lastLineIndex = lines.reduce((last, line, i) => (line.math ? i : last), -1);
      const derivation = lines.map((line, i) => renderDerivationLine(line, gated && i === lastLineIndex)).join("");
      const pinLocked = Boolean(mathParentPinHash);
      const pinFlowOpen = pinLocked && (mathPinPromptOpen || (pinResetState.where === "reveal" && pinResetState.step !== "idle"));
      // The reveal control now lives in the answer head (in place of the old
      // "Double-checked" badge). The body reveal bar only appears for the parent
      // PIN sub-flow (input / reset), which needs more room than the header.
      const revealBtn = (gated && !pinFlowOpen)
        ? `<button class="ma-reveal-btn" type="button" data-reveal-${pinLocked ? "prompt" : "all"}><i>${pinLocked ? "🔒" : "👁"}</i>Reveal answer</button>`
        : "";
      const answerBody = gated
        ? `<div class="ma-value"><span class="ma-blur">${renderMathHtml(current.answer)}</span></div>${pinFlowOpen ? `<div class="ma-reveal">${renderMathRevealBar()}</div>` : ""}`
        : `<div class="ma-value">${renderMathHtml(current.answer)}</div>`;
      const answerPanel = `
        <div class="math-answer-panel">
          <div class="ma-head"><span class="ma-label">Answer</span>${revealBtn}</div>
          ${answerBody}
          ${current.warning ? `<div class="ma-watch"><i>!</i><span>${escapeHtml(current.warning)}</span></div>` : ""}
          <div class="ma-foot">${(!gated && gateOn) ? `<button class="ma-linkbtn ma-hide" type="button" data-hide-all>Hide answer</button>` : (gated ? `<span class="ma-hint">Work the steps first</span>` : `<span></span>`)}<button class="ma-linkbtn ma-feedback" type="button" data-math-feedback>👎 Not right?</button></div>
        </div>`;
      steps.innerHTML = `
        ${givens.length ? `<div class="wb-known"><span>Given</span><div class="wb-known-chips">${givens.map(given => `<em>${renderMathHtml(given)}</em>`).join("")}</div></div>` : ""}
        ${current.goal ? `<div class="wb-goal"><span>Find</span><p>${renderMathHtml(current.goal)}</p></div>` : ""}
        <div class="tb-solution${mathShowNotes ? "" : " notes-hidden"}">
          <div class="tb-solution-head">
            <span class="tb-solution-label">Solution</span>
            <div class="source-pills tb-mode-toggle" role="group" aria-label="Solution detail">
              <button type="button" data-math-notes="explained" class="${mathShowNotes ? "active" : ""}" aria-pressed="${mathShowNotes}">Explained</button>
              <button type="button" data-math-notes="steps" class="${mathShowNotes ? "" : "active"}" aria-pressed="${!mathShowNotes}">Steps</button>
            </div>
          </div>
          <div class="tb-derivation">${derivation}</div>
          ${!gated && check && (check.math || check.why) ? `<div class="tb-check"><i>✓</i><div>${check.math ? `<div class="tb-check-math">${renderMathHtml(check.math)}</div>` : ""}<small>${escapeHtml(check.why || "The answer fits every given, so it checks out.")}</small></div></div>` : ""}
        </div>
        ${answerPanel}
      `;
    }
  }
  if (continueSteps) continueSteps.hidden = true;
  const verifiedPill = document.getElementById("mathVerifiedPill");
  if (verifiedPill) {
    const clearPillTip = () => {
      verifiedPill.removeAttribute("tabindex");
      verifiedPill.removeAttribute("role");
      verifiedPill.removeAttribute("aria-label");
      delete verifiedPill.dataset.tip;
    };
    if (current.status !== "ready" || !current.checked) {
      verifiedPill.hidden = true;
      clearPillTip();
    } else if (current.disputed) {
      verifiedPill.hidden = false;
      verifiedPill.textContent = "Needs teacher check";
      verifiedPill.className = "status warn math-flag";
      const tip = "Hold on. KiddieGPT solved this twice and got different answers. Ask a teacher or parent to confirm before trusting this one.";
      verifiedPill.dataset.tip = tip;
      verifiedPill.setAttribute("tabindex", "0");
      verifiedPill.setAttribute("role", "button");
      verifiedPill.setAttribute("aria-label", `Needs teacher check. ${tip}`);
    } else {
      verifiedPill.hidden = false;
      verifiedPill.textContent = "Double-checked";
      verifiedPill.className = "status blue";
      clearPillTip();
    }
  }
  if (prev) prev.disabled = mathSolveState.index === 0;
  if (next) next.disabled = mathSolveState.index === problems.length - 1;
}

// True when a string carries real LaTeX (a control word, ^{...}, or a subscript).
// Used to route such strings straight to KaTeX and to keep the plain-text
// cleaner (which is destructive to LaTeX) from mangling them.
function looksLikeLatex(text) {
  return /\\(frac|sqrt|cdot|times|div|int|sum|prod|lim|infty|pi|theta|alpha|beta|gamma|Delta|approx|le|ge|ne|neq|leq|geq|pm|mp|circ|text|left|right|begin|end|vec|bar|hat|overline|angle|cos|sin|tan|log|ln)\b|\^\{|_\{|_[0-9A-Za-z]/.test(String(text));
}

function cleanMathText(value) {
  if (value == null) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  // Preserve real LaTeX: the replacements below collapse \frac, \sqrt, \cdot,
  // etc. back to plain text, which destroys anything KaTeX needs to typeset.
  if (looksLikeLatex(text)) {
    return text.replace(/\\\(|\\\)|\\\[|\\\]/g, "").replace(/\s+/g, " ").trim();
  }
  return text
    .replace(/\\\(|\\\)|\\\[|\\\]/g, "")
    .replace(/\\vec\{([^}]+)\}/g, "$1")
    .replace(/\\overrightarrow\{([^}]+)\}/g, "$1")
    .replace(/\\mathbf\{([^}]+)\}/g, "$1")
    .replace(/\\text\{([^}]+)\}/g, "$1")
    .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, "$1/$2")
    .replace(/\\sqrt\{([^}]+)\}/g, "sqrt($1)")
    .replace(/\\cdot/g, " * ")
    .replace(/\\times/g, " x ")
    .replace(/\\,/g, " ")
    .replace(/\\\\/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function renderMathNotation(html) {
  let out = html
    .replace(/\^\{([^}]*)\}/g, (_match, exp) => `<sup>${exp}</sup>`)
    .replace(/\^\(([^)]*)\)/g, (_match, exp) => `<sup>${exp}</sup>`)
    .replace(/\^(-?\d+|[A-Za-z])/g, (_match, exp) => `<sup>${exp}</sup>`);
  out = out
    .replace(/(?:sqrt|√)\s*\(((?:[^()]|\([^()]*\))*)\)/gi, (_match, inner) => `<span class="math-radical">√<span class="math-radicand">${inner}</span></span>`)
    .replace(/(?:sqrt|√)\s*(\d+)/gi, (_match, inner) => `<span class="math-radical">√<span class="math-radicand">${inner}</span></span>`);
  return out.replace(/\s*\*\s*/g, " · ");
}

// Convert the app's plain math convention (sqrt(...), ^2, *, 3/4, °) to LaTeX
// so KaTeX can typeset it. The solver prompt still emits plain text; this stays
// entirely client-side.
function mathToLatex(text) {
  let out = String(text)
    .replace(/%/g, "\\%")                                  // % starts a LaTeX comment
    .replace(/\$/g, "\\$");
  // innermost-first so nested roots work
  for (let i = 0; i < 6 && /(?:sqrt|√)\s*\(/i.test(out); i += 1) {
    out = out.replace(/(?:sqrt|√)\s*\(([^()]*)\)/gi, "\\sqrt{$1}");
  }
  out = out
    .replace(/(?:sqrt|√)\s*(\d+(?:\.\d+)?)/gi, "\\sqrt{$1}")
    .replace(/\^\(([^)]*)\)/g, "^{$1}")
    .replace(/\^(-?\d+(?:\.\d+)?|[A-Za-z])/g, "^{$1}")
    // fractions: (expr)/(expr), (expr)/n, n/n, var/n → \frac
    .replace(/\(([^()]+)\)\s*\/\s*\(([^()]+)\)/g, "\\frac{$1}{$2}")
    .replace(/\(([^()]+)\)\s*\/\s*(\d+(?:\.\d+)?)/g, "\\frac{$1}{$2}")
    .replace(/(^|[\s=+\-(])(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)(?=$|[\s+\-),.;=])/g, "$1\\frac{$2}{$3}")
    .replace(/(^|[\s=+\-(])([A-Za-z])\s*\/\s*(\d+(?:\.\d+)?)(?=$|[\s+\-),.;=])/g, "$1\\frac{$2}{$3}")
    .replace(/\(\s*(\\frac\{[^{}]*\}\{[^{}]*\})\s*\)/g, "$1")  // drop parens left around a lone fraction
    .replace(/\s*\*\s*/g, " \\cdot ")
    .replace(/(\d)\s+x\s+(\d)/g, "$1 \\times $2")          // "4 x 6" reads as times
    .replace(/°/g, "^{\\circ}")
    .replace(/(\d)\s*π/g, "$1\\pi").replace(/π/g, "\\pi")
    .replace(/\b[pP]i\b/g, "\\pi")            // typed "pi"/"Pi" -> π
    .replace(/θ/g, "\\theta").replace(/Δ/g, "\\Delta")
    .replace(/≈/g, "\\approx").replace(/≤/g, "\\le").replace(/≥/g, "\\ge")
    .replace(/≠/g, "\\ne").replace(/±/g, "\\pm").replace(/÷/g, "\\div").replace(/×/g, "\\times")
    // multi-letter words (Area, base, height, cm) set upright, not as run-on italic vars
    .replace(/(^|[^\\A-Za-z])([A-Za-z][A-Za-z]{2,})(?![A-Za-z}])/g, "$1\\text{$2}")
    // keep the space between a word and what follows ("angle C", "Area of")
    .replace(/(\\text\{[^{}]*\})\s+(?=[A-Za-z0-9(\\])/g, "$1\\ ");
  return out;
}

// When KaTeX can't render (malformed LaTeX or KaTeX unavailable), degrade to
// the plain-text convention the legacy renderer understands — a student must
// never see raw "\frac{...}" source.
function latexToReadable(text) {
  let out = String(text);
  for (let i = 0; i < 6 && /\\frac\{/.test(out); i += 1) {
    out = out.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "($1)/($2)");
  }
  for (let i = 0; i < 6 && /\\sqrt\{/.test(out); i += 1) {
    out = out.replace(/\\sqrt\{([^{}]*)\}/g, "sqrt($1)");
  }
  return out
    .replace(/\\sqrt\b/g, "sqrt")
    .replace(/\\cdot/g, " * ").replace(/\\times/g, " x ").replace(/\\div/g, " / ")
    .replace(/\\pm/g, "±").replace(/\\mp/g, "∓")
    .replace(/\\approx/g, "≈").replace(/\\neq|\\ne\b/g, "≠")
    .replace(/\\leq|\\le\b/g, "≤").replace(/\\geq|\\ge\b/g, "≥")
    .replace(/\\pi/g, "π").replace(/\\theta/g, "θ").replace(/\\alpha/g, "α").replace(/\\beta/g, "β").replace(/\\Delta/g, "Δ")
    .replace(/\\circ/g, "°")
    .replace(/\\text\{([^{}]*)\}/g, "$1")
    .replace(/\\left|\\right/g, "")
    .replace(/\\quad|\\qquad|\\,|\\;|\\!|\\ /g, " ")
    .replace(/\\[a-zA-Z]+/g, "")   // drop any remaining commands
    .replace(/[{}]/g, "")          // drop leftover grouping braces (keeps ^2, _n readable)
    .replace(/\s+/g, " ")
    .trim();
}

function renderLegacyMathHtml(value) {
  return renderMathNotation(formatMathFractions(escapeHtml(cleanMathDisplayText(value))));
}

// htmlAndMathml keeps a visually-hidden MathML layer so screen readers can
// speak the math and it copies cleanly — important for an education product.
const KATEX_OPTS = { throwOnError: true, output: "htmlAndMathml", strict: false, displayMode: false };

function renderMathHtml(value) {
  const raw = String(value == null ? "" : value);
  // Real LaTeX from the solver goes straight to KaTeX; the plain-text cleaner
  // would mangle it. Everything else uses the plain->LaTeX converter.
  if (looksLikeLatex(raw)) {
    const latex = raw.replace(/\\\(|\\\)|\\\[|\\\]/g, "").trim();
    if (typeof katex !== "undefined") {
      try {
        return `<span class="kx">${katex.renderToString(latex, KATEX_OPTS)}</span>`;
      } catch {
        // KaTeX rejected it — fall through to the readable degrade below.
      }
    }
    // KaTeX missing or failed: degrade to readable symbols, never show raw LaTeX.
    return renderLegacyMathHtml(latexToReadable(latex));
  }
  const plain = cleanMathDisplayText(value);
  // Sentences read better in the UI font; KaTeX is for actual math.
  if (!plain || isProseMathLine(plain)) return renderLegacyMathHtml(value);
  if (typeof katex !== "undefined") {
    try {
      return `<span class="kx">${katex.renderToString(mathToLatex(plain), KATEX_OPTS)}</span>`;
    } catch {
      // fall through to the legacy renderer
    }
  }
  return renderLegacyMathHtml(value);
}

// Find the first top-level "=" — not inside {} or () — so LaTeX like
// \frac{a=b}{c} or \begin{cases}...=...\end{cases} isn't split mid-token.
// Also skips relational operators (<=, >=, !=, :=) that carry an "=".
function topLevelEqualsIndex(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === "{" || c === "(" || c === "[") depth += 1;
    else if (c === "}" || c === ")" || c === "]") depth -= 1;
    else if (c === "=" && depth === 0) {
      const prev = text[i - 1];
      const next = text[i + 1];
      if ("<>!:=".includes(prev) || next === "=") continue;
      return i;
    }
  }
  return -1;
}

function renderTextbookMath(mathText, cls = "") {
  const text = String(mathText || "").trim();
  const idx = topLevelEqualsIndex(text);
  if (idx === -1) {
    return `<span class="tb-lhs${cls}"></span><span class="tb-op${cls}"></span><span class="tb-rhs${cls}">${renderMathHtml(text)}</span>`;
  }
  const lhs = text.slice(0, idx).trim();
  const rhs = text.slice(idx + 1).trim();
  return `<span class="tb-lhs${cls}">${lhs ? renderMathHtml(lhs) : ""}</span><span class="tb-op${cls}">=</span><span class="tb-rhs${cls}">${renderMathHtml(rhs)}</span>`;
}

function isProseMathLine(mathText) {
  const text = String(mathText || "").trim();
  if (!text || /^=/.test(text)) return false;
  const words = text.match(/[A-Za-z]{3,}/g) || [];
  if (text.length > 48 || words.length >= 4) return true;
  // A wordy line with no math operators is a sentence ("Multiply 6 by 7."),
  // not an equation — keep it out of the math typesetter.
  const hasOperator = /[=+*/^<>≤≥≠±√−]|sqrt|frac|\d\s*-\s*\d/i.test(text);
  return !hasOperator && words.length >= 1;
}

function renderMathRevealBar() {
  if (mathAnswersRevealed) {
    return `<span class="reveal-state">Answers shown</span><button class="reveal-link" type="button" data-hide-all>Hide again</button>`;
  }
  const locked = Boolean(mathParentPinHash);
  if (locked && pinResetState.where === "reveal" && pinResetState.step !== "idle") {
    return pinResetHtml();
  }
  if (locked && mathPinPromptOpen) {
    return `<div class="reveal-pin"><label class="pin-label" for="mathRevealPin">Parent PIN</label><input class="pin-input" id="mathRevealPin" type="password" inputmode="numeric" maxlength="6" placeholder="PIN" autocomplete="off" /><button class="math-reveal-btn" type="button" data-reveal-unlock>Unlock</button><button class="reveal-link" type="button" data-pin-forgot="reveal">Forgot PIN?</button><small class="pin-msg" id="mathRevealPinMsg" hidden></small></div>`;
  }
  return `<span class="reveal-state">Answers hidden — try the steps first</span><button class="math-reveal-btn" type="button" data-reveal-${locked ? "prompt" : "all"}><i>${locked ? "🔒" : "👁"}</i>${locked ? "Reveal answers (parent PIN)" : "Reveal answers"}</button>`;
}

// ---- Forgot PIN: re-verify the parent via the OTP email flow, then set a
// new PIN. The old PIN stays active until the new one is saved, so the gate
// is never silently off. The PIN itself is never emailed (only a hash exists).
let pinResetState = { step: "idle", where: "", email: "", sentCode: "", msg: "" };

function resetPinResetState() {
  pinResetState = { step: "idle", where: "", email: "", sentCode: "", msg: "" };
}

function pinResetHtml() {
  const msg = pinResetState.msg ? `<small class="pin-msg">${escapeHtml(pinResetState.msg)}</small>` : "";
  if (pinResetState.step === "noemail") {
    return `<div class="pin-reset"><small class="pin-msg">Sign in with the parent email first, then try Forgot PIN again.</small><button class="reveal-link" type="button" data-pin-reset-cancel>Close</button></div>`;
  }
  if (pinResetState.step === "code") {
    return `<div class="pin-reset">
      <span class="pin-label">We emailed a code to <b>${escapeHtml(pinResetState.email)}</b></span>
      <div class="pin-row"><input class="pin-input" id="pinResetCode" type="text" inputmode="numeric" maxlength="6" placeholder="Code" autocomplete="off"><button class="math-reveal-btn" type="button" data-pin-reset-verify>Verify</button></div>
      ${pinResetState.sentCode ? `<small class="pin-testcode">Testing mode — your code is <b>${escapeHtml(pinResetState.sentCode)}</b></small>` : ""}
      ${msg}
      <button class="reveal-link" type="button" data-pin-reset-cancel>Cancel</button>
    </div>`;
  }
  if (pinResetState.step === "newpin") {
    return `<div class="pin-reset">
      <span class="pin-label">Code verified — set a new parent PIN</span>
      <div class="pin-row"><input class="pin-input" id="pinResetNew" type="password" inputmode="numeric" maxlength="6" placeholder="New 4–6 digit PIN" autocomplete="off"><button class="math-reveal-btn" type="button" data-pin-reset-save>Save PIN</button></div>
      ${msg}
      <small class="pin-note">The old PIN keeps answers locked until you save this one.</small>
    </div>`;
  }
  return "";
}

function rerenderPinResetSurfaces() {
  renderParentPinArea();
  renderMathSolution();
}

async function startPinReset(where) {
  const email = (portalSession?.email || "").trim();
  if (!email) {
    pinResetState = { step: "noemail", where, email: "", sentCode: "", msg: "" };
    rerenderPinResetSurfaces();
    return;
  }
  const result = await requestOtp(email);
  // requestOtp drives the sign-in gate's state too; put that back to idle so
  // the gate isn't left mid-flow if it opens later.
  otpState = { step: "email", email: "", sentCode: "" };
  pinResetState = { step: "code", where, email, sentCode: result.testCode || "", msg: "" };
  rerenderPinResetSurfaces();
  document.getElementById("pinResetCode")?.focus();
}

async function verifyPinReset() {
  const code = document.getElementById("pinResetCode")?.value.trim() || "";
  if (!code) return;
  try {
    await verifyOtp(pinResetState.email, code);
    pinResetState.step = "newpin";
    pinResetState.msg = "";
  } catch {
    pinResetState.msg = "That code didn't match. Check the newest email.";
  }
  rerenderPinResetSurfaces();
  document.getElementById(pinResetState.step === "newpin" ? "pinResetNew" : "pinResetCode")?.focus();
}

async function completePinReset() {
  const pin = document.getElementById("pinResetNew")?.value.trim() || "";
  if (!/^\d{4,6}$/.test(pin)) {
    pinResetState.msg = "Use a 4 to 6 digit PIN.";
    rerenderPinResetSurfaces();
    document.getElementById("pinResetNew")?.focus();
    return;
  }
  mathParentPinHash = await hashPin(pin);
  mathAnswerGate = true;
  await saveSettings({ mathParentPin: mathParentPinHash, mathAnswerGate: true });
  mathAnswersRevealed = false;
  mathPinPromptOpen = false;
  resetPinResetState();
  rerenderPinResetSurfaces();
}

async function unlockMathReveal() {
  const input = document.getElementById("mathRevealPin");
  const msg = document.getElementById("mathRevealPinMsg");
  const pin = input?.value.trim() || "";
  if (!pin) return;
  const ok = mathParentPinHash && (await hashPin(pin)) === mathParentPinHash;
  if (ok) {
    mathAnswersRevealed = true;
    mathPinPromptOpen = false;
    renderMathSolution();
  } else if (msg) {
    msg.hidden = false;
    msg.textContent = "That PIN didn't match. Ask a parent to help.";
  }
}

function renderDerivationLine(line, blur = false) {
  const why = line.why ? `<small class="tb-why">${escapeHtml(line.why)}</small>` : "";
  if (!line.math) return why;
  const cls = blur ? " tb-blur" : "";
  if (isProseMathLine(line.math)) return `<div class="tb-prose${cls}">${renderMathHtml(line.math)}</div>${why}`;
  return `${renderTextbookMath(line.math, cls)}${why}`;
}

function makeFractionHtml(top, bottom) {
  return `<span class="math-frac"><span>${top.trim()}</span><span>${bottom.trim()}</span></span>`;
}

function simplifyNumericFraction(top, bottom) {
  const divisor = (a, b) => b ? divisor(b, a % b) : Math.abs(a);
  const common = divisor(top, bottom) || 1;
  return `${top / common}/${bottom / common}`;
}

function simplifyWholeFractionExpression(whole, operator, numerator, denominator) {
  const bottom = Number(denominator);
  const signedTop = operator === "-" ? (Number(whole) * bottom) - Number(numerator) : (Number(whole) * bottom) + Number(numerator);
  return simplifyNumericFraction(signedTop, bottom);
}

function cleanMathDisplayText(value) {
  let text = cleanMathText(value)
    .replace(/\[/g, "(")
    .replace(/\]/g, ")");
  text = text.replace(/\(\s*(\d+)\s*([+-])\s*\(?\s*(\d+)\s*\/\s*(\d+)\s*\)?\s*\)/g, (_match, whole, operator, numerator, denominator) => (
    simplifyWholeFractionExpression(whole, operator, numerator, denominator)
  ));
  text = text.replace(/\(\s*\(([^()]+)\)\s*\/\s*(\d+)\s*\)\s*\/\s*(\d+)/g, (_match, top, first, second) => (
    `(${top})/${Number(first) * Number(second)}`
  ));
  text = text.replace(/\(\s*([^()]+?)\s*\/\s*(\d+)\s*\)\s*\/\s*(\d+)/g, (_match, top, first, second) => (
    `(${top})/${Number(first) * Number(second)}`
  ));
  return text;
}

function formatMathFractions(value) {
  return value
    .replace(/\(\s*\(([^()]+)\)\s*\/\s*(\d+)\s*\)/g, (_match, top, bottom) => makeFractionHtml(top, bottom))
    .replace(/\(\s*(\d+)\s*\/\s*(\d+)\s*\)/g, (_match, top, bottom) => makeFractionHtml(top, bottom))
    .replace(/\(\s*([A-Za-z][A-Za-z0-9]*)\s*\/\s*(\d+)\s*\)/g, (_match, top, bottom) => makeFractionHtml(top, bottom))
    .replace(/\(\s*([^()]+?)\s*\)\s*\/\s*(\d+)(?=$|[\s+\-*/),.;=])/g, (_match, top, bottom) => makeFractionHtml(top, bottom))
    .replace(/(^|[\s=+\-*/(])([A-Za-z][A-Za-z0-9]*)\s*\/\s*(\d+)(?=$|[\s+\-*/),.;=A-Za-z])/g, (_match, prefix, top, bottom) => (
      `${prefix}${makeFractionHtml(top, bottom)}`
    ))
    .replace(/(^|[\s=+\-*/(])(\d+)\s*\/\s*(\d+)(?=$|[\s+\-*/),.;=A-Za-z])/g, (_match, prefix, top, bottom) => (
      `${prefix}${makeFractionHtml(top, bottom)}`
    ));
}

function isMathPromptMetadata(value) {
  const text = cleanMathText(value).toLowerCase();
  return !text
    || text === "math problem"
    || text.includes("solve the math problem")
    || text.includes("provided source")
    || text.includes("visible in this screenshot")
    || text.includes("return json")
    || text.includes("input metadata")
    || text.includes("filename:");
}

function pickMathProblemText(item) {
  const candidates = [item.friendlyProblem, item.question, item.originalProblem, item.prompt, item.problem, item.given, item.equation, item.answer];
  const isDerivedLine = value => {
    const text = cleanMathText(value);
    return (text.match(/=/g) || []).length > 1;
  };
  const picked = candidates.find(candidate => !isMathPromptMetadata(candidate) && !isDerivedLine(candidate))
    || candidates.find(candidate => !isMathPromptMetadata(candidate));
  return cleanMathText(picked || "Math problem");
}

function normalizeFigure(fig) {
  if (!fig || typeof fig !== "object" || fig.type !== "rightTriangle") return null;
  const role = value => ["hypotenuse", "legVertical", "legBase"].includes(value) ? value : "";
  return {
    type: "rightTriangle",
    hypotenuse: cleanMathText(fig.hypotenuse || ""),
    legVertical: cleanMathText(fig.legVertical || fig.vertical || ""),
    legBase: cleanMathText(fig.legBase || fig.base || ""),
    angleTop: cleanMathText(fig.angleTop || ""),
    angleBase: cleanMathText(fig.angleBase || ""),
    unknown: role(fig.unknown),
    caption: cleanMathText(fig.caption || "")
  };
}

function normalizeMathProblems(result) {
  const problems = Array.isArray(result.problems) ? result.problems : [result];
  const normalizeLine = line => {
    if (typeof line === "string") return { math: cleanMathText(line), why: "" };
    return {
      math: cleanMathText(line?.math || line?.work || line?.equation || ""),
      why: cleanMathText(line?.why || line?.reason || line?.simple || line?.explain || line?.text || "")
    };
  };
  return problems.filter(Boolean).slice(0, 15).map((item, index) => {
    const rawLines = Array.isArray(item.lines) && item.lines.length ? item.lines : Array.isArray(item.steps) ? item.steps : [];
    const lines = rawLines.slice(0, 25).map(normalizeLine).filter(line => line.math || line.why);
    const check = item.check ? normalizeLine(item.check) : null;
    return {
      title: cleanMathText(item.title || `Problem ${index + 1} of ${problems.length}`),
      equation: pickMathProblemText(item),
      meta: cleanMathText(item.meta || item.skill || "Math · step-by-step"),
      tags: Array.isArray(item.tags) ? item.tags.slice(0, 4).map(cleanMathText) : ["Steps", "Check", "Learn"],
      givens: Array.isArray(item.givens) ? item.givens.slice(0, 8).map(cleanMathText).filter(Boolean) : [],
      goal: cleanMathText(item.goal || ""),
      lines: lines.length ? lines : [
        { math: "", why: "Read the problem and write down what it gives you." },
        { math: "", why: "Pick the rule that connects the givens to what you need." },
        { math: "", why: "Work one small move at a time, then check your answer." }
      ],
      check: check && (check.math || check.why) ? check : null,
      warning: cleanMathText(item.warning || "Copy the problem carefully before solving."),
      answer: cleanMathText(item.answer || "See final line"),
      figure: normalizeFigure(item.figure),
      disputed: false,
      status: "ready",
      checked: false
    };
  });
}

function setMathUploadState(file, error = "") {
  const zone = document.querySelector("#mathPanel .math-upload-zone");
  if (!zone) return;
  const title = zone.querySelector(".math-upload-copy b");
  const meta = zone.querySelector(".math-upload-copy small");
  const icon = zone.querySelector(".browse-button .drop-icon");
  const browseLabel = zone.querySelector(".browse-label");
  const uploaded = Boolean(file) && !error;
  zone.classList.toggle("uploaded", uploaded);
  zone.classList.toggle("upload-error", Boolean(error));
  if (icon) {
    icon.innerHTML = uploaded
      ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.4 4.5L19 7"></path></svg>`
      : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 18a4 4 0 0 1-.7-7.9A5.5 5.5 0 0 1 17 8.5 4.5 4.5 0 0 1 18 17h-2"></path><path d="M12 12v8"></path><path d="m9 15 3-3 3 3"></path></svg>`;
  }
  if (title) title.textContent = uploaded ? `${file.name}` : "Choose a math file";
  if (meta) meta.textContent = error || (uploaded ? `${formatBytes(file.size)} · ready to solve` : "One page · PDF, JPG, or PNG · up to 5 MB");
  if (browseLabel) browseLabel.textContent = uploaded ? "Change" : "Browse file";
}

async function inspectPdf(file) {
  try {
    const buffer = await file.arrayBuffer();
    const text = new TextDecoder("latin1").decode(buffer);
    const pageMatches = text.match(/\/Type\s*\/Page(?![s])/g);
    const countMatch = text.match(/\/Count\s+(\d+)/);
    const pages = pageMatches && pageMatches.length ? pageMatches.length : (countMatch ? parseInt(countMatch[1], 10) : 1);
    // No font references means there's no selectable text layer — the pages are
    // images the model must read with (expensive) vision. That's a "scanned" PDF.
    const scanned = !/\/Font\b/.test(text) && /\/Subtype\s*\/Image|\/DCTDecode|\/CCITTFaxDecode|\/JBIG2Decode/.test(text);
    return { pages, scanned };
  } catch {
    return { pages: 1, scanned: false };
  }
}

async function countPdfPages(file) {
  return (await inspectPdf(file)).pages;
}

async function handleMathFileChange(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const isAcceptedType = ["application/pdf", "image/jpeg", "image/png"].includes(file.type) || /\.(pdf|jpe?g|png)$/i.test(file.name);
  if (!isAcceptedType) {
    setMathUploadState(null, "Use a PDF, JPG, or PNG file.");
    return;
  }
  if (file.size > maxStudyFileBytes) {
    setMathUploadState(null, "That file is too large. Use one under 5 MB.");
    return;
  }
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (isPdf) {
    const pages = await countPdfPages(file);
    if (pages > 1) {
      selectedMathFile = null;
      setMathUploadState(null, `This PDF has ${pages} pages. Please upload just one page at a time.`);
      return;
    }
  }
  selectedMathFile = file;
  selectedMathCapture = null;
  setMathUploadState(file);
}

function mathGradeGuidance(gradeBand) {
  if (gradeBand === "K-2") return "Use small numbers, counting language, and simple number sentences. No algebra symbols unless the problem itself shows them. If there is a picture, describe what to look at in it before using any number.";
  if (gradeBand === "3-5") return "Use arithmetic reasoning in plain words. Introduce a variable only if the problem itself uses one. If there is a picture, tie each step to it: name the side, angle, or part in the picture before using its number, so the student can follow along on the drawing.";
  if (gradeBand === "9-12") return "Use high-school methods as the problem requires — algebra, functions, trigonometry, and early calculus (limits, derivatives, integrals) are all fair game — but still pick the simplest correct approach and name the rule or theorem in each line. Keep the derivation rigorous and complete.";
  return "Use pre-algebra and algebra as needed, but pick the simplest approach the problem allows and name the rule in each line. Prefer basic geometry and algebra (base times height, Pythagorean theorem, factoring) over trigonometry or calculus unless the problem clearly requires them.";
}

async function solveMathOnce({ settings, parts, sourceText, gradeBand, disputeNote = "", model = MODELS.math }) {
  return callOpenAIJson({
    settings,
    parts,
    model, // routes to Luna by default; pass MODELS.hardMath/premiumDeep for harder/deep mode
    moderate: false, // math equations/steps are inherently safe; skip the extra round-trip
    instructions: "You are KiddieGPT Math Tutor, a careful teacher for K-8 students (support harder topics like algebra, geometry, vectors, and early calculus when the source shows them). Accuracy is critical: a wrong answer is worse than no answer. If the source contains no readable math problem — it is blank, too blurry or low-quality to read, or simply not math (like a photo, a paragraph of text, or a random screenshot) — do NOT invent a problem. Instead return exactly {\"noMath\": true, \"reason\": \"<one short, kind, kid-friendly sentence explaining what you see and what to do>\"} and nothing else. Otherwise: before solving, read EVERY label, number, and angle in the source and list them as givens. If there is a diagram, state exactly where the unknown sits (for example: which angle it is opposite or adjacent to) and never assume. A small square in a diagram is a right-angle mark: those two segments are perpendicular, so one of them is a height or leg — use it, and never treat a marked height as a slanted side or assume an included angle between them. Solve with the SIMPLEST method a student at the given grade would use: do not reach for an advanced technique (law of sines, trig area formula, calculus) when a basic one from the figure works, such as base times height for area or the Pythagorean theorem for a right triangle. Show the work like a whiteboard: short connected lines, each following from the one above. Always end with a check that substitutes the answer back and confirms it agrees with every given; if the check fails, redo the work before answering. Write every math expression as inline LaTeX (for example \\frac{a}{b}, \\sqrt{48}, x^{2}, a_{1}, 90^{\\circ}, \\int, \\sum); do NOT wrap it in $, $$, \\( \\), or \\[ \\] delimiters, and use no markdown. If several problems are visible, split them. Return only valid JSON.",
    text: `${sourceText}
${disputeNote ? `IMPORTANT: ${disputeNote}
` : ""}Student grade band: ${gradeBand}. ${mathGradeGuidance(gradeBand)}
Return JSON with a problems array. Solve at most 15 problems; if the page shows more than 15, include only the first 15. Each problem object must have:
- title: like "Problem 1 of 2".
- friendlyProblem: the original question only, such as "Find the missing side b when the angle is 30 degrees and the hypotenuse is 8". No derivations, filenames, source descriptions, or metadata.
- meta: short topic line. tags: array of up to 4 short skill words.
- givens: array of short strings, one per fact read from the source, including every labeled number and angle, like "hypotenuse = 8", "angle = 30 degrees", "bottom side = 4".
- goal: one line naming the unknown and where it sits, like "b is the vertical leg, opposite the 60 degree angle".
- lines: the worked solution as a textbook derivation, an array of objects with math and why. The math field must be ONLY a short equation or expression (symbols and numbers), never a sentence, rule name, or description, and never more than one relation per line. Put every explanation, property, or rule statement in why, not in math. Write it the way a math textbook does. When useful, state the general formula first (like "a^{2} + b^{2} = c^{2}"), then show each simplification on its own line. When a line simply continues simplifying the same quantity, start that line with "=" and drop the left side, like "= \\sqrt{64 - 16}" then "= \\sqrt{48}" then "= 4\\sqrt{3}". Write the math as inline LaTeX: \\frac{}{} for fractions, \\sqrt{} for roots, ^{} for powers, _{} for subscripts, \\cdot or \\times for multiplication, \\pi \\theta for symbols; no $ or \\( \\) delimiters. Keep at most one relation per line. why is one short plain sentence for this grade band explaining that line. The lines must read top to bottom as one connected derivation.
- check: object with math and why that substitutes the final answer back into the original relationship and confirms it agrees with ALL the givens.
- answer: the final solved VALUE only, as inline LaTeX — never an instruction or a step for the student to finish. For a multiple-choice question, give the value and the matching option letter, like "\\theta = 143^{\\circ} \\text{ (d)}".
- warning: the most common mistake on this exact problem type.
- figure (optional): include ONLY when the source shows a diagram you can represent, and only the type "rightTriangle" is supported. For a right triangle return { type: "rightTriangle", hypotenuse, legVertical, legBase, angleTop, angleBase, unknown }. hypotenuse, legVertical, and legBase are the labels exactly as shown on each side (a number like "8" or a letter like "b"); legVertical is the upright leg, legBase is the bottom leg, hypotenuse is the slanted side across from the right angle. angleTop and angleBase are the two acute angle labels like "30 degrees" (use "" if the diagram does not show them). unknown is which of "hypotenuse", "legVertical", or "legBase" the student is solving for. Read the diagram carefully so each label sits on the correct side. Omit figure entirely if there is no diagram or it is not a right triangle.
Every math field (lines, check, answer) must be inline LaTeX with no $ or \\( \\) delimiters.`
  });
}

async function checkMathOnce({ settings, parts, sourceText, problems, model = MODELS.math }) {
  const candidates = problems.map((problem, index) => `Problem ${index + 1}: ${problem.equation} | Candidate answer: ${problem.answer}`).join("\n");
  const result = await callOpenAIJson({
    settings,
    parts,
    model,
    moderate: false,
    instructions: "You are a strict, independent math checker. Re-solve each problem yourself from the original source before looking at the candidate answer, and when possible solve it a SECOND, different way and require both to agree. Do not trust the candidate. Read every label, number, and angle in any diagram carefully, honor right-angle marks (a small square means those segments are perpendicular, so one is a height or leg), and confirm which side or quantity the unknown actually is. Also judge the method: if the candidate used an advanced technique where a simpler one from the figure applies, or its answer disagrees with the simpler method, mark it as not agreeing. Return only valid JSON.",
    text: `${sourceText}
Candidate solutions to audit:
${candidates}
For each problem, re-solve independently, then compare. Return JSON with a verdicts array, one entry per problem: index (0-based number), agree (boolean, true only if the candidate answer is mathematically equivalent to yours), correctAnswer (your answer as short plain text), reason (one short sentence, for example which diagram label the candidate misread).`
  });
  const verdicts = Array.isArray(result.verdicts) ? result.verdicts : [];
  return verdicts
    .map(verdict => ({
      index: Number(verdict.index),
      agree: Boolean(verdict.agree),
      correctAnswer: cleanMathText(verdict.correctAnswer || ""),
      reason: cleanMathText(verdict.reason || "")
    }))
    .filter(verdict => Number.isInteger(verdict.index) && verdict.index >= 0 && verdict.index < problems.length);
}

const mathTipBank = {
  general: [
    "Careful problem-solvers always check their work — so does KiddieGPT.",
    "Reading every label twice so nothing gets misread.",
    "Writing each step out like a math textbook.",
    "Tip: Guess about how big the answer should be, then check it.",
    "Tip: If the screenshot looks blurry, you can fix the problem afterward."
  ],
  grade: {
    "K-2": [
      "Tip: Count slowly and point to each thing.",
      "Tip: Draw a quick picture to see the problem.",
      "Tip: Ten ones make one ten."
    ],
    "3-5": [
      "Tip: Read the question twice before you start.",
      "Tip: Line up the place values before you add.",
      "Tip: Estimate first, then do the exact math."
    ],
    "6-8": [
      "Tip: Do the same step to both sides to keep an equation balanced.",
      "Tip: Undo operations in the opposite order you built them.",
      "Tip: Substitute your answer back in to test it."
    ]
  },
  topics: [
    { match: /triangle|angle|geometr|pythag|hypotenuse/i, tips: [
      "Tip: In a diagram, check which side is opposite each angle.",
      "Tip: The hypotenuse is always across from the right angle.",
      "Tip: The three angles in a triangle add up to 180 degrees."
    ] },
    { match: /equation|algebra|solve for|variable|linear/i, tips: [
      "Tip: Try to get the letter by itself on one side.",
      "Tip: Whatever you do to one side, do to the other."
    ] },
    { match: /fraction|numerator|denominator/i, tips: [
      "Tip: Find a common denominator before adding fractions.",
      "Tip: Simplify by dividing the top and bottom by the same number."
    ] },
    { match: /deriv|calculus|integral|power rule/i, tips: [
      "Tip: The power rule brings the exponent down by one.",
      "Tip: Take the derivative one term at a time."
    ] },
    { match: /area|perimeter|volume/i, tips: [
      "Tip: Area is the space inside; perimeter is the distance around.",
      "Tip: Keep all your units the same before you calculate."
    ] },
    { match: /percent|ratio|proportion/i, tips: [
      "Tip: Percent means out of 100.",
      "Tip: A ratio compares two amounts."
    ] }
  ]
};
let mathThinkingTimer = 0;
let mathThinkingTipIndex = 0;
let mathActiveTips = mathTipBank.general.slice();

function mathTopicHint(problems) {
  const list = Array.isArray(problems) ? problems : [problems];
  return list.filter(Boolean).map(problem => `${problem.meta || ""} ${(problem.tags || []).join(" ")} ${problem.equation || ""}`).join(" ");
}

function buildMathTips({ gradeBand = "6-8", hint = "" } = {}) {
  const tips = [];
  mathTipBank.topics.forEach(topic => {
    if (hint && topic.match.test(hint)) tips.push(...topic.tips);
  });
  tips.push(...(mathTipBank.grade[gradeBand] || mathTipBank.grade["6-8"]));
  tips.push(...mathTipBank.general);
  return [...new Set(tips)];
}

function updateMathThinkingStage(text) {
  const stage = document.getElementById("mathThinkingStage");
  if (stage && text) stage.textContent = text;
}

function startMathThinking(stageText, options = {}) {
  const panel = document.getElementById("mathThinking");
  const layout = document.querySelector("#mathPanel .math-solution-layout");
  const tip = document.getElementById("mathThinkingTip");
  if (panel) panel.hidden = false;
  if (layout) layout.classList.add("is-thinking");
  updateMathThinkingStage(stageText);
  mathActiveTips = buildMathTips(options);
  mathThinkingTipIndex = 0;
  if (tip) {
    tip.textContent = mathActiveTips[0];
    tip.style.opacity = "1";
  }
  clearInterval(mathThinkingTimer);
  mathThinkingTimer = setInterval(() => {
    const el = document.getElementById("mathThinkingTip");
    if (!el || !mathActiveTips.length) return;
    mathThinkingTipIndex = (mathThinkingTipIndex + 1) % mathActiveTips.length;
    el.style.opacity = "0";
    setTimeout(() => {
      el.textContent = mathActiveTips[mathThinkingTipIndex];
      el.style.opacity = "1";
    }, 260);
  }, 2600);
  panel?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function refreshMathThinkingTips(options) {
  if (!mathThinkingTimer) return;
  const next = buildMathTips(options);
  if (next.join("|") === mathActiveTips.join("|")) return;
  mathActiveTips = next;
  mathThinkingTipIndex = 0;
  const el = document.getElementById("mathThinkingTip");
  if (!el) return;
  el.style.opacity = "0";
  setTimeout(() => {
    el.textContent = mathActiveTips[0];
    el.style.opacity = "1";
  }, 260);
}

function stopMathThinking() {
  clearInterval(mathThinkingTimer);
  mathThinkingTimer = 0;
  const panel = document.getElementById("mathThinking");
  const layout = document.querySelector("#mathPanel .math-solution-layout");
  if (panel) panel.hidden = true;
  if (layout) layout.classList.remove("is-thinking");
}

let mathSolveToken = 0;

function showMathNotice(title, message) {
  const notice = document.getElementById("mathNotice");
  const top = document.querySelector("#mathPanel .math-solution-top");
  const layout = document.querySelector("#mathPanel .math-solution-layout");
  const intro = document.getElementById("mathIntro");
  if (top) top.hidden = true;
  if (layout) layout.hidden = true;
  if (intro) { intro.hidden = true; intro.innerHTML = ""; }
  if (!notice) return;
  notice.hidden = false;
  notice.innerHTML = `
    <div class="math-notice-icon">?</div>
    <h3>${escapeHtml(title)}</h3>
    <p>${escapeHtml(message)}</p>
    <ul class="math-notice-tips">
      <li>Capture or crop just the math problem.</li>
      <li>Make sure the picture is clear and not blurry.</li>
      <li>Check that it is actually a math question.</li>
    </ul>
  `;
}

function hideMathNotice() {
  const notice = document.getElementById("mathNotice");
  const top = document.querySelector("#mathPanel .math-solution-top");
  const layout = document.querySelector("#mathPanel .math-solution-layout");
  if (notice) {
    notice.hidden = true;
    notice.innerHTML = "";
  }
  if (top) top.hidden = false;
  if (layout) layout.hidden = false;
}

function showMathIntro() {
  const intro = document.getElementById("mathIntro");
  const notice = document.getElementById("mathNotice");
  const top = document.querySelector("#mathPanel .math-solution-top");
  const layout = document.querySelector("#mathPanel .math-solution-layout");
  if (notice) { notice.hidden = true; notice.innerHTML = ""; }
  if (top) top.hidden = true;
  if (layout) layout.hidden = true;
  if (!intro) return;
  intro.hidden = false;
  const exampleLines = [
    { math: "angle B = 90°", why: "An angle sitting on the diameter is always a right angle." },
    { math: "35° + 90° + C = 180°", why: "The three angles of a triangle add up to 180°." },
    { math: "C = 55°", why: "180 minus 125 leaves 55." }
  ];
  const exampleHtml = exampleLines.map(line => (
    `${renderTextbookMath(line.math)}<small class="tb-why">${escapeHtml(line.why)}</small>`
  )).join("");
  // Triangle inscribed in a circle (Thales): AC is the diameter, B on the arc.
  const figureSvg = `<svg viewBox="0 0 220 138" role="img" aria-label="Triangle inside a circle, standing on the diameter">
    <circle cx="110" cy="70" r="56" fill="#f4faf3" stroke="#9dbcb0" stroke-width="2"/>
    <line x1="54" y1="70" x2="166" y2="70" stroke="#0b2d43" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="54" y1="70" x2="86" y2="19" stroke="#0b2d43" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="86" y1="19" x2="166" y2="70" stroke="#0b2d43" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M 80.9 27.6 L 89.3 33 L 94.7 24.6" fill="none" stroke="#0b2d43" stroke-width="1.8"/>
    <path d="M 70 70 A 16 16 0 0 1 67.4 61.4" fill="none" stroke="#0b2d43" stroke-width="1.8"/>
    <circle cx="54" cy="70" r="3" fill="#0b2d43"/><circle cx="166" cy="70" r="3" fill="#0b2d43"/><circle cx="86" cy="19" r="3" fill="#0b2d43"/>
    <text x="44" y="84" font-size="13" font-weight="800" fill="#0b2d43" font-family="Inter,Arial,sans-serif">A</text>
    <text x="84" y="12" font-size="13" font-weight="800" fill="#0b2d43" font-family="Inter,Arial,sans-serif">B</text>
    <text x="172" y="84" font-size="13" font-weight="800" fill="#0b2d43" font-family="Inter,Arial,sans-serif">C</text>
    <text x="84" y="62" font-size="12" font-weight="800" fill="#0b2d43" font-family="Inter,Arial,sans-serif">35°</text>
    <text x="143" y="63" font-size="14" font-weight="900" fill="#2f8f2e" font-family="Inter,Arial,sans-serif">?</text>
  </svg>`;
  intro.innerHTML = `
    <div class="math-intro-head">
      <span class="mission-eyebrow">Math Tutor</span>
      <h3>How it works</h3>
      <p>Turn any math problem into a clear, checked, step-by-step lesson.</p>
    </div>
    <div class="mi2-example" aria-hidden="true">
      <div class="mi2-example-head"><span class="mi2-example-tag">What you get</span><span class="mi2-example-check"><i>✓</i>Double-checked</span></div>
      <div class="mi2-fig">${figureSvg}<small>AC is the diameter. Find angle C.</small></div>
      <div class="tb-derivation">${exampleHtml}</div>
      <div class="mi2-example-answer"><span>Answer</span><b>${renderMathHtml("C = 55°")}</b></div>
    </div>
    <ol class="mi2-flow">
      <li>
        <span class="mi2-node">▧</span>
        <div><b>Add a problem</b><small>Type it in, screenshot it, or upload a worksheet.</small></div>
      </li>
      <li>
        <span class="mi2-node">∑</span>
        <div><b>Learn the steps</b><small>A textbook-style solution, one line at a time, each with a why.</small></div>
      </li>
      <li>
        <span class="mi2-node">✓</span>
        <div><b>Solved twice, then compared</b><small>An independent check re-solves it and flags anything unsure.</small></div>
      </li>
      <li>
        <span class="mi2-node">🔒</span>
        <div><b>Answer stays earned</b><small>Steps come first. A parent PIN can lock the final answer.</small></div>
      </li>
    </ol>
    <div class="mi2-cta"><i>↑</i><p>Capture or upload a problem above, then press <b>Solve &amp; Explain</b>.</p></div>
  `;
}

function hideMathIntro() {
  const intro = document.getElementById("mathIntro");
  if (intro) { intro.hidden = true; intro.innerHTML = ""; }
}

function mathSingleSolveNote(statement) {
  return `The source below is one already-transcribed math problem to solve fully${statement ? `: "${statement}"` : ""}. Return a problems array containing exactly this one problem, fully solved with lines and a check.`;
}

function mathTranscriptSource(transcribed) {
  if (!transcribed) return "Solve the math problem.";
  return [
    `Problem: ${transcribed.statement || transcribed.equation || "the math problem"}`,
    transcribed.diagram ? `Diagram: ${transcribed.diagram}` : "",
    transcribed.meta ? `Topic: ${transcribed.meta}` : ""
  ].filter(Boolean).join("\n");
}

function mathPlaceholderFromTranscript(transcribed, index, total) {
  return {
    title: `Problem ${index + 1} of ${total}`,
    equation: cleanMathText(transcribed.statement || transcribed.equation || "Math problem"),
    meta: cleanMathText(transcribed.meta || "Math · up next"),
    tags: Array.isArray(transcribed.tags) ? transcribed.tags.slice(0, 4).map(cleanMathText) : [],
    givens: [], goal: "", lines: [], check: null, warning: "", answer: "",
    figure: normalizeFigure(transcribed.figure), disputed: false, checked: false, status: "solving"
  };
}

// One vision call: read the image/file into text problems + diagram descriptions. No solving.
async function transcribeMathProblems({ settings, parts, gradeBand, model = MODELS.math }) {
  return callOpenAIJson({
    settings,
    parts,
    model,
    moderate: false,
    instructions: "You are KiddieGPT's math reader. Your only job is to read the image or file exactly and write down each math problem as text — do NOT solve anything. Read EVERY number, label, and angle, and copy each number with its EXACT sign: coordinate points like P(-4, 3) or (-4,-3) have negative values — never drop a minus sign, and keep the order and sign of every coordinate. Copy any multiple-choice options verbatim. If there is a diagram, describe it completely: every side length, every angle with its value and vertex, which side or label is the unknown, and where each label sits. If the source has no readable math problem (blank, too blurry, or not math), return {\"noMath\": true, \"reason\": \"<one short kind sentence>\"} and nothing else. Return only valid JSON.",
    text: `Read this source and list every math problem in reading order, up to 15. Grade band: ${gradeBand}. Return JSON with a problems array. Each item must have: statement (the full question in plain words, for example "Find b in a right triangle with hypotenuse 8, one leg 4, and a 30 degree angle"), meta (short topic like "Geometry · right triangle"), tags (array up to 4 short words), diagram (a complete text description of any figure so it can be solved without the image, or "" if there is no figure), and figure (ONLY for a right triangle: { type:"rightTriangle", hypotenuse, legVertical, legBase, angleTop, angleBase, unknown } using the exact labels shown; omit otherwise).`
  });
}

async function verifyMathProblemInPlace({ settings, gradeBand, index, token }) {
  const problem = mathSolveState.problems[index];
  const transcribed = lastMathSolve?.transcript?.[index];
  if (!problem || problem.status !== "ready") return;
  const sourceText = mathTranscriptSource(transcribed || problem);
  try {
    let verdicts = await checkMathOnce({ settings, parts: [], sourceText, problems: [problem] });
    if (token !== mathSolveToken) return;
    let disagree = verdicts.find(verdict => verdict.index === 0 && !verdict.agree);
    if (disagree) {
      const note = `${mathSingleSolveNote(problem.equation)} A checker disagreed with the answer "${problem.answer}". The checker got "${disagree.correctAnswer}". Reason: ${disagree.reason}. Solve THIS problem again from scratch.`;
      const resolved = normalizeMathProblems(await solveMathOnce({ settings, parts: [], sourceText, gradeBand, disputeNote: note }));
      if (token !== mathSolveToken) return;
      if (resolved[0]) {
        resolved[0].status = "ready";
        if (!resolved[0].figure && transcribed?.figure) resolved[0].figure = normalizeFigure(transcribed.figure);
        mathSolveState.problems[index] = resolved[0];
      }
      verdicts = await checkMathOnce({ settings, parts: [], sourceText, problems: [mathSolveState.problems[index]] });
      if (token !== mathSolveToken) return;
      disagree = verdicts.find(verdict => verdict.index === 0 && !verdict.agree);
    }
    const solved = mathSolveState.problems[index];
    solved.checked = true;
    solved.disputed = Boolean(disagree);
  } catch (error) {
    console.warn("Verify problem failed", error);
    if (mathSolveState.problems[index]) mathSolveState.problems[index].checked = true;
  }
  if (token === mathSolveToken) renderMathSolution();
}

async function solveMathProblemInPlace({ settings, gradeBand, index, token }) {
  const placeholder = mathSolveState.problems[index];
  const transcribed = lastMathSolve?.transcript?.[index];
  if (!placeholder) return;
  const sourceText = mathTranscriptSource(transcribed || placeholder);
  try {
    const resolved = normalizeMathProblems(await solveMathOnce({ settings, parts: [], sourceText, gradeBand, disputeNote: mathSingleSolveNote(placeholder.equation) }));
    if (token !== mathSolveToken) return;
    if (resolved[0]) {
      resolved[0].status = "ready";
      if (!resolved[0].figure && transcribed?.figure) resolved[0].figure = normalizeFigure(transcribed.figure);
      mathSolveState.problems[index] = resolved[0];
    } else {
      placeholder.status = "error";
    }
  } catch (error) {
    console.warn("Solve problem failed", error);
    placeholder.status = "error";
  }
  if (token !== mathSolveToken) return;
  renderMathSolution();
  if (mathSolveState.problems[index]?.status === "ready") {
    await verifyMathProblemInPlace({ settings, gradeBand, index, token });
  }
}

async function solveMathWithAI() {
  const token = ++mathSolveToken;
  mathAnswersRevealed = false;
  mathPinPromptOpen = false;
  const button = document.getElementById("mathSolveButton");
  const resetButton = () => {
    if (button) {
      button.disabled = false;
      button.textContent = "Solve & Explain";
    }
  };
  const setStage = (label, panelText) => {
    if (button) {
      button.disabled = true;
      button.textContent = label;
    }
    if (panelText) updateMathThinkingStage(panelText);
  };
  setStage("Reading...");

  const settings = await getOpenAISettings();
  if (!settings) {
    resetButton();
    showMathNotice("Turn on OpenAI first", "Add your OpenAI key in Settings and switch on demo mode, then type, capture, or upload a math problem to solve it.");
    return;
  }
  const gradeBand = settings.gradeBand || "6-8";

  // Paste mode: the typed text IS the problem — skip the vision/transcription
  // pass entirely (no image tokens, nothing to misread), then solve + verify
  // through the same pipeline as the image path.
  if (sourceState.math === "paste") {
    const pasted = (document.getElementById("mathPasteInput")?.value || "").trim().slice(0, 900);
    if (!pasted) {
      resetButton();
      showMathNotice("Type a problem first", "Type or paste your math problem above, then press Solve & Explain.");
      return;
    }
    const transcript = [{ statement: pasted, meta: "Math · typed" }];
    lastMathSolve = { transcript, gradeBand };
    mathSolveState.index = 0;
    mathSolveState.problems = [mathPlaceholderFromTranscript(transcript[0], 0, 1)];
    startMathThinking("Solving your problem, step by step…", { gradeBand, hint: mathTopicHint(mathSolveState.problems) });
    renderMathSolution();
    setStage("Solving...", "Working through your problem…");
    await solveMathProblemInPlace({ settings, gradeBand, index: 0, token });
    if (token !== mathSolveToken) return;
    bumpActivity("mathSolved", 1);
    awardStars(1);
    stopMathThinking();
    resetButton();
    return;
  }

  if (!selectedMathFile && !selectedMathCapture) {
    resetButton();
    showMathNotice("Add a problem first", "Capture the problem on the page or upload a worksheet, then press Solve & Explain.");
    return;
  }

  const parts = [];
  if (selectedMathFile) {
    const fileData = await readFileAsDataUrl(selectedMathFile);
    parts.push(getOpenAIStudySourcePart(selectedMathFile, fileData));
  } else if (selectedMathCapture) {
    parts.push({ type: "input_image", image_url: selectedMathCapture });
  }

  startMathThinking("Reading your problem, every number and label…", { gradeBand });

  // Phase 0: read the image ONCE into text problems. Everything after this is text-only (cheap).
  let transcript;
  try {
    const read = await transcribeMathProblems({ settings, parts, gradeBand });
    if (token !== mathSolveToken) return;
    if (read && read.noMath) {
      stopMathThinking();
      resetButton();
      showMathNotice("No math problem found", read.reason || "KiddieGPT couldn't find a math problem to solve here.");
      return;
    }
    transcript = (Array.isArray(read?.problems) ? read.problems : [])
      .filter(item => item && (item.statement || item.diagram || item.equation))
      .slice(0, 15);
    if (!transcript.length) {
      stopMathThinking();
      resetButton();
      showMathNotice("No math problem found", "KiddieGPT couldn't find a math problem in that image. Try capturing just the problem, or use a clearer picture.");
      return;
    }
  } catch (error) {
    console.warn("Math transcription failed", error);
    if (token !== mathSolveToken) return;
    stopMathThinking();
    resetButton();
    // Surface the real reason (auth/key/network) instead of only "blurry image".
    const reason = friendlyError(error);
    const generic = "KiddieGPT had trouble reading the image. Try a clearer screenshot of just the problem, then Solve & Explain again.";
    showMathNotice("Couldn't read that", reason && reason !== "Something went wrong." ? reason : generic);
    return;
  }

  lastMathSolve = { transcript, gradeBand };
  const total = transcript.length;
  const problems = transcript.map((item, index) => mathPlaceholderFromTranscript(item, index, total));
  mathSolveState.index = 0;
  mathSolveState.problems = problems;
  renderMathSolution();
  refreshMathThinkingTips({ gradeBand, hint: mathTopicHint(problems) });
  setStage("Solving...", "Solving the first problem so you can start right away…");

  // Solve the first problem (text-only) while the panel is up, then reveal it.
  await solveMathProblemInPlace({ settings, gradeBand, index: 0, token });
  if (token !== mathSolveToken) return;
  bumpActivity("mathSolved", total);
  awardStars(total);
  stopMathThinking();
  resetButton();

  // Background: solve + verify the remaining problems one at a time (text-only).
  for (let index = 1; index < problems.length; index += 1) {
    if (token !== mathSolveToken) return;
    await solveMathProblemInPlace({ settings, gradeBand, index, token });
  }
}

function setMathCorrectStatus(message, tone = "") {
  const status = document.getElementById("mathCorrectStatus");
  if (!status) return;
  status.textContent = message;
  status.hidden = !message;
  status.className = `pdf-status ${tone}`.trim();
}

async function correctMathProblem() {
  const input = document.getElementById("mathCorrectInput");
  const send = document.getElementById("mathCorrectSend");
  const note = (input?.value.trim() || "").slice(0, 200);
  if (!note) {
    setMathCorrectStatus("Type what your problem actually says, then re-solve.", "warn");
    return;
  }
  const settings = await getOpenAISettings();
  if (!settings || !lastMathSolve) {
    setMathCorrectStatus("Corrections need your Settings OpenAI key and a solved problem.", "warn");
    return;
  }
  if (send) {
    send.disabled = true;
    send.textContent = "Re-solving...";
  }
  mathSolveToken += 1;
  const gradeBand = lastMathSolve.gradeBand;
  const index = mathSolveState.index;
  const current = mathSolveState.problems[index];
  const transcribed = lastMathSolve.transcript?.[index];
  const baseSource = mathTranscriptSource(transcribed || current);
  setMathCorrectStatus("Re-reading your problem with this correction...", "blue");
  startMathThinking("Re-reading your problem with your correction…", { gradeBand, hint: mathTopicHint(current) });
  try {
    const correctionNote = `The student says this problem was read incorrectly (for example a blurry image or a misread label). Student correction: "${note}". Apply the correction to the problem below and solve ONLY this one problem again, trusting the student's correction over the original reading wherever they conflict. Return a problems array with exactly this one corrected problem.`;
    const rawResult = await solveMathOnce({ settings, parts: [], sourceText: baseSource, gradeBand, disputeNote: correctionNote });
    if (rawResult && rawResult.noMath) {
      setMathCorrectStatus(rawResult.reason || "KiddieGPT still couldn't read a math problem. Try a clearer picture.", "warn");
      return;
    }
    const resolved = normalizeMathProblems(rawResult);
    const corrected = resolved[0];
    if (!corrected) {
      setMathCorrectStatus("Could not re-solve that. Try describing the problem again.", "warn");
      return;
    }
    corrected.status = "ready";
    if (!corrected.figure && transcribed?.figure) corrected.figure = normalizeFigure(transcribed.figure);
    let checked = false;
    try {
      updateMathThinkingStage("Checking the corrected answer…");
      const correctedSource = mathTranscriptSource({ statement: corrected.equation, diagram: transcribed?.diagram, meta: corrected.meta });
      const verdicts = await checkMathOnce({ settings, parts: [], sourceText: correctedSource, problems: [corrected] });
      corrected.disputed = verdicts.some(verdict => verdict.index === 0 && !verdict.agree);
      checked = true;
    } catch (error) {
      console.warn("Correction re-check failed", error);
    }
    corrected.checked = checked;
    mathSolveState.problems[index] = corrected;
    if (lastMathSolve.transcript?.[index]) {
      lastMathSolve.transcript[index] = { ...lastMathSolve.transcript[index], statement: corrected.equation, figure: corrected.figure };
    }
    renderMathSolution();
    if (input) input.value = "";
    setMathCorrectStatus("Updated with your correction.", "blue");
  } catch (error) {
    console.warn("Math correction failed", error);
    setMathCorrectStatus(`Could not re-solve: ${friendlyError(error)}`, "warn");
  } finally {
    stopMathThinking();
    if (send) {
      send.disabled = false;
      send.textContent = "Re-solve";
    }
  }
}

// ---- Phone capture (QR) ------------------------------------------------------
// Mint a paired capture session on the portal, show a QR the student scans with
// their phone, poll for the portal's transcription, then solve it through the
// normal pipeline. The phone only uploads; the image never reaches the laptop.
// Needs a real parent portal session — the dummy test sign-in can't mint tokens.
let captureToken = "";
let capturePollTimer = 0;

function setCaptureState(title, hint, showRefresh = false) {
  const t = document.getElementById("mathQrTitle");
  const h = document.getElementById("mathQrHint");
  const r = document.getElementById("mathQrRefresh");
  if (t) t.textContent = title;
  if (h) h.textContent = hint;
  if (r) r.hidden = !showRefresh;
}

function stopPhoneCapture() {
  clearInterval(capturePollTimer);
  capturePollTimer = 0;
  captureToken = "";
}

function renderCaptureQr(url) {
  const box = document.getElementById("mathQrCode");
  if (!box) return;
  document.querySelector(".math-qr-box")?.classList.remove("qr-processing");
  if (typeof qrcode === "undefined") { box.innerHTML = ""; return; }
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  box.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
}

async function startPhoneCapture() {
  stopPhoneCapture();
  const box = document.getElementById("mathQrCode");
  if (box) box.innerHTML = "";
  if (!portalToken || portalToken === OTP_TEST_TOKEN) {
    setCaptureState("Phone capture needs the parent portal", "Sign in with your parent account to use it. In test mode, use Paste, Screenshot, or Local file.", false);
    return;
  }
  setCaptureState("Getting your code…", "");
  const settings = await getOpenAISettings();
  const gradeBand = settings?.gradeBand || "6-8";
  try {
    const res = await portalFetch("/api/capture/session", { method: "POST", body: { childId: portalSession?.childId || undefined, gradeBand } });
    if (!res?.captureUrl || !res?.token) throw new Error("no_session");
    captureToken = res.token;
    renderCaptureQr(res.captureUrl);
    setCaptureState("Scan with your phone", "Open your phone camera, point it at this code, and snap the problem from your book.");
    pollCaptureResult(res.token);
  } catch (error) {
    setCaptureState("Couldn't start phone capture", friendlyError(error) || "Try again in a moment.", true);
  }
}

function pollCaptureResult(token) {
  clearInterval(capturePollTimer);
  capturePollTimer = setInterval(async () => {
    if (token !== captureToken) return;
    let data;
    try { data = await portalFetch(`/api/capture/${encodeURIComponent(token)}/result`); }
    catch { return; } // transient network hiccup — keep polling
    if (token !== captureToken || !data) return;
    if (data.status === "solving") {
      // Swap the QR out for a playful "we're on it" message while the AI reads
      // the photo — there's nothing left to scan at this point.
      const box = document.getElementById("mathQrCode");
      if (box) box.innerHTML = "";
      document.querySelector(".math-qr-box")?.classList.add("qr-processing");
      setCaptureState("Working on it! Math takes a second (even for us).", "Wanna guess the answer? Winner gets… the satisfaction of guessing.");
      return;
    }
    if (data.status === "ready") {
      stopPhoneCapture();
      setCaptureState("Photo received!", "Solving it below…");
      solveCapturedProblems(Array.isArray(data.problems) ? data.problems : []);
      return;
    }
    if (data.status === "error" || data.status === "expired") {
      stopPhoneCapture();
      setCaptureState(
        data.status === "expired" ? "This code expired" : "Couldn't use that photo",
        data.reason || (data.status === "expired" ? "Tap New code and try again." : "Try a clearer photo."),
        true
      );
    }
  }, 2000);
}

// Solve the portal's transcription through the same pipeline the image path uses.
async function solveCapturedProblems(problems) {
  const transcript = (Array.isArray(problems) ? problems : [])
    .map(item => ({ statement: String(item.statement || ""), diagram: String(item.diagram || ""), meta: String(item.meta || ""), figure: item.figure }))
    .filter(item => item.statement);
  if (!transcript.length) { setCaptureState("No problem found", "I couldn't read a math problem. Try another photo.", true); return; }
  const settings = await getOpenAISettings();
  if (!settings) { showMathNotice("Turn on OpenAI first", "Sign in to solve the problem from your photo."); return; }
  const gradeBand = settings.gradeBand || "6-8";
  const token = ++mathSolveToken;
  mathAnswersRevealed = false;
  mathPinPromptOpen = false;
  startMathThinking("Reading your problem, every number and label…", { gradeBand });
  lastMathSolve = { transcript, gradeBand };
  const total = transcript.length;
  const list = transcript.map((item, index) => mathPlaceholderFromTranscript(item, index, total));
  mathSolveState.index = 0;
  mathSolveState.problems = list;
  renderMathSolution();
  refreshMathThinkingTips({ gradeBand, hint: mathTopicHint(list) });
  await solveMathProblemInPlace({ settings, gradeBand, index: 0, token });
  if (token !== mathSolveToken) return;
  bumpActivity("mathSolved", total);
  awardStars(total);
  stopMathThinking();
  for (let index = 1; index < list.length; index += 1) {
    if (token !== mathSolveToken) return;
    await solveMathProblemInPlace({ settings, gradeBand, index, token });
  }
}

function updateMathSourceMode() {
  const mode = sourceState.math || "screenshot";
  document.querySelectorAll("[data-math-source-mode]").forEach(panel => {
    panel.hidden = panel.dataset.mathSourceMode !== mode;
    panel.classList.toggle("active", panel.dataset.mathSourceMode === mode);
  });
  // Phone capture auto-solves when the photo arrives, so the manual Solve button
  // doesn't apply. Start/stop the QR session as the student enters/leaves the tab.
  const solveBtn = document.getElementById("mathSolveButton");
  if (solveBtn) solveBtn.hidden = mode === "qr";
  if (mode === "qr") startPhoneCapture();
  else stopPhoneCapture();
}

function updateExplainSourceMode() {
  const mode = sourceState.explain || "page";
  document.querySelectorAll("[data-explain-source-mode]").forEach(panel => {
    panel.hidden = panel.dataset.explainSourceMode !== mode;
    panel.classList.toggle("active", panel.dataset.explainSourceMode === mode);
  });
}

function initMathTool() {
  document.getElementById("mathBrowseButton")?.addEventListener("click", () => {
    document.getElementById("mathFileInput")?.click();
  });
  document.getElementById("mathFileInput")?.addEventListener("change", handleMathFileChange);
  document.querySelector(".math-capture-box")?.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    captureMathProblemRegion();
  });
  document.getElementById("mathSolveButton")?.addEventListener("click", solveMathWithAI);
  document.getElementById("mathQrRefresh")?.addEventListener("click", startPhoneCapture);
  // Enter solves from the paste box; Shift+Enter makes a new line.
  document.getElementById("mathPasteInput")?.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      solveMathWithAI();
    }
  });
  document.getElementById("mathPrevProblem")?.addEventListener("click", () => {
    mathSolveState.index = Math.max(0, mathSolveState.index - 1);
    renderMathSolution();
  });
  document.getElementById("mathNextProblem")?.addEventListener("click", () => {
    mathSolveState.index = Math.min(mathSolveState.problems.length - 1, mathSolveState.index + 1);
    renderMathSolution();
  });
  document.getElementById("mathStepList")?.addEventListener("click", event => {
    const toggle = event.target.closest("[data-math-notes]");
    if (!toggle) return;
    const showNotes = toggle.dataset.mathNotes === "explained";
    if (showNotes === mathShowNotes) return;
    mathShowNotes = showNotes;
    saveSettings({ mathShowNotes });
    renderMathSolution();
  });
  document.getElementById("mathStepList")?.addEventListener("keydown", event => {
    if (event.target.id === "mathRevealPin" && event.key === "Enter") {
      event.preventDefault();
      unlockMathReveal();
    }
  });
  document.getElementById("mathCorrectToggle")?.addEventListener("click", () => {
    const panel = document.getElementById("mathCorrectPanel");
    if (!panel) return;
    panel.hidden = !panel.hidden;
    if (!panel.hidden) document.getElementById("mathCorrectInput")?.focus();
  });
  document.getElementById("mathCorrectSend")?.addEventListener("click", correctMathProblem);
  document.getElementById("mathCorrectInput")?.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    correctMathProblem();
  });
  updateMathSourceMode();
  renderMathSolution();
}

function initExplainTool() {
  document.querySelector(".explain-input-box[data-action='capture-screenshot']")?.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    captureVisibleTab();
  });
  document.getElementById("explainFollowToggle")?.addEventListener("click", () => {
    const panel = document.getElementById("explainFollowupPanel");
    if (!panel) return;
    panel.hidden = !panel.hidden;
    if (!panel.hidden) document.getElementById("explainFollowupInput")?.focus();
  });
  document.getElementById("explainFollowupPanel")?.addEventListener("click", event => {
    const chip = event.target.closest("[data-followup-prompt]");
    if (!chip) return;
    const input = document.getElementById("explainFollowupInput");
    if (input) {
      input.value = chip.dataset.followupPrompt;
      input.focus();
    }
  });
  document.getElementById("explainButton")?.addEventListener("click", explainCurrentSource);
  document.getElementById("explainFollowupSend")?.addEventListener("click", answerExplainFollowup);
  document.getElementById("explainFollowupInput")?.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    answerExplainFollowup();
  });
  updateExplainSourceMode();
}

function initTutorMode() {
  document.getElementById("tutorGenerateButton")?.addEventListener("click", generateTutorVoice);
  document.querySelectorAll("[data-tutor-mode]").forEach(card => {
    card.addEventListener("click", () => setTutorMode(card.dataset.tutorMode));
  });
  document.getElementById("tutorSourceSummary")?.addEventListener("click", event => {
    if (event.target.closest("#tutorChooseFile")) choosePdfFile();
  });
  const audio = document.getElementById("tutorAudioPlayer");
  document.getElementById("tutorPlayButton")?.addEventListener("click", () => {
    if (!audio || !audio.src) return;
    if (audio.paused) audio.play(); else audio.pause();
  });
  audio?.addEventListener("play", () => updateTutorPlayButton(true));
  audio?.addEventListener("pause", () => updateTutorPlayButton(false));
  audio?.addEventListener("ended", () => updateTutorPlayButton(false));
  audio?.addEventListener("timeupdate", () => { updateTutorTime(); updateTutorHighlight(); });
  audio?.addEventListener("loadedmetadata", updateTutorTime);
  document.getElementById("tutorProgressTrack")?.addEventListener("click", event => {
    if (!audio || !audio.duration) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * audio.duration;
    updateTutorTime();
    updateTutorHighlight();
  });
  document.getElementById("tutorSpeed")?.addEventListener("click", () => {
    const rates = [1, 1.25, 0.75];
    tutorPlaybackRate = rates[(rates.indexOf(tutorPlaybackRate) + 1) % rates.length];
    if (audio) audio.playbackRate = tutorPlaybackRate;
    const speed = document.getElementById("tutorSpeed");
    if (speed) speed.textContent = `Speed ${tutorPlaybackRate}×`;
    saveSettings({ tutorPlaybackRate });
  });
  document.getElementById("tutorTranscript")?.addEventListener("click", event => {
    const span = event.target.closest(".tutor-sentence");
    if (!span || !audio || !audio.duration) return;
    const bound = tutorSentenceBounds[Number(span.dataset.sentence)];
    if (!bound) return;
    audio.currentTime = bound.start * audio.duration;
    updateTutorTime();
    updateTutorHighlight();
    if (audio.paused) audio.play();
  });
  setTutorMode(tutorMode);
  updateTutorSourceSummary();
}

async function explainCurrentSource() {
  const button = document.getElementById("explainButton");
  const observation = document.getElementById("screenshotObservation");
  if (button) {
    button.disabled = true;
    button.textContent = "Explaining...";
  }
  setScreenshotStatus("Explaining", "blue");
  try {
    const settings = await getOpenAISettings();
    if (!settings) {
      setScreenshotStatus("Sample");
      if (observation) observation.textContent = "KiddieGPT will explain the main idea in student-friendly language, then point out the important labels, clues, or vocabulary.";
      return;
    }
    const parts = [];
    let sourceText = "";
    if (sourceState.explain === "screenshot" && selectedExplainCapture) {
      parts.push({ type: "input_image", image_url: selectedExplainCapture });
      sourceText = "Explain the attached screenshot or visual.";
    } else {
      const context = await getActiveTabContext();
      if (!context.usable) {
        setScreenshotStatus("Can't read tab", "warn");
        if (observation) observation.textContent = activeTabIssueMessage(context.reason);
        return;
      }
      sourceText = `Explain this active page or selected text.\nTitle: ${context.title}\nURL: ${context.url}\nText: ${context.text}`;
    }
    const result = await callOpenAIJson({
      settings,
      instructions: "You are KiddieGPT, a grade-safe explainer for students up to 8th grade. Be short, clear, and encouraging. Return only valid JSON.",
      text: `${sourceText}\nReturn JSON with explanation string, remember string, vocabulary array of up to 3 short strings.`,
      parts
    });
    if (observation) {
      const vocab = Array.isArray(result.vocabulary) && result.vocabulary.length ? ` Key words: ${result.vocabulary.join(", ")}.` : "";
      observation.textContent = `${result.explanation || "Here is the main idea in simpler words."} ${result.remember || ""}${vocab}`.trim();
    }
    setScreenshotStatus("AI ready");
    bumpActivity("explains", 1);
    awardStars(2);
  } catch (error) {
    console.warn("Explain AI failed", error);
    setScreenshotStatus("Sample", "warn");
    if (observation) observation.textContent = "Could not reach AI, so KiddieGPT is showing the sample explanation flow.";
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Explain";
    }
    // First run replaces the intro pipeline with the real answer sheet.
    const explainIntro = document.getElementById("explainIntro");
    if (explainIntro) explainIntro.hidden = true;
    document.querySelector(".explain-answer-sheet")?.removeAttribute("hidden");
  }
}

async function answerExplainFollowup() {
  const input = document.getElementById("explainFollowupInput");
  const answer = document.getElementById("explainFollowupAnswer");
  if (!input || !answer) return;
  const question = (input.value.trim() || "Explain this another way").slice(0, 200);
  answer.hidden = false;
  answer.innerHTML = `<span>Thinking...</span>`;
  try {
    const settings = await getOpenAISettings();
    if (!settings) throw new Error("No OpenAI settings");
    const parts = [];
    // Answer from the explanation we already generated — no page re-fetch.
    const explanation = document.getElementById("screenshotObservation")?.textContent || "";
    if (sourceState.explain === "screenshot" && selectedExplainCapture) {
      parts.push({ type: "input_image", image_url: selectedExplainCapture });
    }
    const result = await callOpenAIJson({
      settings,
      instructions: "You are KiddieGPT, a grade-safe tutor for K-8 students. Answer follow-up questions using only the explanation already given (and the screenshot if attached). If the answer isn't in it, say so and suggest re-running Explain. Keep it brief. Return only valid JSON.",
      text: `Explanation already given to the student:\n${explanation}\n\nFollow-up question: ${question}\nReturn JSON with answer string and tryNext string.`,
      parts
    });
    answer.innerHTML = `<span class="followup-question">You asked: ${escapeHtml(question)}</span><p>${escapeHtml(result.answer || "Here is a simpler way to think about it.")}</p><small>${escapeHtml(result.tryNext || "Try saying the idea back in your own words.")}</small>`;
  } catch {
    answer.innerHTML = `<b>You asked:</b> ${escapeHtml(question)}<br><span>KiddieGPT would answer using the same page or screenshot, then keep it short and grade-safe.</span>`;
  }
}

function initMissionFollowup() {
  document.getElementById("missionFollowToggle")?.addEventListener("click", () => {
    const panel = document.getElementById("missionFollowupPanel");
    if (!panel) return;
    panel.hidden = !panel.hidden;
    if (!panel.hidden) document.getElementById("missionFollowupInput")?.focus();
  });
  document.getElementById("missionFollowupPanel")?.addEventListener("click", event => {
    const chip = event.target.closest("[data-mission-followup-prompt]");
    if (!chip) return;
    const input = document.getElementById("missionFollowupInput");
    if (input) {
      input.value = chip.dataset.missionFollowupPrompt;
      input.focus();
    }
  });
  document.getElementById("missionFollowupSend")?.addEventListener("click", answerMissionFollowup);
  document.getElementById("missionFollowupInput")?.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    answerMissionFollowup();
  });
}

async function answerMissionFollowup() {
  const input = document.getElementById("missionFollowupInput");
  const answer = document.getElementById("missionFollowupAnswer");
  if (!input || !answer) return;
  const pack = currentStudyPack;
  if (!pack) {
    answer.hidden = false;
    answer.innerHTML = `<span>Build a study mission first, then ask about it here.</span>`;
    return;
  }
  const question = (input.value.trim() || "Make this easier").slice(0, 200);
  answer.hidden = false;
  answer.innerHTML = "<span>Thinking...</span>";
  try {
    const settings = await getOpenAISettings();
    if (!settings) throw new Error("No OpenAI settings");
    const result = await callOpenAIJson({
      settings,
      instructions: "You are KiddieGPT, a grade-safe study tutor for K-8 students. Answer from the study mission only. Return only valid JSON.",
      text: `Study mission:\n${getCurrentStudyPackText()}\nStudent question: ${question}\nReturn JSON with answer string and tryNext string. Keep it short and useful.`
    });
    answer.innerHTML = `<span class="followup-question">You asked: ${escapeHtml(question)}</span><p>${escapeHtml(result.answer || pack.mainIdea)}</p><small>${escapeHtml(result.tryNext || "Try a flashcard or one quiz question next.")}</small>`;
  } catch {
    const terms = (pack.keyTerms || []).slice(0, 3).join(", ");
    const termLine = terms ? `Key words to watch: ${terms}.` : "";
    answer.innerHTML = `
      <span class="followup-question">You asked: ${escapeHtml(question)}</span>
      <p>${escapeHtml(pack.mainIdea || "Start with the biggest idea from this mission.")}</p>
      <p>${escapeHtml(pack.rememberThis || "Say the idea in your own words, then practice with a card or quiz question.")}</p>
      ${termLine ? `<small>${escapeHtml(termLine)}</small>` : ""}
    `;
  }
}

const writingActions = {
  assignment: {
    eyebrow: "Assignment",
    modeTitle: "Understand the assignment",
    copy: "Paste the assignment question and KiddieGPT helps you plan before you write.",
    hint: "Start with the assignment directions or question.",
    placeholder: "Paste the assignment or question here…",
    button: "Help me plan",
    emptyTitle: "Plan before you write",
    emptyCopy: "Paste the assignment and press Help me plan for a plan you fill in yourself."
  },
  draft: {
    eyebrow: "Draft",
    modeTitle: "Check my draft",
    copy: "Paste your own writing and KiddieGPT points out what to add or fix.",
    hint: "Paste your draft. KiddieGPT will coach, not rewrite.",
    placeholder: "Paste your draft here…",
    button: "Check my draft",
    emptyTitle: "Check your draft",
    emptyCopy: "Paste your draft and press Check my draft to see what to add next."
  },
  grammar: {
    eyebrow: "Grammar",
    modeTitle: "Check my writing",
    copy: "KiddieGPT underlines things to look at. Tap each one to see why — you choose whether to change it.",
    hint: "Paste a sentence or paragraph you want to make clearer.",
    placeholder: "Paste a sentence or paragraph here…",
    button: "Check my writing",
    emptyTitle: "Check your writing",
    emptyCopy: "Paste a sentence or paragraph and press Check my writing. Underlined words show what to look at."
  }
};

function writingGradeGuidance(gradeBand) {
  if (gradeBand === "K-2") return "The writer is in grade K-2. Use very simple words and short sentences. Focus on one idea, capital letters at the start, and a period at the end.";
  if (gradeBand === "3-5") return "The writer is in grade 3-5. Expect a clear main idea with one or two reasons and an example.";
  if (gradeBand === "9-12") return "The writer is in grade 9-12. Expect a clear thesis, well-developed paragraphs with evidence and analysis, varied sentence structure, and academic tone.";
  return "The writer is in grade 6-8. Expect a claim, reasons, evidence, and clear organization.";
}

function initWritingStudio() {
  document.querySelectorAll("[data-writing-action]").forEach(button => {
    button.addEventListener("click", () => setWritingAction(button.dataset.writingAction));
  });
  document.getElementById("writingRunButton")?.addEventListener("click", runWritingCoach);
  document.getElementById("writingOutputGrid")?.addEventListener("click", onWritingReviewClick);
  setWritingAction(writingState.action);
}

function onWritingReviewClick(event) {
  const span = event.target.closest(".wq");
  if (span) {
    const i = Number(span.dataset.i);
    writingState.activeIssue = writingState.activeIssue === i ? null : i;
    renderWritingReview();
    return;
  }
  const apply = event.target.closest("[data-apply]");
  if (apply) { applyWritingFix(Number(apply.dataset.apply)); return; }
  const keep = event.target.closest("[data-keep]");
  if (keep) {
    const issue = writingState.review?.issues[Number(keep.dataset.keep)];
    if (issue) issue.dismissed = true;
    writingState.activeIssue = null;
    renderWritingReview();
  }
}

function setWritingAction(action) {
  if (!writingActions[action]) return;
  writingState.action = action;
  const config = writingActions[action];
  const input = document.getElementById("writingInput");
  document.querySelectorAll("[data-writing-action]").forEach(button => {
    button.classList.toggle("active", button.dataset.writingAction === action);
  });
  document.getElementById("writingModeEyebrow").textContent = config.eyebrow;
  document.getElementById("writingModeTitle").textContent = config.modeTitle;
  document.getElementById("writingModeCopy").textContent = config.copy;
  document.getElementById("writingInputHint").textContent = config.hint;
  document.getElementById("writingRunButton").textContent = config.button;
  if (input) input.placeholder = config.placeholder;
  renderWritingEmpty();
}

const writingDemoStrips = {
  assignment: `Break the prompt into <mark>what to say</mark> and <mark>how to prove it</mark>.`,
  draft: `Strong drafts add <mark>one example only you would know</mark>.`,
  grammar: `I saw <span class="wq-demo">a eagle</span> at the zoo &nbsp;→&nbsp; <mark>an eagle</mark>`
};

function renderWritingEmpty() {
  const config = writingActions[writingState.action] || writingActions.assignment;
  const title = document.getElementById("writingOutputTitle");
  const status = document.getElementById("writingOutputStatus");
  const grid = document.getElementById("writingOutputGrid");
  if (title) title.textContent = config.modeTitle;
  if (status) status.textContent = "Ready";
  if (!grid) return;
  grid.innerHTML = `
    <div class="wr-empty-head"><b>${escapeHtml(config.emptyTitle)}</b><p>${escapeHtml(config.emptyCopy)}</p></div>
    <div class="tv-pipe" aria-hidden="true">
      <div class="tv-stage">
        <span class="tv-ico"><svg viewBox="0 0 24 24"><path d="m14.5 5 4.5 4.5L8.5 20H4v-4.5Z"/><path d="m12.5 7 4.5 4.5"/></svg></span>
        <b>You write it</b>
        <small>Your own words, always</small>
      </div>
      <span class="tv-arrow"><svg viewBox="0 0 24 24"><path d="M4 12h14"/><path d="m13 6 6 6-6 6"/></svg></span>
      <div class="tv-stage">
        <span class="tv-ico"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/><path d="M8.5 12.8c1-.9 2-.9 3 0s2 .9 3 0"/></svg></span>
        <b>KiddieGPT coaches</b>
        <small>Flags it and explains why</small>
      </div>
      <span class="tv-arrow"><svg viewBox="0 0 24 24"><path d="M4 12h14"/><path d="m13 6 6 6-6 6"/></svg></span>
      <div class="tv-stage">
        <span class="tv-ico"><svg viewBox="0 0 24 24"><path d="m5 12.5 4.4 4.5L19 7"/></svg></span>
        <b>You choose the fix</b>
        <small>Tap, learn why, decide</small>
      </div>
    </div>
    <div class="tv-demo" aria-hidden="true">
      <span class="tv-demo-play"><svg viewBox="0 0 24 24"><path d="m14.5 5 4.5 4.5L8.5 20H4v-4.5Z"/><path d="m12.5 7 4.5 4.5"/></svg></span>
      <p>${writingDemoStrips[writingState.action] || writingDemoStrips.assignment}</p>
    </div>`;
}

function renderWritingLoading() {
  const grid = document.getElementById("writingOutputGrid");
  if (grid) grid.innerHTML = `<div class="writing-empty"><div class="math-thinking-orb" aria-hidden="true"><span></span><span></span><span></span></div><p>KiddieGPT is reading your writing…</p></div>`;
}

function writingNotice(titleText, message) {
  const grid = document.getElementById("writingOutputGrid");
  if (grid) grid.innerHTML = `<div class="writing-empty"><b>${escapeHtml(titleText)}</b><p>${escapeHtml(message)}</p></div>`;
}

function renderWritingResult(output) {
  const title = document.getElementById("writingOutputTitle");
  const status = document.getElementById("writingOutputStatus");
  const grid = document.getElementById("writingOutputGrid");
  if (title) title.textContent = output.title;
  if (status) status.textContent = output.status;
  if (!grid) return;
  const [nextLabel, nextText] = output.next;
  grid.innerHTML = `
    <div class="writing-next-card">
      <span>${escapeHtml(nextLabel)}</span>
      <p>${escapeHtml(nextText)}</p>
    </div>
    <div class="writing-mini-list">
      ${output.checks.map(([label, text]) => (
        `<div><b>${escapeHtml(label)}</b><small>${escapeHtml(text)}</small></div>`
      )).join("")}
    </div>
  `;
}

function normalizeWritingResult(result) {
  const fallback = { title: "Try this plan", status: "Coach", next: ["Next step", "Write one sentence in your own words, then read it out loud."], checks: [["Claim", "Say clearly what you think."], ["Reason", "Add one reason and an example only you would know."]] };
  return {
    title: result.title || fallback.title,
    status: result.status || "AI coach",
    next: Array.isArray(result.next) && result.next.length >= 2 ? result.next.slice(0, 2) : fallback.next,
    checks: Array.isArray(result.checks) && result.checks.length
      ? result.checks.slice(0, 3).map(item => [item.label || item[0] || "Check", item.text || item[1] || "Review this part."])
      : fallback.checks
  };
}

// --- Inline writing review (underline → tap to see why → you choose to fix) ---
function normalizeWritingIssues(result, sourceText) {
  const arr = Array.isArray(result.issues) ? result.issues : [];
  return arr
    .map(item => ({
      text: String(item.text || "").trim(),
      type: String(item.type || "Fix").trim(),
      why: String(item.why || "").trim(),
      fix: String(item.fix ?? "").trim(),
      applied: false,
      dismissed: false
    }))
    .filter(issue => issue.text && issue.fix !== issue.text && sourceText.includes(issue.text))
    .slice(0, 12);
}

// Find one non-overlapping occurrence of each live issue's text; return ranges sorted left-to-right.
function locateWritingRanges(text, issues) {
  const used = [];
  const ranges = [];
  issues.forEach((issue, idx) => {
    if (issue.applied || issue.dismissed || !issue.text) return;
    let from = 0;
    let pos;
    while ((pos = text.indexOf(issue.text, from)) !== -1) {
      const end = pos + issue.text.length;
      const overlaps = used.some(u => pos < u.end && end > u.start);
      if (!overlaps) {
        used.push({ start: pos, end });
        ranges.push({ start: pos, end, idx });
        break;
      }
      from = pos + 1;
    }
  });
  return ranges.sort((a, b) => a.start - b.start);
}

function markedWritingHtml(text, ranges) {
  let html = "";
  let cursor = 0;
  ranges.forEach(range => {
    html += escapeHtml(text.slice(cursor, range.start));
    html += `<span class="wq" data-i="${range.idx}">${escapeHtml(text.slice(range.start, range.end))}</span>`;
    cursor = range.end;
  });
  html += escapeHtml(text.slice(cursor));
  return html.replace(/\n/g, "<br>");
}

function writingDetailHtml(issue, index) {
  return `<div class="wr-detail">
    <span class="wr-chip wr-chip-${escapeHtml((issue.type || "fix").toLowerCase())}">${escapeHtml(issue.type || "Fix")}</span>
    <p class="wr-why">${escapeHtml(issue.why || "Take another look at this part.")}</p>
    <div class="wr-fixrow"><span class="wr-you">You wrote <b>${escapeHtml(issue.text)}</b></span><span class="wr-arrow">→</span><span class="wr-try">Try <b>${escapeHtml(issue.fix)}</b></span></div>
    <div class="wr-detail-actions"><button class="wr-apply" data-apply="${index}" type="button">Use this fix</button><button class="wr-keep" data-keep="${index}" type="button">Keep mine</button></div>
  </div>`;
}

function writingReviewStatsHtml(review, ranges) {
  const total = review.issues.length;
  const handled = review.issues.filter(issue => issue.applied || issue.dismissed).length;
  const counts = {};
  ranges.forEach(range => {
    const type = review.issues[range.idx]?.type || "Fix";
    counts[type] = (counts[type] || 0) + 1;
  });
  const chips = Object.entries(counts)
    .map(([type, count]) => `<span class="wr-chip wr-chip-${escapeHtml(type.toLowerCase())}">${escapeHtml(type)} · ${count}</span>`)
    .join("");
  const pct = total ? Math.round((handled / total) * 100) : 100;
  return `<div class="wr-stats">
    <div class="wr-stats-row">
      <div class="wr-progress"><span style="width:${pct}%"></span></div>
      <small>${handled} of ${total} handled</small>
    </div>
    ${chips ? `<div class="wr-type-chips">${chips}</div>` : ""}
  </div>`;
}

function renderWritingReview() {
  const review = writingState.review;
  const title = document.getElementById("writingOutputTitle");
  const status = document.getElementById("writingOutputStatus");
  const grid = document.getElementById("writingOutputGrid");
  if (!grid || !review) return;
  const ranges = locateWritingRanges(review.text, review.issues);
  const remaining = ranges.length;
  if (title) title.textContent = "Check your writing";
  if (status) status.textContent = remaining ? `${remaining} to look at` : "All clear";
  const active = writingState.activeIssue;
  const activeIssue = active != null ? review.issues[active] : null;
  const detail = activeIssue && !activeIssue.applied && !activeIssue.dismissed
    ? writingDetailHtml(activeIssue, active)
    : "";
  const hint = remaining
    ? `<p class="wr-hint">Tap an underlined word to see why — you choose whether to change it.</p>`
    : `<p class="wr-hint">Nice — nothing left to flag. Edit more and press Check again.</p>`;
  grid.innerHTML = `${writingReviewStatsHtml(review, ranges)}<div class="wr-text">${markedWritingHtml(review.text, ranges) || "&nbsp;"}</div>${hint}${detail}`;
}

function applyWritingFix(index) {
  const review = writingState.review;
  const issue = review?.issues[index];
  if (!issue || issue.applied || issue.dismissed) return;
  const range = locateWritingRanges(review.text, review.issues).find(r => r.idx === index);
  if (range) {
    review.text = review.text.slice(0, range.start) + issue.fix + review.text.slice(range.end);
    const input = document.getElementById("writingInput");
    if (input) input.value = review.text;
  }
  issue.applied = true;
  writingState.activeIssue = null;
  renderWritingReview();
}

async function runWritingCoach() {
  const button = document.getElementById("writingRunButton");
  const input = document.getElementById("writingInput");
  const status = document.getElementById("writingOutputStatus");
  const config = writingActions[writingState.action] || writingActions.assignment;
  const text = (input?.value.trim() || "").slice(0, 900);
  if (!text) {
    if (status) status.textContent = "Paste text first";
    writingNotice("Nothing to check yet", config.emptyCopy);
    return;
  }
  const settings = await getOpenAISettings();
  if (!settings) {
    if (status) status.textContent = "Add key";
    writingNotice("Add your OpenAI key", "Turn on OpenAI in Settings to get writing coaching.");
    return;
  }
  const gradeBand = settings.gradeBand || "6-8";
  if (button) {
    button.disabled = true;
    button.textContent = "Reading…";
  }
  renderWritingLoading();
  try {
    if (writingState.action === "grammar") {
      const result = await callOpenAIJson({
        settings,
        instructions: "You are KiddieGPT Writing Studio for K-8 students. Find real mechanics problems only — spelling, punctuation, capitalization, grammar, and obvious clarity slips. Keep the student's own ideas, voice, and argument; never rewrite their content or add new ideas. Return only valid JSON.",
        text: `${writingGradeGuidance(gradeBand)}\nStudent text:\n${text}\nReturn JSON with an issues array (up to 12). Each issue has: text = the exact substring copied verbatim from the student's writing, as short as possible (usually one word or a few words); type = one of Spelling, Punctuation, Capitalization, Grammar, Clarity; why = one short sentence in grade-appropriate language explaining the problem; fix = the corrected version of that same substring. Keep each flagged text as small as possible — prefer fixing one word over rephrasing several, and never reorder or reword beyond the mechanical fix. For spelling, the why must name what is tricky about the word or give the correct spelling, never just "spelled incorrectly." Only include genuine errors. If the writing is already clean, return an empty issues array.`
      });
      writingState.review = { text, issues: normalizeWritingIssues(result, text) };
      writingState.activeIssue = null;
      if (!writingState.review.issues.length) {
        const title = document.getElementById("writingOutputTitle");
        const status = document.getElementById("writingOutputStatus");
        if (title) title.textContent = "Check your writing";
        if (status) status.textContent = "All clear";
        writingNotice("Looks clean!", "KiddieGPT didn't find grammar or spelling problems. Nice work.");
      } else {
        renderWritingReview();
      }
    } else {
      const result = await callOpenAIJson({
        settings,
        instructions: "You are KiddieGPT Writing Studio for K-8 students. Coach the writer; never write their sentences for them. Give prompts and structure the student fills in — do not hand them a ready-to-copy claim, thesis, reason, or paragraph. Return only valid JSON.",
        text: `Mode: ${writingState.action}. ${writingGradeGuidance(gradeBand)}\nStudent text or assignment:\n${text}\nReturn JSON with title string, status string, next as [short label, one short action the student does themselves], and checks as an array of 2 objects with label and text. Every text must be a prompt or a thing to check, never a finished sentence the student can copy. Keep it short and student-friendly.`
      });
      renderWritingResult(normalizeWritingResult(result));
    }
    bumpActivity("writingChecks", 1);
    awardStars(2);
  } catch (error) {
    console.warn("Writing AI failed", error);
    if (status) status.textContent = "Try again";
    writingNotice("Couldn't coach that", friendlyError(error));
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = config.button;
    }
  }
}

function renderParentPinArea() {
  const area = document.getElementById("parentPinArea");
  const note = document.getElementById("parentPinNote");
  const gateToggle = document.getElementById("mathAnswerGateToggle");
  const locked = Boolean(mathParentPinHash);
  if (gateToggle) {
    gateToggle.disabled = locked;
    if (locked) gateToggle.checked = true;
  }
  if (!area) return;
  if (locked && pinResetState.where === "settings" && pinResetState.step !== "idle") {
    area.innerHTML = pinResetHtml();
    if (note) note.textContent = "Reset the parent PIN.";
    return;
  }
  area.innerHTML = locked
    ? `<span class="pin-badge">🔒 Answers locked</span><div class="pin-row"><input id="parentPinInput" type="password" inputmode="numeric" maxlength="6" placeholder="Enter PIN" autocomplete="off"><button id="parentPinRemove" type="button">Remove lock</button></div><button class="reveal-link pin-forgot" type="button" data-pin-forgot="settings">Forgot PIN?</button><small class="pin-msg" id="parentPinMsg" hidden></small>`
    : `<div class="pin-row"><input id="parentPinInput" type="password" inputmode="numeric" maxlength="6" placeholder="4–6 digit PIN" autocomplete="off"><button id="parentPinSet" type="button">Lock answers</button></div><small class="pin-msg" id="parentPinMsg" hidden></small>`;
  if (note) note.textContent = locked ? "Answers stay hidden until this PIN is entered." : "Set a PIN so only a parent can reveal answers.";
}

async function handleParentPinAction(event) {
  const setBtn = event.target.closest("#parentPinSet");
  const removeBtn = event.target.closest("#parentPinRemove");
  if (!setBtn && !removeBtn) return;
  const input = document.getElementById("parentPinInput");
  const msg = document.getElementById("parentPinMsg");
  const pin = input?.value.trim() || "";
  const showMsg = text => { if (msg) { msg.hidden = false; msg.textContent = text; } };
  if (setBtn) {
    if (!/^\d{4,6}$/.test(pin)) { showMsg("Use a 4 to 6 digit PIN."); return; }
    mathParentPinHash = await hashPin(pin);
    mathAnswerGate = true;
    await saveSettings({ mathParentPin: mathParentPinHash, mathAnswerGate: true });
    mathAnswersRevealed = false;
    mathPinPromptOpen = false;
    renderParentPinArea();
    renderMathSolution();
  } else {
    const ok = mathParentPinHash && (await hashPin(pin)) === mathParentPinHash;
    if (!ok) { showMsg("That PIN didn't match."); return; }
    mathParentPinHash = "";
    await saveSettings({ mathParentPin: "" });
    renderParentPinArea();
    renderMathSolution();
  }
}

// ---- Student selector: the children a parent set up on the portal ----
function renderChildSelect() {
  const select = document.getElementById("childSelect");
  const badge = document.getElementById("settingsStudentBadge");
  if (!select) return;
  // Session children come from the portal; fall back to the local-settings list
  // so a configured dev/test list always shows even if the session path missed it.
  let children = Array.isArray(portalSession?.children) && portalSession.children.length
    ? portalSession.children
    : normalizeChildren(globalThis.KIDDIEGPT_LOCAL_SETTINGS?.children);
  const active = portalSession?.childId || children[0]?.id || "";
  if (children.length) {
    select.innerHTML = children.map(child => (
      `<option value="${escapeHtml(child.id)}"${child.id === active ? " selected" : ""}>${escapeHtml(child.name || "Student")}${child.grade ? ` · ${escapeHtml(child.grade)}` : ""}</option>`
    )).join("");
    select.disabled = false;
  } else {
    // No student list available yet (portal hasn't returned children). Use a
    // neutral placeholder — never the parent's email, which isn't the student.
    select.innerHTML = `<option value="${escapeHtml(active)}">Student</option>`;
    select.disabled = true;
  }
  const current = children.find(child => child.id === active);
  if (badge) badge.textContent = current?.name || "Student";
}

async function onChildSelectChange(event) {
  const id = event.target.value;
  if (portalSession) portalSession.childId = id;
  await storageSet({ [PORTAL_CHILD_KEY]: id });
  renderChildSelect();
  renderStars();
}

async function handleSignOut() {
  await portalSignOut();
  renderChildSelect();
  renderPortalGate("login", "");
}

// ---- Tutor voice selector (admin-approved list only) ----
async function renderVoiceSelect() {
  const select = document.getElementById("studentVoiceSelect");
  if (!select) return;
  const list = allowedVoices();
  const settings = await getSettings();
  let current = String(settings.studentVoice || "").trim().toLowerCase();
  // Saved voice no longer approved -> reset to the (admin) default and persist.
  if (!list.includes(current)) {
    current = defaultVoice();
    await saveSettings({ studentVoice: current });
  }
  select.innerHTML = list.map(voice => (
    `<option value="${escapeHtml(voice)}"${voice === current ? " selected" : ""}>${escapeHtml(voiceLabel(voice))}</option>`
  )).join("");
}

async function onVoiceSelectChange(event) {
  const voice = resolveVoice(event.target.value);
  await saveSettings({ studentVoice: voice });
  event.target.value = voice;
}

// ---- Stars: motivational reward derived from the week's real activity ----
// All-time stars: a cumulative counter that only grows (kids want a number that
// climbs), persisted separately so it survives the 7-day activity prune.
let starsTotal = 0;
const starsStorageKey = "kiddiegptStars";

async function loadStars() {
  try {
    const data = await storageGet([starsStorageKey]);
    starsTotal = Number(data[starsStorageKey]) || 0;
  } catch { starsTotal = 0; }
  renderStars();
}

function awardStars(count) {
  const n = Math.round(Number(count) || 0);
  if (n <= 0) return;
  starsTotal += n;
  storageSet({ [starsStorageKey]: starsTotal });
  renderStars();
}

function renderStars() {
  const el = document.getElementById("starsCount");
  if (el) el.textContent = String(starsTotal);
}

function initSettingsTool() {
  document.getElementById("saveSettingsButton")?.addEventListener("click", saveSettingsForm);
  document.getElementById("clearOpenAIButton")?.addEventListener("click", clearOpenAISettings);
  document.getElementById("testOpenAIButton")?.addEventListener("click", testOpenAIKey);
  document.getElementById("childSelect")?.addEventListener("change", onChildSelectChange);
  document.getElementById("studentVoiceSelect")?.addEventListener("change", onVoiceSelectChange);
  document.getElementById("signOutButton")?.addEventListener("click", handleSignOut);
  document.getElementById("mathAnswerGateToggle")?.addEventListener("change", event => {
    mathAnswerGate = event.target.checked;
    mathAnswersRevealed = false;
    saveSettings({ mathAnswerGate });
    renderMathSolution();
  });
  document.getElementById("parentPinArea")?.addEventListener("click", handleParentPinAction);
  renderParentPinArea();
  document.querySelectorAll("[data-settings-jump]").forEach(button => {
    button.addEventListener("click", () => {
      document.getElementById(button.dataset.settingsJump)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  document.getElementById("clearGeneratedAudioButton")?.addEventListener("click", () => {
    const audio = document.getElementById("tutorAudioPlayer");
    if (audio && !audio.paused) audio.pause();
    if (tutorAudioUrl) URL.revokeObjectURL(tutorAudioUrl);
    tutorAudioUrl = "";
    tutorSentences = [];
    tutorSentenceBounds = [];
    tutorCurrentSentence = -1;
    if (audio) {
      audio.removeAttribute("src");
      audio.load();
    }
    showTutorPlayer(false);
    updateSettingsStatus("Generated tutor audio cleared from this session.", "blue");
  });
  document.getElementById("clearStudyCacheButton")?.addEventListener("click", () => {
    currentStudyPack = null;
    selectedPdfFile = null;
    currentSourceText = "";
    currentSourceKey = "";
    const overview = document.getElementById("missionOverview");
    if (overview) overview.hidden = true;
    renderMissionCards();
    renderMissionQuiz();
    updateMissionReadUi();
    updateTutorSourceSummary();
    updateSettingsStatus("Study mission and cached source cleared.", "blue");
  });
  document.getElementById("clearAllDataButton")?.addEventListener("click", async () => {
    // Wipe on-device learning data (activity/stars/cached packs). Keeps sign-in.
    activityCache = {};
    try { extensionApi?.storage?.local?.remove?.(activityStorageKey); } catch {}
    try { localStorage.removeItem(activityStorageKey); } catch {}
    currentStudyPack = null;
    selectedPdfFile = null;
    currentSourceText = "";
    currentSourceKey = "";
    renderMissionCards();
    renderMissionQuiz();
    updateMissionReadUi();
    renderStars();
    updateSettingsStatus("All on-device learning data cleared.", "blue");
  });
}

async function buildStudyPackFromActiveTab(settings, challenge = "Balanced", gradeBand = "6-8", context = null) {
  context = context || await getActiveTabContext();
  const result = await callOpenAIJson({
    settings,
    instructions: "You are KiddieGPT, a parent-safe study helper for grades K-8. Build study aids from active page text. Do not provide answer dumps. Return only valid JSON.",
    text: `Create a kid-facing study pack from this active tab for a grade ${gradeBand} student. Match the wording and difficulty to grade ${gradeBand}. Challenge level: ${challenge} (Less = simpler recall, Balanced = mix recall and understanding, More = a few harder why/how questions without going above grade level). Every quiz question and flashcard MUST come from this page's actual content, not general knowledge. Return JSON with keys: mainIdea string, keyTerms array of 6 short strings, rememberThis string, quiz array of 12 objects with question, choices array of 4 strings, answer string, flashcards array of 10 objects with term and meaning, readAloud string. Title: ${context.title}. URL: ${context.url}. Text: ${context.text}`
  });
  return normalizeStudyPack(result);
}

async function buildPdfWithOpenAI(file, settings, challenge = "Balanced", gradeBand = "6-8") {
  if (file.size > maxStudyFileBytes) throw new Error("Study file must be under 5 MB.");
  setPdfStatus("Reading study file...", "blue");
  const fileData = await readFileAsDataUrl(file);
  const studySourcePart = getOpenAIStudySourcePart(file, fileData);
  setPdfStatus("Sending study source to the tutor...", "blue");
  const result = await callOpenAIJson({
    settings,
    tool: "pdf",
    instructions: "You are KiddieGPT, a parent-safe study helper for grades K-8. Help the student learn from the uploaded study source. Do not provide answer dumps. Return only valid JSON.",
    text: `Create a kid-facing study pack from this uploaded study source for a grade ${gradeBand} student. Match the wording and difficulty to grade ${gradeBand}. Challenge level: ${challenge}. If challenge is Less, keep wording simpler and focus on recall. If Balanced, mix recall and understanding. If More, include a few harder why/how questions without going above grade level. It may be a PDF, text file, or image. If it is an image, read the visible text, diagrams, tables, and labels. Every quiz question and flashcard MUST come from this source's actual content, not general knowledge. Return JSON with keys: mainIdea string, keyTerms array of 6 short strings, rememberThis string, quiz array of 12 objects with question, choices array of 4 strings, answer string, flashcards array of 10 objects with term and meaning, readAloud string. Do not include parent summaries or parent notes. Filename: ${file.name}`,
    parts: [studySourcePart]
  });
  setPdfStatus("Turning the response into a study pack...", "blue");
  return normalizeStudyPack(result);
}

function extractOutputText(data) {
  if (data.output_text) return data.output_text;
  return (data.output || [])
    .flatMap(item => item.content || [])
    .map(content => content.text || "")
    .join("\n")
    .trim();
}

// Models emitting inline LaTeX sometimes write a lone backslash inside a JSON
// string ("\sqrt", "\times"), which is invalid JSON and breaks JSON.parse —
// failing the whole solve. Double any lone backslash before a letter (odd runs
// only, so already-escaped "\\frac" is untouched); leave valid \uXXXX alone.
function escapeLatexBackslashes(text) {
  return text.replace(/(\\+)([a-zA-Z])/g, (match, slashes, ch, offset, full) => {
    if (ch === "u" && /^[0-9a-fA-F]{4}/.test(full.slice(offset + slashes.length + 1))) return match;
    return (slashes.length % 2 === 0 ? slashes : slashes + "\\") + ch;
  });
}

function parseOpenAIJson(text) {
  const cleaned = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const slice = start >= 0 && end > start ? cleaned.slice(start, end + 1) : "";
  // Try as-is, then with the object slice, then each with LaTeX backslashes repaired.
  const candidates = [cleaned];
  if (slice) candidates.push(slice);
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* try next */ }
    try { return JSON.parse(escapeLatexBackslashes(candidate)); } catch { /* try next */ }
  }
  throw new Error("OpenAI returned text, but not a study-pack JSON object.");
}

function normalizeStudyPack(pack) {
  return {
    mainIdea: pack.mainIdea || "This source explains the main lesson and key vocabulary.",
    keyTerms: Array.isArray(pack.keyTerms) ? pack.keyTerms.slice(0, 8) : [],
    rememberThis: pack.rememberThis || "Review the big idea, then practice with a few questions.",
    quiz: Array.isArray(pack.quiz) ? pack.quiz.slice(0, 15) : [],
    flashcards: Array.isArray(pack.flashcards) ? pack.flashcards.slice(0, 12) : [],
    readAloud: pack.readAloud || "Read the mission slowly, then pause and say the main idea back."
  };
}


function renderPdfStudyPack(pack) {
  currentStudyPack = pack;
  showMissionFollowup();
  const remember = document.getElementById("missionReadRemember");
  if (remember) remember.textContent = pack.rememberThis || "";
  const terms = document.getElementById("missionReadTerms");
  if (terms) terms.innerHTML = (pack.keyTerms || []).map(term => `<span>${escapeHtml(term)}</span>`).join("");
  const counts = document.getElementById("missionReadCounts");
  if (counts) counts.innerHTML = `<span><b>${pack.quiz.length}</b> quiz</span><span><b>${pack.flashcards.length}</b> cards</span><span><b>1</b> read-aloud</span>`;
  const overview = document.getElementById("missionOverview");
  if (overview) overview.hidden = false;
  updateMissionReadUi();
}

function showMissionFollowup() {
  const block = document.getElementById("missionFollowupBlock");
  const panel = document.getElementById("missionFollowupPanel");
  const answer = document.getElementById("missionFollowupAnswer");
  const input = document.getElementById("missionFollowupInput");
  if (block) block.hidden = false;
  if (panel) panel.hidden = true;
  if (answer) answer.hidden = true;
  if (input) input.value = "";
}

function hideMissionFollowup() {
  const block = document.getElementById("missionFollowupBlock");
  const panel = document.getElementById("missionFollowupPanel");
  const answer = document.getElementById("missionFollowupAnswer");
  const input = document.getElementById("missionFollowupInput");
  if (block) block.hidden = true;
  if (panel) panel.hidden = true;
  if (answer) answer.hidden = true;
  if (input) input.value = "";
}

function useSampleScreenshot() {
  const sampleSvg = encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="720" height="420" viewBox="0 0 720 420">
      <rect width="720" height="420" fill="#fbfdf8"/>
      <rect x="42" y="42" width="636" height="336" rx="24" fill="#ffffff" stroke="#dbe7df" stroke-width="4"/>
      <text x="72" y="92" fill="#0b2d43" font-family="Arial" font-size="28" font-weight="700">Water Cycle Diagram</text>
      <circle cx="170" cy="175" r="54" fill="#dce96a"/>
      <path d="M310 244c44-66 116-66 160 0" fill="none" stroke="#0f8bf2" stroke-width="16" stroke-linecap="round"/>
      <path d="M484 150h84l-28-28" fill="none" stroke="#004f48" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M484 150h84l-28 28" fill="none" stroke="#004f48" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="96" y="272" fill="#29495b" font-family="Arial" font-size="22" font-weight="700">evaporation</text>
      <text x="304" y="288" fill="#29495b" font-family="Arial" font-size="22" font-weight="700">condensation</text>
      <text x="500" y="220" fill="#29495b" font-family="Arial" font-size="22" font-weight="700">precipitation</text>
    </svg>
  `);
  renderScreenshot(`data:image/svg+xml;charset=utf-8,${sampleSvg}`);
}

function updateMathCaptureCard(state, detail = "") {
  const card = document.querySelector(".math-capture-box");
  if (!card) return;
  const isCaptured = state === "captured" || state === "full";
  card.classList.toggle("captured", isCaptured);
  card.classList.toggle("selecting", state === "selecting");
  card.classList.toggle("unavailable", state === "unavailable");
  const title = {
    selecting: "Drag around the math problem",
    captured: "Math problem captured",
    full: "Page captured for math",
    unavailable: "Open KiddieGPT as an extension",
    ready: "Capture the problem on this page"
  }[state] || "Capture the problem on this page";
  const meta = detail || {
    selecting: "A selection box is open on the active tab.",
    captured: "Now click Solve & Explain to see the tutor view.",
    full: "Chrome blocked area select, so KiddieGPT captured the visible page instead.",
    unavailable: "Browser area capture works from the installed Chrome extension.",
    ready: "Click, then drag around the problem on the page."
  }[state] || "";
  const icon = isCaptured ? "✓" : state === "unavailable" ? "!" : "▧";
  const thumb = isCaptured && selectedMathCapture
    ? `<img class="math-capture-thumb" src="${selectedMathCapture}" alt="Captured math problem">`
    : "";
  card.innerHTML = `
    <span class="math-capture-icon">${icon}</span>
    <div class="math-capture-text">
      <b>${escapeHtml(title)}</b>
      <small>${escapeHtml(meta)}</small>
      ${isCaptured ? `<span class="math-capture-tag">Ready — click to recapture</span>` : ""}
    </div>
    ${thumb}
  `;
}

function injectMathSelectionOverlay() {
  if (document.getElementById("kiddiegpt-math-capture-overlay")) return;
  const overlay = document.createElement("div");
  overlay.id = "kiddiegpt-math-capture-overlay";
  overlay.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:2147483647",
    "cursor:crosshair",
    "background:rgba(0,79,72,.12)",
    "font-family:Inter,Arial,sans-serif"
  ].join(";");
  const hint = document.createElement("div");
  hint.textContent = "Drag around the math problem. Press Esc to cancel.";
  hint.style.cssText = [
    "position:fixed",
    "top:16px",
    "left:50%",
    "transform:translateX(-50%)",
    "background:#004f48",
    "color:#fff",
    "border-radius:999px",
    "padding:10px 14px",
    "font-size:13px",
    "font-weight:800",
    "box-shadow:0 12px 30px rgba(0,0,0,.18)"
  ].join(";");
  const box = document.createElement("div");
  box.style.cssText = [
    "position:fixed",
    "display:none",
    "border:2px solid #dce96a",
    "background:rgba(220,233,106,.16)",
    "box-shadow:0 0 0 9999px rgba(0,0,0,.28)",
    "border-radius:8px"
  ].join(";");
  overlay.append(hint, box);
  document.documentElement.appendChild(overlay);

  let startX = 0;
  let startY = 0;
  let dragging = false;
  const cleanup = () => {
    document.removeEventListener("keydown", onKeydown, true);
    overlay.remove();
  };
  const draw = (event) => {
    const left = Math.min(startX, event.clientX);
    const top = Math.min(startY, event.clientY);
    const width = Math.abs(event.clientX - startX);
    const height = Math.abs(event.clientY - startY);
    box.style.display = "block";
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${width}px`;
    box.style.height = `${height}px`;
  };
  const onKeydown = (event) => {
    if (event.key === "Escape") cleanup();
  };
  overlay.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    draw(event);
    overlay.setPointerCapture(event.pointerId);
  });
  overlay.addEventListener("pointermove", event => {
    if (dragging) draw(event);
  });
  overlay.addEventListener("pointerup", event => {
    if (!dragging) return;
    dragging = false;
    const rect = {
      x: Math.min(startX, event.clientX),
      y: Math.min(startY, event.clientY),
      width: Math.abs(event.clientX - startX),
      height: Math.abs(event.clientY - startY),
      devicePixelRatio: window.devicePixelRatio || 1
    };
    cleanup();
    if (rect.width < 12 || rect.height < 12) return;
    chrome.runtime.sendMessage({ type: "KIDDIEGPT_MATH_REGION_SELECTED", rect });
  });
  document.addEventListener("keydown", onKeydown, true);
}

function cropDataUrl(dataUrl, rect) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const scale = rect.devicePixelRatio || 1;
      const sx = Math.max(0, Math.round(rect.x * scale));
      const sy = Math.max(0, Math.round(rect.y * scale));
      const sw = Math.max(1, Math.round(rect.width * scale));
      const sh = Math.max(1, Math.round(rect.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = Math.min(sw, image.width - sx);
      canvas.height = Math.min(sh, image.height - sy);
      const context = canvas.getContext("2d");
      context.drawImage(image, sx, sy, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/png"));
    };
    image.onerror = () => reject(new Error("Could not read captured screenshot."));
    image.src = dataUrl;
  });
}

async function captureMathProblemRegion() {
  selectedMathFile = null;
  if (!extensionApi?.tabs?.query || !extensionApi?.scripting?.executeScript) {
    selectedMathCapture = null;
    captureMathVisibleTabFallback("Capturing the visible page instead...");
    return;
  }
  updateMathCaptureCard("selecting");
  extensionApi.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs?.[0];
    if (!tab?.id) {
      captureMathVisibleTabFallback("Capturing the visible page instead...");
      return;
    }
    extensionApi.scripting.executeScript({
      target: { tabId: tab.id },
      func: injectMathSelectionOverlay
    }, () => {
      if (extensionApi.runtime.lastError) {
        captureMathVisibleTabFallback("Chrome blocked area select, so KiddieGPT is capturing the visible page.");
      }
    });
  });
}

function captureMathVisibleTabFallback(message = "Capturing the visible page for math...") {
  selectedMathFile = null;
  if (!extensionApi?.tabs?.captureVisibleTab) {
    updateMathCaptureCard("unavailable", "Capture is available after installing KiddieGPT as a Chrome extension.");
    return;
  }
  updateMathCaptureCard("selecting", message);
  extensionApi.tabs.captureVisibleTab({ format: "png" }, dataUrl => {
    if (extensionApi.runtime.lastError || !dataUrl) {
      selectedMathCapture = null;
      updateMathCaptureCard("unavailable", "Chrome blocked this page. Try a normal webpage or upload the worksheet.");
      return;
    }
    selectedMathCapture = dataUrl;
    updateMathCaptureCard("full", "Visible page saved. Click Solve & Explain when ready.");
  });
}

function finishMathRegionCapture(rect) {
  selectedMathFile = null;
  if (!extensionApi?.tabs?.captureVisibleTab) {
    updateMathCaptureCard("unavailable");
    return;
  }
  updateMathCaptureCard("selecting", "Saving the selected math area...");
  extensionApi.tabs.captureVisibleTab({ format: "png" }, async dataUrl => {
    if (extensionApi.runtime.lastError || !dataUrl) {
      updateMathCaptureCard("unavailable", "Could not capture this tab. Try uploading a file.");
      return;
    }
    try {
      selectedMathCapture = await cropDataUrl(dataUrl, rect);
      updateMathCaptureCard("captured", "Selected area saved. Click Solve & Explain when ready.");
    } catch {
      updateMathCaptureCard("unavailable", "Could not crop the selected area. Try again.");
    }
  });
}

function captureVisibleTab() {
  showPanel("screenshot");
  setToolSource("explain", "screenshot");
  setScreenshotStatus("Capturing", "blue");

  if (!extensionApi?.tabs?.captureVisibleTab) {
    setScreenshotStatus("Unavailable", "warn");
    useSampleScreenshot();
    return;
  }

  extensionApi.tabs.captureVisibleTab({ format: "png" }, dataUrl => {
    if (extensionApi.runtime.lastError || !dataUrl) {
      setScreenshotStatus("Use sample", "warn");
      useSampleScreenshot();
      return;
    }
    renderScreenshot(dataUrl);
  });
}

document.addEventListener("click", event => {
  if (event.target.closest("[data-reveal-all]")) {
    mathAnswersRevealed = true;
    renderMathSolution();
    return;
  }
  if (event.target.closest("[data-hide-all]")) {
    mathAnswersRevealed = false;
    mathPinPromptOpen = false;
    renderMathSolution();
    return;
  }
  if (event.target.closest("[data-reveal-prompt]")) {
    mathPinPromptOpen = true;
    renderMathSolution();
    document.getElementById("mathRevealPin")?.focus();
    return;
  }
  if (event.target.closest("[data-reveal-unlock]")) {
    unlockMathReveal();
    return;
  }
  const forgot = event.target.closest("[data-pin-forgot]");
  if (forgot) {
    startPinReset(forgot.dataset.pinForgot);
    return;
  }
  if (event.target.closest("[data-pin-reset-verify]")) {
    verifyPinReset();
    return;
  }
  if (event.target.closest("[data-pin-reset-save]")) {
    completePinReset();
    return;
  }
  if (event.target.closest("[data-pin-reset-cancel]")) {
    resetPinResetState();
    rerenderPinResetSurfaces();
    return;
  }

  const target = event.target.closest("[data-view]");
  if (target) showPanel(target.dataset.view);

  const tool = event.target.closest("[data-tool]");
  if (tool) selectTool(tool.dataset.tool);

  const missionStep = event.target.closest("[data-mission-step]");
  if (missionStep) showMissionStep(missionStep.dataset.missionStep);

  const openMissionStep = event.target.closest("[data-open-mission-step]");
  if (openMissionStep) {
    showPanel("pdf");
    showMissionStep(openMissionStep.dataset.openMissionStep);
  }

  const launch = event.target.closest("[data-launch]");
  if (launch) showPanel(launch.dataset.launch);

  const gradeTab = event.target.closest(".grade-tabs button");
  if (gradeTab) setGrade(gradeTab);
  const preferenceTab = event.target.closest("[data-preference-group] button");
  if (preferenceTab) setPreferenceTab(preferenceTab);

  const sourceButton = event.target.closest("[data-source-group] [data-source-option]");
  if (sourceButton) {
    const group = sourceButton.closest("[data-source-group]");
    setToolSource(group.dataset.sourceGroup, sourceButton.dataset.sourceOption);
  }

  const action = event.target.closest("[data-action]");
  if (action?.dataset.action === "math-capture-region") captureMathProblemRegion();
  if (action?.dataset.action === "capture-screenshot") captureVisibleTab();
  if (action?.dataset.action === "mock-screenshot") useSampleScreenshot();

  if (event.target.closest("#pdfChooseButton")) event.preventDefault();
  if (event.target.closest("#pdfBuildButton")) event.preventDefault();
  if (event.target.closest("#saveSettingsButton")) event.preventDefault();
  if (event.target.closest("#clearOpenAIButton")) event.preventDefault();
  if (event.target.closest("#testOpenAIButton")) event.preventDefault();
  if (event.target.closest("#clearGeneratedAudioButton")) event.preventDefault();
  if (event.target.closest("#clearStudyCacheButton")) event.preventDefault();
});

extensionApi?.runtime?.onMessage?.addListener((message) => {
  if (message?.type === "KIDDIEGPT_MATH_REGION_SELECTED" && message.rect) {
    finishMathRegionCapture(message.rect);
  }
});

loadActivity().then(activity => {
  activityCache = activity;
  renderActivityDashboard();
});
loadStars();

initPdfTool();
initCardsTool();
initMathTool();
initExplainTool();
initTutorMode();
initMissionFollowup();
initWritingStudio();
initSettingsTool();

// Check parent sign-in + entitlement, and show the gate if needed.
bootstrapPortal();

globalThis.kiddieGPTDemo = {
  buildPdfStudyPack,
  choosePdfFile,
  renderPdfStudyPack
};

getSettings().then(data => {
  showPanel(data.activeView || "dashboard");
  if (data.gradeBand) {
    document.querySelectorAll(".grade-tabs button").forEach(button => {
      button.classList.toggle("active", button.textContent.trim() === data.gradeBand);
    });
  }
  document.querySelectorAll("[data-preference-group]").forEach(group => {
    const value = data[group.dataset.preferenceGroup];
    if (!value) return;
    group.querySelectorAll("button").forEach(button => {
      button.classList.toggle("active", (button.dataset.preferenceValue || button.textContent.trim()) === value);
    });
  });
  setToolSource("pdf", data.pdfSource || "file");
  setToolSource("read", data.readSource || data.pdfSource || "file");
  if (data.tutorMode) setTutorMode(data.tutorMode);
  if (data.tutorPlaybackRate) {
    tutorPlaybackRate = data.tutorPlaybackRate;
    const speed = document.getElementById("tutorSpeed");
    if (speed) speed.textContent = `Speed ${tutorPlaybackRate}×`;
  }
  mathAnswerGate = data.mathAnswerGate !== false;
  mathParentPinHash = data.mathParentPin || "";
  const gateToggle = document.getElementById("mathAnswerGateToggle");
  if (gateToggle) gateToggle.checked = mathAnswerGate;
  renderParentPinArea();
  if (typeof data.mathShowNotes === "boolean") {
    mathShowNotes = data.mathShowNotes;
  }
  renderMathSolution();
  loadSettingsForm();
});
