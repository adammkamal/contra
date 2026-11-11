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
  /** The RFC 5322 Message-ID (or, when a message has none, a stable stand-in). Ingest skips one it has already seen. */
  messageId?: string;
  /** How many attachments the message carried (read or not). */
  attachmentCount?: number;
  /**
   * What became of each attachment, in message order, numbered from 1 (`n`). Read outside src/ (ingest/),
   * so src/ sees only text and decisions, never file bytes. Absent on emails read before attachments were.
   */
  attachments?: EmailAttachment[];
}

/**
 * One attachment of a PM email, as ingest read it.
 * - "text": a PDF with a text layer on every page; `pages` holds each page's text, read locally. Evidence
 *   cited from it is verified word for word against `pages`, like the body.
 * - "image": a photo, or a PDF with a page that has no text layer (a scan). The model saw it as an image;
 *   nothing read from it can be verified word for word. `pageCount` is set for a PDF.
 * - "skipped": not read and not shown to the model; `reason` says why, in words.
 */
export interface EmailAttachment {
  n: number;
  filename: string;
  /** The detected type (from the file's bytes where possible): "application/pdf", "image/jpeg", ... */
  mediaType: string;
  read: "text" | "image" | "skipped";
  pages?: string[];
  pageCount?: number;
  reason?: string;
}

/** Bytes of an "image" attachment for the model call only. Never stored: ingest hands it straight to the extractor. */
export interface AttachmentMedia {
  /** The attachment's `n`. */
  n: number;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" | "application/pdf";
  data: Uint8Array;
}

/** Where an ingested PM email came from: an .eml file read by ingest/eml.ts, the built-in sample in seed.ts, or the live Gmail inbox. */
export type EmailOrigin = "eml" | "builtin" | "gmail";

/** Audit action for an ingested PM email, by origin. "ingested" alone (older logs too) means built-in. */
export const EMAIL_INGESTED: Record<EmailOrigin, string> = { builtin: "ingested", eml: "ingested from .eml file", gmail: "ingested from Gmail" };

/** A sentence quoted from a specific email. Must pass the span check before use. */
export interface Evidence {
  emailId: string;
  sentence: string;
  /** Where the sentence is, as the extractor cited it: attachment `attachment` (its `n`), page `page` (1 for a photo). Absent: the email body. */
  at?: { attachment: number; page: number };
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
  | "unresolved_link"
  | "only_in_quoted_text"
  | "suspicious_instructions"
  | "unaccounted_reference"
  | "amount_only_in_image";

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
  /** Delivery of this credit's memo to the AP inbox. Absent until someone asks to send it. */
  memoDelivery?: MemoDelivery;
}

/**
 * queued: about to be handed to the sender (if it stays queued, the process stopped mid-send and the
 * memo may or may not have gone out: a person must check before anything is sent again).
 * sent: the sender accepted it. failed: the sender refused it; only a failed memo may be retried.
 */
export type MemoState = "queued" | "sent" | "failed";

export interface MemoDelivery {
  state: MemoState;
  /** Where it was sent (the sender's destination). */
  to: string;
  attempts: number;
  /** The sender's id for the sent message. */
  messageId: string | null;
  /** Why the last attempt failed, in words. */
  error: string | null;
}
