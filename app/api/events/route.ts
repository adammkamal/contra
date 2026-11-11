import { API_BASE, sessionCookieHeader } from "../../../ui/api.ts";

/**
 * GET /api/events on the UI's own origin: the API's Server-Sent Events stream, proxied by the Next server
 * with the session cookie it keeps. The browser never connects to the API.
 *
 * The proxy always answers 200 (EventSource gives up for good on any other status) and says what happened
 * as an event of its own before the API's:
 * - `connected`: the API accepted the session; its events follow unchanged.
 * - `signed-out`: the API answered 401. The stream ends; the page goes to the sign-in page.
 * - `api-down`: the API couldn't be reached (or refused otherwise). The stream ends; EventSource retries.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const once = (text: string) =>
  new Response(text, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" } });

export async function GET(req: Request): Promise<Response> {
  const cookie = await sessionCookieHeader();
  if (!cookie) return once("event: signed-out\ndata: {}\n\n");
  let upstream: Response;
  try {
    upstream = await fetch(`${API_BASE}/api/events`, { cache: "no-store", headers: { cookie, accept: "text/event-stream" }, signal: req.signal });
  } catch {
    return once("retry: 3000\nevent: api-down\ndata: {}\n\n");
  }
  if (upstream.status === 401) {
    await upstream.body?.cancel();
    return once("event: signed-out\ndata: {}\n\n");
  }
  if (!upstream.ok || !upstream.body) {
    await upstream.body?.cancel();
    return once("retry: 3000\nevent: api-down\ndata: {}\n\n");
  }
  const reader = upstream.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("event: connected\ndata: {}\n\n"));
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch {
        controller.close(); // the API went away mid-stream; EventSource reconnects
      }
    },
    cancel() {
      void reader.cancel(); // the browser left: close the API connection too
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", "x-accel-buffering": "no" } });
}
