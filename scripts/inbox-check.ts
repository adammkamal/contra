/**
 * Lists what the live inbox poll would ingest (npm run inbox:check): date, from, subject, and whether each
 * message would be skipped and why. Reads Gmail only: it ingests nothing and never calls the model.
 * "already ingested" is checked against data/live.db (the live workspace) when it exists (opened read-only for the check).
 */
import { existsSync } from "node:fs";
import { App } from "../src/app.ts";
import { GmailClient, gmailConfigFromEnv, InboxPoller, MAX_PER_POLL, NO_ALLOWED_SENDERS } from "../server/gmail.ts";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* reported as not configured */
}
const cfg = gmailConfigFromEnv(process.env);
if (!cfg.ok) {
  console.error(cfg.message);
  process.exit(2);
}
const DB = "data/live.db";
const app = existsSync(DB) ? new App(DB, { workspace: "live" }) : null;
const client = new GmailClient(cfg.config, fetch, Date.now);
const poller = new InboxPoller({ client, extract: async () => ({ ok: false, reason: "inbox:check never extracts" }), now: Date.now });
try {
  const planned = await poller.plan((key) => app?.ctx.contra.hasMessage(key) ?? false);
  console.log(`Intake ${cfg.config.intake}: newest ${planned.length} message(s) (at most ${MAX_PER_POLL}); memos go to ${cfg.config.apInbox}`);
  console.log(
    cfg.config.allowedSenders.length
      ? `Allowed senders (CONTRA_INTAKE_ALLOWED_SENDERS): ${cfg.config.allowedSenders.join(", ")}; each must also pass Gmail's DKIM or SPF check for its domain`
      : `Allowed senders: none. ${NO_ALLOWED_SENDERS}: set CONTRA_INTAKE_ALLOWED_SENDERS in .env.local, or nothing is ingested`,
  );
  if (!app) console.log(`(${DB} not found: "already ingested" can't be checked)`);
  for (const m of planned) {
    console.log(`- ${m.date || "(no date)"} | ${m.from || "(no sender)"} | ${m.subject || "(no subject)"}\n    ${m.skip ? `skip: ${m.skip}` : "would ingest (one model call)"}`);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  app?.close();
}
