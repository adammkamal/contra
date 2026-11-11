/**
 * JSON API over Contra (node:http only), for a frontend that can't import the TypeScript core directly.
 * Same functions as the in-process path: buildScreens / backChargeDetail / creditMemo to read,
 * runAction to change state. PM emails come from fixtures/emails/*.eml via ingest/eml.ts when present. Binds to 127.0.0.1 by default; it's a local demo server, not production.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { App, type Workspace } from "../src/app.ts";
import type { Clock } from "../src/clock.ts";
import { DEFAULT_EML_DIR, EmlError, loadPmEmails } from "../ingest/eml.ts";
import { NotOffered, runAction, type ActionInput, type PmEmailSource } from "../src/commands.ts";
import { IneligibleForCredit } from "../src/credits.ts";
import { IllegalTransition } from "../src/state.ts";
import { backChargeDetail, buildScreens, type Action } from "../src/view.ts";
import type { ExtractOptions } from "../src/extract/index.ts";
import { tryEmail, TryUnavailable, type TryInput, type TrySettings } from "./try.ts";
import { SAMPLE_INBOX, type InboxPoller, type InboxStatus } from "./gmail.ts";
import type { MemoSender } from "../src/memo.ts";
import type { Human } from "../src/types.ts";
import { DEFAULT_LOGIN_LIMITS, loginLimiter, type LoginLimits, sessionCookie, sessionIdFrom, SESSION_TTL_MS, type AuthStore, type Session, type User } from "./auth.ts";

/** POST /api/try: the model call is paid for with the demo's key, so it is capped and rate-limited. */
export interface TryApiOptions {
  /** Read on each request, so a key added to .env.local after start-up is picked up. */
  settings: () => TrySettings;
  /** Passed to the extractor (tests inject a fake fetcher). */
  callOptions?: ExtractOptions;
  /** Model calls allowed per client IP per rolling hour. Default 30. */
  maxPerHour?: number;
  /** Model calls allowed per UTC day, all clients together (CONTRA_TRY_DAILY_CAP). Default 200. */
  dailyCap?: number;
  /** The one clock the limits read, in epoch milliseconds (UTC). Default Date.now. */
  now?: () => number;
}

export const DEFAULT_TRY_DAILY_CAP = 200;

/** CONTRA_TRY_DAILY_CAP: a positive whole number; unset means 200. Throws on anything else. */
export function tryDailyCapFromEnv(env: Record<string, string | undefined>): number {
  const raw = (env.CONTRA_TRY_DAILY_CAP ?? "").trim();
  if (!raw) return DEFAULT_TRY_DAILY_CAP;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) throw new Error(`CONTRA_TRY_DAILY_CAP must be a positive whole number, got "${raw}"`);
  return Number(raw);
}

export const TRY_LIMITS = { subject: 300, body: 20_000, address: 300, requestBytes: 256 * 1024 } as const;

/** Strict shape check for POST /api/try. Returns the input, or a message for a 400. */
export function parseTryInput(x: unknown): TryInput | string {
  if (!x || typeof x !== "object" || Array.isArray(x)) return "send { subject, body, from?, to? } as JSON";
  const o = x as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !["subject", "body", "from", "to"].includes(k));
  if (extra.length) return `unexpected fields: ${extra.slice(0, 5).join(", ")}`;
  if (typeof o.subject !== "string") return "subject must be a string";
  if (o.subject.length > TRY_LIMITS.subject) return `subject is longer than ${TRY_LIMITS.subject} characters`;
  if (typeof o.body !== "string" || o.body.trim().length === 0) return "body must be a non-empty string";
  if (o.body.length > TRY_LIMITS.body) return `body is longer than ${TRY_LIMITS.body.toLocaleString("en-US")} characters`;
  for (const k of ["from", "to"] as const) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== "string") return `${k} must be a string`;
    if ((o[k] as string).length > TRY_LIMITS.address) return `${k} is longer than ${TRY_LIMITS.address} characters`;
  }
  return {
    subject: o.subject,
    body: o.body,
    ...(typeof o.from === "string" ? { from: o.from } : {}),
    ...(typeof o.to === "string" ? { to: o.to } : {}),
  };
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * In-memory spend limits for POST /api/try, all read from one injected clock (epoch ms):
 * at most one model call in flight (all clients), maxPerHour per client IP per rolling hour, and
 * dailyCap per UTC day for all clients together (resets at 00:00 UTC). Each model call counts once
 * toward both limits; a refused request uses no slot. A restart resets the counts.
 */
export function tryLimiter(limits: { maxPerHour: number; dailyCap: number }, now: () => number) {
  let inFlight = false;
  const perIp = new Map<string, number[]>();
  let day = -1;
  let dayCount = 0;
  return {
    /** Takes a slot for this client, or returns why not. Call release() when the call is done. */
    acquire(ip: string): { ok: true; release: () => void } | { ok: false; error: string } {
      if (inFlight) return { ok: false, error: "another email is being checked; try again when it finishes" };
      const t = now();
      const today = Math.floor(t / DAY_MS);
      if (today !== day) [day, dayCount] = [today, 0];
      if (dayCount >= limits.dailyCap) {
        return { ok: false, error: `the daily demo cap of ${limits.dailyCap} emails is reached for everyone; it resets at midnight UTC` };
      }
      if (perIp.size > 10_000) for (const [k, v] of perIp) if (v.every((s) => s <= t - HOUR_MS)) perIp.delete(k);
      const mine = (perIp.get(ip) ?? []).filter((s) => s > t - HOUR_MS);
      if (mine.length >= limits.maxPerHour) {
        perIp.set(ip, mine);
        return { ok: false, error: `limit of ${limits.maxPerHour} emails per hour from your address reached; try again later` };
      }
      inFlight = true;
      mine.push(t);
      perIp.set(ip, mine);
      dayCount++;
      return { ok: true, release: () => (inFlight = false) };
    },
  };
}

/**
 * Browser origins that get CORS headers when CONTRA_ALLOWED_ORIGINS is unset: the repo's only frontend
 * (contra-ui) runs `next dev`, which serves http://localhost:3000. Any other origin gets no CORS headers.
 */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = ["http://localhost:3000"];

/** CONTRA_ALLOWED_ORIGINS: comma-separated origins ("https://demo.example.com,http://localhost:3000"). Throws on anything that isn't an origin. */
export function allowedOriginsFromEnv(env: Record<string, string | undefined>): string[] {
  const raw = (env.CONTRA_ALLOWED_ORIGINS ?? "").trim();
  if (!raw) return [...DEFAULT_ALLOWED_ORIGINS];
  return raw
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean)
    .map((o) => {
      let parsed: URL | null = null;
      try {
        parsed = new URL(o);
      } catch {
        /* reported below */
      }
      if (!parsed || parsed.origin !== o || !/^https?:$/.test(parsed.protocol)) {
        throw new Error(`CONTRA_ALLOWED_ORIGINS: "${o}" is not an origin like https://demo.example.com`);
      }
      return o;
    });
}

/** "application/json", optionally with a charset parameter ("application/json; charset=utf-8"), and nothing else. */
export function isJsonContentType(header: string | undefined): boolean {
  if (!header) return false;
  const [type, ...params] = header.split(";");
  if (type!.trim().toLowerCase() !== "application/json") return false;
  return params.every((p) => /^\s*charset\s*=\s*"?[A-Za-z0-9._-]+"?\s*$/i.test(p));
}

/** Accounts and sessions (server/auth.ts). Every route but POST /api/login and GET /api/health needs a session. */
export interface AuthOptions {
  store: AuthStore;
  /** Adds Secure to the session cookie (CONTRA_SECURE_COOKIES=1, for HTTPS). */
  secureCookies?: boolean;
  /** Session lifetime in ms. Default 12 hours. */
  sessionTtlMs?: number;
  /** Sign-in limits (server/auth.ts loginLimiter); each field defaults to DEFAULT_LOGIN_LIMITS. */
  loginLimits?: Partial<LoginLimits>;
  /** Waits out a sign-in backoff. Default: a real timer; tests record the delay instead. */
  sleep?: (ms: number) => Promise<void>;
  /** The clock sessions and the sign-in limits read (epoch ms). Default Date.now. */
  now?: () => number;
}

/** Strict shape check for POST /api/login. */
export function parseLogin(x: unknown): { username: string; password: string } | string {
  if (!x || typeof x !== "object" || Array.isArray(x)) return "send { username, password } as JSON";
  const o = x as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== "username" && k !== "password")) return "send only { username, password }";
  if (typeof o.username !== "string" || !o.username.trim() || o.username.length > 64) return "username must be a non-empty string";
  if (typeof o.password !== "string" || !o.password || o.password.length > 1024) return "password must be a non-empty string";
  return { username: o.username.trim().toLowerCase(), password: o.password };
}

/** What GET /api/me and POST /api/login return about the signed-in person. Never the session id. */
const meBody = (s: Session, workspaces: Workspace[]) => ({ ok: true, user: { username: s.user.username, role: s.user.role, live: s.user.live }, expiresAt: s.expiresAt.toISOString(), workspaces });

export interface ApiOptions {
  dbPath: string;
  auth: AuthOptions;
  start?: Date;
  /** Origins that get CORS headers (exact match). Default DEFAULT_ALLOWED_ORIGINS. Other origins get none. */
  allowedOrigins?: readonly string[];
  maxBodyBytes?: number;
  /**
   * Folder of PM .eml files for "Ingest PM emails" (read through ingest/eml.ts, re-read on reset).
   * Default fixtures/emails; when it's missing or empty, or this is null, the built-in sample is used.
   */
  emlDir?: string | null;
  /** Enables POST /api/try. Without it the route answers 503. */
  try?: TryApiOptions;
  /** Delivers credit memos (sendCreditMemo). Without one, the action is never offered. */
  memoSender?: MemoSender | null;
  /**
   * The live workspace's database (data/live.db with CONTRA_INBOX=gmail): same seed, none of the scripted
   * demo's emails. Without it there is no live workspace. Required with `inbox`: live mail never goes to dbPath.
   */
  liveDbPath?: string | null;
  /** The real clock for the live workspace (its time is this plus its offset). Default: the system clock. */
  realClock?: Clock;
  /** Live inbox polling (CONTRA_INBOX=gmail) into the live workspace. Without it, health reports the sample inbox. */
  inbox?: { poller: Pick<InboxPoller, "poll" | "status">; intervalMs: number };
  /** Server-Sent Events heartbeat interval in ms. Default 15,000. */
  heartbeatMs?: number;
}

const COMMANDS: Record<Action["command"], Record<string, "string" | "number" | "string[]">> = {
  ingestPmEmails: {},
  confirmLink: { ref: "string" },
  chooseSubcontract: { ref: "string", options: "string[]" },
  confirmImageAmount: { ref: "string", options: "string[]" },
  draftNotice: { subcontractId: "string" },
  approveNotice: { noticeId: "string" },
  sendNotice: { noticeId: "string" },
  ingestSubReply: { noticeId: "string" },
  advanceDays: { days: "number" },
  evaluateAll: {},
  proposeCredit: { subcontractId: "string" },
  approveCredit: { creditId: "string" },
  rejectCredit: { creditId: "string" },
  billArrives: {},
  turnOnCredits: { billId: "string" },
  payBill: { billId: "string" },
  sendCreditMemo: { creditId: "string" },
};

/** Strict shape check for an Action arriving over HTTP. Returns null if anything is off. */
export function parseAction(x: unknown): Action | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  const spec = typeof o.command === "string" && Object.hasOwn(COMMANDS, o.command) ? COMMANDS[o.command as Action["command"]] : null;
  if (!spec) return null;
  for (const [k, t] of Object.entries(spec)) {
    const v = o[k];
    if (t === "string" && (typeof v !== "string" || v.length === 0 || v.length > 100)) return null;
    if (t === "number" && (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1 || v > 60)) return null;
    if (t === "string[]" && (!Array.isArray(v) || v.length > 50 || !v.every((s) => typeof s === "string" && s.length <= 100))) return null;
  }
  const extra = Object.keys(o).filter((k) => k !== "command" && !Object.hasOwn(spec, k));
  if (extra.length) return null;
  return o as unknown as Action;
}

export function createApiServer(opts: ApiOptions): {
  server: Server;
  /** The demo workspace's App. */
  app: () => App;
  /** The live workspace's App, or null when there is none. */
  live: () => App | null;
  /** The account store this server signs people in against. */
  authStore: AuthStore;
  pollNow: () => Promise<void>;
  close: () => Promise<void>;
} {
  const maxBody = opts.maxBodyBytes ?? 64 * 1024;
  if (opts.inbox && !opts.liveDbPath) throw new Error("a live inbox needs liveDbPath: live mail never goes to the demo database");
  if (opts.liveDbPath && opts.liveDbPath === opts.dbPath) throw new Error("the live workspace needs its own database file");

  // ---- Workspaces: "demo" (dbPath, the scripted demo) and, with liveDbPath, "live" (the live inbox's
  // mail only). Two Apps, two databases; every route below picks one by ?workspace=, demo by default.
  const realClock: Clock = opts.realClock ?? { now: () => new Date() };
  const appOptions = (workspace: Workspace) => ({ ...(opts.start ? { start: opts.start } : {}), memoSender: opts.memoSender ?? null, workspace, ...(workspace === "live" ? { realClock } : {}) });
  const dbPaths = new Map<Workspace, string>([["demo", opts.dbPath]]);
  if (opts.liveDbPath) dbPaths.set("live", opts.liveDbPath);
  const apps = new Map<Workspace, App>();
  for (const [ws, path] of dbPaths) {
    mkdirSync(dirname(path), { recursive: true });
    apps.set(ws, new App(path, appOptions(ws)));
  }
  const appFor = (ws: Workspace) => apps.get(ws)!;
  /**
   * ?workspace= : absent or "demo" is the demo, for any signed-in person; "live" (real Gmail, real memo
   * emails) only for an account created with --live (else 403, whether or not this server has one), and
   * only when this server has one.
   */
  const workspaceOf = (url: URL, user: User): Workspace => {
    const raw = url.searchParams.get("workspace");
    if (raw === null || raw === "demo") return "demo";
    if (raw === "live") {
      if (!user.live) throw Object.assign(new Error("the live workspace is only for accounts created with --live"), { status: 403 });
      if (!apps.has("live")) throw Object.assign(new Error("this server has no live workspace (start it with CONTRA_INBOX=gmail)"), { status: 404 });
      return "live";
    }
    throw Object.assign(new Error('workspace must be "demo" or "live"'), { status: 400 });
  };

  // ---- Server-Sent Events: "screens-changed" after every change, plus a heartbeat. Event data never
  // carries state or secrets: the client re-reads GET /api/screens.
  // Each stream belongs to the session that opened it (the raw id is kept in memory only, never logged).
  const sseClients = new Map<ServerResponse, { live: boolean; sid: string; timer: ReturnType<typeof setTimeout> | null }>();
  /** Ends one stream: a last `session-ended` event (so the client signs in again instead of reconnecting), then close. */
  const endStream = (c: ServerResponse, reason: "signed out" | "expired") => {
    const s = sseClients.get(c);
    if (!s) return;
    sseClients.delete(c);
    if (s.timer) clearTimeout(s.timer);
    c.write(`event: session-ended\ndata: ${JSON.stringify({ reason })}\n\n`);
    c.end();
  };
  /** Ends every stream whose session has expired or no longer exists. */
  const sweep = () => {
    for (const [c, s] of sseClients) if (!auth.store.session(s.sid, authNow())) endStream(c, "expired");
  };
  /** A live workspace's events go only to streams opened by accounts that may see it; never to an ended session's. */
  const broadcast = (event: string, data: Record<string, string>) => {
    sweep();
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [c, who] of sseClients) if (data.workspace !== "live" || who.live) c.write(msg);
  };
  const changed = (reason: "action" | "reset" | "inbox", workspace: Workspace) => broadcast("screens-changed", { reason, workspace });
  const heartbeat = setInterval(() => broadcast("heartbeat", {}), opts.heartbeatMs ?? 15_000);
  heartbeat.unref();

  // ---- Inbox polling into the live workspace only: never overlapping; the poller records its own errors and never throws.
  let polling = false;
  const pollNow = async () => {
    if (!opts.inbox || polling) return;
    polling = true;
    try {
      // A sender whose address is an account's email is recorded as the raiser of its items.
      const r = await opts.inbox.poller.poll(appFor("live"), (address) => {
        const u = auth.store.userByEmail(address);
        return u ? { kind: "human", id: u.username, role: u.role } : null;
      });
      if (r.ingested > 0) changed("inbox", "live");
    } catch {
      /* the poller records errors in its status; a timer must never throw */
    } finally {
      polling = false;
    }
  };
  const pollTimer = opts.inbox ? setInterval(() => void pollNow(), opts.inbox.intervalMs) : null;
  pollTimer?.unref();
  const inboxStatus = (): InboxStatus => opts.inbox?.poller.status() ?? SAMPLE_INBOX;

  // mailparser is async, so the files are read up front and awaited before an action (runAction itself is awaited too).
  const loadEmails = (): Promise<PmEmailSource | null> => {
    const p = opts.emlDir === null ? Promise.resolve(null) : loadPmEmails(opts.emlDir ?? DEFAULT_EML_DIR);
    p.catch(() => {}); // reported when an action awaits it, not as an unhandled rejection
    return p;
  };
  let pmEmails = loadEmails();

  /** Starts one workspace over (its database only; the other workspace is untouched). */
  const reset = (ws: Workspace) => {
    const path = dbPaths.get(ws)!;
    appFor(ws).close();
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(path + suffix)) rmSync(path + suffix);
    apps.set(ws, new App(path, appOptions(ws)));
    if (ws === "demo") pmEmails = loadEmails();
  };

  const allowed = new Set(opts.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS);
  /** CORS headers only for an allowed Origin; a disallowed or missing Origin gets none. */
  const setCors = (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("vary", "Origin");
    const origin = req.headers.origin;
    if (!origin || !allowed.has(origin)) return;
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    // The session cookie goes with cross-origin requests only from an allowed origin (never with "*").
    res.setHeader("access-control-allow-credentials", "true");
  };

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    });
    res.end(json);
  };

  // ---- Sessions (server/auth.ts).
  const auth = opts.auth;
  const authNow = auth.now ?? Date.now;
  const ttl = auth.sessionTtlMs ?? SESSION_TTL_MS;
  const logins = loginLimiter({ ...DEFAULT_LOGIN_LIMITS, ...auth.loginLimits }, authNow);
  const sleep = auth.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const sessionOf = (req: IncomingMessage): Session | null => {
    const id = sessionIdFrom(req.headers.cookie);
    return id ? auth.store.session(id, authNow()) : null;
  };
  /** The workspaces this person may open. */
  const workspacesFor = (u: User): Workspace[] => [...apps.keys()].filter((ws) => ws === "demo" || u.live);

  const limiter = tryLimiter({ maxPerHour: opts.try?.maxPerHour ?? 30, dailyCap: opts.try?.dailyCap ?? DEFAULT_TRY_DAILY_CAP }, opts.try?.now ?? Date.now);

  const readJson = (req: IncomingMessage, limit = maxBody): Promise<unknown> =>
    new Promise((resolve, reject) => {
      let size = 0;
      let tooLarge = false;
      const chunks: Buffer[] = [];
      // Over the limit: stop keeping data and answer 413. Destroying the request at once would close the
      // socket before the 413 is written, so the rest of the upload is read and dropped, up to 4x the limit.
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size <= limit) return void chunks.push(c);
        if (!tooLarge) {
          tooLarge = true;
          chunks.length = 0;
          reject(Object.assign(new Error(`body too large (limit ${limit} bytes)`), { status: 413 }));
        }
        if (size > limit * 4) req.destroy();
      });
      req.on("end", () => {
        if (size > limit) return;
        if (size === 0) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(Object.assign(new Error("body is not valid JSON"), { status: 400 }));
        }
      });
      req.on("error", reject);
    });

  const statusFor = (e: unknown): number => {
    if (e && typeof e === "object" && "status" in e && typeof (e as { status: unknown }).status === "number") return (e as { status: number }).status;
    if (e instanceof IllegalTransition || e instanceof IneligibleForCredit || e instanceof NotOffered) return 409;
    if (e instanceof Error && /^no (back-charge|notice|credit|bill|subcontract)\b/.test(e.message)) return 404;
    if (e instanceof EmlError) return 500;
    if (e instanceof Error) return 409;
    return 500;
  };

  const server = createServer(async (req, res) => {
    setCors(req, res);
    // Gates that run before any body is read or any route runs. CORS headers alone only stop a browser
    // from reading the response; these stop a disallowed page's request from doing anything at all.
    // 1. An Origin header that isn't allowed: 403 on every method. No Origin (curl, server-to-server): unaffected.
    const origin = req.headers.origin;
    if (origin !== undefined && !allowed.has(origin)) return send(res, 403, { ok: false, error: "this origin is not allowed to use the API" });
    // 2. Every POST must be JSON. A form or text/plain POST is one a browser sends cross-origin without a
    //    preflight; requiring application/json forces the preflight that the allow-list then refuses.
    if (req.method === "POST" && !isJsonContentType(req.headers["content-type"])) {
      return send(res, 415, { ok: false, error: "send the request body as JSON (Content-Type: application/json)" });
    }
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      if (req.method === "OPTIONS") return send(res, 204, null);

      if (req.method === "POST" && path === "/api/login") {
        const input = parseLogin(await readJson(req, 4096));
        if (typeof input === "string") return send(res, 400, { ok: false, error: input });
        const ip = req.socket.remoteAddress ?? "unknown"; // the socket address, never X-Forwarded-For (a client can set it)
        const blocked = logins.blocked(ip, input.username);
        if (blocked) return send(res, 429, { ok: false, error: blocked });
        // Failures for this username from anywhere slow its sign-ins down; they never lock it.
        const wait = logins.delayMs(input.username);
        if (wait > 0) await sleep(wait);
        const user = await auth.store.verify(input.username, input.password);
        if (!user) {
          logins.failed(ip, input.username);
          return send(res, 401, { ok: false, error: "wrong username or password" });
        }
        logins.succeeded(ip, input.username);
        const s = auth.store.createSession(user.username, authNow(), ttl);
        return send(res, 200, meBody({ user, expiresAt: s.expiresAt }, workspacesFor(user)), { "set-cookie": sessionCookie(s.id, Math.floor(ttl / 1000), !!auth.secureCookies) });
      }
      // Health without a session is only "up": no workspaces, no inbox address, no counts.
      if (req.method === "GET" && path === "/api/health") {
        const s = sessionOf(req);
        if (!s) return send(res, 200, { ok: true });
        return send(res, 200, { ok: true, workspaces: workspacesFor(s.user), inbox: s.user.live ? inboxStatus() : null });
      }

      // Every other route needs a session (an unknown route too: 401 says nothing about which routes exist).
      const session = sessionOf(req);
      if (!session) return send(res, 401, { ok: false, error: "sign in first" });

      if (req.method === "GET" && path === "/api/me") return send(res, 200, meBody(session, workspacesFor(session.user)));
      if (req.method === "POST" && path === "/api/logout") {
        const sid = sessionIdFrom(req.headers.cookie);
        auth.store.endSession(sid);
        // This session's open live-update streams close now; other sessions' (even the same account's) stay.
        for (const [c, s] of sseClients) if (s.sid === sid) endStream(c, "signed out");
        return send(res, 200, { ok: true }, { "set-cookie": sessionCookie("", 0, !!auth.secureCookies) });
      }
      if (req.method === "GET" && path === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
        res.write("retry: 3000\n\n");
        // Closed at the session's expiry (a timer, plus every heartbeat re-checks the session) or at its logout.
        const left = session.expiresAt.getTime() - authNow();
        const timer = left < 2 ** 31 - 1 ? setTimeout(() => endStream(res, "expired"), Math.max(0, left)) : null;
        timer?.unref();
        sseClients.set(res, { live: session.user.live, sid: sessionIdFrom(req.headers.cookie), timer });
        req.on("close", () => {
          const s = sseClients.get(res);
          if (s?.timer) clearTimeout(s.timer);
          sseClients.delete(res);
        });
        return;
      }
      if (req.method === "GET" && path === "/api/screens") return send(res, 200, buildScreens(appFor(workspaceOf(url, session.user))));
      let m = /^\/api\/backcharge\/([A-Za-z0-9-]{1,20})$/.exec(path);
      if (req.method === "GET" && m) return send(res, 200, backChargeDetail(appFor(workspaceOf(url, session.user)), decodeURIComponent(m[1]!)));
      m = /^\/api\/credit\/([A-Za-z0-9-]{1,20})\/memo$/.exec(path);
      if (req.method === "GET" && m) {
        const id = m[1]!;
        const app = appFor(workspaceOf(url, session.user));
        if (!app.ctx.contra.credits.has(id)) return send(res, 404, { ok: false, error: `no credit ${id}` });
        return send(res, 200, app.ctx.contra.creditMemo(id));
      }
      if (req.method === "POST" && path === "/api/reset") {
        const ws = workspaceOf(url, session.user);
        reset(ws);
        changed("reset", ws);
        return send(res, 200, { ok: true, screens: buildScreens(appFor(ws)) });
      }
      if (req.method === "POST" && path === "/api/action") {
        const ws = workspaceOf(url, session.user);
        const body = (await readJson(req)) as { action?: unknown; input?: unknown };
        const action = parseAction(body?.action);
        if (!action) return send(res, 400, { ok: false, error: "invalid action; send { action: <an Action from /api/screens>, input?: { choice?, reason?, amount? } }" });
        const rawInput = body.input && typeof body.input === "object" ? (body.input as Record<string, unknown>) : {};
        const input: ActionInput = {
          ...(typeof rawInput.choice === "string" ? { choice: rawInput.choice } : {}),
          ...(typeof rawInput.reason === "string" ? { reason: rawInput.reason } : {}),
          ...(typeof rawInput.amount === "string" ? { amount: rawInput.amount.slice(0, 40) } : {}),
        };
        // Sending a memo emails the AP inbox for real (from either workspace): only accounts created with --live.
        if (action.command === "sendCreditMemo" && !session.user.live) return send(res, 403, { ok: false, error: "sending a credit memo emails the AP inbox for real; only accounts created with --live can" });
        const app = appFor(ws);
        // Demo: each step keeps its scripted actor, presented by this person. Live: this person and their role.
        const by: Human = { kind: "human", id: session.user.username, role: session.user.role };
        await runAction(app, action, input, { by, ...(action.command === "ingestPmEmails" ? { pmEmails: await pmEmails } : {}) });
        changed("action", ws);
        return send(res, 200, { ok: true, screens: buildScreens(app) });
      }
      if (req.method === "POST" && path === "/api/try") {
        // Read-only: no runAction, no reset; tryEmail only reads the app. Order: 400, then 429, then the model call.
        const input = parseTryInput(await readJson(req, TRY_LIMITS.requestBytes));
        if (typeof input === "string") return send(res, 400, { ok: false, error: input });
        if (!opts.try) return send(res, 503, { ok: false, error: "trying an email is not enabled on this server" });
        const settings = opts.try.settings();
        if (!settings.ok) return send(res, 503, { ok: false, error: settings.message });
        const slot = limiter.acquire(req.socket.remoteAddress ?? "unknown"); // the socket address, never X-Forwarded-For (a client can set it)
        if (!slot.ok) return send(res, 429, { ok: false, error: slot.error });
        let result: Awaited<ReturnType<typeof tryEmail>>;
        try {
          result = await tryEmail(appFor("demo"), input, settings, opts.try.callOptions ?? {});
        } catch (e) {
          // The model being unavailable is a 503 with its message; anything else is a bug: a generic 500,
          // with no message or detail that could carry the email's text.
          if (e instanceof TryUnavailable) return send(res, 503, { ok: false, error: e.message });
          return send(res, 500, { ok: false, error: "internal error" });
        } finally {
          slot.release();
        }
        return send(res, 200, { ok: true, ...result });
      }
      return send(res, 404, { ok: false, error: `no route ${req.method} ${path}` });
    } catch (e) {
      const status = statusFor(e);
      const show = e instanceof EmlError || (status !== 500 && e instanceof Error);
      return send(res, status, { ok: false, error: show ? (e as Error).message : status === 500 ? "internal error" : String(e) });
    }
  });

  return {
    server,
    app: () => appFor("demo"),
    live: () => apps.get("live") ?? null,
    authStore: auth.store,
    pollNow,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        if (pollTimer) clearInterval(pollTimer);
        for (const [c, s] of sseClients) {
          if (s.timer) clearTimeout(s.timer);
          c.end();
        }
        sseClients.clear();
        server.close(() => {
          for (const a of apps.values()) a.close();
          resolve();
        });
        server.closeAllConnections?.();
      }),
  };
}
