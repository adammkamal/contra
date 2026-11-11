import { writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { MockERP } from "../src/mocks/erp.ts";
import { demoSeed } from "../src/seed.ts";
import { baselineDecide, contraDecide, isItemsLabel, loadCases, loadLabels, loadRuns, parseSet, REVIEW, score, scoreItems, setPaths, type BenchSet, type DecidedItem, type Outcome, type Score } from "./lib.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let set: BenchSet;
try {
  set = parseSet(process.argv);
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
const paths = setPaths(repoRoot, set);
const rel = (p: string) => relative(repoRoot, p).replaceAll("\\", "/");
const setArg = set === "main" ? "" : ` -- --set ${set}`;

const seed = demoSeed(new Date("2026-11-07T15:00:00Z"));
const erp = new MockERP({ jobs: seed.jobs, subcontracts: seed.subcontracts, aliases: [...seed.aliases] });
const cases = loadCases(paths.cases);
if (!cases.length) {
  console.error(`No cases in ${rel(paths.cases)}/`);
  process.exit(1);
}
const runsByCase = new Map(cases.map((c) => [c.id, loadRuns(paths.recordings, c)]));

const unrecorded = cases.filter((c) => runsByCase.get(c.id)!.length === 0).map((c) => c.id);
if (unrecorded.length) {
  console.error(`No recordings for ${unrecorded.length === cases.length ? "any case" : unrecorded.join(", ")}: run npm run bench:record${setArg} first`);
  process.exit(1);
}
const labels = loadLabels(paths.labels);
const missing = cases.filter((c) => !labels.has(c.id)).map((c) => c.id);
if (missing.length) {
  console.error(`Unlabeled cases (label them by hand in ${rel(paths.labels)}/): ${missing.join(", ")}`);
  process.exit(1);
}
const caseIds = new Set(cases.map((c) => c.id));
const notHuman = [...labels.values()].filter((l) => caseIds.has(l.id) && (!l.labeledBy || l.labeledBy.startsWith("claude"))).map((l) => l.id);

type Sys = "contra" | "baseline";
type RunRow = { caseId: string; run: number; items: number; failed?: string; contra?: Score; baseline?: Score; contraDecision: string; baselineDecision: string };

const show = (o: Outcome) => (o.decision.kind === "link" ? `link ${o.decision.subcontractId}` : o.decision.kind) + (o.wouldCredit ? " +credit" : "");
// A run with no accepted item: "nothing extracted" when nothing reaches the Inbox (missed), never "review".
// When validation refused items, each is a "not taken in" row asking a person to read the email (routed).
const NOTHING = "nothing extracted";
const nothingTaken = (refused: number) => (refused ? `nothing taken in (${refused} refused)` : NOTHING);
const showItems = (d: readonly DecidedItem[], refused: number) => (d.length ? d.map(({ x, o }) => `${x.ref ?? "(no BC number)"} ${show(o)}`).join("; ") : nothingTaken(refused));

const rows: RunRow[] = [];
for (const c of cases) {
  const label = labels.get(c.id)!;
  runsByCase.get(c.id)!.forEach((r, i) => {
    const run = i + 1;
    if (r.error) {
      rows.push({ caseId: c.id, run, items: 0, failed: r.error, contraDecision: "failed", baselineDecision: "failed" });
      return;
    }
    const refused = r.rejected.length;
    if (isItemsLabel(label)) {
      // Multi-item label: every accepted item is decided, as ingest would, and paired with the labeled items.
      const refs = r.items.map((x) => x.ref);
      const co = r.items.map((x) => ({ x, o: contraDecide(c.email, x, erp, refs) }));
      const bo = r.items.map((x) => ({ x, o: baselineDecide(x, seed.vendors, seed.subcontracts, seed.jobs) }));
      rows.push({
        caseId: c.id, run, items: r.items.length,
        contra: scoreItems(co, label, refused).score, baseline: scoreItems(bo, label, refused).score,
        contraDecision: showItems(co, refused), baselineDecision: showItems(bo, refused),
      });
      return;
    }
    const x = r.items.length === 1 ? r.items[0]! : null;
    const co = x ? contraDecide(c.email, x, erp) : REVIEW;
    const bo = x ? baselineDecide(x, seed.vendors, seed.subcontracts, seed.jobs) : REVIEW;
    const amount = x ? x.amountCents : 0;
    const accepted = r.items.length;
    const note = x ? "" : ` (${r.items.length} items)`;
    rows.push({
      caseId: c.id, run, items: r.items.length,
      contra: score(co, label, amount, accepted, refused), baseline: score(bo, label, amount, accepted, refused),
      contraDecision: accepted === 0 ? nothingTaken(refused) : show(co) + note, baselineDecision: accepted === 0 ? nothingTaken(refused) : show(bo) + note,
    });
  });
}

const runCount = Math.max(...[...runsByCase.values()].map((r) => r.length));
const perRun = (k: Sys) =>
  Array.from({ length: runCount }, (_, i) => {
    const rs = rows.filter((r) => r.run === i + 1 && r[k]);
    return {
      run: i + 1,
      scored: rs.length,
      failed: rows.filter((r) => r.run === i + 1 && r.failed).length,
      matching: rs.filter((r) => r[k]!.matching).length,
      dispute: rs.filter((r) => r[k]!.dispute).length,
      wrongLinks: rs.filter((r) => r[k]!.wrongLink).length,
      wrongCredits: rs.filter((r) => r[k]!.wrongCredit).length,
      routedToHuman: rs.filter((r) => r[k]!.routedToHuman).length,
      missed: rs.filter((r) => r[k]!.missed).length,
    };
  });

const unstable = (k: "contraDecision" | "baselineDecision") =>
  cases.filter((c) => new Set(rows.filter((r) => r.caseId === c.id).map((r) => r[k])).size > 1).map((c) => c.id);

const models = [...new Set([...runsByCase.values()].flat().map((r) => `${r.model} (${r.effort})`))];
const summary = {
  set,
  extractions: `${rel(paths.recordings)}, ${runCount} run(s), ${models.join(", ")}`,
  contra: perRun("contra"),
  baseline: perRun("baseline"),
  unstable: { contra: unstable("contraDecision"), baseline: unstable("baselineDecision") },
  nonHumanLabels: notHuman,
};

console.log(`Set: ${set}${set === "main" ? "" : " (scored separately, never merged into the main numbers)"}`);
console.log(`Extractions: ${summary.extractions}`);
console.table(rows.map((r) => ({
  case: r.caseId, run: r.run, items: r.failed ? "failed" : r.items,
  contra: r.contraDecision, "c match": r.contra?.matching, "c dispute": r.contra?.dispute, "c missed": r.contra?.missed,
  baseline: r.baselineDecision, "b match": r.baseline?.matching, "b dispute": r.baseline?.dispute, "b missed": r.baseline?.missed,
})));
for (const k of ["contra", "baseline"] as const) {
  console.log(`\n${k} (per run; matching = correct link or correct review; missed = a labeled back-charge nothing was extracted or refused for, which nobody sees)`);
  console.table(summary[k]);
}
console.log(`\nUnstable cases (outcome differs between runs): contra ${summary.unstable.contra.join(", ") || "none"}; baseline ${summary.unstable.baseline.join(", ") || "none"}`);
if (notHuman.length) {
  console.log(`\nNOT VALID FOR THE DEMO: ${notHuman.length} label(s) were not written by a human: ${notHuman.join(", ")}`);
}
writeFileSync(paths.results, JSON.stringify({ summary, rows }, null, 2));
