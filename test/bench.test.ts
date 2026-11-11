import assert from "node:assert/strict";
import { test } from "node:test";
import { cents } from "../src/money.ts";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { baselineDecide, contraDecide, loadRuns, parseSet, REVIEW, score, setPaths, type BenchCase, type BenchLabel, type BenchRun, type Outcome } from "../bench/lib.ts";
import { parseBackCharges } from "../src/extract/validate.ts";
import { MockERP } from "../src/mocks/erp.ts";
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
