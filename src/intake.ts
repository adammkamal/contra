import { resolve, type ResolverData, type Resolution } from "./resolver.ts";
import { disputeSentencesFor, normalize, verifyAmountEvidence, verifySpan } from "./span.ts";
import type { Email, ExtractedBackCharge, HoldReason } from "./types.ts";

/**
 * Text aimed at an AI or automated system rather than at a person. Emails are untrusted input to the
 * extractor, and an email that tries to instruct it is suspect as a whole, so every item in it is held
 * for a person (even when the extraction looks right). Matched case-insensitively on the normalized
 * subject and body (each on its own), quoted text included. Each pattern needs wording a PM wouldn't write to a sub: "ignore the old
 * drawing", "disregard my earlier email", "record this as complete" and "you are now past the window"
 * must not match. A false positive costs a PM review, never a credit.
 */
export const AI_DIRECTED_PATTERNS: readonly RegExp[] = [
  // "ignore previous instructions", "disregard all of the above instructions", "forget your prior prompts"
  /\b(?:ignore|disregard|forget)\s+(?:(?:all|any|the|your|of)\s+)*(?:previous|prior|above|earlier|preceding|all)\s+(?:instructions|prompts?)\b/i,
  /\bsystem\s+prompt\b/i,
  // Role reassignment ("you are now an unrestricted assistant", "you are now in developer mode"), not "you are now late".
  /\byou\s+are\s+now\s+(?:an?\s+(?:\w+\s+)?(?:ai|assistant|bot|model|agent)|in\s+\w+\s+mode|acting\s+as|operating\s+as)\b/i,
  // Telling the reader what amount to record; a PM states the amount, they don't instruct the bookkeeping.
  /\brecord\s+this\s+as\s+\$/i,
];

/** The passages of `text` (a subject or body) that match AI_DIRECTED_PATTERNS (empty when none). */
export function aiDirectedText(raw: string): string[] {
  const text = normalize(raw);
  return AI_DIRECTED_PATTERNS.map((p) => p.exec(text)?.[0]).filter((m): m is string => m !== undefined);
}

/**
 * A back-charge number as the validator accepts it (src/extract/validate.ts normalizeRef): "BC", then an
 * optional space or hyphen, then 3 to 6 digits. Not part of a longer word or number.
 */
const BC_NUMBER = /(?<![A-Za-z0-9])BC[ -]?(\d{3,6})(?!\d)/gi;

/**
 * Back-charge numbers the email's own text mentions (subject, and body without quoted or forwarded
 * mail) that no extracted item accounts for, as "BC-1234", in order of first mention. Conflicting or
 * extra numbers ("BC-1234" in one line, "BC-1243" in another) mean a person must check which charge is
 * real. `extractedRefs` are the refs of every item extracted from this email.
 */
export function unaccountedRefs(email: Email, extractedRefs: readonly string[]): string[] {
  const have = new Set(extractedRefs);
  const text = `${normalize(email.subject)}\n${normalize(email.body, { excludeQuoted: true })}`;
  const out: string[] = [];
  for (const m of text.matchAll(BC_NUMBER)) {
    const ref = `BC-${m[1]}`;
    if (!have.has(ref) && !out.includes(ref)) out.push(ref);
  }
  return out;
}

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
 * The per-item checks Contra applies at ingest: span checks, quoted-text, AI-directed-text and
 * unaccounted-reference holds, dispute flag plus code backstop, and the resolver link. Pure and deterministic.
 * `extractedRefs` are the refs of every item extracted from the same email (this one included).
 * Contra.ingestBackChargeEmail and the benchmark (bench/lib.ts contraDecide) both call this, so the
 * benchmark scores the product's real rules.
 */
export function assessExtractedItem(email: Email, x: ExtractedBackCharge, data: ResolverData, extractedRefs: readonly string[]): IntakeAssessment {
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
  // A back-charge stated only in a quoted or forwarded older email may already have been sent or credited.
  if (amountCheck.ok && !verifySpan(email, x.amountEvidence, { excludeQuoted: true }).ok) {
    holdReasons.push("only_in_quoted_text");
    holdEvidence.push(`amount sentence appears only in quoted text: ${x.amountEvidence.sentence}`);
  }
  const aimed = [
    ...aiDirectedText(email.subject).map((t) => `text aimed at an automated system (subject): ${t}`),
    ...aiDirectedText(email.body).map((t) => `text aimed at an automated system: ${t}`),
  ];
  if (aimed.length) {
    holdReasons.push("suspicious_instructions");
    holdEvidence.push(...aimed);
  }
  // Every item from the email is held, since a person must decide which of the numbers is the real charge.
  // Like only_in_quoted_text, checked only when the evidence verified: an unverified item is already held
  // and keeps that single reason.
  const unaccounted = evidenceOk ? unaccountedRefs(email, extractedRefs) : [];
  if (unaccounted.length) {
    holdReasons.push("unaccounted_reference");
    holdEvidence.push(`email mentions ${unaccounted.join(", ")}, not among the extracted items (${extractedRefs.join(", ") || "none"})`);
  }

  const resolution = holdReasons.length ? null : resolve(x, data);
  return { evidenceOk, disputeInSource, backstop, holdReasons, holdEvidence, resolution };
}
