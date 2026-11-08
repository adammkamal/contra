import assert from "node:assert/strict";
import { test } from "node:test";
import { cents } from "../src/money.ts";
import { score, type BenchLabel, type Outcome } from "../bench/lib.ts";

const L = (link: string, disputed = false, amount = 100): BenchLabel => ({ id: "x", labeledBy: "kamal", link, disputed, amountCents: amount });
const link = (sc: string, wouldCredit = true): Outcome => ({ decision: { kind: "link", subcontractId: sc }, wouldCredit });
const review: Outcome = { decision: { kind: "review" }, wouldCredit: false };

test("scoring: linking when the label says review is a wrong link AND a wrong credit", () => {
  const s = score(link("SC-A"), L("review"), cents(100));
  assert.deepEqual(s, { correct: false, wrongLink: true, wrongCredit: true, routedToHuman: false });
});

test("scoring: right party but disputed -> crediting it is a wrong credit", () => {
  assert.equal(score(link("SC-A", true), L("SC-A", true), cents(100)).wrongCredit, true);
  assert.equal(score(link("SC-A", false), L("SC-A", true), cents(100)).correct, true);
});

test("scoring: right party, wrong extracted amount -> wrong credit", () => {
  assert.equal(score(link("SC-A"), L("SC-A", false, 100), cents(1000)).wrongCredit, true);
});

test("scoring: review when a link was expected is safe but not correct", () => {
  assert.deepEqual(score(review, L("SC-A"), cents(100)), { correct: false, wrongLink: false, wrongCredit: false, routedToHuman: true });
});
