/**
 * Connects Contra to the demo Gmail account (npm run gmail:auth). Opens Google's consent page, checks the
 * signed-in account is CONTRA_GMAIL_ADDRESS (default: the demo account), and saves CONTRA_GMAIL_ADDRESS,
 * CONTRA_GMAIL_CLIENT_ID, CONTRA_GMAIL_CLIENT_SECRET and CONTRA_GMAIL_REFRESH_TOKEN into .env.local.
 * Reads the Desktop OAuth client from private/gmail-oauth-client.json. Prints "saved" and the account only.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { expectedAccount, readOAuthClient, runAuthFlow, updateEnvText } from "../server/gmail-auth.ts";

const ENV_FILE = ".env.local";
const CLIENT_FILE = "private/gmail-oauth-client.json";

try {
  process.loadEnvFile(ENV_FILE);
} catch {
  /* no .env.local yet: it is created */
}

/** Opens the URL without a shell; failures are ignored (the URL is printed anyway). */
function openBrowser(url: string): void {
  const [cmd, args] = process.platform === "win32" ? ["explorer.exe", [url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* printed below */
  }
}

let client;
try {
  client = readOAuthClient(CLIENT_FILE);
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
const expected = expectedAccount(process.env);
const result = await runAuthFlow({
  client,
  expected,
  transport: fetch,
  openBrowser: (url) => {
    console.log(`Sign in as ${expected} in the browser. If it didn't open, open this URL:\n\n${url}\n`);
    openBrowser(url);
  },
});
if (!result.ok) {
  console.error(result.message);
  process.exit(1);
}
const before = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
if (before.includes("\u0000")) {
  // UTF-16 (e.g. written by a PowerShell redirect): rewriting it would destroy the other keys in it.
  console.error(`${ENV_FILE} isn't UTF-8. Nothing was saved. Re-save it as UTF-8 (e.g. in VS Code: "Save with Encoding"), then run npm run gmail:auth again.`);
  process.exit(1);
}
writeFileSync(ENV_FILE, updateEnvText(before, result.values), { encoding: "utf8" });
console.log(`saved ${result.account}`);
