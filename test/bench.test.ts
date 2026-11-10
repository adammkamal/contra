import assert from "node:assert/strict";
import { test } from "node:test";
import { cents } from "../src/money.ts";
import { baselineDecide, score, type BenchLabel, type Outcome } from "../bench/lib.ts";
import { demoSeed } from "../src/seed.ts";
import type { ExtractedBackCharge } from "../src/types.ts";

const L = (link: string, disputed = false, amount = 100): BenchLabel => ({ id: "x", labeledBy: "kamal", link, disputed, amountCents: amount });
const link = (sc: string, wouldCredit = true): Outcome => ({ decision: { kind: "link", subcontractId: sc }, wouldCredit });
const review: Outcome = { decision: { kind: "review" }, wouldCredit: false };

test("scoring: linking when the label says review is a wrong link AND a wrong credit", () => {
  const s = score(link("SC-A"), L("review"), cents(100));
  assert.deepEqual(s, { matching: false, dispute: true, wrongLink: true, wrongCredit: true, routedToHuman: false });
});

test("scoring: right party but disputed -> crediting it is a wrong credit and a dispute miss", () => {
  const credited = score(link("SC-A", true), L("SC-A", true), cents(100));
  assert.equal(credited.wrongCredit, true);
  assert.equal(credited.matching, true);
  assert.equal(credited.dispute, false);
  const held = score(link("SC-A", false), L("SC-A", true), cents(100));
  assert.equal(held.matching && held.dispute && !held.wrongCredit, true);
});

test("scoring: withholding credit on a charge that isn't disputed is a dispute miss, not a wrong credit", () => {
  const s = score(link("SC-A", false), L("SC-A", false), cents(100));
  assert.equal(s.dispute, false);
  assert.equal(s.wrongCredit, false);
});

test("scoring: right party, wrong extracted amount -> wrong credit", () => {
  assert.equal(score(link("SC-A"), L("SC-A", false, 100), cents(1000)).wrongCredit, true);
});

test("scoring: review when a link was expected is safe but not matching", () => {
  assert.deepEqual(score(review, L("SC-A"), cents(100)), { matching: false, dispute: true, wrongLink: false, wrongCredit: false, routedToHuman: true });
});

test("baseline honors the extraction's disputeNoted", () => {
  const seed = demoSeed(new Date("2026-11-07T15:00:00Z"));
  const x: ExtractedBackCharge = {
    ref: "BC-1", description: "d", amountCents: cents(100), amountEvidence: { emailId: "e", sentence: "s" },
    vendorNameAsWritten: "Harbor Mechanical", jobRef: "Summit", disputeNoted: false,
  };
  const free = baselineDecide(x, seed.vendors, seed.subcontracts, seed.jobs);
  assert.equal(free.decision.kind, "link");
  assert.equal(free.wouldCredit, true);
  assert.equal(baselineDecide({ ...x, disputeNoted: true }, seed.vendors, seed.subcontracts, seed.jobs).wouldCredit, false);
});
