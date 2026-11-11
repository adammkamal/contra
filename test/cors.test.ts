import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { allowedOriginsFromEnv, createApiServer, DEFAULT_ALLOWED_ORIGINS } from "../server/api.ts";
import { testAuth } from "./auth-fakes.ts";

const ALLOWED = "https://demo.contra.example";
const OTHER = "https://evil.example";

async function withApi(fn: (port: number) => Promise<void>) {
  const api = createApiServer({ auth: testAuth(), dbPath: join(mkdtempSync(join(tmpdir(), "contra-cors-")), "d.db"), start: new Date("2026-11-07T15:00:00Z"), emlDir: null, allowedOrigins: [ALLOWED] });
  await new Promise<void>((r) => api.server.listen(0, "127.0.0.1", r));
  try {
    await fn((api.server.address() as AddressInfo).port);
  } finally {
    await api.close();
  }
}

/** Raw request, so the Origin header is sent exactly as given. */
function call(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
const corsHeaders = (h: IncomingHttpHeaders) => Object.keys(h).filter((k) => k.startsWith("access-control-"));

test("CORS: an allowed origin gets its own origin back, never *", async () => {
  await withApi(async (port) => {
    const r = await call(port, "GET", "/api/screens", { origin: ALLOWED });
    assert.equal(r.status, 200);
    assert.equal(r.headers["access-control-allow-origin"], ALLOWED);
    assert.match(String(r.headers.vary), /Origin/);
  });
});

test("CORS: a disallowed origin, or no origin, gets no CORS headers", async () => {
  await withApi(async (port) => {
    const cases: Record<string, string>[] = [{ origin: OTHER }, { origin: `${ALLOWED}.evil.example` }, { origin: "null" }, {}];
    for (const headers of cases) {
      const r = await call(port, "GET", "/api/screens", headers);
      assert.deepEqual(corsHeaders(r.headers), [], JSON.stringify(headers));
    }
    const post = await call(port, "POST", "/api/action", { origin: OTHER, "content-type": "application/json" }, JSON.stringify({ action: { command: "evaluateAll" } }));
    assert.deepEqual(corsHeaders(post.headers), []);
  });
});

test("CORS: preflight for POST /api/action answers an allowed origin and not a disallowed one", async () => {
  await withApi(async (port) => {
    const pre = { "access-control-request-method": "POST", "access-control-request-headers": "content-type" };
    const ok = await call(port, "OPTIONS", "/api/action", { origin: ALLOWED, ...pre });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers["access-control-allow-origin"], ALLOWED);
    assert.match(String(ok.headers["access-control-allow-methods"]), /POST/);
    assert.match(String(ok.headers["access-control-allow-headers"]), /content-type/);

    const no = await call(port, "OPTIONS", "/api/action", { origin: OTHER, ...pre });
    assert.deepEqual(corsHeaders(no.headers), []);
  });
});

test("CORS: CONTRA_ALLOWED_ORIGINS is a comma-separated list; unset means the repo's frontend origin; junk is refused", () => {
  assert.deepEqual(allowedOriginsFromEnv({}), [...DEFAULT_ALLOWED_ORIGINS]);
  assert.deepEqual(allowedOriginsFromEnv({ CONTRA_ALLOWED_ORIGINS: "  " }), [...DEFAULT_ALLOWED_ORIGINS]);
  assert.deepEqual(DEFAULT_ALLOWED_ORIGINS, ["http://localhost:3000"]);
  assert.deepEqual(allowedOriginsFromEnv({ CONTRA_ALLOWED_ORIGINS: "https://a.example, http://localhost:5173/ ," }), ["https://a.example", "http://localhost:5173"]);
  for (const bad of ["*", "a.example", "https://a.example/path", "ftp://a.example"]) {
    assert.throws(() => allowedOriginsFromEnv({ CONTRA_ALLOWED_ORIGINS: bad }), /not an origin/, bad);
  }
});
