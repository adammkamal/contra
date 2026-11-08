import { findUsdAmounts, type Cents } from "./money.ts";
import type { Email, Evidence } from "./types.ts";

/**
 * Normalization is whitespace and typography only. It never changes words or digits.
 * Quoted reply lines ("> ...") are removed when excludeQuoted is set, so evidence for a
 * sub's reply can't come from our own notice quoted back at us.
 */
export function normalize(text: string, opts: { excludeQuoted?: boolean } = {}): string {
  let lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (opts.excludeQuoted) {
    lines = lines.filter((l) => !/^\s*>/.test(l));
    const cut = lines.findIndex((l) => /^On .+ wrote:\s*$/.test(l.trim()));
    if (cut >= 0) lines = lines.slice(0, cut);
  }
  return lines
    .join("\n")
    .replace(/[   ]/g, " ")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export type SpanResult = { ok: true } | { ok: false; reason: string };

export function verifySpan(email: Email, ev: Evidence, opts: { excludeQuoted?: boolean } = {}): SpanResult {
  if (ev.emailId !== email.id) return { ok: false, reason: `evidence cites ${ev.emailId}, not ${email.id}` };
  const needle = normalize(ev.sentence);
  if (needle.length < 8) return { ok: false, reason: "evidence sentence too short to be meaningful" };
  if (!normalize(email.body, opts).includes(needle)) {
    return { ok: false, reason: "evidence sentence not found verbatim in email" };
  }
  return { ok: true };
}

/** The span must exist AND contain exactly one dollar amount, equal to the extracted amount. */
export function verifyAmountEvidence(email: Email, ev: Evidence, amount: Cents): SpanResult {
  const span = verifySpan(email, ev);
  if (!span.ok) return span;
  const amounts = findUsdAmounts(normalize(ev.sentence));
  if (amounts.length !== 1) return { ok: false, reason: `evidence has ${amounts.length} dollar amounts; need exactly 1` };
  if (amounts[0] !== amount) return { ok: false, reason: `evidence says ${amounts[0]} cents, extraction says ${amount}` };
  return { ok: true };
}

const DISPUTE_WORDS = /\b(disput\w*|disagree\w*|contest\w*|object\w*|reject\w*|not (?:ours|our fault|responsible)|push(?:ing)? back)\b/i;

/**
 * Code backstop for a dispute the model may have missed: any sentence that names the ref
 * and contains a dispute word. Used only to make outcomes MORE conservative.
 */
export function disputeSentencesFor(body: string, ref: string, opts: { excludeQuoted?: boolean } = {}): string[] {
  const refNum = ref.replace(/^\D+/, "");
  const refRe = new RegExp(`\\b(?:BC-?)?${refNum}\\b`);
  return normalize(body, opts)
    .split(/(?<=[.!?])\s+/)
    .filter((s) => refRe.test(s) && DISPUTE_WORDS.test(s));
}
