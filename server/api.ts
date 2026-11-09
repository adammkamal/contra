/**
 * Zero-dependency JSON API over Contra, for a frontend that can't import the TypeScript core directly.
 * Same functions as the in-process path: buildScreens / backChargeDetail / creditMemo to read,
 * runAction to change state. Binds to 127.0.0.1 by default; it's a local demo server, not production.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { App } from "../src/app.ts";
import { NotOffered, runAction, type ActionInput } from "../src/commands.ts";
import { IneligibleForCredit } from "../src/credits.ts";
import { IllegalTransition } from "../src/state.ts";
import { backChargeDetail, buildScreens, type Action } from "../src/view.ts";

export interface ApiOptions {
  dbPath: string;
  start?: Date;
  corsOrigin?: string;
  maxBodyBytes?: number;
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

  const reset = () => {
    app.close();
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(opts.dbPath + suffix)) rmSync(opts.dbPath + suffix);
    app = new App(opts.dbPath, opts.start ? { start: opts.start } : {});
  };

  const send = (res: ServerResponse, status: number, body: unknown) => {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": opts.corsOrigin ?? "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "cache-control": "no-store",
    });
    res.end(json);
  };

  const readJson = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > maxBody) {
          reject(Object.assign(new Error("body too large"), { status: 413 }));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => {
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
    if (e instanceof Error) return 409;
    return 500;
  };

  const server = createServer(async (req, res) => {
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
        runAction(app, action, input);
        return send(res, 200, { ok: true, screens: buildScreens(app) });
      }
      return send(res, 404, { ok: false, error: `no route ${req.method} ${path}` });
    } catch (e) {
      const status = statusFor(e);
      return send(res, status, { ok: false, error: status === 500 ? "internal error" : e instanceof Error ? e.message : String(e) });
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
