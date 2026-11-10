/**
 * Gmail adapter: reads the PM intake address of the demo inbox and sends credit memos to the stand-in AP
 * inbox. Plain fetch through an injectable Transport, so tests never touch the network. Lives outside
 * src/ (network code); state changes go through src/commands.ts (ingestInboxEmail, sendCreditMemo).
 *
 * Secrets: the refresh token and client secret are only ever placed in a token request body, and the access
 * token only in an Authorization header. No error message, status or log line is built from a response
 * body (only HTTP status codes and Google's short error codes), so none of them can carry a secret.
 */
import { EmlError, parseEml } from "../ingest/eml.ts";
import type { App } from "../src/app.ts";
import { ingestInboxEmail } from "../src/commands.ts";
import type { ModelSettings } from "../src/extract/anthropic.ts";
import { extractBackCharges } from "../src/extract/index.ts";
import type { MemoSender } from "../src/memo.ts";
import type { Actor, Email, ExtractedBackCharge } from "../src/types.ts";
import { MODEL_ERROR_MESSAGES } from "./try.ts";

export type Transport = (url: string, init?: RequestInit) => Promise<Response>;

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
export const MAX_PER_POLL = 20;
export const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
export const GENERATED_HEADER = "X-Contra-Generated";
export const EXPIRED = "expired: run npm run gmail:auth";
export const NOT_CONFIGURED = "not configured: run npm run gmail:auth";

// ---- Configuration ---------------------------------------------------------------------------

/** "local+tag@domain" from "local@domain" (an existing +suffix is replaced). Lower-case. */
export function plusAddress(address: string, tag: string): string {
  const m = /^([^@\s+]+)(?:\+[^@\s]*)?@([^@\s]+\.[^@\s]+)$/.exec(address.trim());
  if (!m) throw new Error(`not an email address: "${address}"`);
  return `${m[1]}+${tag}@${m[2]}`.toLowerCase();
}

export interface GmailConfig {
  /** The demo account (CONTRA_GMAIL_ADDRESS). */
  address: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** PM intake: <local>+backcharges@<domain>. Only mail delivered here is ingested. */
  intake: string;
  /** Stand-in Ramp AP inbox: <local>+ramp-ap@<domain>, or CONTRA_AP_INBOX. Memos go here. */
  apInbox: string;
}

export function gmailConfigFromEnv(env: Record<string, string | undefined>): { ok: true; config: GmailConfig } | { ok: false; message: string } {
  const get = (k: string) => (env[k] ?? "").trim();
  const keys = ["CONTRA_GMAIL_ADDRESS", "CONTRA_GMAIL_CLIENT_ID", "CONTRA_GMAIL_CLIENT_SECRET", "CONTRA_GMAIL_REFRESH_TOKEN"];
  const missing = keys.filter((k) => !get(k));
  if (missing.length) return { ok: false, message: `${NOT_CONFIGURED} (missing ${missing.join(", ")})` };
  const address = get("CONTRA_GMAIL_ADDRESS").toLowerCase();
  let intake: string;
  let apInbox: string;
  try {
    intake = plusAddress(address, "backcharges");
    apInbox = get("CONTRA_AP_INBOX") ? get("CONTRA_AP_INBOX").toLowerCase() : plusAddress(address, "ramp-ap");
  } catch (e) {
    return { ok: false, message: `${NOT_CONFIGURED} (${(e as Error).message})` };
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(apInbox)) return { ok: false, message: "CONTRA_AP_INBOX is not an email address" };
  if (apInbox === intake) return { ok: false, message: "CONTRA_AP_INBOX must not be the PM intake address (memos would be read back as PM mail)" };
  return {
    ok: true,
    config: { address, clientId: get("CONTRA_GMAIL_CLIENT_ID"), clientSecret: get("CONTRA_GMAIL_CLIENT_SECRET"), refreshToken: get("CONTRA_GMAIL_REFRESH_TOKEN"), intake, apInbox },
  };
}

/** CONTRA_GMAIL_POLL_SECONDS: whole seconds, at least 10; unset means 20. Throws on anything else. */
export function pollSecondsFromEnv(env: Record<string, string | undefined>): number {
  const raw = (env.CONTRA_GMAIL_POLL_SECONDS ?? "").trim();
  if (!raw) return 20;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 10) throw new Error(`CONTRA_GMAIL_POLL_SECONDS must be a whole number of seconds, at least 10; got "${raw}"`);
  return n;
}

// ---- Gmail client ----------------------------------------------------------------------------

/** A Gmail or token failure, with a message that is safe to show and to log (no secrets, no response bodies). */
export class GmailError extends Error {}
/** The refresh token was refused (invalid_grant): in Testing mode Google expires it after 7 days. */
export class GmailExpired extends GmailError {}

/** Google's short error code ("invalid_grant"), only when it is plainly one; never free text. */
const errorCode = (json: unknown): string => {
  const e = json && typeof json === "object" ? (json as { error?: unknown }).error : undefined;
  return typeof e === "string" && /^[a-z_]{1,40}$/.test(e) ? e : "";
};

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export interface MessageMeta {
  gmailId: string;
  /** The Message-ID header, or null when the message has none. */
  messageId: string | null;
  date: string;
  from: string;
  subject: string;
  /** Every Delivered-To address, lower-case. */
  deliveredTo: string[];
  /** The message carries X-Contra-Generated (Contra sent it). */
  generated: boolean;
  sizeEstimate: number;
}

const base64url = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const fromBase64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const bareAddress = (v: string) => (/<([^>]+)>/.exec(v)?.[1] ?? v).trim().toLowerCase();

export class GmailClient {
  #token: { value: string; expiresAt: number } | null = null;

  constructor(
    readonly config: GmailConfig,
    private readonly transport: Transport,
    private readonly now: () => number,
  ) {}

  /** The Gmail search for the PM intake address, exactly. */
  get intakeQuery(): string {
    return `deliveredto:${this.config.intake}`;
  }

  async #accessToken(): Promise<string> {
    if (this.#token && this.#token.expiresAt > this.now() + 60_000) return this.#token.value;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.config.refreshToken,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });
    let res: Response;
    try {
      res = await this.transport(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    } catch {
      throw new GmailError("couldn't reach Google to refresh the access token");
    }
    const json = await readJson(res);
    if (!res.ok) {
      const code = errorCode(json);
      if (code === "invalid_grant") throw new GmailExpired(EXPIRED);
      throw new GmailError(`refreshing the access token failed (HTTP ${res.status}${code ? `, ${code}` : ""})`);
    }
    const t = json && typeof json === "object" ? (json as { access_token?: unknown; expires_in?: unknown }) : {};
    if (typeof t.access_token !== "string" || !t.access_token) throw new GmailError("Google returned no access token");
    const ttl = typeof t.expires_in === "number" && t.expires_in > 0 ? t.expires_in : 3600;
    this.#token = { value: t.access_token, expiresAt: this.now() + ttl * 1000 };
    return t.access_token;
  }

  async #api(path: string, init: RequestInit = {}): Promise<unknown> {
    const token = await this.#accessToken();
    let res: Response;
    try {
      res = await this.transport(`${API}${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` } });
    } catch {
      throw new GmailError("couldn't reach the Gmail API");
    }
    if (res.status === 401) {
      this.#token = null;
      throw new GmailError("Gmail refused the access token (HTTP 401); it is refreshed on the next try");
    }
    if (!res.ok) {
      const code = errorCode(await readJson(res));
      throw new GmailError(`Gmail API error (HTTP ${res.status}${code ? `, ${code}` : ""})`);
    }
    return readJson(res);
  }

  /** Ids of the newest messages delivered to the intake address (at most MAX_PER_POLL), newest first. */
  async listIntake(): Promise<string[]> {
    const q = new URLSearchParams({ q: this.intakeQuery, maxResults: String(MAX_PER_POLL) });
    const json = (await this.#api(`/messages?${q}`)) as { messages?: { id?: unknown }[] } | null;
    return (json?.messages ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9]+$/.test(id)).slice(0, MAX_PER_POLL);
  }

  /** Headers and size only (no body). */
  async metadata(id: string): Promise<MessageMeta> {
    const q = new URLSearchParams({ format: "metadata" });
    for (const h of ["Message-ID", "Date", "From", "Subject", "Delivered-To", GENERATED_HEADER]) q.append("metadataHeaders", h);
    const json = (await this.#api(`/messages/${encodeURIComponent(id)}?${q}`)) as { sizeEstimate?: unknown; payload?: { headers?: { name?: unknown; value?: unknown }[] } } | null;
    const headers = new Map<string, string[]>();
    for (const h of json?.payload?.headers ?? []) {
      if (typeof h.name !== "string" || typeof h.value !== "string") continue;
      const k = h.name.toLowerCase();
      headers.set(k, [...(headers.get(k) ?? []), h.value]);
    }
    const one = (k: string) => headers.get(k)?.[0] ?? "";
    return {
      gmailId: id,
      messageId: one("message-id").trim() || null,
      date: one("date"),
      from: one("from"),
      subject: one("subject"),
      deliveredTo: (headers.get("delivered-to") ?? []).map(bareAddress),
      generated: headers.has(GENERATED_HEADER.toLowerCase()),
      sizeEstimate: typeof json?.sizeEstimate === "number" ? json.sizeEstimate : 0,
    };
  }

  /** The whole RFC 822 message (format=raw, base64url-decoded). */
  async raw(id: string): Promise<Buffer> {
    const json = (await this.#api(`/messages/${encodeURIComponent(id)}?format=raw`)) as { raw?: unknown } | null;
    if (typeof json?.raw !== "string") throw new GmailError(`message ${id} came back without its raw content`);
    return fromBase64url(json.raw);
  }

  /** Sends an RFC 822 message from the account; returns Gmail's message id. */
  async send(mime: string): Promise<string> {
    const json = (await this.#api("/messages/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ raw: base64url(mime) }) })) as { id?: unknown } | null;
    if (typeof json?.id !== "string") throw new GmailError("Gmail accepted the memo but returned no message id");
    return json.id;
  }
}

// ---- What to ingest --------------------------------------------------------------------------

/** The key ingest is idempotent on: the Message-ID, or Gmail's id when a message has none. */
export const messageKey = (m: Pick<MessageMeta, "messageId" | "gmailId">) => m.messageId ?? `<gmail-${m.gmailId}@mail.gmail.com>`;

/** Why a listed message is not ingested, or null when it should be. Pure. */
export function skipReason(m: MessageMeta, intake: string, alreadyIngested: (key: string) => boolean): string | null {
  if (m.generated) return `sent by Contra (${GENERATED_HEADER})`;
  if (m.sizeEstimate > MAX_MESSAGE_BYTES) return "larger than 5 MB";
  if (!m.deliveredTo.includes(intake.toLowerCase())) return `not delivered to ${intake}`;
  if (alreadyIngested(messageKey(m))) return "already ingested";
  return null;
}

/** The header block of a raw message (up to the first blank line). */
function headerBlock(raw: Buffer): string {
  const text = raw.subarray(0, Math.min(raw.length, 256 * 1024)).toString("latin1");
  const end = text.search(/\r?\n\r?\n/);
  return end < 0 ? text : text.slice(0, end);
}

export interface PlannedMessage extends MessageMeta {
  skip: string | null;
}

// ---- Polling ---------------------------------------------------------------------------------

export interface InboxStatus {
  /** "gmail" when CONTRA_INBOX=gmail, else "sample" (the demo's own emails only). */
  mode: "gmail" | "sample";
  /** The PM intake address read, or null. */
  address: string | null;
  lastPollAt: string | null;
  lastError: string | null;
  /** "off", "starting", "ok", "error", "expired: run npm run gmail:auth" or "not configured: ...". */
  status: string;
}

export const SAMPLE_INBOX: InboxStatus = { mode: "sample", address: null, lastPollAt: null, lastError: null, status: "off" };

/** Extraction for one live email: the model's items, or a reason (in words) it couldn't be extracted. */
export type Extract = (email: Email) => Promise<{ ok: true; items: ExtractedBackCharge[]; actor: Actor } | { ok: false; reason: string }>;

/** The live extractor: src/extract with Contra's model settings. Never writes anything to disk. */
export function modelExtractor(settings: () => { ok: true; settings: ModelSettings } | { ok: false; message: string }): Extract {
  return async (email) => {
    const s = settings();
    if (!s.ok) return { ok: false, reason: "the model isn't configured (CONTRA_ANTHROPIC_API_KEY in .env.local)" };
    const r = await extractBackCharges(s.settings, email);
    if (!r.ok) return { ok: false, reason: MODEL_ERROR_MESSAGES[r.errorType] };
    return { ok: true, items: r.items, actor: r.actor };
  };
}

/** A message whose extraction failed this many times is skipped until the server restarts (each try costs a model call). */
export const MAX_EXTRACTION_TRIES = 3;

/**
 * Polls the intake address and ingests new mail through ingestInboxEmail. poll() never throws and never
 * overlaps itself: errors land in status(). Messages skipped for good (sent by Contra, too large, not for
 * the intake address, unreadable) are remembered in memory, so they aren't fetched again.
 */
export class InboxPoller {
  #running = false;
  #status: InboxStatus;
  readonly #skipped = new Map<string, string>();
  readonly #tries = new Map<string, number>();

  constructor(private readonly opts: { client: GmailClient | null; notConfigured?: string; extract: Extract; now: () => number }) {
    this.#status = opts.client
      ? { mode: "gmail", address: opts.client.config.intake, lastPollAt: null, lastError: null, status: "starting" }
      : { mode: "gmail", address: null, lastPollAt: null, lastError: opts.notConfigured ?? NOT_CONFIGURED, status: opts.notConfigured ?? NOT_CONFIGURED };
  }

  status(): InboxStatus {
    return { ...this.#status };
  }

  /** What the newest intake messages are and whether each would be skipped (and why). Reads Gmail only. */
  async plan(alreadyIngested: (key: string) => boolean): Promise<PlannedMessage[]> {
    const client = this.opts.client;
    if (!client) throw new GmailError(this.#status.status);
    const ids = await client.listIntake();
    const out: PlannedMessage[] = [];
    for (const id of ids) {
      const known = this.#skipped.get(id);
      if (known) {
        // Skipped for good earlier in this process: not fetched again.
        out.push({ gmailId: id, messageId: null, date: "", from: "", subject: "", deliveredTo: [], generated: false, sizeEstimate: 0, skip: known });
        continue;
      }
      const meta = await client.metadata(id);
      out.push({ ...meta, skip: skipReason(meta, client.config.intake, alreadyIngested) });
    }
    return out;
  }

  async poll(app: App): Promise<{ ingested: number; overlapped?: true }> {
    if (this.#running) return { ingested: 0, overlapped: true };
    const client = this.opts.client;
    if (!client) return { ingested: 0 };
    this.#running = true;
    let ingested = 0;
    const errors: string[] = [];
    try {
      const planned = await this.plan((key) => app.ctx.contra.hasMessage(key));
      // Oldest first, so the inbox fills in the order the mail arrived.
      for (const m of planned.reverse()) {
        if (m.skip) {
          if (m.skip !== "already ingested") this.#skipped.set(m.gmailId, m.skip);
          continue;
        }
        const raw = await client.raw(m.gmailId);
        if (raw.length > MAX_MESSAGE_BYTES) {
          this.#skipped.set(m.gmailId, "larger than 5 MB");
          continue;
        }
        if (new RegExp(`^${GENERATED_HEADER}\\s*:`, "im").test(headerBlock(raw))) {
          this.#skipped.set(m.gmailId, `sent by Contra (${GENERATED_HEADER})`);
          continue;
        }
        let email: Email;
        try {
          email = await parseEml(raw, `gmail-${m.gmailId}`);
        } catch (e) {
          this.#skipped.set(m.gmailId, e instanceof EmlError ? `unreadable: ${e.message}` : "unreadable message");
          continue;
        }
        email = { ...email, messageId: email.messageId ?? messageKey(m) };
        const x = await this.opts.extract(email);
        if (!x.ok) {
          const tries = (this.#tries.get(m.gmailId) ?? 0) + 1;
          this.#tries.set(m.gmailId, tries);
          if (tries >= MAX_EXTRACTION_TRIES) this.#skipped.set(m.gmailId, `extraction failed ${tries} times`);
          errors.push(`extraction failed for one message: ${x.reason}`);
          continue;
        }
        if (ingestInboxEmail(app, email, x.items, x.actor, "gmail").ingested) ingested++;
      }
      this.#status = { ...this.#status, status: errors.length ? "error" : "ok", lastError: errors.at(-1) ?? null };
    } catch (e) {
      const message = e instanceof GmailError ? e.message : "the inbox poll failed unexpectedly";
      this.#status = { ...this.#status, status: e instanceof GmailExpired ? EXPIRED : "error", lastError: message };
    } finally {
      this.#status = { ...this.#status, lastPollAt: new Date(this.opts.now()).toISOString() };
      this.#running = false;
    }
    return { ingested };
  }
}

// ---- Memo sending ----------------------------------------------------------------------------

/**
 * The footer on every memo email. Claims about Ramp follow INTEGRATION.md and SPEC section 4 only: memos
 * are forwarded to the GC's Ramp AP inbox, where Ramp drafts a vendor credit that a person finishes; there
 * is no API for creating vendor credits; whether a forwarded memo reliably becomes a draft is unconfirmed.
 */
export function memoFooter(apInbox: string): string {
  return [
    `This memo was sent by Contra to a stand-in AP inbox for the demo (${apInbox}), not to Ramp.`,
    "In production it would be forwarded to the GC's Ramp AP inbox, where Ramp drafts a vendor credit",
    "that an AP clerk reviews and finishes. Ramp has no API for creating vendor credits. Whether a",
    "forwarded credit memo reliably becomes a draft vendor credit is not yet confirmed in a Ramp sandbox.",
  ].join("\n");
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

/** The memo as an RFC 822 message: plain text (creditMemo's text plus the footer), marked X-Contra-Generated: memo. */
export function memoMime(config: Pick<GmailConfig, "address" | "apInbox">, memo: { creditId: string; filename: string; text: string }, at: Date): string {
  const body = `${memo.text.replace(/\r\n?/g, "\n").replace(/\n+$/, "")}\n\n-- \n${memoFooter(config.apInbox)}\n`;
  const encoded = Buffer.from(body, "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n");
  const domain = config.address.split("@")[1] ?? "localhost";
  return [
    `From: ${oneLine(config.address)}`,
    `To: ${oneLine(config.apInbox)}`,
    `Subject: ${oneLine(`Vendor credit memo ${memo.creditId} (${memo.filename})`)}`,
    `Date: ${at.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <contra-memo-${oneLine(memo.creditId).replace(/[^A-Za-z0-9-]/g, "")}-${at.getTime()}@${domain}>`,
    `${GENERATED_HEADER}: memo`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    encoded,
  ].join("\r\n");
}

/** MemoSender over Gmail: sends to the stand-in AP inbox. Errors are GmailError messages (safe to audit). */
export class GmailMemoSender implements MemoSender {
  constructor(
    private readonly client: GmailClient,
    private readonly now: () => number,
  ) {}

  get destination(): string {
    return this.client.config.apInbox;
  }

  async send(memo: { creditId: string; filename: string; text: string }): Promise<{ messageId: string }> {
    try {
      return { messageId: await this.client.send(memoMime(this.client.config, memo, new Date(this.now()))) };
    } catch (e) {
      throw new Error(e instanceof GmailError ? e.message : "sending through Gmail failed");
    }
  }
}
