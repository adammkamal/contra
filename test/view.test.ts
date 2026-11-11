import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { App } from "../src/app.ts";
import * as cmd from "../src/commands.ts";
import { buildScreens, nextStep, type Action } from "../src/view.ts";

const START = new Date("2026-11-07T15:00:00Z");
const newApp = () => new App(join(mkdtempSync(join(tmpdir(), "contra-")), "d.db"), { start: START });

/** Executes whatever nextStep suggests, exactly as a presenter clicking the highlighted button would. */
function click(app: App, a: Action) {
  switch (a.command) {
    case "ingestPmEmails": return cmd.ingestPmEmails(app, { fixturesDir: null });
    case "confirmLink": return cmd.confirmLink(app, a.ref);
    case "draftNotice": return cmd.draftNotice(app, a.subcontractId);
    case "approveNotice": return cmd.approveNotice(app, a.noticeId);
    case "sendNotice": return cmd.sendNotice(app, a.noticeId);
    case "ingestSubReply": return cmd.ingestSubReply(app, a.noticeId);
    case "advanceDays": return cmd.advanceDays(app, a.days);
    case "evaluateAll": return cmd.evaluateAll(app);
    case "proposeCredit": return cmd.proposeCredit(app, a.subcontractId);
    case "approveCredit": return cmd.approveCredit(app, a.creditId);
    case "billArrives": return cmd.billArrives(app);
    case "turnOnCredits": return cmd.turnOnCredits(app, a.billId);
    case "payBill": return cmd.payBill(app, a.billId);
    default: throw new Error(`unexpected ${a.command}`);
  }
}

test("empty state renders and points at the first step", () => {
  const app = newApp();
  const s = buildScreens(app);
  assert.equal(s.inbox.length, 0);
  assert.equal(s.nextStep.text, "Ingest the PM's back-charge emails");
  assert.deepEqual(s.nextStep.action, { command: "ingestPmEmails" });
  assert.equal(s.extractionSource, null);
  assert.equal(s.opener.notDeducted, "$12,850.00");
  assert.equal(s.opener.sampleData, true);
  app.close();
});

test("following nextStep from start to finish reproduces the demo script exactly", () => {
  const app = newApp();
  const seen: string[] = [];
  for (let i = 0; i < 30; i++) {
    const step = nextStep(app);
    seen.push(step.text);
    if (!step.action) break;
    click(app, step.action);
  }
  assert.deepEqual(seen, [
    "Ingest the PM's back-charge emails",
    "PM confirms the link for BC-4467",
    "PM confirms the link for BC-4468",
    "PM confirms the link for BC-4470",
    "PM confirms the link for BC-4471",
    "Draft the back-charge notice",
    "PM approves the notice",
    "Send the notice",
    "Ridgeline replies",
    "Wait for the response window: advance a week",
    "Check eligibility",
    "Propose the vendor credit",
    "Controller approves credit VC-1",
    "Ridgeline's $48,000 bill arrives",
    "Turn on credits for the bill",
    "Pay the bill (simulated)",
    "Demo complete",
  ]);
  const s = buildScreens(app);
  assert.equal(s.bills[0]!.paid, "$36,500.00");
  assert.equal(s.credits[0]!.amount, "$11,500.00");
  assert.equal(s.credits[0]!.hasMemo, true);
  assert.equal(s.outbox[0]!.total, "$15,500.00");
  assert.deepEqual(s.pmQueue.map((p) => p.ref).sort(), ["BC-4470", "BC-4471"]);
  assert.match(s.pmQueue.find((p) => p.ref === "BC-4470")!.status.label, /dispute noted in the PM's email/);
  assert.match(s.pmQueue.find((p) => p.ref === "BC-4471")!.status.label, /disputed by the sub/);
  assert.ok(s.audit.length > 20);
  assert.ok(s.audit.some((e) => /lee\.chen \(Controller\)/.test(e.actor) && /approved \$11,500\.00/.test(e.what)));
  app.close();
});

test("inbox rows show each amount beside its verbatim sentence and the link explanation", () => {
  const app = newApp();
  cmd.ingestPmEmails(app, { fixturesDir: null });
  const row = buildScreens(app).inbox.find((r) => r.ref === "BC-4467")!;
  assert.equal(row.amount, "$6,800.00");
  assert.match(row.sourceSentence, /\$6,800\.00/);
  assert.ok(row.linkExplanation.some((l) => /alias: "Ridgeline Drywall"/.test(l)));
  assert.deepEqual(row.actions, [{ command: "confirmLink", ref: "BC-4467" }]);
  app.close();
});

test("buttons only appear when the action is legal", () => {
  const app = newApp();
  cmd.ingestPmEmails(app, { fixturesDir: null });
  for (const r of ["BC-4467", "BC-4468", "BC-4470", "BC-4471"]) cmd.confirmLink(app, r);
  const id = cmd.draftNotice(app)!;
  let s = buildScreens(app);
  assert.deepEqual(s.outbox[0]!.actions, [{ command: "approveNotice", noticeId: id }]); // no Send before approval
  cmd.approveNotice(app, id);
  s = buildScreens(app);
  assert.deepEqual(s.outbox[0]!.actions, [{ command: "sendNotice", noticeId: id }]);
  app.close();
});

test("chooseSubcontract never crosses jobs: an item on SUM-01 is never offered SC-LAK-0301", async () => {
  const { demoSeed } = await import("../src/seed.ts");
  const { extractions } = demoSeed(START) as any;
  const app = newApp();
  // An unknown vendor on Summit (no hints from the resolver), and the same vendor with a job no one has.
  const first = extractions["E-1"][0];
  const ex = {
    ...extractions,
    "E-1": [{ ...first, vendorNameAsWritten: "Acme Tile Works" }, { ...extractions["E-1"][1], jobRef: "Nowhere Plaza", vendorNameAsWritten: "Acme Tile Works" }],
  };
  cmd.ingestPmEmails(app, { extractions: ex, extractor: { kind: "system", id: "test" } });
  const pickerFor = (ref: string) => {
    const a = buildScreens(app).inbox.find((r) => r.ref === ref)!.actions.find((x) => x.command === "chooseSubcontract");
    assert.ok(a, `${ref} offers a picker`);
    return (a as Extract<Action, { command: "chooseSubcontract" }>).options;
  };
  const onSummit = pickerFor(first.ref);
  assert.ok(!onSummit.includes("SC-LAK-0301"), `SUM-01 item offered ${onSummit.join(", ")}`);
  assert.deepEqual([...onSummit].sort(), ["SC-SUM-0700", "SC-SUM-0820", "SC-SUM-0912"]);
  // No job resolved: every subcontract, Lakeview included.
  const noJob = pickerFor(extractions["E-1"][1].ref);
  assert.deepEqual([...noJob].sort(), app.ctx.erp.subcontracts.map((s) => s.id).sort());
  await assert.rejects(cmd.runAction(app, { command: "chooseSubcontract", ref: first.ref, options: [...onSummit, "SC-LAK-0301"] }, { choice: "SC-LAK-0301" }));
  app.close();
});
