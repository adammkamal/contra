/**
 * "Try any email": runs the real extraction and the real ingest checks on an email a person typed or
 * pasted, and reports what Contra would do with it. Read-only: it never calls app.run, never ingests,
 * and checks against a copy of the ERP data, so the demo state and the audit log stay exactly as they were.
 * Lives outside src/ because it calls the model (CLAUDE.md: no model calls in src/ except src/extract/).
 * Privacy: the email's text, subject and addresses are never logged, written to disk or put in an error
 * message, on any path (test/try.test.ts "privacy: ..." checks console, stdout/stderr, the database and errors).
 */
import { performance } from "node:perf_hooks";
import type { App } from "../src/app.ts";
import type { ModelSettings } from "../src/extract/anthropic.ts";
import { extractBackCharges, type ExtractOptions } from "../src/extract/index.ts";
import { assessExtractedItem } from "../src/intake.ts";
import { formatUsd } from "../src/money.ts";
import type { ResolverData } from "../src/resolver.ts";
import { verifyAmountEvidence, verifySpan } from "../src/span.ts";
import type { Email, ExtractedBackCharge } from "../src/types.ts";
import { HOLD_WORDS } from "../src/view.ts";

export interface TryInput {
  from?: string;
  to?: string;
  subject: string;
  body: string;
}

export interface TryCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface TryItem {
  ref: string;
  amount: string;
  description: string;
  vendorAsWritten: string;
  jobRef: string;
  sourceSentence: string;
  /** [start, end) of sourceSentence in the body as sent (whitespace-tolerant), or null when it isn't there. */
  highlight: [number, number] | null;
  checks: TryCheck[];
  holdReasons: string[];
  link: { subcontractId: string | null; explanation: string[] };
  /** What Contra would do with the item next, computed from the checks above (see tryOutcome). Never a credit. */
  outcome: TryOutcome;
}

/**
 * - held_at_intake: a check held it at ingest (holdReasons says why); a person must look at it.
 * - will_hold_dispute: not held at ingest, but a dispute is noted in the email, so eligibility holds it.
 * - needs_link: not held and no dispute, but it couldn't be linked to one subcontract; a PM must choose.
 * - ready_for_notice: linked, not held, no dispute: next comes the PM's confirmation and a notice to the sub.
 */
export type TryOutcome = "held_at_intake" | "will_hold_dispute" | "needs_link" | "ready_for_notice";

export const DISPUTE_CHECK = "No dispute noted in the email";
export const LINK_CHECK = "Linked to one subcontract";

/** The outcome, from the item's hold reasons and checks only, in this order. */
export function tryOutcome(holdReasons: readonly string[], checks: readonly TryCheck[]): TryOutcome {
  if (holdReasons.length) return "held_at_intake";
  if (checks.some((c) => c.name === DISPUTE_CHECK && !c.passed)) return "will_hold_dispute";
  if (!checks.some((c) => c.name === LINK_CHECK && c.passed)) return "needs_link";
  return "ready_for_notice";
}

export interface TryResult {
  model: string;
  latencyMs: number;
  note: string;
  items: TryItem[];
  rejected: { reason: string }[];
}

export const TRY_NOTE =
  "outcome is what Contra would do next, not a credit. held_at_intake: a check held the item when the email came in, and a person " +
  "must look at it. will_hold_dispute: the item passes intake, but the email notes a dispute, so the eligibility check will hold it. " +
  "needs_link: the item passes intake but couldn't be linked to one subcontract, so a PM must choose one. ready_for_notice: linked " +
  "and nothing holds it, so the PM can confirm it and send the sub a notice. In every case a credit still needs a notice to the sub, " +
  "the response window to pass, the eligibility check and a controller's approval. Nothing was saved.";

/** The model call couldn't be made or failed (missing key, network, model error). The API answers 503 with the message. */
export class TryUnavailable extends Error {
  readonly status = 503;
}

export type TrySettings = { ok: true; settings: ModelSettings } | { ok: false; message: string };

/** The same typography normalize() (src/span.ts) treats as equal, so the highlight agrees with the span check. */
const SAME: Record<string, string> = {
  "'": "['‘’]", "‘": "['‘’]", "’": "['‘’]",
  '"': '["“”]', "“": '["“”]', "”": '["“”]',
  "-": "[-–—]", "–": "[-–—]", "—": "[-–—]",
};
const escapeChar = (c: string) => SAME[c] ?? c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * Where `sentence` is in `body`: runs of whitespace (incl. line breaks and no-break spaces) match any
 * run of whitespace, and straight and curly quotes and dashes match each other. First match, or null.
 */
export function findHighlight(body: string, sentence: string): [number, number] | null {
  const tokens = sentence.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const re = new RegExp(tokens.map((t) => [...t].map(escapeChar).join("")).join("\\s+"), "u");
  const m = re.exec(body);
  return m ? [m.index, m.index + m[0].length] : null;
}

/** A copy of the resolver's inputs, so nothing done here can reach the app's ERP data. */
function erpCopy(app: App): ResolverData {
  const { jobs, subcontracts, aliases } = app.ctx.erp;
  return structuredClone({ jobs, subcontracts, aliases });
}

function checksFor(email: Email, x: ExtractedBackCharge, a: ReturnType<typeof assessExtractedItem>): TryCheck[] {
  const held = new Set(a.holdReasons);
  const evidence = (prefix: string) => a.holdEvidence.filter((e) => e.startsWith(prefix));
  const amount = verifyAmountEvidence(email, x.amountEvidence, x.amountCents);
  const checks: TryCheck[] = [
    {
      name: "Amount and its sentence are in the email, word for word",
      passed: amount.ok,
      detail: amount.ok ? `the sentence states ${formatUsd(x.amountCents)}` : amount.reason,
    },
  ];
  if (x.disputeNoted && x.disputeEvidence) {
    const d = verifySpan(email, x.disputeEvidence);
    checks.push({ name: "Dispute sentence is in the email, word for word", passed: d.ok, detail: d.ok ? x.disputeEvidence.sentence : d.reason });
  }
  checks.push(
    {
      name: "Stated in the email's own text, not only in quoted or forwarded mail",
      passed: !held.has("only_in_quoted_text"),
      detail: held.has("only_in_quoted_text") ? HOLD_WORDS.only_in_quoted_text : amount.ok ? "yes" : "not checked: the amount sentence wasn't found",
    },
    {
      name: "No text aimed at an AI or automated system",
      passed: !held.has("suspicious_instructions"),
      detail: held.has("suspicious_instructions") ? evidence("text aimed at an automated system").join("; ") : "none found",
    },
    {
      name: "Every back-charge number in the email was extracted",
      passed: !held.has("unaccounted_reference"),
      detail: held.has("unaccounted_reference") ? a.holdEvidence.find((e) => e.startsWith("email mentions"))! : a.evidenceOk ? "yes" : "not checked: the evidence didn't verify",
    },
    {
      name: DISPUTE_CHECK,
      passed: !a.disputeInSource,
      detail: !a.disputeInSource
        ? "none found"
        : [
            ...(x.disputeNoted ? [`the extractor noted a dispute${x.disputeEvidence?.sentence ? `: ${x.disputeEvidence.sentence}` : ""}`] : []),
            ...a.backstop.map((s) => `dispute wording next to ${x.ref}: ${s}`),
          ].join("; ") + " (Contra holds it at the eligibility check)",
    },
  );
  const r = a.resolution;
  checks.push({
    name: LINK_CHECK,
    passed: r?.kind === "linked",
    detail: !r ? "not attempted: a held item is not linked automatically" : r.kind === "linked" ? `${r.subcontractId}: ${r.explanation.join("; ")}` : r.reasons.join("; "),
  });
  return checks;
}

/**
 * Extracts back-charges from the email with the live model, then runs Contra's ingest checks
 * (assessExtractedItem) on each accepted item against a copy of the app's ERP data. Reads the app only.
 * Throws TryUnavailable when settings are missing or the model call fails.
 */
export async function tryEmail(app: App, input: TryInput, settings: TrySettings, opts: ExtractOptions & { now?: () => number } = {}): Promise<TryResult> {
  if (!settings.ok) throw new TryUnavailable(settings.message);
  const now = opts.now ?? (() => performance.now());
  const email: Email = {
    id: "try-email",
    from: input.from?.trim() || "(sender not given)",
    to: input.to?.trim() || "(recipient not given)",
    subject: input.subject,
    receivedAt: app.ctx.clock.now(),
    body: input.body,
  };
  const t0 = now();
  const r = await extractBackCharges(settings.settings, email, opts);
  const latencyMs = Math.round(now() - t0);
  if (!r.ok) throw new TryUnavailable(r.reason);

  const data = erpCopy(app);
  const refs = r.items.map((x) => x.ref);
  const items = r.items.map((x): TryItem => {
    const a = assessExtractedItem(email, x, data, refs);
    const r = a.resolution;
    const linked = r?.kind === "linked" ? r : null;
    const holdReasons = a.holdReasons.map((h) => HOLD_WORDS[h]);
    const checks = checksFor(email, x, a);
    return {
      ref: x.ref,
      amount: formatUsd(x.amountCents),
      description: x.description,
      vendorAsWritten: x.vendorNameAsWritten,
      jobRef: x.jobRef,
      sourceSentence: x.amountEvidence.sentence,
      highlight: findHighlight(email.body, x.amountEvidence.sentence),
      checks,
      holdReasons,
      link: {
        subcontractId: linked?.subcontractId ?? null,
        explanation: !r ? ["not attempted: a held item is not linked automatically"] : r.kind === "linked" ? r.explanation : r.reasons,
      },
      outcome: tryOutcome(holdReasons, checks),
    };
  });
  return {
    model: r.actor.kind === "llm" ? r.actor.model : settings.settings.model,
    latencyMs,
    note: TRY_NOTE,
    items,
    rejected: r.rejected.map((x) => ({ reason: x.reason })),
  };
}
