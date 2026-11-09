import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApiServer, parseAction } from "../server/api.ts";
import type { Screens } from "../src/view.ts";

const START = new Date("2026-11-07T15:00:00Z");

async function withApi(fn: (base: string) => Promise<void>) {
  const api = createApiServer({ dbPath: join(mkdtempSync(join(tmpdir(), "contra-")), "d.db"), start: START });
  await new Promise<void>((r) => api.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  try {
    await fn(base);
  } finally {
    await api.close();
  }
}
const getJson = async (url: string) => {
  const r = await fetch(url);
  return { status: r.status, body: (await r.json()) as any };
};
const post = async (url: string, body: unknown) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};

test("API: a frontend following nextStep over HTTP reproduces the demo and ends at $36,500.00", async () => {
  await withApi(async (base) => {
    let screens = (await getJson(`${base}/api/screens`)).body as Screens;
    const steps: string[] = [];
    while (screens.nextStep.action) {
      steps.push(screens.nextStep.text);
      const r = await post(`${base}/api/action`, { action: screens.nextStep.action });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      screens = r.body.screens;
      assert.ok(steps.length < 30);
    }
    assert.equal(steps[0], "Ingest the PM's back-charge emails");
    assert.equal(screens.nextStep.text, "Demo complete");
    assert.equal(screens.bills[0]!.paid, "$36,500.00");
    assert.equal(screens.credits[0]!.amount, "$11,500.00");

    const memo = await getJson(`${base}/api/credit/VC-1/memo`);
    assert.equal(memo.status, 200);
    assert.match(memo.body.text, /TOTAL CREDIT\s+\$11,500\.00/);
    const detail = await getJson(`${base}/api/backcharge/BC-4471`);
    assert.equal(detail.status, 200);
    assert.match(detail.body.status.label, /disputed by the sub/);
    assert.equal(detail.body.clause.responseWindow, "5 working days");
  });
});

test("API: bad input is rejected with 400, unknown things with 404, illegal moves with 409", async () => {
  await withApi(async (base) => {
    assert.equal((await post(`${base}/api/action`, { action: { command: "approveCredit" } })).status, 400); // missing creditId
    assert.equal((await post(`${base}/api/action`, { action: { command: "deleteEverything" } })).status, 400);
    assert.equal((await post(`${base}/api/action`, { action: { command: "evaluateAll", extra: 1 } })).status, 400);
    const r = await fetch(`${base}/api/action`, { method: "POST", body: "{not json" });
    assert.equal(r.status, 400);
    assert.equal((await getJson(`${base}/api/backcharge/BC-0000`)).status, 404);
    assert.equal((await getJson(`${base}/api/credit/VC-9/memo`)).status, 404);
    assert.equal((await getJson(`${base}/api/nope`)).status, 404);
    // Sending a notice that was never approved: the state machine refuses -> 409, and nothing changes.
    await post(`${base}/api/action`, { action: { command: "ingestPmEmails" } });
    for (const ref of ["BC-4467", "BC-4468", "BC-4470", "BC-4471"]) await post(`${base}/api/action`, { action: { command: "confirmLink", ref } });
    await post(`${base}/api/action`, { action: { command: "draftNotice", subcontractId: "SC-SUM-0912" } });
    const illegal = await post(`${base}/api/action`, { action: { command: "sendNotice", noticeId: "N-1" } });
    assert.equal(illegal.status, 409);
    assert.match(illegal.body.error, /not available right now/);
    const s = (await getJson(`${base}/api/screens`)).body as Screens;
    assert.equal(s.outbox[0]!.status.label, "Draft, needs controller approval");
  });
});

test("API: two-part actions need their input; reset starts clean; CORS preflight works", async () => {
  await withApi(async (base) => {
    await post(`${base}/api/action`, { action: { command: "ingestPmEmails" } });
    // A forged action (a picker the screen never offered, listing Ridgeline Glass) must be refused.
    const forged = await post(`${base}/api/action`, { action: { command: "chooseSubcontract", ref: "BC-4467", options: ["SC-SUM-0820"] }, input: { choice: "SC-SUM-0820" } });
    assert.equal(forged.status, 409);
    assert.match(forged.body.error, /not available right now/);
    // Double-click: the same confirm sent twice; the second is refused, state is unchanged.
    assert.equal((await post(`${base}/api/action`, { action: { command: "confirmLink", ref: "BC-4468" } })).status, 200);
    assert.equal((await post(`${base}/api/action`, { action: { command: "confirmLink", ref: "BC-4468" } })).status, 409);
    const after = (await getJson(`${base}/api/backcharge/BC-4467`)).body;
    assert.equal(after.link.subcontractId, null);
    const reject = await post(`${base}/api/action`, { action: { command: "rejectCredit", creditId: "VC-1" }, input: {} });
    assert.equal(reject.status, 409);
    const reset = await post(`${base}/api/reset`, {});
    assert.equal(reset.status, 200);
    assert.equal(reset.body.screens.inbox.length, 0);
    const pre = await fetch(`${base}/api/action`, { method: "OPTIONS" });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "*");
    const big = await fetch(`${base}/api/action`, { method: "POST", body: "x".repeat(70_000) }).catch(() => null);
    assert.ok(big === null || big.status === 413);
  });
});

test("parseAction accepts exactly the Action shapes from src/view.ts", () => {
  assert.deepEqual(parseAction({ command: "advanceDays", days: 7 }), { command: "advanceDays", days: 7 });
  assert.equal(parseAction({ command: "advanceDays", days: 7.5 }), null);
  assert.equal(parseAction({ command: "advanceDays", days: 9999 }), null);
  assert.equal(parseAction({ command: "confirmLink", ref: "" }), null);
  assert.equal(parseAction({ command: "__proto__" }), null);
  assert.equal(parseAction(null), null);
});

test("runAction: an offered picker still refuses a choice outside its options", async () => {
  const { App } = await import("../src/app.ts");
  const cmd = await import("../src/commands.ts");
  const { buildScreens } = await import("../src/view.ts");
  const { extractions } = (await import("../src/seed.ts")).demoSeed(START) as any;
  const app = new App(join(mkdtempSync(join(tmpdir(), "contra-")), "d.db"), { start: START });
  const ex = { ...extractions, "E-1": [{ ...extractions["E-1"][0], vendorNameAsWritten: "Ridgeline" }, extractions["E-1"][1]] };
  cmd.ingestPmEmails(app, { extractions: ex, extractor: { kind: "system", id: "test" } });
  const picker = buildScreens(app).inbox.find((r) => r.ref === "BC-4467")!.actions[0]!;
  assert.equal(picker.command, "chooseSubcontract");
  const options = (picker as any).options as string[];
  assert.ok(options.includes("SC-SUM-0912") && options.includes("SC-SUM-0820"));
  assert.throws(() => cmd.runAction(app, picker, { choice: "SC-SUM-0700" }), /choose one of/); // Harbor: real, not offered
  cmd.runAction(app, picker, { choice: "SC-SUM-0912" });
  assert.equal(app.ctx.contra.backCharges.get("BC-4467")!.subcontractId, "SC-SUM-0912");
  app.close();
});
