import { findUsdAmounts, unreadableUsd } from "../money.ts";
import { attachmentPages, normalize } from "../span.ts";
import type { Email, Evidence, ExtractedBackCharge, ExtractedResponse, RejectedExtraction } from "../types.ts";

/**
 * Strict checks on model output BEFORE it enters the workflow. Anything off-shape is rejected with a
 * reason (and shown to the PM), never repaired by guessing. Money comes only from parsing the text
 * the model copied, never from a number the model produced.
 */

const isRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const str = (x: unknown, max: number): string | null => (typeof x === "string" && x.trim().length > 0 && x.length <= max ? x.trim() : null);

export function normalizeRef(x: string): string | null {
  const m = /^\s*BC[\s-]?(\d{3,6})\s*$/i.exec(x);
  return m ? `BC-${m[1]}` : null;
}

/**
 * True when the email's own text names this BC number: its subject, body (quoted mail included) or a page
 * of an attachment read as text, written "BC-4467", "BC 4467", "BC4467" or as the bare number. An email
 * with an attachment the model saw as an image may carry the number only there, where code can't read it,
 * so that email isn't checked.
 */
export function refInEmail(ref: string, email: Email): boolean {
  if (email.attachments?.some((a) => a.read === "image")) return true;
  const digits = ref.replace(/^\D+/, "");
  const re = new RegExp(`(?<![A-Za-z0-9$,.])(?:BC[ #-]?)?${digits}(?![0-9]|[.,]\\d)`, "i");
  return [email.subject, email.body, ...attachmentPages(email).map((p) => p.text)].some((t) => re.test(normalize(t)));
}

const ITEM_KEYS = new Set([
  "ref", "description", "amountText", "amountSentence", "vendorNameAsWritten", "jobRef", "disputeNoted", "disputeSentence",
  // Only asked for when the email has attachments; absent (or 0) means the sentence is in the email body.
  "amountAttachment", "amountPage", "disputeAttachment", "disputePage",
]);

/**
 * Where the model says a sentence is: undefined for the body (attachment absent or 0), else attachment n
 * and a page, which must be an attachment the model was shown and a page it has. A photo is page 1.
 * Only the location is taken from the model; whether the sentence is really there is checked in code.
 */
function citedAt(raw: Record<string, unknown>, aKey: string, pKey: string, email: Email): { ok: true; at?: Evidence["at"] } | { ok: false; reason: string; words: string } {
  const a = raw[aKey];
  const p = raw[pKey];
  if (a === undefined || a === 0) return { ok: true };
  if (!Number.isSafeInteger(a) || (a as number) < 0) return { ok: false, reason: `${aKey} must be a whole number`, words: "the model named an attachment that isn't a number" };
  const att = email.attachments?.find((x) => x.n === a);
  if (!att || att.read === "skipped") {
    const words = att
      ? `the model said the amount is in ${att.filename}, which wasn't read (${att.reason ?? "skipped"})`
      : `the model said the amount is in attachment ${a}, but the email has no attachment ${a}`;
    return { ok: false, reason: `${aKey} ${a} is not an attachment that was read`, words };
  }
  const pages = att.read === "text" ? att.pages?.length ?? 0 : att.pageCount ?? 1;
  const nPages = (n: number) => `${n} page${n === 1 ? "" : "s"}`;
  const page = p === undefined ? (pages === 1 ? 1 : null) : p;
  if (page === null) {
    return { ok: false, reason: `${pKey} is missing for ${att.filename}, which has ${pages} pages`, words: `the model didn't say which page of ${att.filename} (${nPages(pages)}) the amount is on` };
  }
  if (!Number.isSafeInteger(page) || (page as number) < 1 || (page as number) > pages) {
    const shown = String(page).slice(0, 20);
    return { ok: false, reason: `${pKey} ${shown} is not a page of ${att.filename} (1-${pages})`, words: `the model said the amount is on page ${shown} of ${att.filename}, which has only ${nPages(pages)}` };
  }
  return { ok: true, at: { attachment: a as number, page: page as number } };
}

/** An item (or, index -1, the whole output) the validator refused; see RejectedExtraction. */
export type Rejected = RejectedExtraction;

export function parseBackCharges(input: unknown, email: Email): { items: ExtractedBackCharge[]; rejected: Rejected[] } {
  const items: ExtractedBackCharge[] = [];
  const rejected: Rejected[] = [];
  if (!isRecord(input) || !Array.isArray(input.items) || Object.keys(input).some((k) => k !== "items")) {
    return { items, rejected: [{ index: -1, reason: "output is not {items: [...]}", words: "the model's answer for this email wasn't in the expected form, so nothing in it was taken in" }] };
  }
  if (input.items.length > 20) return { items, rejected: [{ index: -1, reason: "more than 20 items", words: "the model listed more than 20 back-charges in this one email, so none of them were taken in" }] };
  const seen = new Set<string>();

  input.items.forEach((raw, index) => {
    let ref: string | null = null;
    // `ref` is attached once it reads as a BC number, so the PM sees which back-charge it was.
    const bad = (reason: string, words: string) => rejected.push({ index, reason, words, ...(ref ? { ref } : {}) });
    if (!isRecord(raw)) return bad("item is not an object", "the model returned an item that couldn't be read");
    ref = typeof raw.ref === "string" ? normalizeRef(raw.ref) : null;
    const extra = Object.keys(raw).filter((k) => !ITEM_KEYS.has(k));
    if (extra.length) return bad(`unexpected fields: ${extra.slice(0, 5).join(", ")}`, "the model returned an item with details Contra doesn't ask for");
    // null: the email gives this charge no BC number (usual for a first email). Anything else must be a BC
    // number; "UNKNOWN", "" or "Item 7" is refused, never read as "no number".
    if (raw.ref !== null && !ref) return bad("ref is not a BC number or null", "the model gave a back-charge number that isn't in the form BC-1234");
    if (ref && seen.has(ref)) return bad(`${ref} appears twice`, `the model listed ${ref} twice from this email`);
    const tag = ref ?? `item ${index + 1} (no BC number)`;
    const description = str(raw.description, 200);
    const amountText = str(raw.amountText, 40);
    const amountSentence = str(raw.amountSentence, 1000);
    const vendor = str(raw.vendorNameAsWritten, 120);
    const jobRef = str(raw.jobRef, 120);
    if (!description || !amountText || !amountSentence || !vendor || !jobRef) {
      return bad(`${tag}: missing or oversized field`, "the model left out a detail (description, amount, quoted sentence, sub's name or job), or gave one that is too long");
    }
    if (typeof raw.disputeNoted !== "boolean") return bad(`${tag}: disputeNoted must be true or false`, "the model didn't say whether the back-charge is disputed");
    // An amount that can't be read exactly (in the copied text or anywhere in its sentence) is never
    // guessed or truncated: "$1,200.5" must not pass as "$1,200" just because that is a substring.
    const unreadable = [...new Set([...unreadableUsd(amountText), ...unreadableUsd(amountSentence)])];
    if (unreadable.length) {
      const list = unreadable.map((u) => `"${u}"`).join(", ");
      return bad(`${tag}: amount can't be read exactly: ${list}`, `the amount can't be read exactly (${list})`);
    }
    const amounts = findUsdAmounts(amountText);
    if (amounts.length !== 1) return bad(`${tag}: amountText "${amountText}" is not exactly one $ amount`, "the model's amount isn't exactly one dollar amount");
    if (!normalize(amountSentence).includes(normalize(amountText))) return bad(`${tag}: amountText not inside amountSentence`, "the amount the model gave isn't in the sentence it quoted");
    const amountAt = citedAt(raw, "amountAttachment", "amountPage", email);
    if (!amountAt.ok) return bad(`${tag}: ${amountAt.reason}`, amountAt.words);
    let disputeEvidence: ExtractedBackCharge["disputeEvidence"];
    if (raw.disputeNoted) {
      const ds = str(raw.disputeSentence, 1000);
      // A dispute without its sentence still counts as a dispute (conservative); the span check will flag it.
      // A dispute cited at an impossible place is kept too, cited in the body, where the span check fails.
      const disputeAt = citedAt(raw, "disputeAttachment", "disputePage", email);
      disputeEvidence = { emailId: email.id, sentence: ds ?? "", ...(disputeAt.ok && disputeAt.at ? { at: disputeAt.at } : {}) };
    }
    // A BC number must be the email's own, never invented: one the email doesn't contain is refused.
    if (ref && !refInEmail(ref, email)) return bad(`${ref} is not in the email`, `the model gave ${ref}, which isn't in the email (a back-charge number is never made up)`);
    if (ref) seen.add(ref);
    items.push({
      ref,
      description,
      amountCents: amounts[0]!,
      amountEvidence: { emailId: email.id, sentence: amountSentence, ...(amountAt.at ? { at: amountAt.at } : {}) },
      vendorNameAsWritten: vendor,
      jobRef,
      disputeNoted: raw.disputeNoted,
      ...(disputeEvidence ? { disputeEvidence } : {}),
    });
  });
  return { items, rejected };
}

export function parseResponse(input: unknown, email: Email, noticeId: string, noticeRefs: readonly string[]): { ok: true; value: ExtractedResponse } | { ok: false; reason: string } {
  if (!isRecord(input)) return { ok: false, reason: "output is not an object" };
  const extra = Object.keys(input).filter((k) => !["disputedRefs", "acceptedRefs", "evidenceSentence"].includes(k));
  if (extra.length) return { ok: false, reason: `unexpected fields: ${extra.join(", ")}` };
  const refs = (x: unknown) => (Array.isArray(x) && x.length <= 50 && x.every((r) => typeof r === "string") ? (x as string[]).map(normalizeRef) : null);
  const disputed = refs(input.disputedRefs);
  const accepted = refs(input.acceptedRefs);
  const sentence = str(input.evidenceSentence, 1000);
  if (!disputed || !accepted || !sentence) return { ok: false, reason: "missing or malformed fields" };
  if (disputed.includes(null) || accepted.includes(null)) return { ok: false, reason: "a ref is not a BC number" };
  const unknown = [...disputed, ...accepted].filter((r) => !noticeRefs.includes(r!));
  if (unknown.length) return { ok: false, reason: `refs not in notice ${noticeId}: ${unknown.join(", ")}` };
  const both = accepted.filter((r) => disputed.includes(r));
  // Contradiction: treat as disputed (conservative) by dropping it from accepted.
  return {
    ok: true,
    value: { noticeId, disputedRefs: disputed as string[], acceptedRefs: (accepted as string[]).filter((r) => !both.includes(r)), evidence: { emailId: email.id, sentence } },
  };
}
