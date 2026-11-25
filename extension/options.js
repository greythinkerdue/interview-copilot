const backendInput = document.getElementById("backendUrl");
const status = document.getElementById("status");

function setStatus(msg, cls) {
  status.textContent = msg;
  status.className = cls || "";
}

async function getBackendUrl() {
  const { backendUrl } = await chrome.storage.local.get("backendUrl");
  return (backendUrl || "http://localhost:3001").replace(/\/$/, "");
}

async function authHeaders() {
  const { authToken } = await chrome.storage.local.get("authToken");
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
}

function sendToBackground(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

async function refreshAuthUI() {
  const authSection = document.getElementById("auth-section");
  const signedOut = document.getElementById("auth-signed-out");
  const signedIn = document.getElementById("auth-signed-in");
  const emailEl = document.getElementById("auth-email");
  const res = await sendToBackground({ type: "IC_AUTH_STATUS" });
  if (res?.signedIn) {
    signedOut.style.display = "none";
    signedIn.style.display = "flex";
    emailEl.textContent = res.email || "Signed in";
  } else {
    signedOut.style.display = "flex";
    signedIn.style.display = "none";
  }
}

document.getElementById("sign-in")?.addEventListener("click", async () => {
  setStatus("Opening Google sign-in...", "");
  const res = await sendToBackground({ type: "IC_SIGN_IN" });
  if (res?.ok) {
    setStatus("Signed in.", "ok");
    await refreshAuthUI();
    refreshContext();
  } else {
    setStatus(`Sign-in failed: ${res?.error || "unknown error"}`, "err");
  }
});

document.getElementById("sign-out")?.addEventListener("click", async () => {
  await sendToBackground({ type: "IC_SIGN_OUT" });
  await refreshAuthUI();
  refreshContext();
  setStatus("Signed out.", "ok");
});

chrome.storage.local.get("backendUrl").then(({ backendUrl }) => {
  backendInput.value = backendUrl || "http://localhost:3001";
});

document.getElementById("save").addEventListener("click", async () => {
  const url = backendInput.value.trim().replace(/\/$/, "");
  await chrome.storage.local.set({ backendUrl: url });
  setStatus("Saved.", "ok");
});

document.getElementById("test").addEventListener("click", async () => {
  setStatus("Testing...", "");
  const url = backendInput.value.trim().replace(/\/$/, "");
  await chrome.storage.local.set({ backendUrl: url });
  chrome.runtime.sendMessage({ type: "IC_HEALTH_CHECK" }, (res) => {
    if (res?.ok) {
      setStatus(`Connected. Model: ${res.data.model}. Groq key set: ${res.data.hasGroqKey ? "yes" : "NO - add it to backend/.env"}`, res.data.hasGroqKey ? "ok" : "err");
    } else {
      setStatus(`Failed to connect: ${res?.error || "unknown error"}. Is the backend running?`, "err");
    }
  });
});

// ---------------- Context (resume / job description / other docs) ----------------

function formatBytes(chars) {
  return chars < 1000 ? `${chars} chars` : `${(chars / 1000).toFixed(1)}k chars`;
}

function docCard({ title, meta, onRemove }) {
  const card = document.createElement("div");
  card.className = "doc-card";
  const left = document.createElement("div");
  const titleEl = document.createElement("div");
  titleEl.textContent = title;
  const metaEl = document.createElement("div");
  metaEl.className = "meta";
  metaEl.textContent = meta;
  left.appendChild(titleEl);
  left.appendChild(metaEl);
  const removeBtn = document.createElement("button");
  removeBtn.className = "danger-text";
  removeBtn.textContent = "Remove";
  removeBtn.addEventListener("click", onRemove);
  card.appendChild(left);
  card.appendChild(removeBtn);
  return card;
}

async function refreshContext() {
  try {
    const url = await getBackendUrl();
    const res = await fetch(`${url}/api/context`, { headers: await authHeaders() });
    const ctx = await res.json();
    renderContext(ctx);
  } catch (e) {
    renderContext(null, e.message);
  }
}

function renderContext(ctx, errorMsg) {
  const resumeCard = document.getElementById("resume-card");
  const resumePill = document.getElementById("resume-pill");
  const jdCard = document.getElementById("jd-card");
  const jdPill = document.getElementById("jd-pill");
  const otherList = document.getElementById("other-list");

  resumeCard.innerHTML = "";
  jdCard.innerHTML = "";
  otherList.innerHTML = "";

  if (errorMsg) {
    resumeCard.innerHTML = `<div class="doc-empty">Could not reach backend: ${errorMsg}</div>`;
    resumePill.style.display = "none";
    jdPill.style.display = "none";
    return;
  }

  if (ctx.resume) {
    resumePill.textContent = "Loaded";
    resumePill.style.display = "inline-block";
    resumeCard.appendChild(docCard({
      title: ctx.resume.filename,
      meta: `${formatBytes(ctx.resume.chars)} - uploaded ${new Date(ctx.resume.uploadedAt).toLocaleString()}`,
      onRemove: () => removeDoc("resume"),
    }));
  } else {
    resumePill.style.display = "none";
    resumeCard.innerHTML = `<div class="doc-empty">No resume uploaded yet.</div>`;
  }

  if (ctx.jobDescription) {
    jdPill.textContent = "Loaded";
    jdPill.style.display = "inline-block";
    jdCard.appendChild(docCard({
      title: ctx.jobDescription.filename || "(pasted text)",
      meta: `${formatBytes(ctx.jobDescription.chars)} - ${ctx.jobDescription.source} - ${new Date(ctx.jobDescription.uploadedAt).toLocaleString()}`,
      onRemove: () => removeDoc("jobDescription"),
    }));
  } else {
    jdPill.style.display = "none";
    jdCard.innerHTML = `<div class="doc-empty">No job description saved yet.</div>`;
  }

  if (ctx.otherDocs && ctx.otherDocs.length) {
    ctx.otherDocs.forEach((d) => {
      otherList.appendChild(docCard({
        title: d.filename,
        meta: `${formatBytes(d.chars)} - uploaded ${new Date(d.uploadedAt).toLocaleString()}`,
        onRemove: () => removeDoc("other", d.id),
      }));
    });
  } else {
    otherList.innerHTML = `<div class="doc-empty">No additional documents.</div>`;
  }
}

async function uploadFile(endpoint, file) {
  const url = await getBackendUrl();
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${url}${endpoint}`, { method: "POST", headers: await authHeaders(), body: form });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
  return data;
}

async function removeDoc(kind, id) {
  try {
    const url = await getBackendUrl();
    const path = id ? `/api/context/${kind}/${id}` : `/api/context/${kind}`;
    const res = await fetch(`${url}${path}`, { method: "DELETE", headers: await authHeaders() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to remove.");
    renderContext(data);
    setStatus("Removed.", "ok");
  } catch (e) {
    setStatus(`Error: ${e.message}`, "err");
  }
}

document.getElementById("resume-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    setStatus("Uploading resume...", "");
    const data = await uploadFile("/api/context/resume", file);
    renderContext(data);
    setStatus("Resume uploaded.", "ok");
  } catch (err) {
    setStatus(`Error: ${err.message}`, "err");
  }
  e.target.value = "";
});

document.getElementById("jd-save").addEventListener("click", async () => {
  const text = document.getElementById("jd-text").value;
  if (!text.trim()) return setStatus("Paste the job description text first.", "err");
  try {
    setStatus("Saving job description...", "");
    const url = await getBackendUrl();
    const res = await fetch(`${url}/api/context/job-description`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to save.");
    renderContext(data);
    document.getElementById("jd-text").value = "";
    setStatus("Job description saved.", "ok");
  } catch (err) {
    setStatus(`Error: ${err.message}`, "err");
  }
});

document.getElementById("jd-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    setStatus("Uploading job description...", "");
    const data = await uploadFile("/api/context/job-description", file);
    renderContext(data);
    setStatus("Job description uploaded.", "ok");
  } catch (err) {
    setStatus(`Error: ${err.message}`, "err");
  }
  e.target.value = "";
});

document.getElementById("other-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    setStatus("Uploading document...", "");
    const data = await uploadFile("/api/context/other", file);
    renderContext(data);
    setStatus("Document added.", "ok");
  } catch (err) {
    setStatus(`Error: ${err.message}`, "err");
  }
  e.target.value = "";
});

refreshAuthUI();
refreshContext();
