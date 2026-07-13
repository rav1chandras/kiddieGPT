#!/usr/bin/env node
/*
 * KiddieGPT — Tutor voice per-grade audio sampler (DEV ONLY).
 *
 * Drives the REAL v2 tutor pipeline (extension/tutor-voice.js) end to end for
 * every grade band and writes one MP3 per grade so you can listen to the
 * grade-specific lesson length + spoken style:
 *
 *   source -> normalizeSource -> lesson model (/v1/responses, compact prompt +
 *   per-grade config) -> trimToWordCeiling(sentence boundary) -> semanticChunk
 *   -> /v1/audio/speech per chunk with the grade's SPEECH_STYLES instruction.
 *
 * The extension itself never concatenates MP3s (it plays an ordered queue); this
 * harness concatenates the segment buffers into ONE file purely so the sample is
 * a single listenable track. That is a test artifact, not runtime behavior.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... node evals/tutor-grade-audio.js
 *   OPENAI_API_KEY=sk-... LESSON_MODEL=gpt-4o-mini TTS_MODEL=gpt-4o-mini-tts VOICE=sage node evals/tutor-grade-audio.js
 */

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const TV = require(path.resolve(__dirname, "..", "tutor-voice.js"));

const KEY = process.env.OPENAI_API_KEY || "";
if (!KEY.startsWith("sk-")) {
  console.error("Set OPENAI_API_KEY (sk-...) in the environment.");
  process.exit(1);
}
// The extension's configured model ids (gpt-5.6-*) are portal-side aliases and
// are not valid when calling api.openai.com directly, so this harness uses a
// real lesson model. Speech uses the real gpt-4o-mini-tts the product already uses.
const LESSON_MODEL = process.env.LESSON_MODEL || "gpt-4o-mini";
const TTS_MODEL = process.env.TTS_MODEL || "gpt-4o-mini-tts";
const VOICE = process.env.VOICE || "sage"; // a real, admin-approved voice; same across grades so only the STYLE differs
const OUT_DIR = path.resolve(__dirname, "tutor-grade-samples");

// One shared source so grade differences are apparent side by side.
const SOURCE = `The Water Cycle

The water cycle is how water moves around the Earth again and again. It never stops. There are four main stages: evaporation, condensation, precipitation, and collection.

During evaporation, the Sun heats water in oceans, lakes, and rivers. The heat turns liquid water into an invisible gas called water vapor, which rises into the air.

During condensation, the water vapor cools down high in the sky. It turns back into tiny droplets of liquid water. Millions of these droplets group together to form clouds.

During precipitation, the droplets in a cloud join and grow heavy. When they are too heavy to stay up, they fall as rain, snow, sleet, or hail.

During collection, the fallen water gathers in oceans, lakes, rivers, and underground. From there the Sun heats it again, and the whole cycle repeats. Plants and animals, including people, depend on this cycle for the fresh water they need to live.`;

// Pseudo-session using the backend default length model (per-band Deep Dive max
// words + standard fraction). Depth is chosen per band below.
const SESSION = {
  tutorExplainMaxWords: TV.DEFAULT_EXPLAIN_MAX_WORDS,
  tutorStandardFraction: TV.DEFAULT_STANDARD_FRACTION,
  deepDiveBands: TV.DEFAULT_DEEP_DIVE_BANDS,
  speechStyleVersion: "v2",
  tutorConfigVersion: "sample"
};
// Sample each band at its richest available depth: Deep Dive where offered, else
// Standard (K-2). Override with DEPTH=standard|deep to force one.
const DEPTH_FOR = band => process.env.DEPTH || (TV.deepDiveAvailable(SESSION, band) ? "deep" : "standard");

function parseJson(text) {
  let t = String(text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

function extractOutputText(data) {
  if (typeof data.output_text === "string" && data.output_text) return data.output_text;
  for (const item of data.output || []) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const c of item.content) if (c.type === "output_text" && c.text) return c.text;
    }
  }
  return "";
}

async function makeTranscript(band) {
  const config = TV.buildLessonConfig(SESSION, band, DEPTH_FOR(band));
  const payload = TV.buildLessonUserPayload("The Water Cycle", TV.normalizeSource(SOURCE), config);
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: LESSON_MODEL,
      instructions: TV.LESSON_SYSTEM_INSTRUCTION,
      input: [{ role: "user", content: [{ type: "input_text", text: payload }] }],
      max_output_tokens: 2000
    })
  });
  if (!res.ok) throw new Error(`responses ${res.status}: ${await res.text()}`);
  const parsed = parseJson(extractOutputText(await res.json()));
  const raw = String(parsed.script || "").trim();
  const transcript = TV.trimToWordCeiling(raw, config.targetWords);
  const check = TV.validateTranscript(transcript, config.targetWords);
  return { title: parsed.title || "The Water Cycle", transcript, config, check };
}

async function tts(text, band) {
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice: VOICE,
      input: text,
      instructions: TV.speechStyleFor("explain", band),
      response_format: "mp3"
    })
  });
  if (!res.ok) throw new Error(`speech ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

async function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Lesson model: ${LESSON_MODEL}   TTS model: ${TTS_MODEL}   Voice: ${VOICE}`);
  console.log(`Output: ${OUT_DIR}\n`);

  for (const band of TV.GRADE_BANDS) {
    const t0 = performance.now();
    process.stdout.write(`[${band}] writing lesson… `);
    const { title, transcript, config, check } = await makeTranscript(band);
    const words = TV.countWords(transcript);
    process.stdout.write(`${words} words (${config.depth}, cap ${config.targetWords}) `);

    const chunks = TV.semanticChunk(transcript);
    process.stdout.write(`→ ${chunks.length} segment(s) → synthesizing… `);
    const buffers = [];
    for (const chunk of chunks) buffers.push(await tts(chunk, band));
    const audio = Buffer.concat(buffers);
    const file = path.join(OUT_DIR, `tutor-${band.replace("-", "to")}-${config.depth}.mp3`);
    fs.writeFileSync(file, audio);

    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    console.log(`done (${(audio.length / 1024).toFixed(0)} KB, ${secs}s)`);
    console.log(`   style : ${TV.speechStyleFor("explain", band)}`);
    console.log(`   valid : ${check.ok ? "ok" : "issues -> " + check.problems.join(", ")}`);
    console.log(`   file  : ${file}`);
    console.log(`   opens : "${title}" — ${transcript.slice(0, 140).replace(/\s+/g, " ")}…\n`);
  }
  console.log("All grades done. Open the folder above to listen.");
}

run().catch(err => { console.error("\nFAILED:", err.message); process.exit(1); });
