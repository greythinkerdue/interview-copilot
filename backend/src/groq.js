import { buildSystemPrompt, buildUserTurn, getCurrentGreeting, CATEGORIES } from "./profile.js";
import { loadContext } from "./context.js";

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const API_URL = "https://api.groq.com/openai/v1/chat/completions";

function extractJson(text) {
  const cleaned = text.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found in model response");
  return JSON.parse(cleaned.slice(start, end + 1));
}

export async function generateAnswer({ userId, question, mode, recentHistory }) {
  const ctx = await loadContext(userId);
  const system = buildSystemPrompt({
    currentGreeting: getCurrentGreeting(),
    resumeText: ctx.resume?.text || "",
    jobDescriptionText: ctx.jobDescription?.text || "",
    otherDocsText: ctx.otherDocs.length
      ? ctx.otherDocs.map((d) => `--- ${d.filename} ---\n${d.text}`).join("\n\n")
      : "",
  });
  const userTurn = buildUserTurn({ question, mode, recentHistory });

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userTurn },
      ],
      max_tokens: 2000,
      temperature: 0.6,
      reasoning_effort: "low", // gpt-oss models spend hidden "thinking" tokens out of max_tokens;
      // low effort keeps that small so the visible JSON answer doesn't get truncated.
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Groq API error ${res.status}: ${errBody}`);
  }

  const data = await res.json();
  const choice = data.choices && data.choices[0];
  const rawText = choice?.message?.content;
  if (!rawText) {
    throw new Error(
      choice?.finish_reason === "length"
        ? "Model ran out of tokens before finishing - try again or pick a shorter mode."
        : "Model returned no content - try again in a few seconds, or switch GROQ_MODEL in backend/.env."
    );
  }

  let parsed;
  try {
    parsed = extractJson(rawText);
  } catch {
    // Fall back to raw text so the UI always shows something instead of nothing.
    parsed = { category: "HR", language: "id", isFollowUp: false, answer: rawText.trim() };
  }

  if (!CATEGORIES.includes(parsed.category)) parsed.category = "HR";
  if (parsed.language !== "en") parsed.language = "id";
  parsed.isFollowUp = !!parsed.isFollowUp;
  parsed.answer = String(parsed.answer || "").trim();

  return parsed;
}
