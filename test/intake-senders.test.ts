import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  allowedSendersFromEnv,
  dailyCapReached,
  fromAddress,
  GmailClient,
  gmailConfigFromEnv,
  InboxPoller,
  liveDailyCapFromEnv,
  NO_ALLOWED_SENDERS,
  NOT_AUTHENTICATED,
  senderAuthenticated,
} from "../server/gmail.ts";
import { App } from "../src/app.ts";
import { CONFIG, fakeExtract, fakeGmail, gmailAuthPass, rfc822, type FakeMessage } from "./gmail-fakes.ts";

// Live intake spend and sender control. Every address and message here is made up; no network.

const START = new Date("2026-11-07T15:00:00Z");
const freshApp = () => new App(join(mkdtempSync(join(tmpdir(), "contra-senders-")), "d.db"), { start: START, workspace: "live", realClock: { now: () => new Date("2026-11-10T16:00:00Z") } });
const at = (iso: string) => () => Date.parse(iso);

const msg = (id: string, o: { from?: string; authResults?: string[] } = {}): FakeMessage => ({
  id,
  raw: rfc822({ messageId: `${id}@pm.example`, deliveredTo: CONFIG.intake, subject: `Back-charge ${id}`, body: `Hi,\r\n\r\nBC-73${id.slice(-2)}: patch the stair wall, Summit, $700.00.\r\n\r\nDana`, ...o }),
});

/** Runs one poll with `config`; returns what was downloaded, extracted, ingested and why each was skipped. */
async function pollOnce(messages: FakeMessage[], config = CONFIG) {
  const g = fakeGmail({ messages });
  const x = fakeExtract();
  const now = at("2026-11-10T16:00:00Z");
  const poller = new InboxPoller({ client: new GmailClient(config, g.transport, now), extract: x.extract, now });
  const app = freshApp();
  try {
    const r = await poller.poll(app);
    const plan = await poller.plan((k) => app.ctx.contra.hasMessage(k));
    return { ingested: r.ingested, modelCalls: x.calls(), downloaded: g.rawFetched(), skips: plan.map((m) => [m.gmailId, m.skip]), refs: [...app.ctx.contra.backCharges.keys()] };
  } finally {
    app.close();
  }
}

test("allow-list: empty means nothing is ingested ('no allowed senders configured'): nothing downloaded, no model call", async () => {
  const r = await pollOnce([msg("s01"), msg("s02")], { ...CONFIG, allowedSenders: [] });
  assert.equal(r.modelCalls, 0);
  assert.deepEqual(r.downloaded, []);
  assert.deepEqual(r.refs, []);
  assert.deepEqual(r.skips, [["s01", NO_ALLOWED_SENDERS], ["s02", NO_ALLOWED_SENDERS]]);
  assert.equal(NO_ALLOWED_SENDERS, "no allowed senders configured");
  // Unset in the environment means empty, never "everyone".
  const env = { CONTRA_GMAIL_ADDRESS: "a@b.example", CONTRA_GMAIL_CLIENT_ID: "i", CONTRA_GMAIL_CLIENT_SECRET: "s", CONTRA_GMAIL_REFRESH_TOKEN: "r" };
  const c = gmailConfigFromEnv(env);
  assert.ok(c.ok);
  assert.deepEqual(c.config.allowedSenders, []);
});

test("a disallowed sender is skipped with its reason: nothing downloaded, no model call; allowed ones still ingest", async () => {
  const messages = [
    msg("s11", { from: "Pat Lee <pat@otherfirm.example>", authResults: [gmailAuthPass("otherfirm.example", "pat")] }),
    msg("s12", { from: "Evil <dana@evil-apexbuilders.example>", authResults: [gmailAuthPass("evil-apexbuilders.example", "dana")] }),
    msg("s13", { from: "Sub <dana@sub.apexbuilders.example>", authResults: [gmailAuthPass("sub.apexbuilders.example", "dana")] }),
    msg("s14", { from: "Two <a@apexbuilders.example>, b@apexbuilders.example" }),
    msg("s15"),
  ];
  const r = await pollOnce(messages);
  assert.equal(r.modelCalls, 1);
  assert.deepEqual(r.downloaded, ["s15"]);
  assert.deepEqual(r.refs, ["BC-7315"]);
  assert.deepEqual(r.skips, [
    ["s11", "sender not allowed (pat@otherfirm.example is not on CONTRA_INTAKE_ALLOWED_SENDERS)"],
    ["s12", "sender not allowed (dana@evil-apexbuilders.example is not on CONTRA_INTAKE_ALLOWED_SENDERS)"],
    ["s13", "sender not allowed (dana@sub.apexbuilders.example is not on CONTRA_INTAKE_ALLOWED_SENDERS)"],
    ["s14", "sender not allowed (no single From address)"],
    ["s15", "already ingested"],
  ]);
  // A whole address on the list admits that address only.
  const one = await pollOnce([msg("s16"), msg("s17", { from: "Kim <kim@apexbuilders.example>", authResults: [gmailAuthPass("apexbuilders.example", "kim")] })], { ...CONFIG, allowedSenders: ["kim@apexbuilders.example"] });
  assert.deepEqual(one.refs, ["BC-7317"]);
  assert.equal(one.modelCalls, 1);
});

test("spoofed From: an allowed From that Gmail didn't authenticate for that domain is skipped ('sender not authenticated'), no model call", async () => {
  const fail = "mx.google.com; dkim=fail header.i=@apexbuilders.example header.s=s1; spf=softfail (google.com: domain of transitioning dana.ortiz@apexbuilders.example does not designate 198.51.100.7 as permitted sender) smtp.mailfrom=dana.ortiz@apexbuilders.example; dmarc=fail (p=NONE) header.from=apexbuilders.example";
  const messages = [
    // Gmail's own header says the mail failed DKIM and SPF.
    msg("s21", { authResults: [fail] }),
    // Passes, but for the attacker's domain, not the From domain.
    msg("s22", { authResults: [gmailAuthPass("attacker.example", "x")] }),
    // Gmail's header fails; the sender wrote a passing one lower in the message. Only the first counts.
    msg("s23", { authResults: [fail, gmailAuthPass("apexbuilders.example")] }),
    // A passing header that isn't Gmail's own.
    msg("s24", { authResults: [gmailAuthPass("apexbuilders.example").replace("mx.google.com", "mx.attacker.example")] }),
    // No Authentication-Results at all.
    msg("s25", { authResults: [] }),
  ];
  const r = await pollOnce(messages);
  assert.equal(r.modelCalls, 0);
  assert.deepEqual(r.downloaded, []);
  assert.deepEqual(r.refs, []);
  assert.deepEqual(r.skips, messages.map((m) => [m.id, NOT_AUTHENTICATED]));
  assert.equal(NOT_AUTHENTICATED, "sender not authenticated");
});

test("senderAuthenticated and fromAddress: DKIM or SPF pass for exactly the From domain, in Gmail's first header", () => {
  const d = "apexbuilders.example";
  assert.equal(senderAuthenticated([gmailAuthPass(d)], d), true);
  assert.equal(senderAuthenticated([`mx.google.com; dkim=pass header.d=${d} header.s=s1; spf=fail smtp.mailfrom=x@bounce.example`], d), true); // DKIM alone
  assert.equal(senderAuthenticated([`mx.google.com; dkim=none; spf=pass (google.com: ok) smtp.mailfrom=bounce@${d}`], d), true); // SPF alone
  assert.equal(senderAuthenticated([`mx.google.com; dkim=pass header.d=mail.${d}`], d), false); // subdomain: not the From domain
  assert.equal(senderAuthenticated([`mx.google.com; dkim=pass header.d=evil-${d}`], d), false);
  assert.equal(senderAuthenticated([`mx.google.com; dmarc=pass header.from=${d}`], d), false); // only DKIM or SPF count
  assert.equal(senderAuthenticated([], d), false);
  assert.equal(fromAddress(["Dana Ortiz <Dana.Ortiz@ApexBuilders.example>"]), "dana.ortiz@apexbuilders.example");
  assert.equal(fromAddress(['"Ortiz, Dana <boss@apexbuilders.example>" <dana@evil.example>']), "dana@evil.example");
  assert.equal(fromAddress(["a@x.example", "b@x.example"]), null); // two From headers
  assert.equal(fromAddress(["a@x.example, b@x.example"]), null);
  assert.equal(fromAddress([]), null);
  assert.deepEqual(allowedSendersFromEnv({ CONTRA_INTAKE_ALLOWED_SENDERS: " PM@Builder.example , @Sub.example ,," }), ["pm@builder.example", "@sub.example"]);
  for (const bad of ["builder.example", "@", "pm@", "a b@x.example"]) assert.throws(() => allowedSendersFromEnv({ CONTRA_INTAKE_ALLOWED_SENDERS: bad }), /CONTRA_INTAKE_ALLOWED_SENDERS/, bad);
});

test("daily cap: when reached, extraction stops with no model call, health says so, and the mail is extracted after midnight UTC", async () => {
  const g = fakeGmail({ messages: [msg("c03"), msg("c02"), msg("c01")] }); // newest first, as Gmail lists them
  const x = fakeExtract();
  let t = Date.parse("2026-11-10T23:58:00Z");
  const now = () => t;
  const poller = new InboxPoller({ client: new GmailClient(CONFIG, g.transport, now), extract: x.extract, now, dailyCap: 2 });
  const app = freshApp();
  try {
    assert.deepEqual(await poller.poll(app), { ingested: 2 });
    assert.equal(x.calls(), 2);
    assert.deepEqual(g.rawFetched(), ["c01", "c02"]); // oldest first; c03 not even downloaded
    let s = poller.status();
    assert.equal(s.status, dailyCapReached(2));
    assert.deepEqual(s.modelCalls, { today: 2, cap: 2, capReached: true, resetsAt: "2026-11-11T00:00:00.000Z" });

    // Same day: still capped, still no call, and c03 is not marked skipped.
    assert.deepEqual(await poller.poll(app), { ingested: 0 });
    assert.equal(x.calls(), 2);
    const plan = await poller.plan((k) => app.ctx.contra.hasMessage(k));
    assert.deepEqual(plan.find((m) => m.gmailId === "c03")!.skip, null);

    // After midnight UTC the count starts again and c03 is extracted.
    t = Date.parse("2026-11-11T00:00:30Z");
    assert.equal(poller.status().modelCalls!.today, 0);
    assert.deepEqual(await poller.poll(app), { ingested: 1 });
    assert.equal(x.calls(), 3);
    s = poller.status();
    assert.equal(s.status, "ok");
    assert.deepEqual(s.modelCalls, { today: 1, cap: 2, capReached: false, resetsAt: "2026-11-12T00:00:00.000Z" });
    assert.deepEqual([...app.ctx.contra.backCharges.keys()], ["BC-7301", "BC-7302", "BC-7303"]);
  } finally {
    app.close();
  }
});

test("daily cap: failed extractions count too (each retry is a model call)", async () => {
  const g = fakeGmail({ messages: [msg("f01")] });
  let calls = 0;
  const extract = async () => (calls++, { ok: false as const, reason: "model unavailable" });
  const now = at("2026-11-10T12:00:00Z");
  const poller = new InboxPoller({ client: new GmailClient(CONFIG, g.transport, now), extract, now, dailyCap: 2 });
  const app = freshApp();
  try {
    await poller.poll(app);
    await poller.poll(app);
    await poller.poll(app); // capped: no third call
    assert.equal(calls, 2);
    assert.deepEqual(poller.status().modelCalls, { today: 2, cap: 2, capReached: true, resetsAt: "2026-11-11T00:00:00.000Z" });
    assert.equal(poller.status().status, dailyCapReached(2));
  } finally {
    app.close();
  }
  assert.equal(liveDailyCapFromEnv({}), 50);
  assert.equal(liveDailyCapFromEnv({ CONTRA_LIVE_DAILY_CAP: "7" }), 7);
  for (const bad of ["0", "-1", "2.5", "lots"]) assert.throws(() => liveDailyCapFromEnv({ CONTRA_LIVE_DAILY_CAP: bad }), /CONTRA_LIVE_DAILY_CAP/, bad);
});
