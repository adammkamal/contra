import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GmailClient, InboxPoller, MAX_EXTRACTION_TRIES } from "../server/gmail.ts";
import { App } from "../src/app.ts";
import * as cmd from "../src/commands.ts";
import { parseBackCharges } from "../src/extract/validate.ts";
import { NotPermitted } from "../src/roles.ts";
import type { Email, Human } from "../src/types.ts";
import { buildScreens } from "../src/view.ts";
import { CONFIG, fakeExtract, fakeGmail, rfc822 } from "./gmail-fakes.ts";
import { LLM } from "./helpers.ts";

// Every email here is made up.
const now = () => Date.UTC(2026, 10, 10, 16, 0, 0);
const pm: Human = { kind: "human", id: "pat.pm", role: "pm" };
const controller: Human = { kind: "human", id: "cy.ctl", role: "controller" };

function liveApp(dir: string) {
  return new App(join(dir, "live.db"), { start: new Date(now()), workspace: "live", realClock: { now: () => new Date(now()) } });
}

const statusEmail: Email = {
  id: "gmail-payment-status",
  from: "Dana Ortiz <dana.ortiz@apexbuilders.example>",
  to: "contra.demo+backcharges@example.com",
  subject: "Harbor Mechanical - payment status",
  receivedAt: new Date("2026-11-10T15:00:00Z"),
  body: "Hi Accounting,\n\nWe still owe Harbor $4,900 under their approved pay app. When does it go out?\n\nDana",
  messageId: "<status-1@apexbuilders.example>",
};

test("nothing vanishes: an email that yields no back-charge is a row with its subject and sender, dismissed by a PM with a reason, and persisted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "contra-nv-"));
  let app = liveApp(dir);
  try {
    cmd.ingestInboxEmail(app, statusEmail, [], LLM);
    let s = buildScreens(app);
    assert.equal(s.inbox.length, 1);
    const row = s.inbox[0]!;
    assert.equal(row.kind, "noBackCharge");
    assert.equal(row.emailId, "gmail-payment-status");
    assert.equal(row.emailSubject, "Harbor Mechanical - payment status");
    assert.equal(row.emailFrom, "Dana Ortiz <dana.ortiz@apexbuilders.example>");
    assert.equal(row.status.label, "No back-charge found in this email; a person should read it, then dismiss it with a reason");
    assert.deepEqual(row.actions, [{ command: "dismissEmail", emailId: "gmail-payment-status" }]);
    assert.deepEqual(s.pmQueue.map((q) => q.kind), ["noBackCharge"]);
    assert.match(s.nextStep.text, /PM reads the email "Harbor Mechanical - payment status" \(no back-charge found\)/);

    // Persisted: a restart still shows it.
    app.close();
    app = liveApp(dir);
    assert.equal(buildScreens(app).inbox[0]!.kind, "noBackCharge");

    await assert.rejects(cmd.runAction(app, row.actions[0]!, {}, { by: pm }), /dismissing needs a reason/);
    await assert.rejects(cmd.runAction(app, row.actions[0]!, { reason: "a payment question" }, { by: controller }), NotPermitted);
    await cmd.runAction(app, row.actions[0]!, { reason: "a payment question, not a back-charge" }, { by: pm });
    app.close();
    app = liveApp(dir);
    s = buildScreens(app);
    assert.equal(s.inbox[0]!.status.label, "Dismissed by pat.pm (PM): a payment question, not a back-charge");
    assert.deepEqual(s.inbox[0]!.actions, []);
    assert.deepEqual(s.pmQueue, []);
    assert.ok(app.ctx.contra.audit.forEntity("email", "gmail-payment-status").some((e) => e.action === "dismissed (no back-charge found)" && e.actor.kind === "human"));
  } finally {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nothing vanishes: an email whose only item was refused is a 'not taken in' row, not 'no back-charge found'", () => {
  const dir = mkdtempSync(join(tmpdir(), "contra-nv-"));
  const app = liveApp(dir);
  try {
    const email = { ...statusEmail, id: "gmail-refused", messageId: "<refused-1@apexbuilders.example>", body: "Please back-charge Ridgeline Drywall roughly $2k for the cleanup." };
    const parsed = parseBackCharges({ items: [{ ref: null, description: "Cleanup", amountText: "$2", amountSentence: "Please back-charge Ridgeline Drywall roughly $2k for the cleanup.", vendorNameAsWritten: "Ridgeline Drywall", jobRef: "Summit", disputeNoted: false }] }, email);
    cmd.ingestInboxEmail(app, email, parsed.items, LLM, "gmail", parsed.rejected);
    assert.deepEqual(buildScreens(app).inbox.map((r) => r.kind), ["rejected"]);
  } finally {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nothing vanishes: an email the model fails on after every retry is a persisted 'couldn't process' row, closed when a later try succeeds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "contra-nv-"));
  let app = liveApp(dir);
  const msg = { id: "m91", raw: rfc822({ messageId: "m91@pm.example", deliveredTo: CONFIG.intake, subject: "Summit - stair 2 cleanup", body: "Hi,\r\n\r\nBC-7191: stair 2 cleanup, Summit, $900.00.\r\n\r\nDana" }) };
  try {
    const g = fakeGmail({ messages: [msg] });
    let calls = 0;
    const failing = async () => {
      calls++;
      return { ok: false as const, reason: "the model service didn't answer in time" };
    };
    const poller = new InboxPoller({ client: new GmailClient(CONFIG, g.transport, now), extract: failing, now });
    for (let i = 0; i < MAX_EXTRACTION_TRIES; i++) await poller.poll(app);
    assert.equal(calls, MAX_EXTRACTION_TRIES);
    let s = buildScreens(app);
    assert.equal(s.inbox.length, 1);
    const row = s.inbox[0]!;
    assert.equal(row.kind, "notProcessed");
    assert.equal(row.emailSubject, "Summit - stair 2 cleanup");
    assert.match(row.emailFrom, /dana\.ortiz@apexbuilders\.example/);
    assert.equal(row.status.label, "Couldn't process: the model service didn't answer in time; a person must read the email");
    assert.deepEqual(row.actions, [{ command: "dismissEmail", emailId: "gmail-m91" }]);
    assert.equal(app.ctx.contra.hasMessage("<m91@pm.example>"), false);

    // Persisted across a restart; a later try that succeeds takes the email in and closes the row.
    app.close();
    app = liveApp(dir);
    assert.equal(buildScreens(app).inbox[0]!.kind, "notProcessed");
    const ok = fakeExtract("Ridgeline Drywall");
    await new InboxPoller({ client: new GmailClient(CONFIG, fakeGmail({ messages: [msg] }).transport, now), extract: ok.extract, now }).poll(app);
    s = buildScreens(app);
    assert.deepEqual(s.inbox.map((r) => [r.kind, r.ref]), [["backCharge", "BC-7191"]]);
    assert.ok(app.ctx.contra.audit.forEntity("email", "gmail-m91").some((e) => e.action === "processed on a later try; the couldn't-process row is closed"));
  } finally {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
