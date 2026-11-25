// Google sign-in + JWT session handling.
//
// Two ways a client proves who they are with Google, converging on one issued
// session JWT:
//  - Website: Google Identity Services button hands back an ID token directly
//    (no redirect) -> POST /api/auth/google { idToken }.
//  - Extension: chrome.identity.launchWebAuthFlow runs a real OAuth2
//    authorization-code redirect against accounts.google.com (extensions
//    can't use the GIS script directly) -> POST /api/auth/google/exchange
//    { code, redirectUri } -> backend exchanges the code server-side.
import { OAuth2Client } from "google-auth-library";
import jwt from "jsonwebtoken";
import { query } from "./db.js";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRY = "7d";

function assertConfigured() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set on the backend.");
  }
  if (!JWT_SECRET) {
    throw new Error("JWT_SECRET is not set on the backend.");
  }
}

async function upsertUserAndIssueToken({ sub, email }) {
  const result = await query(
    `INSERT INTO users (google_sub, email)
     VALUES ($1, $2)
     ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email
     RETURNING id, email`,
    [sub, email]
  );
  const user = result.rows[0];
  const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
  return { token, user };
}

// Website flow: GIS already gives us a verified-by-Google ID token directly.
export async function handleIdToken(idToken) {
  assertConfigured();
  const client = new OAuth2Client(GOOGLE_CLIENT_ID);
  const ticket = await client.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
  const payload = ticket.getPayload();
  return upsertUserAndIssueToken({ sub: payload.sub, email: payload.email });
}

// Extension flow: exchange the authorization code for tokens server-side,
// then verify the resulting ID token the same way.
export async function handleAuthCode(code, redirectUri) {
  assertConfigured();
  const client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, redirectUri);
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) throw new Error("Google did not return an ID token for this code.");
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: GOOGLE_CLIENT_ID });
  const payload = ticket.getPayload();
  return upsertUserAndIssueToken({ sub: payload.sub, email: payload.email });
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing Authorization header." });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired session - please sign in again." });
  }
}
