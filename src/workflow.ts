import type { AuditLog } from "./audit.ts";
import { describeWindow, type Clock } from "./clock.ts";
import { backChargeAmount, creditAmountFor } from "./credits.ts";
import { evaluateEligibility, type EligibilityResult } from "./eligibility.ts";
import { renderCreditMemo } from "./memo.ts";
import { formatUsd, sub as subCents, sum, type Cents } from "./money.ts";
import { assessExtractedItem, conflictingStatements } from "./intake.ts";
import { ambiguousWith, matchJobs, resolve, type Resolution } from "./resolver.ts";
import { describeAt, describeAttachment, disputeSentencesFor, normalize, readFromImage, verifySpan } from "./span.ts";
import { duplicateReason, type DuplicateView } from "./duplicates.ts";
import { estimateWording } from "./estimate.ts";
import { IllegalTransition, transitionBackCharge, transitionCredit, transitionMemo, transitionNotice } from "./state.ts";
import type { MockERP } from "./mocks/erp.ts";
import { planApplication, type PaymentsPlatform, type PlannedApplication } from "./mocks/ramp.ts";
import { requireRole, requireSeparateFrom } from "./roles.ts";
import { EMAIL_INGESTED, ROLE_WORDS, type EmailOrigin } from "./types.ts";
import type {
  Actor,
  AmountConfirmation,
  BackCharge,
  Credit,
  Email,
  ExtractedBackCharge,
  ExtractedResponse,
  HoldReason,
  Human,
  Notice,
  RejectedExtraction,
  RejectedItem,
} from "./types.ts";

const SYSTEM: Actor = { kind: "system", id: "contra" };

/** Contra's own reference for a back-charge the email gave no BC number: "CONTRA-0001". No accounting BC number looks like it. */
export const CONTRA_REF = /^CONTRA-\d{4,}$/;
const contraRef = (n: number) => `CONTRA-${String(n).padStart(4, "0")}`;

/** The item's accounting BC number, or null while it has none yet. */
export function bcNumberOf(b: Readonly<BackCharge>): string | null {
  return b.bcNumber === undefined ? b.ref : b.bcNumber;
}

/**
 * The item's reference as screens and notices show it: "BC-4467"; "CONTRA-0001 (no BC number yet)"; or,
 * once a later email supplied the BC number for it, "CONTRA-0001 (BC-4480)".
 */
export function refLabel(b: Readonly<BackCharge>): string {
  const bc = bcNumberOf(b);
  if (bc === b.ref) return b.ref;
  return bc === null ? `${b.ref} (no BC number yet)` : `${b.ref} (${bc})`;
}

/** Both readings of a confirmed image amount: "PM entered $640.00; model read $604.00". */
export function confirmationNote(c: Readonly<AmountConfirmation>): string {
  return `${c.byRole} entered ${formatUsd(c.enteredCents)}; model read ${formatUsd(c.modelCents)}`;
}

/** The wording that makes the item's amount an estimate in its source sentence ("approximately"), or null. */
export function estimateOf(b: Readonly<BackCharge>): string | null {
  return estimateWording(b.extracted.amountEvidence.sentence);
}

/**
 * What the person approving a credit must see about its amounts, one line per note:
 * - an amount a person confirmed from an image: who, from where, and both readings;
 * - an amount the source email calls an estimate: `BC-4480: the amount is an estimate (the email says "approximately")`.
 */
export function amountNotes(items: readonly Readonly<BackCharge>[]): string[] {
  return items.flatMap((b) => {
    const est = estimateOf(b);
    return [
      ...(b.amountConfirmation ? [`${b.ref}: amount confirmed by ${b.amountConfirmation.by} from ${b.amountConfirmation.from} (${confirmationNote(b.amountConfirmation)})`] : []),
      ...(est ? [`${b.ref}: the amount is an estimate (the email says "${est}")`] : []),
    ];
  });
}

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
  /** Absent in snapshots written before rejected extractions were kept. */
  rejected?: RejectedItem[];
  /** Pairs of refs the PM said are different charges (never asked again). Absent in older snapshots. */
  distinct?: [string, string][];
  /** contraRef: Contra references handed out (CONTRA-0001 ...). Absent in older snapshots: 0. */
  seq: { notice: number; credit: number; contraRef?: number };
}

export class Contra {
  readonly backCharges = new Map<string, BackCharge>();
  readonly notices = new Map<string, Notice>();
  readonly credits = new Map<string, Credit>();
  readonly emails = new Map<string, Email>();
  readonly proposals = new Map<string, Resolution>();
  readonly lateDisputes: { ref: string; emailId: string }[] = [];
  /** What validation refused from each email's extraction. Each is a held row in the Inbox, never dropped. */
  readonly rejected: RejectedItem[] = [];
  /** Pairs of refs the PM said are different charges: never held as possible duplicates of each other again. */
  readonly distinct: [string, string][] = [];
  readonly #evidenceOk = new Map<string, boolean>();
  readonly #sourceDispute = new Map<string, boolean>();
  #seq = { notice: 0, credit: 0, contraRef: 0 };

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
      rejected: [...this.rejected],
      distinct: [...this.distinct],
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
    c.rejected.push(...(s2.rejected ?? []));
    c.distinct.push(...(s2.distinct ?? []));
    c.#seq = { contraRef: 0, ...s2.seq };
    return c;
  }

  // ---- Step 1: ingest PM emails ------------------------------------------------------------

  /** True when an email with this Message-ID has already been ingested. Read-only. */
  hasMessage(messageId: string): boolean {
    for (const e of this.emails.values()) if (e.messageId === messageId) return true;
    return false;
  }

  /**
   * Ingests one email and its extracted back-charges. Idempotent by Message-ID: an email whose
   * messageId was already ingested changes nothing (no back-charge, notice or audit entry) and returns [].
   * `rejected` is what validation refused from the same extraction: each is kept (an Inbox row, held) and
   * logged with its reason, so nothing the PM sent vanishes. It never becomes a back-charge.
   * `raisedBy`: the person whose account's email is the sender's address (matched by the host). Each new
   * back-charge logs them as its raiser, so separation of duties (src/roles.ts) keeps them from approving
   * a credit for it.
   */
  ingestBackChargeEmail(
    email: Email,
    extracted: ExtractedBackCharge[],
    extractor: Actor,
    origin: EmailOrigin = "builtin",
    rejected: readonly RejectedExtraction[] = [],
    raisedBy: Human | null = null,
  ): BackCharge[] {
    if (email.messageId && this.hasMessage(email.messageId)) return [];
    this.emails.set(email.id, email);
    // One line per attachment: read as text, read as an image, or skipped and why. Never dropped silently.
    const attachments = email.attachments ? email.attachments.map(describeAttachment) : email.attachmentCount ? [`${email.attachmentCount} attachment(s), not read`] : [];
    // Live mail: when Gmail received it (the host sets receivedAt from Gmail's internalDate).
    const received = origin === "gmail" ? [`received ${email.receivedAt.toISOString()}`] : [];
    this.d.log.append({ actor: SYSTEM, entity: "email", entityId: email.id, action: EMAIL_INGESTED[origin], from: null, to: null, evidence: [email.subject, ...received, ...attachments] });
    for (const r of rejected) {
      this.rejected.push({ ...r, emailId: email.id });
      this.d.log.append({
        actor: extractor,
        entity: "email",
        entityId: email.id,
        action: `${r.ref ?? (r.index < 0 ? "extraction" : `item ${r.index + 1}`)} not taken in, held for a person: ${r.words}`,
        from: null,
        to: null,
        evidence: [`validation: ${r.reason}`],
      });
    }
    const out: BackCharge[] = [];

    for (const x of extracted) {
      // A BC number Contra already has (as an item's ref, or attached to it when the PM merged a duplicate):
      // the same charge again, never a second one.
      const existing = x.ref === null ? undefined : this.byBcNumber(x.ref);
      if (existing) {
        const again = assessExtractedItem(email, x, this.d.erp, extracted.map((e) => e.ref));
        this.#sameChargeAgain(existing, email, x, again, raisedBy ? [raisedBy] : []);
        continue;
      }

      // No BC number in the email (usual for a first back-charge email: accounting assigns one later): Contra
      // gives the item its own reference, and it proceeds like any other.
      const ref = x.ref ?? this.#nextContraRef();
      const a = assessExtractedItem(email, x, this.d.erp, extracted.map((e) => e.ref));
      this.#evidenceOk.set(ref, a.evidenceOk);
      this.#sourceDispute.set(ref, a.disputeInSource);

      const bc: BackCharge = {
        ref,
        bcNumber: x.ref,
        extracted: x,
        state: "extracted",
        subcontractId: null,
        linkExplanation: [],
        noticeId: null,
        subResponse: null,
        holdReasons: [],
        creditId: null,
      };
      this.backCharges.set(ref, bc);
      // An amount read from an image is logged like any other (the log keeps the evidence, I6). Until a
      // person confirms it, the views leave the reading out (src/view.ts shownEvent), so the person types the
      // amount they see without being anchored on it; confirmImageAmount then logs both readings.
      this.d.log.append({
        actor: extractor,
        entity: "backcharge",
        entityId: ref,
        action: `extracted ${formatUsd(x.amountCents)}`,
        from: null,
        to: "extracted",
        evidence: [
          x.amountEvidence.sentence,
          // Where it is, when not in the body: "in attachment estimate.pdf, page 2".
          ...(x.amountEvidence.at ? [`in ${describeAt(email, x.amountEvidence.at)}`] : []),
          ...(x.disputeEvidence ? [x.disputeEvidence.sentence] : []),
          ...a.backstop,
          ...(x.ref === null ? [`no BC number in the email yet; Contra reference ${ref}`] : []),
        ],
      });

      if (raisedBy) {
        this.d.log.append({ actor: { kind: "human", id: raisedBy.id, role: raisedBy.role }, entity: "backcharge", entityId: ref, action: `raised by ${raisedBy.id} (${ROLE_WORDS[raisedBy.role]}): the email came from their address`, from: null, to: null, evidence: [`From: ${email.from}`] });
      }

      if (a.holdReasons.length) {
        this.#hold(bc, a.holdReasons, a.holdEvidence);
      } else {
        const r = a.resolution!;
        this.proposals.set(ref, r);
        if (r.kind === "linked") bc.linkExplanation = r.explanation;
        else transitionBackCharge(this.d.log, bc, "needs_review", SYSTEM, "resolver could not link", r.reasons);
      }
      // Plausibly a charge Contra already has under another reference: held for the PM, never merged on its own.
      this.#holdIfDuplicate(bc);
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
      bc.linkExplanation = [`${pm.kind === "human" ? ROLE_WORDS[pm.role] : pm.kind} ${pm.id} linked "${bc.extracted.vendorNameAsWritten}" to ${sc.id} ${sc.partyLegalName}`];
    }
    bc.subcontractId = sc.id;
    transitionBackCharge(this.d.log, bc, "linked", pm, "link confirmed", bc.linkExplanation);
    // With its subcontract known, it may turn out to be a charge Contra already has.
    this.#holdIfDuplicate(bc);
  }

  // ---- Possible duplicates -----------------------------------------------------------------

  /**
   * The PM confirms a possible duplicate is the same charge as the item it was held against: one charge,
   * both emails as evidence. This item becomes "merged" (final); the other carries the charge on, gets this
   * one's BC number if it had none, and takes over whatever this email says that makes it less certain (a
   * dispute, a different amount) and who raised it. Only for an item held just as a possible duplicate.
   */
  confirmSameCharge(ref: string, pm: Actor): void {
    const b = this.#bc(ref);
    requireRole(pm, "pm", `deciding whether ${ref} is a duplicate`);
    if (b.state !== "held" || !b.duplicate || b.holdReasons.length !== 1 || b.holdReasons[0] !== "possible_duplicate") {
      throw new Error(`${ref}: only an item held just as a possible duplicate can be merged`);
    }
    const o = this.#survivor(b.duplicate.of);
    if (o === b) throw new Error(`${ref}: it can't be merged into itself`);
    const email = this.emails.get(b.extracted.amountEvidence.emailId);
    if (!email) throw new Error(`${ref}: its email is missing`);
    const mine = bcNumberOf(b);
    const attach = mine !== null && bcNumberOf(o) === null;
    b.holdReasons = [];
    b.mergedInto = o.ref;
    transitionBackCharge(this.d.log, b, "merged", pm, `merged into ${o.ref}: the PM confirmed it is the same charge`, [b.duplicate.why]);
    if (attach) o.bcNumber = mine;
    this.d.log.append({
      actor: pm,
      entity: "backcharge",
      entityId: o.ref,
      action: `same charge as ${b.ref}, confirmed by ${pm.id} (PM)${attach ? `; BC number ${mine} attached` : ""}`,
      from: null,
      to: null,
      evidence: [`${email.id}: ${b.extracted.amountEvidence.sentence}`, b.duplicate.why],
    });
    // Whoever raised the merged item raised this charge too (separation of duties, src/roles.ts).
    const raisers = this.d.log.forEntity("backcharge", b.ref).flatMap((e) => (e.actor.kind === "human" && e.action.startsWith("raised by ") ? [e.actor] : []));
    o.alsoIn = [...(o.alsoIn ?? []), ...(b.alsoIn ?? [])];
    this.#sameChargeAgain(o, email, b.extracted, { evidenceOk: this.#evidenceOk.get(b.ref) ?? false, disputeInSource: this.#sourceDispute.get(b.ref) ?? true, backstop: [] }, raisers);
  }

  /**
   * The PM says a possible duplicate is a different charge. The pair is never asked about again. Without
   * another hold reason the item goes back where it was: linked, or waiting for its link (it may then match
   * a third item, and is held again).
   */
  confirmDifferentCharge(ref: string, pm: Actor): void {
    const b = this.#bc(ref);
    requireRole(pm, "pm", `deciding whether ${ref} is a duplicate`);
    if (b.state !== "held" || !b.duplicate || !b.holdReasons.includes("possible_duplicate")) throw new Error(`${ref}: is not held as a possible duplicate`);
    const of = b.duplicate.of;
    this.distinct.push([b.ref, of]);
    b.holdReasons = b.holdReasons.filter((r) => r !== "possible_duplicate");
    const action = `different charge from ${of}: confirmed by ${pm.id} (PM)`;
    if (b.holdReasons.length) {
      this.d.log.append({ actor: pm, entity: "backcharge", entityId: ref, action: `${action}; still held: ${b.holdReasons.join(", ")}`, from: null, to: null, evidence: [b.duplicate.why] });
      return;
    }
    if (b.subcontractId) {
      transitionBackCharge(this.d.log, b, "linked", pm, action, [b.duplicate.why]);
    } else {
      const r = resolve(b.extracted, this.d.erp);
      this.proposals.set(ref, r);
      if (r.kind === "linked") {
        b.linkExplanation = r.explanation;
        transitionBackCharge(this.d.log, b, "extracted", pm, `${action}; waiting for the PM to confirm the link`, [b.duplicate.why]);
      } else transitionBackCharge(this.d.log, b, "needs_review", pm, `${action}; the PM must choose the subcontract`, [b.duplicate.why, ...r.reasons]);
    }
    this.#holdIfDuplicate(b);
  }

  /**
   * The PM confirms an amount the model read from a photo or scanned page, and links the item: held ->
   * linked, a human transition. Only for an item held for amount_only_in_image and nothing else. The PM
   * types the amount they see. It may differ from the model's reading (a misread photo): the PM's amount is
   * used from then on, both are recorded, and both are shown on the credit the controller approves. It is
   * refused (nothing changes, the item stays held) when it isn't more than $0.00, or when the email's text
   * (body or a PDF page) gives this back-charge a different amount. The subcontract must be on the item's
   * job when its job resolves (as for chooseSubcontract).
   */
  confirmImageAmount(ref: string, pm: Actor, typed: Cents, subcontractId: string): void {
    const bc = this.#bc(ref);
    if (bc.state !== "held" || bc.holdReasons.length !== 1 || bc.holdReasons[0] !== "amount_only_in_image") {
      throw new Error(`${ref}: only an item held just for an amount read from an image can be confirmed this way`);
    }
    if (pm.kind !== "human") throw new IllegalTransition(`${ref}: confirming an amount requires a human, got ${pm.kind}`);
    if (typed <= 0) throw new Error(`${ref}: the amount must be more than $0.00; nothing changed and ${ref} stays held`);
    const sc = this.d.erp.subcontract(subcontractId);
    if (!sc) throw new Error(`no subcontract ${subcontractId}`);
    const jobs = matchJobs(bc.extracted.jobRef, this.d.erp.jobs);
    if (jobs.length === 1 && sc.jobId !== jobs[0]!.id) throw new Error(`${sc.id} is not on ${jobs[0]!.id}, the job of ${ref}`);
    const email = this.emails.get(bc.extracted.amountEvidence.emailId);
    if (!email) throw new Error(`${ref}: its email is missing`);
    // At ingest the email's text was compared with the model's reading. The amount typed now is what becomes
    // money, so the text must not give this back-charge a different amount from it either.
    const conflicts = conflictingStatements(email, { ...bc.extracted, amountCents: typed });
    if (conflicts.length) throw new Error(`${ref}: you typed ${formatUsd(typed)}, but the ${conflicts[0]}; nothing changed and ${ref} stays held`);

    const where = describeAt(email, bc.extracted.amountEvidence.at);
    const byRole = ROLE_WORDS[pm.role];
    const confirmation: AmountConfirmation = { by: `${pm.id} (${byRole})`, byRole, at: this.d.clock.now(), from: where, enteredCents: typed, modelCents: bc.extracted.amountCents };
    this.d.log.append({
      actor: pm,
      entity: "backcharge",
      entityId: ref,
      action: `amount confirmed by ${confirmation.by} from ${where}: ${formatUsd(typed)}`,
      from: null,
      to: null,
      evidence: [confirmationNote(confirmation), `the model's reading of the image (not verifiable word for word): ${bc.extracted.amountEvidence.sentence}`],
    });
    // The person's confirmation stands in for the word-for-word check an image can't have. It is recorded
    // on the item, so eligibility's trace says "amount confirmed by <who> from <where>", never "verbatim".
    bc.amountConfirmation = confirmation;
    this.#evidenceOk.set(ref, true);
    bc.holdReasons = [];
    const r = resolve(bc.extracted, this.d.erp);
    this.proposals.set(ref, r);
    if (r.kind === "linked" && r.subcontractId === sc.id) bc.linkExplanation = r.explanation;
    this.confirmLink(ref, pm, sc.id);
  }

  // ---- Step 2: notice ----------------------------------------------------------------------

  draftNotice(subcontractId: string): Notice | null {
    const sc = this.d.erp.subcontract(subcontractId);
    if (!sc) throw new Error(`no subcontract ${subcontractId}`);
    const candidates = [...this.backCharges.values()].filter((b) => b.state === "linked" && b.subcontractId === sc.id && !b.noticeId);

    const include: BackCharge[] = [];
    for (const b of candidates) {
      // Never two items of an open duplicate question on a notice: the later one checked is held.
      if (this.#holdIfDuplicate(b)) continue;
      const r = this.#evaluate(b, "pre_notice");
      if (r.status === "held") this.#hold(b, r.holdReasons, r.trace);
      else include.push(b);
    }
    if (include.length === 0) return null;

    const job = this.d.erp.jobs.find((j) => j.id === sc.jobId)!;
    const total = sum(include.map(backChargeAmount));
    const clause = sc.clause!;
    const body = [
      `NOTICE OF BACK-CHARGES - Subcontract ${sc.id}, ${clause.section}`,
      `To: ${sc.partyLegalName}`,
      `Job: ${job.id} ${job.name}`,
      ``,
      ...include.map((b) => {
        const est = estimateOf(b);
        return `- ${refLabel(b)}: ${b.extracted.description} - ${formatUsd(backChargeAmount(b))}${est ? ` (estimate: the email says "${est}")` : ""}`;
      }),
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

  /** Only a PM approves a notice (also in the state table). */
  approveNotice(id: string, human: Actor): void {
    const n = this.#notice(id);
    requireRole(human, "pm", `approving notice ${id}`);
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
      // An item may be named by its reference or by the BC number a later email supplied for it.
      const names = [...new Set([b.ref, bcNumberOf(b)].filter((r): r is string => r !== null))];
      const mentioned = names.some((n) => new RegExp(`\\b(?:BC-?)?${n.replace(/^\D+/, "")}\\b`).test(own));
      const disputed =
        names.some((n) => x.disputedRefs.includes(n)) ||
        (mentioned && !x.acceptedRefs.includes(b.ref)) ||
        names.some((n) => disputeSentencesFor(email.body, n, { excludeQuoted: true }).length > 0);
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
    this.d.log.append({ actor: SYSTEM, entity: "credit", entityId: c.id, action: `proposed ${formatUsd(amountCents)}`, from: null, to: "proposed", evidence: [...c.backChargeRefs, ...amountNotes(items)] });
    return c;
  }

  /** Human approval is what creates the credit in the payments platform; nothing before it does. */
  approveCredit(id: string, human: Actor): void {
    const c = this.#credit(id);
    // Re-check at approval time: items may have changed since the proposal.
    const items = c.backChargeRefs.map((r) => this.#bc(r));
    creditAmountFor(items);
    // Only a controller (also in the state table), and never one who raised or linked one of its back-charges.
    requireRole(human, "controller", `approving credit ${id}`);
    requireSeparateFrom(this.d.log, c.backChargeRefs, human, `approve credit ${id}`);
    // The approval record carries what the controller saw: amounts a person entered from an image, with the model's reading.
    transitionCredit(this.d.log, c, "approved", human, `approved ${formatUsd(c.amountCents)}`, [...c.backChargeRefs, ...amountNotes(items)]);
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

  // ---- Credit memo delivery ----------------------------------------------------------------

  /** A memo can be sent for a credit with a recorded approval (approved, synced or applied). */
  static memoSendable(c: Readonly<Credit>): boolean {
    return (c.state === "approved" || c.state === "synced" || c.state === "applied") && (!c.memoDelivery || c.memoDelivery.state === "failed");
  }

  /** Marks the memo queued for `to` (first send, or a retry after failed) and returns the memo to send. */
  queueMemo(id: string, to: string, human: Actor): { filename: string; text: string } {
    const c = this.#credit(id);
    if (!Contra.memoSendable(c)) throw new IllegalTransition(`credit ${id}: memo can't be sent now (${c.state}, memo ${c.memoDelivery?.state ?? "not sent"})`);
    const memo = this.creditMemo(id);
    const attempts = (c.memoDelivery?.attempts ?? 0) + 1;
    transitionMemo(this.d.log, c, "queued", human, `memo queued for ${to}${attempts > 1 ? ` (attempt ${attempts})` : ""}`, [memo.filename], { to, attempts, error: null });
    return memo;
  }

  memoSent(id: string, messageId: string): void {
    const c = this.#credit(id);
    transitionMemo(this.d.log, c, "sent", SYSTEM, `memo sent to ${c.memoDelivery?.to ?? "?"}`, [messageId], { messageId });
  }

  memoFailed(id: string, why: string): void {
    transitionMemo(this.d.log, this.#credit(id), "failed", SYSTEM, "memo failed", [why], { error: why });
  }

  // ---- Step 5: bill and payment ------------------------------------------------------------

  /** AP turns on "apply credits" for a bill (in Ramp, a person does this on the bill). Audited with who did it. */
  turnOnCredits(billId: string, human: Actor): void {
    requireRole(human, "ap", `turning on credits for bill ${billId}`);
    this.d.ramp.setApplyCredits(billId, true);
    const plan = this.d.ramp.previewApplication(billId);
    this.d.log.append({ actor: human, entity: "bill", entityId: billId, action: "credits turned on", from: null, to: null, evidence: plan.map((p) => `${p.creditId} would apply ${formatUsd(p.cents)}`) });
  }

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
      actions.push(`propose a credit for ${unproposed.map((b) => b.ref).join(", ")} (${formatUsd(sum(unproposed.map(backChargeAmount)))}) before paying`);
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

  /**
   * The item that carries this accounting BC number (as its ref, or supplied later), if any. An item merged
   * into another is never it: the one it was merged into is.
   */
  byBcNumber(bcNumber: string): BackCharge | undefined {
    for (const b of this.backCharges.values()) if (b.state !== "merged" && bcNumberOf(b) === bcNumber) return b;
    for (const b of this.backCharges.values()) if (bcNumberOf(b) === bcNumber) return this.#survivor(b.ref);
    return undefined;
  }

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

  /** The item that carries `ref`'s charge: itself, or the item it was merged into (followed to the end). */
  #survivor(ref: string): BackCharge {
    let b = this.#bc(ref);
    for (let i = 0; b.state === "merged" && b.mergedInto && i < 100; i++) b = this.#bc(b.mergedInto);
    return b;
  }

  /**
   * Another email states a charge Contra already has: it cites the item's BC number, or the PM confirmed it
   * is the same charge. Never a second charge. Its sentence is added to the item's evidence, the people who
   * raised it are recorded on the item, and what it says that makes the item less certain is carried over:
   * - a different amount holds the item for conflicting amounts (an item already held keeps its reasons);
   * - a dispute (the model's or the code backstop's) holds it for a dispute noted in the source.
   * On an item already credited, neither can be undone here: it is flagged for a person (lateDisputes).
   */
  #sameChargeAgain(o: BackCharge, email: Email, x: ExtractedBackCharge, a: { evidenceOk: boolean; disputeInSource: boolean; backstop: string[] }, raisers: Human[]): void {
    const settled = o.state === "credited" || o.state === "applied";
    if (a.evidenceOk) o.alsoIn = [...(o.alsoIn ?? []), x.amountEvidence];
    for (const h of raisers) {
      this.d.log.append({ actor: { kind: "human", id: h.id, role: h.role }, entity: "backcharge", entityId: o.ref, action: `raised by ${h.id} (${ROLE_WORDS[h.role]}): the email came from their address`, from: null, to: null, evidence: [`From: ${email.from}`] });
    }
    const flag = (why: string, evidence: string) => {
      this.lateDisputes.push({ ref: o.ref, emailId: email.id });
      this.d.log.append({ actor: SYSTEM, entity: "backcharge", entityId: o.ref, action: `${why} after the credit; needs human review`, from: null, to: null, evidence: [evidence] });
    };
    if (backChargeAmount(o) !== x.amountCents) {
      // Logged as read, also when read from an image; the views withhold an image reading (src/view.ts shownEvent).
      const ev = `${email.id}: ${x.amountEvidence.sentence}`;
      if (settled) flag("another email gives a different amount", ev);
      else this.#addHold(o, "conflicting_amounts", [ev]);
    }
    if (a.disputeInSource) {
      this.#sourceDispute.set(o.ref, true);
      const ev = `${email.id}: ${x.disputeEvidence?.sentence || a.backstop[0] || "the extractor noted a dispute"}`;
      if (settled) flag("another email notes a dispute", ev);
      else this.#addHold(o, "dispute_noted_in_source", [ev]);
    }
  }

  /** Holds `b` for `reason`; an item already held gets the reason added, logged as "also held: <reason>". */
  #addHold(b: BackCharge, reason: HoldReason, evidence: string[]): void {
    if (b.state !== "held") return this.#hold(b, [reason], evidence);
    if (b.holdReasons.includes(reason)) return;
    b.holdReasons = [...b.holdReasons, reason];
    this.d.log.append({ actor: SYSTEM, entity: "backcharge", entityId: b.ref, action: `also held: ${reason}`, from: null, to: null, evidence });
  }

  /** True while the item's amount is the model's unconfirmed reading of an image (never compared or shown). */
  #imageUnconfirmed(b: Readonly<BackCharge>): boolean {
    const email = this.emails.get(b.extracted.amountEvidence.emailId);
    return !b.amountConfirmation && !!email && readFromImage(email, b.extracted.amountEvidence.at);
  }

  /** The item's subcontract: linked, else the resolver's proposed link, else none. */
  #subcontractOf(b: Readonly<BackCharge>): string | null {
    if (b.subcontractId) return b.subcontractId;
    const p = this.proposals.get(b.ref) ?? resolve(b.extracted, this.d.erp);
    return p.kind === "linked" ? p.subcontractId : null;
  }

  #duplicateView(b: Readonly<BackCharge>): DuplicateView {
    const sc = this.#subcontractOf(b);
    return { ref: b.ref, bcNumber: bcNumberOf(b), subcontractId: sc, jobId: sc ? (this.d.erp.subcontract(sc)?.jobId ?? null) : null, amountCents: backChargeAmount(b), description: b.extracted.description };
  }

  /**
   * Another item `b` may be the same charge as (src/duplicates.ts), or null. Skips merged items, pairs the PM
   * already said are different, a question already open the other way round, and amounts that are an
   * unconfirmed reading of an image (compared once a person confirms them).
   */
  #possibleDuplicate(b: Readonly<BackCharge>): { of: BackCharge; why: string } | null {
    if (b.state === "merged" || this.#imageUnconfirmed(b)) return null;
    const mine = this.#duplicateView(b);
    if (!mine.subcontractId) return null;
    for (const o of this.backCharges.values()) {
      if (o === b || o.state === "merged" || this.#imageUnconfirmed(o)) continue;
      if (this.distinct.some(([p, q]) => (p === b.ref && q === o.ref) || (p === o.ref && q === b.ref))) continue;
      if (o.duplicate?.of === b.ref && o.holdReasons.includes("possible_duplicate")) continue;
      const why = duplicateReason(mine, this.#duplicateView(o));
      if (why) return { of: o, why };
    }
    return null;
  }

  /** Holds `b` as a possible duplicate when it plausibly is one. True when it is (or already was) held as one. */
  #holdIfDuplicate(b: BackCharge): boolean {
    if (b.holdReasons.includes("possible_duplicate")) return true;
    const d = this.#possibleDuplicate(b);
    if (!d) return false;
    b.duplicate = { of: d.of.ref, why: d.why };
    this.#addHold(b, "possible_duplicate", [`possible duplicate of ${refLabel(d.of)}: ${d.why}`]);
    return true;
  }

  /** The next unused Contra reference. Never reuses one, also after restoring a snapshot without the counter. */
  #nextContraRef(): string {
    let ref: string;
    do ref = contraRef(++this.#seq.contraRef!);
    while (this.backCharges.has(ref));
    return ref;
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
