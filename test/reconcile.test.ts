import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { App } from "../src/app.ts";
import { cents, formatUsd } from "../src/money.ts";
import { reconcile, scanEmails } from "../src/reconcile.ts";
import { demoReply, historySeed } from "../src/seed.ts";
import { CONTROLLER, LLM, setup, throughNotice } from "./helpers.ts";

const NOW = new Date("2026-11-07T15:00:00Z");

function historyCtx() {
  const ctx = setup(NOW);
  const h = historySeed(NOW);
  ctx.ramp.credits.push(...h.rampCredits);
  ctx.ramp.bills.push(...h.rampBills);
  return { ctx, h };
}

test("history opener: $12,850 never deducted, $1,850 possible, $5,500 deducted", () => {
  const { ctx, h } = historyCtx();
  const r = reconcile(scanEmails(h.emails, h.extractions, ctx.erp), ctx.ramp);
  const by = Object.fromEntries(r.rows.map((x) => [x.item.ref, x.status]));
  assert.deepEqual(by, { "BC-4391": "deducted", "BC-4402": "possible_match", "BC-4410": "not_deducted", "BC-4415": "deducted", "BC-4420": "not_deducted" });
  assert.equal(formatUsd(r.totals.not_deducted), "$12,850.00");
  assert.equal(formatUsd(r.totals.possible_match), "$1,850.00");
  assert.equal(formatUsd(r.totals.deducted), "$5,500.00");
});

test("ref matching is exact and vendor-scoped", () => {
  const { ctx, h } = historyCtx();
  // BC-44100 must not count as BC-4410; another vendor's credit naming BC-4410 must not count either.
  ctx.ramp.credits.push(
    { id: "X1", vendorId: "V-RIDGE", jobId: "SUM-01", amountCents: cents(1), remainingCents: cents(0), accountingDate: NOW, erpSynced: true, createdVia: "history", memo: "BC-44100" },
    { id: "X2", vendorId: "V-HARBOR", jobId: "SUM-01", amountCents: cents(1), remainingCents: cents(0), accountingDate: NOW, erpSynced: true, createdVia: "history", memo: "BC-4410" },
  );
  const r = reconcile(scanEmails(h.emails, h.extractions, ctx.erp), ctx.ramp);
  assert.equal(r.rows.find((x) => x.item.ref === "BC-4410")!.status, "not_deducted");
});

test("one credit matching two refs by amount marks both possible, never 'deducted'", () => {
  const { ctx, h } = historyCtx();
  const items = scanEmails(h.emails, h.extractions, ctx.erp).map((i) => (i.ref === "BC-4420" ? { ...i, amountCents: cents(185_000) } : i));
  const r = reconcile(items, ctx.ramp);
  assert.equal(r.rows.find((x) => x.item.ref === "BC-4402")!.status, "possible_match");
  assert.equal(r.rows.find((x) => x.item.ref === "BC-4420")!.status, "possible_match");
});

test("disputed, unlinked and unverified items are never counted as missed money", () => {
  const ctx = setup(NOW);
  const notice = throughNotice(ctx);
  const reply = demoReply(notice.id, notice.body, ctx.clock.now());
  ctx.contra.ingestSubResponse(reply.email, reply.extraction, LLM);
  ctx.clock.advanceDays(7);
  ctx.contra.evaluateAll();
  ctx.contra.approveCredit(ctx.contra.proposeCredit("SC-SUM-0912")!.id, CONTROLLER);

  const ex = { ...ctx.seed.extractions, "E-3": [{ ...ctx.seed.extractions["E-3"]![0]!, vendorNameAsWritten: "Keystone Receivables Lockbox" }] };
  const withoutReplies = reconcile(scanEmails(ctx.seed.emails, ex, ctx.erp), ctx.ramp);
  const by = Object.fromEntries(withoutReplies.rows.map((x) => [x.item.ref, x.status]));
  assert.deepEqual(by, { "BC-4467": "deducted", "BC-4468": "deducted", "BC-4470": "disputed", "BC-4471": "unlinked" });
  assert.equal(withoutReplies.totals.not_deducted, 0);

  const withReplies = reconcile(scanEmails(ctx.seed.emails, ctx.seed.extractions, ctx.erp, { disputedInReplies: new Set(["BC-4471"]) }), ctx.ramp);
  assert.equal(withReplies.rows.find((x) => x.item.ref === "BC-4471")!.status, "disputed");
});

test("app: history is loaded, never applies to the demo bill, and the opener reads $12,850", () => {
  const app = new App(join(mkdtempSync(join(tmpdir(), "contra-")), "d.db"), { start: NOW });
  assert.equal(formatUsd(app.missedBackCharges().totals.not_deducted), "$12,850.00");
  app.run(({ ramp, clock }) => {
    ramp.createBillViaApi({ id: "B-1", vendorId: "V-RIDGE", jobId: "SUM-01", amountCents: cents(4_800_000), accountingDate: clock.now(), origin: "native" });
    ramp.setApplyCredits("B-1", true);
  });
  assert.deepEqual(app.ctx.ramp.previewApplication("B-1"), []);
  app.close();
});

test("a credit already matched by ref is not reused as an amount match for another item", () => {
  const { ctx, h } = historyCtx();
  const items = scanEmails(h.emails, h.extractions, ctx.erp).map((i) => (i.ref === "BC-4410" ? { ...i, amountCents: cents(310_000) } : i));
  const r = reconcile(items, ctx.ramp); // VC-OLD-1 ($3,100) names BC-4391 only
  assert.equal(r.rows.find((x) => x.item.ref === "BC-4391")!.status, "deducted");
  assert.equal(r.rows.find((x) => x.item.ref === "BC-4410")!.status, "not_deducted");
});
