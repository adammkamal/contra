"use server";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import type { TryInput, TryResult } from "../server/try.ts";
import type { Action } from "../src/view.ts";
import { apiDownMessage, apiPost, chosenWorkspace, WORKSPACE_COOKIE, type Workspace } from "./api.ts";

export type Result = { error?: string };

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
