import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { App } from "../src/app.ts";
import { ManualClock } from "../src/clock.ts";
import * as cmd from "../src/commands.ts";
import { estimateWording } from "../src/estimate.ts";
import type { Human } from "../src/types.ts";
import { buildScreens, backChargeDetail } from "../src/view.ts";
import { item, LLM, noNumberEmail, setup } from "./helpers.ts";

test("estimate: wording in the amount's sentence marks it; a plain amount, or 'about' elsewhere, doesn't", () => {
  const cases: [string, string | null][] = [
    ["Ceiling grid replacement will be approximately $6,000.00.", "approximately"],
    ["Cleanup was ~$475 for Ridgeline Drywall.", "~"],
    ["Estimated cost: $1,250.00 for the corridor wall.", "Estimated"],
    ["Patch and paint, approx. $1,200.00.", "approx."],
    ["Repair came to about $300.00.", "about"],
    ["Debris haul-off, $500 or so.", "or so"],
    ["Rework, est. $2,000.00 per the field ticket.", "est."],
    ["Ballpark $900.00 for the glass.", "Ballpark"],
    ["BC-4467: replace damaged ceiling grid, L2, $6,800.00 per the Apex Ceilings invoice.", null],
    ["We talked about the stair rail; the repair was $410.00.", null],
    ["Final cost $6,350.00, invoice attached.", null],
  ];
  for (const [s, want] of cases) assert.equal(estimateWording(s), want, s);
});

test("estimate: marked on the Inbox row, the notice and the credit approval; never a hold", async () => {
  const dir = mkdtempSync(join(tmpdir(), "contra-est-"));
  const app = new App(join(dir, "live.db"), { workspace: "live", realClock: new ManualClock(new Date("2026-11-07T15:00:00Z")) });
  const pm: Human = { kind: "human", id: "pat.pm", role: "pm" };
  const controller: Human = { kind: "human", id: "cy.ctl", role: "controller" };
  try {
    const s1 = "Ceiling grid replacement on L2 will be approximately $6,000.00, to be charged to Ridgeline Drywall.";
    const e = noNumberEmail("gmail-1", s1);
    cmd.ingestInboxEmail(app, e, [item(e, s1, 600_000, { description: "Ceiling grid replacement, L2" })], LLM);
    const row = buildScreens(app).inbox[0]!;
    assert.equal(row.estimate, "approximately");
    assert.equal(row.status.label, "Waiting for PM to confirm the link");
    assert.equal(backChargeDetail(app, "CONTRA-0001").estimate, "approximately");

    cmd.confirmLink(app, "CONTRA-0001", undefined, pm);
    const noticeId = cmd.draftNotice(app, "SC-SUM-0912")!;
    const notice = buildScreens(app).outbox.find((n) => n.id === noticeId)!;
    assert.match(notice.body, /- CONTRA-0001 \(no BC number yet\): Ceiling grid replacement, L2 - \$6,000\.00 \(estimate: the email says "approximately"\)/);
    cmd.approveNotice(app, noticeId, pm);
    cmd.sendNotice(app, noticeId);
    app.advanceDays(7);
    cmd.evaluateAll(app);
    const creditId = cmd.proposeCredit(app, "SC-SUM-0912")!;
    const note = 'CONTRA-0001: the amount is an estimate (the email says "approximately")';
    assert.deepEqual(buildScreens(app).credits.find((c) => c.id === creditId)!.amountNotes, [note]);
    cmd.approveCredit(app, creditId, controller);
    const approval = app.ctx.contra.audit.forEntity("credit", creditId).find((x) => x.to === "approved")!;
    assert.ok(approval.evidence.includes(note));
  } finally {
    app.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("estimate: a later email with a different amount for the same charge holds it for conflicting amounts", () => {
  const { contra } = setup();
  const s1 = "BC-4490: corridor wall repair, approx. $1,200.00.";
  const e1 = { ...noNumberEmail("E-A", s1), subject: "Summit - BC-4490" };
  const [bc] = contra.ingestBackChargeEmail(e1, [item(e1, s1, 120_000, { ref: "BC-4490", description: "Corridor wall repair" })], LLM);
  assert.equal(bc!.state, "extracted");
  const s2 = "BC-4490: corridor wall repair, final cost $1,350.00.";
  const e2 = { ...noNumberEmail("E-B", s2), subject: "Summit - BC-4490 final" };
  contra.ingestBackChargeEmail(e2, [item(e2, s2, 135_000, { ref: "BC-4490", description: "Corridor wall repair" })], LLM);
  assert.equal(bc!.state, "held");
  assert.deepEqual(bc!.holdReasons, ["conflicting_amounts"]);
});
