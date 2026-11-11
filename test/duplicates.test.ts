import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { App } from "../src/app.ts";
import { ManualClock } from "../src/clock.ts";
import * as cmd from "../src/commands.ts";
import { duplicateReason, type DuplicateView } from "../src/duplicates.ts";
import { cents } from "../src/money.ts";
import { NotPermitted } from "../src/roles.ts";
import type { Email } from "../src/types.ts";
import { buildScreens, backChargeDetail } from "../src/view.ts";
import { Contra, refLabel } from "../src/workflow.ts";
import { CONTROLLER, item, LLM, noNumberEmail, PM, setup } from "./helpers.ts";

const S1 = "Please back-charge Ridgeline Drywall $360.00 for the cleanup.";
const FOLLOW = "BC-4480: stair 2 debris removal, $360.00, as sent last week.";

/** A follow-up that cites the BC number accounting assigned. */
function followUp(id: string, sentence: string, extra = ""): Email {
  return { ...noNumberEmail(id, sentence, extra), subject: "Summit - BC-4480 stairwell debris" };
}

/** Ingest a BC-less charge, link it, and send it on a notice. */
function noticedNoNumber(ctx: ReturnType<typeof setup>) {
  const e = noNumberEmail("NB-1", S1);
  const [a] = ctx.contra.ingestBackChargeEmail(e, [item(e, S1, 36_000)], LLM);
  ctx.contra.confirmLink(a!.ref, PM);
  const n = ctx.contra.draftNotice("SC-SUM-0912")!;
  ctx.contra.approveNotice(n.id, PM);
  ctx.contra.sendNotice(n.id);
  return a!;
}

test("duplicates: a later email citing a BC number for a BC-less charge is held, and merges into one charge on PM confirmation", () => {
  const ctx = setup();
  const { contra, clock } = ctx;
  const a = noticedNoNumber(ctx);
  assert.equal(a.state, "noticed");

  const f = followUp("FU-1", FOLLOW);
  const [b] = contra.ingestBackChargeEmail(f, [item(f, FOLLOW, 36_000, { ref: "BC-4480", description: "Stair 2 debris removal" })], LLM);
  assert.equal(b!.ref, "BC-4480");
  assert.equal(b!.state, "held");
  assert.deepEqual(b!.holdReasons, ["possible_duplicate"]);
  assert.equal(b!.duplicate!.of, "CONTRA-0001");
  assert.match(b!.duplicate!.why, /same subcontract \(SC-SUM-0912\) and job \(SUM-01\), same amount \(\$360\.00\)/);

  contra.confirmSameCharge(b!.ref, PM);
  assert.equal(b!.state, "merged");
  assert.equal(b!.mergedInto, "CONTRA-0001");
  // The BC number attaches to the existing item; both emails are its evidence.
  assert.equal(a.bcNumber, "BC-4480");
  assert.equal(refLabel(a), "CONTRA-0001 (BC-4480)");
  assert.deepEqual(a.alsoIn!.map((e) => e.emailId), ["FU-1"]);
  assert.equal(a.state, "noticed");
  assert.ok(ctx.log.forEntity("backcharge", a.ref).some((e) => e.action === "same charge as BC-4480, confirmed by dana.ortiz (PM); BC number BC-4480 attached"));

  // One charge: only the existing item becomes a credit.
  clock.advanceDays(7);
  contra.evaluateAll();
  const c = contra.proposeCredit("SC-SUM-0912")!;
  assert.deepEqual(c.backChargeRefs, ["CONTRA-0001"]);
  assert.equal(c.amountCents, 36_000);

  // A third email citing BC-4480 is the same charge again: no new item, no hold, its evidence added.
  const g = followUp("FU-2", FOLLOW);
  assert.deepEqual(contra.ingestBackChargeEmail({ ...g, messageId: "<fu-2@x>" }, [item(g, FOLLOW, 36_000, { ref: "BC-4480" })], LLM), []);
  assert.equal(contra.byBcNumber("BC-4480"), a);
  assert.deepEqual(a.alsoIn!.map((e) => e.emailId), ["FU-1", "FU-2"]);
});

test("duplicates: two BC-less emails with the same sub, job and amount never both reach a notice", () => {
  const ctx = setup();
  const { contra } = ctx;
  const e1 = noNumberEmail("NB-1", S1);
  const e2 = noNumberEmail("NB-2", S1);
  const [a] = contra.ingestBackChargeEmail(e1, [item(e1, S1, 36_000)], LLM);
  const [b] = contra.ingestBackChargeEmail(e2, [item(e2, S1, 36_000, { description: "Cleanup, stair 2" })], LLM);
  assert.equal(b!.state, "held");
  assert.deepEqual(b!.holdReasons, ["possible_duplicate"]);
  assert.equal(b!.duplicate!.of, a!.ref);
  contra.confirmLink(a!.ref, PM);
  assert.deepEqual(contra.draftNotice("SC-SUM-0912")!.backChargeRefs, [a!.ref]);

  // The PM says they are different charges: b goes back to waiting for its link and is never asked again.
  contra.confirmDifferentCharge(b!.ref, PM);
  assert.equal(b!.state, "extracted");
  assert.deepEqual(b!.holdReasons, []);
  contra.confirmLink(b!.ref, PM);
  assert.equal(b!.state, "linked");
  assert.deepEqual(contra.distinct, [[b!.ref, a!.ref]]);
});

test("duplicates: order doesn't matter; a BC-less charge after its numbered twin is held too", () => {
  const { contra } = setup();
  const f = followUp("FU-1", FOLLOW);
  const [b] = contra.ingestBackChargeEmail(f, [item(f, FOLLOW, 36_000, { ref: "BC-4480" })], LLM);
  assert.equal(b!.state, "extracted");
  const e = noNumberEmail("NB-1", S1);
  const [a] = contra.ingestBackChargeEmail(e, [item(e, S1, 36_000)], LLM);
  assert.deepEqual(a!.holdReasons, ["possible_duplicate"]);
  assert.equal(a!.duplicate!.of, "BC-4480");
  // Merging a BC-less item into a numbered one: the number stays, the BC-less item is merged.
  contra.confirmSameCharge(a!.ref, PM);
  assert.equal(a!.state, "merged");
  assert.equal(b!.bcNumber, "BC-4480");
});

test("duplicates: an item linked by hand is checked once its subcontract is known", () => {
  const { contra } = setup();
  const f = followUp("FU-1", FOLLOW);
  // "Ridgeline" alone is ambiguous: the resolver won't link it, so nothing to compare at ingest.
  const [b] = contra.ingestBackChargeEmail(f, [item(f, FOLLOW, 36_000, { ref: "BC-4480", vendorNameAsWritten: "Ridgeline" })], LLM);
  assert.equal(b!.state, "needs_review");
  const e = noNumberEmail("NB-1", S1);
  const [a] = contra.ingestBackChargeEmail(e, [item(e, S1, 36_000)], LLM);
  assert.equal(a!.state, "extracted");
  contra.confirmLink(b!.ref, PM, "SC-SUM-0912");
  assert.equal(b!.state, "held");
  assert.equal(b!.duplicate!.of, a!.ref);
  // Merged: BC-4480 (stored first) is the merged item, CONTRA-0001 carries the number. A third email citing
  // BC-4480 reaches CONTRA-0001, never the merged item.
  contra.confirmSameCharge(b!.ref, PM);
  const g = followUp("FU-2", FOLLOW);
  contra.ingestBackChargeEmail(g, [item(g, FOLLOW, 36_000, { ref: "BC-4480" })], LLM);
  assert.equal(contra.byBcNumber("BC-4480"), a);
  assert.deepEqual(a!.alsoIn!.map((x) => x.emailId), ["FU-1", "FU-2"]);
  assert.deepEqual(b!.alsoIn ?? [], []);
});

test("duplicates: draftNotice never puts both items of an open pair on a notice, even when both are linked", () => {
  const ctx = setup();
  const e1 = noNumberEmail("NB-1", S1);
  const e2 = noNumberEmail("NB-2", S1);
  ctx.contra.ingestBackChargeEmail(e1, [item(e1, S1, 36_000)], LLM);
  ctx.contra.ingestBackChargeEmail(e2, [item(e2, S1, 36_000)], LLM);
  ctx.contra.confirmLink("CONTRA-0001", PM);
  // As stored before duplicates were checked: both linked, nothing held.
  const s = ctx.contra.snapshot();
  const two = s.backCharges.find((b) => b.ref === "CONTRA-0002")!;
  Object.assign(two, { state: "linked", holdReasons: [], subcontractId: "SC-SUM-0912" });
  delete two.duplicate;
  const c = Contra.restore({ clock: ctx.clock, log: ctx.log, erp: ctx.erp, ramp: ctx.ramp }, s);
  const n = c.draftNotice("SC-SUM-0912")!;
  assert.equal(n.backChargeRefs.length, 1);
  const other = c.backCharges.get(n.backChargeRefs[0] === "CONTRA-0001" ? "CONTRA-0002" : "CONTRA-0001")!;
  assert.deepEqual(other.holdReasons, ["possible_duplicate"]);
});

test("duplicates: merging carries the second email's dispute and different amount to the item that stays", () => {
  const { contra } = setup();
  const s1 = "Ceiling grid replacement on L2 will be approximately $6,000.00, to be charged to Ridgeline Drywall.";
  const e = noNumberEmail("NB-1", s1);
  const [a] = contra.ingestBackChargeEmail(e, [item(e, s1, 600_000, { description: "Ceiling grid replacement, L2" })], LLM);
  contra.confirmLink(a!.ref, PM);
  const s2 = "BC-4481: ceiling grid replacement, L2, final cost $6,350.00.";
  const d2 = "Ridgeline disputes the lift damage on BC-4481.";
  const f = { ...followUp("FU-1", s2, `${d2}\n\n`), subject: "Summit - BC-4481" };
  const [b] = contra.ingestBackChargeEmail(f, [item(f, s2, 635_000, { ref: "BC-4481", description: "Ceiling grid replacement L2", disputeNoted: true, disputeEvidence: { emailId: f.id, sentence: d2 } })], LLM);
  assert.deepEqual(b!.holdReasons, ["possible_duplicate"]);
  assert.match(b!.duplicate!.why, /overlapping description \("ceiling", "grid"\); amounts \$6,350\.00 and \$6,000\.00/);
  contra.confirmSameCharge(b!.ref, PM);
  assert.equal(a!.state, "held");
  assert.deepEqual(a!.holdReasons, ["conflicting_amounts", "dispute_noted_in_source"]);
  assert.equal(a!.bcNumber, "BC-4481");
});

test("duplicates: a same charge confirmed after the credit never throws; it is flagged for a person", () => {
  const ctx = setup();
  const a = noticedNoNumber(ctx);
  ctx.clock.advanceDays(7);
  ctx.contra.evaluateAll();
  ctx.contra.approveCredit(ctx.contra.proposeCredit("SC-SUM-0912")!.id, CONTROLLER);
  assert.equal(a.state, "credited");
  const d = "Ridgeline disputes this.";
  const f = followUp("FU-1", FOLLOW, `${d}\n\n`);
  const [b] = ctx.contra.ingestBackChargeEmail(f, [item(f, FOLLOW, 36_000, { ref: "BC-4480", disputeNoted: true, disputeEvidence: { emailId: f.id, sentence: d } })], LLM);
  ctx.contra.confirmSameCharge(b!.ref, PM);
  assert.equal(a.state, "credited");
  assert.deepEqual(ctx.contra.lateDisputes, [{ ref: a.ref, emailId: "FU-1" }]);
  assert.ok(ctx.log.forEntity("backcharge", a.ref).some((e) => e.action === "another email notes a dispute after the credit; needs human review"));
});

test("duplicates: two different BC numbers with the same amount are two charges; another sub or amount is never a duplicate", () => {
  const v = (o: Partial<DuplicateView>): DuplicateView => ({ ref: "X", bcNumber: null, subcontractId: "SC-SUM-0912", jobId: "SUM-01", amountCents: cents(36_000), description: "Stairwell debris removal", ...o });
  assert.equal(duplicateReason(v({ bcNumber: "BC-1" }), v({ bcNumber: "BC-2" })), null);
  assert.equal(duplicateReason(v({}), v({ subcontractId: "SC-SUM-0700" })), null);
  assert.equal(duplicateReason(v({}), v({ subcontractId: null })), null);
  // Both without a number: only the same amount counts, never a description.
  assert.equal(duplicateReason(v({}), v({ amountCents: cents(41_000) })), null);
  assert.ok(duplicateReason(v({}), v({})));
  // One numbered: overlapping description counts; generic words ("repair", "damage") don't.
  assert.ok(duplicateReason(v({ bcNumber: "BC-1", amountCents: cents(41_000), description: "Debris removal, stair 2" }), v({})));
  assert.equal(duplicateReason(v({ bcNumber: "BC-1", amountCents: cents(41_000), description: "Corridor wall repair damage" }), v({ description: "Ceiling repair damage" })), null);
  const { contra } = setup();
  const s2 = "BC-4481: stair 2 debris removal, $360.00.";
  const f1 = followUp("FU-1", FOLLOW);
  const f2 = { ...followUp("FU-2", s2), subject: "Summit - BC-4481" };
  contra.ingestBackChargeEmail(f1, [item(f1, FOLLOW, 36_000, { ref: "BC-4480" })], LLM);
  const [b] = contra.ingestBackChargeEmail(f2, [item(f2, s2, 36_000, { ref: "BC-4481" })], LLM);
  assert.equal(b!.state, "extracted");
});

test("duplicates: only a PM decides, and only while the question is open", () => {
  const { contra } = setup();
  const e1 = noNumberEmail("NB-1", S1);
  const e2 = noNumberEmail("NB-2", S1);
  contra.ingestBackChargeEmail(e1, [item(e1, S1, 36_000)], LLM);
  contra.ingestBackChargeEmail(e2, [item(e2, S1, 36_000)], LLM);
  assert.throws(() => contra.confirmSameCharge("CONTRA-0002", CONTROLLER), NotPermitted);
  assert.throws(() => contra.confirmDifferentCharge("CONTRA-0002", CONTROLLER), NotPermitted);
  assert.throws(() => contra.confirmSameCharge("CONTRA-0001", PM), /only an item held just as a possible duplicate/);
  assert.equal(contra.backCharges.get("CONTRA-0002")!.state, "held");
});

test("duplicates: the screens say 'possible duplicate of <ref>' and offer same charge / different charge; a stale choice is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "contra-dup-"));
  const app = new App(join(dir, "live.db"), { workspace: "live", realClock: new ManualClock(new Date("2026-11-07T15:00:00Z")) });
  try {
    const by = { kind: "human" as const, id: "pat.pm", role: "pm" as const };
    const e1 = noNumberEmail("gmail-1", S1);
    const f = followUp("gmail-2", FOLLOW);
    cmd.ingestInboxEmail(app, e1, [item(e1, S1, 36_000)], LLM);
    cmd.ingestInboxEmail(app, f, [item(f, FOLLOW, 36_000, { ref: "BC-4480" })], LLM);
    const s = buildScreens(app);
    const row = s.inbox.find((r) => r.ref === "BC-4480")!;
    assert.equal(row.status.label, "Held: possible duplicate of CONTRA-0001");
    assert.deepEqual(row.actions, [
      { command: "sameCharge", ref: "BC-4480", duplicateOf: "CONTRA-0001" },
      { command: "differentCharge", ref: "BC-4480", duplicateOf: "CONTRA-0001" },
    ]);
    assert.equal(s.inbox.find((r) => r.ref === "CONTRA-0001")!.refLabel, "CONTRA-0001 (no BC number yet)");
    assert.equal(s.nextStep.text, "PM decides whether BC-4480 is the same charge as CONTRA-0001 (in its Inbox row)");
    await assert.rejects(cmd.runAction(app, { command: "sameCharge", ref: "BC-4480", duplicateOf: "CONTRA-0009" }, {}, { by }), cmd.NotOffered);
    await cmd.runAction(app, row.actions[0]!, {}, { by });
    const after = buildScreens(app);
    assert.equal(after.inbox.find((r) => r.ref === "BC-4480")!.status.label, "Merged into CONTRA-0001: the PM confirmed it is the same charge");
    assert.equal(after.inbox.find((r) => r.ref === "CONTRA-0001")!.refLabel, "CONTRA-0001 (BC-4480)");
    const d = backChargeDetail(app, "CONTRA-0001");
    assert.deepEqual(d.alsoIn.map((x) => [x.emailId, x.sentence]), [["gmail-2", FOLLOW]]);
    assert.equal(backChargeDetail(app, "BC-4480").duplicate!.ofLabel, "CONTRA-0001 (BC-4480)");
  } finally {
    app.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
