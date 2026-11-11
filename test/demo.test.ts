// PROTECTED (AGENTS.md): the demo script from SPEC.md section 3 as an executable test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatUsd, cents } from "../src/money.ts";
import { demoReply } from "../src/seed.ts";
import { AP, CONTROLLER, LLM, PM, setup } from "./helpers.ts";

test("demo script: $48,000 bill, $11,500 credit, $36,500 paid", () => {
  const ctx = setup();
  const { contra, seed, clock, ramp, log } = ctx;

  // Step 1: ingest, verify spans, resolve via alias, PM confirms.
  for (const e of seed.emails) contra.ingestBackChargeEmail(e, seed.extractions[e.id]!, LLM);
  assert.equal(contra.backCharges.size, 4);
  for (const ref of ["BC-4467", "BC-4468", "BC-4470", "BC-4471"]) {
    const p = contra.proposals.get(ref)!;
    assert.equal(p.kind, "linked", ref);
    assert.ok(p.kind === "linked" && p.subcontractId === "SC-SUM-0912");
    assert.ok(contra.backCharges.get(ref)!.linkExplanation.some((l) => l.startsWith('alias: "Ridgeline Drywall"')));
    contra.confirmLink(ref, PM);
  }

  // Step 2: BC-4470 held for dispute in source; notice for the other three totals $15,500.
  const notice = contra.draftNotice("SC-SUM-0912")!;
  assert.equal(contra.backCharges.get("BC-4470")!.state, "held");
  assert.deepEqual(contra.backCharges.get("BC-4470")!.holdReasons, ["dispute_noted_in_source"]);
  assert.deepEqual(notice.backChargeRefs, ["BC-4467", "BC-4468", "BC-4471"]);
  assert.equal(formatUsd(notice.totalCents), "$15,500.00");
  assert.match(notice.body, /§14\.3/);
  assert.throws(() => contra.sendNotice(notice.id), /not allowed/); // no send before approval
  contra.approveNotice(notice.id, PM);
  contra.sendNotice(notice.id);

  // Step 3: "Fine, except 4471."
  const reply = demoReply(notice.id, notice.body, clock.now());
  clock.advanceDays(1);
  contra.ingestSubResponse(reply.email, reply.extraction, LLM);
  assert.equal(contra.backCharges.get("BC-4471")!.state, "held");
  assert.deepEqual(contra.backCharges.get("BC-4471")!.holdReasons, ["disputed_by_sub"]);
  assert.deepEqual(contra.pmQueue().map((b) => b.ref).sort(), ["BC-4470", "BC-4471"]);

  // Before the window closes nothing is eligible, even though the sub said "fine".
  contra.evaluateAll();
  assert.equal(contra.backCharges.get("BC-4467")!.state, "noticed");
  assert.equal(contra.proposeCredit("SC-SUM-0912"), null);

  // Five CALENDAR days later (Thu) the 5-working-day window is still open: nothing is eligible.
  clock.advanceDays(4);
  contra.evaluateAll();
  assert.equal(contra.backCharges.get("BC-4467")!.state, "noticed");

  // Step 4: a week after the notice (Sat Nov 7 -> Sat Nov 14), the window has closed (Fri Nov 13).
  clock.advanceDays(2);
  contra.evaluateAll();
  assert.equal(contra.backCharges.get("BC-4467")!.state, "eligible");
  assert.equal(contra.backCharges.get("BC-4468")!.state, "eligible");
  const credit = contra.proposeCredit("SC-SUM-0912")!;
  assert.equal(formatUsd(credit.amountCents), "$11,500.00");
  assert.equal(credit.jobId, "SUM-01");
  assert.equal(ramp.credits.length, 0); // nothing exists in Ramp before approval
  contra.approveCredit(credit.id, CONTROLLER);
  assert.equal(credit.state, "synced");

  // Step 5: $48,000 native Summit bill, credits on, pays $36,500.
  ramp.createBillViaApi({ id: "B-1", vendorId: "V-RIDGE", jobId: "SUM-01", amountCents: cents(4_800_000), accountingDate: clock.now(), origin: "native" });
  const preview = contra.previewBill("B-1");
  assert.equal(preview.plan.length, 0); // toggle still off
  ramp.setApplyCredits("B-1", true);
  assert.deepEqual(contra.previewBill("B-1").warnings, []);
  const paid = contra.payBill("B-1", AP);
  assert.equal(formatUsd(paid.paidCents), "$36,500.00");
  assert.equal(credit.state, "applied");
  assert.equal(contra.backCharges.get("BC-4467")!.state, "applied");

  // Audit: every state change logged with actor, time, evidence.
  const events = log.all();
  assert.ok(events.length >= 20);
  for (const e of events) {
    assert.ok(e.actor && e.at instanceof Date && Array.isArray(e.evidence));
  }
  const approval = events.find((e) => e.entity === "credit" && e.to === "approved")!;
  assert.equal(approval.actor.kind, "human");
});
