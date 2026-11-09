import { AP, CONTROLLER, PM, SAMPLE_EXTRACTIONS } from "./actors.ts";
import type { App } from "./app.ts";
import { loadFixtures } from "./extract/index.ts";
import { isOffered } from "./view.ts";

export class NotOffered extends Error {}
import { cents } from "./money.ts";
import { demoReply } from "./seed.ts";
import type { Actor, ExtractedBackCharge, ExtractedResponse } from "./types.ts";

/**
 * Every button in the UI maps to exactly one of these. Each runs inside app.run (atomic).
 * Screens and the Playwright test call these; nothing else mutates state.
 */

export const DEMO_SC = "SC-SUM-0912";
export const DEMO_BILL = "B-SUM-48K";

export const DEFAULT_FIXTURES_DIR = "fixtures/extractions";

/**
 * Ingests the demo PM emails. Source, in order:
 *  1. `extractions` passed in (with the `extractor` that produced them);
 *  2. recorded model output in `fixturesDir` (written by `npm run extract:live` on a full pass);
 *  3. the hand-written sample in src/seed.ts, logged as SAMPLE_EXTRACTIONS, never as the model.
 */
export function ingestPmEmails(
  app: App,
  opts: { extractions?: Record<string, ExtractedBackCharge[]>; extractor?: Actor; fixturesDir?: string | null } = {},
): { refs: string[]; source: "model" | "sample" | "provided" } {
  return app.run(({ contra, seed }) => {
    let ex: Record<string, ExtractedBackCharge[]>;
    let actor: Actor;
    let source: "model" | "sample" | "provided";
    if (opts.extractions) {
      if (!opts.extractor) throw new Error("provided extractions need the extractor that produced them");
      [ex, actor, source] = [opts.extractions, opts.extractor, "provided"];
    } else {
      const rec = opts.fixturesDir === null ? null : loadFixtures(opts.fixturesDir ?? DEFAULT_FIXTURES_DIR, seed.emails.map((e) => e.id));
      if (rec) [ex, actor, source] = [rec.extractions, { kind: "llm", id: "extractor", model: rec.model }, "model"];
      else [ex, actor, source] = [seed.extractions, SAMPLE_EXTRACTIONS, "sample"];
    }
    const refs = seed.emails.flatMap((e) => contra.ingestBackChargeEmail(e, ex[e.id] ?? [], actor).map((b) => b.ref));
    return { refs, source };
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
    if (opts.extraction && !opts.extractor) throw new Error("a provided reply extraction needs the extractor that produced it");
    contra.ingestSubResponse(r.email, opts.extraction ?? r.extraction, opts.extractor ?? SAMPLE_EXTRACTIONS);
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

export interface ActionInput {
  /** For chooseSubcontract: the subcontract the PM picked (must be one of action.options). */
  choice?: string;
  /** For rejectCredit: the reason the controller typed. */
  reason?: string;
}

/**
 * The single dispatcher every frontend uses (Next server action or HTTP API). Exhaustive: adding an
 * Action variant without a case here is a type error.
 */
export function runAction(app: App, action: import("./view.ts").Action, input: ActionInput = {}): void {
  if (!isOffered(app, action)) throw new NotOffered(`${action.command} is not available right now (refresh the screen)`);
  switch (action.command) {
    case "ingestPmEmails":
      ingestPmEmails(app);
      return;
    case "confirmLink":
      return confirmLink(app, action.ref);
    case "chooseSubcontract": {
      if (!input.choice || !action.options.includes(input.choice)) throw new Error(`choose one of: ${action.options.join(", ")}`);
      return confirmLink(app, action.ref, input.choice);
    }
    case "draftNotice":
      draftNotice(app, action.subcontractId);
      return;
    case "approveNotice":
      return approveNotice(app, action.noticeId);
    case "sendNotice":
      return sendNotice(app, action.noticeId);
    case "ingestSubReply":
      return ingestSubReply(app, action.noticeId);
    case "advanceDays":
      return advanceDays(app, action.days);
    case "evaluateAll":
      evaluateAll(app);
      return;
    case "proposeCredit":
      proposeCredit(app, action.subcontractId);
      return;
    case "approveCredit":
      return approveCredit(app, action.creditId);
    case "rejectCredit": {
      const why = (input.reason ?? "").trim();
      if (!why) throw new Error("a rejection needs a reason");
      return rejectCredit(app, action.creditId, why.slice(0, 500));
    }
    case "billArrives":
      return billArrives(app);
    case "turnOnCredits":
      return turnOnCredits(app, action.billId);
    case "payBill":
      payBill(app, action.billId);
      return;
    default: {
      const never: never = action;
      throw new Error(`unknown action ${JSON.stringify(never)}`);
    }
  }
}
