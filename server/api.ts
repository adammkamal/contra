/**
 * JSON API over Contra (node:http only), for a frontend that can't import the TypeScript core directly.
 * Same functions as the in-process path: buildScreens / backChargeDetail / creditMemo to read,
 * runAction to change state. PM emails come from fixtures/emails/*.eml via ingest/eml.ts when present. Binds to 127.0.0.1 by default; it's a local demo server, not production.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { App } from "../src/app.ts";
import { DEFAULT_EML_DIR, EmlError, loadPmEmails } from "../ingest/eml.ts";
import { NotOffered, runAction, type ActionInput, type PmEmailSource } from "../src/commands.ts";
import { IneligibleForCredit } from "../src/credits.ts";
import { IllegalTransition } from "../src/state.ts";
import { backChargeDetail, buildScreens, type Action } from "../src/view.ts";
import type { ExtractOptions } from "../src/extract/index.ts";
import { tryEmail, TryUnavailable, type TryInput, type TrySettings } from "./try.ts";

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

export interface ApiOptions {
  dbPath: string;
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
}

const COMMANDS: Record<Action["command"], Record<string, "string" | "number" | "string[]">> = {
  ingestPmEmails: {},
  confirmLink: { ref: "string" },
  chooseSubcontract: { ref: "string", options: "string[]" },
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

export function createApiServer(opts: ApiOptions): { server: Server; app: () => App; close: () => Promise<void> } {
  const maxBody = opts.maxBodyBytes ?? 64 * 1024;
  mkdirSync(dirname(opts.dbPath), { recursive: true });
  let app = new App(opts.dbPath, opts.start ? { start: opts.start } : {});

  // mailparser is async and runAction is sync, so the files are read up front and awaited before an action.
  const loadEmails = (): Promise<PmEmailSource | null> => {
    const p = opts.emlDir === null ? Promise.resolve(null) : loadPmEmails(opts.emlDir ?? DEFAULT_EML_DIR);
    p.catch(() => {}); // reported when an action awaits it, not as an unhandled rejection
    return p;
  };
  let pmEmails = loadEmails();

  const reset = () => {
    app.close();
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(opts.dbPath + suffix)) rmSync(opts.dbPath + suffix);
    app = new App(opts.dbPath, opts.start ? { start: opts.start } : {});
    pmEmails = loadEmails();
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
  };

  const send = (res: ServerResponse, status: number, body: unknown) => {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(json);
  };

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

      if (req.method === "GET" && path === "/api/health") return send(res, 200, { ok: true });
      if (req.method === "GET" && path === "/api/screens") return send(res, 200, buildScreens(app));
      let m = /^\/api\/backcharge\/([A-Za-z0-9-]{1,20})$/.exec(path);
      if (req.method === "GET" && m) return send(res, 200, backChargeDetail(app, decodeURIComponent(m[1]!)));
      m = /^\/api\/credit\/([A-Za-z0-9-]{1,20})\/memo$/.exec(path);
      if (req.method === "GET" && m) {
        const id = m[1]!;
        if (!app.ctx.contra.credits.has(id)) return send(res, 404, { ok: false, error: `no credit ${id}` });
        return send(res, 200, app.ctx.contra.creditMemo(id));
      }
      if (req.method === "POST" && path === "/api/reset") {
        reset();
        return send(res, 200, { ok: true, screens: buildScreens(app) });
      }
      if (req.method === "POST" && path === "/api/action") {
        const body = (await readJson(req)) as { action?: unknown; input?: unknown };
        const action = parseAction(body?.action);
        if (!action) return send(res, 400, { ok: false, error: "invalid action; send { action: <an Action from /api/screens>, input?: { choice?, reason? } }" });
        const rawInput = body.input && typeof body.input === "object" ? (body.input as Record<string, unknown>) : {};
        const input: ActionInput = {
          ...(typeof rawInput.choice === "string" ? { choice: rawInput.choice } : {}),
          ...(typeof rawInput.reason === "string" ? { reason: rawInput.reason } : {}),
        };
        runAction(app, action, input, action.command === "ingestPmEmails" ? { pmEmails: await pmEmails } : {});
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
          result = await tryEmail(app, input, settings, opts.try.callOptions ?? {});
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
    app: () => app,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          app.close();
          resolve();
        });
        server.closeAllConnections?.();
      }),
  };
}
