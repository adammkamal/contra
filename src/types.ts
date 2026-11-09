import type { Cents } from "./money.ts";

export type Actor =
  | { kind: "system"; id: string }
  | { kind: "llm"; id: string; model: string }
  | { kind: "human"; id: string; role: "pm" | "controller" | "ap" };

export interface Job {
  id: string;
  name: string;
  aliases: string[];
}

export interface BackChargeClause {
  section: string;
  text: string;
  deductionAllowed: boolean;
  noticeRequired: boolean;
  /** How long the sub has to respond. AIA A401 uses working days; custom subcontracts often use hours. */
  responseWindow: ResponseWindow;
}

export interface ResponseWindow {
  amount: number;
  unit: "hours" | "calendar_days" | "working_days";
}

export interface Subcontract {
  id: string;
  jobId: string;
  partyLegalName: string;
  scope: string;
  valueCents: Cents;
  clause: BackChargeClause | null;
  /** Vendor record in the payments platform, mapped by a human at setup. */
  paymentsVendorId: string | null;
}

export interface Alias {
  alias: string;
  partyLegalName: string;
  source: "seed" | "pm_confirmed";
  confirmedBy?: string;
}

export interface Email {
  id: string;
  from: string;
  to: string;
  subject: string;
  receivedAt: Date;
  body: string;
}

/** Where an ingested PM email came from: an .eml file read by ingest/eml.ts, or the built-in sample in seed.ts. */
export type EmailOrigin = "eml" | "builtin";

/** Audit action for an ingested PM email, by origin. "ingested" alone (older logs too) means built-in. */
export const EMAIL_INGESTED: Record<EmailOrigin, string> = { builtin: "ingested", eml: "ingested from .eml file" };

/** A sentence quoted from a specific email. Must pass the span check before use. */
export interface Evidence {
  emailId: string;
  sentence: string;
}

/** What the extractor (LLM) returns for one back-charge. Untrusted until verified. */
export interface ExtractedBackCharge {
  ref: string;
  description: string;
  amountCents: Cents;
  amountEvidence: Evidence;
  vendorNameAsWritten: string;
  jobRef: string;
  disputeNoted: boolean;
  disputeEvidence?: Evidence;
}

/** What the extractor returns for a sub's reply to a notice. Untrusted until verified. */
export interface ExtractedResponse {
  noticeId: string;
  disputedRefs: string[];
  acceptedRefs: string[];
  evidence: Evidence;
}

export type BackChargeState =
  | "extracted"
  | "needs_review"
  | "linked"
  | "noticed"
  | "held"
  | "eligible"
  | "credited"
  | "applied";

export type HoldReason =
  | "dispute_noted_in_source"
  | "disputed_by_sub"
  | "no_clause"
  | "clause_forbids_deduction"
  | "no_notice_evidence"
  | "no_payments_vendor"
  | "unverified_evidence"
  | "conflicting_amounts"
  | "unresolved_link";

export interface BackCharge {
  ref: string;
  extracted: ExtractedBackCharge;
  state: BackChargeState;
  subcontractId: string | null;
  linkExplanation: string[];
  noticeId: string | null;
  subResponse: "accepted" | "disputed" | null;
  holdReasons: HoldReason[];
  creditId: string | null;
}

export type NoticeState = "drafted" | "approved" | "sent";

export interface Notice {
  id: string;
  subcontractId: string;
  backChargeRefs: string[];
  totalCents: Cents;
  body: string;
  state: NoticeState;
  approvedBy: string | null;
  sentAt: Date | null;
}

export type CreditState = "proposed" | "rejected" | "approved" | "synced" | "applied";

export interface Credit {
  id: string;
  subcontractId: string;
  vendorId: string;
  jobId: string;
  amountCents: Cents;
  backChargeRefs: string[];
  state: CreditState;
  approvedBy: string | null;
}
