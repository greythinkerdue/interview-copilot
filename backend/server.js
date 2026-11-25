import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import rateLimit from "express-rate-limit";
import { generateAnswer } from "./src/groq.js";
import { extractText, setResume, setJobDescription, addOtherDoc, removeDoc, contextSummary, isReady, STORAGE_MODE } from "./src/context.js";
import { handleIdToken, handleAuthCode, requireAuth } from "./src/auth.js";
import { query } from "./src/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const DAILY_REQUEST_LIMIT = Number(process.env.DAILY_REQUEST_LIMIT) || 100;

// In local single-user dev mode there are no accounts - every route runs
// "unauthenticated" with userId=null, which context.js's local backend
// ignores anyway. In postgres mode, every protected route requires a real
// signed-in user.
const maybeRequireAuth = STORAGE_MODE === "postgres" ? requireAuth : (req, res, next) => { req.userId = null; next(); };

// CORS: wide open for local dev (matches the original single-user tool);
// an explicit allowlist once hosted for real users. Set ALLOWED_ORIGINS to a
// comma-separated list (website origin + chrome-extension://<id>).
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
app.use(
  cors(
    STORAGE_MODE === "postgres" && allowedOrigins.length
      ? { origin: allowedOrigins }
      : {} // permissive default for local dev
  )
);
app.use(express.json({ limit: "2mb" }));
app.use(express.raw({ type: "audio/*", limit: "15mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, model: process.env.GROQ_MODEL || "openai/gpt-oss-120b", mode: STORAGE_MODE });
});

// Public (non-secret) config the website/extension need to initialize Google Sign-In.
app.get("/api/config", (req, res) => {
  res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || "", mode: STORAGE_MODE });
});

// ---------------- Auth (only meaningful in postgres/hosted mode) ----------------
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });

app.post("/api/auth/google", authLimiter, async (req, res) => {
  try {
    if (STORAGE_MODE !== "postgres") return res.status(501).json({ error: "Sign-in is only available on the hosted version." });
    const { idToken } = req.body || {};
    if (!idToken) return res.status(400).json({ error: "Missing 'idToken'." });
    const { token, user } = await handleIdToken(idToken);
    res.json({ token, email: user.email });
  } catch (err) {
    console.error("[auth/google] error:", err.message);
    res.status(401).json({ error: "Google sign-in failed: " + err.message });
  }
});

app.post("/api/auth/google/exchange", authLimiter, async (req, res) => {
  try {
    if (STORAGE_MODE !== "postgres") return res.status(501).json({ error: "Sign-in is only available on the hosted version." });
    const { code, redirectUri } = req.body || {};
    if (!code || !redirectUri) return res.status(400).json({ error: "Missing 'code' or 'redirectUri'." });
    const { token, user } = await handleAuthCode(code, redirectUri);
    res.json({ token, email: user.email });
  } catch (err) {
    console.error("[auth/google/exchange] error:", err.message);
    res.status(401).json({ error: "Google sign-in failed: " + err.message });
  }
});

// ---------------- Answer generation ----------------
const generateLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 }); // blunt IP-based guard

async function checkDailyLimit(userId) {
  if (STORAGE_MODE !== "postgres" || !userId) return true; // no cap in local single-user mode
  const result = await query(
    `SELECT COUNT(*)::int AS count FROM usage_log WHERE user_id = $1 AND created_at > now() - interval '1 day'`,
    [userId]
  );
  return result.rows[0].count < DAILY_REQUEST_LIMIT;
}

app.post("/api/generate-answer", generateLimiter, maybeRequireAuth, async (req, res) => {
  try {
    const { question, mode, recentHistory } = req.body || {};
    if (!question || typeof question !== "string" || !question.trim()) {
      return res.status(400).json({ error: "Missing 'question' string." });
    }
    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({
        error: "GROQ_API_KEY is not set on the backend. Copy backend/.env.example to backend/.env and add your key.",
      });
    }
    if (!(await isReady(req.userId))) {
      return res.status(400).json({
        error: "Upload your resume and the job description first (extension Options page / dashboard) before asking a question.",
      });
    }
    if (!(await checkDailyLimit(req.userId))) {
      return res.status(429).json({ error: `Daily limit of ${DAILY_REQUEST_LIMIT} questions reached - try again tomorrow.` });
    }
    const result = await generateAnswer({ userId: req.userId, question: question.trim(), mode, recentHistory });
    if (STORAGE_MODE === "postgres" && req.userId) {
      await query(`INSERT INTO usage_log (user_id) VALUES ($1)`, [req.userId]);
    }
    res.json(result);
  } catch (err) {
    console.error("[generate-answer] error:", err.message);
    res.status(500).json({ error: err.message || "Failed to generate answer." });
  }
});

// ---------------- Context (resume / job description / other docs) ----------------
app.get("/api/context", maybeRequireAuth, async (req, res) => {
  res.json(await contextSummary(req.userId));
});

app.post("/api/context/resume", maybeRequireAuth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });
    const text = await extractText(req.file.buffer, req.file.originalname);
    if (!text.trim()) return res.status(400).json({ error: "Could not extract any text from that file." });
    await setResume(req.userId, { filename: req.file.originalname, text });
    res.json(await contextSummary(req.userId));
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to process resume file." });
  }
});

// Job description can be a pasted text OR an uploaded file.
app.post("/api/context/job-description", maybeRequireAuth, upload.single("file"), async (req, res) => {
  try {
    if (req.file) {
      const text = await extractText(req.file.buffer, req.file.originalname);
      if (!text.trim()) return res.status(400).json({ error: "Could not extract any text from that file." });
      await setJobDescription(req.userId, { filename: req.file.originalname, text, source: "file" });
    } else if (req.body?.text && req.body.text.trim()) {
      await setJobDescription(req.userId, { filename: null, text: req.body.text, source: "paste" });
    } else {
      return res.status(400).json({ error: "Provide either a file upload or a 'text' field." });
    }
    res.json(await contextSummary(req.userId));
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to process job description." });
  }
});

app.post("/api/context/other", maybeRequireAuth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });
    const text = await extractText(req.file.buffer, req.file.originalname);
    if (!text.trim()) return res.status(400).json({ error: "Could not extract any text from that file." });
    await addOtherDoc(req.userId, { filename: req.file.originalname, text });
    res.json(await contextSummary(req.userId));
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to process file." });
  }
});

app.delete("/api/context/:kind/:id?", maybeRequireAuth, async (req, res) => {
  try {
    await removeDoc(req.userId, req.params.kind, req.params.id);
    res.json(await contextSummary(req.userId));
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to remove document." });
  }
});

// Optional Beta endpoint: transcribe a short audio chunk (webm/opus) using OpenAI Whisper.
// Only works if OPENAI_API_KEY is configured. Core app does NOT depend on this -
// microphone live-transcription (Web Speech API) and manual input work without it.
app.post("/api/transcribe", maybeRequireAuth, async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(501).json({
        error: "Tab-audio transcription is optional and not configured. Set OPENAI_API_KEY in backend/.env to enable it, or use microphone listening / manual input instead.",
      });
    }
    const audioBuffer = req.body;
    if (!audioBuffer || !audioBuffer.length) {
      return res.status(400).json({ error: "No audio data received." });
    }

    const form = new FormData();
    form.append("file", new Blob([audioBuffer], { type: "audio/webm" }), "chunk.webm");
    form.append("model", "whisper-1");

    const whisperRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });

    if (!whisperRes.ok) {
      const errText = await whisperRes.text();
      throw new Error(`Whisper API error ${whisperRes.status}: ${errText}`);
    }

    const data = await whisperRes.json();
    res.json({ text: data.text || "" });
  } catch (err) {
    console.error("[transcribe] error:", err.message);
    res.status(500).json({ error: err.message || "Transcription failed." });
  }
});

app.listen(PORT, () => {
  console.log(`Interview Copilot backend listening on http://localhost:${PORT} (STORAGE_MODE=${STORAGE_MODE})`);
  if (!process.env.GROQ_API_KEY) {
    console.warn("WARNING: GROQ_API_KEY is not set. Copy .env.example to .env and add your key.");
  }
  if (STORAGE_MODE === "postgres" && (!process.env.GOOGLE_CLIENT_ID || !process.env.JWT_SECRET)) {
    console.warn("WARNING: STORAGE_MODE=postgres but GOOGLE_CLIENT_ID/JWT_SECRET are not fully set.");
  }
});
