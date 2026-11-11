import assert from "node:assert/strict";
import { test } from "node:test";
import { cents } from "../src/money.ts";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { baselineDecide, contraDecide, itemsLabelProblem, loadLabels, loadRuns, parseSet, REVIEW, score, scoreItems, setPaths, type BenchCase, type BenchItemsLabel, type BenchLabel, type BenchRun, type DecidedItem, type Outcome } from "../bench/lib.ts";
import { parseBackCharges } from "../src/extract/validate.ts";
import { MockERP } from "../src/mocks/erp.ts";
import { demoSeed } from "../src/seed.ts";
import type { ExtractedBackCharge } from "../src/types.ts";

const L = (link: string, disputed = false, amount = 100): BenchLabel => ({ id: "x", labeledBy: "kamal", link, disputed, amountCents: amount });
const link = (sc: string, wouldCredit = true): Outcome => ({ decision: { kind: "link", subcontractId: sc }, wouldCredit });
const review: Outcome = { decision: { kind: "review" }, wouldCredit: false };

test("scoring: linking when the label says review is a wrong link AND a wrong credit", () => {
  const s = score(link("SC-A"), L("review"), cents(100), 1);
  assert.deepEqual(s, { matching: false, dispute: true, wrongLink: true, wrongCredit: true, routedToHuman: false, missed: false });
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
  assert.deepEqual(score(review, L("SC-A"), cents(100), 1), { matching: false, dispute: true, wrongLink: false, wrongCredit: false, routedToHuman: true, missed: false });
});

test("scoring: a labeled charge with no extracted item is missed: not correct and not routed to a person", () => {
  // Nothing reaches the Inbox, so nobody sees the charge, whether the label links it or says review.
  const MISSED = { matching: false, dispute: true, wrongLink: false, wrongCredit: false, routedToHuman: false, missed: true };
  assert.deepEqual(score(REVIEW, L("SC-A"), 0, 0), MISSED);
  assert.deepEqual(score(REVIEW, L("review"), 0, 0), MISSED);
  assert.deepEqual(score(REVIEW, L("SC-A", true), 0, 0), MISSED);
  // Several accepted items under a single-item label still reach a person: routed, not missed.
  assert.deepEqual(score(REVIEW, L("SC-A"), 0, 2), { matching: false, dispute: true, wrongLink: false, wrongCredit: false, routedToHuman: true, missed: false });
});

test("scoring: no accepted item but at least one refused item is routed to a person (the 'not taken in' row), not missed", () => {
  const ROUTED = { matching: false, dispute: true, wrongLink: false, wrongCredit: false, routedToHuman: true, missed: false };
  const MISSED = { ...ROUTED, routedToHuman: false, missed: true };
  for (const l of [L("SC-A"), L("review"), L("SC-A", true)]) {
    assert.deepEqual(score(REVIEW, l, 0, 0, 1), ROUTED);
    assert.deepEqual(score(REVIEW, l, 0, 0, 3), ROUTED);
    assert.deepEqual(score(REVIEW, l, 0, 0, 0), MISSED);
  }
  // A "none" label is unaffected: nothing accepted is still correct.
  assert.deepEqual(score(REVIEW, NONE, 0, 0, 2), { matching: true, dispute: true, wrongLink: false, wrongCredit: false, routedToHuman: false, missed: false });
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
  assert.deepEqual(score(REVIEW, NONE, 0, 0), { matching: true, dispute: true, wrongLink: false, wrongCredit: false, routedToHuman: false, missed: false });
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

test("--set: main by default, heldout or fresh on request, anything else rejected", () => {
  assert.equal(parseSet(["node", "run.ts"]), "main");
  assert.equal(parseSet(["node", "run.ts", "--runs", "3"]), "main");
  assert.equal(parseSet(["node", "run.ts", "--set", "main"]), "main");
  assert.equal(parseSet(["node", "run.ts", "--set", "heldout"]), "heldout");
  assert.equal(parseSet(["node", "run.ts", "--set", "fresh"]), "fresh");
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
  assert.deepEqual(setPaths(r, "fresh"), {
    cases: join(r, "bench", "fresh", "cases"), labels: join(r, "bench", "fresh", "labels"),
    recordings: join(r, "fixtures", "bench-extractions", "fresh"), results: join(r, "bench", "fresh", "results.json"),
  });
});

// Multi-item labels (bench/fresh/LABEL-FORMAT.md). Made-up items, written for these tests only.
const item = (ref: string, amount: number): ExtractedBackCharge => ({
  ref, description: "d", amountCents: cents(amount), amountEvidence: { emailId: "e", sentence: "s" },
  vendorNameAsWritten: "v", jobRef: "Summit", disputeNoted: false,
});
const dec = (...xs: [ExtractedBackCharge, Outcome][]): DecidedItem[] => xs.map(([x, o]) => ({ x, o }));
const ITEMS = (...items: BenchItemsLabel["items"]): BenchItemsLabel => ({ id: "x", labeledBy: "kamal", items });
const ALL_OK = { matching: true, dispute: true, wrongLink: false, wrongCredit: false, routedToHuman: false, missed: false };

test("items label: two charges without BC numbers, both linked and credited correctly", () => {
  const label = ITEMS({ link: "SC-SUM-0912", disputed: false, amountCents: 36_000 }, { link: "SC-SUM-0700", disputed: false, amountCents: 72_500 });
  // Extraction order differs from label order: pairing is by amount, not position.
  const r = scoreItems(dec([item("BC-2", 72_500), link("SC-SUM-0700")], [item("BC-1", 36_000), link("SC-SUM-0912")]), label);
  assert.deepEqual(r.score, ALL_OK);
  assert.deepEqual(r.items.map((s) => s.at), [1, 0]);
  assert.deepEqual(r.extra, []);
});

test("items label: one of two charges not extracted -> missed (not routed to a person), not matching, no wrong credit", () => {
  const label = ITEMS({ link: "SC-SUM-0912", disputed: false, amountCents: 36_000 }, { link: "SC-SUM-0700", disputed: false, amountCents: 72_500 });
  const r = scoreItems(dec([item("BC-1", 36_000), link("SC-SUM-0912")]), label);
  assert.deepEqual(r.score, { matching: false, dispute: true, wrongLink: false, wrongCredit: false, routedToHuman: false, missed: true });
  assert.deepEqual(r.items.map((s) => [s.score.missed, s.score.routedToHuman]), [[false, false], [true, false]]);
  assert.deepEqual(r.items.map((s) => s.at), [0, null]);
  // The same run with an item validation refused: the charge isn't extracted, but a person is sent to the email.
  const withRefused = scoreItems(dec([item("BC-1", 36_000), link("SC-SUM-0912")]), label, 1);
  assert.deepEqual(withRefused.score, { matching: false, dispute: true, wrongLink: false, wrongCredit: false, routedToHuman: true, missed: false });
  assert.deepEqual(withRefused.items.map((s) => [s.score.missed, s.score.routedToHuman]), [[false, false], [false, true]]);
  // Nothing accepted at all: routed with a refused item, missed without one.
  assert.deepEqual(scoreItems([], label, 2).score, { matching: false, dispute: true, wrongLink: false, wrongCredit: false, routedToHuman: true, missed: false });
  assert.deepEqual(scoreItems([], label, 0).score, { matching: false, dispute: true, wrongLink: false, wrongCredit: false, routedToHuman: false, missed: true });
});

test("items label: wrong amount does not pair; crediting it is a wrong credit", () => {
  const label = ITEMS({ link: "SC-SUM-0912", disputed: false, amountCents: 47_500 });
  const r = scoreItems(dec([item("BC-1", 4_750), link("SC-SUM-0912")]), label);
  assert.deepEqual(r.extra, [0]);
  assert.equal(r.score.matching, false);
  assert.equal(r.score.wrongCredit, true);
});

test("items label: same amount twice -> the subcontract breaks the tie", () => {
  const label = ITEMS({ link: "SC-SUM-0700", disputed: false, amountCents: 50_000 }, { link: "SC-SUM-0912", disputed: false, amountCents: 50_000 });
  const r = scoreItems(dec([item("BC-1", 50_000), link("SC-SUM-0912")], [item("BC-2", 50_000), link("SC-SUM-0700")]), label);
  assert.deepEqual(r.items.map((s) => s.at), [1, 0]);
  assert.deepEqual(r.score, ALL_OK);
});

test("items label: a ref pairs by ref, whatever the amount", () => {
  const label = ITEMS({ ref: "bc 7001", link: "SC-SUM-0912", disputed: false, amountCents: 10_000 });
  const r = scoreItems(dec([item("BC-7002", 10_000), link("SC-SUM-0912")], [item("BC-7001", 99_900), link("SC-SUM-0912")]), label);
  assert.deepEqual(r.items.map((s) => s.at), [1]);
  assert.deepEqual(r.extra, [0]);
  assert.equal(r.items[0]!.score.wrongCredit, true); // right ref, wrong amount, credited
  assert.equal(r.score.wrongCredit, true);
});

test("items label: review item and disputed item", () => {
  const review1 = ITEMS({ link: "review", disputed: false, amountCents: 83_000 });
  assert.deepEqual(scoreItems(dec([item("BC-1", 83_000), review]), review1).score, { ...ALL_OK, routedToHuman: true });
  assert.deepEqual(scoreItems([], review1).score, { ...ALL_OK, matching: false, missed: true });
  const linked = scoreItems(dec([item("BC-1", 83_000), link("SC-SUM-0912")]), review1).score;
  assert.equal(linked.wrongLink && linked.wrongCredit && !linked.matching, true);
  const disputed = ITEMS({ link: "SC-SUM-0700", disputed: true, amountCents: 215_000 });
  assert.deepEqual(scoreItems(dec([item("BC-1", 215_000), link("SC-SUM-0700", false)]), disputed).score, ALL_OK);
  const credited = scoreItems(dec([item("BC-1", 215_000), link("SC-SUM-0700", true)]), disputed).score;
  assert.equal(credited.wrongCredit && !credited.dispute, true);
});

test("items label: an accepted item beyond the labeled ones is never matching", () => {
  const label = ITEMS({ link: "SC-SUM-0700", disputed: false, amountCents: 134_000 });
  const r = scoreItems(dec([item("BC-1", 134_000), link("SC-SUM-0700")], [item("BC-2", 49_000), review]), label);
  assert.deepEqual(r.score, { matching: false, dispute: true, wrongLink: false, wrongCredit: false, routedToHuman: true, missed: false });
  const credited = scoreItems(dec([item("BC-1", 134_000), link("SC-SUM-0700")], [item("BC-2", 49_000), link("SC-SUM-0912")]), label).score;
  assert.deepEqual(credited, { matching: false, dispute: false, wrongLink: true, wrongCredit: true, routedToHuman: false, missed: false });
});

test("items label: malformed labels are refused when loaded", () => {
  const ok = { link: "SC-SUM-0912", disputed: false, amountCents: 100 };
  assert.equal(itemsLabelProblem(ITEMS(ok)), null);
  assert.equal(itemsLabelProblem(ITEMS({ ...ok, ref: "BC-1001" }, { ...ok, ref: "BC-1002" })), null);
  assert.match(itemsLabelProblem(ITEMS())!, /at least one/);
  assert.match(itemsLabelProblem(ITEMS({ ...ok, link: "none" }))!, /link/);
  assert.match(itemsLabelProblem(ITEMS({ ...ok, amountCents: 1.5 }))!, /amountCents/);
  assert.match(itemsLabelProblem(ITEMS({ ...ok, ref: "BC-1001" }, { ...ok, ref: "bc-1001" }))!, /twice/);
  assert.match(itemsLabelProblem(ITEMS({ ...ok, ref: "7" }))!, /BC number/);
  assert.match(itemsLabelProblem({ ...ITEMS(ok), link: "review" } as BenchItemsLabel)!, /must not also/);
  const dir = mkdtempSync(join(tmpdir(), "contra-labels-"));
  try {
    writeFileSync(join(dir, "a.json"), JSON.stringify({ id: "a", labeledBy: "kamal", link: "SC-SUM-0912", disputed: false, amountCents: 100 }));
    writeFileSync(join(dir, "b.json"), JSON.stringify(ITEMS(ok)));
    assert.equal(loadLabels(dir).size, 2);
    writeFileSync(join(dir, "c.json"), JSON.stringify({ ...ITEMS(), id: "c" }));
    assert.throws(() => loadLabels(dir), /c\.json.*at least one/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Recordings: a made-up case, written for these tests only.
const RAW_CASE: BenchCase = {
  id: "t-raw",
  description: "test only",
  email: {
    id: "t-raw",
    from: "Ines Varga <ines@apexbuilders.example>",
    to: "Harbor Mechanical <office@harbormech.example>",
    subject: "BC-7731 - Summit MOB",
    receivedAt: new Date("2026-10-20T14:00:00Z"),
    body: "Hi,\n\nHarbor Mechanical left condensate lines uncapped and water reached the ceiling below.\n\nBC-7731: ceiling tile replacement, Summit MOB, USD 1,450.\n\nInes",
  },
};
const RAW_OUTPUT = {
  items: [{
    ref: "BC-7731", description: "Ceiling tile replacement", amountText: "USD 1,450",
    amountSentence: "BC-7731: ceiling tile replacement, Summit MOB, USD 1,450.",
    vendorNameAsWritten: "Harbor Mechanical", jobRef: "Summit MOB", disputeNoted: false,
  }],
};

function withRun(run: BenchRun, f: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "contra-bench-"));
  try {
    mkdirSync(join(dir, RAW_CASE.id));
    writeFileSync(join(dir, RAW_CASE.id, "run-1.json"), JSON.stringify(run, null, 2));
    f(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function scoreRun(dir: string) {
  const seed = demoSeed(new Date("2026-11-07T15:00:00Z"));
  const erp = new MockERP({ jobs: seed.jobs, subcontracts: seed.subcontracts, aliases: [...seed.aliases] });
  const [r] = loadRuns(dir, RAW_CASE);
  const x = r!.items.length === 1 ? r!.items[0]! : null;
  const o = x ? contraDecide(RAW_CASE.email, x, erp) : REVIEW;
  return { items: r!.items, rejected: r!.rejected, outcome: o, score: score(o, L("SC-SUM-0912", false, 145_000), x ? x.amountCents : 0, r!.items.length) };
}

test("recordings: an old-format run (stored items only) and a new-format run (raw output) of the same output score the same", () => {
  const validated = parseBackCharges(RAW_OUTPUT, RAW_CASE.email);
  assert.equal(validated.items.length, 1);
  const meta = { model: "claude-test-1", effort: "medium", recordedAt: "2026-11-10T00:00:00.000Z" };
  const old: BenchRun = { ...meta, ...validated };
  const now: BenchRun = { ...meta, ...validated, rawToolInput: RAW_OUTPUT };
  let a: ReturnType<typeof scoreRun> | undefined, b: ReturnType<typeof scoreRun> | undefined;
  withRun(JSON.parse(JSON.stringify(old)), (d) => (a = scoreRun(d)));
  withRun(JSON.parse(JSON.stringify(now)), (d) => (b = scoreRun(d)));
  assert.deepEqual(a, b);
  assert.equal(a!.items[0]!.amountCents, 145_000);
});

test("recordings: raw output is re-validated at scoring time, so a stored rejection from an older validator is not kept", () => {
  // Recorded when the validator didn't read "USD 1,450": nothing accepted. The raw output reads fine today.
  const stale: BenchRun = {
    model: "claude-test-1", effort: "medium", recordedAt: "2026-11-10T00:00:00.000Z",
    items: [], rejected: [{ index: 0, reason: 'BC-7731: amountText "USD 1,450" is not exactly one $ amount' }],
    rawToolInput: RAW_OUTPUT,
  };
  withRun(stale, (d) => {
    const s = scoreRun(d);
    assert.deepEqual(s.rejected, []);
    assert.deepEqual(s.items.map((x) => [x.ref, x.amountCents]), [["BC-7731", 145_000]]);
  });
  // And the other way: raw output today's validator rejects is not scored from stale stored items.
  const unreadable = { items: [{ ...RAW_OUTPUT.items[0]!, amountText: "USD 1,450.5", amountSentence: "BC-7731: ceiling tile replacement, Summit MOB, USD 1,450.5." }] };
  const email = { ...RAW_CASE.email, body: "BC-7731: ceiling tile replacement, Summit MOB, USD 1,450.5." };
  const accepted: BenchRun = { ...stale, items: parseBackCharges(RAW_OUTPUT, RAW_CASE.email).items, rejected: [], rawToolInput: unreadable };
  withRun(accepted, (d) => {
    const [r] = loadRuns(d, { ...RAW_CASE, email });
    assert.equal(r!.items.length, 0);
    assert.match(r!.rejected[0]!.reason, /can't be read exactly/);
  });
});

test("recordings: a failed call is not re-validated", () => {
  const failed: BenchRun = { model: "m", effort: "medium", recordedAt: "2026-11-10T00:00:00.000Z", items: [], rejected: [], error: "HTTP 500" };
  withRun(failed, (d) => {
    const [r] = loadRuns(d, RAW_CASE);
    assert.equal(r!.error, "HTTP 500");
    assert.deepEqual(r!.items, []);
  });
});
