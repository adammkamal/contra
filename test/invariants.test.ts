// PROTECTED (AGENTS.md): one test per invariant in INVARIANTS.md.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { creditAmountFor, IneligibleForCredit } from "../src/credits.ts";
import { evaluateEligibility } from "../src/eligibility.ts";
import { cents, parseUsd } from "../src/money.ts";
import { resolve } from "../src/resolver.ts";
import { demoReply } from "../src/seed.ts";
import { IllegalTransition, transitionBackCharge } from "../src/state.ts";
import { AP, CONTROLLER, LLM, PM, setup, throughNotice } from "./helpers.ts";

function srcFiles(dir = "src"): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? srcFiles(join(dir, d.name)) : d.name.endsWith(".ts") ? [join(dir, d.name)] : [],
  );
}

test("I1: money is integer cents; no float parsing or Date.now in src", () => {
  assert.throws(() => cents(11500.5));
  assert.equal(parseUsd("BC-1, $11,500.10."), 1_150_010);
  assert.equal(parseUsd("$0.07"), 7);
  for (const f of srcFiles()) {
    const s = readFileSync(f, "utf8");
    assert.doesNotMatch(s, /parseFloat|toFixed\(/, f);
    if (!f.endsWith("clock.ts")) assert.doesNotMatch(s, /Date\.now\(\)|new Date\(\)/, f);
  }
});

test("I2: amount must appear verbatim with exactly one matching $ figure", () => {
  const { contra, seed } = setup();
  const e = seed.emails[0]!;
  const base = seed.extractions["E-1"]![0]!;
  contra.ingestBackChargeEmail(e, [
    { ...base, ref: "BC-9001", amountCents: cents(68_000) }, // wrong amount ($680)
    { ...base, ref: "BC-9002", amountEvidence: { emailId: "E-1", sentence: "BC-9002: invented sentence, $6,800.00." } },
    { ...base, ref: "BC-9003", amountEvidence: { emailId: "E-2", sentence: base.amountEvidence.sentence } }, // wrong email
  ], LLM);
  for (const ref of ["BC-9001", "BC-9002", "BC-9003"]) {
    const b = contra.backCharges.get(ref)!;
    assert.equal(b.state, "held", ref);
    assert.deepEqual(b.holdReasons, ["unverified_evidence"], ref);
  }
});

test("I3: eligibility is pure code: no model imports, deterministic", () => {
  const s = readFileSync("src/eligibility.ts", "utf8");
  const imports = [...s.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ["./clock.ts", "./types.ts"]);
  const ctx = setup();
  throughNotice(ctx);
  const b = ctx.contra.backCharges.get("BC-4467")!;
  const input = { bc: b, subcontract: ctx.erp.subcontract("SC-SUM-0912"), notice: ctx.contra.notices.get("N-1")!, evidenceVerified: true, disputeInSource: false, now: ctx.clock.now(), phase: "final" as const };
  assert.deepEqual(evaluateEligibility(input), evaluateEligibility(input));
});

test("I4: disputed or unresolved items never become credits", () => {
  const ctx = setup();
  const notice = throughNotice(ctx);
  const reply = demoReply(notice.id, notice.body, ctx.clock.now());
  ctx.contra.ingestSubResponse(reply.email, reply.extraction, LLM);
  ctx.clock.advanceDays(30);
  ctx.contra.evaluateAll();
  const c = ctx.contra.proposeCredit("SC-SUM-0912")!;
  assert.deepEqual(c.backChargeRefs.sort(), ["BC-4467", "BC-4468"]);
  // Even if someone forces the state, the credit path refuses.
  const disputed = ctx.contra.backCharges.get("BC-4471")!;
  assert.throws(() => creditAmountFor([{ ...disputed, state: "eligible" }]), IneligibleForCredit);
  const inSource = ctx.contra.backCharges.get("BC-4470")!;
  assert.throws(() => creditAmountFor([{ ...inSource, state: "eligible" }]), IneligibleForCredit);
});

test("I5: no credit and no notice without a human approval", () => {
  const ctx = setup();
  const { contra, seed } = ctx;
  for (const e of seed.emails) contra.ingestBackChargeEmail(e, seed.extractions[e.id]!, LLM);
  assert.throws(() => contra.confirmLink("BC-4467", LLM), IllegalTransition);
  for (const ref of ["BC-4467", "BC-4468", "BC-4470", "BC-4471"]) contra.confirmLink(ref, PM);
  const n = contra.draftNotice("SC-SUM-0912")!;
  assert.throws(() => contra.sendNotice(n.id), IllegalTransition);
  assert.throws(() => contra.approveNotice(n.id, LLM), IllegalTransition);
  contra.approveNotice(n.id, CONTROLLER);
  contra.sendNotice(n.id);
  ctx.clock.advanceDays(7);
  contra.evaluateAll();
  const c = contra.proposeCredit("SC-SUM-0912")!;
  assert.equal(ctx.ramp.credits.length, 0);
  assert.throws(() => contra.approveCredit(c.id, { kind: "system", id: "x" }), IllegalTransition);
  assert.equal(ctx.ramp.credits.length, 0);
});

test("I6: audit log is append-only and mirrors every state", () => {
  const ctx = setup();
  throughNotice(ctx);
  const events = ctx.log.all();
  assert.throws(() => {
    (events[0] as { action: string }).action = "tampered";
  });
  assert.throws(() => (events as unknown as unknown[]).push({}));
  for (const b of ctx.contra.backCharges.values()) {
    const last = ctx.log.forEntity("backcharge", b.ref).at(-1)!;
    assert.equal(last.to, b.state, b.ref);
  }
});

test("I7: imported bills, toggle-off bills and unsynced credits get no credit", () => {
  const { ramp, clock } = setup();
  ramp.createCredit({ id: "C-unsynced", vendorId: "V-RIDGE", jobId: "SUM-01", amountCents: cents(100_000), accountingDate: clock.now() });
  ramp.createCredit({ id: "C-synced", vendorId: "V-RIDGE", jobId: "SUM-01", amountCents: cents(100_000), accountingDate: clock.now() });
  ramp.markCreditSynced("C-synced");
  ramp.createBillViaApi({ id: "B-imp", vendorId: "V-RIDGE", jobId: "SUM-01", amountCents: cents(500_000), accountingDate: clock.now(), origin: "imported" });
  ramp.setApplyCredits("B-imp", true);
  assert.equal(ramp.payBill("B-imp").paidCents, 500_000);
  ramp.createBillViaApi({ id: "B-off", vendorId: "V-RIDGE", jobId: "SUM-01", amountCents: cents(500_000), accountingDate: clock.now(), origin: "native" });
  assert.equal(ramp.payBill("B-off").paidCents, 500_000);
  ramp.createBillViaApi({ id: "B-on", vendorId: "V-RIDGE", jobId: "SUM-01", amountCents: cents(500_000), accountingDate: clock.now(), origin: "native" });
  ramp.setApplyCredits("B-on", true);
  const r = ramp.payBill("B-on");
  assert.deepEqual(r.applied.map((a) => a.creditId), ["C-synced"]);
  assert.equal(r.paidCents, 400_000);
});

test("I8: remit-to / lockbox names never match; ambiguous short names don't either", () => {
  const { erp } = setup();
  const lockbox = resolve({ jobRef: "Summit", vendorNameAsWritten: "Keystone Receivables Lockbox" }, erp);
  assert.equal(lockbox.kind, "review");
  const bare = resolve({ jobRef: "Summit", vendorNameAsWritten: "Ridgeline" }, erp);
  assert.equal(bare.kind, "review");
  assert.ok(bare.kind === "review" && bare.hints.length === 2);
  const s = readFileSync("src/resolver.ts", "utf8");
  assert.doesNotMatch(s.replace(/\/\*[\s\S]*?\*\//g, ""), /remit|payee|lockbox/i);
});

test("I9: illegal transitions throw", () => {
  const ctx = setup();
  const { contra, seed, log } = ctx;
  contra.ingestBackChargeEmail(seed.emails[0]!, seed.extractions["E-1"]!, LLM);
  const b = contra.backCharges.get("BC-4467")!;
  assert.throws(() => transitionBackCharge(log, b, "credited", { kind: "system", id: "x" }, "skip", []), IllegalTransition);
  assert.throws(() => transitionBackCharge(log, b, "eligible", PM, "skip", []), IllegalTransition);
});

test("I10: payment never below zero; leftover credit stays available", () => {
  const { ramp, clock } = setup();
  ramp.createCredit({ id: "C-big", vendorId: "V-RIDGE", jobId: "SUM-01", amountCents: cents(1_150_000), accountingDate: clock.now() });
  ramp.markCreditSynced("C-big");
  ramp.createBillViaApi({ id: "B-small", vendorId: "V-RIDGE", jobId: "SUM-01", amountCents: cents(500_000), accountingDate: clock.now(), origin: "native" });
  ramp.setApplyCredits("B-small", true);
  assert.equal(ramp.payBill("B-small").paidCents, 0);
  assert.equal(ramp.creditRemaining("C-big"), 650_000);
  void AP;
});
