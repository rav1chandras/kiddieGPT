/*
 * KiddieGPT — Tutor voice pipeline (pure helpers).
 *
 * This module holds the DEPENDENCY-FREE, deterministic core of the Tutor voice
 * pipeline (Explain Aloud + Read Aloud): source normalization, semantic
 * chunking, cache-key derivation, admin-driven word targets/model resolution,
 * the lesson prompt, transcript validation, request identity, and an injectable
 * sequential audio queue.
 *
 * It runs unchanged in the extension (attached to globalThis) and in Node for
 * tests (module.exports). It touches NO DOM and NO chrome.* APIs — the browser
 * orchestration (IndexedDB, fetch, playback wiring, telemetry) lives in
 * sidepanel.js. Keep it that way so the logic below stays unit-testable.
 */
(function (root) {
  "use strict";

  // ---- Version constants (change one -> only its cache invalidates) ----------
  // NOTE: In PRODUCTION the audio cache key uses the backend's speechStyleVersion
  // (portalSession.speechStyleVersion) and the transcript cache key uses the
  // backend's tutorConfigVersion, so client and server agree. TUTOR_VERSIONS.speechStyle
  // is only the fallback/mirror for the TEST-MODE direct-to-OpenAI path.
  const TUTOR_VERSIONS = { preprocessing: "v1", lessonPrompt: "v2", segmentation: "v2", speechStyle: "v2" };

  // ---- Grade bands & admin-driven defaults -----------------------------------
  const GRADE_BANDS = ["K-2", "3-5", "6-8", "9-12"];
  // Per-band DEEP DIVE max words (also the hard ceiling). Standard mode is a
  // fraction of this. Fallbacks used only when the session omits the values.
  const DEFAULT_EXPLAIN_MAX_WORDS = {
    "K-2": 160,
    "3-5": 400,
    "6-8": 700,
    "9-12": 1000
  };
  const DEFAULT_STANDARD_FRACTION = 0.5;                  // Standard = 50% of the band's Deep Dive max
  const DEFAULT_DEEP_DIVE_BANDS = ["3-5", "6-8", "9-12"]; // K-2 is always Standard (no Deep Dive)
  const DEFAULT_SPEECH_MODEL = "gpt-4o-mini-tts";
  const DEFAULT_WORDS_PER_MINUTE = 130;                   // spoken pace (duration estimates only)
  const TTS_SAFE_CHAR_LIMIT = 4000;                       // stay under OpenAI's ~4096-char TTS limit

  // Grade-shaped tone / sentence complexity passed to the lesson model as config
  // (small hints, NOT large inline prompt blocks).
  const TONE_BY_BAND = {
    "K-2": "playful and gentle",
    "3-5": "friendly and encouraging",
    "6-8": "clear and supportive",
    "9-12": "concise and respectful, not childish"
  };
  const COMPLEXITY_BY_BAND = {
    "K-2": "very short simple sentences",
    "3-5": "short sentences, everyday words",
    "6-8": "medium sentences, define new terms",
    "9-12": "varied sentences, precise vocabulary"
  };

  // Local mirror of the server-owned spoken styles, used ONLY on the test-mode
  // direct-to-OpenAI path. Production speech style is resolved server-side from
  // mode + gradeBand; the extension only sends mode + gradeBand.
  const SPEECH_STYLES = {
    read: {
      "K-2": "Read slowly and warmly like a kind kindergarten teacher. Short gentle phrases, clear pauses.",
      "3-5": "Read clearly and warmly at an easy pace, like a friendly elementary teacher.",
      "6-8": "Read clearly and steadily like a calm, supportive middle-school tutor.",
      "9-12": "Read clearly and evenly like a knowledgeable high-school teacher. Natural, not childish."
    },
    explain: {
      "K-2": "Speak like a playful, patient kindergarten teacher. Very simple, cheerful, lots of gentle pauses.",
      "3-5": "Speak like an encouraging elementary teacher. Simple, warm, concrete examples.",
      "6-8": "Speak like a calm, supportive middle-school tutor. Clear, steady, warm but not childish.",
      "9-12": "Speak like a knowledgeable high-school teacher, concise, don't over-simplify or sound childish."
    }
  };

  function normalizeBand(band) {
    const b = String(band || "").trim();
    return GRADE_BANDS.includes(b) ? b : "6-8";
  }

  function speechStyleFor(mode, band) {
    const table = SPEECH_STYLES[mode === "explain" ? "explain" : "read"];
    return table[normalizeBand(band)] || table["6-8"];
  }

  // ---- Admin-driven resolvers ------------------------------------------------
  // Speech model: (1) portal session, (2) local dev override, (3) hard default.
  // Never hardcode the model into the production request — production uses the
  // backend's model; this only feeds the test-mode call and audio cache keys.
  function resolveSpeechModel(session, local) {
    const fromSession = session && typeof session.ttsModel === "string" ? session.ttsModel.trim() : "";
    const fromLocal = local && typeof local.ttsModel === "string" ? local.ttsModel.trim() : "";
    return fromSession || fromLocal || DEFAULT_SPEECH_MODEL;
  }

  // Per-band DEEP DIVE max words (also the hard ceiling): session value else fallback.
  function resolveDeepDiveMaxWords(session, band) {
    const b = normalizeBand(band);
    const table = session && session.tutorExplainMaxWords;
    const n = table && Number(table[b]);
    return (Number.isFinite(n) && n > 0) ? Math.round(n) : DEFAULT_EXPLAIN_MAX_WORDS[b];
  }

  // Standard mode is this fraction of the band's Deep Dive max (clamped 0.3..0.9).
  function resolveStandardFraction(session) {
    const f = session && Number(session.tutorStandardFraction);
    if (!Number.isFinite(f)) return DEFAULT_STANDARD_FRACTION;
    return Math.min(0.9, Math.max(0.3, f));
  }

  // Bands where Deep Dive is offered (K-2 excluded by default).
  function resolveDeepDiveBands(session) {
    const list = session && Array.isArray(session.deepDiveBands) ? session.deepDiveBands : null;
    const filtered = (list || []).filter(b => GRADE_BANDS.includes(b));
    return filtered.length ? filtered : DEFAULT_DEEP_DIVE_BANDS.slice();
  }

  function deepDiveAvailable(session, band) {
    return resolveDeepDiveBands(session).includes(normalizeBand(band));
  }

  // Normalize a requested depth against band eligibility ("deep" only where allowed).
  function resolveExplainDepth(session, band, requested) {
    return (requested === "deep" && deepDiveAvailable(session, band)) ? "deep" : "standard";
  }

  // Effective hard word cap for a lesson given band + depth. Deep Dive (only for
  // deep-dive bands) = full band max; Standard (and all K-2) = fraction of the max.
  function effectiveExplainMaxWords(session, band, depth) {
    const b = normalizeBand(band);
    const bandMax = resolveDeepDiveMaxWords(session, b);
    const isDeep = depth === "deep" && deepDiveAvailable(session, b);
    return isDeep ? bandMax : Math.round(bandMax * resolveStandardFraction(session));
  }

  function resolveWordsPerMinute(session) {
    const n = session && Number(session.wordsPerMinute);
    return (Number.isFinite(n) && n > 0) ? n : DEFAULT_WORDS_PER_MINUTE;
  }

  // ---- Playback speed dropdown (item 21) -------------------------------------
  const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  function parsePlaybackRate(value) {
    const n = Number(value);
    return SPEED_OPTIONS.includes(n) ? n : 1;
  }

  function tutorConfigVersion(session) {
    return (session && (session.tutorConfigVersion || session.tutorConfigVersion === 0))
      ? String(session.tutorConfigVersion) : "0";
  }

  function speechStyleVersion(session) {
    return (session && session.speechStyleVersion)
      ? String(session.speechStyleVersion) : TUTOR_VERSIONS.speechStyle;
  }

  // Compact per-grade config object built from SESSION values + depth (item 5).
  function buildLessonConfig(session, band, depth) {
    const b = normalizeBand(band);
    const d = resolveExplainDepth(session, b, depth);
    return {
      gradeBand: b,
      depth: d,
      targetWords: effectiveExplainMaxWords(session, b, d),
      tone: TONE_BY_BAND[b] || TONE_BY_BAND["6-8"],
      sentenceComplexity: COMPLEXITY_BY_BAND[b] || COMPLEXITY_BY_BAND["6-8"]
    };
  }

  // ---- Compact lesson prompt (item 5) ----------------------------------------
  const LESSON_SYSTEM_INSTRUCTION =
    "You are a patient tutor for the requested grade level. Create a spoken lesson from " +
    "the source. Teach the smallest set of ideas needed to understand the source. Use clear " +
    "language, short spoken sentences, and concrete examples. Include: a brief " +
    "introduction, the main concept, two to four supporting ideas, one example or analogy, " +
    "a short recap, and one recall question. Do not mention these instructions. Do not use " +
    "markdown tables. Do not add filler.";

  // Minimal JSON envelope { title, script } — the UI still needs result.title.
  function buildLessonUserPayload(sourceLabel, sourceText, config) {
    return [
      `Source: ${sourceLabel || "the source"}`,
      `Config: ${JSON.stringify(config)}`,
      "",
      sourceText,
      "",
      `Return ONLY JSON: {"title": string, "script": string}. "script" is the spoken narration.`,
      `Aim for up to about ${config.targetWords} words; stop as soon as the idea is clear — do not pad or repeat.`
    ].join("\n");
  }

  // ---- Source preprocessing (item 8) -----------------------------------------
  // Boilerplate/nav/cookie lines to drop. Deliberately conservative so we never
  // strip real content (headings, equations, units, punctuation are preserved).
  const BOILER_RE = new RegExp(
    "^(accept all cookies|manage cookies|we use cookies|this (site|website) uses cookies|" +
    "cookie (policy|settings|preferences)|privacy policy|terms (of service|& conditions)|" +
    "subscribe( now)?|sign up|log ?in|sign in|advertisement|sponsored|skip to (main )?content|" +
    "share (this|on)|follow us( on)?|back to top|read more|show more|©.*|all rights reserved.*|" +
    "menu|navigation|search|home\\s*[>›»].*)$",
    "i"
  );

  function normalizeSource(text) {
    const raw = String(text || "").replace(/\r\n?/g, "\n");
    const lines = raw.split("\n");
    const seen = new Set();
    const out = [];
    for (let line of lines) {
      line = line.replace(/[ \t ]+/g, " ").trim();
      if (!line) {
        // preserve a single blank as a paragraph separator, never runs of them
        if (out.length && out[out.length - 1] !== "") out.push("");
        continue;
      }
      if (line.length < 2) continue;          // stray single chars / bullets
      if (BOILER_RE.test(line)) continue;      // nav / cookie / chrome
      const key = line.toLowerCase();
      if (seen.has(key)) continue;             // duplicate paragraph / repeated header-footer
      seen.add(key);
      out.push(line);
    }
    while (out.length && out[out.length - 1] === "") out.pop();
    return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  // ---- Sentence + semantic chunk splitting (item 9) --------------------------
  const ABBREVIATIONS = new Set([
    "mr", "mrs", "ms", "dr", "st", "vs", "etc", "e.g", "i.e", "fig", "eq", "no",
    "approx", "al", "jr", "sr", "prof", "dept", "vol", "pp", "cf", "ca", "inc", "ltd"
  ]);

  // Abbreviation-aware, deterministic sentence splitter. Does NOT split after a
  // known abbreviation, between a number and the following word, or where the
  // next visible character is lowercase (mid-sentence period).
  function splitSentences(text) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    if (!clean) return [];
    const result = [];
    let start = 0;
    for (let i = 0; i < clean.length; i += 1) {
      const ch = clean[i];
      if (ch !== "." && ch !== "!" && ch !== "?") continue;
      let j = i + 1;
      while (j < clean.length && "\"')]}".includes(clean[j])) j += 1; // trailing quotes/brackets
      const atEnd = j >= clean.length;
      if (!atEnd && clean[j] !== " ") continue;            // e.g. decimals "3.14" -> no space
      if (ch === ".") {
        const before = clean.slice(start, i);
        const lastWord = (before.match(/([A-Za-z.]+)$/) || [])[1] || "";
        const lw = lastWord.replace(/\.+$/, "").toLowerCase();
        const isAbbrev = ABBREVIATIONS.has(lw) || /^[A-Za-z]$/.test(lastWord); // "e.g", single initial
        const afterSpace = clean[j + 1];
        const nextLower = afterSpace && /[a-z]/.test(afterSpace);
        if (isAbbrev || nextLower) continue;               // keep as one sentence
      }
      result.push(clean.slice(start, j).trim());
      start = j + 1;
      i = j;
    }
    if (start < clean.length) {
      const tail = clean.slice(start).trim();
      if (tail) result.push(tail);
    }
    return result.filter(Boolean);
  }

  // Stable semantic chunking. Prefers paragraph boundaries, then sentence
  // boundaries; never splits mid-sentence unless a single sentence exceeds the
  // hard limit; aims for ~min..max chars. Deterministic: same text -> same chunks.
  function semanticChunk(text, options) {
    const opts = options || {};
    const min = opts.min || 300;
    const max = opts.max || 700;
    const hard = opts.hardLimit || TTS_SAFE_CHAR_LIMIT;
    const paragraphs = normalizeSource(text).split(/\n+/).map(p => p.trim()).filter(Boolean);
    const chunks = [];
    let buf = "";
    const flush = () => { const t = buf.trim(); if (t) chunks.push(t); buf = ""; };
    const addPiece = (piece, joiner) => {
      if (!buf) buf = piece;
      else if ((buf.length + joiner.length + piece.length) <= max) buf += joiner + piece;
      else { flush(); buf = piece; }
      if (buf.length >= min) flush();
    };
    for (const para of paragraphs) {
      if (para.length <= max) { addPiece(para, "\n"); continue; }
      flush(); // don't glue a giant paragraph onto a pending buffer
      for (const sentence of splitSentences(para)) {
        if (sentence.length > hard) {
          flush();
          for (let k = 0; k < sentence.length; k += hard) {
            const slice = sentence.slice(k, k + hard).trim();
            if (slice) chunks.push(slice);
          }
          continue;
        }
        addPiece(sentence, " ");
      }
      flush();
    }
    flush();
    if (chunks.length) return chunks;
    const fallback = String(text || "").trim();
    return fallback ? [fallback.slice(0, hard)] : [];
  }

  // ---- Hashing & cache keys (items 5, 6, 11, 15) -----------------------------
  const KEY_SEP = "";

  function getSubtle() {
    const c = (typeof crypto !== "undefined" && crypto.subtle) ? crypto
      : (root && root.crypto && root.crypto.subtle) ? root.crypto : null;
    if (!c) throw new Error("SubtleCrypto unavailable");
    return c.subtle;
  }

  async function sha256Hex(value) {
    const bytes = new TextEncoder().encode(String(value));
    const digest = await getSubtle().digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  // tutor-transcript:{sourceHash}:{band}:{mode}:{depth}:{promptVersion}:{model}:{cfgVer}
  // (mode + depth are included so Read/Explain and Standard/Deep never collide.)
  async function transcriptCacheKey(parts) {
    const band = normalizeBand(parts.gradeBand);
    const depth = parts.explainDepth === "deep" ? "deep" : "standard";
    const fields = [
      parts.normalizedSourceText, band, parts.tutorMode, depth,
      parts.lessonPromptVersion, parts.lessonModel, parts.tutorConfigVersion
    ];
    const sourceHash = await sha256Hex(fields.join(KEY_SEP));
    return `tutor-transcript:${sourceHash}:${band}:${parts.tutorMode}:${depth}:${parts.lessonPromptVersion}:${parts.lessonModel}:${parts.tutorConfigVersion}`;
  }

  // tutor-audio:{transcriptHash}:{voice}:{speechModel}:{styleVersion}:{format}
  async function audioCacheKey(parts) {
    const fields = [
      parts.normalizedTranscript, parts.voice, parts.speechModel,
      parts.speechStyleVersion, parts.audioFormat
    ];
    const hash = await sha256Hex(fields.join(KEY_SEP));
    return `tutor-audio:${hash}:${parts.voice}:${parts.speechModel}:${parts.speechStyleVersion}:${parts.audioFormat}`;
  }

  // tutor-seg:{chunkHash}:{voice}:{speechModel}:{styleVersion}:{format}
  async function segmentCacheKey(parts) {
    const fields = [
      parts.normalizedChunkText, parts.voice, parts.speechModel,
      parts.speechStyleVersion, parts.audioFormat
    ];
    const hash = await sha256Hex(fields.join(KEY_SEP));
    return `tutor-seg:${hash}:${parts.voice}:${parts.speechModel}:${parts.speechStyleVersion}:${parts.audioFormat}`;
  }

  // Duplicate-request identity (item 16).
  async function requestIdentity(parts) {
    const sourceHash = await sha256Hex(String(parts.normalizedSourceText || ""));
    const depth = parts.explainDepth === "deep" ? "deep" : "standard";
    return [
      parts.mode, sourceHash, normalizeBand(parts.gradeBand), depth, parts.voice,
      parts.lessonPromptVersion, parts.speechStyleVersion, parts.tutorConfigVersion
    ].join(":");
  }

  // ---- Transcript trimming & validation (items 3, 17) ------------------------
  function countWords(text) {
    return String(text || "").trim().split(/\s+/).filter(Boolean).length;
  }

  // Trim to the word ceiling at a sentence boundary (never mid-sentence).
  function trimToWordCeiling(text, maxWords) {
    if (!maxWords || maxWords <= 0) return String(text || "").trim();
    const sentences = splitSentences(text);
    if (!sentences.length) return String(text || "").trim();
    const kept = [];
    let count = 0;
    for (const sentence of sentences) {
      const w = countWords(sentence);
      if (count + w > maxWords && kept.length) break;
      kept.push(sentence);
      count += w;
    }
    return kept.join(" ").trim() || String(text || "").trim();
  }

  const LEAK_RE = /(you are a patient tutor|return only json|return only valid json|do not mention these instructions|do not add filler|do not use markdown|sentencecomplexity|targetwordrange|"script"\s*:|as an ai language model|system prompt)/i;

  // Deterministic pre-TTS quality gate (item 18). Returns { ok, words, problems }.
  // `problems` lists material issues that justify ONE regeneration. `targetWords`
  // is the effective cap (depth-aware); over-cap is not a regen trigger — the
  // caller trims to it — but a near-empty lesson is.
  function validateTranscript(transcript, targetWords) {
    const t = String(transcript || "");
    const trimmed = t.trim();
    const words = countWords(trimmed);
    const cap = Number(targetWords) || 0;
    const problems = [];

    if (!trimmed) problems.push("empty");
    // markdown table: a pipe row plus a separator row of dashes
    if (/\|.*\|/.test(t) && /\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?/.test(t)) problems.push("markdown_table");
    if (LEAK_RE.test(t)) problems.push("leaked_instructions");
    if (!/\?/.test(t)) problems.push("no_recall_question");

    // repeated paragraphs / sentences
    const paras = trimmed.split(/\n+/).map(p => p.replace(/\s+/g, " ").trim().toLowerCase()).filter(p => p.length > 12);
    if (new Set(paras).size < paras.length) problems.push("repeated_paragraphs");

    // mostly nav/boilerplate
    const contentLines = trimmed.split(/\n+/).map(l => l.trim()).filter(Boolean);
    if (contentLines.length >= 4) {
      const boiler = contentLines.filter(l => BOILER_RE.test(l)).length;
      if (boiler / contentLines.length > 0.5) problems.push("mostly_boilerplate");
    }

    // materially empty: a real lesson has more than a sentence or two.
    if (trimmed && words < 15) problems.push("too_short");
    // near/within the cap is informational; over-cap is handled by trimming.
    const withinCap = cap ? words <= Math.round(cap * 1.15) : true;

    return { ok: problems.length === 0, words, withinCap, problems };
  }

  // ---- Injectable sequential audio queue (items 10, 12) ----------------------
  // Plays an ordered segment list through ONE audio element, advancing on
  // 'ended'. The audio element, URL factory, and callbacks are injected so this
  // is unit-testable in Node with a fake element. It never builds a single
  // concatenated MP3.
  class TutorAudioQueue {
    constructor(deps) {
      const d = deps || {};
      this.audio = d.audio || null;
      this.createUrl = d.createUrl || (blob => blob);      // URL.createObjectURL in browser
      this.revokeUrl = d.revokeUrl || (() => {});           // URL.revokeObjectURL in browser
      this.onSegmentChange = d.onSegmentChange || (() => {});
      this.onEnded = d.onEnded || (() => {});
      this.onPlayStateChange = d.onPlayStateChange || (() => {});
      this.segments = [];        // [{ id, text, url, durationMs }]
      this._index = -1;
      this._playing = false;
      this._finished = false;
      this._destroyed = false;
      this._onEndedBound = () => this._handleEnded();
      if (this.audio && this.audio.addEventListener) {
        this.audio.addEventListener("ended", this._onEndedBound);
      }
    }

    get index() { return this._index; }
    get length() { return this.segments.length; }
    get playing() { return this._playing; }

    // segments: [{ id, text, blob | url, durationMs? }]
    load(segments) {
      this._releaseUrls();
      this.segments = (segments || []).map((seg, i) => ({
        id: seg.id != null ? seg.id : i,
        text: seg.text || "",
        url: seg.url != null ? seg.url : (seg.blob != null ? this.createUrl(seg.blob) : null),
        durationMs: Number(seg.durationMs) || 0
      }));
      this._index = -1;
      this._finished = false;
      return this;
    }

    totalDurationMs() {
      return this.segments.reduce((sum, s) => sum + (s.durationMs || 0), 0);
    }

    _setIndex(i) {
      if (i === this._index) return;
      this._index = i;
      this.onSegmentChange(i, this.segments[i] || null);
    }

    _loadCurrent() {
      const seg = this.segments[this._index];
      if (!seg || !this.audio) return;
      this.audio.src = seg.url;
      if (typeof this.audio.load === "function") this.audio.load();
    }

    async _playCurrent() {
      this._loadCurrent();
      if (this.audio && typeof this.audio.play === "function") {
        try { await this.audio.play(); } catch (_) { /* autoplay/abort */ }
      }
      this._setPlaying(true);
    }

    _setPlaying(v) {
      if (this._playing === v) return;
      this._playing = v;
      this.onPlayStateChange(v);
    }

    async play() {
      if (this._destroyed || !this.segments.length) return;
      // Replay from the top if the lesson already finished.
      if (this._finished || this._index < 0) { this._finished = false; this._setIndex(0); }
      await this._playCurrent();
    }

    pause() {
      if (this.audio && typeof this.audio.pause === "function") this.audio.pause();
      this._setPlaying(false);
    }

    async resume() {
      if (this._destroyed || this._index < 0 || this._finished) return this.play();
      if (this.audio && typeof this.audio.play === "function") {
        try { await this.audio.play(); } catch (_) {}
      }
      this._setPlaying(true);
    }

    stop() {
      this.pause();
      if (this.audio) { try { this.audio.currentTime = 0; } catch (_) {} }
      this._setIndex(this.segments.length ? 0 : -1);
    }

    async next() {
      if (this._index + 1 >= this.segments.length) { this._finish(); return; }
      this._finished = false;
      this._setIndex(this._index + 1);
      await this._playCurrent();
    }

    async restartCurrent() {
      if (this._index < 0) return;
      this._finished = false;
      if (this.audio) { try { this.audio.currentTime = 0; } catch (_) {} }
      await this._playCurrent();
    }

    async seekToSegment(i) {
      if (i < 0 || i >= this.segments.length) return;
      this._finished = false;
      this._setIndex(i);
      await this._playCurrent();
    }

    _handleEnded() {
      if (this._destroyed) return;
      if (this._index + 1 < this.segments.length) { this.next(); }
      else { this._finish(); }
    }

    _finish() {
      this._finished = true;
      this._setPlaying(false);
      this.onEnded();
    }

    _releaseUrls() {
      for (const seg of this.segments) {
        if (seg && seg.url != null) { try { this.revokeUrl(seg.url); } catch (_) {} }
      }
    }

    // Cancel + free everything (item 16 cleanup).
    destroy() {
      this._destroyed = true;
      this.pause();
      if (this.audio && this.audio.removeEventListener) {
        this.audio.removeEventListener("ended", this._onEndedBound);
      }
      this._releaseUrls();
      this.segments = [];
      this._index = -1;
    }
  }

  const api = {
    TUTOR_VERSIONS,
    GRADE_BANDS,
    DEFAULT_EXPLAIN_MAX_WORDS,
    DEFAULT_STANDARD_FRACTION,
    DEFAULT_DEEP_DIVE_BANDS,
    DEFAULT_SPEECH_MODEL,
    TTS_SAFE_CHAR_LIMIT,
    SPEECH_STYLES,
    LESSON_SYSTEM_INSTRUCTION,
    normalizeBand,
    speechStyleFor,
    resolveSpeechModel,
    resolveDeepDiveMaxWords,
    resolveStandardFraction,
    resolveDeepDiveBands,
    deepDiveAvailable,
    resolveExplainDepth,
    effectiveExplainMaxWords,
    resolveWordsPerMinute,
    SPEED_OPTIONS,
    parsePlaybackRate,
    tutorConfigVersion,
    speechStyleVersion,
    buildLessonConfig,
    buildLessonUserPayload,
    normalizeSource,
    splitSentences,
    semanticChunk,
    sha256Hex,
    transcriptCacheKey,
    audioCacheKey,
    segmentCacheKey,
    requestIdentity,
    countWords,
    trimToWordCeiling,
    validateTranscript,
    TutorAudioQueue
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.TutorVoice = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
