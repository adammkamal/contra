import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeRef } from "../src/extract/validate.ts";
import { unaccountedRefs } from "../src/intake.ts";
import { CONTRA_REF, Contra } from "../src/workflow.ts";
import { CONTROLLER, item, LLM, noNumberEmail, PM, setup } from "./helpers.ts";

const S1 = "Please back-charge Ridgeline Drywall $360.00 for the cleanup.";

test("no BC number: the charge gets a Contra reference, links and proceeds to a notice and a credit", () => {
  const ctx = setup();
  const { contra, clock } = ctx;
  const e = noNumberEmail("NB-1", S1);
  const [bc] = contra.ingestBackChargeEmail(e, [item(e, S1, 36_000)], LLM);
  assert.equal(bc!.ref, "CONTRA-0001");
  assert.equal(bc!.bcNumber, null);
  assert.match(bc!.ref, CONTRA_REF);
  // Never mistaken for an accounting number: not a BC number, and no email mentioning it reads as one.
  assert.equal(normalizeRef(bc!.ref), null);
  assert.deepEqual(unaccountedRefs({ ...e, body: `${e.body}\nRe: ${bc!.ref}` }, [null]), []);
  assert.equal(bc!.state, "extracted");
  assert.equal(contra.proposals.get(bc!.ref)?.kind, "linked");
  const extracted = ctx.log.forEntity("backcharge", bc!.ref)[0]!;
  assert.ok(extracted.evidence.includes("no BC number in the email yet; Contra reference CONTRA-0001"));

  contra.confirmLink(bc!.ref, PM);
  const n = contra.draftNotice("SC-SUM-0912")!;
  assert.deepEqual(n.backChargeRefs, ["CONTRA-0001"]);
  assert.match(n.body, /- CONTRA-0001 \(no BC number yet\): Stairwell debris removal - \$360\.00/);
  contra.approveNotice(n.id, PM);
  contra.sendNotice(n.id);
  clock.advanceDays(7);
  contra.evaluateAll();
  assert.equal(bc!.state, "eligible");
  const c = contra.proposeCredit("SC-SUM-0912")!;
  contra.approveCredit(c.id, CONTROLLER);
  assert.equal(c.amountCents, 36_000);
  assert.equal(bc!.state, "credited");
  assert.match(contra.creditMemo(c.id).text, /CONTRA-0001: no BC number yet; CONTRA-0001 is Contra's reference for it\./);
});

test("no BC number: references count up, survive a snapshot, and a snapshot without the counter never reuses one", () => {
  const ctx = setup();
  const e1 = noNumberEmail("NB-1", S1);
  const S2 = "The second cleanup cost $410.00 and goes back to Ridgeline Drywall.";
  const e2 = noNumberEmail("NB-2", S2);
  ctx.contra.ingestBackChargeEmail(e1, [item(e1, S1, 36_000)], LLM);
  const snap = ctx.contra.snapshot();
  const again = Contra.restore({ clock: ctx.clock, log: ctx.log, erp: ctx.erp, ramp: ctx.ramp }, snap);
  assert.deepEqual(again.ingestBackChargeEmail(e2, [item(e2, S2, 41_000, { description: "Second cleanup" })], LLM).map((b) => b.ref), ["CONTRA-0002"]);
  // A snapshot written before Contra references existed has no counter.
  const old = { ...snap, seq: { notice: snap.seq.notice, credit: snap.seq.credit } };
  const fromOld = Contra.restore({ clock: ctx.clock, log: ctx.log, erp: ctx.erp, ramp: ctx.ramp }, old);
  const e3 = noNumberEmail("NB-3", S2);
  assert.deepEqual(fromOld.ingestBackChargeEmail(e3, [item(e3, S2, 41_000, { description: "Second cleanup" })], LLM).map((b) => b.ref), ["CONTRA-0002"]);
});

test("no BC number: a dispute sentence that names no BC number holds the charge at the notice (code backstop)", () => {
  const { contra } = setup();
  const e = noNumberEmail("NB-1", S1, "Ridgeline disputes responsibility for this one.\n\n");
  // The model missed the dispute; the code backstop catches it.
  const [bc] = contra.ingestBackChargeEmail(e, [item(e, S1, 36_000)], LLM);
  contra.confirmLink(bc!.ref, PM);
  assert.equal(contra.draftNotice("SC-SUM-0912"), null);
  assert.equal(bc!.state, "held");
  assert.deepEqual(bc!.holdReasons, ["dispute_noted_in_source"]);
});
