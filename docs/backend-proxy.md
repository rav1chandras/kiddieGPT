# KiddieGPT backend proxy — contract sketch

The extension must stop calling `api.openai.com` directly. All model calls go
through a thin proxy that (1) holds the OpenAI key server-side, (2) authenticates
the parent, (3) enforces quota / device / abuse limits. This doc is the contract
the extension builds against and the server implements.

## Why
- The OpenAI key currently ships inside the extension → extractable, no cost control.
- Only a server can enforce quotas, device caps, and revoke access. Client-side limits are cosmetic.

---

## 1. Auth model (passwordless, 30-day, device-bound)

Parents authenticate with an email one-time code (OTP / magic link). No password
to share. Each device gets its own session.

- **Access token** — short-lived (~1 h) JWT, sent on every request. Limits blast radius if leaked.
- **Refresh token** — 30-day, **device-bound**, **server-tracked** (opaque, stored in DB so it can be revoked). This is the "ask for OTP every 30 days" timer, using **absolute** expiry (not sliding) so an always-active shared account is still forced to re-verify monthly.
- **Device id** — generated on the extension on first run, stored in `chrome.storage.local`, sent at OTP redemption so the refresh token is bound to it.

### Endpoints

```
POST /auth/request-otp
  body: { email }
  -> 200 { ok: true }            # always 200 (don't leak whether email exists)
  # server emails a 6-digit code / magic link, valid ~10 min, rate-limited per email+IP

POST /auth/verify-otp
  body: { email, code, deviceId, deviceName }
  -> 200 { accessToken, refreshToken, expiresIn, account }
  -> 401 { error: "bad_code" }
  -> 409 { error: "device_limit", devices: [...] }   # over device cap; client shows "remove a device"

POST /auth/refresh
  body: { refreshToken, deviceId }
  -> 200 { accessToken, expiresIn }
  -> 401 { error: "expired" }     # refresh token dead -> client restarts OTP flow

POST /auth/sign-out            # this device
POST /auth/sign-out-all        # revoke every device (parent action)
GET  /auth/devices             # list devices for "manage devices" UI
DELETE /auth/devices/:id       # evict a device
```

---

## 2. The AI proxy endpoint

The extension's `callOpenAIJson` / `callOpenAISpeech` / study-pack calls all become
one authenticated proxy call. The server owns the OpenAI request.

```
POST /ai/solve            # math solve / check
POST /ai/study-pack       # mission build + regenerate sets
POST /ai/tutor            # explain script
POST /ai/tts              # tutor voice
POST /ai/explain          # explain-this

  headers: Authorization: Bearer <accessToken>, X-Device-Id: <deviceId>
  body:   { task, gradeBand, input, parts }   # task-specific payload
  -> 200  { ...model JSON... , usage: { in, out, costCents } }
  -> 401  { error: "token_expired" }      # client refreshes, retries once
  -> 429  { error: "rate_limited", retryAfter }
  -> 402  { error: "quota_exceeded", resetsAt }   # daily/monthly cap hit
```

Server-side per call: validate token+device → check quota → call OpenAI with the
server-held key → log token usage/cost → return.

---

## 3. Abuse / cost / sharing controls (all server-side)

| Control | Rule | Purpose |
|---|---|---|
| **Per-account quota** | shared pool, e.g. 30–40 solves/day (free), higher (paid); hard 200/day ceiling | cost cap + makes sharing self-limiting (one pool for all who share) |
| **Rate limit** | e.g. 5–10 AI calls/min per account | stop bursts draining quota in seconds |
| **Device cap** | 3–5 devices/account, household-generous; new device over cap → evict oldest or block | blocks friend-group sharing; OTP bound at redemption = 1 code → 1 device slot |
| **30-day re-auth** | absolute refresh-token expiry, per device | monthly re-verify = parent must forward a fresh code to each shared device → friction |
| **Concurrency anomaly** | same account active from many distant IPs at once → throttle/flag | detect what quota+cap miss |
| **Global budget kill-switch** | month spend > $X → pause all AI | last-resort backstop against a spike |
| **Usage logging** | store `usage` per call (tokens, cost) | ground-truth cost per account; alerts |

Design intent: you can't *prevent* sharing — you make it **degrade the experience
and cost the sharer** (shared quota + monthly re-auth) so it isn't worth it, while
keeping a real family (parent phone + a few kids' devices) comfortable.

---

## 4. Extension changes required

1. **Remove** `host_permissions` for `api.openai.com`; add the proxy origin. Drop the client-side OpenAI key + Settings key UI (or keep only for a dev bypass).
2. **Device id** on first run → `chrome.storage.local`.
3. **Auth gate**: the parent sign-in modal calls `/auth/request-otp` then `/auth/verify-otp`; store tokens; block tools until signed in.
4. **Token handling**: attach `accessToken`; on `401` call `/auth/refresh` once and retry; on refresh `401` → re-show OTP.
5. **Replace** `callOpenAIJson` / `callOpenAISpeech` / study-pack fetches with `POST /ai/*` to the proxy.
6. **Handle** `402` (quota) and `429` (rate) with friendly messages; surface `resetsAt`.
7. **"Manage devices"** + "Sign out all" in Settings (uses `/auth/devices`).

---

## 5. Suggested stack
- Cloudflare Worker or small Node/Fastify service.
- DB (D1 / Postgres / KV): accounts, devices, refresh tokens, daily usage counters.
- Email via Resend/Postmark/SES for OTP.
- Stripe later for paid tiers → sets each account's quota + device cap.

Sequence to ship: proxy + OTP auth + per-account quota first (unblocks the key
removal and cost control), then device cap + 30-day tokens, then concurrency +
Stripe tiers.
