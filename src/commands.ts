import { AP, CONTROLLER, PM, RECORDED_EXTRACTOR } from "./actors.ts";
import type { App } from "./app.ts";
import { cents } from "./money.ts";
import { demoReply } from "./seed.ts";
import type { Actor, ExtractedBackCharge, ExtractedResponse } from "./types.ts";

/**
 * Every button in the UI maps to exactly one of these. Each runs inside app.run (atomic).
 * Screens and the Playwright test call these; nothing else mutates state.
 */

export const DEMO_SC = "SC-SUM-0912";
export const DEMO_BILL = "B-SUM-48K";

export function ingestPmEmails(app: App, opts: { extractions?: Record<string, ExtractedBackCharge[]>; extractor?: Actor } = {}) {
  return app.run(({ contra, seed }) => {
    const ex = opts.extractions ?? seed.extractions;
    return seed.emails.flatMap((e) => contra.ingestBackChargeEmail(e, ex[e.id] ?? [], opts.extractor ?? RECORDED_EXTRACTOR).map((b) => b.ref));
  });
}

export function confirmLink(app: App, ref: string, subcontractId?: string) {
  app.run(({ contra }) => contra.confirmLink(ref, PM, subcontractId));
}

export function draftNotice(app: App, subcontractId = DEMO_SC) {
  return app.run(({ contra }) => contra.draftNotice(subcontractId)?.id ?? null);
}

export function approveNotice(app: App, noticeId: string) {
  app.run(({ contra }) => contra.approveNotice(noticeId, CONTROLLER));
}

export function sendNotice(app: App, noticeId: string) {
  app.run(({ contra }) => contra.sendNotice(noticeId));
}

export function ingestSubReply(app: App, noticeId: string, opts: { extraction?: ExtractedResponse; extractor?: Actor } = {}) {
  app.run(({ contra, clock }) => {
    const n = contra.notices.get(noticeId);
    if (!n || !n.sentAt) throw new Error(`notice ${noticeId} has not been sent`);
    const r = demoReply(n.id, n.body, clock.now());
    contra.ingestSubResponse(r.email, opts.extraction ?? r.extraction, opts.extractor ?? RECORDED_EXTRACTOR);
  });
}

export function advanceDays(app: App, days: number) {
  app.advanceDays(days);
}

export function evaluateAll(app: App) {
  return app.run(({ contra }) => [...contra.evaluateAll().entries()].map(([ref, r]) => ({ ref, status: r.status })));
}

export function proposeCredit(app: App, subcontractId = DEMO_SC) {
  return app.run(({ contra }) => contra.proposeCredit(subcontractId)?.id ?? null);
}

export function approveCredit(app: App, creditId: string) {
  app.run(({ contra }) => contra.approveCredit(creditId, CONTROLLER));
}

export function rejectCredit(app: App, creditId: string, why: string) {
  app.run(({ contra }) => contra.rejectCredit(creditId, CONTROLLER, why));
}

/** Simulates Ridgeline's $48,000 Summit bill arriving in (simulated) Ramp. */
export function billArrives(app: App) {
  app.run(({ ramp, clock }) => {
    if (ramp.bills.some((b) => b.id === DEMO_BILL)) throw new Error("demo bill already exists");
    ramp.createBillViaApi({ id: DEMO_BILL, vendorId: "V-RIDGE", jobId: "SUM-01", amountCents: cents(4_800_000), accountingDate: clock.now(), origin: "native" });
  });
}

export function turnOnCredits(app: App, billId = DEMO_BILL) {
  app.run(({ ramp }) => ramp.setApplyCredits(billId, true));
}

export function payBill(app: App, billId = DEMO_BILL) {
  return app.run(({ contra }) => contra.payBill(billId, AP).paidCents);
}
