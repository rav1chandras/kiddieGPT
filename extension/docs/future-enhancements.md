# KiddieGPT — future enhancements backlog

Parked, non-blocking work. Each item notes which repo/chat owns it. When an item
ships, delete it (git history keeps the record). Newest first.

---

## Open

### FE-1 — Raise the portal output-token ceiling (per-tool) · owner: portal
The extension now requests larger `max_output_tokens` for math (transcription 8000,
solve 4000) so a full multi-problem worksheet isn't truncated. But the portal clamps
every request to `AI_MAX_OUTPUT_TOKENS` (currently 2000, `portal/lib/app.js:4024`), so
those larger budgets have **no effect** until the ceiling is raised.
- Raise `AI_MAX_OUTPUT_TOKENS` (env) to ~8000, **or** make it per-tool (transcription
  high, follow-up chat low) so the abuse cap on free-text chat stays tight.
- Added 2026-07-24, from the "worksheet solved only 1 of 3 problems" trace. The
  extension-side prompt fix (force per-item enumeration) likely resolves the common
  case; this ceiling is what lets big worksheets (6–15 problems) transcribe fully.

### FE-2 — Recover complete items from a truncated transcription · owner: extension
`parseOpenAIJson` currently fails (or drops to 1 problem) if the JSON is cut off.
Make it salvage every complete element of the `problems` array so truncation degrades
to "most problems" instead of one. Defensive backstop for FE-1.

### FE-3 — Moderation: build `/api/ai/moderations` and fail **closed** · owner: portal
`moderateFlagged` calls a portal route that doesn't exist yet and currently fails
*open*, so kid input/output isn't screened. Undercuts the "grade safe" claim. Build
the route and switch the extension guard to fail closed for a children's product.

### FE-4 — Narrow `<all_urls>` → `activeTab` · owner: extension
All tools are user-initiated, so `activeTab` likely suffices. Broad host access draws
extra scrutiny on a child-focused extension in Chrome Web Store review. Try it and
verify Explain / Tutor / Math capture flows still work.

### FE-5 — Refusal clause for off-topic follow-ups · owner: extension
Tutor / Explain / Writing follow-up prompts have no instruction to decline non-
schoolwork requests (code, general chat, adult topics). Add a short refuse-and-redirect
clause so the extension isn't trivially used as a general LLM.

---

## Shipped / handed off (kept briefly for context)
- Model config from Admin Console (standard + "OpenAI model (Adv)"), reconsider →
  Adv model. Extension side done; portal side handed to the portal chat 2026-07-24.
