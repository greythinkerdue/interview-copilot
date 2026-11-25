// Intervue AI - content script. Builds a floating teleprompter overlay
// inside a shadow DOM so host-page CSS never leaks in (and vice versa).
// Safe to execute multiple times in the same tab/frame - idempotent.

(async function interviewCopilotMain() {
  if (window.__interviewCopilotInstance) return; // already injected in this frame

  const DEFAULTS = {
    theme: "dark",
    opacity: 1,
    fontScale: 1,
    compact: false,
    recognitionLang: "id-ID",
    position: { top: 80, left: Math.max(20, (window.innerWidth || 1200) - 440) },
    size: { width: 400, height: 560 },
  };

  // ---------------- Icon set (inline SVG, stroke-based, 16x16 viewBox) ----------------
  function svg(inner) {
    return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  }
  const ICONS = {
    grip: svg(`<circle cx="5" cy="4" r="0.9" fill="currentColor" stroke="none"/><circle cx="11" cy="4" r="0.9" fill="currentColor" stroke="none"/><circle cx="5" cy="8" r="0.9" fill="currentColor" stroke="none"/><circle cx="11" cy="8" r="0.9" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="0.9" fill="currentColor" stroke="none"/><circle cx="11" cy="12" r="0.9" fill="currentColor" stroke="none"/>`),
    minimize: svg(`<line x1="4" y1="11" x2="12" y2="11"/>`),
    restore: svg(`<rect x="4.5" y="4.5" width="7" height="7" rx="1.2"/>`),
    close: svg(`<line x1="4.2" y1="4.2" x2="11.8" y2="11.8"/><line x1="11.8" y1="4.2" x2="4.2" y2="11.8"/>`),
    regenerate: svg(`<path d="M13 8a5 5 0 1 1-1.8-3.8"/><path d="M13 2v3.6h-3.6"/>`),
    chevronDown: svg(`<path d="M3.5 6l4.5 4.5L12.5 6"/>`),
    chevronUp: svg(`<path d="M3.5 10l4.5-4.5L12.5 10"/>`),
    copy: svg(`<rect x="5.2" y="5.2" width="7.3" height="7.3" rx="1.3"/><path d="M3.5 10.3V3.8a1 1 0 0 1 1-1h6.5"/>`),
    star: svg(`<path d="M8 2.2l1.8 3.6 4 .58-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4-2.9-2.8 4-.58z"/>`),
    mic: svg(`<rect x="6" y="2" width="4" height="7.2" rx="2"/><path d="M4 7.5a4 4 0 0 0 8 0"/><line x1="8" y1="11.5" x2="8" y2="14"/><line x1="5.5" y1="14" x2="10.5" y2="14"/>`),
    micOff: svg(`<rect x="6" y="2" width="4" height="7.2" rx="2"/><path d="M4 7.5a4 4 0 0 0 8 0"/><line x1="8" y1="11.5" x2="8" y2="14"/><line x1="5.5" y1="14" x2="10.5" y2="14"/><line x1="2.5" y1="2.5" x2="13.5" y2="13.5"/>`),
    pause: svg(`<circle cx="8" cy="8" r="6.3"/><line x1="6.2" y1="5.6" x2="6.2" y2="10.4"/><line x1="9.8" y1="5.6" x2="9.8" y2="10.4"/>`),
    play: svg(`<circle cx="8" cy="8" r="6.3"/><path d="M6.6 5.6l4 2.4-4 2.4z" fill="currentColor" stroke="none"/>`),
    sun: svg(`<circle cx="8" cy="8" r="2.6"/><line x1="8" y1="1.3" x2="8" y2="2.8"/><line x1="8" y1="13.2" x2="8" y2="14.7"/><line x1="1.3" y1="8" x2="2.8" y2="8"/><line x1="13.2" y1="8" x2="14.7" y2="8"/><line x1="3.3" y1="3.3" x2="4.3" y2="4.3"/><line x1="11.7" y1="11.7" x2="12.7" y2="12.7"/><line x1="3.3" y1="12.7" x2="4.3" y2="11.7"/><line x1="11.7" y1="4.3" x2="12.7" y2="3.3"/>`),
    layout: svg(`<rect x="2.5" y="2.8" width="11" height="2.3" rx="0.8"/><rect x="2.5" y="6.85" width="11" height="2.3" rx="0.8"/><rect x="2.5" y="10.9" width="11" height="2.3" rx="0.8"/>`),
    trash: svg(`<path d="M3 4.6h10"/><path d="M6.3 4.6V3.4a1 1 0 0 1 1-1h1.4a1 1 0 0 1 1 1v1.2"/><path d="M4.6 4.6l.5 7.3a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.5-7.3"/>`),
    send: svg(`<path d="M13.5 2.5L7 9"/><path d="M13.5 2.5L9.3 13.5l-2.3-4.5L2.5 6.7z"/>`),
  };

  const settings = await loadSettings();
  const state = {
    ...settings,
    listening: false,
    micStatus: "off", // off | listening | denied | unsupported | error
    backendStatus: "unknown", // ok | error | unknown
    processStatus: "idle", // idle | processing | ready | error
    pausedForSelf: false,
    history: [], // {question, category, answer, language, isFollowUp, useful, ts, source}
    currentIndex: -1,
  };

  async function loadSettings() {
    try {
      const { ic_settings } = await chrome.storage.session.get("ic_settings");
      return { ...DEFAULTS, ...(ic_settings || {}) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  let saveTimer = null;
  function persistSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const { theme, opacity, fontScale, compact, recognitionLang, position, size } = state;
      chrome.storage.session.set({
        ic_settings: { theme, opacity, fontScale, compact, recognitionLang, position, size },
      }).catch(() => {});
    }, 250);
  }

  // ---------------- Build DOM ----------------
  let cssText = "";
  try {
    const res = await fetch(chrome.runtime.getURL("overlay.css"));
    cssText = await res.text();
  } catch (e) {
    console.warn("Intervue AI: failed to load overlay.css", e);
  }

  const host = document.createElement("div");
  host.id = "interview-copilot-host";
  host.style.all = "initial"; // isolate from host page inherited styles
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = cssText;
  shadow.appendChild(style);

  const root = document.createElement("div");
  root.className = "ic-overlay";
  root.innerHTML = `
    <div class="ic-header" id="ic-drag-handle">
      <span class="ic-grip">${ICONS.grip}</span>
      <div class="ic-brand"><img class="ic-logo-dot" src="${chrome.runtime.getURL("icons/icon48.png")}" alt="" />INTERVUE AI</div>
      <div class="ic-indicators">
        <span class="ic-pill" id="ic-pill-listen" title="Listening status"><span class="dot"></span><span class="label">Idle</span></span>
        <span class="ic-pill" id="ic-pill-conn" title="Backend connection"><span class="dot"></span><span class="label">Backend</span></span>
      </div>
      <div class="ic-header-spacer"></div>
      <button class="ic-icon-btn" id="ic-btn-minimize" title="Minimize">${ICONS.minimize}</button>
      <button class="ic-icon-btn ic-close" id="ic-btn-close" title="Close">${ICONS.close}</button>
    </div>

    <div class="ic-body">
      <div>
        <div class="ic-section-label">Detected question</div>
        <div class="ic-question-box" id="ic-question">Waiting for a question... ask one below or start listening.</div>
      </div>

      <div>
        <div class="ic-section-label">Category</div>
        <span class="ic-category-badge" id="ic-category">-</span>
      </div>

      <div style="display:flex; flex-direction:column; flex:1;">
        <div class="ic-section-label"><span id="ic-status-label">Suggested answer</span></div>
        <div class="ic-answer-box ic-placeholder" id="ic-answer">Your AI-suggested answer will appear here.</div>
      </div>

      <div class="ic-controls-row">
        <button class="ic-btn" id="ic-act-regenerate" disabled>${ICONS.regenerate} Regenerate</button>
        <button class="ic-btn" id="ic-act-shorter" disabled>${ICONS.chevronDown} Shorter</button>
        <button class="ic-btn" id="ic-act-longer" disabled>${ICONS.chevronUp} Detailed</button>
        <button class="ic-btn" id="ic-act-copy" disabled>${ICONS.copy} Copy</button>
        <button class="ic-btn" id="ic-act-useful" disabled>${ICONS.star} Useful</button>
      </div>
    </div>

    <div class="ic-footer">
      <div class="ic-manual-row">
        <input class="ic-manual-input" id="ic-manual-input" type="text" placeholder="Type the question manually and press Enter..." />
        <button class="ic-btn ic-primary" id="ic-manual-send">${ICONS.send} Ask</button>
      </div>
      <div class="ic-footer-controls">
        <button class="ic-btn" id="ic-btn-listen">${ICONS.mic}<span>Listening: OFF</span></button>
        <div class="ic-footer-group">
          <button class="ic-mini-btn" id="ic-lang-id">ID</button>
          <button class="ic-mini-btn" id="ic-lang-en">EN</button>
        </div>
        <button class="ic-mini-btn" id="ic-btn-pause" title="Pause recognition while you are speaking">${ICONS.pause}</button>
        <span class="ic-footer-group" id="ic-mic-status">Mic: off</span>
      </div>
      <div class="ic-footer-controls">
        <div class="ic-footer-group">
          Opacity
          <input type="range" id="ic-opacity" min="30" max="100" step="5" />
        </div>
        <div class="ic-footer-group">
          Font
          <button class="ic-mini-btn" id="ic-font-dec">A-</button>
          <button class="ic-mini-btn" id="ic-font-inc">A+</button>
        </div>
        <button class="ic-mini-btn" id="ic-btn-theme" title="Toggle theme">${ICONS.sun}</button>
        <button class="ic-mini-btn" id="ic-btn-compact" title="Compact mode">${ICONS.layout}</button>
        <button class="ic-mini-btn" id="ic-btn-reset" title="Reset session (clear question history)">${ICONS.trash}</button>
      </div>
    </div>
    <div class="ic-resize-handle" id="ic-resize-handle" title="Resize">
      <svg width="16" height="16" viewBox="0 0 16 16"><path d="M15 15L15 9M15 15L9 15M15 15L1 1" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>
    </div>
    <div class="ic-toast" id="ic-toast"></div>
  `;
  shadow.appendChild(root);

  // ---------------- Element refs ----------------
  const $ = (id) => shadow.getElementById(id);
  const elQuestion = $("ic-question");
  const elCategory = $("ic-category");
  const elAnswer = $("ic-answer");
  const elStatusLabel = $("ic-status-label");
  const elPillListen = $("ic-pill-listen");
  const elPillConn = $("ic-pill-conn");
  const elManualInput = $("ic-manual-input");
  const elMicStatus = $("ic-mic-status");
  const elToast = $("ic-toast");
  const btnListen = $("ic-btn-listen");
  const btnRegenerate = $("ic-act-regenerate");
  const btnShorter = $("ic-act-shorter");
  const btnLonger = $("ic-act-longer");
  const btnCopy = $("ic-act-copy");
  const btnUseful = $("ic-act-useful");

  // ---------------- Apply persisted appearance ----------------
  function applyAppearance() {
    root.dataset.theme = state.theme;
    root.style.setProperty("--ic-opacity", String(state.opacity));
    root.style.setProperty("--ic-font-scale", String(state.fontScale));
    root.classList.toggle("ic-compact", !!state.compact);
    root.style.top = `${state.position.top}px`;
    root.style.left = `${state.position.left}px`;
    root.style.width = `${state.size.width}px`;
    root.style.height = `${state.size.height}px`;
    $("ic-opacity").value = Math.round(state.opacity * 100);
    $("ic-lang-id").classList.toggle("ic-active", state.recognitionLang === "id-ID");
    $("ic-lang-en").classList.toggle("ic-active", state.recognitionLang === "en-US");
    $("ic-btn-compact").classList.toggle("ic-active", !!state.compact);
  }
  applyAppearance();

  let toastTimer = null;
  function showToast(msg) {
    elToast.innerHTML = `<span class="dot"></span><span>${msg}</span>`;
    elToast.classList.add("ic-show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => elToast.classList.remove("ic-show"), 1800);
  }

  // ---------------- Drag ----------------
  (function enableDrag() {
    const handle = $("ic-drag-handle");
    let dragging = false, startX = 0, startY = 0, startTop = 0, startLeft = 0;
    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      dragging = true;
      root.classList.add("ic-dragging");
      startX = e.clientX; startY = e.clientY;
      startTop = root.offsetTop; startLeft = root.offsetLeft;
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      let newTop = startTop + (e.clientY - startY);
      let newLeft = startLeft + (e.clientX - startX);
      newTop = Math.max(0, Math.min(window.innerHeight - 40, newTop));
      newLeft = Math.max(-root.offsetWidth + 60, Math.min(window.innerWidth - 60, newLeft));
      root.style.top = `${newTop}px`;
      root.style.left = `${newLeft}px`;
    });
    document.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      root.classList.remove("ic-dragging");
      state.position = { top: root.offsetTop, left: root.offsetLeft };
      persistSettings();
    });
  })();

  // ---------------- Resize ----------------
  (function enableResize() {
    const handle = $("ic-resize-handle");
    let resizing = false, startX = 0, startY = 0, startW = 0, startH = 0;
    handle.addEventListener("mousedown", (e) => {
      resizing = true;
      root.classList.add("ic-resizing");
      startX = e.clientX; startY = e.clientY;
      startW = root.offsetWidth; startH = root.offsetHeight;
      e.preventDefault();
      e.stopPropagation();
    });
    document.addEventListener("mousemove", (e) => {
      if (!resizing) return;
      let newW = Math.max(300, Math.min(window.innerWidth - 20, startW + (e.clientX - startX)));
      let newH = Math.max(180, Math.min(window.innerHeight - 20, startH + (e.clientY - startY)));
      root.style.width = `${newW}px`;
      root.style.height = `${newH}px`;
    });
    document.addEventListener("mouseup", () => {
      if (!resizing) return;
      resizing = false;
      root.classList.remove("ic-resizing");
      state.size = { width: root.offsetWidth, height: root.offsetHeight };
      persistSettings();
    });
  })();

  // ---------------- Header buttons ----------------
  $("ic-btn-minimize").addEventListener("click", () => {
    const willMinimize = !root.classList.contains("ic-minimized");
    root.classList.toggle("ic-minimized", willMinimize);
    $("ic-btn-minimize").innerHTML = willMinimize ? ICONS.restore : ICONS.minimize;
  });
  $("ic-btn-close").addEventListener("click", () => {
    root.classList.add("ic-hidden");
  });

  // ---------------- Theme / compact / opacity / font ----------------
  $("ic-btn-theme").addEventListener("click", () => {
    state.theme = state.theme === "dark" ? "light" : "dark";
    applyAppearance();
    persistSettings();
  });
  $("ic-btn-compact").addEventListener("click", () => {
    state.compact = !state.compact;
    applyAppearance();
    persistSettings();
  });
  $("ic-btn-reset").addEventListener("click", resetSession);
  $("ic-opacity").addEventListener("input", (e) => {
    state.opacity = Number(e.target.value) / 100;
    root.style.setProperty("--ic-opacity", String(state.opacity));
    persistSettings();
  });
  $("ic-font-inc").addEventListener("click", () => {
    state.fontScale = Math.min(1.6, +(state.fontScale + 0.1).toFixed(2));
    applyAppearance();
    persistSettings();
  });
  $("ic-font-dec").addEventListener("click", () => {
    state.fontScale = Math.max(0.8, +(state.fontScale - 0.1).toFixed(2));
    applyAppearance();
    persistSettings();
  });
  $("ic-lang-id").addEventListener("click", () => setRecognitionLang("id-ID"));
  $("ic-lang-en").addEventListener("click", () => setRecognitionLang("en-US"));
  function setRecognitionLang(lang) {
    state.recognitionLang = lang;
    applyAppearance();
    persistSettings();
    if (recognition && state.listening) {
      try { recognition.lang = lang; recognition.stop(); } catch {}
    }
  }
  $("ic-btn-pause").addEventListener("click", () => {
    state.pausedForSelf = !state.pausedForSelf;
    $("ic-btn-pause").classList.toggle("ic-active", state.pausedForSelf);
    $("ic-btn-pause").innerHTML = state.pausedForSelf ? ICONS.play : ICONS.pause;
    showToast(state.pausedForSelf ? "Paused (your voice ignored)" : "Resumed listening");
  });

  // ---------------- Backend connection check ----------------
  function setConnPill(status) {
    elPillConn.classList.remove("on", "error");
    const label = elPillConn.querySelector(".label");
    if (status === "ok") { elPillConn.classList.add("on"); label.textContent = "Backend"; }
    else if (status === "error") { elPillConn.classList.add("error"); label.textContent = "Offline"; }
    else { label.textContent = "Backend"; }
  }
  async function checkBackend() {
    try {
      const res = await sendToBackground({ type: "IC_HEALTH_CHECK" });
      state.backendStatus = res?.ok ? "ok" : "error";
    } catch {
      state.backendStatus = "error";
    }
    setConnPill(state.backendStatus);
  }
  checkBackend();
  setInterval(checkBackend, 25000);

  function sendToBackground(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(response);
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  // ---------------- Answer generation ----------------
  function setProcessStatus(status) {
    state.processStatus = status;
    const labelMap = { idle: "Suggested answer", processing: "Processing...", ready: "Answer ready", error: "Error" };
    elStatusLabel.textContent = labelMap[status] || "Suggested answer";
  }

  function normalize(text) {
    return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
  }

  let lastProcessedNormalized = "";

  function resetSession() {
    state.history = [];
    state.currentIndex = -1;
    lastProcessedNormalized = "";
    finalBuffer = "";

    elQuestion.textContent = "Waiting for a question... ask one below or start listening.";
    elCategory.textContent = "-";
    elCategory.removeAttribute("data-category");
    elAnswer.textContent = "Your AI-suggested answer will appear here.";
    elAnswer.classList.add("ic-placeholder");
    elAnswer.classList.remove("ic-loading", "ic-error-text");
    setProcessStatus("idle");
    elManualInput.value = "";

    [btnRegenerate, btnShorter, btnLonger, btnCopy, btnUseful].forEach((b) => {
      b.disabled = true;
      b.classList.remove("ic-active");
    });

    showToast("Session direset");
  }

  async function handleNewQuestion(text, { mode = "normal", source = "manual" } = {}) {
    const trimmed = text.trim();
    if (!trimmed) return;

    const isModify = mode !== "normal" && state.currentIndex >= 0;
    const norm = normalize(trimmed);
    if (!isModify && source === "auto" && norm === lastProcessedNormalized) return; // dedupe
    if (!isModify) lastProcessedNormalized = norm;

    elQuestion.textContent = trimmed;
    elCategory.textContent = "...";
    elCategory.removeAttribute("data-category");
    if (!isModify) {
      elAnswer.innerHTML = `<span class="ic-typing-dots"><span></span><span></span><span></span></span>`;
    }
    elAnswer.classList.remove("ic-placeholder", "ic-error-text");
    elAnswer.classList.add("ic-loading");
    setProcessStatus("processing");
    elPillListen.classList.add("processing");
    [btnRegenerate, btnShorter, btnLonger, btnCopy, btnUseful].forEach((b) => (b.disabled = true));

    const recentHistory = state.history.slice(-4).map((h) => ({
      question: h.question, category: h.category, answer: h.answer,
    }));

    const res = await sendToBackground({
      type: "IC_GENERATE_ANSWER",
      payload: { question: trimmed, mode, recentHistory },
    });

    elPillListen.classList.remove("processing");

    if (!res || !res.ok) {
      elAnswer.classList.remove("ic-loading");
      elAnswer.classList.add("ic-error-text");
      elAnswer.textContent = `Could not generate an answer: ${res?.error || "unknown error"}. Check Settings > backend connection, or answer manually.`;
      setProcessStatus("error");
      return;
    }

    const { category, answer, language, isFollowUp } = res.data;
    elAnswer.classList.remove("ic-loading", "ic-placeholder", "ic-error-text", "ic-fade-in");
    elAnswer.textContent = answer;
    void elAnswer.offsetWidth; // restart the fade-in animation on every new answer
    elAnswer.classList.add("ic-fade-in");
    elCategory.textContent = isFollowUp ? `${category} (Follow-up)` : category;
    elCategory.dataset.category = category;
    setProcessStatus("ready");

    const entry = { question: trimmed, category, answer, language, isFollowUp, useful: false, ts: Date.now(), source };
    if (isModify) {
      state.history[state.currentIndex] = { ...state.history[state.currentIndex], ...entry, question: state.history[state.currentIndex].question };
    } else {
      state.history.push(entry);
      state.currentIndex = state.history.length - 1;
    }
    btnUseful.classList.toggle("ic-active", !!state.history[state.currentIndex].useful);
    [btnRegenerate, btnShorter, btnLonger, btnCopy, btnUseful].forEach((b) => (b.disabled = false));
  }

  // Manual input
  $("ic-manual-send").addEventListener("click", submitManual);
  elManualInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitManual();
  });
  function submitManual() {
    const text = elManualInput.value;
    if (!text.trim()) return;
    elManualInput.value = "";
    handleNewQuestion(text, { mode: "normal", source: "manual" });
  }

  // Quick controls
  btnRegenerate.addEventListener("click", () => {
    if (state.currentIndex < 0) return;
    handleNewQuestion(state.history[state.currentIndex].question, { mode: "regenerate", source: "manual" });
  });
  btnShorter.addEventListener("click", () => {
    if (state.currentIndex < 0) return;
    handleNewQuestion(state.history[state.currentIndex].question, { mode: "shorter", source: "manual" });
  });
  btnLonger.addEventListener("click", () => {
    if (state.currentIndex < 0) return;
    handleNewQuestion(state.history[state.currentIndex].question, { mode: "longer", source: "manual" });
  });
  btnCopy.addEventListener("click", copyAnswer);
  btnUseful.addEventListener("click", () => {
    if (state.currentIndex < 0) return;
    const cur = state.history[state.currentIndex];
    cur.useful = !cur.useful;
    btnUseful.classList.toggle("ic-active", cur.useful);
    showToast(cur.useful ? "Marked as useful" : "Unmarked");
  });

  function copyAnswer() {
    if (state.currentIndex < 0) return;
    const text = state.history[state.currentIndex].answer;
    navigator.clipboard.writeText(text).then(
      () => showToast("Copied!"),
      () => {
        try {
          const ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
          showToast("Copied!");
        } catch {
          showToast("Copy failed");
        }
      }
    );
  }

  // ---------------- Speech recognition (microphone) ----------------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let recognitionRunning = false;
  let finalBuffer = "";
  let idleTimer = null;

  function updateMicStatus(status) {
    state.micStatus = status;
    const map = { off: "Mic: off", listening: "Mic: listening", denied: "Mic: permission denied", unsupported: "Mic: not supported - use manual input", error: "Mic: error" };
    elMicStatus.textContent = map[status] || "Mic: off";
  }

  function updateListenPill() {
    const label = elPillListen.querySelector(".label");
    elPillListen.classList.toggle("on", state.listening);
    elPillListen.classList.toggle("listening", state.listening);
    label.textContent = state.listening ? "Listening" : "Idle";
  }

  function flushBuffer() {
    const text = finalBuffer.trim();
    finalBuffer = "";
    if (!text) return;
    if (state.pausedForSelf) return;
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    if (wordCount < 3) return; // avoid incomplete/filler fragments
    handleNewQuestion(text, { mode: "normal", source: "auto" });
  }

  function buildRecognition() {
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.lang = state.recognitionLang;

    rec.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        const transcript = r[0].transcript;
        if (r.isFinal) finalBuffer += (finalBuffer ? " " : "") + transcript.trim();
        else interim += transcript;
      }
      if (interim && !state.pausedForSelf) {
        elQuestion.textContent = (finalBuffer + " " + interim).trim();
      }
      clearTimeout(idleTimer);
      idleTimer = setTimeout(flushBuffer, 1200);
    };

    rec.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        updateMicStatus("denied");
        state.listening = false;
        updateListenPill();
        btnListen.innerHTML = `${ICONS.micOff}<span>Listening: OFF</span>`;
        showToast("Microphone permission denied");
        return;
      }
      updateMicStatus("error");
    };

    rec.onend = () => {
      recognitionRunning = false;
      if (state.listening) {
        setTimeout(() => {
          if (state.listening) startRecognition();
        }, 300);
      } else {
        updateMicStatus("off");
      }
    };

    return rec;
  }

  function startRecognition() {
    if (!SR) { updateMicStatus("unsupported"); return; }
    if (!recognition) recognition = buildRecognition();
    if (recognitionRunning) return;
    try {
      recognition.start();
      recognitionRunning = true;
      updateMicStatus("listening");
    } catch (e) {
      // InvalidStateError if already started; otherwise surface it
      if (!/already started/i.test(e.message || "")) {
        console.warn("Intervue AI recognition start failed:", e);
      }
    }
  }

  function stopRecognition() {
    if (recognition) {
      try { recognition.stop(); } catch {}
    }
    clearTimeout(idleTimer);
    finalBuffer = "";
    updateMicStatus("off");
  }

  function toggleListening() {
    if (!SR) {
      showToast("Speech recognition not supported in this browser - use manual input.");
      updateMicStatus("unsupported");
      return;
    }
    state.listening = !state.listening;
    updateListenPill();
    btnListen.innerHTML = `${state.listening ? ICONS.mic : ICONS.micOff}<span>Listening: ${state.listening ? "ON" : "OFF"}</span>`;
    btnListen.classList.toggle("ic-active", state.listening);
    if (state.listening) startRecognition();
    else stopRecognition();
  }
  btnListen.addEventListener("click", toggleListening);

  if (!SR) updateMicStatus("unsupported");

  // ---------------- Message bridge for commands / toolbar ----------------
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "IC_TOGGLE_OVERLAY") root.classList.toggle("ic-hidden");
    else if (msg?.type === "IC_TOGGLE_LISTENING") toggleListening();
    else if (msg?.type === "IC_COPY_ANSWER") copyAnswer();
  });

  window.__interviewCopilotInstance = { root };
})();
