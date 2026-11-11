import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApiServer, type ApiOptions } from "../server/api.ts";
import { GmailClient, InboxPoller } from "../server/gmail.ts";
import type { MemoSender } from "../src/memo.ts";
import type { Role } from "../src/types.ts";
import type { Screens } from "../src/view.ts";
import { signIn, TEST_PASSWORD, testAuth } from "./auth-fakes.ts";
import { CONFIG, fakeExtract, fakeGmail, rfc822, sseClient, until } from "./gmail-fakes.ts";

// Who may reach which workspace, and who is recorded for each step, over HTTP. Made-up names, addresses
// and mail only; Gmail, the model and the memo sender are fakes.

const START = new Date("2026-11-07T15:00:00Z");
const NOW = Date.UTC(2026, 10, 10, 16, 0, 0);
const tmpDb = (name: string) => join(mkdtempSync(join(tmpdir(), "contra-access-")), name);
const JSON_HEADERS = { "content-type": "application/json" };

async function server(extra: Partial<ApiOptions> = {}, live = true) {
  const sent: string[] = [];
  const memoSender: MemoSender = { destination: CONFIG.apInbox, send: async (m) => (sent.push(m.creditId), { messageId: `m-${sent.length}` }) };
  const g = fakeGmail({
    messages: [{ id: "a01", raw: rfc822({ messageId: "a01@pm.example", deliveredTo: CONFIG.intake, subject: "Back-charge a01", body: "Hi,\r\n\r\nBC-7501: patch the stair core drywall, Summit, $900.00.\r\n\r\nDana" }) }],
  });
  const poller = new InboxPoller({ client: new GmailClient(CONFIG, g.transport, () => NOW), extract: fakeExtract("Ridgeline Drywall", "Summit").extract, now: () => NOW });
  const auth = testAuth();
  const api = createApiServer({
    auth,
    dbPath: tmpDb("demo.db"),
    start: START,
    emlDir: null,
    memoSender,
    ...(live ? { liveDbPath: tmpDb("live.db"), realClock: { now: () => new Date(NOW) }, inbox: { poller, intervalMs: 60_000 } } : {}),
    ...extra,
  });
  await new Promise<void>((r) => api.server.listen(0, "127.0.0.1", r));
  const port = (api.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const as = (username: string, role: Role, isLive: boolean) => signIn(base, auth, { username, role, live: isLive });
  const get = (cookie: string, path: string) => fetch(`${base}${path}`, { headers: { cookie } });
  const post = (cookie: string, path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { ...JSON_HEADERS, cookie }, body: JSON.stringify(body) });
  const screens = async (cookie: string, ws = "demo") => (await (await get(cookie, `/api/screens?workspace=${ws}`)).json()) as Screens;
  return { api, port, base, as, get, post, screens, sent };
}

test("workspaces: an account without --live gets 403 on every ?workspace=live route; /api/me and /api/health list only the demo, with no inbox", async () => {
  for (const hasLive of [true, false]) {
    const s = await server({}, hasLive);
    try {
      const demoOnly = await s.as("dee.demo", "controller", false);
      for (const [method, path] of [
        ["GET", "/api/screens?workspace=live"],
        ["GET", "/api/backcharge/BC-7501?workspace=live"],
        ["GET", "/api/credit/VC-1/memo?workspace=live"],
        ["POST", "/api/action?workspace=live"],
        ["POST", "/api/reset?workspace=live"],
      ] as const) {
        const r = method === "GET" ? await s.get(demoOnly, path) : await s.post(demoOnly, path, path.includes("action") ? { action: { command: "advanceDays", days: 7 } } : {});
        assert.equal(r.status, 403, `${method} ${path} (server ${hasLive ? "with" : "without"} a live workspace)`);
        assert.deepEqual(await r.json(), { ok: false, error: "the live workspace is only for accounts created with --live" });
      }
      // The demo is open to them.
      assert.equal((await s.get(demoOnly, "/api/screens")).status, 200);
      const me = (await (await s.get(demoOnly, "/api/me")).json()) as any;
      assert.deepEqual([me.user, me.workspaces], [{ username: "dee.demo", role: "controller", live: false }, ["demo"]]);
      assert.deepEqual(await (await s.get(demoOnly, "/api/health")).json(), { ok: true, workspaces: ["demo"], inbox: null });
      if (hasLive) {
        const liveUser = await s.as("lou.live", "pm", true);
        assert.equal((await s.get(liveUser, "/api/screens?workspace=live")).status, 200);
        const h = (await (await s.get(liveUser, "/api/health")).json()) as any;
        assert.deepEqual(h.workspaces, ["demo", "live"]);
        assert.equal(h.inbox.address, CONFIG.intake);
      }
    } finally {
      await s.api.close();
    }
  }
});

test("workspaces: the live workspace's live updates (SSE) reach only --live accounts; demo updates reach everyone", async () => {
  const s = await server();
  try {
    const demoOnly = await s.as("dee.demo", "pm", false);
    const liveUser = await s.as("lou.live", "pm", true);
    const a = await sseClient(s.port, { cookie: demoOnly });
    const b = await sseClient(s.port, { cookie: liveUser });
    try {
      assert.equal((await s.post(liveUser, "/api/reset?workspace=live", {})).status, 200);
      assert.equal((await s.post(liveUser, "/api/reset", {})).status, 200);
      await until(() => b.text().includes('"workspace":"demo"') && a.text().includes('"workspace":"demo"'));
      assert.match(b.text(), /"reason":"reset","workspace":"live"/);
      assert.ok(!a.text().includes('"workspace":"live"'), a.text());
    } finally {
      a.close();
      b.close();
    }
  } finally {
    await s.api.close();
  }
});

test("demo: any signed-in account presents the whole script; steps keep the scripted actors, 'presented by' the account; a real memo email needs --live", async () => {
  const s = await server();
  try {
    const presenter = await s.as("pia.present", "ap", false); // not live, and AP: still presents the PM's and controller's steps
    for (let i = 0; i < 40; i++) {
      const a = (await s.screens(presenter)).nextStep.action;
      if (!a) break;
      const r = await s.post(presenter, "/api/action", { action: a });
      assert.equal(r.status, 200, `${a.command}: ${await r.clone().text()}`);
    }
    const sc = await s.screens(presenter);
    assert.equal(sc.nextStep.text, "Demo complete");
    assert.deepEqual([sc.outbox[0]!.total, sc.credits[0]!.amount, sc.bills[0]!.paid], ["$15,500.00", "$11,500.00", "$36,500.00"]);
    const actors = new Set(sc.audit.map((e) => e.actor));
    for (const who of ["dana.ortiz (PM), presented by pia.present", "lee.chen (Controller), presented by pia.present", "sam.ap (AP), presented by pia.present"]) assert.ok(actors.has(who), who);

    // The memo button is on screen, but sending it emails the AP inbox for real: only a --live account can.
    const send = sc.credits[0]!.actions.find((x) => x.command === "sendCreditMemo")!;
    const refused = await s.post(presenter, "/api/action", { action: send });
    assert.equal(refused.status, 403);
    assert.match(((await refused.json()) as any).error, /only accounts created with --live can/);
    assert.deepEqual(s.sent, []);
    const liveUser = await s.as("lou.live", "ap", true);
    assert.equal((await s.post(liveUser, "/api/action", { action: send })).status, 200);
    assert.deepEqual(s.sent, ["VC-1"]);
    assert.ok((await s.screens(liveUser)).audit.some((e) => e.actor === "sam.ap (AP), presented by lou.live" && /memo queued/.test(e.what)));
  } finally {
    await s.api.close();
  }
});

test("live: refusals are 409 with the reason in words: a PM can't approve a credit, nor can the controller who linked it; the audit records the real person and role", async () => {
  const s = await server();
  try {
    await s.api.pollNow();
    const pm = await s.as("pat.pm", "pm", true);
    const ctl = await s.as("cy.ctl", "controller", true);
    const ctl2 = await s.as("di.ctl", "controller", true);
    const ap = await s.as("al.ap", "ap", true);
    const step = async () => (await s.screens(pm, "live")).nextStep.action!;
    const act = async (cookie: string, action: unknown) => s.post(cookie, "/api/action?workspace=live", { action });
    const ok = async (cookie: string, action: unknown) => assert.equal((await act(cookie, action)).status, 200, JSON.stringify(action));

    const link = await step();
    assert.equal(link.command, "confirmLink");
    await ok(ctl, link); // a controller links BC-7501
    await ok(pm, await step()); // draft
    const approveNotice = await step();
    const noticeRefused = await act(ctl, approveNotice);
    assert.equal(noticeRefused.status, 409);
    assert.match(((await noticeRefused.json()) as any).error, /approving notice N-1 needs the PM role; cy\.ctl is a Controller/);
    await ok(pm, approveNotice);
    await ok(pm, await step()); // send
    await ok(pm, await step()); // advance a week
    await ok(pm, await step()); // check eligibility
    await ok(pm, await step()); // propose
    const approve = await step();
    assert.equal(approve.command, "approveCredit");
    const byPm = await act(pm, approve);
    assert.equal(byPm.status, 409);
    assert.deepEqual(await byPm.json(), { ok: false, error: "approving credit VC-1 needs the Controller role; pat.pm is a PM" });
    const byLinker = await act(ctl, approve);
    assert.equal(byLinker.status, 409);
    assert.deepEqual(await byLinker.json(), { ok: false, error: "separation of duties: cy.ctl linked BC-7501, so cy.ctl can't approve credit VC-1; another controller must" });
    assert.equal((await s.screens(pm, "live")).credits[0]!.status.label, "Proposed, needs controller approval");
    await ok(ctl2, approve);
    // Turning credits on needs AP; nothing else here does.
    const audit = (await s.screens(ap, "live")).audit;
    const who = (pred: RegExp) => audit.find((e) => pred.test(e.what))?.actor;
    assert.equal(who(/^backcharge BC-7501: link confirmed/), "cy.ctl (Controller)");
    assert.equal(who(/^notice N-1: notice approved/), "pat.pm (PM)");
    assert.equal(who(/^credit VC-1: approved \$900\.00/), "di.ctl (Controller)");
    assert.ok(!audit.some((e) => /presented by/.test(e.actor)), "live steps are never 'presented'");
    // The sender's address is no account's email here, so nobody is recorded as the raiser.
    assert.ok(!audit.some((e) => /raised by/.test(e.what)));
  } finally {
    await s.api.close();
  }
});

test("raised by: live mail from an account's email records that person as its raiser, so they can't approve a credit for it", async () => {
  const s = await server();
  try {
    // The fake mail comes from Dana Ortiz <dana.ortiz@apexbuilders.example>; Cy's account has that email (any case).
    await s.api.authStore.addUser("cy.ctl", "controller", TEST_PASSWORD, { live: true, email: "Dana.Ortiz@ApexBuilders.EXAMPLE" });
    await s.api.pollNow();
    const pm = await s.as("pat.pm", "pm", true);
    const cy = await s.as("cy.ctl", "controller", true);
    const di = await s.as("di.ctl", "controller", true);
    const raised = (await s.screens(pm, "live")).audit.find((e) => /^backcharge BC-7501: raised by/.test(e.what))!;
    assert.equal(raised.what, "backcharge BC-7501: raised by cy.ctl (Controller): the email came from their address");
    assert.equal(raised.actor, "cy.ctl (Controller)");
    assert.deepEqual(raised.evidence, ["From: Dana Ortiz <dana.ortiz@apexbuilders.example>"]);
    // Pat (PM) links and runs the notice; Cy never touches the item in the app.
    for (let i = 0; i < 8; i++) {
      const a = (await s.screens(pm, "live")).nextStep.action!;
      if (a.command === "approveCredit") break;
      assert.equal((await s.post(pm, "/api/action?workspace=live", { action: a })).status, 200, a.command);
    }
    const approve = (await s.screens(pm, "live")).nextStep.action!;
    assert.equal(approve.command, "approveCredit");
    const refused = await s.post(cy, "/api/action?workspace=live", { action: approve });
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { ok: false, error: "separation of duties: cy.ctl raised BC-7501, so cy.ctl can't approve credit VC-1; another controller must" });
    assert.equal((await s.post(di, "/api/action?workspace=live", { action: approve })).status, 200);
  } finally {
    await s.api.close();
  }
});
