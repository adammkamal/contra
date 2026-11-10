import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseEml } from "../ingest/eml.ts";
import { createApiServer } from "../server/api.ts";
import { EXPIRED, fromBase64url, GmailClient, gmailConfigFromEnv, InboxPoller, MAX_PER_POLL, memoFooter, memoMime, plusAddress, pollSecondsFromEnv, skipReason } from "../server/gmail.ts";
import { App } from "../src/app.ts";
import { ingestInboxEmail, runAction } from "../src/commands.ts";
import { buildScreens, nextStep } from "../src/view.ts";
import { CONFIG, fakeExtract, fakeGmail, rfc822, sseClient, until, type FakeMessage } from "./gmail-fakes.ts";

// Every email and address here is made up. No network: Gmail and Google's token endpoint are faked.

const START = new Date("2026-11-07T15:00:00Z");
const now = () => Date.UTC(2026, 10, 10, 16, 0, 0);
const freshApp = () => new App(join(mkdtempSync(join(tmpdir(), "contra-gmail-")), "d.db"), { start: START });

const intakeMsg = (id: string, body = `Hi,\r\n\r\nBC-71${id.slice(-2).padStart(2, "0")}: patch drywall at the stair, Summit, $900.00.\r\n\r\nDana`): FakeMessage => ({
  id,
  raw: rfc822({ messageId: `${id}@pm.example`, deliveredTo: CONFIG.intake, subject: `Back-charge ${id}`, body }),
});

test("gmail config: addresses come from CONTRA_GMAIL_ADDRESS (+backcharges, +ramp-ap), CONTRA_AP_INBOX overrides; poll seconds >= 10", () => {
  const env = { CONTRA_GMAIL_ADDRESS: "Someone.Else@Example.org", CONTRA_GMAIL_CLIENT_ID: "id", CONTRA_GMAIL_CLIENT_SECRET: "s", CONTRA_GMAIL_REFRESH_TOKEN: "r" };
  const c = gmailConfigFromEnv(env);
  assert.ok(c.ok);
  assert.equal(c.config.intake, "someone.else+backcharges@example.org");
  assert.equal(c.config.apInbox, "someone.else+ramp-ap@example.org");
  const o = gmailConfigFromEnv({ ...env, CONTRA_AP_INBOX: "ap@finance.example" });
  assert.ok(o.ok && o.config.apInbox === "ap@finance.example");
  const loop = gmailConfigFromEnv({ ...env, CONTRA_AP_INBOX: "someone.else+backcharges@example.org" });
  assert.ok(!loop.ok && /must not be the PM intake/.test(loop.message));
  const missing = gmailConfigFromEnv({ CONTRA_GMAIL_ADDRESS: "a@b.example" });
  assert.ok(!missing.ok && /not configured: run npm run gmail:auth/.test(missing.message));
  assert.equal(plusAddress("a+old@b.example", "x"), "a+x@b.example");
  assert.equal(pollSecondsFromEnv({}), 20);
  assert.equal(pollSecondsFromEnv({ CONTRA_GMAIL_POLL_SECONDS: "10" }), 10);
  for (const bad of ["9", "0", "2.5", "soon"]) assert.throws(() => pollSecondsFromEnv({ CONTRA_GMAIL_POLL_SECONDS: bad }), /at least 10/, bad);
});

test("poll: the query targets only the intake address; ramp-ap mail, X-Contra-Generated mail and mail over 5 MB are skipped unread", async () => {
  const messages: FakeMessage[] = [
    intakeMsg("m01"),
    { id: "m02", raw: rfc822({ messageId: "m02@pm.example", deliveredTo: CONFIG.apInbox, subject: "for AP", body: "BC-7102: x, $5.00." }) },
    { id: "m03", raw: rfc822({ messageId: "m03@contra.example", deliveredTo: CONFIG.intake, subject: "memo", body: "BC-7103: x, $5.00.", extraHeaders: ["X-Contra-Generated: memo"] }) },
    { ...intakeMsg("m04"), size: 6 * 1024 * 1024 },
  ];
  const g = fakeGmail({ messages });
  const x = fakeExtract();
  const poller = new InboxPoller({ client: new GmailClient(CONFIG, g.transport, now), extract: x.extract, now });
  const app = freshApp();
  try {
    assert.deepEqual(await poller.poll(app), { ingested: 1 });
    const list = new URL(g.calls.find((c) => c.url.includes("/messages?"))!.url);
    assert.deepEqual([...list.searchParams.entries()], [["q", `deliveredto:${CONFIG.intake}`], ["maxResults", String(MAX_PER_POLL)]]);
    assert.deepEqual(g.rawFetched(), ["m01"]); // only the one to ingest is downloaded
    assert.equal(x.calls(), 1);
    assert.deepEqual([...app.ctx.contra.backCharges.keys()], ["BC-7101"]);
    assert.equal(poller.status().status, "ok");
    const plan = await poller.plan((k) => app.ctx.contra.hasMessage(k));
    assert.deepEqual(plan.map((m) => [m.gmailId, m.skip]), [
      ["m01", "already ingested"],
      ["m02", `not delivered to ${CONFIG.intake}`],
      ["m03", "sent by Contra (X-Contra-Generated)"],
      ["m04", "larger than 5 MB"],
    ]);
  } finally {
    app.close();
  }
});

test("skipReason: a message is ingested only when delivered to the intake address, not generated, small and new", () => {
  const m = { gmailId: "a", messageId: "<a@x>", date: "", from: "", subject: "", deliveredTo: [CONFIG.intake], generated: false, sizeEstimate: 10 };
  assert.equal(skipReason(m, CONFIG.intake, () => false), null);
  assert.match(skipReason({ ...m, deliveredTo: [CONFIG.apInbox] }, CONFIG.intake, () => false)!, /not delivered/);
  assert.match(skipReason({ ...m, deliveredTo: [] }, CONFIG.intake, () => false)!, /not delivered/);
  assert.match(skipReason({ ...m, generated: true }, CONFIG.intake, () => false)!, /X-Contra-Generated/);
  assert.equal(skipReason(m, CONFIG.intake, (k) => k === "<a@x>"), "already ingested");
});

test("raw: base64url format=raw round-trips through parseEml, keeping the Message-ID; attachments are counted, not read", async () => {
  const body = "Hi,\r\n\r\nBC-7105: replace the damaged door closer, Summit, $1,240.00.\r\n\r\nDana";
  const raw = rfc822({ messageId: "rt-1@pm.example", deliveredTo: CONFIG.intake, subject: "Closer", body });
  const g = fakeGmail({ messages: [{ id: "r1", raw }] });
  const client = new GmailClient(CONFIG, g.transport, now);
  const bytes = await client.raw("r1");
  assert.equal(bytes.toString("utf8"), raw);
  assert.equal(fromBase64url(Buffer.from(raw).toString("base64url")).toString("utf8"), raw);
  const email = await parseEml(bytes, "gmail-r1");
  assert.equal(email.messageId, "<rt-1@pm.example>");
  assert.equal(email.subject, "Closer");
  assert.equal(email.body, "Hi,\n\nBC-7105: replace the damaged door closer, Summit, $1,240.00.\n\nDana");
  assert.equal(email.receivedAt.toISOString(), "2026-11-10T15:00:00.000Z");
  assert.equal(email.attachmentCount, undefined);

  const withFile = [
    `Delivered-To: ${CONFIG.intake}`, "Message-ID: <att-1@pm.example>", "Date: Tue, 10 Nov 2026 15:00:00 +0000",
    "From: Dana <dana@apexbuilders.example>", `To: ${CONFIG.intake}`, "Subject: With photo", "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b1"', "", "--b1", "Content-Type: text/plain; charset=utf-8", "",
    "BC-7106: clean the lobby, Summit, $300.00.", "--b1", "Content-Type: image/png", 'Content-Disposition: attachment; filename="photo.png"',
    "Content-Transfer-Encoding: base64", "", "iVBORw0KGgo=", "--b1--", "",
  ].join("\r\n");
  const g2 = fakeGmail({ messages: [{ id: "a1", raw: withFile }] });
  const app = freshApp();
  try {
    await new InboxPoller({ client: new GmailClient(CONFIG, g2.transport, now), extract: fakeExtract().extract, now }).poll(app);
    const stored = app.ctx.contra.emails.get("gmail-a1")!;
    assert.equal(stored.attachmentCount, 1);
    const ev = [...app.ctx.contra.audit.all()].find((e) => e.entity === "email" && e.entityId === "gmail-a1")!;
    assert.equal(ev.action, "ingested from Gmail");
    assert.ok(ev.evidence.includes("1 attachment(s), not read"));
  } finally {
    app.close();
  }
});

test("idempotency (core): the same Message-ID ingested twice makes one back-charge and no second audit entry", async () => {
  const app = freshApp();
  try {
    const email = await parseEml(Buffer.from(intakeMsg("m11").raw), "gmail-m11");
    const { extract } = fakeExtract();
    const x = await extract(email);
    assert.deepEqual(ingestInboxEmail(app, email, x.items, x.actor), { ingested: true, refs: ["BC-7111"] });
    const seq = app.store.lastEventSeq();
    // Same Message-ID, even under another Gmail id: nothing changes.
    const again = { ...email, id: "gmail-other" };
    assert.deepEqual(ingestInboxEmail(app, again, x.items, x.actor), { ingested: false, refs: [] });
    // And straight through the core, bypassing the command's own check.
    app.run(({ contra }) => contra.ingestBackChargeEmail(again, x.items, x.actor, "gmail"));
    assert.equal(app.store.lastEventSeq(), seq);
    assert.equal(app.ctx.contra.backCharges.size, 1);
    assert.equal([...app.ctx.contra.emails.keys()].length, 1);
    assert.equal(app.ctx.contra.notices.size, 0);
  } finally {
    app.close();
  }
});

test("poll: a second poll doesn't download or extract what was already ingested", async () => {
  const g = fakeGmail({ messages: [intakeMsg("m21"), intakeMsg("m22")] });
  const x = fakeExtract();
  const poller = new InboxPoller({ client: new GmailClient(CONFIG, g.transport, now), extract: x.extract, now });
  const app = freshApp();
  try {
    assert.equal((await poller.poll(app)).ingested, 2);
    const seq = app.store.lastEventSeq();
    assert.equal((await poller.poll(app)).ingested, 0);
    assert.equal(x.calls(), 2);
    assert.equal(g.rawFetched().length, 2);
    assert.equal(app.store.lastEventSeq(), seq);
  } finally {
    app.close();
  }
});

test("poll: polls never overlap; a second poll while one runs returns at once", async () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const g = fakeGmail({ messages: [intakeMsg("m31")], gate });
  const poller = new InboxPoller({ client: new GmailClient(CONFIG, g.transport, now), extract: fakeExtract().extract, now });
  const app = freshApp();
  try {
    const first = poller.poll(app);
    await until(() => g.calls.some((c) => c.url.includes("/messages?")));
    // The second poll must return at once; without the guard it would wait on Gmail like the first.
    const second = await Promise.race([poller.poll(app), new Promise((r) => setTimeout(() => r("still waiting"), 300))]);
    assert.deepEqual(second, { ingested: 0, overlapped: true });
    open();
    assert.deepEqual(await first, { ingested: 1 });
    assert.equal(g.calls.filter((c) => c.url.includes("/messages?")).length, 1);
  } finally {
    app.close();
  }
});

test("invalid_grant: the inbox reports expired, the poll doesn't throw, and the server keeps serving screens", async () => {
  const g = fakeGmail({ token: "invalid_grant", messages: [intakeMsg("m41")] });
  const poller = new InboxPoller({ client: new GmailClient(CONFIG, g.transport, now), extract: fakeExtract().extract, now });
  const api = createApiServer({ dbPath: join(mkdtempSync(join(tmpdir(), "contra-gmail-")), "d.db"), start: START, emlDir: null, inbox: { poller, intervalMs: 60_000 } });
  await new Promise<void>((r) => api.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  try {
    await api.pollNow();
    const health = (await (await fetch(`${base}/api/health`)).json()) as { ok: boolean; inbox: Record<string, unknown> };
    assert.deepEqual(health, { ok: true, inbox: { mode: "gmail", address: CONFIG.intake, lastPollAt: "2026-11-10T16:00:00.000Z", lastError: EXPIRED, status: EXPIRED } });
    assert.equal(EXPIRED, "expired: run npm run gmail:auth");
    const screens = await fetch(`${base}/api/screens`);
    assert.equal(screens.status, 200);
    assert.equal(((await screens.json()) as { nextStep: { text: string } }).nextStep.text, "Ingest the PM's back-charge emails");
  } finally {
    await api.close();
  }
});

test("health: without the live inbox it reports sample mode and no address", async () => {
  const api = createApiServer({ dbPath: join(mkdtempSync(join(tmpdir(), "contra-gmail-")), "d.db"), start: START, emlDir: null });
  await new Promise<void>((r) => api.server.listen(0, "127.0.0.1", r));
  try {
    const h = await (await fetch(`http://127.0.0.1:${(api.server.address() as AddressInfo).port}/api/health`)).json();
    assert.deepEqual(h, { ok: true, inbox: { mode: "sample", address: null, lastPollAt: null, lastError: null, status: "off" } });
  } finally {
    await api.close();
  }
});

test("live mail never steers the demo script, and the demo still ends at $11,500.00 / $36,500.00", async () => {
  // A live email for an unknown vendor (needs review) arrives before the demo starts.
  const g = fakeGmail({ messages: [intakeMsg("m51")] });
  const poller = new InboxPoller({ client: new GmailClient(CONFIG, g.transport, now), extract: fakeExtract("Nobody We Know LLC", "Summit").extract, now });
  const app = freshApp();
  try {
    await poller.poll(app);
    assert.equal(app.ctx.contra.backCharges.get("BC-7151")!.state, "needs_review");
    assert.equal(buildScreens(app).emailSource, "gmail");
    assert.equal(nextStep(app).text, "Ingest the PM's back-charge emails");
    for (let i = 0; i < 40; i++) {
      const a = nextStep(app).action;
      if (!a) break;
      await runAction(app, a);
    }
    const s = buildScreens(app);
    assert.equal(s.nextStep.text, "Demo complete");
    assert.deepEqual(s.credits.map((c) => c.amount), ["$11,500.00"]);
    assert.equal(s.bills[0]!.paid, "$36,500.00");
    assert.equal(s.emailSource, "mixed");
    assert.equal(app.ctx.contra.backCharges.get("BC-7151")!.state, "needs_review"); // still waiting for a person
  } finally {
    app.close();
  }
});

test("SSE: screens-changed after an action, a reset and a poll that ingested, plus heartbeats", async () => {
  const g = fakeGmail({ messages: [intakeMsg("m61")] });
  const poller = new InboxPoller({ client: new GmailClient(CONFIG, g.transport, now), extract: fakeExtract().extract, now });
  const api = createApiServer({ dbPath: join(mkdtempSync(join(tmpdir(), "contra-gmail-")), "d.db"), start: START, emlDir: null, heartbeatMs: 30, inbox: { poller, intervalMs: 60_000 } });
  await new Promise<void>((r) => api.server.listen(0, "127.0.0.1", r));
  const port = (api.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const sse = await sseClient(port);
  try {
    await until(() => sse.text().includes("event: heartbeat"));
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post("/api/action", { action: { command: "ingestPmEmails" } })).status, 200);
    await until(() => sse.text().includes('event: screens-changed\ndata: {"reason":"action"}'));
    await api.pollNow();
    await until(() => sse.text().includes('data: {"reason":"inbox"}'));
    await api.pollNow(); // nothing new: no event
    assert.equal((await post("/api/reset", {})).status, 200);
    await until(() => sse.text().includes('data: {"reason":"reset"}'));
    assert.equal(sse.text().split('{"reason":"inbox"}').length - 1, 1);
    // A refused action changes nothing and emits nothing.
    assert.equal((await post("/api/action", { action: { command: "payBill", billId: "B-NONE" } })).status, 409);
    assert.equal(sse.text().split("screens-changed").length - 1, 3);
  } finally {
    sse.close();
    await api.close();
  }
});

test("memo email: plain text from creditMemo, X-Contra-Generated: memo, to the AP inbox, footer true to INTEGRATION.md", () => {
  const mime = memoMime(CONFIG, { creditId: "VC-1", filename: "VC-1.txt", text: "CREDIT MEMO\nTOTAL CREDIT $11,500.00" }, new Date(now()));
  const [head, body] = mime.split("\r\n\r\n") as [string, string];
  assert.match(head, /^X-Contra-Generated: memo$/m);
  assert.match(head, new RegExp(`^To: ${CONFIG.apInbox.replace(/[+.]/g, "\\$&")}$`, "m"));
  assert.match(head, /^Content-Type: text\/plain; charset=utf-8$/m);
  const text = Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8");
  assert.match(text, /^CREDIT MEMO\nTOTAL CREDIT \$11,500\.00\n\n-- \n/);
  assert.ok(text.includes(memoFooter(CONFIG.apInbox)));
  assert.match(text, /stand-in AP inbox for the demo/);
  assert.match(text, /Ramp has no API for creating vendor credits/);
  assert.match(text, /not yet confirmed in a Ramp sandbox/);
  // Header injection: a line break in a value can't start a new header.
  const evil = memoMime({ address: CONFIG.address, apInbox: CONFIG.apInbox }, { creditId: "VC-1\r\nBcc: x@y.example", filename: "f", text: "t" }, new Date(now()));
  assert.doesNotMatch(evil.split("\r\n\r\n")[0]!, /^Bcc:/m);
});
