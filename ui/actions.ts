"use server";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { TryInput, TryResult } from "../server/try.ts";
import type { Action } from "../src/view.ts";
import { API_BASE, apiDownMessage, apiPost, chosenWorkspace, sessionCookieHeader, WORKSPACE_COOKIE, type Workspace } from "./api.ts";
import { API_SESSION_COOKIE, safeNext, UI_SESSION_COOKIE } from "./session-cookie.ts";

export type Result = { error?: string };

export type SignInState = { username: string; error?: string };

/** The session id and Max-Age from the API's Set-Cookie for contra_session; null when it sent none. */
function sessionFrom(res: Response): { id: string; maxAge: number } | null {
  for (const line of res.headers.getSetCookie()) {
    const [pair, ...attrs] = line.split(";").map((p) => p.trim());
    const eq = pair!.indexOf("=");
    if (pair!.slice(0, eq) !== API_SESSION_COOKIE) continue;
    const id = pair!.slice(eq + 1);
    const maxAge = Number(/^max-age=(\d+)$/i.exec(attrs.find((a) => /^max-age=/i.test(a)) ?? "")?.[1] ?? NaN);
    return id ? { id, maxAge } : null;
  }
  return null;
}

/**
 * POST /api/login from the Next server. On 200 the API's session id is set as the UI's own HttpOnly,
 * SameSite=Lax cookie (Secure in production) with the API's Max-Age, and the person goes back to `next`.
 * Otherwise the API's words come back as they are (401, 429, 400), with the username kept.
 */
export async function signIn(_prev: SignInState, form: FormData): Promise<SignInState> {
  const username = String(form.get("username") ?? "");
  const password = String(form.get("password") ?? "");
  const next = safeNext(String(form.get("next") ?? ""));
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/login`, { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
  } catch {
    return { username, error: apiDownMessage() };
  }
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  if (!res.ok) return { username, error: typeof body?.error === "string" ? body.error : `HTTP ${res.status}` };
  const session = sessionFrom(res);
  if (!session) return { username, error: `The API at ${API_BASE} accepted the sign-in but sent no ${API_SESSION_COOKIE} cookie.` };
  (await cookies()).set(UI_SESSION_COOKIE, session.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    ...(Number.isFinite(session.maxAge) ? { maxAge: session.maxAge } : {}),
  });
  redirect(next);
}

/** "Sign out": POST /api/logout (ends the session on the server), then drop the UI's cookie. */
export async function signOut(): Promise<void> {
  const cookie = await sessionCookieHeader();
  if (cookie) {
    await fetch(`${API_BASE}/api/logout`, { method: "POST", cache: "no-store", headers: { "content-type": "application/json", cookie }, body: "{}" }).catch(() => undefined);
  }
  (await cookies()).delete(UI_SESSION_COOKIE);
  redirect("/login");
}

/** One button = one POST /api/action to the chosen workspace, with exactly the Action the screens offered. */
export async function runAction(action: Action, input: { choice?: string; reason?: string; amount?: string } = {}): Promise<Result> {
  const ws = await chosenWorkspace();
  const r = await apiPost(`/api/action?workspace=${ws}`, { action, input });
  revalidatePath("/", "layout");
  if (r.ok) return {};
  return { error: r.down ? apiDownMessage() : r.error };
}

/** Starts the scripted demo over (POST /api/reset). The live workspace is never reset from the UI. */
export async function resetDemo(): Promise<Result> {
  const r = await apiPost("/api/reset?workspace=demo", {});
  revalidatePath("/", "layout");
  if (r.ok) return {};
  return { error: r.down ? apiDownMessage() : r.error };
}

export async function chooseWorkspace(ws: Workspace): Promise<void> {
  (await cookies()).set(WORKSPACE_COOKIE, ws === "live" ? "live" : "demo", { path: "/", sameSite: "lax", httpOnly: true });
  revalidatePath("/", "layout");
}

export type TryResponse = { ok: true; result: TryResult } | { ok: false; error: string };

/** POST /api/try. Never logs the email. Errors (400, 429, 503, ...) come back with the API's own message. */
export async function tryEmail(input: TryInput): Promise<TryResponse> {
  const r = await apiPost<TryResult & { ok: true }>("/api/try", input);
  if (r.ok) return { ok: true, result: r.data };
  return { ok: false, error: r.down ? apiDownMessage() : r.error };
}
