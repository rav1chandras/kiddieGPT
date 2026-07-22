# KiddieGPT — Extension ↔ Portal Contract (v1)

Status: draft for the revamp. This is the boundary that turns the admin console's
mock telemetry into real data.

## Roles
- **Portal** (`server.js`): source of truth for accounts, entitlements, AI config,
  usage limits, and now usage telemetry.
- **Extension** (side panel): authenticates as a parent, checks entitlement before
  unlocking tools, respects daily caps, and reports usage after each action.

## Auth
- Extension shows a parent sign-in (reuses existing `POST /api/auth/login`).
- On success it stores the returned Bearer token in `chrome.storage.local`
  (`kiddiegptPortalToken`) and sends `Authorization: Bearer <token>` on every call.
- Tokens are stateless HMAC (`verifyToken`); TTL from `AUTH_TOKEN_TTL_HOURS`.
- On 401 → clear token, show sign-in. On 423 (locked) → show "account locked".

## CORS (new — required)
Extension origin is `chrome-extension://<id>`, so the portal must send CORS headers
for the extension endpoints: allow the extension origin, `Authorization` +
`Content-Type` headers, methods `GET,POST,OPTIONS`, and answer preflight `OPTIONS`.
Configurable via `ALLOWED_EXTENSION_ORIGINS` (comma-separated; `*` allowed for dev,
but credentials are not used so `*` is acceptable).

## Endpoints

### GET /api/entitlements/me  (exists)
The gate. Returns `{ active, status, locked, plan, familyId, ... }`.
Extension unlocks paid tools only when `active === true`.
Also carries the **tutor voice policy** the extension uses to build the student
voice picker:
```
{ ..., ttsAllowedVoices: string[], ttsDefaultVoice: string, ttsModel: "gpt-4o-mini-tts" }
```

### Tutor voice (TTS) — admin-controlled, student-chosen
Text-model routing (`openaiModel`, e.g. `gpt-5.6-luna`) is **separate** from the
tutor voice. The TTS model is pinned to `gpt-4o-mini-tts`.

- **Admin** (portal → AI & Usage → Tutor voice) controls `ttsAllowedVoices`
  (shortlist from the 13 supported voices) and `ttsDefaultVoice`. Server
  validation: only supported voices, never empty (falls back to
  `["marin","cedar","sage"]`), and the default must be in the shortlist
  (auto-fixed to marin → cedar → sage otherwise).
- **Student** (extension → Settings → Tutor voice) picks from the admin shortlist
  only. If their saved voice is no longer allowed, it resets to the admin default.
- **Voice resolution** (both client and `POST /api/ai/speech` server-side):
  student pick if allowed → admin default → marin → cedar → sage → first allowed.
- Recommended middle-school defaults: `marin`, `cedar`, `sage`.
- Exposed on both `/api/entitlements/me` (session; what the extension consumes)
  and `/api/ai/usage-limits` (`voice: { allowed, default, model }`); the admin
  read/write surface is `GET`/`PUT /api/admin/ai-settings`.

### GET /api/ai/usage-limits  (exists — to be extended)
Currently: `{ mathProblemsPerUserDaily, tutorVoiceMinutesPerUserDaily,
tutorVoiceEnabled, aiConfigured }`.
Extend with **remaining** counts for the calling family's active child so the
extension can show "3 of 20 left" and block at 0:
```
{ mathProblemsPerUserDaily, tutorVoiceMinutesPerUserDaily, tutorVoiceEnabled,
  aiConfigured, remaining: { mathProblems, voiceMinutes } }
```

### POST /api/usage/report  (new)
Called by the extension after a metered action. `requireParent`.
Request:
```
{ childId?: string,        // which student profile; defaults to family's primary
  tool: "math" | "voice" | "pdf" | "read" | "write" | "quiz" | "flashcard",
  mathProblems?: number,   // increment (default 0)
  voiceSeconds?: number,   // increment (default 0)
  at?: string }            // ISO; server uses now() if absent
```
Server behavior:
- Rejects if over the daily cap (returns `{ ok:false, reason:"cap_reached" }`).
- Increments today's counters and updates `lastExtensionUseAt`, per-tool tallies.
- Returns updated `remaining`.

### POST /api/progress  — required for the parent portal's Progress snapshot

**This is a separate feed from `/api/usage/report`, and nothing derives one from
the other.** `/api/usage/report` fills the per-tool stat tiles, the favourite-tool
line and the cap counters. The **Progress snapshot** on the parent Overview — the
days-active ring, the seven-day bar chart and the Recent activity list — reads
only `db.studentProgress`, and `POST /api/progress` is its sole writer. An
extension that reports usage but never posts progress leaves that card showing
"Your child's activity from the KiddieGPT extension will show here."

`requireParent`. Request:
```
{ childId?: string,          // must belong to this parent; omitted -> family's first child
  date: "YYYY-MM-DD",        // required; anything else -> 400 { error: "bad_date" }
  bucket: {
    lessons?: number,        // missions built
    cardsReviewed?: number,  // flashcards reviewed
    mathSolved?: number,     // math problems solved
    tutorLessons?: number,   // tutor sessions
    explains?: number,       // Explain runs
    writingChecks?: number,  // writing checks
    lastLesson?: string,     // <=100 chars, shown as the latest topic
    quizzes?: [              // <=12 per day
      { title: string,       // <=100 chars
        score: number,
        total: number,
        ts?: number,         // epoch ms; defaults to now
        missed?: [ { q: string,       // <=100 chars
                     answer: string,  // <=60
                     chosen: string } ]   // <=60, <=12 entries
      }
    ]
  } }
```

**Upsert, not increment — the one real footgun here.** The row is keyed on
`(childId, date)` and each POST *replaces* it. So send the running total for
that day, not the delta. This is the opposite of `/api/usage/report`, which
increments. Posting `{ mathSolved: 1 }` five times leaves the day at 1, not 5.

Cadence: post the current day's bucket after each session, or on a short timer
while the side panel is open. Re-posting the same day is free.

Server behavior:
- Counters clamp to 0..100000; strings truncate rather than reject.
- `childId` not belonging to the caller -> `403 { error: "not_your_child" }`.
  It is never silently reattributed to another child.
- Rows older than 120 days are pruned on write; total rows cap at 2000.
- The snapshot reads the last 7 days; `GET /api/account/progress` returns them
  per child alongside `stats`, `goals`, `remaining` and `favoriteTool`.

Which field drives what:

| Portal element | Source |
| --- | --- |
| Days-active ring (`5/7 days active`) | days in the last 7 with any bucket activity |
| Seven-day bar chart | per-day sum of all six counters + quiz count |
| "N learning actions" | same sum across the week |
| Recent activity list | `bucket.quizzes`, newest first |
| Latest topic | `bucket.lastLesson` |
| Stat tiles, favourite tool, last seen | `/api/usage/report` (not this endpoint) |

`scripts/seed-progress.js` posts a realistic week for two students through these
same endpoints — useful as a reference payload and for checking the view.

## Data model additions (per family, or per child in family.children[])
```
usage: {
  lastExtensionUseAt: ISO,
  daily: { "YYYY-MM-DD": { mathProblems, voiceSeconds, tools: { math, voice, ... } } },
  totals: { mathProblems, voiceSeconds, tools: {...} },
  favoriteTool: string        // derived
}
```
Daily buckets older than N days are pruned on write. This replaces the mock fields
the admin console currently invents (`Last extension use`, `Tool adoption`,
`Favorite tool`, `engagement`, `student risk`).

## OpenAI key strategy — OPEN DECISION
Two options (pick one before extension rewrite):
- **A. Portal proxy (recommended):** extension calls portal endpoints
  (`/api/ai/solve`, `/api/ai/speak`, …); portal holds the OpenAI key server-side and
  forwards. Key never ships in the client; caps enforced centrally; more portal code.
- **B. Served key:** authenticated parents fetch the shared key from the portal and
  call OpenAI directly. Less portal code, but the key is exposed to every client —
  same weakness as today, just centrally rotatable.

## Sequence (happy path)
1. Parent signs in → token stored.
2. `GET /api/entitlements/me` → `active:true` → unlock tools.
3. `GET /api/ai/usage-limits` → show caps/remaining.
4. Parent uses Math tutor → (proxy or direct) AI call → `POST /api/usage/report`.
5. Admin console reads families → sees real last-seen, tool adoption, remaining caps.
