import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApiServer } from "../server/api.ts";
import { GmailClient, InboxPoller } from "../server/gmail.ts";
import { App } from "../src/app.ts";
import { advanceDays } from "../src/commands.ts";
import type { Screens } from "../src/view.ts";
import { CONFIG, fakeExtract, fakeGmail, rfc822 } from "./gmail-fakes.ts";
import { sessionFetch, signIn, testAuth } from "./auth-fakes.ts";

const http = sessionFetch();

// The live workspace's clock is the real clock (injected here) plus an offset that only "advance a
// week" changes. The demo keeps its simulated clock. Every email here is made up; no network.

const START = new Date("2026-11-07T15:00:00Z");
const DAY = 86_400_000;
const tmpDb = (name: string) => join(mkdtempSync(join(tmpdir(), "contra-clock-")), name);
const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/** A real clock the test moves by hand. */
function realClock(iso: string) {
  let t = Date.parse(iso);
  return { clock: { now: () => new Date(t) }, set: (s: string) => (t = Date.parse(s)), ms: () => t };
}

const ridgeline = (id: string, internalDate?: number) => ({
  id,
  raw: rfc822({ messageId: `${id}@pm.example`, deliveredTo: CONFIG.intake, subject: `Back-charge ${id}`, body: "Hi,\r\n\r\nBC-7401: patch the stair core drywall, Summit, $900.00.\r\n\r\nDana" }),
  ...(internalDate === undefined ? {} : { internalDate }),
});

test("live mail gets the time Gmail received it (internalDate), and is logged at the real time, not the database's creation time", async () => {
  const real = realClock("2026-11-10T09:00:00Z");
  const app = new App(tmpDb("live.db"), { workspace: "live", realClock: real.clock }); // created at 09:00
  const received = Date.parse("2026-11-10T16:12:07Z"); // the Date header says 15:00; Gmail got it at 16:12:07
  const g = fakeGmail({ messages: [ridgeline("t01", received)] });
  const pollNow = () => real.ms();
  const poller = new InboxPoller({ client: new GmailClient(CONFIG, g.transport, pollNow), extract: fakeExtract("Ridgeline Drywall", "Summit").extract, now: pollNow });
  try {
    real.set("2026-11-10T16:20:00Z");
    assert.deepEqual(await poller.poll(app), { ingested: 1 });
    const email = app.ctx.contra.emails.get("gmail-t01")!;
    assert.equal(email.receivedAt.toISOString(), "2026-11-10T16:12:07.000Z");
    const ev = app.ctx.contra.audit.all().find((e) => e.entity === "email" && e.entityId === "gmail-t01")!;
    assert.ok(ev.evidence.includes("received 2026-11-10T16:12:07.000Z"), ev.evidence.join(" | "));
    assert.equal(ev.at.toISOString(), "2026-11-10T16:20:00.000Z"); // ingested now, not at 09:00
    assert.equal(app.ctx.clock.now().toISOString(), "2026-11-10T16:20:00.000Z");
  } finally {
    app.close();
  }
});

test("advance a week moves the live workspace 7 days ahead of real time and leaves the demo untouched", async () => {
  const real = realClock("2026-11-10T16:00:00Z");
  const g = fakeGmail({ messages: [ridgeline("t11")] });
  const poller = new InboxPoller({ client: new GmailClient(CONFIG, g.transport, real.ms), extract: fakeExtract("Ridgeline Drywall", "Summit").extract, now: real.ms });
  const api = createApiServer({ auth: testAuth(), dbPath: tmpDb("demo.db"), liveDbPath: tmpDb("live.db"), realClock: real.clock, start: START, emlDir: null, inbox: { poller, intervalMs: 60_000 } });
  await new Promise<void>((r) => api.server.listen(0, "127.0.0.1", r));
  http.use(await signIn(`http://127.0.0.1:${(api.server.address() as AddressInfo).port}`, api.authStore));
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  const screens = async (ws: string) => (await (await http.fetch(`${base}/api/screens?workspace=${ws}`)).json()) as Screens;
  const act = async (ws: string, action: unknown) =>
    assert.equal((await http.fetch(`${base}/api/action?workspace=${ws}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) })).status, 200);
  try {
    // The demo's own simulated clock moves a week too, so this checks it isn't shared.
    for (let i = 0; i < 40; i++) {
      const a = (await screens("demo")).nextStep.action!;
      await act("demo", a);
      if (a.command === "advanceDays") break;
    }
    const demoBefore = JSON.stringify(await screens("demo"));
    assert.equal((await screens("demo")).now, when(START.getTime() + 7 * DAY));

    await api.pollNow();
    for (let i = 0; i < 10; i++) {
      const a = (await screens("live")).nextStep.action!;
      if (a.command === "advanceDays") break;
      await act("live", a);
    }
    assert.equal((await screens("live")).now, "2026-11-10 16:00 UTC");
    await act("live", { command: "advanceDays", days: 7 });
    assert.equal((await screens("live")).now, "2026-11-17 16:00 UTC");
    // Real time keeps running underneath the offset.
    real.set("2026-11-10T18:30:00Z");
    assert.equal((await screens("live")).now, "2026-11-17 18:30 UTC");
    // The demo didn't move with either.
    assert.equal(JSON.stringify(await screens("demo")), demoBefore);
  } finally {
    await api.close();
  }
});

test("the live offset is stored in data/live.db and survives reopening; the demo's simulated clock is unchanged", () => {
  const real = realClock("2026-11-10T16:00:00Z");
  const livePath = tmpDb("live.db");
  let live = new App(livePath, { workspace: "live", realClock: real.clock });
  assert.equal(live.ctx.clock.now().toISOString(), "2026-11-10T16:00:00.000Z"); // offset starts at 0
  advanceDays(live, 7);
  live.close();
  real.set("2026-11-12T08:00:00Z"); // restarted two days later
  live = new App(livePath, { workspace: "live", realClock: real.clock });
  assert.equal(live.ctx.clock.now().toISOString(), "2026-11-19T08:00:00.000Z");
  advanceDays(live, 7);
  live.close();
  live = new App(livePath, { workspace: "live", realClock: real.clock });
  assert.equal(live.ctx.clock.now().toISOString(), "2026-11-26T08:00:00.000Z");
  live.close();
  assert.throws(() => new App(tmpDb("live.db"), { workspace: "live" }), /needs the real clock/);

  // Demo: simulated, from `start`, saved and resumed as before; a real clock passed in is ignored.
  const demoPath = tmpDb("demo.db");
  let demo = new App(demoPath, { start: START, realClock: real.clock });
  advanceDays(demo, 7);
  demo.close();
  demo = new App(demoPath);
  assert.equal(demo.ctx.clock.now().toISOString(), "2026-11-14T15:00:00.000Z");
  demo.close();
});
