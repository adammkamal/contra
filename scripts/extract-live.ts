/**
 * Live acceptance test for AI extraction (#2). Needs ANTHROPIC_API_KEY (optional ANTHROPIC_MODEL).
 *   npm run extract:live            # 5 runs per email, compare, record fixtures only if ALL pass
 *   npm run extract:live -- --runs 3
 * Pass = every run, for every email: same refs, same cents, verbatim sentence passes the span check,
 * same dispute flag, and the resolver links to the same subcontract as the hand-written seed.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractBackCharges, extractResponse, saveFixture } from "../src/extract/index.ts";
import { settingsFromEnv } from "../src/extract/anthropic.ts";
import { MockERP } from "../src/mocks/erp.ts";
import { resolve } from "../src/resolver.ts";
import { demoReply, demoSeed } from "../src/seed.ts";
import { verifyAmountEvidence, verifySpan } from "../src/span.ts";
import type { ExtractedBackCharge } from "../src/types.ts";

const runsArg = process.argv.indexOf("--runs");
const RUNS = runsArg > 0 ? Number(process.argv[runsArg + 1]) : 5;
const cfg = settingsFromEnv(process.env);
if (!cfg.ok) {
  console.error(cfg.message);
  process.exit(2);
}
const seed = demoSeed(new Date("2026-11-07T15:00:00Z"));
const erp = new MockERP({ jobs: seed.jobs, subcontracts: seed.subcontracts, aliases: [...seed.aliases] });
const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "extractions");

const failures: string[] = [];
const last: Record<string, { model: string; items: ExtractedBackCharge[] }> = {};

for (const email of seed.emails) {
  const expected = seed.extractions[email.id]!;
  for (let run = 1; run <= RUNS; run++) {
    const tag = `${email.id} run ${run}`;
    const r = await extractBackCharges(cfg.settings, email);
    if (!r.ok) { failures.push(`${tag}: ${r.reason}`); continue; }
    for (const rej of r.rejected) failures.push(`${tag}: rejected item ${rej.index}: ${rej.reason}`);
    const got = new Map(r.items.map((x) => [x.ref, x]));
    if (got.size !== expected.length) failures.push(`${tag}: expected ${expected.length} items, got ${got.size}`);
    for (const e of expected) {
      const g = got.get(e.ref);
      if (!g) { failures.push(`${tag}: missing ${e.ref}`); continue; }
      if (g.amountCents !== e.amountCents) failures.push(`${tag}: ${e.ref} amount ${g.amountCents} != ${e.amountCents}`);
      const span = verifyAmountEvidence(email, g.amountEvidence, g.amountCents);
      if (!span.ok) failures.push(`${tag}: ${e.ref} ${span.reason}`);
      if (g.disputeNoted !== e.disputeNoted) failures.push(`${tag}: ${e.ref} disputeNoted ${g.disputeNoted} != ${e.disputeNoted}`);
      if (g.disputeEvidence && !verifySpan(email, g.disputeEvidence).ok) failures.push(`${tag}: ${e.ref} dispute sentence not verbatim`);
      const a = resolve(g, erp), b = resolve(e, erp);
      const linkA = a.kind === "linked" ? a.subcontractId : "review", linkB = b.kind === "linked" ? b.subcontractId : "review";
      if (linkA !== linkB) failures.push(`${tag}: ${e.ref} links to ${linkA}, expected ${linkB} (vendor "${g.vendorNameAsWritten}", job "${g.jobRef}")`);
    }
    last[email.id] = { model: r.actor.kind === "llm" ? r.actor.model : "unknown", items: r.items };
    console.log(`${tag}: ${r.items.map((x) => `${x.ref} ${x.amountCents}`).join(", ")}`);
  }
}

// Sub reply: "Fine, except 4471." must dispute exactly BC-4471.
const notice = { id: "N-1", backChargeRefs: ["BC-4467", "BC-4468", "BC-4471"] };
const reply = demoReply(notice.id, "NOTICE (quoted)\n- BC-4467\n- BC-4468\n- BC-4471", new Date("2026-11-07T15:00:00Z"));
for (let run = 1; run <= RUNS; run++) {
  const r = await extractResponse(cfg.settings, reply.email, notice);
  if (!r.ok) { failures.push(`reply run ${run}: ${r.reason}`); continue; }
  if (JSON.stringify(r.value.disputedRefs) !== JSON.stringify(["BC-4471"])) failures.push(`reply run ${run}: disputed ${r.value.disputedRefs.join(",")}`);
  if (!verifySpan(reply.email, r.value.evidence, { excludeQuoted: true }).ok) failures.push(`reply run ${run}: evidence not in sub's own text`);
}

if (failures.length) {
  console.error(`\nFAIL (${failures.length}):\n- ${failures.join("\n- ")}\nNo fixtures written. Fix the prompt, then re-run.`);
  process.exit(1);
}
for (const [id, f] of Object.entries(last)) saveFixture(outDir, id, { ...f, recordedAt: new Date(Date.now()).toISOString() });
console.log(`\nPASS: ${RUNS} runs x ${seed.emails.length} emails + reply. Fixtures written to fixtures/extractions/.`);
