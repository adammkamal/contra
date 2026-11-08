import { sum, type Cents } from "./money.ts";
import type { BackCharge } from "./types.ts";

export class IneligibleForCredit extends Error {}

/**
 * The only path from back-charges to a credit amount. Refuses anything not in state "eligible",
 * anything with a dispute, and mixing subcontracts (INVARIANT 4).
 */
export function creditAmountFor(items: readonly Readonly<BackCharge>[]): { subcontractId: string; amountCents: Cents } {
  if (items.length === 0) throw new IneligibleForCredit("no items");
  for (const b of items) {
    if (b.state !== "eligible") throw new IneligibleForCredit(`${b.ref} is ${b.state}, not eligible`);
    if (b.subResponse === "disputed" || b.extracted.disputeNoted || b.holdReasons.length) {
      throw new IneligibleForCredit(`${b.ref} has a dispute or hold`);
    }
    if (b.creditId) throw new IneligibleForCredit(`${b.ref} is already on credit ${b.creditId}`);
  }
  const scs = new Set(items.map((b) => b.subcontractId));
  if (scs.size !== 1 || !items[0]!.subcontractId) throw new IneligibleForCredit("items span more than one subcontract");
  return { subcontractId: items[0]!.subcontractId, amountCents: sum(items.map((b) => b.extracted.amountCents)) };
}
