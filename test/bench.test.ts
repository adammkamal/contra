import assert from "node:assert/strict";
import { test } from "node:test";
import { cents } from "../src/money.ts";
import { join } from "node:path";
import { baselineDecide, parseSet, REVIEW, score, setPaths, type BenchLabel, type Outcome } from "../bench/lib.ts";
import { demoSeed } from "../src/seed.ts";
import type { ExtractedBackCharge } from "../src/types.ts";

const L = (link: string, disputed = false, amount = 100): BenchLabel => ({ id: "x", labeledBy: "kamal", link, disputed, amountCents: amount });
const link = (sc: string, wouldCredit = true): Outcome => ({ decision: { kind: "link", subcontractId: sc }, wouldCredit });
const review: Outcome = { decision: { kind: "review" }, wouldCredit: false };

test("scoring: linking when the label says review is a wrong link AND a wrong credit", () => {
  const s = score(link("SC-A"), L("review"), cents(100), 1);
  assert.deepEqual(s, { matching: false, dispute: true, wrongLink: true, wrongCredit: true, routedToHuman: false });
});

test("scoring: right party but disputed -> crediting it is a wrong credit and a dispute miss", () => {
  const credited = score(link("SC-A", true), L("SC-A", true), cents(100), 1);
  assert.equal(credited.wrongCredit, true);
  assert.equal(credited.matching, true);
  assert.equal(credited.dispute, false);
  const held = score(link("SC-A", false), L("SC-A", true), cents(100), 1);
  assert.equal(held.matching && held.dispute && !held.wrongCredit, true);
});

test("scoring: withholding credit on a charge that isn't disputed is a dispute miss, not a wrong credit", () => {
  const s = score(link("SC-A", false), L("SC-A", false), cents(100), 1);
  assert.equal(s.dispute, false);
  assert.equal(s.wrongCredit, false);
});

test("scoring: right party, wrong extracted amount -> wrong credit", () => {
  assert.equal(score(link("SC-A"), L("SC-A", false, 100), cents(1000), 1).wrongCredit, true);
});

test("scoring: review when a link was expected is safe but not matching", () => {
  assert.deepEqual(score(review, L("SC-A"), cents(100), 1), { matching: false, dispute: true, wrongLink: false, wrongCredit: false, routedToHuman: true });
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

const NONE: BenchLabel = { id: "x", labeledBy: "kamal", link: "none", disputed: false, amountCents: null };

test("scoring 'none': no accepted item is correct and not routed", () => {
  assert.deepEqual(score(REVIEW, NONE, 0, 0), { matching: true, dispute: true, wrongLink: false, wrongCredit: false, routedToHuman: false });
});

test("scoring 'none': an accepted item that would be credited is a wrong credit", () => {
  const s = score(link("SC-A", true), NONE, cents(100), 1);
  assert.equal(s.matching, false);
  assert.equal(s.wrongCredit, true);
  assert.equal(s.wrongLink, true);
  assert.equal(s.routedToHuman, false);
});

test("scoring 'none': an accepted item not credited is routed to a person and not correct", () => {
  for (const [o, n] of [[review, 1], [link("SC-A", false), 1], [REVIEW, 2]] as const) {
    const s = score(o, NONE, cents(100), n);
    assert.equal(s.matching, false);
    assert.equal(s.wrongCredit, false);
    assert.equal(s.routedToHuman, true);
  }
});

test("--set: main by default, heldout on request, anything else rejected", () => {
  assert.equal(parseSet(["node", "run.ts"]), "main");
  assert.equal(parseSet(["node", "run.ts", "--runs", "3"]), "main");
  assert.equal(parseSet(["node", "run.ts", "--set", "main"]), "main");
  assert.equal(parseSet(["node", "run.ts", "--set", "heldout"]), "heldout");
  assert.throws(() => parseSet(["node", "run.ts", "--set", "all"]), /--set/);
  assert.throws(() => parseSet(["node", "run.ts", "--set"]), /--set/);
});

test("--set: each set has its own cases, labels, recordings and results", () => {
  const r = join("repo");
  assert.deepEqual(setPaths(r, "main"), {
    cases: join(r, "bench", "cases"), labels: join(r, "bench", "labels"),
    recordings: join(r, "fixtures", "bench-extractions"), results: join(r, "bench", "results.json"),
  });
  assert.deepEqual(setPaths(r, "heldout"), {
    cases: join(r, "bench", "heldout", "cases"), labels: join(r, "bench", "heldout", "labels"),
    recordings: join(r, "fixtures", "bench-extractions", "heldout"), results: join(r, "bench", "heldout", "results.json"),
  });
});
