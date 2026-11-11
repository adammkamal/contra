import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import type { InboxStatus } from "../server/gmail.ts";
import type { BackChargeDetail, Screens } from "../src/view.ts";

/**
 * The UI is a client of the HTTP API (npm run api); it never opens the core in-process. Every read is a
 * GET here; every button is one POST /api/action from a server action (ui/actions.ts).
 */
export const API_BASE = (process.env.CONTRA_API_URL ?? "http://127.0.0.1:4100").replace(/\/+$/, "");

export type Workspace = "demo" | "live";
export const WORKSPACE_COOKIE = "contra-workspace";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; down: true } | { ok: false; down: false; status: number; error: string };

export const apiDownMessage = () => `The Contra API isn't running at ${API_BASE}. Start it with "npm run api" in the repo.`;

async function call<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { cache: "no-store", ...init });
  } catch {
    return { ok: false, down: true };
  }
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  if (!res.ok) return { ok: false, down: false, status: res.status, error: typeof body?.error === "string" ? body.error : `HTTP ${res.status}` };
  return { ok: true, data: body as T };
}

export const apiGet = <T>(path: string) => call<T>(path);
/** Every POST is JSON (the API refuses anything else with 415). */
export const apiPost = <T>(path: string, body: unknown) => call<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export interface Health {
  ok: true;
  workspaces: Workspace[];
  inbox: InboxStatus;
}

/** The workspace the person picked (a cookie, so the layout, pages and server actions all see it). */
export const chosenWorkspace = cache(async (): Promise<Workspace> => ((await cookies()).get(WORKSPACE_COOKIE)?.value === "live" ? "live" : "demo"));

// One request each per page render: the layout and the page share them.
export const getHealth = cache(() => apiGet<Health>("/api/health"));
export const getScreens = cache((ws: Workspace) => apiGet<Screens>(`/api/screens?workspace=${ws}`));
export const getDetail = (ws: Workspace, ref: string) => apiGet<BackChargeDetail>(`/api/backcharge/${encodeURIComponent(ref)}?workspace=${ws}`);
export const getMemo = (ws: Workspace, id: string) => apiGet<{ filename: string; text: string }>(`/api/credit/${encodeURIComponent(id)}/memo?workspace=${ws}`);

/** Screens for the chosen workspace, or null when the layout is already showing why there are none. */
export async function currentScreens(): Promise<{ ws: Workspace; s: Screens } | null> {
  const ws = await chosenWorkspace();
  const r = await getScreens(ws);
  return r.ok ? { ws, s: r.data } : null;
}
