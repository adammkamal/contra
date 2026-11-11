import { InMemoryAuditLog } from "../src/audit.ts";
import { ManualClock } from "../src/clock.ts";
import { MockERP } from "../src/mocks/erp.ts";
import { MockRamp } from "../src/mocks/ramp.ts";
import { demoSeed } from "../src/seed.ts";
import type { Actor } from "../src/types.ts";
import { Contra } from "../src/workflow.ts";

import { AP, CONTROLLER, PM } from "../src/actors.ts";
export { AP, CONTROLLER, PM };
export const LLM: Actor = { kind: "llm", id: "extractor", model: "fixture" };

export function setup(start = new Date("2026-11-07T15:00:00Z")) {
  const clock = new ManualClock(start);
  const seed = demoSeed(clock.now());
  const log = new InMemoryAuditLog(clock);
  const erp = new MockERP({ jobs: seed.jobs, subcontracts: seed.subcontracts, aliases: [...seed.aliases] });
  const ramp = new MockRamp(seed.vendors);
  const contra = new Contra({ clock, log, erp, ramp });
  return { clock, seed, log, erp, ramp, contra };
}

/** Runs steps 1-2 of the demo: ingest, confirm links, draft+approve+send notice. */
export function throughNotice(ctx: ReturnType<typeof setup>) {
  const { contra, seed } = ctx;
  for (const e of seed.emails) contra.ingestBackChargeEmail(e, seed.extractions[e.id]!, LLM);
  for (const ref of ["BC-4467", "BC-4468", "BC-4470", "BC-4471"]) contra.confirmLink(ref, PM);
  const notice = contra.draftNotice("SC-SUM-0912")!;
  contra.approveNotice(notice.id, PM);
  contra.sendNotice(notice.id);
  return notice;
}
