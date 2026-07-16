# Portal handoff — reviewer sign-in code + "account doesn't exist" → sign-up

Two small portal changes so the extension's new sign-in behaviour works. The
extension side is already shipped; it can only *display* what the portal returns,
so these two behaviours must come from `/api/auth/otp/request`.

Context: the extension's sign-in gate is now dismissable and Home is ungated, so
a Chrome Web Store reviewer can open the panel and see the product. To let them
actually **test the tools**, they sign in with a dedicated review account whose
code is shown on-screen (they have no inbox access). Every other user gets their
code by email only, and an unknown email is routed to sign-up.

## The review account

```
REVIEW_EMAIL = parent.kiddiegpt@gmail.com
```

This account should be a **real, active (entitled) family** on the portal with a
server-side AI key, so the reviewer gets fully working tools — not a dead demo.

---

## Change 1 — return the sign-in code on-screen ONLY for the review account

Today `POST /api/auth/otp/request` returns `testCode` whenever the mailer is in
`mock` mode (no email provider) — i.e. for **any** email. That would show a code
on-screen for real users. Restrict it to the review account.

`server.js` `/api/auth/otp/request` (~line 2194):

```js
// current
return res.json({ ok: true, mode, ...(mode === "mock" ? { testCode: otp } : {}) });

// desired: only the review account ever gets the code back in the response
const isReview = email === "parent.kiddiegpt@gmail.com";
return res.json({ ok: true, mode, ...(isReview ? { testCode: otp } : {}) });
```

With this, the review account shows its code on-screen even in production (so the
reviewer can sign in), and no one else ever sees a code in the UI. The extension
already guards the on-screen display to this same address, so both sides agree.

---

## Change 2 — unknown email → `no_account` (don't auto-create), so the extension opens sign-up

Today the login flow **auto-creates** a parent user on verify
(`server.js` ~line 2228: `if (!user) { … db.users.push(user) }`), so an unknown
email silently becomes an account and there is no "doesn't exist" signal.

Desired: **login is for existing accounts only; new users go through sign-up.**

In `POST /api/auth/otp/request`, before generating/storing the OTP, check whether
an account exists for the email. If not (and it isn't the review account), return
a 404 the extension recognises:

```js
const existing = db.users.find(u => u.email === email && u.role === "parent")
             || db.families.find(f => f.email === email);
if (!existing && email !== "parent.kiddiegpt@gmail.com") {
  return res.status(404).json({ ok: false, error: "no_account" });
}
```

And in `/api/auth/otp/verify`, drop the auto-create branch (or keep it only for
the review account) so a code can't mint a brand-new account. New accounts are
created via the existing `/api/auth/signup` flow.

### What the extension does with it
On `404 { error: "no_account" }` from the OTP request, the gate shows
*"We couldn't find a KiddieGPT account for that email. Opening sign-up so you can
create one…"* and opens `${portalBaseUrl()}/?signup=1&email=…` in a new tab.

### Nice-to-have (optional)
Have the portal webapp read `?signup=1` (and prefill `?email=`) so the tab lands
directly on the "Create account" form instead of the login form.

---

## Sequencing
Change 1 is a one-liner and unblocks Google review (reviewer can sign in and test).
Change 2 is the login-only + sign-up split; until it ships, unknown emails still
receive a code (the extension's sign-up redirect stays dormant but harmless).
