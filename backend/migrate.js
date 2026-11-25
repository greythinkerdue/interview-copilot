// One-off schema migration runner. Usage: npm run migrate
// Applies every .sql file in migrations/ in filename order. Idempotent (uses
// IF NOT EXISTS everywhere), so safe to re-run.
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getPool } from "./src/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(__dirname, "migrations");

const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
if (!files.length) {
  console.log("No migration files found in migrations/.");
  process.exit(0);
}

const pool = getPool();
for (const file of files) {
  const sql = fs.readFileSync(path.join(dir, file), "utf-8");
  console.log(`Applying ${file}...`);
  await pool.query(sql);
}
console.log("Migrations applied successfully.");
await pool.end();
