import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { request } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApiServer, type AuthOptions } from "../server/api.ts";
import { AuthStore, parseUserAddArgs, SESSION_COOKIE } from "../server/auth.ts";
import { signIn, TEST_COST, TEST_PASSWORD, testAuth } from "./auth-fakes.ts";

// Accounts and sessions (server/auth.ts). Made-up names and passwords only.

const START = new Date("2026-11-07T15:00:00Z");
const tmp = () => mkdtempSync(join(tmpdir(), "contra-auth-"));
const MIN = 60_000;

async function withApi(auth: AuthOptions, fn: (base: string) => Promise<void>) {
  const api = createApiServer({ auth, dbPath: join(tmp(), "d.db"), start: START, emlDir: null });
  await new Promise<void>((r) => api.server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(api.server.address() as AddressInfo).port}`);
  } finally {
    await api.close();
  }
}

const login = (base: string, username: string, password: string) =>
  fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0]!;
const me = (base: string, cookie?: string) => fetch(`${base}/api/me`, cookie ? { headers: { cookie } } : {});

test("login: the right password starts a session (HttpOnly, SameSite=Lax cookie); a wrong one or an unknown user is 401 with the same words", async () => {
  const auth = testAuth();
  await auth.store.addUser("pat.pm", "pm", TEST_PASSWORD);
  await withApi(auth, async (base) => {
    for (const [u, p] of [["pat.pm", "not the password!"], ["nobody.here", TEST_PASSWORD]] as const) {
      const r = await login(base, u, p);
      assert.equal(r.status, 401);
      assert.deepEqual(await r.json(), { ok: false, error: "wrong username or password" });
      assert.equal(r.headers.get("set-cookie"), null);
    }
    const r = await login(base, "Pat.PM ", TEST_PASSWORD); // usernames are matched lowercased and trimmed
    assert.equal(r.status, 200);
    const set = r.headers.get("set-cookie")!;
    assert.match(set, new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200$`));
    const body = (await r.json()) as any;
    assert.deepEqual(body.user, { username: "pat.pm", role: "pm", live: false });
    assert.deepEqual(body.workspaces, ["demo"]);
    const m = await me(base, cookieOf(r));
    assert.equal(m.status, 200);
    assert.equal(((await m.json()) as any).user.username, "pat.pm");
    assert.equal((await me(base)).status, 401);
    assert.equal((await me(base, `${SESSION_COOKIE}=made-up-session-id`)).status, 401);
    // Bad shapes are 400 and count toward nothing.
    for (const body of [{}, { username: "pat.pm" }, { username: "pat.pm", password: TEST_PASSWORD, role: "controller" }]) {
      const b = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(b.status, 400);
    }
  });
});

test("login: Secure is added to the cookie with secureCookies (CONTRA_SECURE_COOKIES=1)", async () => {
  const auth = testAuth({ secureCookies: true });
  await auth.store.addUser("pat.pm", "pm", TEST_PASSWORD);
  await withApi(auth, async (base) => {
    assert.match((await login(base, "pat.pm", TEST_PASSWORD)).headers.get("set-cookie")!, /; Secure$/);
  });
});

test("sessions: logout ends the session server-side; a session expires after its lifetime", async () => {
  let now = START.getTime();
  const auth = testAuth({ now: () => now, sessionTtlMs: 60 * MIN });
  await auth.store.addUser("cy.ctl", "controller", TEST_PASSWORD, { live: true });
  await withApi(auth, async (base) => {
    const a = cookieOf(await login(base, "cy.ctl", TEST_PASSWORD));
    const b = cookieOf(await login(base, "cy.ctl", TEST_PASSWORD));
    const out = await fetch(`${base}/api/logout`, { method: "POST", headers: { "content-type": "application/json", cookie: a } });
    assert.equal(out.status, 200);
    assert.match(out.headers.get("set-cookie")!, new RegExp(`^${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0$`));
    assert.equal((await me(base, a)).status, 401); // the old cookie is useless, even if a browser kept it
    assert.equal((await me(base, b)).status, 200); // the other session is untouched
    now += 59 * MIN;
    assert.equal((await me(base, b)).status, 200);
    now += 1 * MIN;
    assert.equal((await me(base, b)).status, 401);
    assert.equal((await fetch(`${base}/api/logout`, { method: "POST", headers: { "content-type": "application/json", cookie: b } })).status, 401);
  });
});

/** POST /api/login from a chosen loopback address (127.0.0.1 or 127.0.0.2), so tests can be two clients. */
function loginFrom(base: string, localAddress: string, username: string, password: string): Promise<{ status: number; body: any; setCookie: string | undefined }> {
  const u = new URL(`${base}/api/login`);
  const body = JSON.stringify({ username, password });
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", localAddress, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text), setCookie: res.headers["set-cookie"]?.[0] }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
const STRANGER = "127.0.0.2";
const OWNER = "127.0.0.1";

test("lockout: a stranger's 5 wrong passwords lock only the stranger's address for that username; the real person signs in from theirs", async () => {
  let now = START.getTime();
  const delays: number[] = [];
  const auth = testAuth({ now: () => now, sleep: async (ms) => void delays.push(ms) });
  await auth.store.addUser("pat.pm", "pm", TEST_PASSWORD);
  await withApi(auth, async (base) => {
    for (let i = 0; i < 5; i++) assert.equal((await loginFrom(base, STRANGER, "pat.pm", `wrong password ${i}`)).status, 401);
    // The stranger's address is now refused for pat.pm, even with the right password, before it is checked.
    const r = await loginFrom(base, STRANGER, "pat.pm", TEST_PASSWORD);
    assert.equal(r.status, 429);
    assert.equal(r.body.error, "too many failed sign-ins for this username from your address; try again in 15 minutes");
    assert.equal(r.setCookie, undefined);
    // Pat, from their own address, is not locked out: slowed down (the failures came from somewhere), then in.
    delays.length = 0;
    const own = await loginFrom(base, OWNER, "pat.pm", TEST_PASSWORD);
    assert.equal(own.status, 200);
    assert.deepEqual(delays, [500]);
    // The pair lock lasts 15 minutes.
    now += 15 * MIN;
    assert.equal((await loginFrom(base, STRANGER, "pat.pm", TEST_PASSWORD)).status, 200);
  });
});

test("backoff: failures for a username from many addresses slow its sign-ins (doubling, capped at 8 s) but never refuse them", async () => {
  const delays: number[] = [];
  const auth = testAuth({ loginLimits: { perIp: 1000, perUserIp: 1000 }, sleep: async (ms) => void delays.push(ms) });
  await auth.store.addUser("pat.pm", "pm", TEST_PASSWORD);
  await withApi(auth, async (base) => {
    for (let i = 0; i < 12; i++) assert.equal((await loginFrom(base, i % 2 ? STRANGER : OWNER, "pat.pm", `wrong ${i}`)).status, 401);
    // No delay for the first 5 failures; then 0.5 s, doubling, capped at 8 s.
    assert.deepEqual(delays, [500, 1000, 2000, 4000, 8000, 8000, 8000]);
    delays.length = 0;
    const ok = await loginFrom(base, OWNER, "pat.pm", TEST_PASSWORD);
    assert.equal(ok.status, 200);
    assert.deepEqual(delays, [8000]);
    // A successful sign-in clears the username's backoff.
    delays.length = 0;
    assert.equal((await loginFrom(base, STRANGER, "pat.pm", "wrong again")).status, 401);
    assert.deepEqual(delays, []);
  });
});

test("backoff: the real delay is a real wait (no injected sleep)", async () => {
  const auth = testAuth({ loginLimits: { backoffAfter: 1, backoffBaseMs: 120, perUserIp: 1000 } });
  await auth.store.addUser("pat.pm", "pm", TEST_PASSWORD);
  await withApi(auth, async (base) => {
    assert.equal((await loginFrom(base, STRANGER, "pat.pm", "wrong")).status, 401);
    const t = performance.now();
    assert.equal((await loginFrom(base, OWNER, "pat.pm", TEST_PASSWORD)).status, 200);
    assert.ok(performance.now() - t >= 110, "the sign-in waited out the backoff");
  });
});

test("rate limit: failures from one address across many usernames are capped per IP", async () => {
  const auth = testAuth({ loginLimits: { perIp: 3, perUserIp: 100 } });
  await auth.store.addUser("al.ap", "ap", TEST_PASSWORD);
  await withApi(auth, async (base) => {
    for (const u of ["x1", "x2", "x3"]) assert.equal((await login(base, u, "wrong password!")).status, 401);
    const r = await login(base, "al.ap", TEST_PASSWORD);
    assert.equal(r.status, 429);
    assert.match(((await r.json()) as any).error, /too many failed sign-ins from your address/);
  });
});

test("secrets: passwords and session ids never appear in logs, response bodies or the database", async () => {
  const dir = tmp();
  const dbPath = join(dir, "auth.db");
  const store = new AuthStore(dbPath, { cost: TEST_COST });
  const password = "sekrit-pass-phrase-91f3";
  await store.addUser("pat.pm", "pm", password, { live: true });
  await store.addUser("cy.ctl", "controller", password); // same password, different salt
  const logged: string[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info, out: process.stdout.write, err: process.stderr.write };
  const grab = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  Object.assign(console, { log: grab, error: grab, warn: grab, info: grab });
  process.stdout.write = ((c: unknown) => (logged.push(String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => (logged.push(String(c)), true)) as typeof process.stderr.write;
  const bodies: string[] = [];
  let sessionId = "";
  try {
    await withApi({ store }, async (base) => {
      const keep = async (r: Response) => (bodies.push(JSON.stringify([...r.headers].filter(([k]) => k !== "set-cookie")), await r.text()), r);
      await keep(await login(base, "pat.pm", "wrong " + password));
      const r = await login(base, "pat.pm", password);
      const cookie = cookieOf(r);
      sessionId = cookie.split("=")[1]!;
      await keep(r);
      await keep(await me(base, cookie));
      await keep(await fetch(`${base}/api/screens`, { headers: { cookie } }));
      await keep(await fetch(`${base}/api/health`, { headers: { cookie } }));
      await keep(await fetch(`${base}/api/logout`, { method: "POST", headers: { "content-type": "application/json", cookie } }));
      await keep(await me(base, cookie));
    });
  } finally {
    Object.assign(console, { log: orig.log, error: orig.error, warn: orig.warn, info: orig.info });
    process.stdout.write = orig.out;
    process.stderr.write = orig.err;
  }
  assert.ok(sessionId.length >= 40);
  for (const [what, text] of [["logs", logged.join("\n")], ["responses", bodies.join("\n")]] as const) {
    assert.ok(!text.includes(password), `password in ${what}`);
    assert.ok(!text.includes(sessionId), `session id in ${what}`);
  }
  store.close();
  const db = ["", "-wal"].map((s) => (existsSync(dbPath + s) ? readFileSync(dbPath + s).toString("latin1") : "")).join("");
  assert.ok(!db.includes(password), "password in the database");
  assert.ok(!db.includes(sessionId), "session id in the database (only its SHA-256 is stored)");
  const hashes = [...db.matchAll(/scrypt\$1024\$8\$1\$([A-Za-z0-9+/=]{24})\$/g)].map((m) => m[1]);
  assert.equal(new Set(hashes).size, 2, "each user has their own salt");
});

test("user:add: the password is read from the prompt (here a pipe), never printed; a password given as an argument is refused and not echoed", () => {
  const dir = tmp();
  const env = { ...process.env, CONTRA_AUTH_DB: join(dir, "auth.db") };
  const run = (args: string[], input: string) => spawnSync(process.execPath, ["--import", "tsx", "scripts/user-add.ts", ...args], { env, input, encoding: "utf8" });
  const password = "piped-pass-phrase-5d0a";
  const ok = run(["kim.ap", "ap", "--live"], password + "\n");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /added kim\.ap \(AP, demo and live workspaces\)/);
  assert.ok(!(ok.stdout + ok.stderr).includes(password));
  const store = new AuthStore(env.CONTRA_AUTH_DB);
  assert.deepEqual(store.user("kim.ap"), { username: "kim.ap", role: "ap", live: true });
  store.close();

  const asArg = run(["lee.ctl", "controller", "hunter2-as-an-argument"], "");
  assert.equal(asArg.status, 2);
  assert.ok(!(asArg.stdout + asArg.stderr).includes("hunter2"));
  const dup = run(["kim.ap", "pm"], "another-password-xyz\n");
  assert.equal(dup.status, 1);
  assert.match(dup.stderr, /already exists/);
  const short = run(["sam.pm", "pm"], "short\n");
  assert.equal(short.status, 1);
  assert.match(short.stderr, /at least 12 characters; nothing was added/);
  assert.ok(!short.stderr.includes("short\n"));

  assert.deepEqual(parseUserAddArgs(["pat.pm", "pm"]), { username: "pat.pm", role: "pm", live: false });
  assert.match(parseUserAddArgs(["pat.pm", "boss"]) as string, /role must be one of: pm, controller, ap/);
  assert.match(parseUserAddArgs(["pat.pm", "pm", "--password=x"]) as string, /unknown option/);
  assert.ok(!(parseUserAddArgs(["pat.pm", "pm", "--password=x"]) as string).includes("--password=x"));
});

test("no session: 401 on every route except POST /api/login and GET /api/health; nothing runs and nothing changes", async () => {
  const auth = testAuth();
  let trySettingsRead = 0;
  const dir = tmp();
  const api = createApiServer({
    auth,
    dbPath: join(dir, "d.db"),
    liveDbPath: join(dir, "live.db"),
    realClock: { now: () => START },
    start: START,
    emlDir: null,
    try: { settings: () => (trySettingsRead++, { ok: false as const, message: "no key in this test" }) },
  });
  await new Promise<void>((r) => api.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  try {
    const cookie = await signIn(base, auth);
    const json = { "content-type": "application/json" };
    // Some state, so a reset or action that slipped through would show.
    assert.equal((await fetch(`${base}/api/action`, { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ action: { command: "ingestPmEmails" } }) })).status, 200);
    const before = await (await fetch(`${base}/api/screens`, { headers: { cookie } })).text();
    const auditBefore = api.app().ctx.contra.audit.all().length;

    const routes: [string, string, unknown?][] = [
      ["GET", "/api/screens"],
      ["GET", "/api/screens?workspace=live"],
      ["GET", "/api/events"],
      ["GET", "/api/me"],
      ["GET", "/api/backcharge/BC-4467"],
      ["GET", "/api/credit/VC-1/memo"],
      ["GET", "/api/no-such-route"],
      ["POST", "/api/action", { action: { command: "confirmLink", ref: "BC-4467" } }],
      ["POST", "/api/action?workspace=live", { action: { command: "advanceDays", days: 7 } }],
      ["POST", "/api/reset", {}],
      ["POST", "/api/reset?workspace=live", {}],
      ["POST", "/api/try", { subject: "s", body: "BC-1: $1.00" }],
      ["POST", "/api/logout", {}],
    ];
    for (const badCookie of [undefined, `${SESSION_COOKIE}=forged-or-expired`, `${SESSION_COOKIE}=`]) {
      for (const [method, path, body] of routes) {
        const r = await fetch(`${base}${path}`, { method, headers: { ...(method === "POST" ? json : {}), ...(badCookie ? { cookie: badCookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        assert.equal(r.status, 401, `${method} ${path} ${badCookie ?? "no cookie"}`);
        assert.deepEqual(await r.json(), { ok: false, error: "sign in first" });
      }
    }
    assert.equal(trySettingsRead, 0, "an unsigned /api/try never reaches the model settings, let alone the model");
    assert.equal(await (await fetch(`${base}/api/screens`, { headers: { cookie } })).text(), before);
    assert.equal(api.app().ctx.contra.audit.all().length, auditBefore);

    // Health: without a session only "up"; with one, the workspaces and the inbox.
    const anon = await fetch(`${base}/api/health`);
    assert.equal(anon.status, 200);
    assert.deepEqual(await anon.json(), { ok: true });
    const h = (await (await fetch(`${base}/api/health`, { headers: { cookie } })).json()) as any;
    assert.deepEqual(h.workspaces, ["demo", "live"]);
    assert.equal(h.inbox.mode, "sample");
    // A signed-in /api/try reaches its own checks (here: no key, 503), keeping its caps.
    assert.equal((await fetch(`${base}/api/try`, { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ subject: "s", body: "BC-1: $1.00" }) })).status, 503);
    assert.equal(trySettingsRead, 1);
  } finally {
    await api.close();
  }
});
