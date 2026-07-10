#!/usr/bin/env bash
# Writing Studio – grammar "why" sanity check (DEV ONLY).
#
# Runs a set of messy K-8 sentences through the SAME prompt the extension's
# "Check my writing" mode uses, then prints each flagged issue so a human can
# judge whether the underline, the fix, and (most importantly) the grade-level
# "why" are correct and age-appropriate.
#
# This calls the real OpenAI Responses API and costs a few cents per run.
# The key is read at runtime from local-settings.js and never printed.
#
# Usage:  bash evals/writing-grammar-eval.sh
# Deps:   curl, jq  (no node required)

set -euo pipefail
cd "$(dirname "$0")/.."

# --- config -----------------------------------------------------------------
MODEL="gpt-4.1"   # match local-settings.js openaiModel
KEY="$(sed -n "s/.*openaiApiKey: *'\\([^']*\\)'.*/\\1/p" local-settings.js | head -1)"
if [ -z "${KEY:-}" ] || [ "${KEY:0:3}" != "sk-" ]; then
  echo "No OpenAI key found in local-settings.js (openaiApiKey). Aborting." >&2
  exit 1
fi

# Exact instructions + guidance strings copied from sidepanel.js runWritingCoach (grammar branch).
INSTRUCTIONS="You are KiddieGPT Writing Studio for K-8 students. Find real mechanics problems only — spelling, punctuation, capitalization, grammar, and obvious clarity slips. Keep the student's own ideas, voice, and argument; never rewrite their content or add new ideas. Return only valid JSON."

grade_guidance() {
  case "$1" in
    K-2) echo "The writer is in grade K-2. Use very simple words and short sentences. Focus on one idea, capital letters at the start, and a period at the end." ;;
    3-5) echo "The writer is in grade 3-5. Expect a clear main idea with one or two reasons and an example." ;;
    *)   echo "The writer is in grade 6-8. Expect a claim, reasons, evidence, and clear organization." ;;
  esac
}

TASK="Return JSON with an issues array (up to 12). Each issue has: text = the exact substring copied verbatim from the student's writing, as short as possible (usually one word or a few words); type = one of Spelling, Punctuation, Capitalization, Grammar, Clarity; why = one short sentence in grade-appropriate language explaining the problem; fix = the corrected version of that same substring. Keep each flagged text as small as possible — prefer fixing one word over rephrasing several, and never reorder or reword beyond the mechanical fix. For spelling, the why must name what is tricky about the word or give the correct spelling, never just \"spelled incorrectly.\" Only include genuine errors. If the writing is already clean, return an empty issues array."

# --- test set : grade | sentence | what a good check should catch -----------
# Includes clean "control" sentences to check for false positives.
read -r -d '' CASES <<'EOF' || true
K-2|i like my dog he is brown|capitalize i, add a period, two ideas run together
K-2|The cat runned away.|runned -> ran
K-2|me and jon went to the park|capitalize start, name Jon, "Jon and I"
3-5|My favrite hobby are reading books becaus it is fun.|favrite->favorite, are->is, becaus->because
3-5|Their going to bring they're books over there.|Their->They're, they're->their
3-5|we seen a eagle at the zoo yesterday|capitalize we, seen->saw, a->an, add period
6-8|Its important to recycle, because it help the planet and reduces wastes'.|Its->It's, help->helps, wastes'->waste
6-8|The experiment was effected by the cold, which effected our results.|effected->affected (both)
6-8|Me and my friends was planning to go, but we wasnt sure weather it would rain.|Me->I / were, wasnt->weren't, weather->whether
3-5|I read a great book last weekend. It was about a young explorer.|CLEAN - expect no issues
6-8|My favorite season is autumn because the leaves change color and the air feels crisp.|CLEAN - expect no issues
EOF

# --- run --------------------------------------------------------------------
pass=0; total=0
while IFS='|' read -r grade sentence expect; do
  [ -z "${grade:-}" ] && continue
  total=$((total+1))
  missing=0
  guidance="$(grade_guidance "$grade")"
  user_text="${guidance}
Student text:
${sentence}
${TASK}"

  body="$(jq -n --arg m "$MODEL" --arg i "$INSTRUCTIONS" --arg t "$user_text" \
    '{model:$m, instructions:$i, input:[{role:"user", content:[{type:"input_text", text:$t}]}]}')"

  resp="$(curl -sS https://api.openai.com/v1/responses \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${KEY}" \
    -d "$body")"

  # Extract the model's text output, strip any ``` fences, parse the issues.
  out="$(printf '%s' "$resp" | jq -r '[.output[]?.content[]? | select(.type=="output_text") | .text] | join("")' 2>/dev/null || true)"
  out="$(printf '%s' "$out" | sed -E 's/^```[a-zA-Z]*//; s/```$//')"
  issues="$(printf '%s' "$out" | jq -c '.issues // []' 2>/dev/null || echo '[]')"
  count="$(printf '%s' "$issues" | jq 'length' 2>/dev/null || echo 0)"

  echo "────────────────────────────────────────────────────────"
  echo "[$grade]  \"$sentence\""
  echo "  expect: $expect"
  if [ "$count" = "0" ]; then
    echo "  → no issues flagged"
  else
    printf '%s' "$issues" | jq -r '.[] | "  • [\(.type)] \(.text) → \(.fix)\n      why: \(.why)"'
    # sanity: does every flagged substring actually appear in the sentence?
    missing="$(printf '%s' "$issues" | jq -r --arg s "$sentence" '[.[] | .text as $t | select(($s | contains($t)) | not)] | length' 2>/dev/null || echo 0)"
    [ "$missing" != "0" ] && echo "  ⚠︎ $missing flagged substring(s) not found verbatim in the sentence (would not underline)"
  fi
  if [ "$missing" = "0" ] || [ "$count" = "0" ]; then pass=$((pass+1)); fi
done <<< "$CASES"

echo "════════════════════════════════════════════════════════"
echo "Ran $total cases. $pass had all flagged substrings locatable (underlinable)."
echo "Now read the 'why' lines above by hand — that is the real quality bar."
