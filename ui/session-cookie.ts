/**
 * The API's session, held by the Next server. The browser keeps the API's session id in an HttpOnly cookie on
 * the UI's own origin; only the Next server reads it and forwards it to the API (`cookie: contra_session=...`).
 * Client-side JavaScript never sees it, and the browser never calls the API directly.
 *
 * No imports, so middleware.ts (edge runtime) can use it too.
 */
export const UI_SESSION_COOKIE = "contra_session";
/** The API's own cookie name (FRONTEND_CONTRACT.md, "The session cookie"). */
export const API_SESSION_COOKIE = "contra_session";
/** Set by middleware.ts on every request: the path and query the person is on, for "return after sign-in". */
export const PATH_HEADER = "x-contra-path";

/** A same-origin path to return to after sign-in; anything else (another origin, "//host", junk) is "/". */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\") || next.startsWith("/login")) return "/";
  return next;
}

/** "/login?ended=1&next=/inbox": the sign-in page, saying the session ended, then back to `path`. */
export const loginPath = (path: string | null | undefined, ended: boolean) => {
  const q = new URLSearchParams();
  if (ended) q.set("ended", "1");
  const next = safeNext(path);
  if (next !== "/") q.set("next", next);
  const s = q.toString();
  return s ? `/login?${s}` : "/login";
};
