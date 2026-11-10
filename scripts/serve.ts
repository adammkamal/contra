/**
 * Local JSON API for the demo frontend.  npm run api
 * env (from .env.local): CONTRA_PORT (default 4100), CONTRA_ALLOWED_ORIGINS, CONTRA_TRY_DAILY_CAP, and for the
 * live inbox CONTRA_INBOX=gmail, CONTRA_GMAIL_POLL_SECONDS (default 20, at least 10), CONTRA_AP_INBOX, plus the
 * CONTRA_GMAIL_* values written by npm run gmail:auth.
 */
import { allowedOriginsFromEnv, createApiServer, tryDailyCapFromEnv, type ApiOptions } from "../server/api.ts";
import { GmailClient, gmailConfigFromEnv, GmailMemoSender, InboxPoller, modelExtractor, pollSecondsFromEnv } from "../server/gmail.ts";
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
let live: Pick<ApiOptions, "inbox" | "memoSender"> = {};
let liveNote = "inbox: sample data (set CONTRA_INBOX=gmail for the live inbox)";
if (mode === "gmail") {
  const intervalMs = pollSecondsFromEnv(process.env) * 1000;
  const cfg = gmailConfigFromEnv(process.env);
  if (cfg.ok) {
    const client = new GmailClient(cfg.config, fetch, Date.now);
    const poller = new InboxPoller({ client, extract: modelExtractor(modelSettings), now: Date.now });
    live = { inbox: { poller, intervalMs }, memoSender: new GmailMemoSender(client, Date.now) };
    liveNote = `inbox: Gmail, reading ${cfg.config.intake} every ${intervalMs / 1000}s; memos go to ${cfg.config.apInbox}`;
  } else {
    // Not configured: the server keeps running with sample data and /api/health says why.
    live = { inbox: { poller: new InboxPoller({ client: null, notConfigured: cfg.message, extract: modelExtractor(modelSettings), now: Date.now }), intervalMs } };
    liveNote = `inbox: ${cfg.message}`;
  }
}

const api = createApiServer({ dbPath: "data/demo.db", allowedOrigins, try: { settings: modelSettings, dailyCap: tryDailyCapFromEnv(process.env) }, ...live });
api.server.listen(port, "127.0.0.1", () => {
  console.log(`Contra API on http://127.0.0.1:${port}  (GET /api/screens, /api/events, /api/health; POST /api/action, /api/reset, /api/try)`);
  console.log(`CORS allowed for: ${allowedOrigins.join(", ")}`);
  console.log(liveNote);
  void api.pollNow();
});
