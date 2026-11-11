/**
 * Local JSON API for the demo frontend.  npm run api
 * env (from .env.local): CONTRA_PORT (default 4100), CONTRA_ALLOWED_ORIGINS, CONTRA_TRY_DAILY_CAP, and for the
 * live inbox CONTRA_INBOX=gmail, CONTRA_INTAKE_ALLOWED_SENDERS, CONTRA_LIVE_DAILY_CAP (default 50 model calls a UTC day),
 * CONTRA_GMAIL_POLL_SECONDS (default 20, at least 10), CONTRA_AP_INBOX, plus the
 * CONTRA_GMAIL_* values written by npm run gmail:auth, and CONTRA_SECURE_COOKIES=1 behind HTTPS.
 * Accounts: data/auth.db (or CONTRA_AUTH_DB), created with npm run user:add -- <username> <role> [--live].
 */
import { allowedOriginsFromEnv, createApiServer, tryDailyCapFromEnv, type ApiOptions } from "../server/api.ts";
import { AuthStore, authDbFromEnv } from "../server/auth.ts";
import { GmailClient, gmailConfigFromEnv, GmailMemoSender, InboxPoller, liveDailyCapFromEnv, modelExtractor, NO_ALLOWED_SENDERS, pollSecondsFromEnv } from "../server/gmail.ts";
import { settingsFromEnv } from "../src/extract/anthropic.ts";

// The model (/api/try and live extraction) reads CONTRA_ANTHROPIC_API_KEY / CONTRA_MODEL / CONTRA_EFFORT (never ANTHROPIC_*).
try {
  process.loadEnvFile(".env.local");
} catch {
  /* no .env.local: /api/try answers 503 and the inbox reports what's missing */
}
const port = Number(process.env.CONTRA_PORT ?? 4100);
const allowedOrigins = allowedOriginsFromEnv(process.env); // CONTRA_ALLOWED_ORIGINS, comma-separated
const modelSettings = () => settingsFromEnv(process.env);

const mode = (process.env.CONTRA_INBOX ?? "").trim();
if (mode && mode !== "gmail") throw new Error(`CONTRA_INBOX must be "gmail" or unset, got "${mode}"`);
let live: Pick<ApiOptions, "inbox" | "memoSender" | "liveDbPath"> = {};
let liveNote = "inbox: sample data (set CONTRA_INBOX=gmail for the live inbox)";
// Live mail goes to its own workspace and database; the scripted demo (data/demo.db) is never touched by the inbox.
const LIVE_DB = "data/live.db";
if (mode === "gmail") {
  const intervalMs = pollSecondsFromEnv(process.env) * 1000;
  const dailyCap = liveDailyCapFromEnv(process.env);
  const cfg = gmailConfigFromEnv(process.env);
  if (cfg.ok) {
    const client = new GmailClient(cfg.config, fetch, Date.now);
    const poller = new InboxPoller({ client, extract: modelExtractor(modelSettings), now: Date.now, dailyCap });
    live = { liveDbPath: LIVE_DB, inbox: { poller, intervalMs }, memoSender: new GmailMemoSender(client, Date.now) };
    liveNote = `inbox: Gmail, reading ${cfg.config.intake} every ${intervalMs / 1000}s; memos go to ${cfg.config.apInbox}\n  senders allowed: ${cfg.config.allowedSenders.join(", ") || `none (${NO_ALLOWED_SENDERS}: nothing will be ingested)`}; at most ${dailyCap} model calls per UTC day`;
  } else {
    // Not configured: the server keeps running with sample data and /api/health says why.
    live = { liveDbPath: LIVE_DB, inbox: { poller: new InboxPoller({ client: null, notConfigured: cfg.message, extract: modelExtractor(modelSettings), now: Date.now, dailyCap }), intervalMs } };
    liveNote = `inbox: ${cfg.message}`;
  }
}

const secure = (process.env.CONTRA_SECURE_COOKIES ?? "").trim();
if (secure && secure !== "1") throw new Error(`CONTRA_SECURE_COOKIES must be "1" or unset, got "${secure}"`);
const authDb = authDbFromEnv(process.env);
const authStore = new AuthStore(authDb);
const api = createApiServer({ auth: { store: authStore, secureCookies: secure === "1" }, dbPath: "data/demo.db", allowedOrigins, try: { settings: modelSettings, dailyCap: tryDailyCapFromEnv(process.env) }, ...live });
api.server.listen(port, "127.0.0.1", () => {
  console.log(`Contra API on http://127.0.0.1:${port}  (GET /api/screens, /api/events, /api/health; POST /api/action, /api/reset, /api/try)`);
  console.log(`CORS allowed for: ${allowedOrigins.join(", ")}`);
  console.log(liveNote);
  const users = authStore.userCount();
  console.log(users ? `accounts: ${users} in ${authDb}${secure === "1" ? " (Secure cookies)" : ""}` : `accounts: none yet; add one with npm run user:add -- <username> <pm|controller|ap> [--live]`);
  void api.pollNow();
});
