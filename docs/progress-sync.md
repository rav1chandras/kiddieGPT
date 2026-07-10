# KiddieGPT progress sync — contract sketch

The extension tracks student activity (missions built, flashcards reviewed,
quizzes with scores + which questions were missed, math problems solved, tutor /
explain / writing usage) in `chrome.storage.local`. That store is **device-only**:
a parent on another device or browser profile sees nothing, and clearing browser
data wipes it. This doc is the contract for syncing that activity to the backend
so the **parent portal progress screen** can show it. The extension side is
already built against this contract.

## Why
- Local storage can't power a parent portal (wrong device, cleared on cache-clear).
- Progress must live server-side, keyed by student, readable by the owning parent.
- This is **separate from metering**: `/api/usage/report` counts calls for quota
  enforcement; `/api/progress` is the parent-facing learning record. Don't conflate them.

---

## 1. Data model — the day bucket

The extension keeps one bucket per student per calendar day (local date, `YYYY-MM-DD`)
and prunes to a rolling 7 days locally. The bucket is the unit of sync:

```jsonc
{
  "lessons": 1,          // Study Missions built
  "cardsReviewed": 8,    // flashcard flips
  "mathSolved": 3,       // math problems solved
  "tutorLessons": 1,     // tutor voice lessons generated
  "explains": 2,         // Explain-this runs
  "writingChecks": 1,    // Writing Studio runs
  "lastLesson": "Photosynthesis",
  "quizzes": [
    {
      "title": "Photosynthesis",
      "score": 7,
      "total": 10,
      "ts": 1720483200000,
      "missed": [                       // the actionable part for parents
        { "q": "What gas do plants take in?", "answer": "Carbon dioxide", "chosen": "Oxygen" },
        { "q": "Where does it happen?",       "answer": "Chloroplasts",   "chosen": "(blank)" }
      ]
    }
  ]
}
```

Field notes:
- Counters are **cumulative for the day** — the client re-sends the whole bucket as it grows.
- `missed` is trimmed client-side (≤12 items, question ≤100 chars, answer/chosen ≤60).
- `chosen` is `"(blank)"` when the student left the question unanswered.

---

## 2. Endpoints

Both are called via the existing portal base URL with the parent's bearer token
(`Authorization: Bearer <accessToken>`, `X-Device-Id: <deviceId>` per the
[backend-proxy](backend-proxy.md) auth model).

```
POST /api/progress
  body: { childId, date, bucket }        # date = "YYYY-MM-DD", bucket = section 1
  -> 200 { ok: true }
  -> 401 { error: "auth_required" }       # client re-auths
  # UPSERT semantics: replace (or merge) this student's record for this exact day.
  # The client sends the same day repeatedly (debounced) as activity accrues, so
  # the handler MUST be idempotent — last write for a given (childId, date) wins.

GET /api/progress?childId=<id>&days=7
  -> 200 { days: [ { date, bucket }, ... ] }   # newest-first or by date; portal aggregates
  -> 403 { error: "not_your_child" }            # requester doesn't own this childId
```

### Extension behaviour (already implemented)
- After **any** activity log, `persistActivity()` debounce-fires
  `syncActivityToPortal()` (1.5 s) → `POST /api/progress` with today's bucket.
- **No-op when signed out or in test mode** (`OTP_TEST_TOKEN`) — nothing is sent.
- Best-effort: a failed sync is swallowed and retried on the next event (offline-tolerant).
- The client owns `childId` selection via `portalSession.childId`.

So the backend only needs to **store on POST** and **return on GET**.

---

## 3. Backend responsibilities

| Concern | Rule |
|---|---|
| **Ownership** | On both POST and GET, verify the authenticated parent owns `childId`. Never trust the client's `childId` alone. |
| **Idempotency** | `(childId, date)` is the key. Re-POSTing a day replaces/merges it — no duplicate rows, no double-counting. |
| **Merge vs replace** | Replace is simplest and safe (client bucket is the source of truth for that day). If multiple devices write the same day, prefer max-of-counters + union-of-quizzes to avoid one device clobbering another. |
| **Retention** | Client prunes to 7 days; server may keep longer for trends/report cards. Serve whatever `days` asks for. |
| **Validation** | Clamp counter sizes and `quizzes`/`missed` array lengths server-side too (defense against a tampered client). |
| **PII** | Buckets contain no student name/email — only counts, quiz titles, and question text. Keep it that way; don't enrich with identifiers. |

---

## 4. Parent portal (reads GET /api/progress)

The portal renders the same shape the extension shows locally, aggregated over the
requested window:
- Six stat tiles: Missions built · Flashcards reviewed · Quizzes taken · Math
  problems solved · Tutor lessons · Explain & Writing.
- Daily-activity bar chart (sum of all actions per day).
- Recent quiz scores with a **"N to review"** expansion listing each missed
  question → correct answer (and what the student chose). This is the headline
  parent value: *what* to help with, not just a percentage.

---

## 5. Suggested sequence
1. `POST /api/progress` upsert + `GET /api/progress` read, with ownership checks — unblocks the parent progress screen.
2. Multi-device merge (max counters, union quizzes) once households use >1 device.
3. Longer retention + trend/report-card views in the portal.

No extension changes are required to ship the parent progress screen — the client
already emits everything above. This is backend + portal work only.
