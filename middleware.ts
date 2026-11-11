import { NextResponse, type NextRequest } from "next/server";
import { loginPath, PATH_HEADER, UI_SESSION_COOKIE } from "./ui/session-cookie.ts";

/**
 * 1. Tells the server components and server actions which screen the person is on (PATH_HEADER), so a 401
 *    can send them to /login and back again afterwards.
 * 2. A page visit without a session cookie goes straight to /login. Whether a cookie is still a valid
 *    session is the API's call: a 401 from it does the same (ui/api.ts).
 * Server actions (POSTs with a Next-Action header) and /api/events are never redirected here: they reach the
 * API, and its 401 is handled where the answer arrives.
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const params = new URLSearchParams(req.nextUrl.search);
  params.delete("_rsc"); // Next's client-navigation marker, not part of the screen's address
  const here = pathname + (params.size ? `?${params}` : "");
  const signedOut = !req.cookies.get(UI_SESSION_COOKIE)?.value;
  if (signedOut && pathname !== "/login" && !pathname.startsWith("/api/") && req.method === "GET" && !req.headers.has("next-action")) {
    return NextResponse.redirect(new URL(loginPath(here, false), req.url));
  }
  const headers = new Headers(req.headers);
  headers.set(PATH_HEADER, here);
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ["/((?!_next/|fonts/|favicon\\.ico).*)"] };
