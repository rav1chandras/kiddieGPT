# KiddieGPT — future enhancements backlog

Parked, non-blocking work. Each item notes which repo/chat owns it. When an item
ships, delete it (git history keeps the record). Newest first.

---

## Open


### FE-4 — `<all_urls>`: do NOT swap for `activeTab` · owner: extension
Broad host access draws extra scrutiny on a child-focused extension, so the original
plan was to drop `<all_urls>` and rely on `activeTab`. **Investigated 2026-07-27 and
rejected** — it breaks the product in two ways, the second worse than the permission
it was meant to avoid.

1. **`activeTab` does not fit a side panel.** It is granted by a gesture on the
   *extension* (toolbar icon, context menu, shortcut) and only for the tab active at
   that moment. The panel stays open across tab switches, so: open the panel on tab
   A, switch to tab B, click Explain -> `scripting.executeScript` runs against a tab
   that was never granted and fails. Clicking a button inside the panel is not a
   gesture on the action, so it grants nothing. Affects all 3 executeScript sites and
   all 4 captureVisibleTab calls.

2. **It silently disables the adult-site blocklist.** `tab.url` is only readable with
   host permission or the `tabs` permission. Without `<all_urls>` it is `undefined`
   for un-granted tabs, and the guard fails open: `isBlockedSiteUrl("")` and
   `isBlockedSiteUrl(undefined)` both return false, so the capture proceeds. That is
   the exact check the store listing invites the reviewer to test ("open such a site
   and click Explain — it declines without sending anything"), on a children's
   product.

Note `tabs` is redundant while `<all_urls>` is present — host permission already
makes `tab.url` readable, which is why the blocklist works today. Adding it now
changes nothing.

**Recommendation:** keep `<all_urls>` and answer the concern in the listing, which
already makes the right argument (nothing is read until the student clicks a tool;
no background access). If review pushes back, the real alternative is
`optional_host_permissions` with `<all_urls>` requested on first use: the student
grants once, both problems above go away, and the manifest no longer *requires*
broad access. More work than a manifest edit, but it solves the problem instead of
trading it for a safety hole.


---

## Shipped / handed off (kept briefly for context)
- FE-6 automatic answer verification: **closed 2026-07-29, decided against.**
  Verification stays off. A worksheet remains 1 transcribe + N solve — one call
  per problem, ~16 calls / ~27k tokens for 15 problems, ~7 worksheets/day against
  the 200k account cap. Turning it back on cost ~35k batched or ~52k per problem
  for a second opinion that is not demonstrably more reliable than the first.
  `checkMathOnce` stays live for student-requested corrections only. This is now
  a standing rule, not a backlog item — see guardrail 4 in CLAUDE_HANDOFF.md.
- FE-2 truncation salvage: shipped 2026-07-29. closeTruncatedJson discards the
  incomplete tail and closes the open brackets, so a cut-off worksheet degrades to
  "most problems" instead of an error. Reachable from parseOpenAIJson only after
  every clean parse has failed, so it cannot alter a well-formed response.
- FE-5 prompt-injection guard: shipped 2026-07-29. UNTRUSTED_CONTENT_GUARD is on
  all six prompts that ingest a page, file or image; UNTRUSTED_TEXT_GUARD (which
  adds refuse-and-redirect) is on the five that take student free text.
- Model config from Admin Console (standard + "OpenAI model (Adv)"), reconsider →
  Adv model. Extension side done; portal side handed to the portal chat 2026-07-24.
- FE-1 output-token ceiling: shipped 2026-07-25 as **per-tool** caps
  (`maxOutputTokens` 2000 / `maxOutputTokensLong` 8000 for transcription), both
  admin-configurable. Per-tool was load-bearing, not cosmetic: the ceiling
  multiplies across a worksheet's ~15 solve calls, so raising it globally to 8000
  takes one worksheet from ~40k tokens (20% of the daily account cap) to ~136k
  (68%). Transcription needs the larger budget and is a single call, which is
  exactly why the split is per tool. (Figures corrected 2026-07-27 — see FE-6.)
