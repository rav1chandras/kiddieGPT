#!/usr/bin/env node
/*
 * KiddieGPT worksheet image model benchmark (DEV ONLY).
 *
 * Sends one worksheet image through the same kind of math-tutor JSON contract
 * the extension uses for screenshot/PDF math. The key is read from
 * local-settings.js and is never printed.
 *
 * Usage:
 *   IMAGE=/path/to/worksheet.png node evals/math-worksheet-image-benchmark.js
 *   MODELS=gpt-5.6-luna,gpt-5.6-terra IMAGE=/path/to/worksheet.png node evals/math-worksheet-image-benchmark.js
 */

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const root = path.resolve(__dirname, "..");
const settings = fs.readFileSync(path.join(root, "local-settings.js"), "utf8");
const key = settings.match(/openaiApiKey:\s*'([^']+)'/)?.[1] || "";
const imagePath = process.env.IMAGE || "/var/folders/kj/5cl20w814137pcssqvddf2mh0000gn/T/codex-clipboard-9a0541e7-bd19-4c0f-84da-d54302cbd742.png";

if (!key.startsWith("sk-")) {
  console.error("No OpenAI key found in extension/local-settings.js.");
  process.exit(1);
}
if (!fs.existsSync(imagePath)) {
  console.error(`Image not found: ${imagePath}`);
  process.exit(1);
}

const models = (process.env.MODELS || "gpt-5.6-luna,gpt-5.6-terra,gpt-5.6-sol,gpt-4.1")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const pricesPerMillion = {
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-5.6-luna": { input: 1, output: 6 },
  "gpt-5.6-terra": { input: 2.5, output: 15 },
  "gpt-5.6-sol": { input: 5, output: 30 }
};

const expectedChoices = ["a", "d", "d", "a", "d", "c", "b"];

const instructions = "You are KiddieGPT Math Tutor, a careful teacher for students. Accuracy is critical: a wrong answer is worse than no answer. Read EVERY problem, number, answer choice, and symbol from the worksheet image. Solve with the simplest reliable method. Return only valid JSON. Write math as inline LaTeX with no markdown delimiters.";

const text = `Solve every visible multiple-choice problem in the worksheet image.
Return JSON with a problems array of exactly 7 objects in reading order.
Each object must have:
- number: problem number
- topic: short topic
- choice: one lowercase letter from a, b, c, d
- answer: the selected answer text
- work: array of 2 to 5 short strings explaining the solution
- confidence: number from 0 to 1

Known answer choices must come from the image. Do not invent a new option.`;

const imageDataUrl = `data:image/png;base64,${fs.readFileSync(imagePath).toString("base64")}`;

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
  const problems = Array.isArray(parsed?.problems) ? parsed.problems : [];
  const choices = expectedChoices.map((_, index) => {
    const item = problems.find((problem) => Number(problem.number) === index + 1) || problems[index] || {};
    return String(item.choice || "").trim().toLowerCase().slice(0, 1);
  });
  const perProblem = choices.map((choice, index) => ({
    number: index + 1,
    expected: expectedChoices[index],
    actual: choice || "(missing)",
    pass: choice === expectedChoices[index]
  }));
  return {
    passed: perProblem.filter((item) => item.pass).length,
    total: expectedChoices.length,
    choices,
    perProblem,
    validJson: Boolean(parsed),
    problemCount: problems.length
  };
}

async function run(model) {
  const started = performance.now();
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      model,
      instructions,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text },
          { type: "input_image", image_url: imageDataUrl }
        ]
      }]
    })
  });
  const elapsedMs = Math.round(performance.now() - started);
  const data = await response.json().catch(() => ({}));
  const rawText = outputText(data);
  const parsed = parseJson(rawText);
  const scored = response.ok ? score(parsed) : {
    passed: 0,
    total: expectedChoices.length,
    choices: [],
    perProblem: [],
    validJson: false,
    problemCount: 0
  };
  return {
    model,
    ok: response.ok,
    status: response.status,
    latencyMs: elapsedMs,
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0,
    totalTokens: data.usage?.total_tokens || 0,
    estimatedCostUsd: estimateCost(model, data.usage || {}),
    score: `${scored.passed}/${scored.total}`,
    choices: scored.choices.join(""),
    validJson: scored.validJson,
    problemCount: scored.problemCount,
    perProblem: scored.perProblem,
    error: response.ok ? "" : data.error?.message || "api_error",
    rawText,
    parsed
  };
}

function csvEscape(value) {
  const textValue = value == null ? "" : String(value);
  return /[",\n]/.test(textValue) ? `"${textValue.replace(/"/g, '""')}"` : textValue;
}

(async () => {
  const results = [];
  fs.mkdirSync(path.join(__dirname, "results"), { recursive: true });
  for (const model of models) {
    process.stdout.write(`Running ${model} worksheet image... `);
    const result = await run(model);
    results.push(result);
    const cost = result.estimatedCostUsd == null ? "n/a" : `$${result.estimatedCostUsd.toFixed(6)}`;
    console.log(`${result.score} choices=${result.choices || "n/a"} ${result.latencyMs}ms ${cost}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(__dirname, "results", `math-worksheet-image-benchmark-${stamp}.json`);
  const csvPath = path.join(__dirname, "results", `math-worksheet-image-benchmark-${stamp}.csv`);
  fs.writeFileSync(jsonPath, JSON.stringify({ imagePath, expectedChoices, pricesPerMillion, results }, null, 2));

  const rows = [
    ["model", "score", "choices", "validJson", "problemCount", "status", "latencyMs", "inputTokens", "outputTokens", "totalTokens", "estimatedCostUsd", "error"],
    ...results.map((item) => [
      item.model,
      item.score,
      item.choices,
      item.validJson,
      item.problemCount,
      item.status,
      item.latencyMs,
      item.inputTokens,
      item.outputTokens,
      item.totalTokens,
      item.estimatedCostUsd == null ? "" : item.estimatedCostUsd.toFixed(8),
      item.error
    ])
  ];
  fs.writeFileSync(csvPath, rows.map((row) => row.map(csvEscape).join(",")).join("\n") + "\n");

  console.log("\nExpected choices: " + expectedChoices.join(""));
  for (const result of results) {
    const cost = result.estimatedCostUsd || 0;
    console.log(`${result.model}: ${result.score}, avg call ${result.latencyMs}ms, est $${cost.toFixed(6)}`);
  }
  console.log(`JSON: ${jsonPath}`);
  console.log(`CSV:  ${csvPath}`);
})().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
