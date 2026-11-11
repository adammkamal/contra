/**
 * Ordered scenario scoring (the fresh2 set, `npm run bench -- --set fresh2`). Instead of deciding each case
 * on its own, run n ingests run n of every case, in date order, into ONE store (an in-memory live App, via
 * src/commands.ts ingestInboxEmail, as the inbox poller does), so a later email meets the charges the earlier
 * ones created: the product's duplicate holds, CONTRA- references and BC numbers it already has all apply.
 * Each case is scored against the store's state right after its own email is ingested.
 */
import { App } from "../src/app.ts";
import { ManualClock } from "../src/clock.ts";
import { ingestInboxEmail } from "../src/commands.ts";
import { estimateWording } from "../src/estimate.ts";
import type { RampVendor } from "../src/mocks/ramp.ts";
import type { ResolverData } from "../src/resolver.ts";
import type { BackCharge, Email, RejectedExtraction, Subcontract } from "../src/types.ts";
import type { Contra } from "../src/workflow.ts";
import {
  baselineDecide, isItemsLabel, pairItems, REVIEW, score, scoreItems,
  type AnyBenchLabel, type BenchCase, type BenchLabel, type BenchLabelItem, type BenchRun, type DecidedItem, type Outcome, type Score,
} from "./lib.ts";

/** One accepted item of a run, with the store item that carries its charge. */
export interface ScenarioItem extends DecidedItem {
  /** Ref of the store item carrying this charge (followed through merges), or null when nothing does. */
  carrier: string | null;
  /** True when ingest added no item for it: it cited a BC number the store already had (the same charge again). */
  absorbed: boolean;
}

export interface EstimateTally {
  /** Labeled items with `estimated` set. */
  labeled: number;
  /** Of those, items paired with an accepted item whose marking equals the label. Unpaired ones count as wrong. */
  right: number;
}

export interface ScenarioRow {
  caseId: string;
  run: number;
  items: number;
  failed?: string;
  contra?: Score;
  baseline?: Score;
  contraEstimate?: EstimateTally;
  baselineEstimate?: EstimateTally;
  contraDecision: string;
  baselineDecision: string;
}

export interface ScenarioData {
  seedStart: Date;
  vendors: readonly RampVendor[];
  subcontracts: readonly Subcontract[];
  jobs: ResolverData["jobs"];
}

/** Cases in ingest order: by receivedAt, then id. */
export const scenarioOrder = (cases: readonly BenchCase[]): BenchCase[] =>
  [...cases].sort((a, b) => a.email.receivedAt.getTime() - b.email.receivedAt.getTime() || a.id.localeCompare(b.id));

/**
 * Why the fresh2 labels can't be scored as a scenario, or null: `estimated` must be a boolean when present;
 * a `sameAs` must name an earlier case (in ingest order) with a label, and an item of it that names a
 * back-charge (an items-label index, or 0 for a single-item label that isn't "none").
 */
export function scenarioLabelProblem(cases: readonly BenchCase[], labels: ReadonlyMap<string, AnyBenchLabel>): string | null {
  const order = scenarioOrder(cases).map((c) => c.id);
  for (const id of order) {
    const l = labels.get(id);
    if (!l) continue;
    if (!isItemsLabel(l)) {
      if (l.estimated !== undefined && typeof l.estimated !== "boolean") return `${id}: estimated must be true or false, or left out`;
      if ("sameAs" in l) return `${id}: sameAs goes on an item of an "items" label`;
      continue;
    }
    for (const [n, it] of l.items.entries()) {
      if (!it.sameAs) continue;
      const at = `${id} items[${n}].sameAs`;
      const t = it.sameAs.case;
      if (!order.includes(t)) return `${at}: no case ${t} in this set`;
      if (order.indexOf(t) >= order.indexOf(id)) return `${at}: ${t} is not earlier than ${id} in date order`;
      const tl = labels.get(t);
      if (!tl) return `${at}: ${t} has no label`;
      const count = isItemsLabel(tl) ? tl.items.length : tl.link === "none" ? 0 : 1;
      if (it.sameAs.index >= count) return `${at}: ${t} has no labeled back-charge at index ${it.sameAs.index}`;
    }
  }
  return null;
}

const outcomeWords = (o: Outcome) =>
  o.decision.kind === "link" ? `link ${o.decision.subcontractId}${o.wouldCredit ? " +credit" : ""}` : o.decision.kind === "hold" ? `hold (${o.decision.why})` : "review";

/** The item carrying `ref`'s charge: itself, or what it was merged into (followed to the end). */
function survivor(contra: Contra, ref: string): BackCharge {
  let b = contra.backCharges.get(ref)!;
  for (let i = 0; b.state === "merged" && b.mergedInto && i < 100; i++) b = contra.backCharges.get(b.mergedInto)!;
  return b;
}

/**
 * A store item's outcome, in the per-case terms (bench/lib.ts contraDecide): held -> hold; linked (by the
 * resolver's proposal, or a subcontract set on the item) -> link, credited unless a dispute was noted in the
 * source; anything else -> review. "Proceeds" means it would reach a notice: a link.
 */
function storeOutcome(contra: Contra, b: BackCharge, sourceDispute: ReadonlyMap<string, boolean>): Outcome {
  if (b.state === "held") {
    const dup = b.duplicate && b.holdReasons.includes("possible_duplicate") ? ` of ${b.duplicate.of}` : "";
    return { decision: { kind: "hold", why: b.holdReasons.map((r) => (r === "possible_duplicate" ? r + dup : r)).join(", ") }, wouldCredit: false };
  }
  const p = contra.proposals.get(b.ref);
  const sc = b.subcontractId ?? (b.state === "extracted" && p?.kind === "linked" ? p.subcontractId : null);
  if (!sc) return REVIEW;
  return { decision: { kind: "link", subcontractId: sc }, wouldCredit: !(sourceDispute.get(b.ref) ?? true) };
}

const proceeds = (o: Outcome) => o.decision.kind === "link";

/**
 * Ingests one case's run into the store and returns, per accepted item, the store item that took it in.
 * Ingest takes the items in order: one citing a BC number already in the store (or created earlier in this
 * email) joins that item; every other one is a new item, in order.
 */
function ingestOne(app: App, c: BenchCase, run: BenchRun): { ref: string; absorbed: boolean }[] {
  const contra = app.ctx.contra;
  const before = new Set(contra.backCharges.keys());
  const known = new Map(run.items.map((x) => [x.ref, x.ref === null ? undefined : contra.byBcNumber(x.ref)?.ref]));
  const email: Email = { ...c.email, messageId: `<${c.id}@bench.invalid>` };
  ingestInboxEmail(app, email, run.items, { kind: "llm", id: "extractor", model: run.model }, "builtin", run.rejected as RejectedExtraction[]);
  const created = [...contra.backCharges.keys()].filter((k) => !before.has(k));
  const mine = new Map<string, string>();
  let k = 0;
  const carriers = run.items.map((x) => {
    const into = x.ref === null ? undefined : (known.get(x.ref) ?? mine.get(x.ref));
    if (into) return { ref: into, absorbed: true };
    const ref = created[k++]!;
    if (x.ref !== null) mine.set(x.ref, ref);
    return { ref, absorbed: false };
  });
  if (k !== created.length) throw new Error(`${c.id}: ${created.length} items created for ${k} new extracted items`);
  return carriers;
}

/** The store as it stands now: an item's carrier and outcome, and what each held item is a possible duplicate of. */
function storeView(contra: Contra) {
  const sourceDispute = new Map(contra.snapshot().sourceDispute);
  const dupOf = new Map<string, string>();
  for (const b of contra.backCharges.values()) {
    if (b.state === "held" && b.duplicate && b.holdReasons.includes("possible_duplicate")) dupOf.set(b.ref, survivor(contra, b.duplicate.of).ref);
  }
  const at = (ref: string) => {
    const b = survivor(contra, ref);
    return { carrier: b.ref, o: storeOutcome(contra, b, sourceDispute) };
  };
  return { at, dupOf };
}

const markedEstimate = (x: DecidedItem["x"]) => estimateWording(x.amountEvidence.sentence) !== null;

function tallyEstimates(labelItems: readonly (BenchLabelItem | BenchLabel)[], at: readonly (number | null)[], decided: readonly DecidedItem[], marks: (x: DecidedItem["x"]) => boolean): EstimateTally | undefined {
  let labeled = 0;
  let right = 0;
  labelItems.forEach((l, li) => {
    if (l.estimated === undefined) return;
    labeled++;
    const i = at[li];
    if (i !== null && i !== undefined && marks(decided[i]!.x) === l.estimated) right++;
  });
  return labeled ? { labeled, right } : undefined;
}

/**
 * A labeled item with `sameAs`, paired with accepted item `d` (null: nothing extracted for it), against the
 * earlier item it is the same charge as, as it stands now (`target`: null when that item has no accepted item).
 * - not extracted: missed, or routed to a person when the run refused an item from the email (as any item);
 * - no target: scored as a plain item (there is nothing for it to be charged twice with);
 * - handled (one item carries both, or one is held as a possible duplicate of the other) and they don't both
 *   proceed: matching;
 * - both proceed separately (each would reach a notice): a wrong credit, never matching;
 * - otherwise (visible, but not as the same charge): scored as a plain item, never matching.
 */
function scoreSameAs(l: BenchLabelItem, labelId: string, d: ScenarioItem | null, target: ScenarioItem | null, refused: number, handled: boolean): Score {
  const one: BenchLabel = { id: labelId, labeledBy: "", link: l.link, disputed: l.disputed, amountCents: l.amountCents };
  if (!d) return score(REVIEW, one, 0, 0, refused);
  const plain = score(d.o, one, d.x.amountCents, 1);
  if (!target) return plain;
  const same = d.carrier !== null && d.carrier === target.carrier;
  const bothProceed = !same && proceeds(d.o) && proceeds(target.o);
  if (handled && !bothProceed) return { matching: true, dispute: true, wrongLink: false, wrongCredit: false, routedToHuman: !proceeds(d.o), missed: false };
  if (bothProceed) return { ...plain, matching: false, wrongCredit: true };
  return { ...plain, matching: false };
}

/**
 * Scores the set as an ordered scenario, run by run (run n = run n of every case): each case is scored right
 * after its own email is ingested, a `sameAs` target as it stands at that moment. A case whose run n failed is
 * not ingested in scenario n and not scored there; a later item that is the same charge as one of its items has
 * no target in that scenario. Rows come in case order (as `cases`), then run.
 */
export function scoreScenario(cases: readonly BenchCase[], runsByCase: ReadonlyMap<string, BenchRun[]>, labels: ReadonlyMap<string, AnyBenchLabel>, d: ScenarioData): ScenarioRow[] {
  const order = scenarioOrder(cases);
  const runCount = Math.max(0, ...[...runsByCase.values()].map((r) => r.length));
  const rows: ScenarioRow[] = [];
  for (let n = 0; n < runCount; n++) {
    const app = new App(":memory:", { workspace: "live", realClock: new ManualClock(d.seedStart), start: d.seedStart });
    try {
      rows.push(...scoreOneScenario(app, order, runsByCase, labels, d, n));
    } finally {
      app.close();
    }
  }
  const pos = new Map(cases.map((c, i) => [c.id, i]));
  return rows.sort((a, b) => pos.get(a.caseId)! - pos.get(b.caseId)! || a.run - b.run);
}

function scoreOneScenario(app: App, order: readonly BenchCase[], runsByCase: ReadonlyMap<string, BenchRun[]>, labels: ReadonlyMap<string, AnyBenchLabel>, d: ScenarioData, n: number): ScenarioRow[] {
  const rows: ScenarioRow[] = [];
  // Per case, the store ref carrying each labeled item (contra) or the baseline's decided item; null when unpaired.
  const pairedC = new Map<string, (string | null)[]>();
  const pairedB = new Map<string, (DecidedItem | null)[]>();
  for (const c of order) {
    const r = runsByCase.get(c.id)?.[n];
    if (!r) continue;
    if (r.error) {
      rows.push({ caseId: c.id, run: n + 1, items: 0, failed: r.error, contraDecision: "failed", baselineDecision: "failed" });
      continue;
    }
    const label = labels.get(c.id)!;
    const refused = r.rejected.length;
    const carriers = ingestOne(app, c, r);
    const { at: now, dupOf } = storeView(app.ctx.contra);
    const co: ScenarioItem[] = r.items.map((x, i) => ({ x, ...now(carriers[i]!.ref), absorbed: carriers[i]!.absorbed }));
    const bo: DecidedItem[] = r.items.map((x) => ({ x, o: baselineDecide(x, d.vendors, d.subcontracts, d.jobs) }));
    const nothing = refused ? `nothing taken in (${refused} refused)` : "nothing extracted";
    const showC = co.length ? co.map((s) => `${s.x.ref ?? "(no BC number)"}${s.absorbed ? ` joined ${s.carrier}` : ` as ${s.carrier}`}: ${outcomeWords(s.o)}${markedEstimate(s.x) ? " [estimate]" : ""}`).join("; ") : nothing;
    const showB = bo.length ? bo.map((s) => `${s.x.ref ?? "(no BC number)"} ${outcomeWords(s.o)}`).join("; ") : nothing;
    const row: ScenarioRow = { caseId: c.id, run: n + 1, items: r.items.length, contraDecision: showC, baselineDecision: showB };

    if (isItemsLabel(label)) {
      const atC = pairItems(co, label).at;
      const atB = pairItems(bo, label).at;
      pairedC.set(c.id, atC.map((i) => (i === null ? null : co[i]!.carrier)));
      pairedB.set(c.id, atB.map((i) => (i === null ? null : bo[i]!)));
      const targetOf = <T,>(m: Map<string, (T | null)[]>, l: BenchLabelItem) => (l.sameAs ? (m.get(l.sameAs.case)?.[l.sameAs.index] ?? null) : null);
      row.contra = scoreItems(co, label, refused, (li, i) => {
        const l = label.items[li]!;
        if (!l.sameAs) return undefined;
        const mine = i === null ? null : co[i]!;
        const tRef = targetOf(pairedC, l);
        // The earlier item as it stands now, right after this email.
        const t: ScenarioItem | null = mine && tRef !== null ? { x: mine.x, ...now(tRef), absorbed: false } : null;
        const handled = !!mine && !!t && mine.carrier !== null && t.carrier !== null &&
          (mine.carrier === t.carrier || dupOf.get(mine.carrier) === t.carrier || dupOf.get(t.carrier) === mine.carrier);
        return scoreSameAs(l, label.id, mine, t, refused, handled);
      }).score;
      row.baseline = scoreItems(bo, label, refused, (li, i) => {
        const l = label.items[li]!;
        if (!l.sameAs) return undefined;
        const t = targetOf(pairedB, l);
        // The baseline keeps no state: each item stands alone, so it never treats two as one charge.
        return scoreSameAs(l, label.id, i === null ? null : { ...bo[i]!, carrier: null, absorbed: false }, t && { ...t, carrier: null, absorbed: false }, refused, false);
      }).score;
      row.contraEstimate = tallyEstimates(label.items, atC, co, markedEstimate);
      row.baselineEstimate = tallyEstimates(label.items, atB, bo, () => false);
    } else {
      // Single-item form: scored as in the per-case sets, on the store's outcome for the one accepted item.
      const one = r.items.length === 1;
      const amount = one ? r.items[0]!.amountCents : 0;
      row.contra = score(one ? co[0]!.o : REVIEW, label, amount, r.items.length, refused);
      row.baseline = score(one ? bo[0]!.o : REVIEW, label, amount, r.items.length, refused);
      if (!one && r.items.length) {
        row.contraDecision += ` (${r.items.length} items)`;
        row.baselineDecision += ` (${r.items.length} items)`;
      }
      pairedC.set(c.id, [one ? co[0]!.carrier : null]);
      pairedB.set(c.id, [one ? bo[0]! : null]);
      const at = [one ? 0 : null];
      row.contraEstimate = tallyEstimates([label], at, co, markedEstimate);
      row.baselineEstimate = tallyEstimates([label], at, bo, () => false);
    }
    rows.push(row);
  }
  return rows;
}
