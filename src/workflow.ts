import type { AuditLog } from "./audit.ts";
import { describeWindow, type Clock } from "./clock.ts";
import { creditAmountFor } from "./credits.ts";
import { evaluateEligibility, type EligibilityResult } from "./eligibility.ts";
import { renderCreditMemo } from "./memo.ts";
import { formatUsd, sub as subCents, sum, type Cents } from "./money.ts";
import { assessExtractedItem } from "./intake.ts";
import { ambiguousWith, type Resolution } from "./resolver.ts";
import { disputeSentencesFor, normalize, verifySpan } from "./span.ts";
import { transitionBackCharge, transitionCredit, transitionNotice } from "./state.ts";
import type { MockERP } from "./mocks/erp.ts";
import { planApplication, type PaymentsPlatform, type PlannedApplication } from "./mocks/ramp.ts";
import { EMAIL_INGESTED, type EmailOrigin } from "./types.ts";
import type {
  Actor,
  BackCharge,
  Credit,
  Email,
  ExtractedBackCharge,
  ExtractedResponse,
  HoldReason,
  Notice,
} from "./types.ts";

const SYSTEM: Actor = { kind: "system", id: "contra" };

export interface Deps {
  clock: Clock;
  log: AuditLog;
  erp: MockERP;
  ramp: PaymentsPlatform;
}

export interface BillCheck {
  billId: string;
  vendorId: string;
  jobId: string;
  amountCents: Cents;
  status: "ok" | "action_needed" | "too_late";
  /** Where credits would land if credits were on for this bill (Ramp's documented order). */
  ifCreditsOn: PlannedApplication[];
  wouldPayCents: Cents;
  actions: string[];
  warnings: string[];
  heldRefs: string[];
}

export interface ContraState {
  backCharges: BackCharge[];
  notices: Notice[];
  credits: Credit[];
  emails: Email[];
  proposals: [string, Resolution][];
  lateDisputes: { ref: string; emailId: string }[];
  evidenceOk: [string, boolean][];
  sourceDispute: [string, boolean][];
  seq: { notice: number; credit: number };
}

export class Contra {
  readonly backCharges = new Map<string, BackCharge>();
  readonly notices = new Map<string, Notice>();
  readonly credits = new Map<string, Credit>();
  readonly emails = new Map<string, Email>();
  readonly proposals = new Map<string, Resolution>();
  readonly lateDisputes: { ref: string; emailId: string }[] = [];
  readonly #evidenceOk = new Map<string, boolean>();
  readonly #sourceDispute = new Map<string, boolean>();
  #seq = { notice: 0, credit: 0 };

  constructor(private readonly d: Deps) {}

  // ---- Persistence -------------------------------------------------------------------------

  snapshot(): ContraState {
    return structuredClone({
      backCharges: [...this.backCharges.values()],
      notices: [...this.notices.values()],
      credits: [...this.credits.values()],
      emails: [...this.emails.values()],
      proposals: [...this.proposals.entries()],
      lateDisputes: [...this.lateDisputes],
      evidenceOk: [...this.#evidenceOk.entries()],
      sourceDispute: [...this.#sourceDispute.entries()],
      seq: { ...this.#seq },
    });
  }

  static restore(d: Deps, s: ContraState): Contra {
    const c = new Contra(d);
    const s2 = structuredClone(s);
    for (const b of s2.backCharges) c.backCharges.set(b.ref, b);
    for (const n of s2.notices) c.notices.set(n.id, n);
    for (const x of s2.credits) c.credits.set(x.id, x);
    for (const e of s2.emails) c.emails.set(e.id, e);
    for (const [k, v] of s2.proposals) c.proposals.set(k, v);
    c.lateDisputes.push(...s2.lateDisputes);
    for (const [k, v] of s2.evidenceOk) c.#evidenceOk.set(k, v);
    for (const [k, v] of s2.sourceDispute) c.#sourceDispute.set(k, v);
    c.#seq = { ...s2.seq };
    return c;
  }

  // ---- Step 1: ingest PM emails ------------------------------------------------------------

  ingestBackChargeEmail(email: Email, extracted: ExtractedBackCharge[], extractor: Actor, origin: EmailOrigin = "builtin"): BackCharge[] {
    this.emails.set(email.id, email);
    this.d.log.append({ actor: SYSTEM, entity: "email", entityId: email.id, action: EMAIL_INGESTED[origin], from: null, to: null, evidence: [email.subject] });
    const out: BackCharge[] = [];

    for (const x of extracted) {
      const existing = this.backCharges.get(x.ref);
      if (existing) {
        if (existing.extracted.amountCents !== x.amountCents && existing.state !== "held") {
          this.#hold(existing, ["conflicting_amounts"], [`${email.id}: ${x.amountEvidence.sentence}`]);
        }
        continue;
      }

      const a = assessExtractedItem(email, x, this.d.erp, extracted.map((e) => e.ref));
      this.#evidenceOk.set(x.ref, a.evidenceOk);
      this.#sourceDispute.set(x.ref, a.disputeInSource);

      const bc: BackCharge = {
        ref: x.ref,
        extracted: x,
        state: "extracted",
        subcontractId: null,
        linkExplanation: [],
        noticeId: null,
        subResponse: null,
        holdReasons: [],
        creditId: null,
      };
      this.backCharges.set(x.ref, bc);
      this.d.log.append({
        actor: extractor,
        entity: "backcharge",
        entityId: x.ref,
        action: `extracted ${formatUsd(x.amountCents)}`,
        from: null,
        to: "extracted",
        evidence: [x.amountEvidence.sentence, ...(x.disputeEvidence ? [x.disputeEvidence.sentence] : []), ...a.backstop],
      });

      if (a.holdReasons.length) {
        this.#hold(bc, a.holdReasons, a.holdEvidence);
      } else {
        const r = a.resolution!;
        this.proposals.set(x.ref, r);
        if (r.kind === "linked") bc.linkExplanation = r.explanation;
        else transitionBackCharge(this.d.log, bc, "needs_review", SYSTEM, "resolver could not link", r.reasons);
      }
      out.push(bc);
    }
    return out;
  }

  /** PM confirms the proposed link, or picks the subcontract for a needs_review item. */
  confirmLink(ref: string, pm: Actor, chosenSubcontractId?: string): void {
    const bc = this.#bc(ref);
    const proposal = this.proposals.get(ref);
    const scId = chosenSubcontractId ?? (proposal?.kind === "linked" ? proposal.subcontractId : null);
    const sc = scId ? this.d.erp.subcontract(scId) : null;
    if (!sc) throw new Error(`${ref}: no subcontract to link to`);

    if (proposal?.kind !== "linked" || proposal.subcontractId !== sc.id) {
      const name = bc.extracted.vendorNameAsWritten;
      // Aliases apply on every job, so check every party in the ERP, not only this job's.
      const parties = [...new Set(this.d.erp.subcontracts.map((s) => s.partyLegalName))];
      const other = ambiguousWith(name, sc.partyLegalName, parties);
      if (other) {
        this.d.log.append({ actor: pm, entity: "alias", entityId: name, action: `alias not learned: "${name}" is ambiguous with ${other}`, from: null, to: null, evidence: [ref] });
      } else {
        this.d.erp.addAlias({ alias: name, partyLegalName: sc.partyLegalName, source: "pm_confirmed", confirmedBy: pm.id });
        this.d.log.append({ actor: pm, entity: "alias", entityId: name, action: `alias -> ${sc.partyLegalName}`, from: null, to: null, evidence: [ref] });
      }
      bc.linkExplanation = [`PM ${pm.id} linked "${bc.extracted.vendorNameAsWritten}" to ${sc.id} ${sc.partyLegalName}`];
    }
    bc.subcontractId = sc.id;
    transitionBackCharge(this.d.log, bc, "linked", pm, "link confirmed", bc.linkExplanation);
  }

  // ---- Step 2: notice ----------------------------------------------------------------------

  draftNotice(subcontractId: string): Notice | null {
    const sc = this.d.erp.subcontract(subcontractId);
    if (!sc) throw new Error(`no subcontract ${subcontractId}`);
    const candidates = [...this.backCharges.values()].filter((b) => b.state === "linked" && b.subcontractId === sc.id && !b.noticeId);

    const include: BackCharge[] = [];
    for (const b of candidates) {
      const r = this.#evaluate(b, "pre_notice");
      if (r.status === "held") this.#hold(b, r.holdReasons, r.trace);
      else include.push(b);
    }
    if (include.length === 0) return null;

    const job = this.d.erp.jobs.find((j) => j.id === sc.jobId)!;
    const total = sum(include.map((b) => b.extracted.amountCents));
    const clause = sc.clause!;
    const body = [
      `NOTICE OF BACK-CHARGES - Subcontract ${sc.id}, ${clause.section}`,
      `To: ${sc.partyLegalName}`,
      `Job: ${job.id} ${job.name}`,
      ``,
      ...include.map((b) => `- ${b.ref}: ${b.extracted.description} - ${formatUsd(b.extracted.amountCents)}`),
      `Total: ${formatUsd(total)}`,
      ``,
      `${clause.section}: "${clause.text}"`,
      ``,
      `You have ${describeWindow(clause.responseWindow)} from the date of this notice to dispute any item in writing, citing its number.`,
      `Undisputed amounts will be deducted from payments due under the subcontract.`,
    ].join("\n");

    const n: Notice = {
      id: `N-${++this.#seq.notice}`,
      subcontractId: sc.id,
      backChargeRefs: include.map((b) => b.ref),
      totalCents: total,
      body,
      state: "drafted",
      approvedBy: null,
      sentAt: null,
    };
    this.notices.set(n.id, n);
    this.d.log.append({ actor: SYSTEM, entity: "notice", entityId: n.id, action: `drafted ${formatUsd(total)}`, from: null, to: "drafted", evidence: n.backChargeRefs });
    return n;
  }

  approveNotice(id: string, human: Actor): void {
    const n = this.#notice(id);
    transitionNotice(this.d.log, n, "approved", human, "notice approved", [n.body]);
    n.approvedBy = human.id;
  }

  /** Sends to the in-app outbox. Throws unless a human approved it first (state machine). */
  sendNotice(id: string): void {
    const n = this.#notice(id);
    transitionNotice(this.d.log, n, "sent", SYSTEM, "notice sent to outbox", [`approved by ${n.approvedBy}`]);
    n.sentAt = this.d.clock.now();
    for (const ref of n.backChargeRefs) {
      const b = this.#bc(ref);
      b.noticeId = n.id;
      transitionBackCharge(this.d.log, b, "noticed", SYSTEM, "included in notice", [n.id]);
    }
  }

  // ---- Step 3: sub response ----------------------------------------------------------------

  ingestSubResponse(email: Email, x: ExtractedResponse, extractor: Actor): void {
    this.emails.set(email.id, email);
    const n = this.#notice(x.noticeId);
    const span = verifySpan(email, x.evidence, { excludeQuoted: true });
    this.d.log.append({ actor: extractor, entity: "email", entityId: email.id, action: `sub response to ${n.id}`, from: null, to: null, evidence: [x.evidence.sentence] });

    const all = n.backChargeRefs.map((r) => this.#bc(r));
    // Late replies still count: an eligible item with a proposed (unapproved) credit can be held.
    const live = all.filter((b) => b.state === "noticed" || b.state === "eligible");
    // Already credited: can't be undone automatically. Flag it for a human.
    for (const b of all.filter((b) => b.state === "credited" || b.state === "applied")) {
      this.lateDisputes.push({ ref: b.ref, emailId: email.id });
      this.d.log.append({ actor: SYSTEM, entity: "backcharge", entityId: b.ref, action: "reply received after credit; needs human review", from: null, to: null, evidence: [x.evidence.sentence] });
    }
    if (!span.ok) {
      // A reply we can't verify must not let the window silently close on these items.
      for (const b of live) this.#hold(b, ["unverified_evidence"], [`sub reply ${email.id}: ${span.reason}`]);
      return;
    }

    const own = normalize(email.body, { excludeQuoted: true });
    for (const b of live) {
      const num = b.ref.replace(/^\D+/, "");
      const mentioned = new RegExp(`\\b(?:BC-?)?${num}\\b`).test(own);
      const disputed =
        x.disputedRefs.includes(b.ref) ||
        (mentioned && !x.acceptedRefs.includes(b.ref)) ||
        disputeSentencesFor(email.body, b.ref, { excludeQuoted: true }).length > 0;
      b.subResponse = disputed ? "disputed" : x.acceptedRefs.includes(b.ref) ? "accepted" : null;
      if (disputed) this.#hold(b, ["disputed_by_sub"], [x.evidence.sentence]);
    }
  }

  // ---- Step 4: evaluate, propose, approve credit --------------------------------------------

  evaluateAll(): Map<string, EligibilityResult> {
    const out = new Map<string, EligibilityResult>();
    for (const b of this.backCharges.values()) {
      if (b.state !== "noticed" && b.state !== "linked") continue;
      const r = this.#evaluate(b, "final");
      out.set(b.ref, r);
      if (r.status === "held") this.#hold(b, r.holdReasons, r.trace);
      else if (r.status === "eligible") transitionBackCharge(this.d.log, b, "eligible", SYSTEM, "eligible", r.trace);
    }
    return out;
  }

  proposeCredit(subcontractId: string): Credit | null {
    const items = [...this.backCharges.values()].filter((b) => b.state === "eligible" && b.subcontractId === subcontractId && !b.creditId);
    if (items.length === 0) return null;
    const { amountCents } = creditAmountFor(items);
    const sc = this.d.erp.subcontract(subcontractId)!;
    const c: Credit = {
      id: `VC-${++this.#seq.credit}`,
      subcontractId,
      vendorId: sc.paymentsVendorId!,
      jobId: sc.jobId,
      amountCents,
      backChargeRefs: items.map((b) => b.ref),
      state: "proposed",
      approvedBy: null,
    };
    this.credits.set(c.id, c);
    this.d.log.append({ actor: SYSTEM, entity: "credit", entityId: c.id, action: `proposed ${formatUsd(amountCents)}`, from: null, to: "proposed", evidence: c.backChargeRefs });
    return c;
  }

  /** Human approval is what creates the credit in the payments platform; nothing before it does. */
  approveCredit(id: string, human: Actor): void {
    const c = this.#credit(id);
    // Re-check at approval time: items may have changed since the proposal.
    creditAmountFor(c.backChargeRefs.map((r) => this.#bc(r)));
    transitionCredit(this.d.log, c, "approved", human, `approved ${formatUsd(c.amountCents)}`, c.backChargeRefs);
    c.approvedBy = human.id;

    this.d.ramp.createCredit({ id: c.id, vendorId: c.vendorId, jobId: c.jobId, amountCents: c.amountCents, accountingDate: this.d.clock.now(), memo: `Contra ${c.id}: ${c.backChargeRefs.join(", ")}` });
    this.d.erp.syncCredit(c.id);
    this.d.ramp.markCreditSynced(c.id);
    transitionCredit(this.d.log, c, "synced", SYSTEM, "created in payments platform and synced to ERP", [c.vendorId, c.jobId]);
    for (const r of c.backChargeRefs) {
      const b = this.#bc(r);
      b.creditId = c.id;
      transitionBackCharge(this.d.log, b, "credited", SYSTEM, `on credit ${c.id}`, [c.id]);
    }
  }

  rejectCredit(id: string, human: Actor, why: string): void {
    transitionCredit(this.d.log, this.#credit(id), "rejected", human, "rejected", [why]);
  }

  /** The memo for the production route (Ramp AP inbox). Only for approved credits. */
  creditMemo(id: string): { filename: string; text: string } {
    const credit = this.#credit(id);
    const sc = this.d.erp.subcontract(credit.subcontractId)!;
    const job = this.d.erp.jobs.find((j) => j.id === credit.jobId)!;
    const items = credit.backChargeRefs.map((r) => this.#bc(r));
    const notices = [...new Set(items.map((b) => b.noticeId))].filter((x): x is string => !!x).map((n) => this.#notice(n));
    const approval = this.d.log.forEntity("credit", id).find((e) => e.to === "approved");
    if (!approval) throw new Error(`credit ${id} has no recorded approval`);
    return renderCreditMemo({ credit, subcontract: sc, job, vendorName: sc.partyLegalName, items, notices, approvedAt: approval.at });
  }

  // ---- Step 5: bill and payment ------------------------------------------------------------

  /** Shows where credits would land BEFORE anyone turns credits on for a bill. */
  previewBill(billId: string): { plan: PlannedApplication[]; warnings: string[] } {
    const plan = this.d.ramp.previewApplication(billId);
    const warnings = plan.filter((p) => p.jobMismatch).map((p) => `credit ${p.creditId} is for job ${p.creditJobId} but would apply to bill ${billId} on another job`);
    return { plan, warnings };
  }

  /**
   * Run when a sub's bill arrives (production: Ramp's bills.created / bills.approved webhooks).
   * Read-only. Credits can't be applied once payment starts, so this is the last moment to act.
   */
  billArrivalCheck(billId: string): BillCheck {
    const bill = this.d.ramp.getBill(billId);
    const actions: string[] = [];
    const warnings: string[] = [];
    const scIds = new Set(this.d.erp.subcontracts.filter((s) => s.paymentsVendorId === bill.vendorId).map((s) => s.id));
    const mine = [...this.backCharges.values()].filter((b) => b.subcontractId && scIds.has(b.subcontractId));
    const heldRefs = mine.filter((b) => b.state === "held").map((b) => b.ref);
    const base = { billId, vendorId: bill.vendorId, jobId: bill.jobId, amountCents: bill.amountCents, heldRefs };

    if (bill.status !== "approved") {
      return { ...base, status: "too_late", ifCreditsOn: [], wouldPayCents: bill.paidCents ?? bill.amountCents, actions, warnings: [`bill is ${bill.status}; credits can no longer be applied to it`] };
    }

    const proposed = [...this.credits.values()].filter((c) => c.vendorId === bill.vendorId && c.state === "proposed");
    const onProposal = new Set(proposed.flatMap((c) => c.backChargeRefs));
    const unproposed = mine.filter((b) => b.state === "eligible" && !b.creditId && !onProposal.has(b.ref));
    if (unproposed.length) {
      actions.push(`propose a credit for ${unproposed.map((b) => b.ref).join(", ")} (${formatUsd(sum(unproposed.map((b) => b.extracted.amountCents)))}) before paying`);
    }
    for (const c of proposed) actions.push(`approve credit ${c.id} (${formatUsd(c.amountCents)}) before paying`);

    const plan = bill.origin === "imported" ? [] : planApplication(bill, this.d.ramp.listCredits(bill.vendorId));
    if (bill.origin === "imported" && (planApplication(bill, this.d.ramp.listCredits(bill.vendorId)).length || unproposed.length || proposed.length)) {
      warnings.push("imported bill: Ramp can't apply credits to imported bills; deduct another way or re-create the bill in Ramp");
    }
    if (plan.length && !bill.applyCredits) {
      actions.push(`turn on credits for this bill: ${plan.map((p) => `${p.creditId} ${formatUsd(p.cents)}`).join(", ")} would apply`);
    }
    for (const p of plan.filter((x) => x.jobMismatch)) {
      warnings.push(`credit ${p.creditId} is for job ${p.creditJobId} but this bill is for ${bill.jobId}`);
    }
    if (heldRefs.length) warnings.push(`${heldRefs.join(", ")} held (disputed or unverified); not deductible yet`);

    const wouldPayCents = subCents(bill.amountCents, sum(plan.map((p) => p.cents)));
    return { ...base, status: actions.length ? "action_needed" : "ok", ifCreditsOn: plan, wouldPayCents, actions, warnings };
  }

  payBill(billId: string, actor: Actor) {
    const result = this.d.ramp.payBill(billId);
    this.d.log.append({
      actor,
      entity: "bill",
      entityId: billId,
      action: `paid ${formatUsd(result.paidCents)}`,
      from: "approved",
      to: "paid",
      evidence: result.applied.map((a) => `${a.creditId} applied ${formatUsd(a.cents)}`),
    });
    for (const a of result.applied) {
      const c = this.credits.get(a.creditId);
      if (!c || c.state !== "synced") continue;
      if (this.d.ramp.creditRemaining(c.id) === 0) {
        transitionCredit(this.d.log, c, "applied", SYSTEM, `applied to ${billId}`, [billId]);
        for (const r of c.backChargeRefs) transitionBackCharge(this.d.log, this.#bc(r), "applied", SYSTEM, `deducted on ${billId}`, [billId]);
      }
    }
    return result;
  }

  // ---- Read-only views ---------------------------------------------------------------------

  /** Why an item is (or isn't) eligible right now. Read-only; changes nothing. */
  explainEligibility(ref: string): EligibilityResult {
    return this.#evaluate(this.#bc(ref), "final");
  }

  get audit(): AuditLog {
    return this.d.log;
  }

  // ---- Queues ------------------------------------------------------------------------------

  pmQueue(): BackCharge[] {
    return [...this.backCharges.values()].filter((b) => b.state === "needs_review" || b.state === "held");
  }

  // ---- internals ---------------------------------------------------------------------------

  #evaluate(b: BackCharge, phase: "pre_notice" | "final"): EligibilityResult {
    return evaluateEligibility({
      bc: b,
      subcontract: b.subcontractId ? this.d.erp.subcontract(b.subcontractId) : null,
      notice: b.noticeId ? this.notices.get(b.noticeId) ?? null : null,
      evidenceVerified: this.#evidenceOk.get(b.ref) ?? false,
      disputeInSource: this.#sourceDispute.get(b.ref) ?? true,
      now: this.d.clock.now(),
      phase,
    });
  }

  #hold(b: BackCharge, reasons: HoldReason[], evidence: string[]): void {
    b.holdReasons = [...new Set([...b.holdReasons, ...reasons])];
    if (b.state !== "held") transitionBackCharge(this.d.log, b, "held", SYSTEM, `held: ${reasons.join(", ")}`, evidence);
  }

  #bc(ref: string): BackCharge {
    const b = this.backCharges.get(ref);
    if (!b) throw new Error(`no back-charge ${ref}`);
    return b;
  }
  #notice(id: string): Notice {
    const n = this.notices.get(id);
    if (!n) throw new Error(`no notice ${id}`);
    return n;
  }
  #credit(id: string): Credit {
    const c = this.credits.get(id);
    if (!c) throw new Error(`no credit ${id}`);
    return c;
  }
}
