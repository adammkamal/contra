import { findUsdAmounts, unreadableUsd, type Cents } from "./money.ts";
import type { Email, Evidence } from "./types.ts";

/**
 * Lines that start quoted or forwarded older mail. Each test sees trimmed lines and must match a whole
 * line (or, for the Outlook block, a run of header lines), so the same words inside a sentence don't count.
 */
const QUOTE_START: readonly ((line: string, following: readonly string[]) => boolean)[] = [
  // Reply header: "On Mon, Sep 14, 2026 at 9:15 AM Name <addr> wrote:"
  (line) => /^On .+ wrote:$/.test(line),
  // Outlook separator: "-----Original Message-----"
  (line) => /^-{3,}\s*Original Message\s*-{3,}$/i.test(line),
  // Forward separator: "---------- Forwarded message ---------"
  (line) => /^-{3,}\s*Forwarded message\s*-{3,}$/i.test(line),
  // Apple Mail forward
  (line) => /^Begin forwarded message:$/i.test(line),
  // Outlook header block: a "From:" line followed, within the next 4 lines, by "Sent:" or "Date:" and by
  // "To:" or "Subject:". A lone "From:" line in ordinary text has neither, so it doesn't count.
  (line, following) => {
    if (!/^From:/.test(line)) return false;
    const next = following.slice(0, 4);
    return next.some((l) => /^(?:Sent|Date):/.test(l)) && next.some((l) => /^(?:To|Subject):/.test(l));
  },
];

/**
 * Normalization is whitespace and typography only. It never changes words or digits.
 * When excludeQuoted is set, quoted reply lines ("> ...") are removed and everything from the first
 * reply or forward header (QUOTE_START) on is cut, so evidence for an email's own text can't come from
 * older mail quoted or forwarded inside it (e.g. our own notice quoted back at us).
 */
export function normalize(text: string, opts: { excludeQuoted?: boolean } = {}): string {
  let lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (opts.excludeQuoted) {
    lines = lines.filter((l) => !/^\s*>/.test(l));
    const trimmed = lines.map((l) => l.trim());
    const cut = trimmed.findIndex((line, i) => QUOTE_START.some((starts) => starts(line, trimmed.slice(i + 1))));
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
  const sentence = normalize(ev.sentence);
  const unreadable = unreadableUsd(sentence);
  if (unreadable.length) return { ok: false, reason: `evidence has an amount that can't be read exactly: ${unreadable.join(", ")}` };
  const amounts = findUsdAmounts(sentence);
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
