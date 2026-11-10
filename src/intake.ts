import { resolve, type ResolverData, type Resolution } from "./resolver.ts";
import { disputeSentencesFor, verifyAmountEvidence, verifySpan } from "./span.ts";
import type { Email, ExtractedBackCharge, HoldReason } from "./types.ts";

/** What ingest decides for one extracted back-charge, before any state changes. */
export interface IntakeAssessment {
  /** Every span check on the item's evidence passed (the amount, and the dispute sentence when the model cited one). */
  evidenceOk: boolean;
  /** Model-flagged dispute OR code backstop hit. Either one later holds the item in eligibility. */
  disputeInSource: boolean;
  /** Code backstop sentences (ref + dispute word), for the audit log. */
  backstop: string[];
  /** Non-empty: the item is held at ingest and goes to the PM queue. */
  holdReasons: HoldReason[];
  /** Why it was held, in words, for the audit log. */
  holdEvidence: string[];
  /** Resolver result. null when the item is held: a held item is not linked automatically. */
  resolution: Resolution | null;
}

/**
 * The per-item checks Contra applies at ingest: span checks, dispute flag plus code backstop, and
 * the resolver link. Pure and deterministic. Contra.ingestBackChargeEmail and the benchmark
 * (bench/lib.ts contraDecide) both call this, so the benchmark scores the product's real rules.
 */
export function assessExtractedItem(email: Email, x: ExtractedBackCharge, data: ResolverData): IntakeAssessment {
  const amountCheck = verifyAmountEvidence(email, x.amountEvidence, x.amountCents);
  const disputeCheck = x.disputeNoted && x.disputeEvidence ? verifySpan(email, x.disputeEvidence) : { ok: true as const };
  const backstop = disputeSentencesFor(email.body, x.ref);
  const evidenceOk = amountCheck.ok && disputeCheck.ok;
  const disputeInSource = x.disputeNoted || backstop.length > 0;

  const holdReasons: HoldReason[] = [];
  const holdEvidence: string[] = [];
  if (!evidenceOk) {
    holdReasons.push("unverified_evidence");
    holdEvidence.push(...[!amountCheck.ok ? amountCheck.reason : "", !disputeCheck.ok ? disputeCheck.reason : ""].filter(Boolean));
  }

  const resolution = holdReasons.length ? null : resolve(x, data);
  return { evidenceOk, disputeInSource, backstop, holdReasons, holdEvidence, resolution };
}
