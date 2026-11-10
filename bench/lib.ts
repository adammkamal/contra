import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Rejected } from "../src/extract/validate.ts";
import { cents } from "../src/money.ts";
import type { RampVendor } from "../src/mocks/ramp.ts";
import { assessExtractedItem } from "../src/intake.ts";
import { normName, type ResolverData } from "../src/resolver.ts";
import type { Email, ExtractedBackCharge, Subcontract } from "../src/types.ts";

/** A case file holds only the email. Extractions come from recordings, labels from bench/labels/. */
export interface BenchCase {
  id: string;
  description: string;
  email: Email;
}

/** One recorded extractor call: fixtures/bench-extractions/<caseId>/run-<n>.json. */
export interface BenchRun {
  model: string;
  effort: string;
  recordedAt: string;
  items: ExtractedBackCharge[];
  rejected: Rejected[];
  /** Set when the call itself failed (network, model error...). Such a run is not scored. */
  error?: string;
}

export interface BenchLabel {
  id: string;
  labeledBy: string;
  /**
   * "review" means a careful human would NOT auto-link this (ambiguous or unknown party).
   * "none" means the email holds no back-charge; then amountCents is null.
   */
  link: string | "review" | "none";
  disputed: boolean;
  amountCents: number | null;
}

/** Which benchmark: the main set, or the held-out set that is scored separately and never merged into the main numbers. */
export type BenchSet = "main" | "heldout";

/** Reads `--set <main|heldout>` from argv; main when absent. Throws on any other value. */
export function parseSet(argv: readonly string[]): BenchSet {
  const i = argv.indexOf("--set");
  if (i < 0) return "main";
  const v = argv[i + 1];
  if (v === "main" || v === "heldout") return v;
  throw new Error(`--set must be "main" or "heldout", got ${v === undefined ? "nothing" : `"${v}"`}`);
}

/** Where a set's cases, labels, recordings and results live, from the repo root. */
export function setPaths(repoRoot: string, set: BenchSet) {
  const bench = set === "main" ? join(repoRoot, "bench") : join(repoRoot, "bench", "heldout");
  const recordings = join(repoRoot, "fixtures", "bench-extractions", ...(set === "main" ? [] : ["heldout"]));
  return { cases: join(bench, "cases"), labels: join(bench, "labels"), recordings, results: join(bench, "results.json") };
}

export type Decision = { kind: "link"; subcontractId: string } | { kind: "review" } | { kind: "hold"; why: string };

export interface Outcome {
  decision: Decision;
  wouldCredit: boolean;
}

/** Both systems send a run with 0 or several accepted items to a human. */
export const REVIEW: Outcome = { decision: { kind: "review" }, wouldCredit: false };

/**
 * Contra: the product's own ingest checks (src/intake.ts assessExtractedItem), mapped to an outcome. Nothing bench-specific.
 * A scored run has exactly one accepted item, so it is the only extracted ref from the email.
 */
export function contraDecide(email: Email, x: ExtractedBackCharge, data: ResolverData): Outcome {
  const a = assessExtractedItem(email, x, data, [x.ref]);
  if (a.holdReasons.length) return { decision: { kind: "hold", why: a.holdReasons.join(", ") }, wouldCredit: false };
  const r = a.resolution!;
  if (r.kind !== "linked") return { decision: { kind: "review" }, wouldCredit: false };
  return { decision: { kind: "link", subcontractId: r.subcontractId }, wouldCredit: !a.disputeInSource };
}

const tokens = (s: string) => new Set(normName(s).split(" ").filter(Boolean));

/**
 * Baseline "field matcher": what a typical AP auto-match does. Fuzzy token overlap of the name as
 * written against vendor name AND remit-to; best score wins, ties go to the first vendor; no job
 * scoping beyond picking that vendor's subcontract on a job whose name shares a token. It honors the
 * extraction's disputeNoted flag (no credit when set), so the comparison isolates matching.
 */
export function baselineDecide(x: ExtractedBackCharge, vendors: readonly RampVendor[], subcontracts: readonly Subcontract[], jobs: ResolverData["jobs"]): Outcome {
  const want = tokens(x.vendorNameAsWritten);
  let best: RampVendor | null = null;
  let bestScore = 0;
  for (const v of vendors) {
    const have = new Set([...tokens(v.name), ...tokens(v.remitTo)]);
    const score = [...want].filter((t) => have.has(t)).length;
    if (score > bestScore) [best, bestScore] = [v, score];
  }
  if (!best) return { decision: { kind: "review" }, wouldCredit: false };
  const jobTok = tokens(x.jobRef);
  const ofVendor = subcontracts.filter((s) => s.paymentsVendorId === best!.id);
  const onJob = ofVendor.find((s) => {
    const j = jobs.find((j) => j.id === s.jobId)!;
    return [j.name, ...j.aliases].some((n) => [...tokens(n)].some((t) => jobTok.has(t)));
  });
  const sc = onJob ?? ofVendor[0];
  if (!sc) return { decision: { kind: "review" }, wouldCredit: false };
  return { decision: { kind: "link", subcontractId: sc.id }, wouldCredit: !x.disputeNoted };
}

export interface Score {
  matching: boolean;
  dispute: boolean;
  wrongLink: boolean;
  wrongCredit: boolean;
  routedToHuman: boolean;
}

/**
 * matching: linked to the labeled subcontract, or not linked when the label says review.
 * dispute: when the system links, its credit decision matches the label (credit iff not disputed).
 *   A run that doesn't link has no credit decision to get wrong.
 * wrongLink: auto-linked to anything other than the label (including linking when label = review).
 * wrongCredit: would create a credit that a careful human would not (wrong party, disputed, or wrong amount).
 * `extracted` is the extracted amount; it only matters when the system would credit.
 * `accepted` is how many items the extractor accepted in the run (o is REVIEW when it isn't exactly 1).
 *
 * Label "none" (no back-charge): correct only if no item is accepted. An accepted item that would be
 * credited is a wrong credit; any other accepted outcome is routed to a person and not correct.
 */
export function score(o: Outcome, label: BenchLabel, extracted: number, accepted: number): Score {
  const linked = o.decision.kind === "link" ? o.decision.subcontractId : null;
  if (label.link === "none") {
    return {
      matching: accepted === 0,
      dispute: !o.wouldCredit,
      wrongLink: linked !== null,
      wrongCredit: o.wouldCredit,
      routedToHuman: accepted > 0 && !o.wouldCredit,
    };
  }
  const wrongLink = linked !== null && linked !== label.link;
  return {
    matching: label.link === "review" ? linked === null : linked === label.link,
    dispute: linked === null || o.wouldCredit === !label.disputed,
    wrongLink,
    wrongCredit: o.wouldCredit && (wrongLink || label.disputed || extracted !== label.amountCents),
    routedToHuman: linked === null,
  };
}

const reviveDates = (_k: string, v: unknown) => (typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) ? new Date(v) : v);

export function loadCases(dir: string): BenchCase[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8"), reviveDates) as BenchCase);
}

/** Recorded runs for one case, in run order. Empty when the case has no recordings. */
export function loadRuns(recordingsDir: string, caseId: string): BenchRun[] {
  const dir = join(recordingsDir, caseId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => /^run-(\d+)\.json$/.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((m) => {
      const r = JSON.parse(readFileSync(join(dir, m[0]), "utf8")) as BenchRun;
      r.items = r.items.map((x) => ({ ...x, amountCents: cents(x.amountCents) }));
      return r;
    });
}

export function loadLabels(dir: string): Map<string, BenchLabel> {
  const out = new Map<string, BenchLabel>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const l = JSON.parse(readFileSync(join(dir, f), "utf8")) as BenchLabel;
    out.set(l.id, l);
  }
  return out;
}
