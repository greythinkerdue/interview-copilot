// Manages the uploaded "knowledge base" for Interview Copilot: the candidate's
// resume/CV, the target job description, and any other supporting documents.
//
// Two storage backends behind the same function signatures:
//  - STORAGE_MODE=local (default, for local dev without a database): a single
//    JSON file on disk, same as the original single-user version. userId is
//    accepted but ignored - there's only ever one "user" in this mode.
//  - STORAGE_MODE=postgres (production/hosted): one row per user across a
//    few tables. See migrations/001_init.sql for the schema.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import mammoth from "mammoth";
import { query } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const CONTEXT_FILE = path.join(DATA_DIR, "context.json");
const MODE = process.env.STORAGE_MODE === "postgres" ? "postgres" : "local";

function cleanText(text) {
  return text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Extracts plain text from an uploaded file buffer based on its extension.
// Pure function, identical in both storage modes.
export async function extractText(buffer, originalName) {
  const ext = path.extname(originalName || "").toLowerCase();
  if (ext === ".txt" || ext === ".md") {
    return buffer.toString("utf-8");
  }
  if (ext === ".pdf") {
    const pdfParse = (await import("pdf-parse")).default;
    const data = await pdfParse(buffer);
    return data.text;
  }
  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  throw new Error(`Unsupported file type "${ext || "(none)"}" - use .pdf, .docx, or .txt`);
}

// ---------------- local (single JSON file) backend ----------------

function emptyContext() {
  return { resume: null, jobDescription: null, otherDocs: [] };
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function localLoad() {
  try {
    ensureDataDir();
    if (!fs.existsSync(CONTEXT_FILE)) return emptyContext();
    return { ...emptyContext(), ...JSON.parse(fs.readFileSync(CONTEXT_FILE, "utf-8")) };
  } catch {
    return emptyContext();
  }
}

function localSave(ctx) {
  ensureDataDir();
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify(ctx, null, 2), "utf-8");
}

const localImpl = {
  loadContext: async () => localLoad(),
  setResume: async (_userId, { filename, text }) => {
    const ctx = localLoad();
    ctx.resume = { filename, text: cleanText(text), uploadedAt: Date.now() };
    localSave(ctx);
  },
  setJobDescription: async (_userId, { filename, text, source }) => {
    const ctx = localLoad();
    ctx.jobDescription = { filename: filename || null, source: source || "paste", text: cleanText(text), uploadedAt: Date.now() };
    localSave(ctx);
  },
  addOtherDoc: async (_userId, { filename, text }) => {
    const ctx = localLoad();
    ctx.otherDocs.push({ id: crypto.randomUUID(), filename, text: cleanText(text), uploadedAt: Date.now() });
    localSave(ctx);
  },
  removeDoc: async (_userId, kind, id) => {
    const ctx = localLoad();
    if (kind === "resume") ctx.resume = null;
    else if (kind === "jobDescription") ctx.jobDescription = null;
    else if (kind === "other") ctx.otherDocs = ctx.otherDocs.filter((d) => d.id !== id);
    else throw new Error("Unknown document kind: " + kind);
    localSave(ctx);
  },
};

// ---------------- postgres (multi-tenant) backend ----------------

const pgImpl = {
  loadContext: async (userId) => {
    const [ctxRes, docsRes] = await Promise.all([
      query(`SELECT * FROM user_context WHERE user_id = $1`, [userId]),
      query(`SELECT id, filename, text, uploaded_at FROM user_other_docs WHERE user_id = $1 ORDER BY uploaded_at`, [userId]),
    ]);
    const row = ctxRes.rows[0];
    return {
      resume: row?.resume_text ? { filename: row.resume_filename, text: row.resume_text, uploadedAt: +row.resume_uploaded_at } : null,
      jobDescription: row?.jd_text ? { filename: row.jd_filename, source: row.jd_source, text: row.jd_text, uploadedAt: +row.jd_uploaded_at } : null,
      otherDocs: docsRes.rows.map((d) => ({ id: d.id, filename: d.filename, text: d.text, uploadedAt: +d.uploaded_at })),
    };
  },
  setResume: async (userId, { filename, text }) => {
    await query(
      `INSERT INTO user_context (user_id, resume_filename, resume_text, resume_uploaded_at, updated_at)
       VALUES ($1, $2, $3, now(), now())
       ON CONFLICT (user_id) DO UPDATE SET resume_filename = $2, resume_text = $3, resume_uploaded_at = now(), updated_at = now()`,
      [userId, filename, cleanText(text)]
    );
  },
  setJobDescription: async (userId, { filename, text, source }) => {
    await query(
      `INSERT INTO user_context (user_id, jd_filename, jd_text, jd_source, jd_uploaded_at, updated_at)
       VALUES ($1, $2, $3, $4, now(), now())
       ON CONFLICT (user_id) DO UPDATE SET jd_filename = $2, jd_text = $3, jd_source = $4, jd_uploaded_at = now(), updated_at = now()`,
      [userId, filename || null, cleanText(text), source || "paste"]
    );
  },
  addOtherDoc: async (userId, { filename, text }) => {
    await query(`INSERT INTO user_other_docs (user_id, filename, text) VALUES ($1, $2, $3)`, [userId, filename, cleanText(text)]);
  },
  removeDoc: async (userId, kind, id) => {
    if (kind === "resume") {
      await query(`UPDATE user_context SET resume_filename = NULL, resume_text = NULL, resume_uploaded_at = NULL WHERE user_id = $1`, [userId]);
    } else if (kind === "jobDescription") {
      await query(`UPDATE user_context SET jd_filename = NULL, jd_text = NULL, jd_source = NULL, jd_uploaded_at = NULL WHERE user_id = $1`, [userId]);
    } else if (kind === "other") {
      await query(`DELETE FROM user_other_docs WHERE user_id = $1 AND id = $2`, [userId, id]);
    } else {
      throw new Error("Unknown document kind: " + kind);
    }
  },
};

const impl = MODE === "postgres" ? pgImpl : localImpl;

export async function loadContext(userId) {
  return impl.loadContext(userId);
}
export async function setResume(userId, data) {
  return impl.setResume(userId, data);
}
export async function setJobDescription(userId, data) {
  return impl.setJobDescription(userId, data);
}
export async function addOtherDoc(userId, data) {
  return impl.addOtherDoc(userId, data);
}
export async function removeDoc(userId, kind, id) {
  return impl.removeDoc(userId, kind, id);
}

// Summary for the extension/website UI - never sends full document text over
// the wire unnecessarily, just what's needed to show "what's loaded".
export async function contextSummary(userId) {
  const ctx = await loadContext(userId);
  return {
    resume: ctx.resume ? { filename: ctx.resume.filename, uploadedAt: ctx.resume.uploadedAt, chars: ctx.resume.text.length } : null,
    jobDescription: ctx.jobDescription
      ? { filename: ctx.jobDescription.filename, source: ctx.jobDescription.source, uploadedAt: ctx.jobDescription.uploadedAt, chars: ctx.jobDescription.text.length }
      : null,
    otherDocs: ctx.otherDocs.map((d) => ({ id: d.id, filename: d.filename, uploadedAt: d.uploadedAt, chars: d.text.length })),
  };
}

export async function isReady(userId) {
  const ctx = await loadContext(userId);
  return !!(ctx.resume && ctx.jobDescription);
}

export const STORAGE_MODE = MODE;
