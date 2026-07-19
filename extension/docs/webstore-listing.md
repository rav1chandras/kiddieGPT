# Chrome Web Store listing — reviewer notes, permissions, data disclosures

Paste-ready answers for the CWS dashboard. Everything here was checked against the
code; if the code changes, re-check before resubmitting.

---

## 1. "Notes for reviewers" (Privacy tab → Justifications → Notes)

> KiddieGPT is a homework-help side panel for K‑8/K‑12 students. The tools require a
> parent account, so please use the review account below. No email inbox access is
> needed: for this account only, the sign-in code is displayed on screen.
>
> TEST ACCOUNT
>   Email: parent.kiddiegpt@gmail.com
>   (no password — sign-in is a one-time code, shown on screen for this account)
>
> HOW TO TEST
> 1. Open a normal content page, e.g. https://en.wikipedia.org/wiki/Water_cycle
> 2. Click the KiddieGPT toolbar icon. The side panel opens on Home — no sign-in
>    required to look around.
> 3. Click "Math" in the right-hand nav. A sign-in dialog appears.
> 4. Enter parent.kiddiegpt@gmail.com and click "Send code".
> 5. The 6-digit code appears on screen for this review account. Enter it, click
>    "Verify". You now have an active test subscription.
> 6. Math: paste  2x^2 - 5x - 3 = 0  and click "Solve & Explain". You get a
>    step-by-step solution. The final answer stays blurred behind a "Reveal answer"
>    button — that is intentional, so students work the steps first.
> 7. Explain: click "Explain" in the nav, keep "Active page", click the "Explain"
>    button. You get a kid-level explanation of the Wikipedia page.
>
> NOTES FOR REVIEW
> • The on-screen code is shown ONLY for parent.kiddiegpt@gmail.com. Every other user
>   receives the code by email.
> • Home is the only screen available signed-out; all tools and Settings require the
>   parent account.
> • Account creation and billing happen on our website, not in the extension. The
>   "Create an account" link opens it in a new tab.
> • Safety: the panel refuses to read adult/gambling sites. To verify, open such a
>   site and click Explain — it declines without sending anything ("KiddieGPT only
>   helps with schoolwork").
> • Broad host access is used only to read the page the student is actively on, and
>   only after they click a tool. Nothing is read or captured in the background.
> • No ads and no third-party analytics.

---

## 2. Single purpose

> KiddieGPT provides age-appropriate homework help in a browser side panel: it explains
> the page or a selection in simpler language, reads it aloud, and walks students
> step-by-step through math problems, with parent-controlled settings.

---

## 3. Permission justifications

| Permission | Justification to paste |
|---|---|
| `activeTab` | Reads the text of the page the student is currently viewing, only when they click a KiddieGPT tool (Explain, Tutor, Math), so the AI can explain that specific content. |
| `storage` | Stores the parent's sign-in token, the selected student, grade band and tool preferences, and local study activity on the device. |
| `scripting` | Injects a small drag-to-select overlay so the student can outline the exact region of the page (a math problem or diagram) to capture, and extracts the visible article text for explanation. |
| `sidePanel` | The entire product is a Chrome side panel that opens beside the page the student is reading. |
| Host permission — `https://kiddiegpt1.vercel.app/*` (later `https://app.kiddiegpt.com/*`) | Our own backend. Handles parent sign-in, subscription checks, and proxies AI requests so the API key stays server-side rather than shipping in the extension. |
| Host permission — `https://api.openai.com/*` | Used only in the optional "bring your own API key" mode, where a parent supplies their own OpenAI key and requests go directly from the extension. |
| Broad host access (`<all_urls>`) | The student can ask for help on any page they are reading for school, so the tools must be able to read the active tab's text or capture a selected region on any site. Nothing is read or captured until the student clicks a tool. |

> NOTE: `<all_urls>` invites extra scrutiny on a child-focused extension. If review
> pushes back, the tools are all user-initiated, so `activeTab` alone is likely
> sufficient — drop `<all_urls>` and resubmit.

---

## 4. Data usage disclosures

Declare **YES** to collecting:

- **Personally identifiable information** — the parent's email address, used to sign in.
- **Authentication information** — the sign-in session token, stored on the device.
- **Website content** — text of the page the student asks about, any text they select,
  and screenshots of a region they choose to capture. Sent only when a tool is used.
- **User activity** — in-app study activity (problems solved, quiz scores, tools used)
  so parents can see progress.

Declare **NO** to: health information, financial and payment information (billing is on
our website, not in the extension), personal communications, location, and web history
(we never collect browsing history — only the page the student explicitly asks about).

**Certifications — tick all three:**
- I do not sell or transfer user data to third parties, apart from the approved use cases.
- I do not use or transfer user data for purposes unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

These are all truthful: page content is sent to our backend and on to OpenAI **as a
service provider** to generate the explanation — that is an approved "providing the
service" transfer, not a sale.

**Privacy policy URL:** must be public and reachable, e.g. `https://kiddiegpt.com/privacy.html`.
It must explicitly state: page content and captured images are sent to our servers and to
OpenAI for processing; what is retained and for how long; that the parent's email is
stored; and how to request deletion.

---

## 5. Pre-submit checklist

- [ ] Upload `extension/dist/kiddiegpt-<version>.zip` (built by `./build.sh`, never a
      hand-zipped folder — that would include `local-settings.js` and point the build
      at localhost).
- [ ] Reviewer notes pasted (section 1).
- [ ] Permission justifications pasted (section 3).
- [ ] Data disclosures + all three certifications (section 4).
- [ ] Privacy policy URL live and accurate.
- [ ] Extension ID sent to the portal so `ALLOWED_EXTENSION_ORIGINS` is set.
- [ ] Review account `parent.kiddiegpt@gmail.com` is active, entitled, and its
      on-screen code path verified against production.
