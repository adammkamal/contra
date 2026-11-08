import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MockERP } from "../src/mocks/erp.ts";
import { demoSeed } from "../src/seed.ts";
import { baselineDecide, contraDecide, loadCases, loadLabels, score, type Score } from "./lib.ts";

const root = dirname(fileURLToPath(import.meta.url));
const live = process.argv.includes("--live") ? join(root, "..", "fixtures", "extractions") : undefined;

const seed = demoSeed(new Date("2026-11-07T15:00:00Z"));
const erp = new MockERP({ jobs: seed.jobs, subcontracts: seed.subcontracts, aliases: [...seed.aliases] });
const cases = loadCases(join(root, "cases"), live);
const labels = loadLabels(join(root, "labels"));

const missing = cases.filter((c) => !labels.has(c.id)).map((c) => c.id);
if (missing.length) {
  console.error(`Unlabeled cases (label them by hand in bench/labels/): ${missing.join(", ")}`);
  process.exit(1);
}
const notHuman = [...labels.values()].filter((l) => !l.labeledBy || l.labeledBy.startsWith("claude")).map((l) => l.id);

type Row = { id: string; contra: Score; baseline: Score; contraDecision: string; baselineDecision: string };
const rows: Row[] = cases.map((c) => {
  const label = labels.get(c.id)!;
  const co = contraDecide(c, erp);
  const bo = baselineDecide(c, seed.vendors, seed.subcontracts, seed.jobs);
  const d = (o: typeof co) => (o.decision.kind === "link" ? `link ${o.decision.subcontractId}` : o.decision.kind);
  return { id: c.id, contra: score(co, label, c.extraction.amountCents), baseline: score(bo, label, c.extraction.amountCents), contraDecision: d(co), baselineDecision: d(bo) };
});

const agg = (k: "contra" | "baseline") => ({
  cases: rows.length,
  correct: rows.filter((r) => r[k].correct).length,
  wrongLinks: rows.filter((r) => r[k].wrongLink).length,
  wrongCredits: rows.filter((r) => r[k].wrongCredit).length,
  routedToHuman: rows.filter((r) => r[k].routedToHuman).length,
});
const summary = { extractions: live ? "live fixtures where present" : "recorded in case files", contra: agg("contra"), baseline: agg("baseline"), nonHumanLabels: notHuman };

console.table(rows.map((r) => ({ case: r.id, contra: r.contraDecision, "contra ok": r.contra.correct, baseline: r.baselineDecision, "baseline ok": r.baseline.correct })));
console.table({ contra: summary.contra, baseline: summary.baseline });
if (notHuman.length) {
  console.log(`\nNOT VALID FOR THE DEMO: ${notHuman.length} label(s) were not written by a human: ${notHuman.join(", ")}`);
}
writeFileSync(join(root, "results.json"), JSON.stringify({ summary, rows }, null, 2));
