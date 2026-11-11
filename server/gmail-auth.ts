/**
 * Gmail OAuth for the demo account: Desktop loopback flow with PKCE (S256) and a random state, run by
 * scripts/gmail-auth.ts (npm run gmail:auth). Split out so the whole flow is testable with a fake transport
 * and a simulated browser. Never prints a token, a secret or the client file's contents.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Transport } from "./gmail.ts";

export const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"] as const;
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

/** The account gmail:auth accepts when CONTRA_GMAIL_ADDRESS is unset (the human's demo account). */
export const DEFAULT_DEMO_ACCOUNT = "contra.demo.ak@gmail.com";

export const expectedAccount = (env: Record<string, string | undefined>) => ((env.CONTRA_GMAIL_ADDRESS ?? "").trim() || DEFAULT_DEMO_ACCOUNT).toLowerCase();

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

/** Reads a Desktop client JSON (fields under "installed"). Errors never include the file's contents. */
export function readOAuthClient(path: string): OAuthClient {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`couldn't read ${path} as JSON (download the Desktop OAuth client JSON from Google Cloud)`);
  }
  const installed = json && typeof json === "object" ? (json as { installed?: { client_id?: unknown; client_secret?: unknown } }).installed : undefined;
  if (!installed || typeof installed.client_id !== "string" || typeof installed.client_secret !== "string") {
    throw new Error(`${path} has no "installed" client_id and client_secret (is it a Desktop OAuth client?)`);
  }
  return { clientId: installed.client_id, clientSecret: installed.client_secret };
}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** PKCE: a random verifier and its S256 challenge. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

export function authUrl(p: { clientId: string; redirectUri: string; challenge: string; state: string; loginHint: string }): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    state: p.state,
    access_type: "offline",
    prompt: "consent",
    login_hint: p.loginHint,
  });
  return `${AUTH_URL}?${q}`;
}

/**
 * Sets each key in a dotenv text: replaces the first `KEY=` line in place (dropping later duplicates),
 * appends keys that aren't there, keeps every other line and the file's line endings. Strips a BOM.
 */
export function updateEnvText(text: string, updates: Record<string, string>): string {
  const src = text.replace(/^﻿/, "");
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  const lines = src.length ? src.split(/\r?\n/) : [];
  const trailing = lines.length > 0 && lines[lines.length - 1] === "";
  if (trailing) lines.pop();
  const done = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const key = m?.[1];
    if (key && Object.hasOwn(updates, key)) {
      if (done.has(key)) continue;
      done.add(key);
      out.push(`${key}=${envValue(updates[key]!)}`);
    } else out.push(line);
  }
  for (const [k, v] of Object.entries(updates)) if (!done.has(k)) out.push(`${k}=${envValue(v)}`);
  return out.join(eol) + eol;
}

function envValue(v: string): string {
  if (/[\r\n]/.test(v)) throw new Error("a value for .env.local can't contain a line break");
  return /^[A-Za-z0-9._\-/@+:=]*$/.test(v) ? v : `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export type AuthOutcome = { ok: true; account: string; values: Record<string, string> } | { ok: false; message: string };

/**
 * The whole flow: loopback server on 127.0.0.1 (OS-assigned port), browser to Google, code exchange with
 * PKCE, then users/me/profile. Refuses (saves nothing) unless the profile is the expected account.
 * `openBrowser` gets the URL; the caller also prints it. Resolves with what to write to .env.local.
 */
export async function runAuthFlow(p: {
  client: OAuthClient;
  expected: string;
  transport: Transport;
  openBrowser: (url: string) => void;
  timeoutMs?: number;
}): Promise<AuthOutcome> {
  const { verifier, challenge } = pkce();
  const state = b64url(randomBytes(24));

  let resolveCode!: (r: { code: string } | { error: string }) => void;
  const got = new Promise<{ code: string } | { error: string }>((r) => (resolveCode = r));
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/") {
      res.writeHead(404).end();
      return;
    }
    const page = (msg: string) => res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(`${msg}\n\nYou can close this tab and return to the terminal.\n`);
    if (url.searchParams.get("state") !== state) {
      page("This sign-in link doesn't match the one Contra started (state mismatch). Nothing was saved.");
      resolveCode({ error: "the browser came back with a different state (start npm run gmail:auth again)" });
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (error || !code) {
      page("Google didn't grant access. Nothing was saved.");
      resolveCode({ error: `Google returned ${error && /^[a-z_]{1,40}$/.test(error) ? error : "no code"}` });
      return;
    }
    page("Signed in. Contra is checking the account.");
    resolveCode({ code });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const timer = setTimeout(() => resolveCode({ error: "no answer from the browser within the time limit" }), p.timeoutMs ?? 5 * 60_000);

  try {
    p.openBrowser(authUrl({ clientId: p.client.clientId, redirectUri, challenge, state, loginHint: p.expected }));
    const r = await got;
    if ("error" in r) return { ok: false, message: r.error };

    const tokenRes = await p.transport(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: r.code, code_verifier: verifier, client_id: p.client.clientId, client_secret: p.client.clientSecret, redirect_uri: redirectUri }),
    });
    const tokens = (await tokenRes.json().catch(() => null)) as { access_token?: unknown; refresh_token?: unknown; error?: unknown } | null;
    if (!tokenRes.ok || typeof tokens?.access_token !== "string") {
      const code = typeof tokens?.error === "string" && /^[a-z_]{1,40}$/.test(tokens.error) ? `, ${tokens.error}` : "";
      return { ok: false, message: `exchanging the code failed (HTTP ${tokenRes.status}${code})` };
    }
    if (typeof tokens.refresh_token !== "string" || !tokens.refresh_token) {
      return { ok: false, message: "Google returned no refresh token; run npm run gmail:auth again (it asks for consent each time)" };
    }

    const profileRes = await p.transport(PROFILE_URL, { headers: { authorization: `Bearer ${tokens.access_token}` } });
    const profile = (await profileRes.json().catch(() => null)) as { emailAddress?: unknown } | null;
    if (!profileRes.ok || typeof profile?.emailAddress !== "string") return { ok: false, message: `reading the Gmail profile failed (HTTP ${profileRes.status})` };
    const account = profile.emailAddress.toLowerCase();
    const mismatch = accountMismatch(account, p.expected);
    if (mismatch) return { ok: false, message: mismatch };

    return {
      ok: true,
      account,
      values: {
        CONTRA_GMAIL_ADDRESS: account,
        CONTRA_GMAIL_CLIENT_ID: p.client.clientId,
        CONTRA_GMAIL_CLIENT_SECRET: p.client.clientSecret,
        CONTRA_GMAIL_REFRESH_TOKEN: tokens.refresh_token,
      },
    };
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
  }
}

/** null when the signed-in account is the expected one; otherwise what to tell the human. */
export function accountMismatch(actual: string, expected: string): string | null {
  if (actual.trim().toLowerCase() === expected.trim().toLowerCase()) return null;
  return `You signed in as ${actual}, but Contra needs ${expected}. Nothing was saved. Run npm run gmail:auth again and pick ${expected} in Google's account chooser.`;
}
