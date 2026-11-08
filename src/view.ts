import type { AuditEvent } from "./audit.ts";
import type { App } from "./app.ts";
import { DEMO_BILL, DEMO_SC } from "./commands.ts";
import { formatUsd } from "./money.ts";
import type { Actor, BackCharge, Credit, HoldReason, Notice } from "./types.ts";

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
  | { command: "payBill"; billId: string };

const HOLD_WORDS: Record<HoldReason, string> = {
  dispute_noted_in_source: "dispute noted in the PM's email",
  disputed_by_sub: "disputed by the sub",
  no_clause: "no back-charge clause",
  clause_forbids_deduction: "clause does not allow deduction",
  no_notice_evidence: "no notice was sent",
  no_payments_vendor: "sub not mapped to a Ramp vendor",
  unverified_evidence: "amount not found in the source email",
  conflicting_amounts: "two emails give different amounts",
  unresolved_link: "not linked to a subcontract",
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

export function actorLabel(a: Actor): string {
  if (a.kind === "human") return `${a.id} (${a.role === "pm" ? "PM" : a.role === "ap" ? "AP" : "Controller"})`;
  if (a.kind === "llm") return `AI extractor (${a.model})`;
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
  now: string;
  nextStep: { text: string; action: Action | null };
  inbox: InboxRow[];
  outbox: { id: string; total: string; refs: string[]; body: string; status: Status; actions: Action[] }[];
  credits: { id: string; amount: string; job: string; refs: string[]; status: Status; actions: Action[]; hasMemo: boolean }[];
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
      const options = proposal?.kind === "review" ? proposal.hints.map((h) => h.split(" ")[0]!) : [];
      actions.push({ command: "chooseSubcontract", ref: b.ref, options: options.length ? options : erp.subcontracts.map((s) => s.id) });
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

  const creditRows = credits.map((c) => ({
    id: c.id,
    amount: formatUsd(c.amountCents),
    job: c.jobId,
    refs: c.backChargeRefs,
    status: CREDIT_STATUS[c.state],
    actions: (c.state === "proposed"
      ? [
          { command: "approveCredit", creditId: c.id },
          { command: "rejectCredit", creditId: c.id },
        ]
      : []) as Action[],
    hasMemo: c.state === "approved" || c.state === "synced" || c.state === "applied",
  }));

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

  return {
    now: when(clock.now()),
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

/** Presenter guidance for the demo, derived only from state. */
export function nextStep(app: App): { text: string; action: Action | null } {
  const { contra, ramp } = app.ctx;
  const bcs = [...contra.backCharges.values()];
  const notices = [...contra.notices.values()];
  const credits = [...contra.credits.values()];
  const bill = ramp.bills.find((b) => b.id === DEMO_BILL);

  if (bcs.length === 0) return { text: "Ingest the PM's back-charge emails", action: null };
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
