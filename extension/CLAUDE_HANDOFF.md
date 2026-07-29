# KiddieGPT Extension Handoff

This is a Chrome side-panel extension for K-8 students. Work only in the
`extension/` directory. Do not change the webapp or portal files unless Ravi
explicitly asks. The working tree is intentionally dirty; do not reset or
discard existing changes.

## Current Runtime Surface

- `sidepanel.html`: Home/dashboard, Study Mission/PDF panel, Math Step Tutor,
  and Settings. Several older tool views were consolidated into Home or
  Study Mission; inspect the current markup before adding a new screen.
- `sidepanel.js`: all view state, portal auth/usage, AI requests, math
  rendering, PIN gate, study mission, quiz, flashcards, explain, and tutor
  flows.
- `styles.css`: current KiddieGPT visual system. Preserve the dark green,
  lime, white, and pale green palette and responsive side-panel layout.
- `manifest.json`, `background.js`, `icons/`: extension runtime and capture
  support.
- `katex/`: local KaTeX assets used for textbook-style math output.

## Math Hybrid Approach

The purpose of the hybrid flow is to avoid sending the original image to
every downstream request.

### Image or local-file input

1. `transcribeMathProblems()` sends the image/file once to the AI reader.
2. It returns text problems, choices, diagram text, and a limited right-triangle
   figure description.
3. The first problem is solved with `solveMathOnce()` using text only.
4. Additional problems are solved one at a time using text only.
5. The automatic independent checker is **not** called during the normal solve
   path. `verifyMathProblemInPlace()` still exists for correction/escalation
   paths, but do not reconnect it to every normal solve without measuring cost.

### Visual escalation

- `mathVisionEscalation` is false for normal solving.
- Complex diagram keywords such as circle, semicircle, tangent, chord, radius,
  and arc can trigger a focused visual retry when the first text solve fails.
- Correction requests can also escalate to the original visual source.
- Do not resend the image for ordinary formatting, answer display, or follow-up
  UI changes.

### Typed input

Typed/pasted math skips image transcription and makes one text-only solve call.

### Token behavior

The latest local test recorded 2 math requests and 2,298 tokens for one image
problem. The old packaged copy had the older multi-call flow, which caused the
larger usage reports. Rebuild and reload the current extension before judging
token behavior.

## Math UX and Output Contract

- Math has `Help Me` and `Solution` modes.
- Help Me is a single white panel containing the key concept, the key formula
  when available, and up to five short next-step lines that guide the student
  without revealing the final answer.
- Do not add a separate `Try these steps` card or `Your turn` section.
- Solution contains textbook-style derivation lines, a check, and an answer.
- KaTeX is used for fractions, roots, powers, vectors, combinations, and
  textbook equations. AI math fields must be inline LaTeX without `$` or
  `\\(...\\)` delimiters.
- Multiple-choice answers should show the option letter first in the light
  green square `.ma-option` badge, followed by the expression.
- The answer option matcher handles `B`, `Option B`, `(B)`, `\\text{(B)}`,
  and an exact match against the listed choice text. Do not make it match an
  arbitrary trailing variable such as the `B` in `a + B`.
- Parent PIN/answer gating is controlled by `mathAnswerGate`,
  `mathParentPinHash`, and the portal `requireSteps` control. Preserve the
  local-dev bypass behavior only for localhost testing.

## Current Math Correction UX

- The correction toggle says `Something not right?`.
- The panel heading says `How can I help?`.
- It uses polite predefined pills rather than a free-text input:
  - Question looks different
  - Answer seems off
  - This step is confusing
  - Make it simpler
  - Try another way
  - Check the choices
- Keep the correction request compact and use the selected pill as the AI
  correction note.

## Other High-Impact Changes Already Present

- Home/dashboard is the primary entry screen; the menu no longer needs a
  redundant standalone Tools screen.
- Learning tools use a compact horizontal browsing/selection experience.
- Study Mission supports Active tab versus Local file source selection,
  mission generation, challenge level, and practice handoff to flashcards and
  quiz.
- Quiz supports source-aware generation, 15-question sets, pagination,
  answered progress, submit/score feedback, wrong-answer review, retake, and
  next-set actions.
- Flashcards support term/clue direction, literal flip interaction, stable
  responsive card sizing, left/right navigation, new-set generation, and
  card-specific follow-up help.
- Explain and screenshot workflows share the kid-facing explanation pattern
  and follow-up correction behavior.
- Tutor Mode can use mission or active-tab context, generates a teacher-like
  voice lesson, plays audio in the extension, and supports downloading audio
  for later/offline playback where enabled.
- Settings consolidate student preferences, reading level/focus, OpenAI demo
  configuration, answer protection, and local testing controls.
- Parent-facing summaries and progress logs belong in the portal, not inside
  the student extension.

## Local Testing

- Local-only settings live in the ignored file `extension/local-settings.js`.
  Never ship that file; it may contain a local portal URL or a demo key.
- For local development, load the unpacked folder:
  `/Users/ravi/Desktop/Dev/KiddieGPT/extension`
- The release build intentionally excludes `local-settings.js`.
- Build from `extension/` with `./build.sh`.
- The generated release bundle is:
  `extension/dist/kiddiegpt-1.4.0.zip`
- After source edits, reload the unpacked extension in `chrome://extensions`.
  Do not test an older `dist` copy and assume source changes are live.

## Guardrails For Future Changes

1. Read the existing renderer and state flow before editing.
2. Search for all call sites before changing a math or portal function.
3. Keep UI-only changes separate from AI prompt/transport changes.
4. Never restore automatic verification or resend image parts without checking
   request count and measured token usage.
5. Do not remove an existing behavior to simplify a visual section; consolidate
   its presentation while preserving the underlying data and interactions.
6. Run Node syntax check, `git diff --check`, and `./build.sh` after changes.

Useful checks:

`node --check extension/sidepanel.js`
`git diff --check`
`cd extension && ./build.sh`
