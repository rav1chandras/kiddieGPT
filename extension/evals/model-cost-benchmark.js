#!/usr/bin/env node
/*
 * KiddieGPT model benchmark (DEV ONLY).
 *
 * Runs one assignment through the same Responses API shape used by the
 * extension for math, tutor, and Study Mission-style JSON generation. The key
 * is read from local-settings.js and is never printed.
 *
 * Usage:
 *   node evals/model-cost-benchmark.js
 *   MODELS=gpt-5.6-luna,gpt-5.6-terra node evals/model-cost-benchmark.js
 */

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const root = path.resolve(__dirname, "..");
const settingsPath = path.join(root, "local-settings.js");
const settings = fs.readFileSync(settingsPath, "utf8");
const key = settings.match(/openaiApiKey:\s*'([^']+)'/)?.[1] || "";

if (!key.startsWith("sk-")) {
  console.error("No OpenAI key found in extension/local-settings.js.");
  process.exit(1);
}

const models = (process.env.MODELS || "gpt-5.6-luna,gpt-5.6-terra,gpt-5.6-sol,gpt-4.1")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const assignment = "If \\int_{-2}^{3} x^{2}\\,dx = k\\int_{0}^{2} x^{2}\\,dx + \\int_{2}^{3} x^{2}\\,dx, then the value of k is";
const expectedAnswer = "k = 2";

const pricesPerMillion = {
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-5.6-luna": { input: 1, output: 6 },
  "gpt-5.6-terra": { input: 2.5, output: 15 },
  "gpt-5.6-sol": { input: 5, output: 30 }
};

const mathInstructions = "You are KiddieGPT Math Tutor, a careful teacher for K-8 students (support harder topics like algebra, geometry, vectors, and early calculus when the source shows them). Accuracy is critical: a wrong answer is worse than no answer. If the source contains no readable math problem — it is blank, too blurry or low-quality to read, or simply not math (like a photo, a paragraph of text, or a random screenshot) — do NOT invent a problem. Instead return exactly {\"noMath\": true, \"reason\": \"<one short, kind, kid-friendly sentence explaining what you see and what to do>\"} and nothing else. Otherwise: before solving, read EVERY label, number, and angle in the source and list them as givens. Solve with the SIMPLEST method a student at the given grade would use. Show the work like a whiteboard: short connected lines, each following from the one above. Always end with a check that substitutes the answer back and confirms it agrees with every given; if the check fails, redo the work before answering. Write every math expression as inline LaTeX; do NOT wrap it in $, $$, \\( \\), or \\[ \\] delimiters, and use no markdown. Return only valid JSON.";

const workloads = [
  {
    tool: "math",
    instructions: mathInstructions,
    text: `${assignment}
Student grade band: 6-8. Use pre-algebra and algebra as needed, but pick the simplest approach the problem allows and name the rule in each line.
Return JSON with a problems array. Each problem object must have:
- friendlyProblem: the original question only.
- givens: array of short strings, one per fact.
- goal: one line naming the unknown.
- lines: the worked solution as an array of {math, why}. math is ONE short relation as inline LaTeX, never a sentence. why is one short plain sentence.
- check: object with math and why that substitutes the final answer back into the original relationship.
- answer: the final answer only, as inline LaTeX.
- warning: the most common mistake on this exact problem type.
Every math field must be inline LaTeX with no $ or \\( \\) delimiters.`
  },
  {
    tool: "tutor",
    instructions: "You are KiddieGPT Tutor, a warm K-8 teacher. Explain the lesson behind a math problem without being childish. Use hint-first teaching, not answer dumping. Return only valid JSON.",
    text: `${assignment}
Student grade band: 6-8.
Return JSON with:
- title string
- explanation array of 4 short steps
- commonMistake string
- finalCheck string
- answer string
The answer must be ${expectedAnswer} or an equivalent value.`
  },
  {
    tool: "mission",
    instructions: "You are KiddieGPT Study Mission Builder for K-8 students. Build study material from the provided assignment only, never general knowledge. Return only valid JSON.",
    text: `Study material:
${assignment}
Build a compact Study Mission for a grade 6-8 student. Return JSON with:
- mainIdea string
- mustKnow array of 4 strings
- flashcards array of 5 objects with term and meaning
- quiz array of 5 multiple-choice objects with question, choices array of 4 strings, answer string
- parentSummary string
Keep all content focused on integrals, splitting intervals, and solving for k.`
  }
];

function outputText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  return (data.output || [])
    .flatMap((item) => item.content || [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text || "")
    .join("");
}

function stripFence(text) {
  return String(text || "").trim().replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "");
}

function repairJson(text) {
  return text.replace(/(\\+)([a-zA-Z])/g, (match, slashes, letter) =>
    slashes.length % 2 ? `${slashes}\\${letter}` : match
  );
}

function parseJson(text) {
  const clean = stripFence(text);
  try {
    return JSON.parse(clean);
  } catch {
    try {
      return JSON.parse(repairJson(clean));
    } catch {
      return null;
    }
  }
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, "$1/$2")
    .replace(/\\(cdot|times)/g, "*")
    .replace(/[{}\s$]/g, "")
    .replace(/^k=/, "");
}

function judge(tool, parsed) {
  if (!parsed) return { pass: false, note: "invalid_json" };
  if (tool === "math") {
    const problem = parsed.problems?.[0] || {};
    const answer = normalize(problem.answer);
    const hasAnswer = answer === "2" || answer.includes("=2");
    const hasSteps = Array.isArray(problem.lines) && problem.lines.length >= 3;
    const hasCheck = Boolean(problem.check?.math || problem.check?.why);
    return { pass: hasAnswer && hasSteps && hasCheck, note: `answer=${problem.answer || "(missing)"}` };
  }
  if (tool === "tutor") {
    const answer = normalize(parsed.answer || parsed.finalCheck || JSON.stringify(parsed));
    return { pass: answer === "2" || answer.includes("=2"), note: `answer=${parsed.answer || "(embedded)"}` };
  }
  if (tool === "mission") {
    const cardCount = Array.isArray(parsed.flashcards) ? parsed.flashcards.length : 0;
    const quizCount = Array.isArray(parsed.quiz) ? parsed.quiz.length : 0;
    return { pass: Boolean(parsed.mainIdea) && cardCount >= 4 && quizCount >= 4, note: `cards=${cardCount};quiz=${quizCount}` };
  }
  return { pass: false, note: "unknown_tool" };
}

function estimateCost(model, usage = {}) {
  const price = pricesPerMillion[model];
  if (!price) return null;
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  return (input * price.input + output * price.output) / 1_000_000;
}

async function call(model, workload) {
  const started = performance.now();
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      model,
      instructions: workload.instructions,
      input: [{ role: "user", content: [{ type: "input_text", text: workload.text }] }]
    })
  });
  const elapsedMs = Math.round(performance.now() - started);
  const data = await response.json().catch(() => ({}));
  const rawText = outputText(data);
  const parsed = parseJson(rawText);
  const verdict = response.ok ? judge(workload.tool, parsed) : { pass: false, note: data.error?.message || "api_error" };
  const usage = data.usage || {};
  return {
    model,
    tool: workload.tool,
    ok: response.ok,
    status: response.status,
    latencyMs: elapsedMs,
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    totalTokens: usage.total_tokens || 0,
    estimatedCostUsd: estimateCost(model, usage),
    pass: verdict.pass,
    note: verdict.note,
    rawText,
    parsed
  };
}

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

(async () => {
  const results = [];
  fs.mkdirSync(path.join(__dirname, "results"), { recursive: true });

  for (const model of models) {
    for (const workload of workloads) {
      process.stdout.write(`Running ${model} / ${workload.tool}... `);
      const result = await call(model, workload);
      results.push(result);
      const cost = result.estimatedCostUsd == null ? "n/a" : `$${result.estimatedCostUsd.toFixed(6)}`;
      console.log(`${result.pass ? "PASS" : "FAIL"} ${result.latencyMs}ms ${cost} ${result.note}`);
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(__dirname, "results", `model-cost-benchmark-${stamp}.json`);
  const csvPath = path.join(__dirname, "results", `model-cost-benchmark-${stamp}.csv`);
  fs.writeFileSync(jsonPath, JSON.stringify({ assignment, expectedAnswer, pricesPerMillion, results }, null, 2));
  const rows = [
    ["model", "tool", "pass", "status", "latencyMs", "inputTokens", "outputTokens", "totalTokens", "estimatedCostUsd", "note"],
    ...results.map((item) => [
      item.model,
      item.tool,
      item.pass,
      item.status,
      item.latencyMs,
      item.inputTokens,
      item.outputTokens,
      item.totalTokens,
      item.estimatedCostUsd == null ? "" : item.estimatedCostUsd.toFixed(8),
      item.note
    ])
  ];
  fs.writeFileSync(csvPath, rows.map((row) => row.map(csvEscape).join(",")).join("\n") + "\n");

  const total = results.reduce((sum, item) => sum + (item.estimatedCostUsd || 0), 0);
  console.log("\nSummary");
  for (const model of models) {
    const modelResults = results.filter((item) => item.model === model);
    const passes = modelResults.filter((item) => item.pass).length;
    const cost = modelResults.reduce((sum, item) => sum + (item.estimatedCostUsd || 0), 0);
    const avgLatency = Math.round(modelResults.reduce((sum, item) => sum + item.latencyMs, 0) / modelResults.length);
    console.log(`${model}: ${passes}/${modelResults.length} pass, avg ${avgLatency}ms, est $${cost.toFixed(6)}`);
  }
  console.log(`Total estimated cost: $${total.toFixed(6)}`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`CSV:  ${csvPath}`);
})().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
