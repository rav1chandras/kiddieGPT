# KiddieGPT — handover for the web / marketing chat

Everything the `_web` chat needs to build the marketing site. Screenshots are
provided separately (4 key screens, described in §6). This describes the product
*as it actually behaves in the extension today* — see §8 for what's safe to
claim vs. what depends on the backend (don't over-promise those).

---

## 1. One-liner
**KiddieGPT — a kid-safe AI study copilot that teaches, not just answers.**
A Chrome side-panel extension for grades K-8 (works up to K-12) that turns any
homework problem, page, or worksheet into a guided, checked, step-by-step lesson.

Tagline options:
- "Smart help. Clear answers. Better learning."
- "Homework help that teaches — with a parent in the loop."
- "The AI tutor that shows the work."

## 2. Who it's for
- **Parents of K-8 students** who want homework help that doesn't just hand over answers.
- **Homeschool families** needing a patient, on-demand tutor across subjects.
- Secondary: **middle/early-high-school students** (math rendering supports algebra, geometry, early calculus).

Primary buyer = **the parent** (they install it, set controls, see progress). Primary user = **the kid**.

## 3. What it does — the five tools
1. **Math Tutor** *(the flagship)* — Type, screenshot, or upload a problem. It reads every number/label, solves with the *simplest grade-appropriate method*, shows a **textbook-quality worked solution** (real math typesetting via KaTeX), and **checks its own answer with a second independent pass**. Answers stay hidden behind the steps (optionally a parent PIN) so kids work first.
2. **Study Mission** — Turn a page or PDF into a full study pack: read the main idea + key terms, then **flashcards** and a **quiz**. One build, guided in the right order.
3. **Tutor Voice** — Reads a passage aloud, or gives a short spoken lesson, with **each sentence highlighting as it plays** (read-along).
4. **Writing Studio** — Underlines things to look at in the student's *own* writing, explains *why* in kid language, and lets them **choose** each fix. Coaches; never writes it for them.
5. **Explain This** — Explains the current page, selected text, or a screenshot in simple words, with follow-up questions.

## 4. Why it's different (the positioning wedge)
- **Teaches, doesn't cheat.** Answers are gated behind worked steps; Writing coaches instead of rewriting. This is the core parent-trust message — the opposite of "AI does your homework."
- **The math is checked.** A second, independent verification pass catches mistakes; the tool would rather flag uncertainty than be confidently wrong.
- **Parent in the loop.** Grade band, explanation style, an answer-reveal **PIN**, and a **progress view** of what the student practiced and which quiz questions they missed.
- **Kid-safe by design.** Grade-appropriate prompts + content moderation on AI output; no student name/email in the AI prompts.
- **Lives where homework happens** — a side panel next to the webpage/worksheet, not another tab to juggle.

## 5. Trust & safety (parents care about this — feature it)
- Answer-reveal **parent PIN** (with email-code reset).
- **Content moderation** screens AI responses before a child sees them.
- **Grade-safe** prompting tuned per grade band (K-2 / 3-5 / 6-8 / 9-12).
- **Progress & activity** for parents: missions, quizzes + scores, flashcards, and *which questions were missed* — the actionable part.
- Data stays on-device unless synced to the parent portal; prompts carry no child PII.

## 6. Screenshots (attached separately)
Real captures at true side-panel width (~400px). Suggested use on the site:
1. **home.png** — Dashboard: "Welcome back," Start Mission, a big **stars** reward tile, and the Learning Tools grid. *Use for the hero / overview.*
2. **math.png** — A quadratic solved with real math typesetting (stacked fractions, √, ±), "Given" chips, and the **answer blurred behind "Reveal answers."** *Use as the flagship "it shows the work + gates the answer" shot.*
3. **writing.png** — Student's sentence with squiggly underlines, category counts (Spelling/Grammar/…), and a "Use this fix / Keep mine" coaching card. *Use for the "coaches, doesn't cheat" message.*
4. **tutor.png** — The read-along flow (Pick a source → Tutor voice → Follow along) with a sentence highlighted mid-playback. *Use for the audio/accessibility angle.*

(Ask this chat for more — Mission, Explain, Settings, or the Math "how it works" geometry diagram — anytime.)

## 7. Brand / visual notes
- **Mascot:** a graduation-cap owl (lime/green). Friendly, smart, not babyish.
- **Palette:** deep teal-green (`#004f48`) + lime accent (`#eef6b5`) on white; dark hero cards. Rounded, soft-shadow cards; warm and clean, not clinical.
- **Voice:** encouraging, plain-spoken, parent-reassuring. Avoid "cheat/shortcut" framing.
- **Format:** it's a **Chrome extension (MV3 side panel)** → primary CTA is **"Add to Chrome."** Parents manage the account/subscription on the **web portal** (kiddiegpt.com).

## 8. Claim carefully (status honesty)
Live and demoable **now** (in the extension): all five tools, math verification, KaTeX rendering, answer PIN, on-device activity/stars, content moderation.

Depends on the **backend/portal (in progress)** — don't imply these are live yet:
- **Cross-device parent progress dashboard** (activity currently syncs *to* the portal only once the backend endpoints exist; today it's per-device).
- **Accounts, subscription/billing, multi-student switching** in production.
- **Email OTP sign-in** (currently a test flow).

So marketing can describe these as the product vision, but avoid "your parent dashboard shows X across all devices today." Soft-launch framing ("parent portal") is safe; hard specifics ("real-time cross-device sync") are not yet.

## 9. Suggested site sections
1. Hero: one-liner + "Add to Chrome" + home.png.
2. "Teaches, doesn't cheat" — math.png + the answer-gate/verification story.
3. The five tools (icon grid).
4. "A parent in the loop" — PIN, progress, grade controls (screenshots).
5. Safety/trust strip.
6. FAQ (grades, subjects, privacy, cost).
7. Footer CTA.

---
*Source of truth for behavior: the `extension/` app in this monorepo. When in doubt about a claim, check there (or ask the extension chat) rather than inventing capabilities.*
