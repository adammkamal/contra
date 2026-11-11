import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApiServer } from "../server/api.ts";
import { accountMismatch, authUrl, pkce, runAuthFlow, SCOPES, updateEnvText } from "../server/gmail-auth.ts";
import { GmailClient, GmailMemoSender, InboxPoller } from "../server/gmail.ts";
import { createHash } from "node:crypto";
import { AP } from "../src/actors.ts";
import type { App } from "../src/app.ts";
import { NotOffered, runAction } from "../src/commands.ts";
import type { MemoSender } from "../src/memo.ts";
import { IllegalTransition, transitionMemo } from "../src/state.ts";
import { buildScreens, isOffered, nextStep } from "../src/view.ts";
import { CONFIG, fakeExtract, fakeGmail, rfc822, SECRETS, sseClient, until } from "./gmail-fakes.ts";
import { sessionFetch, signIn, testAuth } from "./auth-fakes.ts";

const http = sessionFetch();

// Made-up addresses only. No network: the memo sender, Gmail and Google are fakes.

const START = new Date("2026-11-07T15:00:00Z");
const ALLOWED = "http://localhost:3000";
const SEND = { command: "sendCreditMemo" as const, creditId: "VC-1" };

/** A MemoSender that fails the first `failures` sends, then succeeds. */
function fakeSender(failures = 0) {
  const sent: string[] = [];
  let calls = 0;
  const sender: MemoSender = {
    destination: "ap@stand-in.example",
    async send(memo) {
      calls++;
      if (calls <= failures) throw new Error("the AP inbox refused the message (HTTP 503)");
      sent.push(memo.text);
      return { messageId: `msg-${calls}` };
    },
  };
  return { sender, sent, calls: () => calls };
}

async function withApi(sender: MemoSender | null, fn: (base: string, port: number, app: () => App) => Promise<void>) {
  const api = createApiServer({ auth: testAuth(), dbPath: join(mkdtempSync(join(tmpdir(), "contra-memo-")), "d.db"), start: START, emlDir: null, memoSender: sender, allowedOrigins: [ALLOWED] });
  await new Promise<void>((r) => api.server.listen(0, "127.0.0.1", r));
  http.use(await signIn(`http://127.0.0.1:${(api.server.address() as AddressInfo).port}`, api.authStore));
  const port = (api.server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`, port, api.app);
  } finally {
    await api.close();
  }
}

const post = async (base: string, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) => {
  const r = await http.fetch(`${base}/api/action`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};

/** Follows nextStep (as the presenter would) until `stop` says so. */
async function advance(app: App, stop: (a: NonNullable<ReturnType<typeof nextStep>["action"]>) => boolean) {
  for (let i = 0; i < 40; i++) {
    const a = nextStep(app).action;
    if (!a || stop(a)) return;
    await runAction(app, a);
  }
}

test("sendCreditMemo is not offered (409) before the credit is approved, nor without a memo sender", async () => {
  const { sender, calls } = fakeSender();
  await withApi(sender, async (base, _port, app) => {
    assert.equal((await post(base, { action: SEND })).status, 409); // no credit yet
    await advance(app(), (a) => a.command === "approveCredit");
    assert.equal(app().ctx.contra.credits.get("VC-1")!.state, "proposed");
    const r = await post(base, { action: SEND });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /not available right now/);
    assert.equal(buildScreens(app()).credits[0]!.memo, null);
    assert.equal(calls(), 0);
  });
  await withApi(null, async (base, _port, app) => {
    await advance(app(), () => false);
    assert.equal(app().ctx.contra.credits.get("VC-1")!.state, "applied");
    assert.equal(buildScreens(app()).credits[0]!.actions.length, 0);
    assert.equal((await post(base, { action: SEND })).status, 409);
  });
});

test("sendCreditMemo: queued -> failed is recorded, retry from failed sends it, and a sent memo can't be sent again", async () => {
  const { sender, sent, calls } = fakeSender(1);
  await withApi(sender, async (base, _port, app) => {
    await advance(app(), (a) => a.command === "billArrives"); // VC-1 approved and synced
    assert.deepEqual(buildScreens(app()).credits[0]!.actions, [SEND]);
    assert.deepEqual(buildScreens(app()).credits[0]!.memo, { label: "Memo not sent", tone: "idle" });

    const first = await post(base, { action: SEND });
    assert.equal(first.status, 200);
    const c1 = app().ctx.contra.credits.get("VC-1")!;
    assert.equal(c1.memoDelivery!.state, "failed");
    assert.match(first.body.screens.credits[0].memo.label, /^Memo not sent: the AP inbox refused the message \(HTTP 503\)\. You can send it again\.$/);
    assert.deepEqual(first.body.screens.credits[0].actions, [SEND]); // retry offered

    const second = await post(base, { action: SEND });
    assert.equal(second.status, 200);
    const c2 = app().ctx.contra.credits.get("VC-1")!;
    assert.deepEqual({ ...c2.memoDelivery }, { state: "sent", to: "ap@stand-in.example", attempts: 2, messageId: "msg-2", error: null });
    assert.equal(second.body.screens.credits[0].memo.label, "Memo sent to ap@stand-in.example");
    assert.deepEqual(second.body.screens.credits[0].actions, []);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /TOTAL CREDIT\s+\$11,500\.00/);

    assert.equal((await post(base, { action: SEND })).status, 409); // sent: never again
    assert.equal(calls(), 2);
    const memoEvents = [...app().ctx.contra.audit.all()].filter((e) => e.entity === "memo").map((e) => `${e.from ?? "new"}->${e.to} ${e.action}`);
    assert.deepEqual(memoEvents, [
      "new->queued memo queued for ap@stand-in.example",
      "queued->failed memo failed",
      "failed->queued memo queued for ap@stand-in.example (attempt 2)",
      "queued->sent memo sent to ap@stand-in.example",
    ]);
    // The demo still ends where it should.
    await advance(app(), () => false);
    assert.equal(buildScreens(app()).bills[0]!.paid, "$36,500.00");
  });
});

test("a memo left queued (stopped between send and record) is never re-sent automatically", async () => {
  const { sender, calls } = fakeSender();
  await withApi(sender, async (_base, _port, app) => {
    await advance(app(), (a) => a.command === "billArrives");
    // Simulate a crash after queueing: the queue step committed, the send's result never recorded.
    app().run(({ contra }) => contra.queueMemo("VC-1", sender.destination, AP));
    assert.equal(isOffered(app(), SEND), false);
    await assert.rejects(runAction(app(), SEND), NotOffered);
    assert.match(buildScreens(app()).credits[0]!.memo!.label, /check that inbox before sending again/);
    assert.equal(calls(), 0);
    // The transition table itself refuses queued -> queued.
    const c = structuredClone(app().ctx.contra.credits.get("VC-1")!);
    assert.throws(() => transitionMemo({ append: () => ({}) as never, all: () => [], forEntity: () => [] }, c, "queued", AP, "again", [], {}), IllegalTransition);
  });
});

test("sendCreditMemo goes through the API gates: a disallowed origin or a non-JSON POST can't trigger a send", async () => {
  const { sender, calls } = fakeSender();
  await withApi(sender, async (base, port, app) => {
    await advance(app(), (a) => a.command === "billArrives");
    const body = JSON.stringify({ action: SEND });
    const raw = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, method: "POST", path: "/api/action", headers: { ...headers, cookie: http.cookie } }, (res) => (res.resume(), resolve(res.statusCode!)));
        req.on("error", reject);
        req.end(body);
      });
    assert.equal(await raw({ origin: "https://evil.example", "content-type": "application/json" }), 403);
    assert.equal(await raw({ origin: "https://evil.example", "content-type": "text/plain" }), 403);
    assert.equal(await raw({ "content-type": "text/plain" }), 415);
    assert.equal(await raw({ "content-type": "application/x-www-form-urlencoded" }), 415);
    assert.equal(calls(), 0);
    assert.equal(app().ctx.contra.credits.get("VC-1")!.memoDelivery, undefined);
    assert.equal(await raw({ origin: ALLOWED, "content-type": "application/json" }), 200);
    assert.equal(calls(), 1);
  });
});

// ---- Secrets ---------------------------------------------------------------------------------

async function captureOutput(fn: () => Promise<void>): Promise<string> {
  const seen: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
  const saved = methods.map((m) => console[m]);
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  methods.forEach((m) => (console[m] = (...a: unknown[]) => void seen.push(a.map(String).join(" "))));
  process.stdout.write = ((c: unknown, ...r: unknown[]) => (seen.push(String(c)), out(c as string, ...(r as [])))) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown, ...r: unknown[]) => (seen.push(String(c)), err(c as string, ...(r as [])))) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    methods.forEach((m, i) => (console[m] = saved[i]!));
    process.stdout.write = out;
    process.stderr.write = err;
  }
  return seen.join("\n");
}

const leaked = (text: string) => Object.entries(SECRETS).filter(([, v]) => text.includes(v)).map(([k]) => k);

test("secrets: the refresh token, client secret and access token never appear in logs, errors, health, SSE or screens", async () => {
  const intake = (id: string) => ({ id, raw: rfc822({ messageId: `${id}@pm.example`, deliveredTo: CONFIG.intake, subject: "BC", body: "BC-7201: fix the ceiling, Summit, $400.00." }) });
  const seen: string[] = [];
  // Every failure the fake can produce echoes the secrets in its response body.
  const scenarios = [
    fakeGmail({ token: "server_error", messages: [intake("s1")] }),
    fakeGmail({ token: "invalid_grant", messages: [intake("s2")] }),
    fakeGmail({ listStatus: 500, messages: [intake("s3")] }),
    fakeGmail({ sendStatus: 500, messages: [intake("s4")] }),
    fakeGmail({ messages: [intake("s5")] }), // a successful poll and send
  ];
  const output = await captureOutput(async () => {
    for (const g of scenarios) {
      const now = () => Date.UTC(2026, 10, 10, 16);
      const client = new GmailClient(CONFIG, g.transport, now);
      const poller = new InboxPoller({ client, extract: fakeExtract().extract, now });
      const api = createApiServer({ auth: testAuth(), dbPath: join(mkdtempSync(join(tmpdir(), "contra-sec-")), "d.db"), liveDbPath: join(mkdtempSync(join(tmpdir(), "contra-sec-")), "live.db"), start: START, emlDir: null, heartbeatMs: 20, memoSender: new GmailMemoSender(client, now), inbox: { poller, intervalMs: 60_000 } });
      await new Promise<void>((r) => api.server.listen(0, "127.0.0.1", r));
      http.use(await signIn(`http://127.0.0.1:${(api.server.address() as AddressInfo).port}`, api.authStore));
      const port = (api.server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;
      const sse = await sseClient(port, { cookie: http.cookie });
      try {
        await api.pollNow();
        seen.push(JSON.stringify(poller.status()), await (await http.fetch(`${base}/api/health`)).text());
        await advance(api.app(), (a) => a.command === "billArrives");
        const r = await post(base, { action: SEND });
        seen.push(JSON.stringify(r.body));
        for (const call of [() => client.listIntake(), () => client.metadata("s1"), () => client.raw("nope"), () => client.send("x")]) {
          await call().catch((e: Error) => seen.push(e.message, String(e.stack)));
        }
        await until(() => sse.text().includes("heartbeat"));
        seen.push(sse.text(), JSON.stringify(buildScreens(api.app())), JSON.stringify([...api.app().ctx.contra.audit.all()]));
        seen.push(JSON.stringify(buildScreens(api.live()!)), JSON.stringify([...api.live()!.ctx.contra.audit.all()]));
      } finally {
        sse.close();
        await api.close();
      }
    }
  });
  assert.deepEqual(leaked(output), [], "console or stdout/stderr");
  assert.deepEqual(leaked(seen.join("\n")), [], "errors, health, SSE, screens or audit");
  // The scenarios did exercise the failure paths.
  const all = seen.join("\n");
  assert.match(all, /expired: run npm run gmail:auth/);
  assert.match(all, /refreshing the access token failed \(HTTP 500\)/);
  assert.match(all, /Gmail API error \(HTTP 500\)/);
  assert.match(all, /Memo not sent: Gmail API error \(HTTP 500\)/);
  assert.match(all, /Memo sent to demo\.tester\+ramp-ap@example\.com/);
});

// ---- gmail:auth ------------------------------------------------------------------------------

/** Runs the auth flow with a fake Google; `browser` decides what the "browser" sends back to the loopback. */
async function auth(profileEmail: string, browser: (redirect: URL) => string = (u) => `${u.origin}/?code=auth-code-1&state=${u.searchParams.get("state")}`) {
  let tokenBody = "";
  const transport = async (url: string, init: RequestInit = {}) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      tokenBody = String(init.body);
      return Response.json({ access_token: SECRETS.accessToken, refresh_token: SECRETS.refreshToken, expires_in: 3599 });
    }
    if (url === "https://gmail.googleapis.com/gmail/v1/users/me/profile") return Response.json({ emailAddress: profileEmail });
    return new Response("{}", { status: 404 });
  };
  let opened = "";
  const result = await runAuthFlow({
    client: { clientId: "client-id-123.apps.example", clientSecret: SECRETS.clientSecret },
    expected: "demo.tester@example.com",
    transport,
    timeoutMs: 5000,
    openBrowser: (url) => {
      opened = url;
      const u = new URL(url);
      const redirect = new URL(u.searchParams.get("redirect_uri")!);
      redirect.searchParams.set("state", u.searchParams.get("state")!);
      void fetch(browser(redirect)).then((r) => r.text()).catch(() => {});
    },
  });
  return { result, opened: new URL(opened), tokenBody: new URLSearchParams(tokenBody) };
}

test("gmail:auth refuses a profile email that doesn't match, and saves nothing", async () => {
  const { result } = await auth("someone.else@example.com");
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /signed in as someone\.else@example\.com, but Contra needs demo\.tester@example\.com/i.test(result.message));
  assert.ok(!result.ok && /pick demo\.tester@example\.com/.test(result.message));
  assert.equal("values" in result, false);
  assert.equal(accountMismatch("Demo.Tester@Example.com", "demo.tester@example.com"), null);
});

test("gmail:auth: loopback PKCE (S256) flow with only the two scopes; saves the four values for the right account", async () => {
  const { result, opened, tokenBody } = await auth("Demo.Tester@example.com");
  assert.ok(result.ok);
  assert.deepEqual(Object.keys(result.values), ["CONTRA_GMAIL_ADDRESS", "CONTRA_GMAIL_CLIENT_ID", "CONTRA_GMAIL_CLIENT_SECRET", "CONTRA_GMAIL_REFRESH_TOKEN"]);
  assert.equal(result.values.CONTRA_GMAIL_ADDRESS, "demo.tester@example.com");
  assert.equal(result.values.CONTRA_GMAIL_REFRESH_TOKEN, SECRETS.refreshToken);
  const q = opened.searchParams;
  assert.equal(opened.origin + opened.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.deepEqual(q.get("scope")!.split(" "), [...SCOPES]);
  assert.deepEqual([...SCOPES], ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"]);
  assert.equal(q.get("access_type"), "offline");
  assert.equal(q.get("prompt"), "consent");
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.match(q.get("redirect_uri")!, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(q.get("state")!.length >= 32);
  // The verifier sent with the code matches the challenge in the URL.
  const verifier = tokenBody.get("code_verifier")!;
  assert.equal(createHash("sha256").update(verifier).digest("base64url"), q.get("code_challenge"));
  assert.equal(tokenBody.get("grant_type"), "authorization_code");
  const p = pkce();
  assert.equal(createHash("sha256").update(p.verifier).digest("base64url"), p.challenge);
  assert.match(authUrl({ clientId: "c", redirectUri: "http://127.0.0.1:1", challenge: "x", state: "s", loginHint: "a@b.example" }), /login_hint=a%40b\.example/);
});

test("gmail:auth refuses a browser answer with the wrong state", async () => {
  const { result } = await auth("demo.tester@example.com", (u) => `${u.origin}/?code=c&state=forged`);
  assert.ok(!result.ok && /different state/.test(result.message));
});

test("updateEnvText: updates keys in place, keeps every other line and the line endings, strips a BOM", () => {
  const before = "﻿# Contra\r\nCONTRA_ANTHROPIC_API_KEY=sk-keep-me\r\nCONTRA_GMAIL_REFRESH_TOKEN=old\r\nOTHER=1\r\nCONTRA_GMAIL_REFRESH_TOKEN=dupe\r\n";
  const after = updateEnvText(before, { CONTRA_GMAIL_REFRESH_TOKEN: "1//new-token", CONTRA_GMAIL_ADDRESS: "demo.tester@example.com" });
  assert.equal(after, "# Contra\r\nCONTRA_ANTHROPIC_API_KEY=sk-keep-me\r\nCONTRA_GMAIL_REFRESH_TOKEN=1//new-token\r\nOTHER=1\r\nCONTRA_GMAIL_ADDRESS=demo.tester@example.com\r\n");
  assert.equal(updateEnvText("", { A: "b" }), "A=b\n");
  assert.equal(updateEnvText("X=1", { A: 'has "quotes" and spaces' }), 'X=1\nA="has \\"quotes\\" and spaces"\n');
  assert.throws(() => updateEnvText("", { A: "two\nlines" }), /line break/);
});
