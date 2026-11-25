// Shared JS for the Intervue AI website (landing + dashboard).
// Vanilla JS, no build step - matches the rest of this project.

function getToken() {
  return localStorage.getItem("ic_token");
}
function setSession(token, email) {
  localStorage.setItem("ic_token", token);
  if (email) localStorage.setItem("ic_email", email);
}
function clearSession() {
  localStorage.removeItem("ic_token");
  localStorage.removeItem("ic_email");
}
function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ---------------- Landing page ----------------
async function initLanding() {
  if (getToken()) {
    window.location.href = "/dashboard";
    return;
  }
  const status = document.getElementById("status");
  try {
    const res = await fetch("/api/config");
    const cfg = await res.json();
    if (!cfg.googleClientId) {
      status.textContent = "Sign-in is not configured yet (GOOGLE_CLIENT_ID missing on the server).";
      status.className = "err";
      return;
    }
    window.google.accounts.id.initialize({
      client_id: cfg.googleClientId,
      callback: onGoogleCredential,
    });
    window.google.accounts.id.renderButton(document.getElementById("g_id_signin_container"), {
      theme: "filled_black",
      size: "large",
      shape: "pill",
    });
  } catch (e) {
    status.textContent = `Could not load sign-in: ${e.message}`;
    status.className = "err";
  }
}

async function onGoogleCredential(response) {
  const status = document.getElementById("status");
  status.textContent = "Signing in...";
  status.className = "";
  try {
    const res = await fetch("/api/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: response.credential }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Sign-in failed.");
    setSession(data.token, data.email);
    window.location.href = "/dashboard";
  } catch (e) {
    status.textContent = `Error: ${e.message}`;
    status.className = "err";
  }
}

// ---------------- Dashboard page ----------------
function setStatus(msg, cls) {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.className = cls || "";
}

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
    const res = await fetch("/api/context", { headers: authHeaders() });
    if (res.status === 401) return signOut();
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
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(endpoint, { method: "POST", headers: authHeaders(), body: form });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
  return data;
}

async function removeDoc(kind, id) {
  try {
    const path = id ? `/api/context/${kind}/${id}` : `/api/context/${kind}`;
    const res = await fetch(path, { method: "DELETE", headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to remove.");
    renderContext(data);
    setStatus("Removed.", "ok");
  } catch (e) {
    setStatus(`Error: ${e.message}`, "err");
  }
}

function signOut() {
  clearSession();
  window.location.href = "/";
}

function initDashboard() {
  if (!getToken()) {
    window.location.href = "/";
    return;
  }
  const email = localStorage.getItem("ic_email");
  if (email) document.getElementById("email-pill").textContent = email;
  document.getElementById("sign-out").addEventListener("click", signOut);

  document.getElementById("resume-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      setStatus("Uploading resume...", "");
      renderContext(await uploadFile("/api/context/resume", file));
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
      const res = await fetch("/api/context/job-description", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
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
      renderContext(await uploadFile("/api/context/job-description", file));
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
      renderContext(await uploadFile("/api/context/other", file));
      setStatus("Document added.", "ok");
    } catch (err) {
      setStatus(`Error: ${err.message}`, "err");
    }
    e.target.value = "";
  });

  refreshContext();
}
