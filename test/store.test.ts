import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { App } from "../src/app.ts";
import { cents, formatUsd } from "../src/money.ts";
import { demoReply } from "../src/seed.ts";
import { AP, CONTROLLER, LLM, PM } from "./helpers.ts";

const START = new Date("2026-11-07T15:00:00Z");
const dbPath = () => join(mkdtempSync(join(tmpdir(), "contra-")), "demo.db");

test("restart mid-demo loses nothing; demo still ends at $36,500", () => {
  const path = dbPath();
  let app = new App(path, { start: START });
  app.run(({ contra, seed }) => {
    for (const e of seed.emails) contra.ingestBackChargeEmail(e, seed.extractions[e.id]!, LLM);
    for (const ref of ["BC-4467", "BC-4468", "BC-4470", "BC-4471"]) contra.confirmLink(ref, PM);
  });
  const noticeId = app.run(({ contra }) => {
    const n = contra.draftNotice("SC-SUM-0912")!;
    contra.approveNotice(n.id, PM);
    contra.sendNotice(n.id);
    return n.id;
  });
  const eventsBefore = app.store.lastEventSeq();
  app.close();

  // "Server restart"
  app = new App(path);
  assert.equal(app.ctx.contra.backCharges.get("BC-4470")!.state, "held");
  assert.equal(app.ctx.contra.notices.get(noticeId)!.sentAt instanceof Date, true);
  assert.equal(app.ctx.clock.now().getTime(), START.getTime());

  app.run(({ contra, clock }) => {
    const n = contra.notices.get(noticeId)!;
    const r = demoReply(n.id, n.body, clock.now());
    contra.ingestSubResponse(r.email, r.extraction, LLM);
  });
  app.advanceDays(7);
  app.close();

  app = new App(path); // restart again after the clock moved
  const paid = app.run(({ contra, ramp, clock }) => {
    contra.evaluateAll();
    const c = contra.proposeCredit("SC-SUM-0912")!;
    contra.approveCredit(c.id, CONTROLLER);
    ramp.createBillViaApi({ id: "B-1", vendorId: "V-RIDGE", jobId: "SUM-01", amountCents: cents(4_800_000), accountingDate: clock.now(), origin: "native" });
    ramp.setApplyCredits("B-1", true);
    return contra.payBill("B-1", AP).paidCents;
  });
  assert.equal(formatUsd(paid), "$36,500.00");

  const seqs = app.store.auditLog(app.ctx.clock).all().map((e) => e.seq);
  assert.ok(seqs.length > eventsBefore);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1)); // no gaps across restarts
  app.close();
});

test("a command that throws leaves no trace: state and audit log roll back", () => {
  const app = new App(dbPath(), { start: START });
  app.run(({ contra, seed }) => contra.ingestBackChargeEmail(seed.emails[0]!, seed.extractions["E-1"]!, LLM));
  const before = app.store.lastEventSeq();
  assert.throws(() =>
    app.run(({ contra }) => {
      contra.confirmLink("BC-4467", PM); // succeeds...
      throw new Error("boom"); // ...then the command fails
    }),
  );
  assert.equal(app.ctx.contra.backCharges.get("BC-4467")!.state, "extracted");
  assert.equal(app.store.lastEventSeq(), before);
  // An illegal action through the app is also rolled back.
  assert.throws(() => app.run(({ contra }) => contra.confirmLink("BC-4467", LLM)));
  assert.equal(app.ctx.contra.backCharges.get("BC-4467")!.state, "extracted");
  app.close();
});

test("audit log is append-only at the database level", () => {
  const app = new App(dbPath(), { start: START });
  app.run(({ contra, seed }) => contra.ingestBackChargeEmail(seed.emails[0]!, seed.extractions["E-1"]!, LLM));
  assert.throws(() => app.store.db.exec("UPDATE events SET action = 'tampered'"), /append-only/);
  assert.throws(() => app.store.db.exec("DELETE FROM events"), /append-only/);
  app.close();
});
