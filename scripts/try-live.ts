/**
 * Live smoke test for "try any email": one real model call, then Contra's ingest checks, printed as JSON.
 * Reads CONTRA_ANTHROPIC_API_KEY, CONTRA_MODEL and CONTRA_EFFORT from .env.local (never ANTHROPIC_*).
 *   npm run try:live -- path\to\email.txt
 * The file may start with "From:", "To:" and "Subject:" lines, then a blank line, then the body. Without
 * those lines the whole file is the body. Runs against a fresh demo App in a temp folder (never data/demo.db),
 * and changes nothing.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryEmail, TryUnavailable, type TryInput } from "../server/try.ts";
import { App } from "../src/app.ts";
import { settingsFromEnv } from "../src/extract/anthropic.ts";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* no .env.local: settingsFromEnv reports what's missing */
}
const path = process.argv[2];
if (!path) {
  console.error("Usage: npm run try:live -- path\\to\\email.txt");
  process.exit(2);
}

/** Leading "Header: value" lines (From, To, Subject) up to the first blank line; the rest is the body. */
function parseEmailFile(text: string): TryInput {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const headers: Record<string, string> = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const m = /^(From|To|Subject):\s*(.*)$/i.exec(lines[i]!);
    if (!m) break;
    headers[m[1]!.toLowerCase()] = m[2]!.trim();
  }
  const hasHeaders = i > 0 && (lines[i] ?? "") === "";
  const body = (hasHeaders ? lines.slice(i + 1) : lines).join("\n").trim();
  return {
    subject: hasHeaders ? (headers.subject ?? "") : "",
    body,
    ...(hasHeaders && headers.from ? { from: headers.from } : {}),
    ...(hasHeaders && headers.to ? { to: headers.to } : {}),
  };
}

const input = parseEmailFile(readFileSync(path, "utf8"));
const dir = mkdtempSync(join(tmpdir(), "contra-try-live-"));
const app = new App(join(dir, "try.db"), { start: new Date("2026-11-07T15:00:00Z") });
try {
  const result = await tryEmail(app, input, settingsFromEnv(process.env));
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error(e instanceof TryUnavailable ? `Unavailable (${e.errorType}): ${e.message}` : e);
  process.exitCode = 1;
} finally {
  app.close();
  rmSync(dir, { recursive: true, force: true });
}
