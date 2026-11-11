import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { App } from "../src/app.ts";
import * as cmd from "../src/commands.ts";
import { buildScreens, nextStep } from "../src/view.ts";

/**
 * The scripted demo on the recorded model output (fixtures/extractions/, written by a passing
 * `npm run extract:live`), followed step by step with nextStep: it must end at $15,500.00 / $11,500.00 /
 * $36,500.00, exactly as with the hand-written sample (test/demo.test.ts).
 */
test("demo on recorded model output: notice $15,500.00, credit $11,500.00, Bill Pay pays $36,500.00", async () => {
  const dir = mkdtempSync(join(tmpdir(), "contra-demo-rec-"));
  const app = new App(join(dir, "demo.db"), { start: new Date("2026-11-07T15:00:00Z") });
  try {
    for (let i = 0; i < 40; i++) {
      const step = nextStep(app);
      if (!step.action) break;
      if (step.action.command === "ingestPmEmails") assert.equal(cmd.ingestPmEmails(app).source, "model");
      else await cmd.runAction(app, step.action);
    }
    const s = buildScreens(app);
    assert.equal(nextStep(app).text, "Demo complete");
    assert.equal(s.extractionSource, "model");
    assert.deepEqual(s.inbox.map((r) => [r.ref, r.amount]), [["BC-4467", "$6,800.00"], ["BC-4468", "$4,700.00"], ["BC-4470", "$2,750.00"], ["BC-4471", "$4,000.00"]]);
    assert.deepEqual(s.outbox.map((n) => n.total), ["$15,500.00"]);
    assert.deepEqual(s.credits.map((c) => c.amount), ["$11,500.00"]);
    assert.deepEqual(s.bills.map((b) => b.paid), ["$36,500.00"]);
  } finally {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
