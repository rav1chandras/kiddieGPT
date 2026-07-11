# KiddieGPT

A Chrome (Manifest V3) **side-panel** extension that helps K‑8 students (K‑12
capable) with homework — built around accuracy, grade-awareness, and parent
controls.

## Tools
- **Math Tutor** — type/paste a problem, screenshot it, or upload a worksheet. Solves it as a textbook-style, step-by-step derivation with a **second independent verification pass** (a wrong answer is worse than no answer). Real math typesetting via bundled **KaTeX**, app-drawn diagrams, and a parent-PIN gate that hides the final answer until steps are worked.
- **Study Mission** — turn a page or PDF into a study pack: read the main idea + key terms, then drill with flashcards and a grade-aware quiz.
- **Tutor Voice** — read a passage aloud or hear a short spoken lesson, with each sentence highlighting as it plays.
- **Writing Studio** — coach a student's own writing (assignment planning, draft feedback, and inline grammar review that explains *why* — it never writes the assignment for them).
- **Explain This** — explain the active page, a selection, or a screenshot in kid-simple words.

## Model routing
Text models are chosen per task from benchmark results (`evals/`), defined once in the
`MODELS` constant at the top of `sidepanel.js`:

| Use | Model | Notes |
|---|---|---|
| Default text — tutor explain, Study Mission, flashcards, quizzes, Explain, Writing | **gpt-5.6-luna** | Best all-round default |
| Math — solve / check / transcribe | **gpt-5.6-luna** | Same default, accuracy-tuned lane |
| Harder-math / faster fallback | **gpt-5.6-terra** | Opt-in per call |
| Premium "deep" mode | **gpt-5.6-sol** | Opt-in only, never the default |
| Tutor **voice** (TTS) | **gpt-4o-mini-tts** | Separate audio model |
| Content **moderation** | **omni-moderation-latest** | Free safety screen |

- **Luna** is the default for all text. **Terra** is the faster / harder-math fallback —
  route to it per call for tricky problems or a snappier response. **Sol** is reserved for
  a premium/deep mode and is never used by default (it's the most expensive). **`gpt-4.1`
  is no longer a default** anywhere.
- **Voice always uses `gpt-4o-mini-tts`**, independent of the text routing above; moderation
  always uses `omni-moderation-latest`.
- Override per call with `model:` on `callOpenAIJson` (or `solveMathOnce` / `checkMathOnce` /
  `transcribeMathProblems`, e.g. `model: MODELS.hardMath`). A `local-settings.js` `openaiModel`
  still overrides the default for non-math text calls.

## Safety & parent features
- **Grade-safe prompts** plus an **output moderation** pass on generated content.
- **Parent PIN** to gate math answers, with an OTP-based "Forgot PIN" reset.
- **Passwordless OTP sign-in** (email code), with a multi-student selector.
- **Activity + stars tracking** — quiz scores (including which questions were missed), flashcards, and per-tool usage, ready to sync to a parent portal.

## Repo layout
```
sidepanel.html / sidepanel.js / styles.css   The whole side-panel app
background.js / manifest.json                 MV3 service worker + manifest
katex/                                        Bundled KaTeX (MIT) for math typesetting
icons/                                        Extension icons
local-settings.example.js                     Template for local dev config (copy -> local-settings.js)
docs/                                         Backend contracts (proxy, progress sync, handoff)
evals/                                         Prompt-quality eval scripts (curl + jq)
```

## Run it locally
1. **Config:** copy the template and add a dev key
   ```
   cp local-settings.example.js local-settings.js
   # edit local-settings.js -> set openaiApiKey: 'sk-...'
   ```
   > `local-settings.js` is **gitignored** — never commit a real key.
2. **Load the extension:** `chrome://extensions` → enable *Developer mode* → *Load unpacked* → select this folder.
3. Open the side panel (toolbar icon). Sign in with the **test code `1234`**.
   In test mode the extension calls OpenAI directly with your local key; in
   production, all AI goes through a backend proxy that holds the key server-side.

## Architecture note
The extension is designed to run against a **portal backend** (not in this repo)
that holds the OpenAI key, authenticates parents, enforces quotas, and stores
progress. Until that backend exists, test mode (OTP `1234` + a local key) drives
the AI directly. The backend contracts are specced in [`docs/`](docs/):
- [`backend-proxy.md`](docs/backend-proxy.md) — auth + AI proxy + abuse controls
- [`progress-sync.md`](docs/progress-sync.md) — student progress storage
- [`portal-handoff-progress.md`](docs/portal-handoff-progress.md) — paste-ready brief for the backend

## Security
- The OpenAI key lives only in `local-settings.js` (local, gitignored) or the
  Settings field (`chrome.storage.local`). It is never committed and is stripped
  from any packaged build.
- Prompts never include a student's name or email; only schoolwork content and
  grade band are sent to the model.

## License
MIT — see [LICENSE](LICENSE). Bundles KaTeX (MIT).
