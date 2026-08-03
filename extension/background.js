chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// ---- Sign-in hand-off from the parent portal --------------------------------
// The portal and the extension keep separate credentials: the portal holds a
// bearer token in its own origin's localStorage, the extension holds one in
// chrome.storage.local. Neither can read the other, so signing in on the web
// left the panel still asking. This lets the portal HAND the token over on an
// explicit click, rather than the extension scraping it.
//
// externally_connectable in the manifest already limits senders to the two
// portal origins, but that is Chrome's check on the sender's URL, not proof the
// payload is good. So the token is treated as untrusted input: verified against
// the portal before it is stored, and discarded if it does not check out.
const PORTAL_ORIGINS = ["https://app.kiddiegpt.com", "https://kiddiegpt1.vercel.app"];
const TOKEN_KEY = "kiddiegptPortalToken";
const EMAIL_KEY = "kiddiegptPortalEmail";

async function adoptPortalToken(token, origin) {
  // Ask the SAME origin that sent the token whether it is real. A token minted
  // by one environment must not unlock another.
  const res = await fetch(`${origin}/api/entitlements/me`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error("token_rejected");
  const ent = await res.json();
  await chrome.storage.local.set({
    [TOKEN_KEY]: token,
    ...(ent?.email ? { [EMAIL_KEY]: ent.email } : {})
  });
  return { active: Boolean(ent?.active), email: ent?.email || "" };
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  // sender.origin is set by Chrome, not by the page, so it is the thing worth
  // checking. Anything else is ignored silently rather than answered.
  const origin = String(sender?.origin || "").replace(/\/$/, "");
  if (!PORTAL_ORIGINS.includes(origin)) return false;
  // The portal pings before offering the button. Answer it, or a listener that
  // returns without responding closes the channel and looks like "not installed".
  if (message?.type === "KIDDIEGPT_PING") { sendResponse({ ok: true, version: chrome.runtime.getManifest().version }); return false; }
  if (message?.type !== "KIDDIEGPT_SIGN_IN") return false;
  const token = String(message.token || "");
  if (!token) { sendResponse({ ok: false, error: "no_token" }); return false; }

  adoptPortalToken(token, origin)
    .then(result => {
      // Tell an open panel to re-read its session, so the student sees the
      // signed-in state without reopening anything.
      chrome.runtime.sendMessage({ type: "KIDDIEGPT_SESSION_ADOPTED" }).catch(() => {});
      sendResponse({ ok: true, ...result });
    })
    .catch(() => sendResponse({ ok: false, error: "token_rejected" }));
  return true;   // keep the channel open for the async reply
});
