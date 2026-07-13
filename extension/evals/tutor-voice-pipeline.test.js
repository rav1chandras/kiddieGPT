#!/usr/bin/env node
/*
 * KiddieGPT — Tutor voice pipeline unit tests (no external deps).
 *
 * Covers the pure, deterministic core in ../tutor-voice.js:
 *   source normalization, deterministic semantic chunking, transcript/audio/
 *   segment cache keys, request-identity dedup, cancellation-safe queue,
 *   queued playback order, partial segment-cache reuse, highlight transitions,
 *   word-target/model resolution, transcript trim + validation.
 *
 * Usage: node evals/tutor-voice-pipeline.test.js
 */

const TV = require("../tutor-voice.js");

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { passed += 1; }
  else { failed += 1; failures.push(`${name}${detail ? " — " + detail : ""}`); }
}
function eq(name, a, b) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  ok(name, A === B, `expected ${B}, got ${A}`);
}

async function run() {
  // ---- Source normalization (item 8) ---------------------------------------
  {
    const src = "Home > Section\nAccept all cookies\n\nHot   rock    rises.\n\nVolcanoes are openings in Earth.\n\nVolcanoes are openings in Earth.\nSubscribe now\nThe pressure is 5 kPa.";
    const out = TV.normalizeSource(src);
    ok("normalize drops nav/cookie", !/Accept all cookies/i.test(out) && !/Subscribe now/i.test(out) && !/Home >/i.test(out));
    ok("normalize collapses whitespace", out.includes("Hot rock rises."));
    ok("normalize dedupes repeated paragraph", (out.match(/Volcanoes are openings in Earth\./g) || []).length === 1);
    ok("normalize preserves units", out.includes("5 kPa"));
    eq("normalize deterministic", TV.normalizeSource(src), out);
  }

  // ---- Sentence splitting (abbreviation + decimal aware) -------------------
  {
    eq("split basic", TV.splitSentences("A cat sat. A dog ran! Why?"),
      ["A cat sat.", "A dog ran!", "Why?"]);
    eq("split keeps decimals", TV.splitSentences("Pi is 3.14 exactly."),
      ["Pi is 3.14 exactly."]);
    eq("split keeps abbreviation", TV.splitSentences("Dr. Smith arrived. He left."),
      ["Dr. Smith arrived.", "He left."]);
    eq("split keeps e.g.", TV.splitSentences("Use fruit, e.g. apples, daily."),
      ["Use fruit, e.g. apples, daily."]);
  }

  // ---- Deterministic semantic chunking (item 9) ----------------------------
  {
    const para = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} explains an idea about the topic clearly.`).join(" ");
    const text = para + "\n\n" + para;
    const c1 = TV.semanticChunk(text);
    const c2 = TV.semanticChunk(text);
    eq("chunking deterministic", c1, c2);
    ok("chunking respects max", c1.every(c => c.length <= 700));
    ok("chunking never splits mid-sentence", c1.every(c => /[.!?]["')\]]?$/.test(c.trim())));
    ok("chunking produces multiple segments", c1.length >= 2);

    const huge = "x".repeat(9000) + ".";
    const hc = TV.semanticChunk(huge, { hardLimit: 4000 });
    ok("chunking hard-splits oversize sentence", hc.length >= 3 && hc.every(c => c.length <= 4000));
  }

  // ---- Model + word-target resolution (items 1, 3) -------------------------
  {
    eq("speech model default", TV.resolveSpeechModel(null, null), "gpt-4o-mini-tts");
    eq("speech model from session", TV.resolveSpeechModel({ ttsModel: "session-tts" }, { ttsModel: "local-tts" }), "session-tts");
    eq("speech model from local", TV.resolveSpeechModel({}, { ttsModel: "local-tts" }), "local-tts");

    // Deep Dive max words (per band), standard fraction, deep-dive availability.
    eq("deep max fallback 9-12", TV.resolveDeepDiveMaxWords(null, "9-12"), 1000);
    eq("deep max from session", TV.resolveDeepDiveMaxWords({ tutorExplainMaxWords: { "6-8": 500 } }, "6-8"), 500);
    eq("unknown band -> 6-8 fallback", TV.resolveDeepDiveMaxWords(null, "banana"), 700);
    eq("standard fraction default", TV.resolveStandardFraction(null), 0.5);
    eq("standard fraction clamped", TV.resolveStandardFraction({ tutorStandardFraction: 2 }), 0.9);

    // Effective cap = deep? bandMax : round(bandMax * fraction). K-2 always standard.
    eq("effective standard 6-8", TV.effectiveExplainMaxWords(null, "6-8", "standard"), 350); // 700 * 0.5
    eq("effective deep 6-8", TV.effectiveExplainMaxWords(null, "6-8", "deep"), 700);
    eq("K-2 deep -> standard (no deep dive)", TV.effectiveExplainMaxWords(null, "K-2", "deep"), 80); // 160 * 0.5

    // Deep Dive availability + depth normalization (item 4b).
    ok("deep dive available 3-5", TV.deepDiveAvailable(null, "3-5"));
    ok("deep dive NOT available K-2", !TV.deepDiveAvailable(null, "K-2"));
    eq("resolveDepth K-2 forced standard", TV.resolveExplainDepth(null, "K-2", "deep"), "standard");
    eq("resolveDepth 9-12 honors deep", TV.resolveExplainDepth(null, "9-12", "deep"), "deep");
    eq("resolveDepth custom bands respected", TV.resolveExplainDepth({ deepDiveBands: ["9-12"] }, "6-8", "deep"), "standard");

    const cfg = TV.buildLessonConfig({ tutorExplainMaxWords: { "9-12": 900 } }, "9-12", "deep");
    eq("lesson config band", cfg.gradeBand, "9-12");
    eq("lesson config depth", cfg.depth, "deep");
    eq("lesson config targetWords (deep)", cfg.targetWords, 900);
    const cfgStd = TV.buildLessonConfig({ tutorExplainMaxWords: { "9-12": 900 }, tutorStandardFraction: 0.5 }, "9-12", "standard");
    eq("lesson config targetWords (standard)", cfgStd.targetWords, 450);
    ok("lesson config has tone+complexity", !!cfg.tone && !!cfg.sentenceComplexity);

    // Speed dropdown (item 21).
    eq("speed options", TV.SPEED_OPTIONS, [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
    eq("parse valid rate", TV.parsePlaybackRate("1.5"), 1.5);
    eq("parse invalid rate -> 1", TV.parsePlaybackRate("3"), 1);
    eq("parse junk rate -> 1", TV.parsePlaybackRate("abc"), 1);
  }

  // ---- Transcript trim at sentence boundary (item 3) -----------------------
  {
    const t = "One two three four five. Six seven eight nine ten. Eleven twelve.";
    const trimmed = TV.trimToWordCeiling(t, 6);
    eq("trim stops at sentence boundary", trimmed, "One two three four five.");
    ok("trim never mid-sentence", /[.!?]$/.test(trimmed));
    eq("trim keeps first oversize sentence", TV.trimToWordCeiling("A very long single unbroken sentence here.", 3),
      "A very long single unbroken sentence here.");
  }

  // ---- Transcript validation (item 18) -------------------------------------
  {
    const good = "Welcome to today's lesson. Photosynthesis lets plants make food from light. Leaves capture sunlight. Roots pull up water. Can you name one thing a plant needs?";
    const gv = TV.validateTranscript(good, 300);
    ok("valid transcript passes", gv.ok, JSON.stringify(gv.problems));

    ok("empty flagged", TV.validateTranscript("", 300).problems.includes("empty"));
    ok("no recall question flagged", TV.validateTranscript("This is a lesson with no question at all here.", 300).problems.includes("no_recall_question"));
    ok("markdown table flagged", TV.validateTranscript("Here.\n| a | b |\n| --- | --- |\n| 1 | 2 |\nWhat?", 300).problems.includes("markdown_table"));
    ok("leaked instructions flagged", TV.validateTranscript("You are a patient tutor. Do it. What?", 300).problems.includes("leaked_instructions"));
    ok("repeated paragraph flagged", TV.validateTranscript("The mitochondria is the powerhouse.\nThe mitochondria is the powerhouse.\nWhat?", 300).problems.includes("repeated_paragraphs"));
    ok("too-short flagged", TV.validateTranscript("Short? Yes.", 300).problems.includes("too_short"));
  }

  // ---- Cache keys (items 6, 7, 12) -----------------------------------------
  {
    const baseT = { normalizedSourceText: "hello world", gradeBand: "6-8", tutorMode: "explain", explainDepth: "standard", lessonPromptVersion: "v2", lessonModel: "gpt-5.6-luna", tutorConfigVersion: "7" };
    const k1 = await TV.transcriptCacheKey(baseT);
    const k2 = await TV.transcriptCacheKey({ ...baseT });
    eq("transcript key deterministic", k1, k2);
    ok("transcript key prefixed", k1.startsWith("tutor-transcript:"));
    ok("transcript key encodes fields", k1.includes(":6-8:explain:standard:v2:gpt-5.6-luna:7"));
    const kDeep = await TV.transcriptCacheKey({ ...baseT, explainDepth: "deep" });
    ok("transcript key changes with depth", k1 !== kDeep);
    const k3 = await TV.transcriptCacheKey({ ...baseT, tutorConfigVersion: "8" });
    ok("transcript key changes with cfgVer", k1 !== k3);
    const k4 = await TV.transcriptCacheKey({ ...baseT, gradeBand: "9-12" });
    ok("transcript key changes with band", k1 !== k4);

    const baseA = { normalizedTranscript: "spoken lesson", voice: "marin", speechModel: "gpt-4o-mini-tts", speechStyleVersion: "v2", audioFormat: "mp3" };
    const a1 = await TV.audioCacheKey(baseA);
    eq("audio key deterministic", a1, await TV.audioCacheKey({ ...baseA }));
    ok("audio key prefixed", a1.startsWith("tutor-audio:"));
    ok("audio key changes with voice", a1 !== await TV.audioCacheKey({ ...baseA, voice: "cedar" }));
    ok("audio key changes with styleVersion", a1 !== await TV.audioCacheKey({ ...baseA, speechStyleVersion: "v3" }));

    const s1 = await TV.segmentCacheKey({ normalizedChunkText: "chunk one", voice: "marin", speechModel: "gpt-4o-mini-tts", speechStyleVersion: "v2", audioFormat: "mp3" });
    const s2 = await TV.segmentCacheKey({ normalizedChunkText: "chunk two", voice: "marin", speechModel: "gpt-4o-mini-tts", speechStyleVersion: "v2", audioFormat: "mp3" });
    ok("segment keys differ per chunk", s1 !== s2 && s1.startsWith("tutor-seg:"));
  }

  // ---- Request identity / dedup (item 16) ----------------------------------
  {
    const base = { mode: "explain", normalizedSourceText: "abc", gradeBand: "6-8", explainDepth: "standard", voice: "marin", lessonPromptVersion: "v2", speechStyleVersion: "v2", tutorConfigVersion: "7" };
    const id1 = await TV.requestIdentity(base);
    eq("identity deterministic", id1, await TV.requestIdentity({ ...base }));
    ok("identity changes with grade", id1 !== await TV.requestIdentity({ ...base, gradeBand: "9-12" }));
    ok("identity changes with depth", id1 !== await TV.requestIdentity({ ...base, explainDepth: "deep" }));
    ok("identity changes with voice", id1 !== await TV.requestIdentity({ ...base, voice: "cedar" }));
  }

  // ---- Fake audio element for queue tests ----------------------------------
  function fakeAudio() {
    return {
      src: "", currentTime: 0, _handlers: {},
      addEventListener(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); },
      removeEventListener(ev, fn) { this._handlers[ev] = (this._handlers[ev] || []).filter(h => h !== fn); },
      load() {}, play() { this.playing = true; return Promise.resolve(); }, pause() { this.playing = false; },
      fire(ev) { (this._handlers[ev] || []).slice().forEach(h => h()); }
    };
  }

  // ---- Queued playback order + highlight transitions (items 10, 12) --------
  {
    const audio = fakeAudio();
    const highlights = [];
    const revoked = [];
    const q = new TV.TutorAudioQueue({
      audio,
      createUrl: blob => `url:${blob}`,
      revokeUrl: u => revoked.push(u),
      onSegmentChange: i => highlights.push(i)
    });
    q.load([
      { id: "a", text: "one", blob: "A" },
      { id: "b", text: "two", blob: "B" },
      { id: "c", text: "three", blob: "C" }
    ]);
    ok("queue builds object urls, no concat", q.segments.map(s => s.url).join(",") === "url:A,url:B,url:C");
    await q.play();
    eq("queue starts at segment 0", q.index, 0);
    ok("audio src is first segment", audio.src === "url:A");
    audio.fire("ended");
    await Promise.resolve();
    eq("queue advanced to 1 on ended", q.index, 1);
    ok("audio src is second segment", audio.src === "url:B");
    audio.fire("ended");
    await Promise.resolve();
    eq("queue advanced to 2 on ended", q.index, 2);

    let finished = false;
    q.onEnded = () => { finished = true; };
    audio.fire("ended");
    await Promise.resolve();
    ok("queue finishes after last segment", finished);
    eq("highlight transitions in order", highlights, [0, 1, 2]);

    // replay after finish restarts from the top
    highlights.length = 0;
    await q.play();
    eq("queue replays from segment 0 after finish", q.index, 0);

    q.destroy();
    ok("queue revokes all urls on destroy", revoked.length === 3);
  }

  // ---- Cancellation safety (item 16) ---------------------------------------
  {
    const audio = fakeAudio();
    let changesAfterDestroy = 0;
    const q = new TV.TutorAudioQueue({ audio, createUrl: b => `u:${b}`, revokeUrl: () => {} });
    q.load([{ blob: "A" }, { blob: "B" }]);
    await q.play();
    q.destroy();
    q.onSegmentChange = () => { changesAfterDestroy += 1; };
    audio.fire("ended"); // must be ignored: listener removed + destroyed guard
    await Promise.resolve();
    ok("destroyed queue ignores ended", changesAfterDestroy === 0);
  }

  // ---- Partial segment-cache reuse simulation (item 11) --------------------
  {
    // Simulate: two chunks, one cached, one synthesized; order preserved.
    const cache = new Map();
    const chunks = ["Chunk one.", "Chunk two."];
    const voice = "marin", model = "gpt-4o-mini-tts", styleV = "v2", fmt = "mp3";
    const k0 = await TV.segmentCacheKey({ normalizedChunkText: chunks[0], voice, speechModel: model, speechStyleVersion: styleV, audioFormat: fmt });
    cache.set(k0, "cached-blob-0"); // pretend chunk 0 already synthesized
    let synthCalls = 0;
    const segments = [];
    for (const chunk of chunks) {
      const key = await TV.segmentCacheKey({ normalizedChunkText: chunk, voice, speechModel: model, speechStyleVersion: styleV, audioFormat: fmt });
      let blob = cache.get(key);
      let hit = true;
      if (!blob) { hit = false; synthCalls += 1; blob = `fresh-${chunk}`; cache.set(key, blob); }
      segments.push({ text: chunk, blob, hit });
    }
    eq("partial cache: only misses synthesized", synthCalls, 1);
    eq("partial cache: order preserved", segments.map(s => s.text), chunks);
    ok("partial cache: first was a hit, second a miss", segments[0].hit === true && segments[1].hit === false);
  }

  // ---- Report -------------------------------------------------------------
  console.log(`\nTutor voice pipeline tests: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log("\nFailures:");
    failures.forEach(f => console.log("  ✗ " + f));
    process.exit(1);
  }
  console.log("All green ✓");
}

run().catch(err => { console.error(err); process.exit(1); });
