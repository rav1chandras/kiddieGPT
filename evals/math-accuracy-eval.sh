#!/usr/bin/env bash
# Math solver – accuracy regression set (DEV ONLY).
#
# The flagship tool "can't be wrong", so run this on every solver-prompt change.
# It sends a fixed set of problems (known answers) through the EXACT solver
# instructions + return-format used by solveMathOnce() in sidepanel.js, then:
#   - auto-checks the final answer contains the expected value  -> PASS/FAIL
#   - reports whether the step lines render (LaTeX markers or plain, both OK)
#   - prints the answer + lines for a human to eyeball the reasoning
#
# A drift guard warns if the prompt in sidepanel.js no longer matches the copy
# below (so this eval can't silently test a stale prompt).
#
# Costs ~1-2 cents/problem. Key read from local-settings.js, never printed.
# Usage:  bash evals/math-accuracy-eval.sh        Deps: curl, jq
#
# NOTE: diagram/image problems are NOT covered here (curl can't easily send the
# worksheet image). See the manual diagram checklist printed at the end.

set -euo pipefail
cd "$(dirname "$0")/.."

MODEL="gpt-4.1"
KEY="$(sed -n "s/.*openaiApiKey: *'\\([^']*\\)'.*/\\1/p" local-settings.js | head -1)"
if [ -z "${KEY:-}" ] || [ "${KEY:0:3}" != "sk-" ]; then
  echo "No OpenAI key in local-settings.js. Aborting." >&2; exit 1
fi

# ---- EXACT prompt copied from solveMathOnce() in sidepanel.js ---------------
INSTRUCTIONS='You are KiddieGPT Math Tutor, a careful teacher for K-8 students (support harder topics like algebra, geometry, vectors, and early calculus when the source shows them). Accuracy is critical: a wrong answer is worse than no answer. If the source contains no readable math problem — it is blank, too blurry or low-quality to read, or simply not math (like a photo, a paragraph of text, or a random screenshot) — do NOT invent a problem. Instead return exactly {"noMath": true, "reason": "<one short, kind, kid-friendly sentence explaining what you see and what to do>"} and nothing else. Otherwise: before solving, read EVERY label, number, and angle in the source and list them as givens. If there is a diagram, state exactly where the unknown sits (for example: which angle it is opposite or adjacent to) and never assume. A small square in a diagram is a right-angle mark: those two segments are perpendicular, so one of them is a height or leg — use it, and never treat a marked height as a slanted side or assume an included angle between them. Solve with the SIMPLEST method a student at the given grade would use: do not reach for an advanced technique (law of sines, trig area formula, calculus) when a basic one from the figure works, such as base times height for area or the Pythagorean theorem for a right triangle. Show the work like a whiteboard: short connected lines, each following from the one above. Always end with a check that substitutes the answer back and confirms it agrees with every given; if the check fails, redo the work before answering. Write every math expression as inline LaTeX (for example \frac{a}{b}, \sqrt{48}, x^{2}, a_{1}, 90^{\circ}, \int, \sum); do NOT wrap it in $, $$, \( \), or \[ \] delimiters, and use no markdown. If several problems are visible, split them. Return only valid JSON.'

# Drift guard: a signature phrase that must still be present in sidepanel.js.
SIG='Write every math expression as inline LaTeX'
if ! grep -qF "$SIG" sidepanel.js; then
  echo "⚠︎  DRIFT: sidepanel.js no longer contains the copied solver prompt signature."
  echo "    Re-sync INSTRUCTIONS/TASK in this script with solveMathOnce() before trusting results."
  echo
fi

TASK='Return JSON with a problems array. Each problem object must have: friendlyProblem (the original question only); givens (array of short strings, one per fact); goal (one line naming the unknown); lines (the worked solution as an array of {math, why}: math is ONE short relation as inline LaTeX — \frac{}{} fractions, \sqrt{} roots, ^{} powers, _{} subscripts, \cdot multiply — never a sentence; why is one short plain sentence); check ({math, why} substituting the answer back); answer (the final answer only, inline LaTeX). Every math field must be inline LaTeX with no $ or \( \) delimiters.'

guidance () {
  case "$1" in
    K-2) echo "Use small numbers, counting language, and simple number sentences. No algebra symbols unless the problem itself shows them." ;;
    3-5) echo "Use arithmetic reasoning in plain words. Introduce a variable only if the problem itself uses one." ;;
    *)   echo "Use pre-algebra and algebra as needed, but pick the simplest approach the problem allows and name the rule in each line." ;;
  esac
}

# normalize for loose matching: lowercase, drop spaces/$, unwrap \text, drop
# braces, and strip a leading "x=" / "=" so "x = 4", "=4", and "4" all compare equal.
norm () { printf '%s' "$1" | tr 'A-Z' 'a-z' | sed -E 's/\\frac\{([^}]*)\}\{([^}]*)\}/\1\/\2/g; s/\\text\{([^}]*)\}/\1/g; s/[[:space:]$]//g; s/\\(cdot|times)/*/g; s/\\//g; s/[{}]//g; s/^[a-z][a-z0-9_]*=//; s/^=//'; }

# Mirror the app's parseOpenAIJson repair: double lone backslashes before a
# letter so unescaped inline LaTeX (\sqrt, \times) becomes valid JSON.
repair_json () { perl -0777 -pe 's/(\\+)([a-zA-Z])/ (length($1)%2 ? $1.chr(92) : $1).$2 /ge'; }

pass=0; fail=0; total=0
# each case: grade | problem | expected-substring(s), pipe-separated alternatives
run () {
  local grade="$1" problem="$2" expect="$3"
  total=$((total+1))
  local text="Solve this math problem: ${problem}
Student grade band: ${grade}. $(guidance "$grade")
${TASK}"
  local body resp out ans lines linecount
  body="$(jq -n --arg m "$MODEL" --arg i "$INSTRUCTIONS" --arg t "$text" \
    '{model:$m, instructions:$i, input:[{role:"user", content:[{type:"input_text", text:$t}]}]}')"
  resp="$(curl -sS https://api.openai.com/v1/responses \
    -H "Content-Type: application/json" -H "Authorization: Bearer ${KEY}" -d "$body")"
  out="$(printf '%s' "$resp" | jq -r '[.output[]?.content[]? | select(.type=="output_text") | .text] | join("")' 2>/dev/null || true)"
  out="$(printf '%s' "$out" | sed -E 's/^```[a-zA-Z]*//; s/```$//')"
  # If the model emitted invalid JSON (unescaped LaTeX backslashes), repair it
  # the same way the app does before extracting fields.
  if ! printf '%s' "$out" | jq -e '.problems' >/dev/null 2>&1; then
    out="$(printf '%s' "$out" | repair_json)"
  fi
  ans="$(printf '%s' "$out" | jq -r '.problems[0].answer // "(none)"' 2>/dev/null || echo '(parse error)')"
  lines="$(printf '%s' "$out" | jq -r '[.problems[0].lines[]?.math] | join("   |   ")' 2>/dev/null || echo '')"
  linecount="$(printf '%s' "$out" | jq -r '[.problems[0].lines[]?.math] | length' 2>/dev/null || echo 0)"

  # PASS if any expected alternative (normalized) appears in the normalized answer
  local na verdict="FAIL"; na="$(norm "$ans")"
  local IFS='|'; for exp in $expect; do
    if printf '%s' "$na" | grep -qF "$(norm "$exp")"; then verdict="PASS"; break; fi
  done; unset IFS
  if [ "$verdict" = "PASS" ]; then pass=$((pass+1)); else fail=$((fail+1)); fi

  printf '[%s] %-4s  %s\n' "$verdict" "$grade" "$problem"
  printf '        answer: %s   (expected: %s)\n' "$ans" "$expect"
  printf '        steps(%s): %s\n' "$linecount" "$lines"
}

echo "Running math accuracy regression set…"; echo
# ---- K-2 -------------------------------------------------------------------
run "K-2" "What is 8 + 5?"                                          "13"
run "K-2" "What is 12 - 7?"                                         "5"
run "K-2" "There are 3 baskets with 4 apples each. How many apples in all?" "12"
run "K-2" "What is double 6?"                                       "12"
# ---- 3-5 -------------------------------------------------------------------
run "3-5" "What is 7 x 8?"                                          "56"
run "3-5" "What is 96 divided by 8?"                                "12"
run "3-5" "Add 3/4 + 1/8."                                          "7/8|0.875"
run "3-5" "Subtract 5/6 - 1/3."                                     "1/2|3/6|0.5"
run "3-5" "What is 0.25 + 0.6?"                                     "0.85"
run "3-5" "A rectangle is 7 cm by 4 cm. What is its area?"          "28"
run "3-5" "What is the perimeter of a square with side 9?"          "36"
run "3-5" "Evaluate 3 + 4 x 2."                                     "11"
# ---- 6-8 -------------------------------------------------------------------
run "6-8" "Solve for x: 2x + 3 = 11."                               "x=4|=4"
run "6-8" "Solve for x: 5x - 4 = 3x + 10."                          "x=7|=7"
run "6-8" "What is 20% of 150?"                                     "30"
run "6-8" "A right triangle has legs 6 and 8. Find the hypotenuse." "10"
run "6-8" "Find the area of a triangle with base 10 and height 6."  "30"
run "6-8" "Simplify: 2^5."                                          "32"
run "6-8" "What is -7 + 12?"                                        "5"
run "6-8" "Solve the proportion 3/4 = x/12."                        "x=9|=9"
run "6-8" "Find the area of a circle with radius 3 (use pi)."       "9pi|28.27|28.3"
# ---- higher (K-12 reach, 6-8 guidance) -------------------------------------
run "6-8" "Solve x^2 - 5x + 6 = 0."                                 "2|3"
run "6-8" "Solve 2x^2 - 4x - 6 = 0."                                "3|-1"
run "6-8" "An arithmetic sequence has first term 3 and common difference 4. Formula for the nth term?" "4n-1"
run "6-8" "Find the slope between (1, 2) and (4, 11)."              "3"

echo
echo "════════════════════════════════════════════════════════"
echo "PASS $pass / $total   (FAIL $fail)"
echo "Auto-check = final answer only. Read the steps above by hand for reasoning quality."
echo
echo "MANUAL diagram checklist (curl can't send images — test these in-app):"
echo "  • right triangle with a right-angle square + one leg + hypotenuse → correct missing leg"
echo "  • triangle with a 90° mark where the height is marked (not the slant) → uses height, not slant"
echo "  • the original trig-triangle worksheet that once over-reached to law of sines"
echo "  • a non-math photo → returns the kind 'no math here' message, does NOT invent a problem"
