import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import type { InboxStatus } from "../server/gmail.ts";
import type { BackChargeDetail, Screens } from "../src/view.ts";
import { API_SESSION_COOKIE, loginPath, PATH_HEADER, UI_SESSION_COOKIE } from "./session-cookie.ts";

/**
 * The UI is a client of the HTTP API (npm run api); it never opens the core in-process. Every read is a
 * GET here; every button is one POST /api/action from a server action (ui/actions.ts). Only the Next server
 * calls the API: it forwards the session it keeps in an HttpOnly cookie on the UI's origin.
 */
export const API_BASE = (process.env.CONTRA_API_URL ?? "http://127.0.0.1:4100").replace(/\/+$/, "");

export type Workspace = "demo" | "live";
export const WORKSPACE_COOKIE = "contra-workspace";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; down: true } | { ok: false; down: false; status: number; error: string };

export const apiDownMessage = () => `The Contra API isn't running at ${API_BASE}. Start it with "npm run api" in the repo.`;

/** The Cookie header for the API: the session the person signed in with, or nothing. */
export async function sessionCookieHeader(): Promise<string | null> {
  const id = (await cookies()).get(UI_SESSION_COOKIE)?.value;
  return id ? `${API_SESSION_COOKIE}=${id}` : null;
}

/**
 * The API said 401 (no session, signed out, expired): go to the sign-in page with "Your session has ended",
 * then back to the screen the person was on. The request that got the 401 is not sent again.
 */
async function sessionEnded(): Promise<never> {
  try {
    (await cookies()).delete(UI_SESSION_COOKIE); // allowed in a server action; while rendering a page it throws
  } catch {
    /* rendering: the sign-in page replaces the stale cookie */
  }
  redirect(loginPath((await headers()).get(PATH_HEADER), true));
}

async function call<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  const cookie = await sessionCookieHeader();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { cache: "no-store", ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...(cookie ? { cookie } : {}) } });
  } catch {
    return { ok: false, down: true };
  }
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  if (res.status === 401) await sessionEnded();
  if (!res.ok) return { ok: false, down: false, status: res.status, error: typeof body?.error === "string" ? body.error : `HTTP ${res.status}` };
  return { ok: true, data: body as T };
}

export const apiGet = <T>(path: string) => call<T>(path);
/** Every POST is JSON (the API refuses anything else with 415). */
export const apiPost = <T>(path: string, body: unknown) => call<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** GET /api/health. Signed out it is `{ ok: true }` and nothing else; signed in it adds the workspaces and inbox. */
export interface Health {
  ok: true;
  workspaces?: Workspace[];
  /** null for an account without --live. */
  inbox?: InboxStatus | null;
}

export type Role = "pm" | "controller" | "ap";
/** GET /api/me (and the body of POST /api/login). */
export interface Me {
  ok: true;
  user: { username: string; role: Role; live: boolean };
  expiresAt: string;
  workspaces: Workspace[];
}

/**
 * GET /api/me for the sign-in page: the person if the session is valid, else null. Never redirects (the
 * sign-in page must not send itself to the sign-in page); an unreachable API is null too.
 */
export async function signedInAs(): Promise<Me | null> {
  const cookie = await sessionCookieHeader();
  if (!cookie) return null;
  try {
    const res = await fetch(`${API_BASE}/api/me`, { cache: "no-store", headers: { cookie } });
    return res.ok ? ((await res.json()) as Me) : null;
  } catch {
    return null;
  }
}

/** The workspace the person picked (a cookie, so the layout, pages and server actions all see it). */
export const chosenWorkspace = cache(async (): Promise<Workspace> => ((await cookies()).get(WORKSPACE_COOKIE)?.value === "live" ? "live" : "demo"));

// One request each per page render: the layout and the page share them.
export const getMe = cache(() => apiGet<Me>("/api/me"));
export const getHealth = cache(() => apiGet<Health>("/api/health"));
export const getScreens = cache((ws: Workspace) => apiGet<Screens>(`/api/screens?workspace=${ws}`));
export const getDetail = (ws: Workspace, ref: string) => apiGet<BackChargeDetail>(`/api/backcharge/${encodeURIComponent(ref)}?workspace=${ws}`);
export const getMemo = (ws: Workspace, id: string) => apiGet<{ filename: string; text: string }>(`/api/credit/${encodeURIComponent(id)}/memo?workspace=${ws}`);

/**
 * Why this account can't open the live workspace, in the API's words: the refusal GET /api/screens?workspace=live
 * gets (403 for an account without --live, 404 on a server without a live workspace). The API refuses before
 * building any screens. null when it can.
 */
export const liveRefusal = cache(async (): Promise<string | null> => {
  const r = await apiGet<Screens>("/api/screens?workspace=live");
  return r.ok ? null : r.down ? apiDownMessage() : r.error;
});

/** Screens for the chosen workspace, or null when the layout is already showing why there are none. */
export async function currentScreens(): Promise<{ ws: Workspace; s: Screens } | null> {
  const ws = await chosenWorkspace();
  const r = await getScreens(ws);
  return r.ok ? { ws, s: r.data } : null;
}
