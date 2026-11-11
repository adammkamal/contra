import { windowCloses } from "./clock.ts";
import type { BackCharge, HoldReason, Notice, Subcontract } from "./types.ts";

export interface EligibilityInput {
  bc: Readonly<BackCharge>;
  subcontract: Readonly<Subcontract> | null;
  notice: Readonly<Notice> | null;
  /**
   * Result of the span checks on all of the item's evidence (computed by code, not the model), or, for an
   * amount read from an image, of a person's confirmation of that amount (bc.amountConfirmation).
   */
  evidenceVerified: boolean;
  /** Model-flagged dispute (span-verified) OR code backstop hit. Either one holds the item. */
  disputeInSource: boolean;
  now: Date;
  /** pre_notice: decide what to put in a notice. final: decide what may become a credit. */
  phase: "pre_notice" | "final";
}

export interface EligibilityResult {
  status: "eligible" | "pending" | "held";
  holdReasons: HoldReason[];
  pendingReasons: string[];
  trace: string[];
}

/**
 * Pure and deterministic. Takes no model judgement except facts that passed span checks.
 * Every rule appends to the trace so the UI can show why.
 */
export function evaluateEligibility(i: EligibilityInput): EligibilityResult {
  const hold: HoldReason[] = [];
  const pending: string[] = [];
  const trace: string[] = [];
  const rule = (ok: boolean, label: string, reason?: HoldReason) => {
    trace.push(`${ok ? "PASS" : reason ? "HOLD" : "WAIT"} ${label}`);
    if (!ok && reason) hold.push(reason);
    if (!ok && !reason) pending.push(label);
  };

  rule(i.subcontract !== null && i.bc.subcontractId === i.subcontract.id, "linked to a subcontract", "unresolved_link");
  // An amount a person confirmed from an image is human evidence, never "verbatim": the trace names who and where.
  const confirmed = i.bc.amountConfirmation;
  rule(i.evidenceVerified, confirmed ? `amount confirmed by ${confirmed.by} from ${confirmed.from}` : "all evidence verbatim in source", "unverified_evidence");
  rule(!i.disputeInSource, "no dispute noted in source", "dispute_noted_in_source");

  const clause = i.subcontract?.clause ?? null;
  rule(clause !== null, "subcontract has a back-charge clause", "no_clause");
  if (clause) rule(clause.deductionAllowed, `${clause.section} allows deduction from payments`, "clause_forbids_deduction");
  rule(!!i.subcontract?.paymentsVendorId, "subcontract party mapped to a payments vendor", "no_payments_vendor");

  if (i.phase === "final" && clause?.noticeRequired) {
    const sent = i.notice !== null && i.notice.state === "sent" && i.notice.sentAt !== null && i.notice.backChargeRefs.includes(i.bc.ref);
    rule(sent, `${clause.section} notice sent for ${i.bc.ref}`, "no_notice_evidence");
    rule(i.bc.subResponse !== "disputed", "not disputed by sub", "disputed_by_sub");
    if (sent && i.bc.subResponse !== "disputed") {
      const closes = windowCloses(i.notice!.sentAt!, clause.responseWindow);
      // Deliberately no early exit on "accepted": acceptance is read by the model from free text,
      // so only the contractual window closing makes an item final.
      rule(i.now.getTime() >= closes.getTime(), `response window closed (${closes.toISOString().slice(0, 16).replace("T", " ")} UTC)`);
    }
  }

  const status = hold.length ? "held" : pending.length ? "pending" : "eligible";
  return { status, holdReasons: hold, pendingReasons: pending, trace };
}
