import type { AuditEvent } from "./audit.ts";
import type { App, Workspace } from "./app.ts";
import { DEMO_BILL, DEMO_SC } from "./commands.ts";
import { formatUsd } from "./money.ts";
import { matchJobs, type Resolution } from "./resolver.ts";
import { EMAIL_INGESTED, type Actor, type BackCharge, type Credit, type EmailOrigin, type HoldReason, type Job, type Notice, type Subcontract } from "./types.ts";
import { Contra } from "./workflow.ts";

/**
 * Pure screen data. Screens render this and nothing else: every status word, amount and available
 * button comes from stored state here, never from component logic. Tone is decoration; the label
 * always carries the meaning on its own.
 */

export type Tone = "ok" | "warn" | "danger" | "info" | "idle";
export interface Status {
  label: string;
  tone: Tone;
}
export type Action =
  | { command: "ingestPmEmails" }
  | { command: "confirmLink"; ref: string }
  | { command: "chooseSubcontract"; ref: string; options: string[] }
  | { command: "draftNotice"; subcontractId: string }
  | { command: "approveNotice"; noticeId: string }
  | { command: "sendNotice"; noticeId: string }
  | { command: "ingestSubReply"; noticeId: string }
  | { command: "advanceDays"; days: number }
  | { command: "evaluateAll" }
  | { command: "proposeCredit"; subcontractId: string }
  | { command: "approveCredit"; creditId: string }
  | { command: "rejectCredit"; creditId: string }
  | { command: "billArrives" }
  | { command: "turnOnCredits"; billId: string }
  | { command: "payBill"; billId: string }
  | { command: "sendCreditMemo"; creditId: string };

export const HOLD_WORDS: Record<HoldReason, string> = {
  dispute_noted_in_source: "dispute noted in the PM's email",
  disputed_by_sub: "disputed by the sub",
  no_clause: "no back-charge clause",
  clause_forbids_deduction: "clause does not allow deduction",
  no_notice_evidence: "no notice was sent",
  no_payments_vendor: "sub not mapped to a Ramp vendor",
  unverified_evidence: "amount not found in the source email",
  conflicting_amounts: "two emails give different amounts",
  unresolved_link: "not linked to a subcontract",
  only_in_quoted_text: "found only in quoted or forwarded text (may already have been sent or credited)",
  suspicious_instructions: "email contains instructions aimed at an AI or automated system",
  unaccounted_reference: "the email mentions a back-charge number that wasn't extracted",
};

export function backChargeStatus(b: Readonly<BackCharge>): Status {
  switch (b.state) {
    case "extracted":
      return { label: "Waiting for PM to confirm the link", tone: "warn" };
    case "needs_review":
      return { label: "PM must choose the subcontract", tone: "warn" };
    case "linked":
      return { label: "Linked, no notice yet", tone: "info" };
    case "noticed":
      return { label: "Notice sent, response window open", tone: "info" };
    case "held":
      return { label: `Held: ${b.holdReasons.map((r) => HOLD_WORDS[r]).join("; ")}`, tone: "danger" };
    case "eligible":
      return { label: "Eligible to deduct", tone: "ok" };
    case "credited":
      return { label: `On credit ${b.creditId}`, tone: "ok" };
    case "applied":
      return { label: `Deducted (credit ${b.creditId})`, tone: "ok" };
  }
}

const NOTICE_STATUS: Record<Notice["state"], Status> = {
  drafted: { label: "Draft, needs controller approval", tone: "warn" },
  approved: { label: "Approved, not sent", tone: "info" },
  sent: { label: "Sent", tone: "ok" },
};

const CREDIT_STATUS: Record<Credit["state"], Status> = {
  proposed: { label: "Proposed, needs controller approval", tone: "warn" },
  rejected: { label: "Rejected", tone: "idle" },
  approved: { label: "Approved", tone: "info" },
  synced: { label: "Approved and synced to ERP", tone: "ok" },
  applied: { label: "Applied to a bill", tone: "ok" },
};

/** The memo's delivery in words. "queued" that stays queued means the send may or may not have happened. */
export function memoStatus(c: Readonly<Credit>): Status {
  const d = c.memoDelivery;
  if (!d) return { label: "Memo not sent", tone: "idle" };
  switch (d.state) {
    case "queued":
      return { label: `Memo sending to ${d.to} (if this doesn't change, check that inbox before sending again)`, tone: "warn" };
    case "sent":
      return { label: `Memo sent to ${d.to}`, tone: "ok" };
    case "failed":
      return { label: `Memo not sent: ${d.error ?? "the send failed"}. You can send it again.`, tone: "danger" };
  }
}

export function actorLabel(a: Actor): string {
  if (a.kind === "human") return `${a.id} (${a.role === "pm" ? "PM" : a.role === "ap" ? "AP" : "Controller"})`;
  if (a.kind === "llm") return `AI extractor (${a.model})`;
  if (a.id === "sample-extractions") return "Sample extractions (hand-written)";
  return "Contra";
}

export interface InboxRow {
  ref: string;
  emailSubject: string;
  vendorAsWritten: string;
  amount: string;
  sourceSentence: string;
  linkExplanation: string[];
  status: Status;
  actions: Action[];
}

export interface Screens {
  /** "demo" (the scripted demo) or "live" (mail from the live inbox only). Each is separate state. */
  workspace: Workspace;
  now: string;
  /** Who produced the extractions on screen. "sample" must be shown as hand-written, never as AI output. */
  extractionSource: "model" | "sample" | "mixed" | null;
  /** Where the Inbox's PM emails were read from: "eml" (.eml files), "builtin" (built-in sample), "gmail" (the live inbox), "mixed", or null before ingest. */
  emailSource: EmailOrigin | "mixed" | null;
  nextStep: { text: string; action: Action | null };
  inbox: InboxRow[];
  outbox: { id: string; total: string; refs: string[]; body: string; status: Status; actions: Action[] }[];
  /** memo: the memo's delivery to the AP inbox, or null when the credit has no memo yet (not approved). */
  credits: { id: string; amount: string; job: string; refs: string[]; status: Status; actions: Action[]; hasMemo: boolean; memo: Status | null }[];
  bills: {
    id: string;
    vendor: string;
    job: string;
    amount: string;
    creditsOn: boolean;
    status: Status;
    paid: string | null;
    check: { status: Status; actions: string[]; warnings: string[]; wouldPay: string };
    actions: Action[];
    simulated: true;
  }[];
  pmQueue: { ref: string; status: Status }[];
  opener: { sampleData: true; notDeducted: string; possible: string; deducted: string; rows: { ref: string; status: string; amount: string; evidence: string }[] };
  audit: { seq: number; at: string; actor: string; what: string; evidence: string[] }[];
}

const when = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ") + " UTC";

/**
 * The picker for a needs_review item never crosses jobs. When the job resolved: the resolver's hints on
 * that job, or else every subcontract on that job. Every subcontract only when no single job resolved.
 */
export function subcontractOptions(jobRef: string, proposal: Resolution | undefined, jobs: readonly Job[], subcontracts: readonly Subcontract[]): string[] {
  const matched = matchJobs(jobRef, jobs);
  if (matched.length !== 1) return subcontracts.map((s) => s.id);
  const onJob = subcontracts.filter((s) => s.jobId === matched[0]!.id).map((s) => s.id);
  const hinted = proposal?.kind === "review" ? proposal.hints.map((h) => h.split(" ")[0]!).filter((id) => onJob.includes(id)) : [];
  return hinted.length ? hinted : onJob;
}

export function buildScreens(app: App): Screens {
  const { contra, ramp, erp, clock } = app.ctx;
  const bcs = [...contra.backCharges.values()];
  const notices = [...contra.notices.values()];
  const credits = [...contra.credits.values()];

  const inbox: InboxRow[] = bcs.map((b) => {
    const email = contra.emails.get(b.extracted.amountEvidence.emailId);
    const proposal = contra.proposals.get(b.ref);
    const actions: Action[] = [];
    if (b.state === "extracted" && proposal?.kind === "linked") actions.push({ command: "confirmLink", ref: b.ref });
    if (b.state === "needs_review") {
      actions.push({ command: "chooseSubcontract", ref: b.ref, options: subcontractOptions(b.extracted.jobRef, proposal, erp.jobs, erp.subcontracts) });
    }
    return {
      ref: b.ref,
      emailSubject: email?.subject ?? "",
      vendorAsWritten: b.extracted.vendorNameAsWritten,
      amount: formatUsd(b.extracted.amountCents),
      sourceSentence: b.extracted.amountEvidence.sentence,
      linkExplanation: b.linkExplanation.length ? b.linkExplanation : proposal?.kind === "review" ? proposal.reasons : [],
      status: backChargeStatus(b),
      actions,
    };
  });

  const outbox = notices.map((n) => ({
    id: n.id,
    total: formatUsd(n.totalCents),
    refs: n.backChargeRefs,
    body: n.body,
    status: NOTICE_STATUS[n.state],
    actions: (n.state === "drafted"
      ? [{ command: "approveNotice", noticeId: n.id }]
      : n.state === "approved"
        ? [{ command: "sendNotice", noticeId: n.id }]
        : []) as Action[],
  }));

  const creditRows = credits.map((c) => {
    const hasMemo = c.state === "approved" || c.state === "synced" || c.state === "applied";
    const actions: Action[] =
      c.state === "proposed"
        ? [
            { command: "approveCredit", creditId: c.id },
            { command: "rejectCredit", creditId: c.id },
          ]
        : [];
    // Offered only with a memo sender configured, for a credit with a recorded approval whose memo isn't sent (or failed).
    if (app.ctx.memoSender && Contra.memoSendable(c)) actions.push({ command: "sendCreditMemo", creditId: c.id });
    return {
      id: c.id,
      amount: formatUsd(c.amountCents),
      job: c.jobId,
      refs: c.backChargeRefs,
      status: CREDIT_STATUS[c.state],
      actions,
      hasMemo,
      memo: hasMemo ? memoStatus(c) : null,
    };
  });

  const bills = ramp.bills
    .filter((b) => !b.id.startsWith("B-OLD"))
    .map((b) => {
      const check = contra.billArrivalCheck(b.id);
      const vendor = ramp.vendors.find((v) => v.id === b.vendorId);
      const actions: Action[] = [];
      if (b.status === "approved" && !b.applyCredits && check.ifCreditsOn.length) actions.push({ command: "turnOnCredits", billId: b.id });
      if (b.status === "approved") actions.push({ command: "payBill", billId: b.id });
      return {
        id: b.id,
        vendor: vendor?.name ?? b.vendorId,
        job: b.jobId,
        amount: formatUsd(b.amountCents),
        creditsOn: b.applyCredits,
        status: b.status === "paid" ? { label: "Paid (simulated)", tone: "ok" as Tone } : { label: "Approved, not paid", tone: "info" as Tone },
        paid: b.paidCents === null ? null : formatUsd(b.paidCents),
        check: {
          status: { ok: { label: "Ready to pay", tone: "ok" }, action_needed: { label: "Action needed before paying", tone: "warn" }, too_late: { label: "Paid; too late to apply credits", tone: "idle" } }[check.status] as Status,
          actions: check.actions,
          warnings: check.warnings,
          wouldPay: formatUsd(check.wouldPayCents),
        },
        actions,
        simulated: true as const,
      };
    });

  const recon = app.missedBackCharges();
  const opener = {
    sampleData: true as const,
    notDeducted: formatUsd(recon.totals.not_deducted),
    possible: formatUsd(recon.totals.possible_match),
    deducted: formatUsd(recon.totals.deducted),
    rows: recon.rows.map((r) => ({ ref: r.item.ref, status: r.status.replace("_", " "), amount: formatUsd(r.item.amountCents), evidence: r.evidence })),
  };

  const audit = [...contra.audit.all()]
    .reverse()
    .map((e: AuditEvent) => ({
      seq: e.seq,
      at: when(e.at),
      actor: actorLabel(e.actor),
      what: `${e.entity} ${e.entityId}: ${e.action}${e.from || e.to ? ` (${e.from ?? "new"} → ${e.to ?? e.from})` : ""}`,
      evidence: [...e.evidence],
    }));

  const extractedBy = [...contra.audit.all()].filter((e) => e.entity === "backcharge" && e.to === "extracted").map((e) => e.actor.kind);
  const extractionSource: Screens["extractionSource"] =
    extractedBy.length === 0 ? null : extractedBy.every((k) => k === "llm") ? "model" : extractedBy.some((k) => k === "llm") ? "mixed" : "sample";

  const origins = new Set(emailOrigins(app).values());
  const emailSource: Screens["emailSource"] = origins.size === 0 ? null : origins.size === 1 ? [...origins][0]! : "mixed";

  return {
    workspace: app.ctx.workspace,
    now: when(clock.now()),
    extractionSource,
    emailSource,
    nextStep: nextStep(app),
    inbox,
    outbox,
    credits: creditRows,
    bills,
    pmQueue: contra.pmQueue().map((b) => ({ ref: b.ref, status: backChargeStatus(b) })),
    opener,
    audit,
  };
}

/** Each ingested email's origin, by email id, from the audit log ("ingested" alone is built-in). */
function emailOrigins(app: App): Map<string, EmailOrigin> {
  const byAction = new Map(Object.entries(EMAIL_INGESTED).map(([origin, action]) => [action, origin as EmailOrigin]));
  const out = new Map<string, EmailOrigin>();
  for (const e of app.ctx.contra.audit.all()) {
    const origin = e.entity === "email" ? byAction.get(e.action) : undefined;
    if (origin) out.set(e.entityId, origin);
  }
  return out;
}

/**
 * Presenter guidance for the demo, derived only from state. It follows the demo's own emails (built-in
 * or .eml) only: mail from the live inbox is handled with its own row buttons and never steers the script.
 */
export function nextStep(app: App): { text: string; action: Action | null } {
  if (app.ctx.workspace === "live") return liveNextStep(app);
  const { contra, ramp } = app.ctx;
  const origins = emailOrigins(app);
  const live = (emailId: string) => origins.get(emailId) === "gmail";
  const bcs = [...contra.backCharges.values()].filter((b) => !live(b.extracted.amountEvidence.emailId));
  const notices = [...contra.notices.values()];
  const credits = [...contra.credits.values()];
  const bill = ramp.bills.find((b) => b.id === DEMO_BILL);

  const demoIngested = [...origins.values()].some((o) => o !== "gmail");
  if (!demoIngested && bcs.length === 0) return { text: "Ingest the PM's back-charge emails", action: { command: "ingestPmEmails" } };
  const toConfirm = bcs.find((b) => b.state === "extracted" || b.state === "needs_review");
  if (toConfirm) return { text: `PM confirms the link for ${toConfirm.ref}`, action: { command: "confirmLink", ref: toConfirm.ref } };
  if (notices.length === 0) return { text: "Draft the back-charge notice", action: { command: "draftNotice", subcontractId: DEMO_SC } };
  const n = notices[0]!;
  if (n.state === "drafted") return { text: "Controller approves the notice", action: { command: "approveNotice", noticeId: n.id } };
  if (n.state === "approved") return { text: "Send the notice", action: { command: "sendNotice", noticeId: n.id } };
  const replied = bcs.some((b) => b.subResponse !== null);
  if (!replied && bcs.some((b) => b.state === "noticed")) return { text: "Ridgeline replies", action: { command: "ingestSubReply", noticeId: n.id } };
  if (bcs.some((b) => b.state === "noticed")) {
    const r = contra.explainEligibility(bcs.find((b) => b.state === "noticed")!.ref);
    if (r.status === "pending") return { text: "Wait for the response window: advance a week", action: { command: "advanceDays", days: 7 } };
    return { text: "Check eligibility", action: { command: "evaluateAll" } };
  }
  const proposed = credits.find((c) => c.state === "proposed");
  if (proposed) return { text: `Controller approves credit ${proposed.id}`, action: { command: "approveCredit", creditId: proposed.id } };
  if (bcs.some((b) => b.state === "eligible" && !b.creditId)) return { text: "Propose the vendor credit", action: { command: "proposeCredit", subcontractId: DEMO_SC } };
  if (!bill) return { text: "Ridgeline's $48,000 bill arrives", action: { command: "billArrives" } };
  if (bill.status === "approved" && !bill.applyCredits) return { text: "Turn on credits for the bill", action: { command: "turnOnCredits", billId: bill.id } };
  if (bill.status === "approved") return { text: "Pay the bill (simulated)", action: { command: "payBill", billId: bill.id } };
  return { text: "Demo complete", action: null };
}

/**
 * Guidance for the live workspace: the same workflow, for whatever the live inbox brought in, with none of
 * the demo's scripted steps (its emails, the sub's reply, the bill). Ends at the credit memo, the real
 * route into Ramp. action is null while a person must choose in a row, and while waiting for mail.
 */
function liveNextStep(app: App): { text: string; action: Action | null } {
  const { contra } = app.ctx;
  const bcs = [...contra.backCharges.values()];
  const toConfirm = bcs.find((b) => b.state === "extracted" && contra.proposals.get(b.ref)?.kind === "linked");
  if (toConfirm) return { text: `PM confirms the link for ${toConfirm.ref}`, action: { command: "confirmLink", ref: toConfirm.ref } };
  const toChoose = bcs.find((b) => b.state === "needs_review");
  if (toChoose) return { text: `PM chooses the subcontract for ${toChoose.ref} (in its Inbox row)`, action: null };
  const notices = [...contra.notices.values()];
  const drafted = notices.find((n) => n.state === "drafted");
  if (drafted) return { text: `Controller approves notice ${drafted.id}`, action: { command: "approveNotice", noticeId: drafted.id } };
  const approved = notices.find((n) => n.state === "approved");
  if (approved) return { text: `Send notice ${approved.id}`, action: { command: "sendNotice", noticeId: approved.id } };
  // After the unsent notices above: an item stays "linked" until its notice is sent, so drafting must wait
  // until no notice is drafted or approved, or the same items would be drafted twice.
  const linked = bcs.find((b) => b.state === "linked" && b.subcontractId && !b.noticeId);
  if (linked) return { text: `Draft the back-charge notice for ${linked.subcontractId}`, action: { command: "draftNotice", subcontractId: linked.subcontractId! } };
  const noticed = bcs.filter((b) => b.state === "noticed");
  if (noticed.length) {
    if (noticed.every((b) => contra.explainEligibility(b.ref).status === "pending")) return { text: "Wait for the response window: advance a week (moves this workspace 7 days ahead of real time)", action: { command: "advanceDays", days: 7 } };
    return { text: "Check eligibility", action: { command: "evaluateAll" } };
  }
  const credits = [...contra.credits.values()];
  const proposed = credits.find((c) => c.state === "proposed");
  if (proposed) return { text: `Controller approves credit ${proposed.id}`, action: { command: "approveCredit", creditId: proposed.id } };
  const eligible = bcs.find((b) => b.state === "eligible" && !b.creditId && b.subcontractId);
  if (eligible) return { text: `Propose the vendor credit for ${eligible.subcontractId}`, action: { command: "proposeCredit", subcontractId: eligible.subcontractId! } };
  const unsent = app.ctx.memoSender ? credits.find((c) => Contra.memoSendable(c) && !c.memoDelivery) : undefined;
  if (unsent) return { text: `Send the credit memo for ${unsent.id} to the AP inbox`, action: { command: "sendCreditMemo", creditId: unsent.id } };
  return { text: "Waiting for back-charge emails from the live inbox", action: null };
}

export interface BackChargeDetail {
  ref: string;
  description: string;
  amount: string;
  status: Status;
  vendorAsWritten: string;
  jobRef: string;
  email: { id: string; subject: string; from: string; body: string } | null;
  sourceSentence: string;
  disputeSentence: string | null;
  link: { subcontractId: string | null; explanation: string[] };
  /** The subcontract's back-charge clause, quoted, or null if not linked / no clause. */
  clause: { section: string; text: string; responseWindow: string; deductionAllowed: boolean; noticeRequired: boolean } | null;
  eligibility: { status: "eligible" | "pending" | "held"; holdReasons: string[]; waitingFor: string[]; trace: string[] };
  history: { seq: number; at: string; actor: string; what: string; evidence: string[] }[];
}

const WINDOW_WORDS = { hours: "hours", calendar_days: "calendar days", working_days: "working days" } as const;

/** Everything the back-charge detail screen shows. Read-only. Throws for an unknown ref. */
export function backChargeDetail(app: App, ref: string): BackChargeDetail {
  const { contra, erp } = app.ctx;
  const b = contra.backCharges.get(ref);
  if (!b) throw new Error(`no back-charge ${ref}`);
  const email = contra.emails.get(b.extracted.amountEvidence.emailId) ?? null;
  const proposal = contra.proposals.get(ref);
  const scId = b.subcontractId ?? (proposal?.kind === "linked" ? proposal.subcontractId : null);
  const sc = scId ? erp.subcontract(scId) : null;
  const r = contra.explainEligibility(ref);
  return {
    ref,
    description: b.extracted.description,
    amount: formatUsd(b.extracted.amountCents),
    status: backChargeStatus(b),
    vendorAsWritten: b.extracted.vendorNameAsWritten,
    jobRef: b.extracted.jobRef,
    email: email ? { id: email.id, subject: email.subject, from: email.from, body: email.body } : null,
    sourceSentence: b.extracted.amountEvidence.sentence,
    disputeSentence: b.extracted.disputeEvidence?.sentence || null,
    link: { subcontractId: b.subcontractId, explanation: b.linkExplanation.length ? b.linkExplanation : proposal?.kind === "review" ? proposal.reasons : proposal?.kind === "linked" ? proposal.explanation : [] },
    clause: sc?.clause
      ? {
          section: sc.clause.section,
          text: sc.clause.text,
          responseWindow: `${sc.clause.responseWindow.amount} ${WINDOW_WORDS[sc.clause.responseWindow.unit]}`,
          deductionAllowed: sc.clause.deductionAllowed,
          noticeRequired: sc.clause.noticeRequired,
        }
      : null,
    eligibility: { status: r.status, holdReasons: r.holdReasons.map((h) => HOLD_WORDS[h]), waitingFor: r.pendingReasons, trace: r.trace },
    history: contra.audit.forEntity("backcharge", ref).map((e) => ({ seq: e.seq, at: when(e.at), actor: actorLabel(e.actor), what: e.action + (e.from || e.to ? ` (${e.from ?? "new"} → ${e.to ?? e.from})` : ""), evidence: [...e.evidence] })),
  };
}

/** Every action the screens currently offer. runAction refuses anything else (forged, stale or double-clicked). */
export function offeredActions(app: App): Action[] {
  const s = buildScreens(app);
  const all: Action[] = [
    ...s.inbox.flatMap((r) => r.actions),
    ...s.outbox.flatMap((r) => r.actions),
    ...s.credits.flatMap((r) => r.actions),
    ...s.bills.flatMap((r) => r.actions),
    ...(s.nextStep.action ? [s.nextStep.action] : []),
  ];
  return all;
}

const canonical = (a: Action) => JSON.stringify(Object.keys(a).sort().map((k) => [k, (a as Record<string, unknown>)[k]]));

export function isOffered(app: App, action: Action): boolean {
  const want = canonical(action);
  return offeredActions(app).some((a) => canonical(a) === want);
}
