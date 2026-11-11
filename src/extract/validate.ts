import { findUsdAmounts, unreadableUsd } from "../money.ts";
import { normalize } from "../span.ts";
import type { Email, Evidence, ExtractedBackCharge, ExtractedResponse } from "../types.ts";

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
function citedAt(raw: Record<string, unknown>, aKey: string, pKey: string, email: Email): { ok: true; at?: Evidence["at"] } | { ok: false; reason: string } {
  const a = raw[aKey];
  const p = raw[pKey];
  if (a === undefined || a === 0) return { ok: true };
  if (!Number.isSafeInteger(a) || (a as number) < 0) return { ok: false, reason: `${aKey} must be a whole number` };
  const att = email.attachments?.find((x) => x.n === a);
  if (!att || att.read === "skipped") return { ok: false, reason: `${aKey} ${a} is not an attachment that was read` };
  const pages = att.read === "text" ? att.pages?.length ?? 0 : att.pageCount ?? 1;
  const page = p === undefined ? (pages === 1 ? 1 : null) : p;
  if (page === null) return { ok: false, reason: `${pKey} is missing for ${att.filename}, which has ${pages} pages` };
  if (!Number.isSafeInteger(page) || (page as number) < 1 || (page as number) > pages) return { ok: false, reason: `${pKey} ${String(page).slice(0, 20)} is not a page of ${att.filename} (1-${pages})` };
  return { ok: true, at: { attachment: a as number, page: page as number } };
}

export interface Rejected {
  index: number;
  reason: string;
}

export function parseBackCharges(input: unknown, email: Email): { items: ExtractedBackCharge[]; rejected: Rejected[] } {
  const items: ExtractedBackCharge[] = [];
  const rejected: Rejected[] = [];
  if (!isRecord(input) || !Array.isArray(input.items) || Object.keys(input).some((k) => k !== "items")) {
    return { items, rejected: [{ index: -1, reason: "output is not {items: [...]}" }] };
  }
  if (input.items.length > 20) return { items, rejected: [{ index: -1, reason: "more than 20 items" }] };
  const seen = new Set<string>();

  input.items.forEach((raw, index) => {
    const bad = (reason: string) => rejected.push({ index, reason });
    if (!isRecord(raw)) return bad("item is not an object");
    const extra = Object.keys(raw).filter((k) => !ITEM_KEYS.has(k));
    if (extra.length) return bad(`unexpected fields: ${extra.slice(0, 5).join(", ")}`);
    const ref = typeof raw.ref === "string" ? normalizeRef(raw.ref) : null;
    if (!ref) return bad("ref is not a BC number");
    if (seen.has(ref)) return bad(`${ref} appears twice`);
    const description = str(raw.description, 200);
    const amountText = str(raw.amountText, 40);
    const amountSentence = str(raw.amountSentence, 1000);
    const vendor = str(raw.vendorNameAsWritten, 120);
    const jobRef = str(raw.jobRef, 120);
    if (!description || !amountText || !amountSentence || !vendor || !jobRef) return bad(`${ref}: missing or oversized field`);
    if (typeof raw.disputeNoted !== "boolean") return bad(`${ref}: disputeNoted must be true or false`);
    // An amount that can't be read exactly (in the copied text or anywhere in its sentence) is never
    // guessed or truncated: "$1,200.5" must not pass as "$1,200" just because that is a substring.
    const unreadable = [...new Set([...unreadableUsd(amountText), ...unreadableUsd(amountSentence)])];
    if (unreadable.length) return bad(`${ref}: amount can't be read exactly: ${unreadable.map((u) => `"${u}"`).join(", ")}`);
    const amounts = findUsdAmounts(amountText);
    if (amounts.length !== 1) return bad(`${ref}: amountText "${amountText}" is not exactly one $ amount`);
    if (!normalize(amountSentence).includes(normalize(amountText))) return bad(`${ref}: amountText not inside amountSentence`);
    const amountAt = citedAt(raw, "amountAttachment", "amountPage", email);
    if (!amountAt.ok) return bad(`${ref}: ${amountAt.reason}`);
    let disputeEvidence: ExtractedBackCharge["disputeEvidence"];
    if (raw.disputeNoted) {
      const ds = str(raw.disputeSentence, 1000);
      // A dispute without its sentence still counts as a dispute (conservative); the span check will flag it.
      // A dispute cited at an impossible place is kept too, cited in the body, where the span check fails.
      const disputeAt = citedAt(raw, "disputeAttachment", "disputePage", email);
      disputeEvidence = { emailId: email.id, sentence: ds ?? "", ...(disputeAt.ok && disputeAt.at ? { at: disputeAt.at } : {}) };
    }
    seen.add(ref);
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
