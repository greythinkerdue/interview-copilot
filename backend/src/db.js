// Single shared Postgres connection pool. Only used when STORAGE_MODE=postgres
// (see context.js) - local dev defaults to the JSON-file-backed mode and never
// touches this module.
import pg from "pg";

let pool = null;

export function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set - required when STORAGE_MODE=postgres.");
    }
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
    });
  }
  return pool;
}

export async function query(text, params) {
  return getPool().query(text, params);
}
