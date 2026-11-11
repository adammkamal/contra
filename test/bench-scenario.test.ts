import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSet, setPaths, type AnyBenchLabel, type BenchCase, type BenchItemsLabel, type BenchLabelItem, type BenchRun } from "../bench/lib.ts";
import { scenarioLabelProblem, scenarioOrder, scoreScenario } from "../bench/scenario.ts";
import { cents } from "../src/money.ts";
import { demoSeed } from "../src/seed.ts";
import type { ExtractedBackCharge } from "../src/types.ts";
import { join } from "node:path";

// Ordered scenario scoring (bench/scenario.ts, the fresh2 set). Made-up emails, runs and labels, written for
// these tests only.
const START = new Date("2026-11-07T15:00:00Z");
const seed = demoSeed(START);
const DATA = { seedStart: START, vendors: seed.vendors, subcontracts: seed.subcontracts, jobs: seed.jobs };

function mkCase(id: string, day: number, subject: string, sentence: string): BenchCase {
  return {
    id,
    description: "test case",
    email: {
      id, from: "dana.ortiz@apexbuilders.example", to: "contra.demo+backcharges@example.com", subject,
      receivedAt: new Date(Date.UTC(2026, 9, 27 + day, 14)),
      body: `Hi,\n\nRidgeline Drywall tore up the floor protection in the Level 2 west corridor at Summit.\n\n${sentence}\n\nDana`,
    },
  };
}
function mkItem(c: BenchCase, sentence: string, amount: number, o: Partial<ExtractedBackCharge> = {}): ExtractedBackCharge {
  return {
    ref: null, description: "Level 2 west corridor floor protection replacement", amountCents: cents(amount),
    amountEvidence: { emailId: c.id, sentence }, vendorNameAsWritten: "Ridgeline Drywall", jobRef: "Summit", disputeNoted: false, ...o,
  };
}
const run = (...items: ExtractedBackCharge[]): BenchRun => ({ model: "fixture", effort: "medium", recordedAt: "2026-11-01T00:00:00Z", items, rejected: [] });
const L = (id: string, ...items: BenchLabelItem[]): BenchItemsLabel => ({ id, labeledBy: "kamal", items });
const score = (cases: BenchCase[], runs: Record<string, BenchRun[]>, labels: AnyBenchLabel[]) =>
  scoreScenario(cases, new Map(Object.entries(runs)), new Map(labels.map((l) => [l.id, l])), DATA);

const S1 = "I'm estimating about $680.00 for labor and material.";
const S2 = "Actual cost for BC-5102 is $715.00 per the tickets.";
const first = mkCase("sc-1", 0, "Summit - Level 2 floor protection", S1);
const followUp = mkCase("sc-2", 1, "RE: Summit - Level 2 floor protection / BC-5102", S2);
const FIRST_LABEL = L("sc-1", { link: "SC-SUM-0912", disputed: false, amountCents: 68_000, estimated: true });
const FOLLOW_LABEL = L("sc-2", { ref: "BC-5102", link: "SC-SUM-0912", disputed: false, amountCents: 71_500, estimated: false, sameAs: { case: "sc-1", index: 0 } });

test("--set fresh2: its own cases, labels, recordings and results", () => {
  assert.equal(parseSet(["node", "run.ts", "--set", "fresh2"]), "fresh2");
  const r = join("repo");
  assert.deepEqual(setPaths(r, "fresh2"), {
    cases: join(r, "bench", "fresh2", "cases"), labels: join(r, "bench", "fresh2", "labels"),
    recordings: join(r, "fixtures", "bench-extractions", "fresh2"), results: join(r, "bench", "fresh2", "results.json"),
  });
});

test("scenario: a follow-up held as a possible duplicate of the earlier charge is correct; the stateless baseline credits both", () => {
  const rows = score([first, followUp], { "sc-1": [run(mkItem(first, S1, 68_000))], "sc-2": [run(mkItem(followUp, S2, 71_500, { ref: "BC-5102" }))] }, [FIRST_LABEL, FOLLOW_LABEL]);
  const [a, b] = rows;
  assert.equal(a!.caseId, "sc-1");
  assert.match(a!.contraDecision, /^\(no BC number\) as CONTRA-0001: link SC-SUM-0912 \+credit \[estimate\]$/);
  assert.equal(a!.contra!.matching, true);
  assert.match(b!.contraDecision, /BC-5102 as BC-5102: hold \(possible_duplicate of CONTRA-0001\)/);
  assert.deepEqual(b!.contra, { matching: true, dispute: true, wrongLink: false, wrongCredit: false, routedToHuman: true, missed: false });
  // The baseline has no state: both items link and credit, so the one charge would be credited twice.
  assert.equal(b!.baseline!.matching, false);
  assert.equal(b!.baseline!.wrongCredit, true);
});

test("scenario: an earlier charge and a follow-up that both proceed separately are a wrong credit", () => {
  // The earlier item is in the store but not recognised as the same charge (descriptions and amounts unrelated):
  // both proceed, so the one charge would be credited twice.
  const other = mkItem(followUp, S2, 71_500, { ref: "BC-5102", description: "Mechanical room access door paint touch-up" });
  const rows = score([first, followUp], { "sc-1": [run(mkItem(first, S1, 68_000, { description: "Elevator lobby wall patching" }))], "sc-2": [run(other)] }, [FIRST_LABEL, FOLLOW_LABEL]);
  const b = rows[1]!;
  assert.match(b.contraDecision, /BC-5102 as BC-5102: link SC-SUM-0912 \+credit/);
  assert.equal(b.contra!.matching, false);
  assert.equal(b.contra!.wrongCredit, true);
});

test("scenario: an email citing a BC number the store already has joins that item (merged into it): correct, never a second charge", () => {
  const early = mkCase("sc-1", 0, "Summit - BC-5102 floor protection", "BC-5102: floor protection, $680.00 for labor and material.");
  const x1 = mkItem(early, "BC-5102: floor protection, $680.00 for labor and material.", 68_000, { ref: "BC-5102" });
  const rows = score([early, followUp], { "sc-1": [run(x1)], "sc-2": [run(mkItem(followUp, S2, 71_500, { ref: "BC-5102" }))] }, [
    L("sc-1", { ref: "BC-5102", link: "SC-SUM-0912", disputed: false, amountCents: 68_000 }),
    FOLLOW_LABEL,
  ]);
  // Each case is scored right after its own email: sc-1's item was not yet held when sc-1 was ingested.
  assert.match(rows[0]!.contraDecision, /BC-5102 as BC-5102: link SC-SUM-0912 \+credit/);
  const b = rows[1]!;
  // The different amount holds the one item for conflicting amounts (the product's #sameChargeAgain).
  assert.match(b.contraDecision, /BC-5102 joined BC-5102: hold \(conflicting_amounts\)/);
  assert.equal(b.contra!.matching, true);
  assert.equal(b.contra!.wrongCredit, false);
});

test("scenario: a sameAs item with nothing extracted is missed; with an item refused from the email, routed to a person", () => {
  const empty: BenchRun = { ...run(), rejected: [] };
  const refused: BenchRun = { ...run(), rejected: [{ index: 0, reason: "amount not in email", words: "the BC-5102 item" }] };
  for (const [r, missed, routed] of [[empty, true, false], [refused, false, true]] as const) {
    const rows = score([first, followUp], { "sc-1": [run(mkItem(first, S1, 68_000))], "sc-2": [r] }, [FIRST_LABEL, FOLLOW_LABEL]);
    assert.equal(rows[1]!.contra!.missed, missed);
    assert.equal(rows[1]!.contra!.routedToHuman, routed);
    assert.equal(rows[1]!.contra!.matching, false);
  }
});

test("scenario: estimate markings are their own column, not part of matching", () => {
  // The label says estimated, the email's amount sentence doesn't call it one: matching stays true, estimate 0/1.
  const plain = "Please back-charge them $680.00 for labor and material.";
  const c = mkCase("sc-1", 0, "Summit - Level 2 floor protection", plain);
  const rows = score([c], { "sc-1": [run(mkItem(c, plain, 68_000))] }, [FIRST_LABEL]);
  assert.equal(rows[0]!.contra!.matching, true);
  assert.deepEqual(rows[0]!.contraEstimate, { labeled: 1, right: 0 });
  const rows2 = score([first], { "sc-1": [run(mkItem(first, S1, 68_000))] }, [FIRST_LABEL]);
  assert.deepEqual(rows2[0]!.contraEstimate, { labeled: 1, right: 1 });
  assert.deepEqual(rows2[0]!.baselineEstimate, { labeled: 1, right: 0 });
});

test("scenario: run n ingests run n of every case in date order, not id order; a failed run is reported, not scored", () => {
  // sc-2 is dated before sc-1 here: it is ingested first, so it gets CONTRA-0001.
  const a = mkCase("sc-1", 3, "Summit - Level 2 floor protection", S1);
  const b = { ...mkCase("sc-2", 0, "Summit - Level 2 floor protection", S1) };
  assert.deepEqual(scenarioOrder([a, b]).map((c) => c.id), ["sc-2", "sc-1"]);
  const failed: BenchRun = { ...run(), error: "overloaded" };
  const rows = score([a, b], { "sc-1": [run(mkItem(a, S1, 68_000)), failed], "sc-2": [run(mkItem(b, S1, 68_000)), run(mkItem(b, S1, 68_000))] }, [
    L("sc-1", { link: "SC-SUM-0912", disputed: false, amountCents: 68_000 }),
    L("sc-2", { link: "SC-SUM-0912", disputed: false, amountCents: 68_000 }),
  ]);
  assert.deepEqual(rows.map((r) => [r.caseId, r.run]), [["sc-1", 1], ["sc-1", 2], ["sc-2", 1], ["sc-2", 2]]);
  assert.match(rows.find((r) => r.caseId === "sc-2" && r.run === 1)!.contraDecision, /as CONTRA-0001:/);
  // Same sub, job and amount: the later email's item is held as a possible duplicate of the earlier one.
  assert.match(rows.find((r) => r.caseId === "sc-1" && r.run === 1)!.contraDecision, /as CONTRA-0002: hold \(possible_duplicate of CONTRA-0001\)/);
  assert.equal(rows.find((r) => r.caseId === "sc-1" && r.run === 2)!.failed, "overloaded");
  // In run 2 sc-1 failed and was never ingested, so sc-2's item stands alone.
  assert.match(rows.find((r) => r.caseId === "sc-2" && r.run === 2)!.contraDecision, /as CONTRA-0001: link SC-SUM-0912 \+credit/);
});

test("scenario labels: sameAs must name an earlier case's labeled back-charge", () => {
  const labels = (follow: BenchItemsLabel) => new Map<string, AnyBenchLabel>([["sc-1", FIRST_LABEL], ["sc-2", follow]]);
  const withSame = (s: object) => L("sc-2", { ...FOLLOW_LABEL.items[0]!, sameAs: s as never });
  assert.equal(scenarioLabelProblem([first, followUp], labels(FOLLOW_LABEL)), null);
  assert.match(scenarioLabelProblem([first, followUp], labels(withSame({ case: "sc-9", index: 0 })))!, /no case sc-9/);
  assert.match(scenarioLabelProblem([first, followUp], labels(withSame({ case: "sc-1", index: 1 })))!, /no labeled back-charge at index 1/);
  // A target dated later than the item is refused (sc-1 is moved after sc-2).
  const late = { ...first, email: { ...first.email, receivedAt: new Date(Date.UTC(2026, 10, 30)) } };
  assert.match(scenarioLabelProblem([late, followUp], labels(FOLLOW_LABEL))!, /not earlier than sc-2/);
});
