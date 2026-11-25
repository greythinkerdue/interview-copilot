// Background service worker (MV3).
// Responsible for: toggling the overlay on the active tab, handling keyboard
// commands, Google sign-in, and proxying API calls to the backend (fetch from
// here is not subject to the host page's CSP, unlike fetch from a content script).

const DEFAULT_BACKEND_URL = "http://localhost:3001";

async function getBackendUrl() {
  const { backendUrl } = await chrome.storage.local.get("backendUrl");
  return backendUrl || DEFAULT_BACKEND_URL;
}

async function getAuthToken() {
  const { authToken } = await chrome.storage.local.get("authToken");
  return authToken || null;
}

async function authHeaders() {
  const token = await getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function ensureInjected(tabId) {
  try {
    // content.js builds a shadow DOM and loads overlay.css into it itself
    // (page-level insertCSS can't reach inside a shadow root).
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  } catch (e) {
    console.warn("Intervue: could not inject into this tab", e);
  }
}

async function toggleOverlay(tab) {
  if (!tab || !tab.id) return;
  await ensureInjected(tab.id);
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "IC_TOGGLE_OVERLAY" });
  } catch (e) {
    // content script may not have been ready; ignore
  }
}

chrome.action.onClicked.addListener((tab) => {
  toggleOverlay(tab);
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (command === "toggle-overlay") {
    toggleOverlay(tab);
  } else if (command === "toggle-listening") {
    await ensureInjected(tab.id);
    chrome.tabs.sendMessage(tab.id, { type: "IC_TOGGLE_LISTENING" }).catch(() => {});
  } else if (command === "copy-answer") {
    await ensureInjected(tab.id);
    chrome.tabs.sendMessage(tab.id, { type: "IC_COPY_ANSWER" }).catch(() => {});
  }
});

// ---------------- Google sign-in ----------------
// Chrome extensions can't use the website's Google Identity Services button
// directly (no stable origin for Google to redirect back to), so this runs a
// real OAuth2 authorization-code flow via chrome.identity.launchWebAuthFlow,
// then hands the code to our own backend to exchange server-side - the exact
// same backend auth logic the website uses (see backend/src/auth.js).
async function signInWithGoogle() {
  const backendUrl = await getBackendUrl();
  const configRes = await fetch(`${backendUrl}/api/config`);
  const config = await configRes.json();
  if (config.mode !== "postgres" || !config.googleClientId) {
    throw new Error("This backend is running in local single-user mode - sign-in isn't needed (or isn't configured on the hosted backend yet).");
  }

  const redirectUri = chrome.identity.getRedirectURL();
  const authUrl =
    `https://accounts.google.com/o/oauth2/v2/auth` +
    `?client_id=${encodeURIComponent(config.googleClientId)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent("openid email profile")}` +
    `&prompt=consent`;

  const responseUrl = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  const code = new URL(responseUrl).searchParams.get("code");
  if (!code) throw new Error("Google sign-in was cancelled or did not return a code.");

  const exchangeRes = await fetch(`${backendUrl}/api/auth/google/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, redirectUri }),
  });
  const data = await exchangeRes.json();
  if (!exchangeRes.ok) throw new Error(data.error || "Sign-in failed.");

  await chrome.storage.local.set({ authToken: data.token, authEmail: data.email });
  return { email: data.email };
}

async function signOutGoogle() {
  await chrome.storage.local.remove(["authToken", "authEmail"]);
}

async function getAuthStatus() {
  const { authToken, authEmail } = await chrome.storage.local.get(["authToken", "authEmail"]);
  return { signedIn: !!authToken, email: authEmail || null };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "IC_GENERATE_ANSWER") {
    (async () => {
      try {
        const backendUrl = await getBackendUrl();
        const res = await fetch(`${backendUrl}/api/generate-answer`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(await authHeaders()) },
          body: JSON.stringify(message.payload),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Backend error ${res.status}`);
        sendResponse({ ok: true, data });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true; // keep the message channel open for the async response
  }

  if (message?.type === "IC_HEALTH_CHECK") {
    (async () => {
      try {
        const backendUrl = await getBackendUrl();
        const res = await fetch(`${backendUrl}/api/health`, { method: "GET" });
        const data = await res.json();
        sendResponse({ ok: res.ok, data });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (message?.type === "IC_SIGN_IN") {
    signInWithGoogle().then(
      (result) => sendResponse({ ok: true, ...result }),
      (err) => sendResponse({ ok: false, error: err.message || String(err) })
    );
    return true;
  }

  if (message?.type === "IC_SIGN_OUT") {
    signOutGoogle().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === "IC_AUTH_STATUS") {
    getAuthStatus().then((status) => sendResponse({ ok: true, ...status }));
    return true;
  }
});
