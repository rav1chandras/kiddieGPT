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

### FE-6 — Decide whether answers should be verified at all · owner: product
**Automatic answer verification is OFF, and has been since `d62c9ed`.** That commit
removed the only call to `verifyMathProblemInPlace` and replaced it with a comment
explaining the cost reasoning. The function sat unreachable until 2026-07-27, when
it was deleted (git history has it if it is ever wanted back). `checkMathOnce` is
still live, but only when the student asks for a correction.

So a worksheet is **1 transcribe + N solve** — one call per problem, not two.

This is a product decision, not an optimisation:
- **Off (today):** ~16 calls ≈ 27k tokens for 15 problems, ~7 worksheets/day
  against the 200k account cap.
- **On, batched:** ~21 calls ≈ 35k tokens. `checkMathOnce` already accepts a
  `problems` array, so several can be verified per call — batching is only worth
  building if verification is coming back.
- **On, per problem:** ~31 calls ≈ 52k tokens, ~4 worksheets/day. Not worth it
  when batching exists.

The case for turning it back on is accuracy: the `143^°` wrong answer that reached
a student in 2026-07-26 testing is exactly what an independent checker catches. The
case against is cost, and that a second opinion is only useful if it is actually
more reliable than the first.

- Corrected 2026-07-27. The earlier version of this entry claimed ~31 calls and
  ~52k tokens per worksheet for the *current* build; that was wrong, read off
  `checkMathOnce`'s call sites without checking the enclosing function was
  reachable. Real figures are roughly half that.

---

## Shipped / handed off (kept briefly for context)
- Model config from Admin Console (standard + "OpenAI model (Adv)"), reconsider →
  Adv model. Extension side done; portal side handed to the portal chat 2026-07-24.
- FE-1 output-token ceiling: shipped 2026-07-25 as **per-tool** caps
  (`maxOutputTokens` 2000 / `maxOutputTokensLong` 8000 for transcription), both
  admin-configurable. Per-tool was load-bearing, not cosmetic: the ceiling
  multiplies across a worksheet's ~15 solve calls, so raising it globally to 8000
  takes one worksheet from ~40k tokens (20% of the daily account cap) to ~136k
  (68%). Transcription needs the larger budget and is a single call, which is
  exactly why the split is per tool. (Figures corrected 2026-07-27 — see FE-6.)
