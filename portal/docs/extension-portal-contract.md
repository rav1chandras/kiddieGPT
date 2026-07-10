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
