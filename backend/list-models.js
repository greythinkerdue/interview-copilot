// Quick helper: prints which models your Groq account currently has access to.
// Groq's lineup changes over time, so this is more reliable than any hardcoded list.
import "dotenv/config";

if (!process.env.GROQ_API_KEY) {
  console.error("Set GROQ_API_KEY in backend/.env first.");
  process.exit(1);
}

const res = await fetch("https://api.groq.com/openai/v1/models", {
  headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
});
const data = await res.json();
if (!res.ok) {
  console.error("Error:", data);
  process.exit(1);
}
console.log("Models available on your Groq account:\n");
for (const m of data.data) console.log(" -", m.id);
