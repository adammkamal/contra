import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { App } from "../src/app.ts";
import * as cmd from "../src/commands.ts";
import { cents, formatUsd } from "../src/money.ts";
import { NotPermitted } from "../src/roles.ts";
import { IllegalTransition, transitionNotice } from "../src/state.ts";
import type { Human, Role } from "../src/types.ts";
import { buildScreens, nextStep } from "../src/view.ts";
import { AP, CONTROLLER, LLM, PM, setup, throughNotice } from "./helpers.ts";

// Roles and separation of duties (src/roles.ts). Every name here is made up.

const START = new Date("2026-11-07T15:00:00Z");
const tmpDb = (name: string) => join(mkdtempSync(join(tmpdir(), "contra-roles-")), name);
const person = (id: string, role: Role): Human => ({ kind: "human", id, role });

/** Steps 1-4 of the demo in the core, up to a proposed credit for BC-4467 and BC-4468. */
function throughProposal() {
  const ctx = setup();
  throughNotice(ctx);
  ctx.clock.advanceDays(7);
  ctx.contra.evaluateAll();
  const credit = ctx.contra.proposeCredit("SC-SUM-0912")!;
  return { ...ctx, credit };
}

test("roles: only a controller approves or rejects a credit; a PM or AP is refused in words and nothing changes", () => {
  const { contra, ramp, log, credit } = throughProposal();
  const before = log.all().length;
  assert.throws(() => contra.approveCredit(credit.id, PM), (e: Error) => e instanceof NotPermitted && /needs the Controller role; dana\.ortiz is a PM/.test(e.message));
  assert.throws(() => contra.approveCredit(credit.id, AP), /needs the Controller role; sam\.ap is an AP/);
  assert.throws(() => contra.rejectCredit(credit.id, PM, "no"), /needs the Controller role/);
  assert.equal(credit.state, "proposed");
  assert.equal(ramp.credits.length, 0);
  assert.equal(log.all().length, before);
  contra.approveCredit(credit.id, CONTROLLER);
  assert.equal(credit.state, "synced");
});

test("separation of duties: the person who linked a charge cannot approve its credit; another controller can", () => {
  const ctx = setup();
  const { contra, seed, clock, ramp } = ctx;
  for (const e of seed.emails) contra.ingestBackChargeEmail(e, seed.extractions[e.id]!, LLM);
  // Lee Chen, a controller, confirmed the link for BC-4468 (linking needs no particular role).
  for (const ref of ["BC-4467", "BC-4470", "BC-4471"]) contra.confirmLink(ref, PM);
  contra.confirmLink("BC-4468", CONTROLLER);
  const n = contra.draftNotice("SC-SUM-0912")!;
  contra.approveNotice(n.id, PM);
  contra.sendNotice(n.id);
  clock.advanceDays(7);
  contra.evaluateAll();
  const credit = contra.proposeCredit("SC-SUM-0912")!;
  assert.deepEqual(credit.backChargeRefs, ["BC-4467", "BC-4468", "BC-4471"]);
  assert.throws(
    () => contra.approveCredit(credit.id, CONTROLLER),
    (e: Error) => e instanceof NotPermitted && e.message === "separation of duties: lee.chen linked BC-4468, so lee.chen can't approve credit VC-1; another controller must",
  );
  assert.equal(credit.state, "proposed");
  assert.equal(ramp.credits.length, 0);
  // A different controller approves it.
  contra.approveCredit(credit.id, person("kim.ng", "controller"));
  assert.equal(credit.state, "synced");
});

test("separation of duties: the person who raised a charge (a human on its audit trail) cannot approve its credit", () => {
  const ctx = setup();
  const { contra, seed, clock } = ctx;
  const raiser = person("jo.raise", "controller");
  // jo.raise entered E-1's back-charge by hand (a human extractor), and Dana confirmed the links.
  for (const e of seed.emails) contra.ingestBackChargeEmail(e, seed.extractions[e.id]!, e.id === "E-1" ? raiser : LLM);
  const raised = seed.extractions["E-1"]!.map((x) => x.ref);
  for (const ref of contra.backCharges.keys()) contra.confirmLink(ref, PM);
  const n = contra.draftNotice("SC-SUM-0912")!;
  contra.approveNotice(n.id, PM);
  contra.sendNotice(n.id);
  clock.advanceDays(7);
  contra.evaluateAll();
  const credit = contra.proposeCredit("SC-SUM-0912")!;
  const mine = raised.filter((r) => credit.backChargeRefs.includes(r));
  assert.ok(mine.length > 0, "E-1 has an item on the credit");
  assert.throws(() => contra.approveCredit(credit.id, raiser), new RegExp(`separation of duties: jo\\.raise raised ${mine[0]}`));
  assert.equal(credit.state, "proposed");
});

test("roles (core): only a PM approves a notice; a direct Contra call by a controller or AP is refused in words and nothing changes", () => {
  const { contra, seed, log } = setup();
  for (const e of seed.emails) contra.ingestBackChargeEmail(e, seed.extractions[e.id]!, LLM);
  for (const ref of ["BC-4467", "BC-4468", "BC-4470", "BC-4471"]) contra.confirmLink(ref, PM);
  const n = contra.draftNotice("SC-SUM-0912")!;
  const before = log.all().length;
  assert.throws(() => contra.approveNotice(n.id, CONTROLLER), (e: Error) => e instanceof NotPermitted && e.message === "approving notice N-1 needs the PM role; lee.chen is a Controller");
  assert.throws(() => contra.approveNotice(n.id, AP), /approving notice N-1 needs the PM role; sam\.ap is an AP/);
  // The state table refuses it on its own too, for any path that reaches the transition.
  assert.throws(() => transitionNotice(log, n, "approved", CONTROLLER, "x", []), (e: Error) => e instanceof NotPermitted && /needs the PM role/.test(e.message));
  assert.equal(n.state, "drafted");
  assert.equal(n.approvedBy, null);
  assert.equal(log.all().length, before);
  contra.approveNotice(n.id, PM);
  assert.equal(n.state, "approved");
});

test("roles: only AP turns credits on for a bill, and the audit records who", () => {
  const { contra, ramp, log, credit } = throughProposal();
  contra.approveCredit(credit.id, CONTROLLER);
  ramp.createBillViaApi({ id: "B-1", vendorId: "V-RIDGE", jobId: "SUM-01", amountCents: cents(4_800_000), accountingDate: new Date(START), origin: "native" });
  assert.throws(() => contra.turnOnCredits("B-1", CONTROLLER), (e: Error) => e instanceof NotPermitted && /turning on credits for bill B-1 needs the AP role; lee\.chen is a Controller/.test(e.message));
  assert.throws(() => contra.turnOnCredits("B-1", LLM), IllegalTransition);
  assert.equal(ramp.getBill("B-1").applyCredits, false);
  contra.turnOnCredits("B-1", AP);
  assert.equal(ramp.getBill("B-1").applyCredits, true);
  const e = log.all().at(-1)!;
  assert.deepEqual([e.entity, e.entityId, e.action, e.actor], ["bill", "B-1", "credits turned on", AP]);
  assert.deepEqual(e.evidence, [`VC-1 would apply ${formatUsd(credit.amountCents)}`]);
});

/** A live App holding the demo seed's three PM emails as if they had come from the inbox. */
function liveWithMail() {
  const app = new App(tmpDb("live.db"), { start: START, workspace: "live", realClock: { now: () => new Date(START) } });
  const { seed } = app.ctx;
  for (const e of seed.emails) cmd.ingestInboxEmail(app, { ...e, messageId: `${e.id}@pm.example` }, seed.extractions[e.id]!, LLM);
  return app;
}

test("roles (live): a notice needs a PM; a credit needs a controller who didn't link it; the audit records the real person and role", async () => {
  const app = liveWithMail();
  const pat = person("pat.pm", "pm");
  const cy = person("cy.ctl", "controller");
  const al = person("al.ap", "ap");
  try {
    const step = () => nextStep(app).action!;
    // Pat links BC-4467 and BC-4470; Cy links BC-4468 and BC-4471.
    for (const ref of ["BC-4467", "BC-4468", "BC-4470", "BC-4471"]) {
      const a = step();
      assert.deepEqual(a, { command: "confirmLink", ref });
      await cmd.runAction(app, a, {}, { by: ref === "BC-4468" || ref === "BC-4471" ? cy : pat });
    }
    await cmd.runAction(app, step(), {}, { by: pat }); // draft the notice
    const approve = step();
    assert.equal(approve.command, "approveNotice");
    for (const who of [cy, al]) {
      await assert.rejects(cmd.runAction(app, approve, {}, { by: who }), (e: Error) => e instanceof NotPermitted && /approving notice N-1 needs the PM role/.test(e.message));
    }
    assert.equal(app.ctx.contra.notices.get("N-1")!.state, "drafted");
    await cmd.runAction(app, approve, {}, { by: pat });
    await cmd.runAction(app, step(), {}, { by: pat }); // send
    app.advanceDays(7);
    await cmd.runAction(app, step(), {}, { by: pat }); // evaluate
    await cmd.runAction(app, step(), {}, { by: pat }); // propose
    const approveCredit = step();
    assert.equal(approveCredit.command, "approveCredit");
    // A PM can't approve a credit; Cy, a controller, linked two of its items, so Cy can't either.
    await assert.rejects(cmd.runAction(app, approveCredit, {}, { by: pat }), /approving credit VC-1 needs the Controller role; pat\.pm is a PM/);
    await assert.rejects(cmd.runAction(app, approveCredit, {}, { by: cy }), /separation of duties: cy\.ctl linked BC-4468, linked BC-4471, so cy\.ctl can't approve credit VC-1/);
    assert.equal(app.ctx.contra.credits.get("VC-1")!.state, "proposed");
    await cmd.runAction(app, approveCredit, {}, { by: person("di.ctl", "controller") });
    assert.equal(app.ctx.contra.credits.get("VC-1")!.state, "synced");

    const events = app.ctx.contra.audit.all();
    const actorOf = (pred: (e: (typeof events)[number]) => boolean) => events.find(pred)!.actor;
    assert.deepEqual(actorOf((e) => e.entity === "notice" && e.to === "approved"), pat);
    assert.deepEqual(actorOf((e) => e.entity === "credit" && e.to === "approved"), person("di.ctl", "controller"));
    assert.deepEqual(actorOf((e) => e.entityId === "BC-4468" && e.to === "linked"), cy);
    assert.ok(buildScreens(app).audit.some((e) => e.actor === "di.ctl (Controller)" && e.what.startsWith("credit VC-1: approved $15,500.00")));
  } finally {
    app.close();
  }
});

test("roles (demo): any signed-in presenter runs the scripted demo; steps keep their scripted actors, presented by them", async () => {
  const app = new App(tmpDb("demo.db"), { start: START });
  const presenter = person("kamal", "ap"); // an AP account can present every step, including the approvals
  try {
    for (let i = 0; i < 40 && nextStep(app).action; i++) await cmd.runAction(app, nextStep(app).action!, {}, { by: presenter });
    const s = buildScreens(app);
    assert.equal(s.nextStep.text, "Demo complete");
    assert.equal(s.outbox[0]!.total, "$15,500.00");
    assert.equal(s.credits[0]!.amount, "$11,500.00");
    assert.equal(s.bills[0]!.paid, "$36,500.00");
    const events = app.ctx.contra.audit.all();
    const by = (entity: string, to: string) => events.find((e) => e.entity === entity && e.to === to)!.actor;
    assert.deepEqual(by("notice", "approved"), { ...PM, presentedBy: "kamal" });
    assert.deepEqual(by("credit", "approved"), { ...CONTROLLER, presentedBy: "kamal" });
    assert.deepEqual(events.find((e) => e.action === "credits turned on")!.actor, { ...AP, presentedBy: "kamal" });
    assert.ok(s.audit.some((e) => e.actor === "lee.chen (Controller), presented by kamal" && e.what.startsWith(`credit VC-1: approved ${formatUsd(cents(1_150_000))}`)));
  } finally {
    app.close();
  }
});

test("roles (live): a step without a signed-in person is refused and changes nothing", async () => {
  const app = liveWithMail();
  try {
    const a = nextStep(app).action!;
    assert.equal(a.command, "confirmLink");
    await assert.rejects(cmd.runAction(app, a), (e: Error) => e instanceof NotPermitted && /live workspace records who takes each step: sign in first/.test(e.message));
    assert.throws(() => cmd.approveCredit(app, "VC-1"), NotPermitted);
    assert.equal(app.ctx.contra.backCharges.get("BC-4467")!.state, "extracted");
  } finally {
    app.close();
  }
});
