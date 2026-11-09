import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateEligibility } from "../src/eligibility.ts";
import { cents } from "../src/money.ts";
import { ambiguousWith, normName, resolve } from "../src/resolver.ts";
import { demoReply } from "../src/seed.ts";
import { disputeSentencesFor, normalize } from "../src/span.ts";
import { CONTROLLER, LLM, PM, setup, throughNotice } from "./helpers.ts";

test("credit leakage: a Summit credit on a Lakeview bill is flagged before payment", () => {
  const ctx = setup();
  const notice = throughNotice(ctx);
  void notice;
  ctx.clock.advanceDays(7);
  ctx.contra.evaluateAll();
  const c = ctx.contra.proposeCredit("SC-SUM-0912")!;
  ctx.contra.approveCredit(c.id, CONTROLLER);
  ctx.ramp.createBillViaApi({ id: "B-LAK", vendorId: "V-RIDGE", jobId: "LAK-02", amountCents: cents(2_000_000), accountingDate: ctx.clock.now(), origin: "native" });
  ctx.ramp.setApplyCredits("B-LAK", true);
  const { warnings } = ctx.contra.previewBill("B-LAK");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /SUM-01/);
});

test("sub reply: quoted notice text is not evidence", () => {
  const ctx = setup();
  const notice = throughNotice(ctx);
  const reply = demoReply(notice.id, notice.body, ctx.clock.now());
  // Model cites a sentence that only exists in the quoted notice.
  ctx.contra.ingestSubResponse(reply.email, { ...reply.extraction, evidence: { emailId: "E-4", sentence: "Undisputed amounts will be deducted from payments due under the subcontract." } }, LLM);
  for (const ref of notice.backChargeRefs) {
    assert.equal(ctx.contra.backCharges.get(ref)!.state, "held", ref);
    assert.deepEqual(ctx.contra.backCharges.get(ref)!.holdReasons, ["unverified_evidence"]);
  }
});

test("sub reply: model says accepted but the sub's own text disputes it -> held", () => {
  const ctx = setup();
  const notice = throughNotice(ctx);
  const reply = demoReply(notice.id, notice.body, ctx.clock.now());
  const email = { ...reply.email, body: `We dispute BC-4468, that debris was the painter's. ${reply.email.body}` };
  ctx.contra.ingestSubResponse(email, { ...reply.extraction, acceptedRefs: ["BC-4467", "BC-4468"] }, LLM);
  assert.equal(ctx.contra.backCharges.get("BC-4468")!.subResponse, "disputed");
  assert.equal(ctx.contra.backCharges.get("BC-4468")!.state, "held");
  assert.equal(ctx.contra.backCharges.get("BC-4467")!.state, "noticed");
});

test("sub reply: model drops the disputed ref entirely -> mention without acceptance still holds it", () => {
  const ctx = setup();
  const notice = throughNotice(ctx);
  const reply = demoReply(notice.id, notice.body, ctx.clock.now());
  ctx.contra.ingestSubResponse(reply.email, { ...reply.extraction, disputedRefs: [] }, LLM);
  assert.equal(ctx.contra.backCharges.get("BC-4471")!.state, "held");
});

test("sub reply: plain 'Fine.' does not hold items just because the quoted notice names them", () => {
  const ctx = setup();
  const notice = throughNotice(ctx);
  const reply = demoReply(notice.id, notice.body, ctx.clock.now());
  const email = { ...reply.email, body: reply.email.body.replace("Fine, except 4471. Our crew was ready, your inspector rescheduled.", "Fine, all received.") };
  ctx.contra.ingestSubResponse(email, { ...reply.extraction, disputedRefs: [], acceptedRefs: [], evidence: { emailId: "E-4", sentence: "Fine, all received." } }, LLM);
  for (const ref of notice.backChargeRefs) assert.equal(ctx.contra.backCharges.get(ref)!.state, "noticed", ref);
});

test("eligibility rule alone holds a sub-disputed item (defense in depth)", () => {
  const ctx = setup();
  throughNotice(ctx);
  ctx.clock.advanceDays(10);
  const b = { ...ctx.contra.backCharges.get("BC-4467")!, subResponse: "disputed" as const };
  const r = evaluateEligibility({ bc: b, subcontract: ctx.erp.subcontract("SC-SUM-0912"), notice: ctx.contra.notices.get("N-1")!, evidenceVerified: true, disputeInSource: false, now: ctx.clock.now(), phase: "final" });
  assert.equal(r.status, "held");
  assert.deepEqual(r.holdReasons, ["disputed_by_sub"]);
});

test("dispute backstop catches a dispute the model missed", () => {
  const ctx = setup();
  const { contra, seed } = ctx;
  const email = { ...seed.emails[2]!, body: seed.emails[2]!.body + " Ridgeline is contesting BC-4471 per their super." };
  contra.ingestBackChargeEmail(email, seed.extractions["E-3"]!, LLM); // disputeNoted: false
  contra.confirmLink("BC-4471", PM);
  assert.equal(contra.draftNotice("SC-SUM-0912"), null);
  assert.deepEqual(contra.backCharges.get("BC-4471")!.holdReasons, ["dispute_noted_in_source"]);
  assert.equal(disputeSentencesFor(email.body, "BC-4471").length, 1);
});

test("unknown vendor name goes to PM; PM link teaches an alias used next time", () => {
  const ctx = setup();
  const { contra, seed } = ctx;
  const x = { ...seed.extractions["E-1"]![0]!, vendorNameAsWritten: "RDG Interiors crew" };
  contra.ingestBackChargeEmail(seed.emails[0]!, [x], LLM);
  assert.equal(contra.backCharges.get("BC-4467")!.state, "needs_review");
  contra.confirmLink("BC-4467", PM, "SC-SUM-0912");
  assert.ok(ctx.erp.aliases.some((a) => a.alias === "RDG Interiors crew" && a.source === "pm_confirmed"));
  const y = { ...seed.extractions["E-1"]![1]!, vendorNameAsWritten: "RDG Interiors crew" };
  contra.ingestBackChargeEmail(seed.emails[0]!, [y], LLM);
  assert.equal(contra.proposals.get("BC-4468")!.kind, "linked");
});

test("late dispute after eligibility blocks the proposed credit at approval", () => {
  const ctx = setup();
  const notice = throughNotice(ctx);
  ctx.clock.advanceDays(7);
  ctx.contra.evaluateAll();
  const c = ctx.contra.proposeCredit("SC-SUM-0912")!;
  const reply = demoReply(notice.id, notice.body, ctx.clock.now());
  ctx.contra.ingestSubResponse(reply.email, reply.extraction, LLM);
  assert.equal(ctx.contra.backCharges.get("BC-4471")!.state, "held");
  assert.throws(() => ctx.contra.approveCredit(c.id, CONTROLLER), /not eligible/);
  assert.equal(ctx.ramp.credits.length, 0);
});

test("reply after the credit exists is flagged, not silently dropped", () => {
  const ctx = setup();
  const notice = throughNotice(ctx);
  ctx.clock.advanceDays(7);
  ctx.contra.evaluateAll();
  ctx.contra.approveCredit(ctx.contra.proposeCredit("SC-SUM-0912")!.id, CONTROLLER);
  const reply = demoReply(notice.id, notice.body, ctx.clock.now());
  ctx.contra.ingestSubResponse(reply.email, reply.extraction, LLM);
  assert.equal(ctx.contra.lateDisputes.length, 3);
});

test("same party with two subcontracts on one job -> review, never a guess", () => {
  const ctx = setup();
  const base = ctx.erp.subcontract("SC-SUM-0912")!;
  ctx.erp.subcontracts.push({ ...base, id: "SC-SUM-0913", scope: "Acoustic ceilings" });
  const r = resolve({ jobRef: "Summit", vendorNameAsWritten: "Ridgeline Drywall" }, ctx.erp);
  assert.equal(r.kind, "review");
  assert.ok(r.kind === "review" && /matches 2 subcontracts/.test(r.reasons[0]!));
});

test("same ref, different amount in a later email -> held for conflicting amounts", () => {
  const ctx = setup();
  const { contra, seed } = ctx;
  contra.ingestBackChargeEmail(seed.emails[0]!, seed.extractions["E-1"]!, LLM);
  const e = { ...seed.emails[2]!, id: "E-9", body: "Correction: BC-4468: debris haul-off, $5,100.00." };
  contra.ingestBackChargeEmail(e, [{ ...seed.extractions["E-1"]![1]!, amountCents: cents(510_000), amountEvidence: { emailId: "E-9", sentence: "BC-4468: debris haul-off, $5,100.00." } }], LLM);
  assert.deepEqual(contra.backCharges.get("BC-4468")!.holdReasons, ["conflicting_amounts"]);
});

test("normalize joins wrapped lines and strips quoted replies only when asked", () => {
  assert.equal(normalize("a\r\n  b c"), "a b c");
  assert.equal(normalize("mine\n> theirs", { excludeQuoted: true }), "mine");
});

test("MockRamp: same accounting date -> larger remaining balance applies first (per Ramp docs)", () => {
  const { ramp, clock } = setup();
  for (const [id, amt] of [["C-a", 10_000], ["C-b", 90_000]] as const) {
    ramp.createCredit({ id, vendorId: "V-RIDGE", jobId: "SUM-01", amountCents: cents(amt), accountingDate: clock.now() });
    ramp.markCreditSynced(id);
  }
  ramp.createBillViaApi({ id: "B-t", vendorId: "V-RIDGE", jobId: "SUM-01", amountCents: cents(50_000), accountingDate: clock.now(), origin: "native" });
  ramp.setApplyCredits("B-t", true);
  assert.deepEqual(ramp.payBill("B-t").applied.map((a) => a.creditId), ["C-b"]);
});

test("credit memo: only after approval, lines sum to the credit, both refs present", () => {
  const ctx = setup();
  const notice = throughNotice(ctx);
  const reply = demoReply(notice.id, notice.body, ctx.clock.now());
  ctx.contra.ingestSubResponse(reply.email, reply.extraction, LLM);
  ctx.clock.advanceDays(7);
  ctx.contra.evaluateAll();
  const c = ctx.contra.proposeCredit("SC-SUM-0912")!;
  assert.throws(() => ctx.contra.creditMemo(c.id), /approv/);
  ctx.contra.approveCredit(c.id, CONTROLLER);
  const memo = ctx.contra.creditMemo(c.id);
  assert.match(memo.text, /TOTAL CREDIT\s+\$11,500\.00/);
  assert.match(memo.text, /BC-4467.*\$6,800\.00/);
  assert.match(memo.text, /BC-4468.*\$4,700\.00/);
  assert.doesNotMatch(memo.text, /BC-4470|BC-4471/);
  assert.match(memo.text, /Vendor: Ridgeline Interiors LLC/);
  assert.match(memo.text, /response window closed 2026-11-13/);
});

test("renderCreditMemo refuses unapproved credits and lines that don't sum to the credit", async () => {
  const { renderCreditMemo } = await import("../src/memo.ts");
  const ctx = setup();
  throughNotice(ctx);
  ctx.clock.advanceDays(7);
  ctx.contra.evaluateAll();
  const c = ctx.contra.proposeCredit("SC-SUM-0912")!;
  const base = {
    subcontract: ctx.erp.subcontract("SC-SUM-0912")!,
    job: ctx.erp.jobs[0]!,
    vendorName: "Ridgeline Interiors LLC",
    items: c.backChargeRefs.map((r) => ctx.contra.backCharges.get(r)!),
    notices: [ctx.contra.notices.get("N-1")!],
    approvedAt: ctx.clock.now(),
  };
  assert.throws(() => renderCreditMemo({ ...base, credit: c }), /only for approved/);
  assert.throws(() => renderCreditMemo({ ...base, credit: { ...c, state: "approved", amountCents: cents(1) } }), /lines total/);
});

test("response windows: working days skip weekends; hours and calendar days are exact", async () => {
  const { windowCloses } = await import("../src/clock.ts");
  const sat = new Date("2026-11-07T15:00:00Z");
  const fri = new Date("2026-11-13T15:00:00Z");
  const wed = new Date("2026-11-11T09:30:00Z");
  assert.equal(windowCloses(sat, { amount: 5, unit: "working_days" }).toISOString(), "2026-11-13T15:00:00.000Z");
  assert.equal(windowCloses(fri, { amount: 5, unit: "working_days" }).toISOString(), "2026-11-20T15:00:00.000Z");
  assert.equal(windowCloses(fri, { amount: 1, unit: "working_days" }).toISOString(), "2026-11-16T15:00:00.000Z");
  assert.equal(windowCloses(wed, { amount: 48, unit: "hours" }).toISOString(), "2026-11-13T09:30:00.000Z");
  assert.equal(windowCloses(wed, { amount: 3, unit: "calendar_days" }).toISOString(), "2026-11-14T09:30:00.000Z");
  assert.throws(() => windowCloses(wed, { amount: 0, unit: "hours" }));
  assert.throws(() => windowCloses(wed, { amount: 1.5, unit: "working_days" }));
});

test("a 48-hour clause makes items eligible after 48 hours, not before", () => {
  const ctx = setup();
  const sc = ctx.erp.subcontract("SC-SUM-0912")!;
  sc.clause = { ...sc.clause!, responseWindow: { amount: 48, unit: "hours" } };
  throughNotice(ctx);
  ctx.clock.advanceDays(1);
  ctx.contra.evaluateAll();
  assert.equal(ctx.contra.backCharges.get("BC-4467")!.state, "noticed");
  ctx.clock.advanceDays(1);
  ctx.contra.evaluateAll();
  assert.equal(ctx.contra.backCharges.get("BC-4467")!.state, "eligible");
  assert.match(ctx.contra.notices.get("N-1")!.body, /You have 48 hours/);
});

test("bill arrival: walks AP from propose -> approve -> turn on credits, then shows $36,500", () => {
  const ctx = setup();
  const notice = throughNotice(ctx);
  const reply = demoReply(notice.id, notice.body, ctx.clock.now());
  ctx.contra.ingestSubResponse(reply.email, reply.extraction, LLM);
  ctx.clock.advanceDays(7);
  ctx.contra.evaluateAll();
  ctx.ramp.createBillViaApi({ id: "B-1", vendorId: "V-RIDGE", jobId: "SUM-01", amountCents: cents(4_800_000), accountingDate: ctx.clock.now(), origin: "native" });

  let check = ctx.contra.billArrivalCheck("B-1");
  assert.equal(check.status, "action_needed");
  assert.match(check.actions[0]!, /propose a credit for BC-4467, BC-4468 \(\$11,500\.00\)/);
  assert.match(check.warnings.join(" "), /BC-4470, BC-4471 held/);

  const c = ctx.contra.proposeCredit("SC-SUM-0912")!;
  check = ctx.contra.billArrivalCheck("B-1");
  assert.deepEqual(check.actions, [`approve credit ${c.id} ($11,500.00) before paying`]);

  ctx.contra.approveCredit(c.id, CONTROLLER);
  check = ctx.contra.billArrivalCheck("B-1");
  assert.match(check.actions[0]!, /turn on credits for this bill: VC-1 \$11,500\.00 would apply/);
  assert.equal(check.wouldPayCents, 3_650_000);

  ctx.ramp.setApplyCredits("B-1", true);
  check = ctx.contra.billArrivalCheck("B-1");
  assert.equal(check.status, "ok");
  ctx.contra.payBill("B-1", CONTROLLER);
  assert.equal(ctx.contra.billArrivalCheck("B-1").status, "too_late");
});

test("bill arrival: imported bills and other-job bills are flagged", () => {
  const ctx = setup();
  throughNotice(ctx);
  ctx.clock.advanceDays(7);
  ctx.contra.evaluateAll();
  ctx.contra.approveCredit(ctx.contra.proposeCredit("SC-SUM-0912")!.id, CONTROLLER);
  ctx.ramp.createBillViaApi({ id: "B-imp", vendorId: "V-RIDGE", jobId: "SUM-01", amountCents: cents(1_000_000), accountingDate: ctx.clock.now(), origin: "imported" });
  const imp = ctx.contra.billArrivalCheck("B-imp");
  assert.match(imp.warnings.join(" "), /imported bill/);
  assert.equal(imp.ifCreditsOn.length, 0);
  assert.equal(imp.wouldPayCents, 1_000_000);
  ctx.ramp.createBillViaApi({ id: "B-lak", vendorId: "V-RIDGE", jobId: "LAK-02", amountCents: cents(1_000_000), accountingDate: ctx.clock.now(), origin: "native" });
  assert.match(ctx.contra.billArrivalCheck("B-lak").warnings.join(" "), /is for job SUM-01 but this bill is for LAK-02/);
});

test("an ambiguous name is never learned as an alias: PM links 'Ridgeline' once, the next 'Ridgeline' still goes to review", () => {
  const ctx = setup();
  const { contra, seed } = ctx;
  const x = { ...seed.extractions["E-2"]![0]!, vendorNameAsWritten: "Ridgeline" };
  contra.ingestBackChargeEmail(seed.emails[1]!, [x], LLM);
  assert.equal(contra.backCharges.get("BC-4470")!.state, "needs_review");
  contra.confirmLink("BC-4470", PM, "SC-SUM-0912");
  assert.equal(contra.backCharges.get("BC-4470")!.state, "linked"); // the item itself is linked
  assert.ok(!ctx.erp.aliases.some((a) => normName(a.alias) === "ridgeline"));
  const ev = [...ctx.log.all()].find((e) => e.entity === "alias" && e.entityId === "Ridgeline");
  assert.ok(ev && /not learned/.test(ev.action) && /Ridgeline Glass & Glazing Inc/.test(ev.action), ev?.action);

  const y = { ...seed.extractions["E-1"]![1]!, vendorNameAsWritten: "Ridgeline" };
  contra.ingestBackChargeEmail(seed.emails[0]!, [y], LLM);
  assert.equal(contra.proposals.get("BC-4468")!.kind, "review");
  assert.equal(contra.backCharges.get("BC-4468")!.state, "needs_review");
});

test("the seeded 'Ridgeline Drywall' alias is not ambiguous and still links to SC-SUM-0912", () => {
  const { seed, erp } = setup();
  const r = resolve({ jobRef: "Summit", vendorNameAsWritten: "Ridgeline Drywall" }, erp);
  assert.ok(r.kind === "linked" && r.subcontractId === "SC-SUM-0912");
  assert.equal(ambiguousWith("Ridgeline Drywall", "Ridgeline Interiors LLC", seed.subcontracts.map((s) => s.partyLegalName)), null);
  assert.equal(ambiguousWith("Ridgeline", "Ridgeline Interiors LLC", seed.subcontracts.map((s) => s.partyLegalName)), "Ridgeline Glass & Glazing Inc");
});

test("an alias that becomes ambiguous after a similar party joins the job stops linking", () => {
  const ctx = setup();
  const { contra, seed, erp } = ctx;
  const x = { ...seed.extractions["E-1"]![0]!, vendorNameAsWritten: "RDG Interiors crew" };
  contra.ingestBackChargeEmail(seed.emails[0]!, [x], LLM);
  contra.confirmLink("BC-4467", PM, "SC-SUM-0912");
  assert.ok(erp.aliases.some((a) => a.alias === "RDG Interiors crew")); // learned: not ambiguous yet
  const sc = erp.subcontract("SC-SUM-0820")!;
  erp.subcontracts.push({ ...sc, id: "SC-SUM-0990", partyLegalName: "RDG Interiors Crew Services LLC", paymentsVendorId: "V-RGG" });
  const r = resolve({ jobRef: "Summit", vendorNameAsWritten: "RDG Interiors crew" }, erp);
  assert.equal(r.kind, "review");
  assert.ok(r.kind === "review" && r.reasons.some((m) => /alias "RDG Interiors crew" -> Ridgeline Interiors LLC ignored/.test(m) && /RDG Interiors Crew Services LLC/.test(m)), JSON.stringify(r));
});
