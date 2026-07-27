# KiddieGPT — future enhancements backlog

Parked, non-blocking work. Each item notes which repo/chat owns it. When an item
ships, delete it (git history keeps the record). Newest first.

---

## Open

### FE-2 — Recover complete items from a truncated transcription · owner: extension
`parseOpenAIJson` currently fails (or drops to 1 problem) if the JSON is cut off.
Make it salvage every complete element of the `problems` array so truncation degrades
to "most problems" instead of one. Defensive backstop for FE-1.


### FE-4 — Narrow `<all_urls>` → `activeTab` · owner: extension
All tools are user-initiated, so `activeTab` likely suffices. Broad host access draws
extra scrutiny on a child-focused extension in Chrome Web Store review. Try it and
verify Explain / Tutor / Math capture flows still work.

### FE-5 — Refusal clause for off-topic follow-ups · owner: extension
Tutor / Explain / Writing follow-up prompts have no instruction to decline non-
schoolwork requests (code, general chat, adult topics). Add a short refuse-and-redirect
clause so the extension isn't trivially used as a general LLM.

---

### FE-6 — Batch the math verification pass · owner: extension
One worksheet costs ~31 AI calls (1 transcribe + 15 solve + 15 check) ≈ 52k tokens,
which is the single largest driver of account spend. `checkMathOnce` already accepts
a `problems` array but every caller passes one problem, so the verification pass
could batch several per call and cut worksheet cost ~40%.
- Not urgent: measured peak real usage is ~54k tokens/day against a 200k cap.
- Not trivial: the flow is coupled to per-problem progressive reveal, per-problem
  retry-on-failed-check, and `mathSolveToken` cancellation, so batching means
  restructuring the answer-verification path. Do it on its own, not alongside
  cost-control changes.
- Added 2026-07-25 while hardening AI cost controls.

---

## Shipped / handed off (kept briefly for context)
- Model config from Admin Console (standard + "OpenAI model (Adv)"), reconsider →
  Adv model. Extension side done; portal side handed to the portal chat 2026-07-24.
- FE-1 output-token ceiling: shipped 2026-07-25 as **per-tool** caps
  (`maxOutputTokens` 2000 / `maxOutputTokensLong` 8000 for transcription), both
  admin-configurable. Per-tool was load-bearing, not cosmetic: raising the global
  ceiling to 8000 would have multiplied across a worksheet's ~30 solve/check calls
  and cost ~264k tokens in one run, over the whole 200k daily account cap.
