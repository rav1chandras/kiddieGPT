# Handoff to the portal (backend) — Student progress sync

> Paste this into the portal project's chat. It's self-contained. Match it to
> the portal's existing stack (DB, auth middleware, routing) — the shapes below
> are the contract the KiddieGPT extension already sends and reads against.

## Goal
The extension records student activity (quiz scores + which questions were
missed, flashcards reviewed, math problems solved, tutor/explain/writing usage,
missions built) and already POSTs it to the backend. Build the receiving side so
the **parent portal progress screen** can display it.

Ship three things: **a table**, **`POST /api/progress`** (upsert), **`GET /api/progress`** (read).

## What the extension sends (do not change this shape)
One "day bucket" per student per local calendar date (`YYYY-MM-DD`):

```jsonc
POST /api/progress
Authorization: Bearer <accessToken>          // parent session (same auth as other /api/* calls)
{
  "childId": "c_123",
  "date": "2026-07-09",
  "bucket": {
    "lessons": 1,           // missions built
    "cardsReviewed": 8,
    "mathSolved": 3,
    "tutorLessons": 1,
    "explains": 2,
    "writingChecks": 1,
    "lastLesson": "Photosynthesis",
    "quizzes": [
      {
        "title": "Photosynthesis",
        "score": 7,
        "total": 10,
        "ts": 1720483200000,
        "missed": [
          { "q": "What gas do plants take in?", "answer": "Carbon dioxide", "chosen": "Oxygen" },
          { "q": "Where does it happen?",       "answer": "Chloroplasts",   "chosen": "(blank)" }
        ]
      }
    ]
  }
}
-> 200 { "ok": true }
```

- The client re-sends the same day repeatedly (debounced) as activity grows, so
  **counters are cumulative-for-the-day** and the handler MUST be **idempotent**:
  last write for a `(childId, date)` wins. Upsert, don't append.
- The client sends nothing in test mode / signed out, so every real POST is authenticated.

## Endpoints to implement

```
POST /api/progress
  auth: required. Verify the authenticated parent OWNS body.childId (else 403 not_your_child).
  body: { childId, date, bucket }   # shapes above
  action: UPSERT row keyed (childId, date). Replace the bucket (simplest & correct).
  -> 200 { ok: true }
  -> 401 { error: "auth_required" }
  -> 403 { error: "not_your_child" }

GET /api/progress?childId=<id>&days=7
  auth: required + ownership check.
  -> 200 { days: [ { date, bucket }, ... ] }   # last N days, any order; portal aggregates
  -> 403 { error: "not_your_child" }
```

## Suggested table (adapt to your DB)
```sql
CREATE TABLE student_progress (
  child_id   TEXT        NOT NULL,
  date       DATE        NOT NULL,          -- the student's local calendar day
  bucket     JSONB       NOT NULL,          -- the day bucket, stored as-is
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (child_id, date)
);
-- upsert: INSERT ... ON CONFLICT (child_id, date) DO UPDATE SET bucket = EXCLUDED.bucket, updated_at = now();
```
JSONB keeps you flexible if the extension adds fields later. If you prefer
columns, promote the scalar counters and keep `quizzes`/`missed` as JSON.

## Rules / acceptance criteria
1. **Ownership on both routes** — never trust `childId` from the client alone; confirm it belongs to the authenticated parent.
2. **Idempotent upsert** — POSTing the same `(childId, date)` twice yields one row, no double-counting.
3. **Validation** — clamp array sizes server-side too (`quizzes` and each `missed` ≤ ~12; string lengths ≤ ~100) against a tampered client.
4. **No PII** — buckets contain counts, quiz titles, and question text only. Do not enrich with student name/email.
5. **Multi-device (optional, later)** — if two devices write the same day, prefer max-of-counters + union-of-quizzes so one device can't clobber another. Plain replace is fine for v1.

## Parent portal reads GET /api/progress and renders
- Six tiles: Missions built · Flashcards reviewed · Quizzes taken · Math problems solved · Tutor lessons · Explain & Writing.
- Daily-activity bar (sum of actions per day).
- Recent quiz scores, each with an expandable **"N to review"** listing missed question → correct answer (+ what the student chose). This is the headline value: *what to help with*, not just a percentage.

## Note
No extension changes are needed — the client already emits all of the above the
moment a real (non-test) parent session is signed in. This is backend + portal
work only.
