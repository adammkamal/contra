import { AP, CONTROLLER, PM, SAMPLE_EXTRACTIONS } from "./actors.ts";
import type { App } from "./app.ts";
import { loadFixtures } from "./extract/index.ts";
import { isOffered } from "./view.ts";

export class NotOffered extends Error {}
import { cents, parseUsd } from "./money.ts";
import { NotPermitted } from "./roles.ts";
import { demoReply } from "./seed.ts";
import type { Actor, Email, EmailOrigin, ExtractedBackCharge, ExtractedResponse, Human, RejectedExtraction } from "./types.ts";

/**
 * Every button in the UI maps to exactly one of these. Each runs inside app.run (atomic).
 * Screens and the Playwright test call these; nothing else mutates state.
 */

export const DEMO_SC = "SC-SUM-0912";
export const DEMO_BILL = "B-SUM-48K";

export const DEFAULT_FIXTURES_DIR = "fixtures/extractions";

/** Thrown when a command belongs to the other workspace (scripted demo steps in live, live mail in demo). */
export class WrongWorkspace extends Error {}

/**
 * Who a person's step is recorded under. `by` is the signed-in person, injected by the host (the API's
 * session). Demo: the step keeps its scripted actor (Dana Ortiz PM, Lee Chen Controller, Sam AP), with
 * `presentedBy` the person who clicked, so the scripted demo reads the same whoever presents it. Live: the
 * person themselves, with their own role; there is no live step without one. Without a person, the demo
 * uses the scripted actor (in-process scripts and tests).
 */
export function actorFor(app: App, scripted: Human, by: Human | undefined): Human {
  if (app.ctx.workspace === "demo") return by ? { ...scripted, presentedBy: by.id } : scripted;
  if (!by) throw new NotPermitted("the live workspace records who takes each step: sign in first");
  return { kind: "human", id: by.id, role: by.role };
}

/** The scripted demo's own emails, reply and bill exist only in the demo workspace. */
function demoOnly(app: App, what: string): void {
  if (app.ctx.workspace !== "demo") throw new WrongWorkspace(`${what} is part of the scripted demo, not the ${app.ctx.workspace} workspace`);
}

/**
 * PM emails read outside src/ (ingest/eml.ts loads fixtures/emails/*.eml) and injected here, so src/
 * needs no mail-parsing dependency. Ids must match the seed's (E-1..E-3) for recorded extractions to apply.
 */
export interface PmEmailSource {
  origin: EmailOrigin;
  emails: Email[];
}

/**
 * Ingests the demo PM emails: `emails` when given (from `emailOrigin`, required with it), else the
 * built-in sample in src/seed.ts. Extractions, in order:
 *  1. `extractions` passed in (with the `extractor` that produced them, and `rejected`: what validation
 *     refused from each email, by email id, kept as held Inbox rows);
 *  2. recorded model output in `fixturesDir` (written by `npm run extract:live` on a full pass);
 *  3. the hand-written sample in src/seed.ts, logged as SAMPLE_EXTRACTIONS, never as the model.
 */
export function ingestPmEmails(
  app: App,
  opts: {
    extractions?: Record<string, ExtractedBackCharge[]>;
    rejected?: Record<string, RejectedExtraction[]>;
    extractor?: Actor;
    fixturesDir?: string | null;
    emails?: Email[];
    emailOrigin?: EmailOrigin;
  } = {},
): { refs: string[]; source: "model" | "sample" | "provided"; emailOrigin: EmailOrigin } {
  if (opts.emails && !opts.emailOrigin) throw new Error("provided emails need their origin");
  demoOnly(app, "ingesting the demo's PM emails");
  return app.run(({ contra, seed }) => {
    const emails = opts.emails ?? seed.emails;
    const emailOrigin: EmailOrigin = opts.emails ? opts.emailOrigin! : "builtin";
    let ex: Record<string, ExtractedBackCharge[]>;
    let actor: Actor;
    let source: "model" | "sample" | "provided";
    if (opts.extractions) {
      if (!opts.extractor) throw new Error("provided extractions need the extractor that produced them");
      [ex, actor, source] = [opts.extractions, opts.extractor, "provided"];
    } else {
      const rec = opts.fixturesDir === null ? null : loadFixtures(opts.fixturesDir ?? DEFAULT_FIXTURES_DIR, emails.map((e) => e.id));
      if (rec) [ex, actor, source] = [rec.extractions, { kind: "llm", id: "extractor", model: rec.model }, "model"];
      else [ex, actor, source] = [seed.extractions, SAMPLE_EXTRACTIONS, "sample"];
    }
    const rejected = source === "provided" ? opts.rejected ?? {} : {};
    const refs = emails.flatMap((e) => contra.ingestBackChargeEmail(e, ex[e.id] ?? [], actor, emailOrigin, rejected[e.id] ?? []).map((b) => b.ref));
    return { refs, source, emailOrigin };
  });
}

/**
 * Ingests one email read from a live inbox, with the extraction made for it, into the live workspace only
 * (a demo App refuses it). Idempotent by Message-ID (the core skips one it has seen: no back-charge, notice
 * or audit entry). Returns whether it was new. `rejected`: what validation refused from the extraction;
 * each becomes a held Inbox row, never dropped.
 */
export function ingestInboxEmail(
  app: App,
  email: Email,
  extracted: ExtractedBackCharge[],
  extractor: Actor,
  origin: EmailOrigin = "gmail",
  rejected: readonly RejectedExtraction[] = [],
): { ingested: boolean; refs: string[] } {
  // Live mail never reaches the scripted demo: its notice, credit and payment can't change through the inbox.
  if (app.ctx.workspace !== "live") throw new WrongWorkspace("live inbox mail goes only to the live workspace, never to the demo");
  if (!email.messageId) throw new Error(`inbox email ${email.id} has no Message-ID`);
  if (app.ctx.contra.hasMessage(email.messageId)) return { ingested: false, refs: [] };
  return app.run(({ contra }) => {
    if (contra.hasMessage(email.messageId!)) return { ingested: false, refs: [] };
    return { ingested: true, refs: contra.ingestBackChargeEmail(email, extracted, extractor, origin, rejected).map((b) => b.ref) };
  });
}

/**
 * Sends a credit's memo with the injected MemoSender, in three steps: queue it (app.run), hand it to the
 * sender, then record sent or failed (app.run). If the process stops between the send and the record,
 * the memo stays queued and is never re-sent automatically (retry is only from failed).
 */
export async function sendCreditMemo(app: App, creditId: string, by?: Human): Promise<{ state: "sent" | "failed" }> {
  const sender = app.ctx.memoSender;
  if (!sender) throw new Error("no memo sender is configured on this server");
  const actor = actorFor(app, AP, by);
  const memo = app.run(({ contra }) => contra.queueMemo(creditId, sender.destination, actor));
  let messageId: string;
  try {
    ({ messageId } = await sender.send({ creditId, ...memo }));
  } catch (e) {
    const why = (e instanceof Error ? e.message : "the sender failed").slice(0, 300) || "the sender failed";
    app.run(({ contra }) => contra.memoFailed(creditId, why));
    return { state: "failed" };
  }
  app.run(({ contra }) => contra.memoSent(creditId, messageId));
  return { state: "sent" };
}

export function confirmLink(app: App, ref: string, subcontractId?: string, by?: Human) {
  const actor = actorFor(app, PM, by);
  app.run(({ contra }) => contra.confirmLink(ref, actor, subcontractId));
}

/** The PM confirms an amount read from a photo or scanned page (typed as they see it, e.g. "$1,250.00") and links the item. */
export function confirmImageAmount(app: App, ref: string, amount: string, subcontractId: string, by?: Human) {
  const actor = actorFor(app, PM, by);
  const t = amount.trim();
  // "1,250.00" and "$1,250.00" both read; anything that isn't exactly one readable amount is refused.
  const typed = parseUsd(/^\d/.test(t) ? "$" + t : t);
  app.run(({ contra }) => contra.confirmImageAmount(ref, actor, typed, subcontractId));
}

export function draftNotice(app: App, subcontractId = DEMO_SC) {
  return app.run(({ contra }) => contra.draftNotice(subcontractId)?.id ?? null);
}

/** Only a PM approves a notice (Contra.approveNotice). In the demo the scripted approver is the PM, Dana Ortiz. */
export function approveNotice(app: App, noticeId: string, by?: Human) {
  const actor = actorFor(app, PM, by);
  app.run(({ contra }) => contra.approveNotice(noticeId, actor));
}

export function sendNotice(app: App, noticeId: string) {
  app.run(({ contra }) => contra.sendNotice(noticeId));
}

export function ingestSubReply(app: App, noticeId: string, opts: { extraction?: ExtractedResponse; extractor?: Actor } = {}) {
  demoOnly(app, "the sub's scripted reply");
  app.run(({ contra, clock }) => {
    const n = contra.notices.get(noticeId);
    if (!n || !n.sentAt) throw new Error(`notice ${noticeId} has not been sent`);
    const r = demoReply(n.id, n.body, clock.now());
    if (opts.extraction && !opts.extractor) throw new Error("a provided reply extraction needs the extractor that produced it");
    contra.ingestSubResponse(r.email, opts.extraction ?? r.extraction, opts.extractor ?? SAMPLE_EXTRACTIONS);
  });
}

export function advanceDays(app: App, days: number) {
  app.advanceDays(days);
}

export function evaluateAll(app: App) {
  return app.run(({ contra }) => [...contra.evaluateAll().entries()].map(([ref, r]) => ({ ref, status: r.status })));
}

export function proposeCredit(app: App, subcontractId = DEMO_SC) {
  return app.run(({ contra }) => contra.proposeCredit(subcontractId)?.id ?? null);
}

export function approveCredit(app: App, creditId: string, by?: Human) {
  const actor = actorFor(app, CONTROLLER, by);
  app.run(({ contra }) => contra.approveCredit(creditId, actor));
}

export function rejectCredit(app: App, creditId: string, why: string, by?: Human) {
  const actor = actorFor(app, CONTROLLER, by);
  app.run(({ contra }) => contra.rejectCredit(creditId, actor, why));
}

/** Simulates Ridgeline's $48,000 Summit bill arriving in (simulated) Ramp. */
export function billArrives(app: App) {
  demoOnly(app, "the demo bill");
  app.run(({ ramp, clock }) => {
    if (ramp.bills.some((b) => b.id === DEMO_BILL)) throw new Error("demo bill already exists");
    ramp.createBillViaApi({ id: DEMO_BILL, vendorId: "V-RIDGE", jobId: "SUM-01", amountCents: cents(4_800_000), accountingDate: clock.now(), origin: "native" });
  });
}

export function turnOnCredits(app: App, billId = DEMO_BILL, by?: Human) {
  const actor = actorFor(app, AP, by);
  app.run(({ contra }) => contra.turnOnCredits(billId, actor));
}

export function payBill(app: App, billId = DEMO_BILL, by?: Human) {
  const actor = actorFor(app, AP, by);
  return app.run(({ contra }) => contra.payBill(billId, actor).paidCents);
}

export interface ActionInput {
  /** For chooseSubcontract: the subcontract the PM picked (must be one of action.options). */
  choice?: string;
  /** For rejectCredit: the reason the controller typed. */
  reason?: string;
  /** For confirmImageAmount: the amount the PM typed from the image, e.g. "$1,250.00". */
  amount?: string;
}

/**
 * The single dispatcher every frontend uses (Next server action or HTTP API). Exhaustive: adding an
 * Action variant without a case here is a type error. Always returns a Promise, for every action: it
 * resolves once the action is recorded, and every refusal (NotOffered, a rule, a bad choice) is a
 * rejection, never a synchronous throw. Hosts must await it. Most actions are recorded before it returns;
 * sendCreditMemo settles only after the send's result is recorded.
 */
export async function runAction(
  app: App,
  action: import("./view.ts").Action,
  input: ActionInput = {},
  /**
   * Injected by the host. `pmEmails`: where "Ingest PM emails" reads from (absent or null: the built-in
   * sample). `by`: the signed-in person (the API's session); see actorFor. The live workspace refuses a
   * person's step without one.
   */
  host: { pmEmails?: PmEmailSource | null; by?: Human } = {},
): Promise<void> {
  if (!isOffered(app, action)) throw new NotOffered(`${action.command} is not available right now (refresh the screen)`);
  const by = host.by;
  switch (action.command) {
    case "ingestPmEmails":
      ingestPmEmails(app, host.pmEmails ? { emails: host.pmEmails.emails, emailOrigin: host.pmEmails.origin } : {});
      return;
    case "confirmLink":
      return confirmLink(app, action.ref, undefined, by);
    case "chooseSubcontract": {
      if (!input.choice || !action.options.includes(input.choice)) throw new Error(`choose one of: ${action.options.join(", ")}`);
      return confirmLink(app, action.ref, input.choice, by);
    }
    case "confirmImageAmount": {
      if (!input.choice || !action.options.includes(input.choice)) throw new Error(`choose one of: ${action.options.join(", ")}`);
      if (!input.amount?.trim()) throw new Error("type the amount you see in the image");
      return confirmImageAmount(app, action.ref, input.amount, input.choice, by);
    }
    case "draftNotice":
      draftNotice(app, action.subcontractId);
      return;
    case "approveNotice":
      return approveNotice(app, action.noticeId, by);
    case "sendNotice":
      return sendNotice(app, action.noticeId);
    case "ingestSubReply":
      return ingestSubReply(app, action.noticeId);
    case "advanceDays":
      return advanceDays(app, action.days);
    case "evaluateAll":
      evaluateAll(app);
      return;
    case "proposeCredit":
      proposeCredit(app, action.subcontractId);
      return;
    case "approveCredit":
      return approveCredit(app, action.creditId, by);
    case "rejectCredit": {
      const why = (input.reason ?? "").trim();
      if (!why) throw new Error("a rejection needs a reason");
      return rejectCredit(app, action.creditId, why.slice(0, 500), by);
    }
    case "billArrives":
      return billArrives(app);
    case "turnOnCredits":
      return turnOnCredits(app, action.billId, by);
    case "payBill":
      payBill(app, action.billId, by);
      return;
    case "sendCreditMemo":
      await sendCreditMemo(app, action.creditId, by);
      return;
    default: {
      const never: never = action;
      throw new Error(`unknown action ${JSON.stringify(never)}`);
    }
  }
}
