import { findUsdAmounts, unreadableUsd, type Cents } from "./money.ts";
import type { Email, EmailAttachment, Evidence } from "./types.ts";

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
  return ownLines(text, opts)
    .join("\n")
    .replace(/[   ]/g, " ")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** The text's lines, unnormalized; with excludeQuoted, without quoted or forwarded mail (as normalize). */
export function ownLines(text: string, opts: { excludeQuoted?: boolean } = {}): string[] {
  let lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (opts.excludeQuoted) {
    lines = lines.filter((l) => !/^\s*>/.test(l));
    const trimmed = lines.map((l) => l.trim());
    const cut = trimmed.findIndex((line, i) => QUOTE_START.some((starts) => starts(line, trimmed.slice(i + 1))));
    if (cut >= 0) lines = lines.slice(0, cut);
  }
  return lines;
}

/** `image`: the evidence is cited from an image (a photo or a scanned page), which can't be checked word for word. */
export type SpanResult = { ok: true } | { ok: false; reason: string; image?: true };

/** "attachment <name>, page <n>" for evidence in an attachment ("attachment <name>" for a photo), "email body" otherwise. */
export function describeAt(email: Email, at: Evidence["at"]): string {
  if (!at) return "email body";
  const a = email.attachments?.find((x) => x.n === at.attachment);
  const name = a ? a.filename : `#${at.attachment}`;
  return a && a.mediaType !== "application/pdf" ? `attachment ${name}` : `attachment ${name}, page ${at.page}`;
}

/** What became of an attachment, in words, for the audit log and the screens. */
export function describeAttachment(a: EmailAttachment): string {
  const pdf = a.mediaType === "application/pdf";
  const pages = (n: number | undefined) => `${n ?? "?"} page${n === 1 ? "" : "s"}`;
  if (a.read === "skipped") return `attachment ${a.filename} skipped: ${a.reason ?? "not read"}`;
  if (a.read === "text") return `attachment ${a.filename}: PDF, ${pages(a.pages?.length)}, text read`;
  return `attachment ${a.filename}: ${pdf ? `scanned PDF, ${pages(a.pageCount)}` : "photo"}, read by the model as an image (not verifiable word for word)`;
}

/** The text a sentence may be cited from: the body, or one page of an attachment read as text. */
type Source = { kind: "text"; text: string; quotable: boolean } | { kind: "image" } | { kind: "missing"; reason: string };

function sourceOf(email: Email, at: Evidence["at"]): Source {
  if (!at) return { kind: "text", text: email.body, quotable: true };
  const a: EmailAttachment | undefined = email.attachments?.find((x) => x.n === at.attachment);
  if (!a || a.read === "skipped") return { kind: "missing", reason: `evidence cites attachment ${at.attachment}, which was not read` };
  if (a.read === "image") return { kind: "image" };
  const page = a.pages?.[at.page - 1];
  if (page === undefined) return { kind: "missing", reason: `evidence cites page ${at.page} of ${a.filename}, which has ${a.pages?.length ?? 0}` };
  return { kind: "text", text: page, quotable: false };
}

/**
 * The sentence must appear (after normalization) in the text it cites: the body, or the locally extracted
 * text of the cited attachment page. An attachment is never quoted mail, so excludeQuoted applies to the body only.
 */
export function verifySpan(email: Email, ev: Evidence, opts: { excludeQuoted?: boolean } = {}): SpanResult {
  if (ev.emailId !== email.id) return { ok: false, reason: `evidence cites ${ev.emailId}, not ${email.id}` };
  const needle = normalize(ev.sentence);
  if (needle.length < 8) return { ok: false, reason: "evidence sentence too short to be meaningful" };
  const src = sourceOf(email, ev.at);
  if (src.kind === "missing") return { ok: false, reason: src.reason };
  if (src.kind === "image") {
    return { ok: false, image: true, reason: `evidence is read from an image (${describeAt(email, ev.at)}); nothing in an image can be verified word for word` };
  }
  if (!normalize(src.text, src.quotable ? opts : {}).includes(needle)) {
    return { ok: false, reason: ev.at ? `evidence sentence not found verbatim in ${describeAt(email, ev.at)}` : "evidence sentence not found verbatim in email" };
  }
  return { ok: true };
}

/**
 * Every text section of the email other than the body: each page of each attachment read as text,
 * with where it is ("attachment estimate.pdf, page 2").
 */
export function attachmentPages(email: Email): { where: string; at: { attachment: number; page: number }; text: string }[] {
  return (email.attachments ?? []).flatMap((a) =>
    a.read === "text" ? (a.pages ?? []).map((text, i) => ({ where: describeAt(email, { attachment: a.n, page: i + 1 }), at: { attachment: a.n, page: i + 1 }, text })) : [],
  );
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
