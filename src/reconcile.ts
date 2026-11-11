import { formatUsd, sum, ZERO, type Cents } from "./money.ts";
import type { RampBill, RampCredit } from "./mocks/ramp.ts";
import { resolve, type Resolution, type ResolverData } from "./resolver.ts";
import { disputeSentencesFor, disputeSentencesWithoutRef, verifyAmountEvidence } from "./span.ts";
import type { Email, ExtractedBackCharge, Subcontract } from "./types.ts";

/**
 * Read-only "missed back-charges" scan (shadow mode). Touches no workflow state and writes nothing:
 * it reads emails and the payments platform's credits and bills, which Ramp's API allows today.
 */

export interface ScanItem {
  /** The BC number, or null when the email gave none: then no credit or bill can name it, and only an amount match is possible. */
  ref: string | null;
  emailId: string;
  description: string;
  amountCents: Cents;
  link: Resolution;
  vendorId: string | null;
  disputed: boolean;
  evidenceOk: boolean;
}

export type ReconStatus = "deducted" | "possible_match" | "not_deducted" | "disputed" | "unlinked" | "unverified";

export interface ReconRow {
  item: ScanItem;
  status: ReconStatus;
  evidence: string;
}

export interface ReconResult {
  rows: ReconRow[];
  totals: Record<ReconStatus, Cents>;
}

export function scanEmails(
  emails: readonly Email[],
  extractions: Readonly<Record<string, readonly ExtractedBackCharge[]>>,
  data: ResolverData & { subcontract(id: string): Subcontract | null },
  opts: { disputedInReplies?: ReadonlySet<string> } = {},
): ScanItem[] {
  const out: ScanItem[] = [];
  for (const email of emails) {
    for (const x of extractions[email.id] ?? []) {
      const evidenceOk = verifyAmountEvidence(email, x.amountEvidence, x.amountCents).ok;
      const link = resolve(x, data);
      const sc = link.kind === "linked" ? data.subcontract(link.subcontractId) : null;
      out.push({
        ref: x.ref,
        emailId: email.id,
        description: x.description,
        amountCents: x.amountCents,
        link,
        vendorId: sc?.paymentsVendorId ?? null,
        // Sub replies must be fed in too, or a sub-disputed item would be reported as missed money.
        disputed:
          x.disputeNoted ||
          (x.ref === null ? disputeSentencesWithoutRef(email.body).length > 0 : disputeSentencesFor(email.body, x.ref).length > 0 || !!opts.disputedInReplies?.has(x.ref)),
        evidenceOk,
      });
    }
  }
  return out;
}

const mentions = (text: string | undefined, ref: string | null) =>
  !!text && ref !== null && new RegExp(`(?<![\\d-])(?:BC-?)?${ref.replace(/^\D+/, "")}(?!\\d)`).test(text);

/**
 * Deducted = a credit or short-paid bill FOR THE SAME VENDOR that names the ref.
 * Possible match = same vendor, exact amount, no ref named; needs a human. If one credit
 * amount-matches several refs, all of them are "possible" (never claim money missed when it may not be).
 * Disputed, unlinked and unverified items are reported separately and never counted as missed money.
 */
export function reconcile(items: readonly ScanItem[], ramp: { credits: readonly RampCredit[]; bills: readonly RampBill[] }): ReconResult {
  const rows: ReconRow[] = [];
  const claimed = new Set<string>();
  const pending: ScanItem[] = [];

  for (const item of items) {
    if (!item.evidenceOk) rows.push({ item, status: "unverified", evidence: "amount not verified in source email" });
    else if (item.link.kind !== "linked" || !item.vendorId) rows.push({ item, status: "unlinked", evidence: item.link.kind === "review" ? item.link.reasons.join("; ") : "no payments vendor" });
    else if (item.disputed) rows.push({ item, status: "disputed", evidence: "dispute noted in source" });
    else {
      const credit = ramp.credits.find((c) => c.vendorId === item.vendorId && mentions(c.memo, item.ref));
      const bill = ramp.bills.find((b) => b.vendorId === item.vendorId && b.status === "paid" && mentions(b.memo, item.ref));
      if (credit) {
        claimed.add(credit.id);
        rows.push({ item, status: "deducted", evidence: `credit ${credit.id}: "${credit.memo}"` });
      } else if (bill) {
        rows.push({ item, status: "deducted", evidence: `short-paid bill ${bill.id}: "${bill.memo}"` });
      } else pending.push(item);
    }
  }

  for (const item of pending) {
    const candidates = ramp.credits.filter((c) => c.vendorId === item.vendorId && c.amountCents === item.amountCents && !claimed.has(c.id));
    if (candidates.length) {
      rows.push({ item, status: "possible_match", evidence: `same vendor and amount, no ref: ${candidates.map((c) => c.id).join(", ")}` });
    } else {
      rows.push({ item, status: "not_deducted", evidence: `no credit or short-pay for ${item.vendorId} names ${item.ref ?? "it (it has no BC number)"} or equals ${formatUsd(item.amountCents)}` });
    }
  }

  const statuses: ReconStatus[] = ["deducted", "possible_match", "not_deducted", "disputed", "unlinked", "unverified"];
  const totals = Object.fromEntries(statuses.map((s) => [s, ZERO])) as Record<ReconStatus, Cents>;
  for (const s of statuses) totals[s] = sum(rows.filter((r) => r.status === s).map((r) => r.item.amountCents));
  return { rows, totals };
}
