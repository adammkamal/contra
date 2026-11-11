import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApiServer, isJsonContentType, type TryApiOptions } from "../server/api.ts";
import { MODEL_ERROR_MESSAGES, type TryInput } from "../server/try.ts";
import type { App } from "../src/app.ts";
import { sessionFetch, signIn, testAuth } from "./auth-fakes.ts";

const http = sessionFetch();

// Every POST must be JSON, and a disallowed Origin is refused on every method, before anything runs.
// Emails here are made up for these tests; the model fetcher is fake.

const ALLOWED = "https://demo.contra.example";
const OTHER = "https://evil.example";
const INGEST = JSON.stringify({ action: { command: "ingestPmEmails" } });

let modelCalls = 0;
const tryItem = { ref: "BC-5521", description: "Ceiling repair", amountText: "$1,840.00", amountSentence: "BC-5521: ceiling repair, $1,840.00.", vendorNameAsWritten: "Harbor Mechanical Co", jobRef: "Summit MOB", disputeNoted: false };
const TRY_EMAIL: TryInput = { subject: "Summit MOB back-charge", body: "Hi,\n\nBC-5521: ceiling repair, $1,840.00.\n\nThanks" };
const countingFetcher = (async () => {
  modelCalls++;
  return new Response(JSON.stringify({ model: "claude-test-1", content: [{ type: "tool_use", name: "record_back_charges", input: { items: [tryItem] } }] }), { status: 200 });
}) as unknown as typeof fetch;

async function withApi(fn: (port: number, app: () => App) => Promise<void>, tryOpts?: TryApiOptions) {
  const api = createApiServer({ auth: testAuth(),
    dbPath: join(mkdtempSync(join(tmpdir(), "contra-gate-")), "d.db"),
    start: new Date("2026-11-07T15:00:00Z"),
    emlDir: null,
    allowedOrigins: [ALLOWED],
    try: tryOpts ?? { settings: () => ({ ok: true, settings: { apiKey: "sk-test", model: "claude-test" } }), callOptions: { fetcher: countingFetcher, maxRetries: 0 } },
  });
  await new Promise<void>((r) => api.server.listen(0, "127.0.0.1", r));
  http.use(await signIn(`http://127.0.0.1:${(api.server.address() as AddressInfo).port}`, api.authStore));
  try {
    await fn((api.server.address() as AddressInfo).port, api.app);
  } finally {
    await api.close();
  }
}

/** Raw request, so Origin and Content-Type are sent exactly as given (or not at all). */
function call(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { ...headers, ...(http.cookie ? { cookie: http.cookie } : {}) } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** Everything a request could change: the stored snapshot and the audit log's last seq. */
const stateOf = (app: App) => ({ seq: app.store.lastEventSeq(), snapshot: JSON.stringify(app.store.loadSnapshot()) });

test("gate: a text/plain POST to /api/action from a disallowed origin runs nothing and is refused", async () => {
  await withApi(async (port, app) => {
    const before = stateOf(app());
    const r = await call(port, "POST", "/api/action", { origin: OTHER, "content-type": "text/plain" }, INGEST);
    assert.ok(r.status === 403 || r.status === 415, String(r.status));
    assert.deepEqual(stateOf(app()), before);
    assert.equal(r.headers["access-control-allow-origin"], undefined);
  });
});

test("gate: a disallowed origin is 403 on every method, even with a valid JSON body, and nothing runs", async () => {
  await withApi(async (port, app) => {
    const before = stateOf(app());
    const post = await call(port, "POST", "/api/action", { origin: OTHER, "content-type": "application/json" }, INGEST);
    assert.equal(post.status, 403);
    assert.equal(JSON.parse(post.body).ok, false);
    assert.deepEqual(stateOf(app()), before);
    for (const [method, path] of [["GET", "/api/screens"], ["GET", "/api/health"], ["OPTIONS", "/api/action"], ["POST", "/api/reset"]] as const) {
      const r = await call(port, method, path, { origin: OTHER, "content-type": "application/json" }, method === "POST" ? "{}" : undefined);
      assert.equal(r.status, 403, `${method} ${path}`);
    }
    const tried = modelCalls;
    assert.equal((await call(port, "POST", "/api/try", { origin: OTHER, "content-type": "application/json" }, JSON.stringify(TRY_EMAIL))).status, 403);
    assert.equal(modelCalls, tried);
    assert.deepEqual(stateOf(app()), before);
  });
});

test("gate: a POST that isn't JSON is 415 on every POST route, from any origin or none, and nothing runs", async () => {
  await withApi(async (port, app) => {
    // Put some state in place, so a reset that slipped through would show.
    assert.equal((await call(port, "POST", "/api/action", { "content-type": "application/json" }, INGEST)).status, 200);
    const before = stateOf(app());
    const tried = modelCalls;
    const kinds: Record<string, string>[] = [
      { "content-type": "application/x-www-form-urlencoded" },
      { "content-type": "multipart/form-data; boundary=x" },
      { "content-type": "text/plain" },
      { "content-type": "text/plain;charset=UTF-8" },
      { "content-type": "application/json-patch+json" },
      { "content-type": "application/json; boundary=x" },
      {},
    ];
    for (const ct of kinds) {
      const origins: Record<string, string>[] = [{}, { origin: ALLOWED }];
      for (const origin of origins) {
        for (const [path, body] of [["/api/action", INGEST], ["/api/reset", "{}"], ["/api/try", JSON.stringify(TRY_EMAIL)]] as const) {
          const r = await call(port, "POST", path, { ...ct, ...origin }, body);
          assert.equal(r.status, 415, `${JSON.stringify(ct)} ${JSON.stringify(origin)} ${path}`);
        }
      }
    }
    // The form-encoded case on its own, as a browser form would send it.
    assert.equal((await call(port, "POST", "/api/action", { "content-type": "application/x-www-form-urlencoded" }, "action=ingestPmEmails")).status, 415);
    assert.deepEqual(stateOf(app()), before);
    assert.equal(modelCalls, tried);
  });
});

test("gate: an allowed-origin JSON POST still works and gets CORS headers", async () => {
  await withApi(async (port, app) => {
    const before = app().store.lastEventSeq();
    const r = await call(port, "POST", "/api/action", { origin: ALLOWED, "content-type": "application/json; charset=utf-8" }, INGEST);
    assert.equal(r.status, 200, r.body);
    assert.equal(r.headers["access-control-allow-origin"], ALLOWED);
    assert.ok(app().store.lastEventSeq() > before);
    const pre = await call(port, "OPTIONS", "/api/action", { origin: ALLOWED, "access-control-request-method": "POST" });
    assert.equal(pre.status, 204);
  });
});

test("gate: a JSON POST with no Origin header (curl, server-to-server) still works", async () => {
  await withApi(async (port, app) => {
    const before = app().store.lastEventSeq();
    const r = await call(port, "POST", "/api/action", { "content-type": "application/json" }, INGEST);
    assert.equal(r.status, 200, r.body);
    assert.ok(app().store.lastEventSeq() > before);
    assert.equal((await call(port, "POST", "/api/try", { "content-type": "Application/JSON" }, JSON.stringify(TRY_EMAIL))).status, 200);
    assert.equal((await call(port, "GET", "/api/screens", {})).status, 200);
  });
});

test("gate: isJsonContentType accepts application/json with only a charset parameter", () => {
  for (const ok of ["application/json", "application/json; charset=utf-8", "Application/JSON;charset=UTF-8", 'application/json; charset="utf-8"']) assert.equal(isJsonContentType(ok), true, ok);
  for (const no of [undefined, "", "text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "application/json-patch+json", "application/jsonx", "application/json; boundary=x", "text/json"]) {
    assert.equal(isJsonContentType(no), false, String(no));
  }
});

test("/api/try 503: a fixed message per API error type; the upstream message is never passed through", async () => {
  const SECRET = "UPSTREAM-TEXT-9c41";
  const errorBody = (status: number) => new Response(JSON.stringify({ type: "error", error: { type: "some_error", message: `${SECRET} details` } }), { status });
  const fetchers: Record<keyof typeof MODEL_ERROR_MESSAGES, typeof fetch> = {
    INVALID_CREDENTIAL: (async () => errorBody(401)) as unknown as typeof fetch,
    RATE_LIMITED: (async () => errorBody(429)) as unknown as typeof fetch,
    MODEL_ERROR: (async () => errorBody(500)) as unknown as typeof fetch,
    INVALID_OUTPUT: (async () => new Response(`not json ${SECRET}`, { status: 200 })) as unknown as typeof fetch,
    NETWORK_ERROR: (async () => {
      throw new TypeError(`fetch failed ${SECRET}`);
    }) as unknown as typeof fetch,
    TIMEOUT: (async () => {
      throw Object.assign(new Error(`timed out ${SECRET}`), { name: "TimeoutError" });
    }) as unknown as typeof fetch,
  };
  const messages = new Set(Object.values(MODEL_ERROR_MESSAGES));
  assert.equal(messages.size, 6); // one distinct sentence per type
  for (const [type, fetcher] of Object.entries(fetchers)) {
    await withApi(
      async (port) => {
        const r = await call(port, "POST", "/api/try", { "content-type": "application/json" }, JSON.stringify(TRY_EMAIL));
        assert.equal(r.status, 503, type);
        assert.deepEqual(JSON.parse(r.body), { ok: false, error: MODEL_ERROR_MESSAGES[type as keyof typeof MODEL_ERROR_MESSAGES] }, type);
        assert.ok(!r.body.includes(SECRET), type);
      },
      { settings: () => ({ ok: true, settings: { apiKey: "sk-test", model: "claude-test" } }), callOptions: { fetcher, maxRetries: 0, sleep: async () => {} } },
    );
  }
});
