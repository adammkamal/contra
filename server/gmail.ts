/**
 * Gmail adapter: reads the PM intake address of the demo inbox and sends credit memos to the stand-in AP
 * inbox. Plain fetch through an injectable Transport, so tests never touch the network. Lives outside
 * src/ (network code); state changes go through src/commands.ts (ingestInboxEmail, sendCreditMemo).
 *
 * Secrets: the refresh token and client secret are only ever placed in a token request body, and the access
 * token only in an Authorization header. No error message, status or log line is built from a response
 * body (only HTTP status codes and Google's short error codes), so none of them can carry a secret.
 */
import { EmlError, parseEmlWithMedia } from "../ingest/eml.ts";
import type { App } from "../src/app.ts";
import { ingestInboxEmail } from "../src/commands.ts";
import type { ModelSettings } from "../src/extract/anthropic.ts";
import { extractBackCharges, type ExtractOptions } from "../src/extract/index.ts";
import type { MemoSender } from "../src/memo.ts";
import type { Actor, AttachmentMedia, Email, ExtractedBackCharge, Human, RejectedExtraction } from "../src/types.ts";
import { MODEL_ERROR_MESSAGES } from "./try.ts";

export type Transport = (url: string, init?: RequestInit) => Promise<Response>;

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
export const MAX_PER_POLL = 20;
/** Gmail's own limit for sending a message (larger files go as Drive links, which aren't read). Attachments have their own limits (ingest/attachments.ts). */
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
const TOO_LARGE = "larger than 25 MB";
export const GENERATED_HEADER = "X-Contra-Generated";
export const EXPIRED = "expired: run npm run gmail:auth";
export const NOT_CONFIGURED = "not configured: run npm run gmail:auth";
export const NO_ALLOWED_SENDERS = "no allowed senders configured";
export const NOT_AUTHENTICATED = "sender not authenticated";
/** Model calls for live extraction per UTC day (CONTRA_LIVE_DAILY_CAP), separate from /api/try's cap. */
export const DEFAULT_LIVE_DAILY_CAP = 50;
const DAY_MS = 86_400_000;
export const dailyCapReached = (cap: number) => `paused: the daily cap of ${cap} model calls is reached; new mail waits and is extracted after midnight UTC`;

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
  /**
   * CONTRA_INTAKE_ALLOWED_SENDERS, lower-case: whole addresses ("pm@builder.example") or whole domains
   * ("@builder.example", that domain exactly, not its subdomains). Empty: nothing is ingested.
   */
  allowedSenders: string[];
}

const ADDRESS = /^[^@\s,;<>"()]+@[^@\s,;<>"()]+\.[^@\s,;<>"()]+$/;

/** CONTRA_INTAKE_ALLOWED_SENDERS: comma-separated addresses or @domain entries. Throws on an entry that is neither. */
export function allowedSendersFromEnv(env: Record<string, string | undefined>): string[] {
  return (env.CONTRA_INTAKE_ALLOWED_SENDERS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((s) => {
      if (!(ADDRESS.test(s) || (s.startsWith("@") && ADDRESS.test(`x${s}`)))) {
        throw new Error(`CONTRA_INTAKE_ALLOWED_SENDERS: "${s}" is neither an address (pm@builder.example) nor a domain (@builder.example)`);
      }
      return s;
    });
}

/** CONTRA_LIVE_DAILY_CAP: a positive whole number of model calls per UTC day; unset means 50. Throws on anything else. */
export function liveDailyCapFromEnv(env: Record<string, string | undefined>): number {
  const raw = (env.CONTRA_LIVE_DAILY_CAP ?? "").trim();
  if (!raw) return DEFAULT_LIVE_DAILY_CAP;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) throw new Error(`CONTRA_LIVE_DAILY_CAP must be a positive whole number, got "${raw}"`);
  return Number(raw);
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
  let allowedSenders: string[];
  try {
    allowedSenders = allowedSendersFromEnv(env);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  return {
    ok: true,
    config: { address, clientId: get("CONTRA_GMAIL_CLIENT_ID"), clientSecret: get("CONTRA_GMAIL_CLIENT_SECRET"), refreshToken: get("CONTRA_GMAIL_REFRESH_TOKEN"), intake, apInbox, allowedSenders },
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
  /** The From address, lower-case; null unless there is exactly one From header holding exactly one address. */
  fromAddress: string | null;
  subject: string;
  /** Every Delivered-To address, lower-case. */
  deliveredTo: string[];
  /** Every Authentication-Results header, in message order (the receiving server's own comes first). */
  authResults: string[];
  /** The message carries X-Contra-Generated (Contra sent it). */
  generated: boolean;
  sizeEstimate: number;
  /** When Gmail received the message (its internalDate, epoch ms), or null if Gmail didn't say. */
  internalDate: number | null;
}

const base64url = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const fromBase64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const bareAddress = (v: string) => (/<([^>]+)>/.exec(v)?.[1] ?? v).trim().toLowerCase();

/** The one sender address in the From header(s), lower-case, or null (no From, several, a group or a list). */
export function fromAddress(values: string[]): string | null {
  if (values.length !== 1) return null;
  const v = values[0]!.replace(/"(?:[^"\\]|\\.)*"/g, " ").replace(/\([^()]*\)/g, " ");
  const angles = [...v.matchAll(/<([^<>]*)>/g)];
  if (angles.length > 1) return null;
  if (angles.length === 1 && /[@,;]/.test(v.replace(angles[0]![0], ""))) return null; // a second address beside the <...>, or a list
  const a = (angles.length === 1 ? angles[0]![1]! : v).trim().toLowerCase();
  return ADDRESS.test(a) ? a : null;
}

/** Whether the sender is on the allow-list: the exact address, or an "@domain" entry for exactly its domain. */
export function senderAllowed(address: string, allowed: readonly string[]): boolean {
  const domain = address.slice(address.lastIndexOf("@"));
  return allowed.includes(address) || allowed.includes(domain);
}

/** The receiving server whose Authentication-Results Contra trusts: Gmail's own. */
export const GMAIL_AUTHSERV_ID = "mx.google.com";

/**
 * Whether Gmail authenticated the sender's domain: the message's first Authentication-Results header (the
 * one Gmail adds on receipt, above anything the sender wrote) must come from mx.google.com and show
 * dkim=pass with header.d (or header.i) in the From domain, or spf=pass with smtp.mailfrom in the From
 * domain. Exact domain match. Any Authentication-Results lower in the message is the sender's own text
 * and is ignored.
 */
export function senderAuthenticated(authResults: readonly string[], fromDomain: string): boolean {
  const first = authResults[0];
  if (!first) return false;
  const parts = first
    .replace(/\([^()]*\)/g, " ")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  if ((parts[0] ?? "").split(/\s+/)[0]!.toLowerCase() !== GMAIL_AUTHSERV_ID) return false;
  const domain = fromDomain.toLowerCase();
  for (const p of parts.slice(1)) {
    const m = /^(dkim|spf)\s*=\s*([a-z]+)(?:\s+(.*))?$/is.exec(p);
    if (!m || m[2]!.toLowerCase() !== "pass") continue;
    const props = new Map<string, string>();
    for (const [, k, v] of (m[3] ?? "").matchAll(/([a-z]+\.[a-z-]+)\s*=\s*([^\s;]+)/gi)) props.set(k!.toLowerCase(), v!.toLowerCase());
    const authDomain =
      m[1]!.toLowerCase() === "dkim"
        ? (props.get("header.d") ?? props.get("header.i")?.slice(props.get("header.i")!.lastIndexOf("@") + 1))
        : props.get("smtp.mailfrom")?.slice(props.get("smtp.mailfrom")!.lastIndexOf("@") + 1);
    if (authDomain && authDomain === domain) return true;
  }
  return false;
}

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
    for (const h of ["Message-ID", "Date", "From", "Subject", "Delivered-To", "Authentication-Results", GENERATED_HEADER]) q.append("metadataHeaders", h);
    const json = (await this.#api(`/messages/${encodeURIComponent(id)}?${q}`)) as { sizeEstimate?: unknown; internalDate?: unknown; payload?: { headers?: { name?: unknown; value?: unknown }[] } } | null;
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
      fromAddress: fromAddress(headers.get("from") ?? []),
      subject: one("subject"),
      deliveredTo: (headers.get("delivered-to") ?? []).map(bareAddress),
      authResults: headers.get("authentication-results") ?? [],
      generated: headers.has(GENERATED_HEADER.toLowerCase()),
      sizeEstimate: typeof json?.sizeEstimate === "number" ? json.sizeEstimate : 0,
      internalDate: typeof json?.internalDate === "string" && /^\d{1,15}$/.test(json.internalDate) ? Number(json.internalDate) : null,
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

/**
 * Why a listed message is not ingested, or null when it should be. Pure. The sender checks come before
 * "already ingested", so inbox:check shows a misconfigured allow-list on every message.
 */
export function skipReason(m: MessageMeta, config: Pick<GmailConfig, "intake" | "allowedSenders">, alreadyIngested: (key: string) => boolean): string | null {
  if (m.generated) return `sent by Contra (${GENERATED_HEADER})`;
  if (m.sizeEstimate > MAX_MESSAGE_BYTES) return TOO_LARGE;
  if (!m.deliveredTo.includes(config.intake.toLowerCase())) return `not delivered to ${config.intake}`;
  if (config.allowedSenders.length === 0) return NO_ALLOWED_SENDERS;
  if (!m.fromAddress) return "sender not allowed (no single From address)";
  if (!senderAllowed(m.fromAddress, config.allowedSenders)) return `sender not allowed (${m.fromAddress} is not on CONTRA_INTAKE_ALLOWED_SENDERS)`;
  if (!senderAuthenticated(m.authResults, m.fromAddress.slice(m.fromAddress.lastIndexOf("@") + 1))) return NOT_AUTHENTICATED;
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
  /** "off", "starting", "ok", "error", "expired: run npm run gmail:auth", "not configured: ..." or "paused: the daily cap ...". */
  status: string;
  /** Live extraction's model calls this UTC day (CONTRA_LIVE_DAILY_CAP); null without a live inbox. */
  modelCalls: { today: number; cap: number; capReached: boolean; resetsAt: string } | null;
}

export const SAMPLE_INBOX: InboxStatus = { mode: "sample", address: null, lastPollAt: null, lastError: null, status: "off", modelCalls: null };

/**
 * Extraction for one live email: the model's items, or a reason (in words) it couldn't be extracted.
 * One call is at most one model call (the poller counts each against the daily cap), so retries are the
 * poller's own, each counted. `media` holds the bytes of the email's photos and scans, for the model only.
 */
export type Extract = (
  email: Email,
  media: readonly AttachmentMedia[],
) => Promise<{ ok: true; items: ExtractedBackCharge[]; rejected?: RejectedExtraction[]; actor: Actor } | { ok: false; reason: string }>;

/**
 * The live extractor: src/extract with Contra's model settings, one model call and no retry. Never writes
 * anything to disk. `opts` is for tests (a fake fetcher); the retry count is always 0.
 */
export function modelExtractor(settings: () => { ok: true; settings: ModelSettings } | { ok: false; message: string }, opts: ExtractOptions = {}): Extract {
  return async (email, media) => {
    const s = settings();
    if (!s.ok) return { ok: false, reason: "the model isn't configured (CONTRA_ANTHROPIC_API_KEY in .env.local)" };
    const r = await extractBackCharges(s.settings, email, { ...opts, maxRetries: 0, media });
    if (!r.ok) return { ok: false, reason: MODEL_ERROR_MESSAGES[r.errorType] };
    // What validation refused goes along too: ingest keeps each as a held Inbox row.
    return { ok: true, items: r.items, rejected: r.rejected, actor: r.actor };
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
  #status: Omit<InboxStatus, "modelCalls">;
  readonly #skipped = new Map<string, string>();
  readonly #tries = new Map<string, number>();
  readonly #cap: number;
  /** Model calls made on UTC day #day (days since the epoch, from the injected clock). */
  #day = -1;
  #calls = 0;

  constructor(private readonly opts: { client: GmailClient | null; notConfigured?: string; extract: Extract; now: () => number; dailyCap?: number }) {
    this.#cap = opts.dailyCap ?? DEFAULT_LIVE_DAILY_CAP;
    if (!Number.isSafeInteger(this.#cap) || this.#cap < 1) throw new Error("the live daily cap must be a positive whole number");
    this.#status = opts.client
      ? { mode: "gmail", address: opts.client.config.intake, lastPollAt: null, lastError: null, status: "starting" }
      : { mode: "gmail", address: null, lastPollAt: null, lastError: opts.notConfigured ?? NOT_CONFIGURED, status: opts.notConfigured ?? NOT_CONFIGURED };
  }

  /** Calls made today; starts a new count when the UTC day has changed. */
  #callsToday(): number {
    const today = Math.floor(this.opts.now() / DAY_MS);
    if (today !== this.#day) [this.#day, this.#calls] = [today, 0];
    return this.#calls;
  }

  status(): InboxStatus {
    const today = this.#callsToday();
    return {
      ...this.#status,
      modelCalls: { today, cap: this.#cap, capReached: today >= this.#cap, resetsAt: new Date((this.#day + 1) * DAY_MS).toISOString() },
    };
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
        out.push({ gmailId: id, messageId: null, date: "", from: "", fromAddress: null, subject: "", deliveredTo: [], authResults: [], generated: false, sizeEstimate: 0, internalDate: null, skip: known });
        continue;
      }
      const meta = await client.metadata(id);
      out.push({ ...meta, skip: skipReason(meta, client.config, alreadyIngested) });
    }
    return out;
  }

  /** `raisedBy`: the account whose email is a sender's (authenticated, allow-listed) address, or null. */
  async poll(app: App, raisedBy: (address: string) => Human | null = () => null): Promise<{ ingested: number; overlapped?: true }> {
    if (this.#running) return { ingested: 0, overlapped: true };
    const client = this.opts.client;
    if (!client) return { ingested: 0 };
    this.#running = true;
    let ingested = 0;
    let capped = false;
    const errors: string[] = [];
    try {
      const planned = await this.plan((key) => app.ctx.contra.hasMessage(key));
      // Oldest first, so the inbox fills in the order the mail arrived.
      for (const m of planned.reverse()) {
        if (m.skip) {
          // Sender reasons aren't remembered: they depend on settings, and the message stays in the inbox.
          if (m.skip !== "already ingested" && m.skip !== NO_ALLOWED_SENDERS && !m.skip.startsWith("sender not allowed")) this.#skipped.set(m.gmailId, m.skip);
          continue;
        }
        // Daily cap: stop before downloading. Nothing is marked skipped, so this mail is extracted on a later day.
        if (this.#callsToday() >= this.#cap) {
          capped = true;
          break;
        }
        const raw = await client.raw(m.gmailId);
        if (raw.length > MAX_MESSAGE_BYTES) {
          this.#skipped.set(m.gmailId, TOO_LARGE);
          continue;
        }
        if (new RegExp(`^${GENERATED_HEADER}\\s*:`, "im").test(headerBlock(raw))) {
          this.#skipped.set(m.gmailId, `sent by Contra (${GENERATED_HEADER})`);
          continue;
        }
        let email: Email;
        let media: AttachmentMedia[];
        try {
          ({ email, media } = await parseEmlWithMedia(raw, `gmail-${m.gmailId}`));
        } catch (e) {
          this.#skipped.set(m.gmailId, e instanceof EmlError ? `unreadable: ${e.message}` : "unreadable message");
          continue;
        }
        // Received time: Gmail's internalDate (when Gmail got it), not the sender's Date header. Only if Gmail
        // gave none does the Date header stand.
        email = { ...email, messageId: email.messageId ?? messageKey(m), ...(m.internalDate !== null ? { receivedAt: new Date(m.internalDate) } : {}) };
        this.#calls++; // counted before the call: a failed call (or a retry on a later poll) costs the same
        const x = await this.opts.extract(email, media);
        if (!x.ok) {
          const tries = (this.#tries.get(m.gmailId) ?? 0) + 1;
          this.#tries.set(m.gmailId, tries);
          if (tries >= MAX_EXTRACTION_TRIES) this.#skipped.set(m.gmailId, `extraction failed ${tries} times`);
          errors.push(`extraction failed for one message: ${x.reason}`);
          continue;
        }
        const raiser = m.fromAddress ? raisedBy(m.fromAddress) : null;
        if (ingestInboxEmail(app, email, x.items, x.actor, "gmail", x.rejected ?? [], raiser).ingested) ingested++;
      }
      this.#status = { ...this.#status, status: capped ? dailyCapReached(this.#cap) : errors.length ? "error" : "ok", lastError: errors.at(-1) ?? null };
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
