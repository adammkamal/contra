/**
 * Records live extractions for the benchmark cases. Reads CONTRA_ANTHROPIC_API_KEY, CONTRA_MODEL and
 * CONTRA_EFFORT from .env.local (never from ANTHROPIC_* variables, which Claude Code also reads).
 *   npm run bench:record              # 3 runs per case
 *   npm run bench:record -- --runs 5
 *   npm run bench:record -- --set heldout   # held-out set (default: main); --set fresh for the fresh set
 *   npm run bench:record -- --cases bc-17,bc-18     # only these cases (their runs are replaced)
 *   npm run bench:record -- --cases bc-08 --run 1   # only run 1 of bc-08; its other runs are kept
 * Writes fixtures/bench-extractions/<caseId>/run-<n>.json (held-out and fresh: fixtures/bench-extractions/<set>/<caseId>/). A failed call is recorded (with `error`)
 * and the recording continues. Each run also stores the model's raw tool input (`rawToolInput`), which `npm run bench`
 * re-validates with the current validator. Never touches fixtures/extractions/ (the demo's).
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCases, parseSet, setPaths, type BenchRun, type BenchSet } from "../bench/lib.ts";
import { settingsFromEnv } from "../src/extract/anthropic.ts";
import { extractBackCharges } from "../src/extract/index.ts";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* no .env.local: settingsFromEnv reports what's missing */
}
const runsArg = process.argv.indexOf("--runs");
const RUNS = runsArg > 0 ? Number(process.argv[runsArg + 1]) : 3;
if (!Number.isInteger(RUNS) || RUNS < 1) {
  console.error("--runs must be a positive integer");
  process.exit(2);
}
let set: BenchSet;
try {
  set = parseSet(process.argv);
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
const cfg = settingsFromEnv(process.env);
if (!cfg.ok) {
  console.error(cfg.message);
  process.exit(2);
}
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const paths = setPaths(root, set);
const outRoot = paths.recordings;
const outRel = relative(root, outRoot).replaceAll("\\", "/");
const casesArg = process.argv.indexOf("--cases");
const only = casesArg > 0 ? new Set((process.argv[casesArg + 1] ?? "").split(",").filter(Boolean)) : null;
const runArg = process.argv.indexOf("--run");
const oneRun = runArg > 0 ? Number(process.argv[runArg + 1]) : null;
if (oneRun !== null && (!Number.isInteger(oneRun) || oneRun < 1 || oneRun > RUNS)) {
  console.error(`--run must be a whole number from 1 to ${RUNS}`);
  process.exit(2);
}
const all = loadCases(paths.cases);
const unknown = only ? [...only].filter((id) => !all.some((c) => c.id === id)) : [];
if (unknown.length) {
  console.error(`No such case in ${relative(root, paths.cases)}: ${unknown.join(", ")}`);
  process.exit(2);
}
const cases = only ? all.filter((c) => only.has(c.id)) : all;
if (!cases.length) {
  console.error(`No cases in ${relative(root, paths.cases)}`);
  process.exit(1);
}
const effort = cfg.settings.effort ?? "medium";

console.log(`Recording ${set} set: ${cases.length} cases x ${oneRun === null ? `${RUNS} runs` : `run ${oneRun} only`} with ${cfg.settings.model} (${effort})`);
let failed = 0;
for (const c of cases) {
  const dir = join(outRoot, c.id);
  mkdirSync(dir, { recursive: true });
  // A whole case is re-recorded from scratch; with --run, only that run's file is replaced.
  if (oneRun === null) for (const f of readdirSync(dir).filter((f) => /^run-\d+\.json$/.test(f))) rmSync(join(dir, f));
  const parts: string[] = [];
  for (let n = oneRun ?? 1; n <= (oneRun ?? RUNS); n++) {
    let rec: BenchRun;
    try {
      const r = await extractBackCharges(cfg.settings, c.email);
      rec = r.ok
        ? { model: r.actor.kind === "llm" ? r.actor.model : cfg.settings.model, effort, recordedAt: new Date(Date.now()).toISOString(), items: r.items, rejected: r.rejected, rawToolInput: r.rawToolInput }
        : { model: cfg.settings.model, effort, recordedAt: new Date(Date.now()).toISOString(), items: [], rejected: [], error: r.reason };
    } catch (e) {
      rec = { model: cfg.settings.model, effort, recordedAt: new Date(Date.now()).toISOString(), items: [], rejected: [], error: e instanceof Error ? e.message : String(e) };
    }
    writeFileSync(join(dir, `run-${n}.json`), JSON.stringify(rec, null, 2) + "\n");
    if (rec.error) failed++;
    parts.push(rec.error ? `run ${n}: FAILED (${rec.error})` : `run ${n}: ${rec.items.length} accepted, ${rec.rejected.length} rejected`);
  }
  console.log(`${c.id}  ${parts.join(" | ")}`);
}
console.log(`\nDone: ${cases.length} cases x ${oneRun === null ? `${RUNS} runs` : `run ${oneRun}`}, ${failed} failed call(s). Written to ${outRel}/.`);
