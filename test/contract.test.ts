import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { App } from "../src/app.ts";
import * as cmd from "../src/commands.ts";
import { saveFixture } from "../src/extract/index.ts";
import { demoSeed } from "../src/seed.ts";
import { backChargeDetail, buildScreens } from "../src/view.ts";

const START = new Date("2026-11-07T15:00:00Z");
const tmp = () => mkdtempSync(join(tmpdir(), "contra-"));
const newApp = () => new App(join(tmp(), "d.db"), { start: START });

test("no recorded model output: ingest uses the hand-written sample and never credits the model", () => {
  const app = newApp();
  const r = cmd.ingestPmEmails(app, { fixturesDir: join(tmp(), "missing") });
  assert.equal(r.source, "sample");
  assert.equal(r.refs.length, 4);
  const extracted = app.ctx.contra.audit.all().filter((e) => e.entity === "backcharge" && e.to === "extracted");
  assert.equal(extracted.length, 4);
  assert.ok(extracted.every((e) => e.actor.kind !== "llm"));
  const s = buildScreens(app);
  assert.equal(s.extractionSource, "sample");
  assert.ok(s.audit.some((e) => e.actor === "Sample extractions (hand-written)"));
  assert.ok(!s.audit.some((e) => e.actor.startsWith("AI extractor")));
  app.close();
});

test("recorded model output present for every email: ingest uses it and labels the model", () => {
  const dir = tmp();
  const seed = demoSeed(START);
  for (const e of seed.emails) saveFixture(dir, e.id, { model: "claude-opus-5-5", recordedAt: START.toISOString(), items: seed.extractions[e.id]! });
  const app = newApp();
  const r = cmd.ingestPmEmails(app, { fixturesDir: dir });
  assert.equal(r.source, "model");
  const s = buildScreens(app);
  assert.equal(s.extractionSource, "model");
  assert.ok(s.audit.some((e) => e.actor === "AI extractor (claude-opus-5-5)"));
  app.close();
});

test("recordings missing for some emails: falls back to the sample for all, never mixes sources", () => {
  const dir = tmp();
  const seed = demoSeed(START);
  saveFixture(dir, "E-1", { model: "claude-opus-5-5", recordedAt: START.toISOString(), items: seed.extractions["E-1"]! });
  const app = newApp();
  assert.equal(cmd.ingestPmEmails(app, { fixturesDir: dir }).source, "sample");
  assert.equal(buildScreens(app).extractionSource, "sample");
  app.close();
});

test("provided extractions must say who produced them", () => {
  const app = newApp();
  assert.throws(() => cmd.ingestPmEmails(app, { extractions: demoSeed(START).extractions }), /extractor/);
  assert.equal(app.ctx.contra.backCharges.size, 0); // rolled back
  app.close();
});

test("detail view quotes the clause, explains eligibility in words and shows history", () => {
  const app = newApp();
  cmd.ingestPmEmails(app, { fixturesDir: null });
  let d = backChargeDetail(app, "BC-4470");
  assert.equal(d.clause!.section, "§14.3 Back-Charges"); // proposal known before PM confirms
  assert.equal(d.clause!.responseWindow, "5 working days");
  assert.match(d.clause!.text, /five \(5\) working days/);
  assert.equal(d.disputeSentence, "Ridgeline disputes this one, holding until we sort out who caused it.");
  for (const ref of ["BC-4467", "BC-4468", "BC-4470", "BC-4471"]) cmd.confirmLink(app, ref);
  cmd.draftNotice(app);
  d = backChargeDetail(app, "BC-4470");
  assert.equal(d.eligibility.status, "held");
  // Final-phase explanation: the dispute AND the fact that it was (correctly) left off the notice.
  assert.deepEqual(d.eligibility.holdReasons, ["dispute noted in the PM's email", "no notice was sent"]);
  assert.match(d.status.label, /^Held: dispute noted in the PM's email/);
  assert.ok(d.history.length >= 3);
  assert.equal(d.amount, "$2,750.00");
  assert.throws(() => backChargeDetail(app, "BC-0000"), /no back-charge/);
  app.close();
});
