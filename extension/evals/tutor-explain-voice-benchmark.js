#!/usr/bin/env node
/*
 * KiddieGPT tutor explanation + voice benchmark (DEV ONLY).
 *
 * Fetches a web page, sends its main text through the extension-style tutor
 * JSON contract across text models, then generates one MP3 narration for each
 * model's explanation using the extension TTS model.
 *
 * Usage:
 *   node evals/tutor-explain-voice-benchmark.js
 *   URL=https://example.com MODELS=gpt-5.6-luna,gpt-5.6-terra node evals/tutor-explain-voice-benchmark.js
 */

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const root = path.resolve(__dirname, "..");
const settings = fs.readFileSync(path.join(root, "local-settings.js"), "utf8");
const key = settings.match(/openaiApiKey:\s*'([^']+)'/)?.[1] || "";

if (!key.startsWith("sk-")) {
  console.error("No OpenAI key found in extension/local-settings.js.");
  process.exit(1);
}

const url = process.env.URL || "https://www.usgs.gov/programs/VHP/about-volcanoes";
const models = (process.env.MODELS || "gpt-5.6-luna,gpt-5.6-terra,gpt-5.6-sol,gpt-4.1")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const ttsModel = process.env.TTS_MODEL || "gpt-4o-mini-tts";
const voice = process.env.VOICE || "sage";
const gradeBand = process.env.GRADE || "6-8";

const pricesPerMillion = {
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-5.6-luna": { input: 1, output: 6 },
  "gpt-5.6-terra": { input: 2.5, output: 15 },
  "gpt-5.6-sol": { input: 5, output: 30 }
};

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'");
}

function extractMainText(html) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "";
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  const cleaned = decodeHtml(`${title}\n${body}`)
    .replace(/\s+/g, " ")
    .replace(/Skip to main content[\s\S]*?About Volcanoes/i, "About Volcanoes")
    .trim();
  const start = cleaned.indexOf("About Volcanoes");
  const sliced = start >= 0 ? cleaned.slice(start) : cleaned;
  return sliced.slice(0, 9000);
}

function outputText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  return (data.output || [])
    .flatMap((item) => item.content || [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text || "")
    .join("");
}

function stripFence(value) {
  return String(value || "").trim().replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "");
}

function parseJson(value) {
  const clean = stripFence(value);
  try {
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

function estimateCost(model, usage = {}) {
  const price = pricesPerMillion[model];
  if (!price) return null;
  return ((usage.input_tokens || 0) * price.input + (usage.output_tokens || 0) * price.output) / 1_000_000;
}

function score(parsed) {
  if (!parsed) return { pass: false, note: "invalid_json" };
  const concepts = Array.isArray(parsed.keyConcepts) ? parsed.keyConcepts : [];
  const check = Array.isArray(parsed.quickCheck) ? parsed.quickCheck : [];
  const narration = String(parsed.narration || "");
  const blob = JSON.stringify(parsed).toLowerCase();
  const mustMention = ["magma", "lava", "ash", "cinder", "shield"];
  const hits = mustMention.filter((term) => blob.includes(term));
  const pass = Boolean(parsed.title) && concepts.length >= 5 && check.length >= 3 && narration.length >= 350 && hits.length >= 4;
  return { pass, note: `concepts=${concepts.length};check=${check.length};terms=${hits.join("|")};narrationChars=${narration.length}` };
}

async function explain(model, sourceText) {
  const started = performance.now();
  const instructions = "You are KiddieGPT Tutor, a warm K-8 science teacher. Explain only from the provided source. Be accurate, concrete, and age-appropriate without sounding babyish. Return only valid JSON.";
  const inputText = `Source URL: ${url}
Student grade band: ${gradeBand}
Source text:
${sourceText}

Return JSON with:
- title string
- plainSummary string, 90-130 words
- keyConcepts array of 6 objects with term and meaning
- whyItMatters string
- quickCheck array of 3 objects with question, choices array of 4 strings, answer string
- parentSummary string, 35 words max
- narration string, 90-120 words for text-to-speech. Use clear sentences and no markdown.`;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      model,
      instructions,
      input: [{ role: "user", content: [{ type: "input_text", text: inputText }] }]
    })
  });
  const elapsedMs = Math.round(performance.now() - started);
  const data = await response.json().catch(() => ({}));
  const rawText = outputText(data);
  const parsed = parseJson(rawText);
  const verdict = response.ok ? score(parsed) : { pass: false, note: data.error?.message || "api_error" };
  return {
    model,
    ok: response.ok,
    status: response.status,
    latencyMs: elapsedMs,
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0,
    totalTokens: data.usage?.total_tokens || 0,
    estimatedCostUsd: estimateCost(model, data.usage || {}),
    pass: verdict.pass,
    note: verdict.note,
    rawText,
    parsed
  };
}

async function synthesizeSpeech({ text, outputPath }) {
  const started = performance.now();
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      model: ttsModel,
      voice,
      input: text,
      instructions: "Speak like a warm, patient tutor. Clear, encouraging, not childish. Add gentle pauses between sentences.",
      response_format: "mp3"
    })
  });
  const elapsedMs = Math.round(performance.now() - started);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return { ok: false, status: response.status, latencyMs: elapsedMs, bytes: 0, path: "", error: detail.slice(0, 300) };
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);
  return { ok: true, status: response.status, latencyMs: elapsedMs, bytes: buffer.length, path: outputPath, error: "" };
}

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

(async () => {
  const resultsDir = path.join(__dirname, "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const audioDir = path.join(resultsDir, `tutor-voice-${stamp}`);
  fs.mkdirSync(audioDir, { recursive: true });

  console.log(`Fetching source: ${url}`);
  const htmlResponse = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 KiddieGPTBenchmark/1.0",
      Accept: "text/html,application/xhtml+xml"
    }
  });
  if (!htmlResponse.ok) throw new Error(`Source fetch failed: ${htmlResponse.status}`);
  const sourceText = extractMainText(await htmlResponse.text());
  fs.writeFileSync(path.join(audioDir, "source.txt"), sourceText);

  const results = [];
  for (const model of models) {
    process.stdout.write(`Running ${model} tutor explanation... `);
    const explainResult = await explain(model, sourceText);
    const narration = String(explainResult.parsed?.narration || explainResult.parsed?.plainSummary || "").slice(0, 1600);
    let speech = { ok: false, status: 0, latencyMs: 0, bytes: 0, path: "", error: "no narration" };
    if (narration) {
      const safeModel = model.replace(/[^a-zA-Z0-9_.-]/g, "_");
      speech = await synthesizeSpeech({
        text: narration,
        outputPath: path.join(audioDir, `${safeModel}-${ttsModel}-${voice}.mp3`)
      });
    }
    results.push({ ...explainResult, speech });
    const cost = explainResult.estimatedCostUsd == null ? "n/a" : `$${explainResult.estimatedCostUsd.toFixed(6)}`;
    console.log(`${explainResult.pass ? "PASS" : "FAIL"} text=${explainResult.latencyMs}ms ${cost} voice=${speech.ok ? `${speech.latencyMs}ms ${speech.bytes} bytes` : "failed"}`);
  }

  const jsonPath = path.join(resultsDir, `tutor-explain-voice-benchmark-${stamp}.json`);
  const csvPath = path.join(resultsDir, `tutor-explain-voice-benchmark-${stamp}.csv`);
  fs.writeFileSync(jsonPath, JSON.stringify({ url, gradeBand, ttsModel, voice, sourceChars: sourceText.length, pricesPerMillion, results }, null, 2));

  const rows = [
    ["model", "pass", "status", "latencyMs", "inputTokens", "outputTokens", "totalTokens", "estimatedTextCostUsd", "note", "ttsModel", "voiceStatus", "voiceLatencyMs", "voiceBytes", "voicePath"],
    ...results.map((item) => [
      item.model,
      item.pass,
      item.status,
      item.latencyMs,
      item.inputTokens,
      item.outputTokens,
      item.totalTokens,
      item.estimatedCostUsd == null ? "" : item.estimatedCostUsd.toFixed(8),
      item.note,
      ttsModel,
      item.speech.status,
      item.speech.latencyMs,
      item.speech.bytes,
      item.speech.path
    ])
  ];
  fs.writeFileSync(csvPath, rows.map((row) => row.map(csvEscape).join(",")).join("\n") + "\n");

  console.log("\nSummary");
  for (const item of results) {
    const cost = item.estimatedCostUsd || 0;
    console.log(`${item.model}: ${item.pass ? "PASS" : "FAIL"}, text ${item.latencyMs}ms, voice ${item.speech.ok ? `${item.speech.latencyMs}ms` : "failed"}, est text $${cost.toFixed(6)}`);
  }
  console.log(`Audio dir: ${audioDir}`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`CSV:  ${csvPath}`);
})().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
