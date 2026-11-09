import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_EML_DIR, loadEmlDir, loadPmEmails, parseEml } from "../ingest/eml.ts";
import { emlFiles } from "../scripts/make-eml.ts";
import { createApiServer } from "../server/api.ts";
import { App } from "../src/app.ts";
import * as cmd from "../src/commands.ts";
import { DEFAULT_FIXTURES_DIR } from "../src/commands.ts";
import { loadFixtures } from "../src/extract/index.ts";
import { demoSeed } from "../src/seed.ts";
import { normalize, verifyAmountEvidence, verifySpan } from "../src/span.ts";
import type { Email } from "../src/types.ts";
import { buildScreens, nextStep, type Screens } from "../src/view.ts";

const START = new Date("2026-11-07T15:00:00Z");
const seed = demoSeed(START);
const tmp = () => mkdtempSync(join(tmpdir(), "contra-"));
const raw = (id: string) => readFileSync(join(DEFAULT_EML_DIR, `${id}.eml`));
const parsed = async () => (await loadEmlDir(DEFAULT_EML_DIR))!;

test("eml: the committed files are exactly what scripts/make-eml.ts writes", () => {
  for (const [name, text] of Object.entries(emlFiles())) assert.equal(readFileSync(join(DEFAULT_EML_DIR, name), "utf8"), text, name);
});

test("eml: every parsed email yields amount sentences that verify against the recorded extractions", async () => {
  const emails = await parsed();
  assert.deepEqual(emails.map((e) => e.id), ["E-1", "E-2", "E-3"]);
  const rec = loadFixtures(DEFAULT_FIXTURES_DIR, emails.map((e) => e.id));
  assert.ok(rec, "recorded extractions exist for every .eml id");
  let n = 0;
  for (const e of emails) {
    const s = seed.emails.find((x) => x.id === e.id)!;
    assert.equal(e.from, s.from);
    assert.equal(e.to, s.to, "To keeps its display name");
    assert.equal(e.subject, s.subject);
    assert.ok(!e.body.includes("\r"), "CRLF normalized");
    assert.equal(normalize(e.body), normalize(s.body), `${e.id}: same text as the built-in sample`);
    for (const x of rec.extractions[e.id]!) {
      const r = verifyAmountEvidence(e, x.amountEvidence, x.amountCents);
      assert.ok(r.ok, `${x.ref}: ${r.ok ? "" : r.reason}`);
      if (x.disputeEvidence) assert.ok(verifySpan(e, x.disputeEvidence).ok, `${x.ref} dispute sentence`);
      n++;
    }
  }
  assert.equal(n, 4);
});

test("eml: quoted-printable soft line breaks decode, including one inside an amount sentence", async () => {
  const bytes = raw("E-1").toString("utf8");
  assert.match(bytes, /Content-Transfer-Encoding: quoted-printable/);
  assert.match(bytes, /BC-4468: d=\r\nebris/, "the fixture really has a soft break mid-sentence");
  const e = (await parsed()).find((x) => x.id === "E-1")!;
  assert.ok(e.body.includes("BC-4468: debris haul-off, $4,700.00."));
  assert.ok(!/=\n/.test(e.body), "no soft-break markers left");
  // =3D and a soft break inside a dollar amount.
  const qp = "From: a@x.example\r\nTo: b@y.example\r\nSubject: t\r\nDate: Sat, 07 Nov 2026 15:00:00 GMT\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nBC-1: total =3D $1,2=\r\n50.00.\r\n";
  assert.equal((await parseEml(Buffer.from(qp), "Q")).body, "BC-1: total = $1,250.00.");
});

test("eml: line endings are normalized to \\n, including lone CRs that mailparser leaves in a base64 body", async () => {
  const b64 = Buffer.from("BC-1: fix,\r\n$1.00.\rDana\r").toString("base64");
  const m = `From: a@x.example\r\nTo: b@y.example\r\nSubject: t\r\nDate: Sat, 07 Nov 2026 15:00:00 GMT\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64}\r\n`;
  assert.equal((await parseEml(Buffer.from(m), "B")).body, "BC-1: fix,\n$1.00.\nDana");
});

test("eml: the HTML-only email gives the same sentences as the built-in sample", async () => {
  const bytes = raw("E-2").toString("utf8");
  assert.match(bytes, /Content-Type: text\/html/);
  assert.doesNotMatch(bytes, /text\/plain/);
  const e = (await parsed()).find((x) => x.id === "E-2")!;
  assert.doesNotMatch(e.body, /<p>|<br>|<\/?html/);
  const sentences = (t: string) => normalize(t).split(/(?<=[.!?])\s+/);
  assert.deepEqual(sentences(e.body), sentences(seed.emails[1]!.body));
});

test("eml: a file without a Date header is rejected", async () => {
  const noDate = raw("E-3").toString("utf8").replace(/^Date: .*\r\n/m, "");
  assert.doesNotMatch(noDate, /^Date:/m);
  await assert.rejects(parseEml(Buffer.from(noDate), "E-3"), /missing Date header/);
  const dir = tmp();
  writeFileSync(join(dir, "E-3.eml"), noDate);
  await assert.rejects(loadPmEmails(dir), /E-3: missing Date header/);
  assert.equal(await loadPmEmails(join(dir, "nope")), null, "missing folder: built-in sample");
});

test("eml: Date header sets receivedAt; From/To without a display name stay bare addresses", async () => {
  const e = (await parsed()).find((x) => x.id === "E-1")!;
  assert.equal(e.receivedAt.toISOString(), "2026-10-29T15:00:00.000Z");
  assert.equal(e.from, "dana.ortiz@apexbuilders.example");
});

/** Follows nextStep to the end; ingest reads `emails` when given. Same recorded extractions either way. */
function runDemo(emails: Email[] | null): Screens {
  const app = new App(join(tmp(), "d.db"), { start: START });
  const pmEmails = emails ? { origin: "eml" as const, emails } : null;
  for (let i = 0; i < 40; i++) {
    const a = nextStep(app).action;
    if (!a) break;
    if (a.command === "ingestPmEmails") assert.equal(cmd.ingestPmEmails(app, pmEmails ? { emails: pmEmails.emails, emailOrigin: "eml" } : {}).source, "model");
    else cmd.runAction(app, a, {}, { pmEmails });
  }
  const s = buildScreens(app);
  app.close();
  return s;
}

test("eml: ingesting from .eml files and from the seed ends in the same demo state", async () => {
  const fromEml = runDemo(await parsed());
  const fromSeed = runDemo(null);
  for (const s of [fromEml, fromSeed]) {
    assert.equal(s.nextStep.action, null);
    assert.deepEqual(s.credits.map((c) => c.amount), ["$11,500.00"]);
    assert.equal(s.bills[0]!.paid, "$36,500.00");
  }
  assert.equal(fromEml.emailSource, "eml");
  assert.equal(fromSeed.emailSource, "builtin");
  const strip = (s: Screens) => ({ inbox: s.inbox, outbox: s.outbox, credits: s.credits, bills: s.bills });
  assert.deepEqual(strip(fromEml), strip(fromSeed));
});

test("eml: emailSource is null before ingest, and provided emails must say where they came from", () => {
  const app = new App(join(tmp(), "d.db"), { start: START });
  assert.equal(buildScreens(app).emailSource, null);
  assert.throws(() => cmd.ingestPmEmails(app, { emails: seed.emails }), /origin/);
  // Only the emails given are ingested, not the seed's.
  const r = cmd.ingestPmEmails(app, { emails: [seed.emails[2]!], emailOrigin: "eml", fixturesDir: null });
  assert.deepEqual(r.refs, ["BC-4471"]);
  assert.deepEqual([...app.ctx.contra.emails.keys()], ["E-3"]);
  app.close();
});

test("API: ingest reads fixtures/emails/*.eml when present, the built-in sample when emlDir is null", async () => {
  for (const [emlDir, want] of [[undefined, "eml"], [null, "builtin"]] as const) {
    const api = createApiServer({ dbPath: join(tmp(), "d.db"), start: START, ...(emlDir === null ? { emlDir } : {}) });
    await new Promise<void>((r) => api.server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
    try {
      const r = await fetch(`${base}/api/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: { command: "ingestPmEmails" } }) });
      const body = (await r.json()) as { ok: boolean; screens: Screens };
      assert.equal(r.status, 200);
      assert.equal(body.screens.emailSource, want);
      assert.equal(body.screens.inbox.length, 4);
    } finally {
      await api.close();
    }
  }
});
