import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cents, type Cents } from "../src/money.ts";
import type { RampVendor } from "../src/mocks/ramp.ts";
import { normName, resolve, type ResolverData } from "../src/resolver.ts";
import { disputeSentencesFor, verifyAmountEvidence } from "../src/span.ts";
import type { Email, ExtractedBackCharge, Subcontract } from "../src/types.ts";

export interface BenchCase {
  id: string;
  description: string;
  email: Email;
  /** Extractor output for this email. Replaced by fixtures/extractions/<emailId>.json when present. */
  extraction: ExtractedBackCharge;
}

export interface BenchLabel {
  id: string;
  labeledBy: string;
  /** "review" means a careful human would NOT auto-link this (ambiguous or unknown party). */
  link: string | "review";
  disputed: boolean;
  amountCents: number;
}

export type Decision = { kind: "link"; subcontractId: string } | { kind: "review" } | { kind: "hold"; why: string };

export interface Outcome {
  decision: Decision;
  wouldCredit: boolean;
}

/** Contra: span check, deterministic resolver, dispute rules. Same rules as src/, nothing bench-specific. */
export function contraDecide(c: BenchCase, data: ResolverData): Outcome {
  const x = c.extraction;
  if (!verifyAmountEvidence(c.email, x.amountEvidence, x.amountCents).ok) return { decision: { kind: "hold", why: "unverified" }, wouldCredit: false };
  const r = resolve(x, data);
  if (r.kind !== "linked") return { decision: { kind: "review" }, wouldCredit: false };
  const disputed = x.disputeNoted || disputeSentencesFor(c.email.body, x.ref).length > 0;
  return { decision: { kind: "link", subcontractId: r.subcontractId }, wouldCredit: !disputed };
}

const tokens = (s: string) => new Set(normName(s).split(" ").filter(Boolean));

/**
 * Baseline "field matcher": what a typical AP auto-match does. Fuzzy token overlap of the name as
 * written against vendor name AND remit-to; best score wins, ties go to the first vendor; no job
 * scoping beyond picking that vendor's subcontract on a job whose name shares a token; ignores
 * dispute language. Same extraction input as Contra, so the comparison isolates linking and rules.
 */
export function baselineDecide(c: BenchCase, vendors: readonly RampVendor[], subcontracts: readonly Subcontract[], jobs: ResolverData["jobs"]): Outcome {
  const want = tokens(c.extraction.vendorNameAsWritten);
  let best: RampVendor | null = null;
  let bestScore = 0;
  for (const v of vendors) {
    const have = new Set([...tokens(v.name), ...tokens(v.remitTo)]);
    const score = [...want].filter((t) => have.has(t)).length;
    if (score > bestScore) [best, bestScore] = [v, score];
  }
  if (!best) return { decision: { kind: "review" }, wouldCredit: false };
  const jobTok = tokens(c.extraction.jobRef);
  const ofVendor = subcontracts.filter((s) => s.paymentsVendorId === best!.id);
  const onJob = ofVendor.find((s) => {
    const j = jobs.find((j) => j.id === s.jobId)!;
    return [j.name, ...j.aliases].some((n) => [...tokens(n)].some((t) => jobTok.has(t)));
  });
  const sc = onJob ?? ofVendor[0];
  if (!sc) return { decision: { kind: "review" }, wouldCredit: false };
  return { decision: { kind: "link", subcontractId: sc.id }, wouldCredit: true };
}

export interface Score {
  correct: boolean;
  wrongLink: boolean;
  wrongCredit: boolean;
  routedToHuman: boolean;
}

/**
 * correct: linked to the labeled subcontract, or sent to review when the label says review,
 *   and (if disputed) not credited.
 * wrongLink: auto-linked to anything other than the label (including linking when label = review).
 * wrongCredit: would create a credit that a careful human would not (wrong party, disputed, or wrong amount).
 */
export function score(o: Outcome, label: BenchLabel, extracted: Cents): Score {
  const linked = o.decision.kind === "link" ? o.decision.subcontractId : null;
  const wrongLink = linked !== null && linked !== label.link;
  const rightTarget = label.link === "review" ? o.decision.kind !== "link" : linked === label.link;
  const wrongCredit = o.wouldCredit && (wrongLink || label.disputed || extracted !== label.amountCents);
  return {
    correct: rightTarget && !(label.disputed && o.wouldCredit) && !wrongCredit,
    wrongLink,
    wrongCredit,
    routedToHuman: o.decision.kind !== "link",
  };
}

const reviveDates = (_k: string, v: unknown) => (typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) ? new Date(v) : v);

export function loadCases(dir: string, fixturesDir?: string): BenchCase[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const c = JSON.parse(readFileSync(join(dir, f), "utf8"), reviveDates) as BenchCase;
      c.extraction.amountCents = cents(c.extraction.amountCents);
      if (fixturesDir) {
        try {
          const f = JSON.parse(readFileSync(join(fixturesDir, `${c.email.id}.json`), "utf8")) as { items: ExtractedBackCharge[] };
          const live = f.items;
          const match = live.find((x) => x.ref === c.extraction.ref) ?? live[0];
          if (match) c.extraction = { ...match, amountCents: cents(match.amountCents) };
        } catch {
          /* no live fixture for this email: keep the recorded extraction */
        }
      }
      return c;
    });
}

export function loadLabels(dir: string): Map<string, BenchLabel> {
  const out = new Map<string, BenchLabel>();
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const l = JSON.parse(readFileSync(join(dir, f), "utf8")) as BenchLabel;
    out.set(l.id, l);
  }
  return out;
}
