# QR phone-capture → extension result — spec / handoff

Let a student photograph a **physical-book** math problem with their phone and have
the solved result appear in the **KiddieGPT browser extension** on their laptop.
The phone is just a camera; the portal does the AI work; the result renders in the
extension. This doc is the contract for both halves. The **portal owns the bulk**;
the extension half is small and waits on these endpoints.

## Flow
```
Extension: "Scan with phone" → POST /api/capture/session → gets token → shows QR (captureUrl)
   ↓ student scans with phone camera
Phone opens GET /capture/:token  → native camera → snaps the book problem → uploads
   ↓
Portal: validates token → transcribes the image (vision) → stores the transcription
        → "Sent! Check your KiddieGPT extension." on the phone (no result on phone)
   ↓ extension polls GET /api/capture/:token/result
Extension: pulls the transcription → runs its normal solve → verify → render pipeline
```

## Key design decision — portal **transcribes**, extension **solves**
The portal converts the **image → text** (vision transcription only). It does **not**
run the full solve. The extension pulls the transcribed text and runs its existing
`solve → verify → render` flow (which already routes model calls through the portal
proxy). Why:
- The math **solve/verify prompts are the moat** and live in the extension as the
  single source of truth — don't duplicate them server-side.
- Reuses the extension's whole math pipeline (steps, answer-gate, "fix it", render).
- **The raw image never reaches the laptop** — only the transcribed text does. (Honors
  the "don't drag the image down" goal.)

(Alternative, if you ever move the math prompts server-side: the same result endpoint
can return fully solved `problems` and the extension just renders them. Not recommended now.)

---

## Portal endpoints (to build)

### 1. `POST /api/capture/session`  (auth: parent bearer)
Extension mints a short-lived capture session bound to the signed-in parent + child.
```jsonc
// req body
{ "childId": "c1", "gradeBand": "6-8" }
// 200
{ "token": "cap_9f3...", "captureUrl": "https://app.kiddiegpt.com/capture/cap_9f3...", "expiresAt": 1720999999999 }
```
- Token: opaque, unguessable, **~5 min TTL**, bound to `{ familyId, childId }` from the auth.
- `captureUrl` must be a **public URL a phone browser can open** (see dev note below).

### 2. `GET /capture/:token`  (no auth — the token IS the scoped credential)
Serves a tiny **mobile capture page** (HTML). Requirements:
- If token missing/expired/used → friendly "This link expired, generate a new QR in KiddieGPT."
- Else: a big camera button using `<input type="file" accept="image/*" capture="environment">`,
  a preview, and a **Send** button that POSTs to endpoint 3.
- On success → show **"Sent! Check your KiddieGPT extension."** and stop. **Never show a result.**

### 3. `POST /api/capture/:token/image`  (no auth — token-scoped)
Phone uploads the photo (multipart `image/*`, or base64 JSON — your call).
- Validate token (exists, not expired, not already used). Enforce size (~5 MB) and image type.
- Mark token **used** (single upload).
- **Transcribe** the image server-side (vision) into text problems using the transcription
  prompt (see "Transcription contract" below). Run the result through **moderation**.
- **Delete the image** right after transcribing (transient — it holds a photo of a kid's book).
- Store the transcription against the token with status `ready` (or `error` + reason).
- `-> 200 { ok: true }` (the phone doesn't need the content).

### 4. `GET /api/capture/:token/result`  (auth: parent bearer, must own the session)
Extension polls this every ~2 s while the QR is showing.
```jsonc
// 200 — one of:
{ "status": "waiting" }                       // no upload yet
{ "status": "solving" }                        // uploaded, transcribing
{ "status": "ready", "problems": [ /* see below */ ] }
{ "status": "error", "reason": "not_math" }    // e.g. blurry / not a math problem
{ "status": "expired" }
// 403 if the caller doesn't own this token's session
```

### Transcription contract (`problems`)
Match what the extension's transcriber already produces so the extension can drop it
straight into its solve flow. Each problem:
```jsonc
{ "statement": "Find b in a right triangle with hypotenuse 8 and one leg 4.",
  "diagram": "Right triangle, right angle at C, hypotenuse AB=8, leg AC=4, unknown BC=b.",  // "" if none
  "meta": "Geometry · right triangle" }
```
If no readable math: `{ "status": "error", "reason": "<short kid-friendly reason>" }`.
Use the **same transcription instruction** as the extension's `transcribeMathProblems`
(the "KiddieGPT's math reader… read every number/label/angle… don't solve" prompt) so
output is consistent.

---

## Security / lifecycle (kids' product — important)
- Token: **unguessable, single-use for upload, ~5 min TTL, scoped to `{familyId, childId}`**. Never an open upload endpoint.
- The capture page needs **no login** (kid-friendly) — the token is the only credential, so keep TTL short and one-shot.
- **Image is transient** — deleted immediately after transcription; never persisted.
- Transcription output runs through **existing moderation**.
- Rate-limit session creation per parent (stops QR spamming).

## Dev note (phones can't reach `localhost`)
In local dev the portal is `localhost:8080`, which a phone **cannot** open. For testing,
`captureUrl` must use the laptop's **LAN IP** (e.g. `http://192.168.x.x:8080/capture/...`)
with the phone on the same Wi-Fi, or a tunnel (ngrok/Cloudflare Tunnel). Production uses the
real public origin.

---

## Extension side (I build this — small, once the endpoints exist)
1. Add a **"Scan with phone"** source option in the Math tool (a 4th pill or a button next to Paste/Screenshot/Local file).
2. On select: `POST /api/capture/session` → render the **QR** for `captureUrl` + copy: *"Open your phone camera and scan. Snap the problem from your book."*
   - QR generation needs a **locally bundled JS QR encoder** (MV3 CSP blocks CDNs — same pattern as the bundled KaTeX). ~10 KB.
3. **Poll** `GET /api/capture/:token/result` every ~2 s. Show a *"Waiting for your phone photo…"* state; handle `expired`/`error`.
4. On `status: "ready"`: take `problems[].statement` (+ `diagram`) and feed it into the **existing** solve path (same as a pasted/transcribed problem) → solve → verify → render, with the normal answer-gate/steps.
5. States: waiting · solving · ready · expired · error. Regenerate-QR button on expiry.

The extension already has the solve/verify/render pipeline, so its only new work is: pill + session mint + QR + poll + hand the transcription into the existing flow.

---

## Sequencing
Portal-first: this needs auth (exists as OTP), a public origin, the capture page, upload
+ transcription, and transient token storage. Build it after the core portal fundamentals.
The extension half is quick and I'll wire it as soon as endpoints 1–4 are defined.
