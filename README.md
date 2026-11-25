# Interview Copilot

A floating AI teleprompter Chrome extension for live interviews (Google Meet / Zoom / Teams / any tab).
It listens for interview questions (microphone or manual input), classifies them, and generates a
ready-to-speak, first-person answer tailored to **your own uploaded resume/CV and the job description**
you're interviewing for - fully generic, not tied to any specific person or company.

Two pieces:
- `backend/` - a tiny local Node.js server that holds your Groq API key, stores your uploaded resume/job
  description locally, and calls a fast open model (`openai/gpt-oss-120b` by default). Never ship an API
  key inside the extension itself.
- `extension/` - the Chrome Extension (Manifest V3) with the floating teleprompter overlay.

---

## 1. Setup (Windows)

### 1.1 Backend

```powershell
cd backend
npm install
copy .env.example .env
```

Get a key at https://console.groq.com/keys (sign in, "Create API Key" - no credit card required
to sign up). Edit `backend\.env` and paste it:

```
GROQ_API_KEY=gsk_...your real key...
```

The default model (`GROQ_MODEL` in `.env`) is `openai/gpt-oss-120b` - tested end-to-end with a real
key and gives solid, natural Indonesian + English answers with no fabricated numbers. Groq is not a
flat-free tier like some providers, but pricing is per-token and tiny: a full interview's worth of
questions will cost a small fraction of a cent.

**Groq's model lineup changes over time** (e.g. `llama-3.3-70b-versatile` was tried first but is no
longer available on a fresh account as of this build) - run this to see exactly what your account can
currently use, and edit `GROQ_MODEL` in `.env` to switch (restart the backend after):

```powershell
npm run list-models
```

If an answer comes back odd, use **Regenerate**, or just answer in your own words; the question
categorization and manual-input flow don't depend on the model being perfect. The prompt explicitly
forbids inventing specific numbers/percentages not in the real CV - if you ever see a stat that isn't
in your actual background, treat it as wrong and don't repeat it.

Start it:

```powershell
npm start
```

You should see:

```
Interview Copilot backend listening on http://localhost:3001
```

Leave this terminal window running during your interview. Keep it running in the background.

### 1.2 Chrome Extension

1. Open Chrome and go to `chrome://extensions`
2. Turn on **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension` folder inside this project
5. Pin the "Interview Copilot" icon to your toolbar (puzzle-piece icon -> pin)

### 1.3 Connect the extension to the backend, and upload your resume + job description

1. Right-click the Interview Copilot icon -> **Options** (or `chrome://extensions` -> Details -> Extension options)
2. Confirm Backend URL is `http://localhost:3001` (default), click **Test connection** - should say
   "Connected. Model: openai/gpt-oss-120b. Groq key set: yes"
3. **Upload your resume/CV** (PDF, DOCX, or TXT) under section 1.
4. **Paste or upload the job description** under section 2 (paste the job posting text directly, or
   upload a file).
5. (Optional) Add any other supporting documents under section 3 - portfolio, achievements list, etc.

The AI will not generate answers until both a resume and a job description are loaded - this is what
makes every answer grounded in your real background instead of a generic/hallucinated one. Uploaded
documents are stored only on your own machine (`backend/data/context.json`), never sent anywhere except
to the AI model when you ask a question.

---

## 2. Using it during the interview

1. Open your Google Meet / Zoom / Teams tab.
2. Click the Interview Copilot toolbar icon (or press `Alt+Shift+I`) to show the floating overlay.
3. Drag it anywhere by its header. Resize it from the bottom-right corner handle.
4. Two ways to get an answer:
   - **Manual (always reliable):** type the interviewer's question into the bottom input and press Enter.
   - **Automatic (microphone):** click "Listening: OFF" to turn it on (grant microphone permission when Chrome asks). It transcribes your mic input and auto-detects finished questions after a short pause in speech.
5. The detected question, category (HR / Behavioral / Technical / etc.), and a ready-to-speak first-person answer appear. Use **Regenerate**, **Shorter**, **Detailed**, **Copy**, or **Useful** as needed.
6. Adjust opacity, font size, theme (sun icon), and compact mode (⋮ icon) from the footer to fit your screen layout next to the call window.

### Keyboard shortcuts
- `Alt+Shift+I` - show/hide overlay
- `Alt+Shift+L` - start/stop listening
- `Alt+Shift+C` - copy the latest answer

(Chrome assigns these; if they conflict with another extension, change them at `chrome://extensions/shortcuts`.)

---

## 3. Important limitations (read before you rely on this live)

- **Automatic question detection uses your microphone (Web Speech API), not literal tab audio capture.**
  Chrome's `tabCapture` API can grab the Meet/Zoom tab's audio, but there is no supported way to feed
  that raw stream into a speech-to-text engine without an extra paid STT backend (Deepgram/AssemblyAI/
  Whisper) and an audio-chunk-streaming pipeline. Building and testing that reliably was not realistic
  before your 1:00 PM interview, so this MVP uses the microphone instead, which:
  - Works out of the box, no extra API key needed.
  - On a laptop, naturally also picks up the interviewer's voice coming out of your speakers, so it
    generally works for in-person-at-your-desk video calls.
  - Will also hear **your own voice**. Use the 🔇 **pause** button in the footer while you're speaking
    so your own answer doesn't get mis-treated as the next "question".
  - A manual question-mark/length filter (ignores fragments under 3 words) reduces false triggers.
- **Manual input is the guaranteed fallback** - if listening ever misfires or mishears, just type the
  question. This path is fully tested and does not depend on microphone/audio at all.
- **Optional Beta tab-audio transcription endpoint** (`POST /api/transcribe` in the backend) is wired up
  to OpenAI Whisper if you set `OPENAI_API_KEY` in `backend/.env`, but the extension does not call it
  automatically yet (no stable low-latency tab-audio chunking UI was built in the time available). It's
  there as a starting point if you want to extend it later - not required for today.
- The AI never invents company-internal facts (revenue, partnership terms, etc.) - it was explicitly
  instructed not to, per the prompt rules in `backend/src/profile.js`.
- Nothing is recorded or stored permanently. Speech recognition happens live in the browser; questions/
  answers live only in memory for the current tab session (cleared on reload); appearance settings
  (position, theme, opacity, font size) are kept in `chrome.storage.session`, which Chrome clears when
  the browser closes.

---

## 4. What was tested

- Backend: boots; `/api/health` and `/api/generate-answer` tested end-to-end against the **real** Groq
  API with a real key - an HR/intro question, an English behavioral question (verified natural STAR
  narrative with no "Situation/Task/Action/Result" labels), an Indonesian business-strategy question
  (verified no STAR used, as required), a follow-up question (verified `isFollowUp: true` + correct
  category + uses prior context), and `shorter` mode. One real quality issue was caught this way - the
  model invented a specific statistic ("mengurangi kesalahan data hingga 12%") that isn't in the real
  CV - and fixed by tightening the anti-fabrication rule in the system prompt; re-tested and confirmed
  fixed (qualitative language used instead of invented numbers).
- Extension UI: verified via `scripts/test-harness.html` (a stub page that fakes the `chrome.*` APIs so the
  real `content.js`/`overlay.css` can run and be screenshotted without needing `chrome://extensions`):
  drag, resize, minimize/restore, close, dark/light theme, compact mode, opacity slider, font size
  controls, manual question submission -> category badge + answer rendering, Shorter/Regenerate/Copy/
  Mark-as-useful, and the "backend not configured" error path. One real bug was found and fixed this way
  (minimized state left a gap due to a leftover `min-height`).
- Not exercised by automation (needs a real browser profile + your own mic): the live microphone
  recognition loop and the `chrome://extensions` "Load unpacked" flow itself - please do step 1.2 above
  and talk/type a test question once before your interview to confirm your machine's mic permission
  prompt behaves as expected.

To re-run the visual harness yourself:
```powershell
node scripts/static-server.js . 5500
# then open http://localhost:5500/scripts/test-harness.html (backend should also be running)
```

---

## 5. Folder structure

```
backend/
  server.js            Express app: /api/health, /api/generate-answer, /api/context/*, /api/transcribe (beta)
  src/profile.js        Prompt-building logic + general answer-style rules (STAR, language, length, category) - fully generic, no hardcoded candidate info
  src/context.js         Stores/parses the uploaded resume, job description, and other docs (PDF/DOCX/TXT)
  src/groq.js            Groq API call wrapper - builds the prompt from the current uploaded context
  list-models.js         Prints which models your Groq account currently has access to
  data/context.json       Your uploaded resume/job description, stored locally (gitignored)
  .env.example
extension/
  manifest.json
  background.js          Service worker: injects content script, proxies fetch to backend
  content.js             Builds the floating shadow-DOM teleprompter UI + mic listening logic
  overlay.css
  options.html/.js        Settings page: backend URL + resume/job-description/other-docs upload UI
  icons/
scripts/
  make-icons.js           Generates the placeholder PNG icons
  static-server.js        Tiny static file server (dev tool)
  test-harness.html       Dev-only page to visually test content.js outside chrome://extensions
  options-harness.html    Dev-only page to visually test options.js outside chrome://extensions
```

## 6. If something breaks right before the interview

- Overlay won't show: click the toolbar icon again, or reload the Meet/Zoom tab and click it once more.
- "Backend offline": make sure the `npm start` terminal in `backend/` is still running.
- Mic not working: just type the question manually - the AI answer quality is identical either way.

---

## 7. Going commercial: hosted multi-tenant mode

Everything above describes **local mode** (`STORAGE_MODE=local`, the default) - one person, one
machine, one JSON file, no accounts. The backend also supports a **hosted mode**
(`STORAGE_MODE=postgres`) with Google sign-in and a real database, so many different people can each
upload their own resume/job description and share one backend deployment. The full architecture
decisions are written up in `C:\Users\MyBook Hype AMD\.claude\plans\foamy-twirling-nest.md`.

### What's already built
- `backend/src/auth.js` - Google sign-in (ID token verification for the website, OAuth
  authorization-code exchange for the Chrome extension via `chrome.identity.launchWebAuthFlow`),
  JWT session issuing/verification.
- `backend/src/db.js` + `backend/migrations/001_init.sql` - Postgres connection + schema
  (`users`, `user_context`, `user_other_docs`, `usage_log`).
- `backend/src/context.js` - now supports both storage backends behind the same function names.
- `backend/public/` - a plain-HTML website: landing page with "Sign in with Google", and a
  `/dashboard` page to upload resume/job description (same UI pattern as the extension's Options page).
- Per-user daily request cap (`DAILY_REQUEST_LIMIT`) and IP-based rate limiting on auth/generate
  routes, so one shared Groq key can't be exhausted by a single user.

### To actually go live, you need to do these yourself (I can't create accounts for you):

1. **Create a Railway account** (https://railway.app), make a new Project, and add the **Postgres**
   plugin to it - this auto-generates a `DATABASE_URL`.
2. **Push this repo to GitHub** (it's already a git repo - `git remote add origin <your-repo-url>`
   then `git push -u origin main`), then connect that GitHub repo to your Railway project so it
   deploys automatically.
3. **Google Cloud Console** (https://console.cloud.google.com): create a project, go to
   "APIs & Services > Credentials", create an **OAuth 2.0 Client ID** (type: Web application).
   - Authorized JavaScript origin: your Railway domain (e.g. `https://yourapp.up.railway.app`)
   - Authorized redirect URIs: `https://yourapp.up.railway.app` (for the website) and
     `https://<your-extension-id>.chromiumapp.org/` (for the Chrome extension - you'll know this
     ID once you load the unpacked extension; it changes if you later publish to the Chrome Web Store)
   - Configure the OAuth consent screen (External, basic info). Until you submit it for Google's
     verification (needs a privacy policy URL), users will see an "unverified app" warning - fine
     pre-launch.
4. **Set these environment variables in Railway's dashboard** for the backend service:
   ```
   STORAGE_MODE=postgres
   GROQ_API_KEY=<your key>
   GOOGLE_CLIENT_ID=<from step 3>
   GOOGLE_CLIENT_SECRET=<from step 3>
   JWT_SECRET=<generate one: openssl rand -base64 32>
   ALLOWED_ORIGINS=https://yourapp.up.railway.app,chrome-extension://<your-extension-id>
   DAILY_REQUEST_LIMIT=100
   ```
   (`DATABASE_URL` is set automatically by the Postgres plugin.)
5. **Run the schema migration once** against the new database: `npm run migrate` (with
   `DATABASE_URL` set in your shell, or via Railway's one-off command runner).
6. **Point the extension at the hosted backend**: in `extension/background.js`, change
   `DEFAULT_BACKEND_URL` from `http://localhost:3001` to your Railway domain, then reload the
   unpacked extension.
7. Optional: buy a custom domain and point it at Railway; optional: a Chrome Web Store developer
   account ($5 one-time) to publish the extension publicly instead of side-loading it.

**Deliberately not built yet** (documented as out-of-scope for this pass): billing/subscriptions,
tiered plans, an admin dashboard, or a polished marketing design - the plan file has the reasoning
for deferring these.
