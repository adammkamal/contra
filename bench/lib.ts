import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeRef, parseBackCharges, type Rejected } from "../src/extract/validate.ts";
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
  /** Recordings made before rejections carried plain words (`words`, `ref`) have only index and reason. */
  rejected: (Pick<Rejected, "index" | "reason"> & Partial<Rejected>)[];
  /**
   * The model's tool input before validation. When present, loadRuns re-validates it with the current
   * parseBackCharges and uses that result instead of the stored items/rejected (which reflect the
   * validator at recording time). Older recordings don't have it; their stored items are used as is.
   */
  rawToolInput?: unknown;
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

/** One back-charge in a multi-item label (see bench/fresh/LABEL-FORMAT.md). */
export interface BenchLabelItem {
  /** The BC number when the email states one. Without it, the item is matched by amount (and subcontract on a tie). */
  ref?: string;
  /** A subcontract ID, or "review" if a careful person would not auto-link this item. */
  link: string;
  disputed: boolean;
  amountCents: number;
}

/**
 * A label listing every back-charge in the email, scored item by item. For emails that can hold several
 * charges, or whose charges have no BC number (the fresh set). An email with no back-charge keeps the
 * single-item form with link "none".
 */
export interface BenchItemsLabel {
  id: string;
  labeledBy: string;
  items: BenchLabelItem[];
}

export type AnyBenchLabel = BenchLabel | BenchItemsLabel;

export const isItemsLabel = (l: AnyBenchLabel): l is BenchItemsLabel => "items" in l;

/**
 * Which benchmark: the main set, the held-out set, or the fresh set (written outside the team). Each is
 * scored separately and never merged into another's numbers.
 */
export type BenchSet = "main" | "heldout" | "fresh";
const SETS: readonly string[] = ["main", "heldout", "fresh"];

/** Reads `--set <main|heldout|fresh>` from argv; main when absent. Throws on any other value. */
export function parseSet(argv: readonly string[]): BenchSet {
  const i = argv.indexOf("--set");
  if (i < 0) return "main";
  const v = argv[i + 1];
  if (v !== undefined && SETS.includes(v)) return v as BenchSet;
  throw new Error(`--set must be "main", "heldout" or "fresh", got ${v === undefined ? "nothing" : `"${v}"`}`);
}

/** Where a set's cases, labels, recordings and results live, from the repo root. */
export function setPaths(repoRoot: string, set: BenchSet) {
  const bench = set === "main" ? join(repoRoot, "bench") : join(repoRoot, "bench", set);
  const recordings = join(repoRoot, "fixtures", "bench-extractions", ...(set === "main" ? [] : [set]));
  return { cases: join(bench, "cases"), labels: join(bench, "labels"), recordings, results: join(bench, "results.json") };
}

export type Decision = { kind: "link"; subcontractId: string } | { kind: "review" } | { kind: "hold"; why: string };

export interface Outcome {
  decision: Decision;
  wouldCredit: boolean;
}

/** The outcome of a run without exactly one accepted item: nothing linked or credited (0 items is scored as missed, see `score`). */
export const REVIEW: Outcome = { decision: { kind: "review" }, wouldCredit: false };

/**
 * Contra: the product's own ingest checks (src/intake.ts assessExtractedItem), mapped to an outcome. Nothing bench-specific.
 * `extractedRefs` is every accepted ref from the run, as ingest passes them. A run scored against a
 * single-item label has exactly one accepted item, so by default it is the only extracted ref from the email.
 */
export function contraDecide(email: Email, x: ExtractedBackCharge, data: ResolverData, extractedRefs: readonly (string | null)[] = [x.ref]): Outcome {
  const a = assessExtractedItem(email, x, data, extractedRefs);
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
  /**
   * A labeled back-charge that no accepted item stands for, from an email that produced no refused item
   * either: in the product nothing reaches the Inbox, so nobody ever sees it.
   */
  missed: boolean;
}

/**
 * matching: linked to the labeled subcontract, or not linked when the label says review.
 * dispute: when the system links, its credit decision matches the label (credit iff not disputed).
 *   A run that doesn't link has no credit decision to get wrong.
 * wrongLink: auto-linked to anything other than the label (including linking when label = review).
 * wrongCredit: would create a credit that a careful human would not (wrong party, disputed, or wrong amount).
 * `extracted` is the extracted amount; it only matters when the system would credit.
 * `accepted` is how many items the extractor accepted in the run (o is REVIEW when it isn't exactly 1).
 * `refused` is how many items validation refused in the run (BenchRun.rejected). Each is an Inbox row in the
 * product ("not taken in", held, asking a person to read the email).
 *
 * The label names a back-charge (a subcontract or "review") and the run accepted no item:
 *   - refused > 0: routed to a person (the refused row sends them to the email), never matching;
 *   - otherwise missed: nothing reaches the Inbox, so no person sees it: never matching (even when the label
 *     says review) and never routed to a person.
 *   Only refused items count. A row saying the email held no back-charge would not send anyone to find one,
 *   so if the product ever shows such a row, it must not count here.
 *
 * Label "none" (no back-charge): correct only if no item is accepted. An accepted item that would be
 * credited is a wrong credit; any other accepted outcome is routed to a person and not correct.
 */
export function score(o: Outcome, label: BenchLabel, extracted: number, accepted: number, refused = 0): Score {
  const linked = o.decision.kind === "link" ? o.decision.subcontractId : null;
  if (label.link === "none") {
    return {
      matching: accepted === 0,
      dispute: !o.wouldCredit,
      wrongLink: linked !== null,
      wrongCredit: o.wouldCredit,
      routedToHuman: accepted > 0 && !o.wouldCredit,
      missed: false,
    };
  }
  if (accepted === 0) {
    const routed = refused > 0;
    return { matching: false, dispute: true, wrongLink: false, wrongCredit: false, routedToHuman: routed, missed: !routed };
  }
  const wrongLink = linked !== null && linked !== label.link;
  return {
    matching: label.link === "review" ? linked === null : linked === label.link,
    dispute: linked === null || o.wouldCredit === !label.disputed,
    wrongLink,
    wrongCredit: o.wouldCredit && (wrongLink || label.disputed || extracted !== label.amountCents),
    routedToHuman: linked === null,
    missed: false,
  };
}

/** Label "none", used to score an accepted item that matches no labeled back-charge. */
const NO_CHARGE: BenchLabel = { id: "", labeledBy: "", link: "none", disputed: false, amountCents: null };

/** One accepted item of a run with one system's outcome for it. */
export interface DecidedItem {
  x: ExtractedBackCharge;
  o: Outcome;
}

/** One labeled item's result: `at` is the index of the accepted item it was paired with, or null. */
export interface ItemScore {
  label: BenchLabelItem;
  at: number | null;
  score: Score;
}

/**
 * Pairs a run's accepted items with a multi-item label's items, then scores each pair with `score`.
 * The system's answer is used only to break ties:
 *  1. a labeled item with a ref pairs with the accepted item of that ref;
 *  2. a labeled item without a ref pairs with an unpaired accepted item of exactly its amount; among
 *     several, the one the system linked to the labeled subcontract, else the first in extraction order.
 * A labeled item left unpaired was not extracted, and is scored like a run with no accepted item: routed to a
 * person when the run refused at least one item (`refused`, see `score`), else missed (nobody sees it).
 * An accepted item left unpaired matches no labeled charge: scored against label "none" (crediting it is
 * a wrong credit, linking it a wrong link, otherwise routed to a person; never matching).
 * The run: matching only if every labeled item matches and no accepted item is left over; dispute only if
 * every item's (labeled and left over) is; wrongLink, wrongCredit, routedToHuman and missed if any item's is.
 */
export function scoreItems(decided: readonly DecidedItem[], label: BenchItemsLabel, refused = 0): { score: Score; items: ItemScore[]; extra: number[] } {
  const free = new Set(decided.map((_, i) => i));
  const at: (number | null)[] = label.items.map(() => null);
  const take = (li: number, i: number | undefined) => {
    if (i === undefined) return;
    at[li] = i;
    free.delete(i);
  };
  label.items.forEach((l, li) => {
    if (l.ref === undefined) return;
    const want = normalizeRef(l.ref);
    take(li, [...free].find((i) => decided[i]!.x.ref === want));
  });
  label.items.forEach((l, li) => {
    if (l.ref !== undefined) return;
    const same = [...free].filter((i) => decided[i]!.x.amountCents === l.amountCents);
    const toLabeled = (i: number) => {
      const d = decided[i]!.o.decision;
      return d.kind === "link" && d.subcontractId === l.link;
    };
    take(li, same.find(toLabeled) ?? same[0]);
  });
  const items: ItemScore[] = label.items.map((l, li) => {
    const i = at[li]!;
    const one: BenchLabel = { id: label.id, labeledBy: label.labeledBy, link: l.link, disputed: l.disputed, amountCents: l.amountCents };
    return { label: l, at: i, score: i === null ? score(REVIEW, one, 0, 0, refused) : score(decided[i]!.o, one, decided[i]!.x.amountCents, 1) };
  });
  const extra = [...free].sort((a, b) => a - b);
  const all = [...items.map((s) => s.score), ...extra.map((i) => score(decided[i]!.o, NO_CHARGE, decided[i]!.x.amountCents, 1))];
  return {
    score: {
      matching: extra.length === 0 && items.every((s) => s.score.matching),
      dispute: all.every((s) => s.dispute),
      wrongLink: all.some((s) => s.wrongLink),
      wrongCredit: all.some((s) => s.wrongCredit),
      routedToHuman: all.some((s) => s.routedToHuman),
      missed: all.some((s) => s.missed),
    },
    items,
    extra,
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

/**
 * Recorded runs for one case, in run order. Empty when the case has no recordings. A run with
 * `rawToolInput` is re-validated against the case's email, so validator changes are measured
 * without new model calls; a run without it keeps its stored items.
 */
export function loadRuns(recordingsDir: string, c: BenchCase): BenchRun[] {
  const dir = join(recordingsDir, c.id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => /^run-(\d+)\.json$/.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((m) => {
      const r = JSON.parse(readFileSync(join(dir, m[0]), "utf8")) as BenchRun;
      if (!r.error && r.rawToolInput !== undefined) return { ...r, ...parseBackCharges(r.rawToolInput, c.email) };
      r.items = r.items.map((x) => ({ ...x, amountCents: cents(x.amountCents) }));
      return r;
    });
}

export function loadLabels(dir: string): Map<string, AnyBenchLabel> {
  const out = new Map<string, AnyBenchLabel>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const l = JSON.parse(readFileSync(join(dir, f), "utf8")) as AnyBenchLabel;
    if (isItemsLabel(l)) {
      const bad = itemsLabelProblem(l);
      if (bad) throw new Error(`${join(dir, f)}: ${bad}`);
    }
    out.set(l.id, l);
  }
  return out;
}

/** Why a multi-item label can't be scored, or null. Single-item labels are read as before, unchecked. */
export function itemsLabelProblem(l: BenchItemsLabel): string | null {
  for (const k of ["link", "disputed", "amountCents"]) if (k in l) return `an "items" label must not also have "${k}"`;
  if (!Array.isArray(l.items) || l.items.length === 0) return `"items" must list at least one back-charge (an email with none uses link "none")`;
  const refs = new Set<string>();
  for (const [n, it] of l.items.entries()) {
    const at = `items[${n}]`;
    if (typeof it.link !== "string" || !it.link || it.link === "none") return `${at}.link must be a subcontract ID or "review"`;
    if (typeof it.disputed !== "boolean") return `${at}.disputed must be true or false`;
    if (!Number.isSafeInteger(it.amountCents) || it.amountCents <= 0) return `${at}.amountCents must be a positive whole number of cents`;
    if (it.ref !== undefined) {
      const r = typeof it.ref === "string" ? normalizeRef(it.ref) : null;
      if (!r) return `${at}.ref must be a BC number, or left out`;
      if (refs.has(r)) return `${at}.ref ${r} appears twice`;
      refs.add(r);
    }
  }
  return null;
}
