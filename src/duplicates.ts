import { formatUsd, type Cents } from "./money.ts";

/**
 * Whether two back-charges are plausibly the same charge. Pure and deterministic. A first back-charge
 * email usually has no BC number and a follow-up often cites the one accounting assigned, so the same
 * charge can arrive twice under two references. It must never be charged twice: a match holds the newer
 * item for the PM to decide (src/workflow.ts), never merges on its own.
 */
export interface DuplicateView {
  ref: string;
  /** The accounting BC number, or null while there is none. */
  bcNumber: string | null;
  /** The item's subcontract (linked, or the resolver's link), or null when it has none yet. */
  subcontractId: string | null;
  jobId: string | null;
  amountCents: Cents;
  description: string;
}

/** Words too common in back-charge descriptions to say two descriptions are about the same thing. */
const COMMON = new Set([
  "the", "and", "for", "from", "with", "per", "our", "their", "its", "his", "her", "this", "that", "was", "were", "has", "had",
  "back", "charge", "charges", "backcharge", "cost", "costs", "work", "repair", "repairs", "repaired", "replace", "replaced",
  "replacement", "damage", "damaged", "sub", "crew", "level", "floor", "area", "job", "site", "summit", "lakeview", "invoice",
]);

/** The words of a description that say what the charge is about: letters only, 3+ long, not common. */
export function significantWords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((w) => !COMMON.has(w)));
}

/**
 * Why `a` and `b` may be the same charge, in words, or null. Both must have the same subcontract (and so
 * the same job), and at least one must lack a BC number: two different accounting numbers are two charges,
 * and the same number is the same item already. Then either
 * - the same amount, or
 * - one has a BC number and the other doesn't, and their descriptions overlap (an initial amount is often
 *   an estimate, so the follow-up's amount may differ): they share at least two significant words, or
 *   every significant word of the shorter one when it has fewer than two.
 */
export function duplicateReason(a: DuplicateView, b: DuplicateView): string | null {
  if (!a.subcontractId || a.subcontractId !== b.subcontractId || a.jobId !== b.jobId) return null;
  if (a.bcNumber !== null && b.bcNumber !== null) return null;
  const where = `same subcontract (${a.subcontractId}) and job (${a.jobId ?? "?"})`;
  if (a.amountCents === b.amountCents) return `${where}, same amount (${formatUsd(a.amountCents)})`;
  if ((a.bcNumber === null) === (b.bcNumber === null)) return null;
  const wa = significantWords(a.description);
  const wb = significantWords(b.description);
  const shared = [...wa].filter((w) => wb.has(w));
  const need = Math.min(2, wa.size, wb.size);
  if (need === 0 || shared.length < need) return null;
  return `${where}, overlapping description (${shared.map((w) => `"${w}"`).join(", ")}); amounts ${formatUsd(a.amountCents)} and ${formatUsd(b.amountCents)}`;
}
