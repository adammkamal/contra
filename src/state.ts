import type { AuditLog } from "./audit.ts";
import type { Actor, BackCharge, BackChargeState, Credit, CreditState, MemoDelivery, MemoState, Notice, NoticeState } from "./types.ts";

type Rule<S extends string> = { to: S; needsHuman: boolean };

const BACKCHARGE: Record<BackChargeState, Rule<BackChargeState>[]> = {
  extracted: [
    { to: "linked", needsHuman: true },
    { to: "needs_review", needsHuman: false },
    { to: "held", needsHuman: false },
  ],
  needs_review: [
    { to: "linked", needsHuman: true },
    { to: "held", needsHuman: false },
  ],
  linked: [
    { to: "noticed", needsHuman: false },
    { to: "eligible", needsHuman: false },
    { to: "held", needsHuman: false },
  ],
  noticed: [
    { to: "eligible", needsHuman: false },
    { to: "held", needsHuman: false },
  ],
  // Leaving "held" is a human decision (e.g. dispute resolved); it goes back to linked, not to eligible.
  held: [{ to: "linked", needsHuman: true }],
  eligible: [
    { to: "credited", needsHuman: false },
    { to: "held", needsHuman: false },
  ],
  credited: [{ to: "applied", needsHuman: false }],
  applied: [],
};

const NOTICE: Record<NoticeState, Rule<NoticeState>[]> = {
  drafted: [{ to: "approved", needsHuman: true }],
  approved: [{ to: "sent", needsHuman: false }],
  sent: [],
};

const CREDIT: Record<CreditState, Rule<CreditState>[]> = {
  proposed: [
    { to: "approved", needsHuman: true },
    { to: "rejected", needsHuman: true },
  ],
  approved: [{ to: "synced", needsHuman: false }],
  synced: [{ to: "applied", needsHuman: false }],
  rejected: [],
  applied: [],
};

/**
 * A credit memo's delivery. "none" is a credit with no delivery yet. Retry is only from failed: a memo
 * left queued (the process stopped between handing it to the sender and recording the result) may
 * already have gone out, so it is never re-sent automatically.
 */
type MemoFrom = MemoState | "none";
const MEMO: Record<MemoFrom, Rule<MemoState>[]> = {
  none: [{ to: "queued", needsHuman: true }],
  queued: [
    { to: "sent", needsHuman: false },
    { to: "failed", needsHuman: false },
  ],
  failed: [{ to: "queued", needsHuman: true }],
  sent: [],
};

export class IllegalTransition extends Error {}

function check<S extends string>(table: Record<S, Rule<S>[]>, kind: string, id: string, from: S, to: S, actor: Actor) {
  const rule = table[from].find((r) => r.to === to);
  if (!rule) throw new IllegalTransition(`${kind} ${id}: ${from} -> ${to} is not allowed`);
  if (rule.needsHuman && actor.kind !== "human") {
    throw new IllegalTransition(`${kind} ${id}: ${from} -> ${to} requires a human, got ${actor.kind}`);
  }
}

export function transitionBackCharge(
  log: AuditLog,
  bc: BackCharge,
  to: BackChargeState,
  actor: Actor,
  action: string,
  evidence: string[],
): void {
  check(BACKCHARGE, "BackCharge", bc.ref, bc.state, to, actor);
  log.append({ actor, entity: "backcharge", entityId: bc.ref, action, from: bc.state, to, evidence });
  bc.state = to;
}

export function transitionNotice(log: AuditLog, n: Notice, to: NoticeState, actor: Actor, action: string, evidence: string[]): void {
  check(NOTICE, "Notice", n.id, n.state, to, actor);
  log.append({ actor, entity: "notice", entityId: n.id, action, from: n.state, to, evidence });
  n.state = to;
}

export function transitionCredit(log: AuditLog, c: Credit, to: CreditState, actor: Actor, action: string, evidence: string[]): void {
  check(CREDIT, "Credit", c.id, c.state, to, actor);
  log.append({ actor, entity: "credit", entityId: c.id, action, from: c.state, to, evidence });
  c.state = to;
}

/** Moves a credit's memo delivery to `to`, audited under entity "memo" with the credit's id. `update` sets the other fields. */
export function transitionMemo(
  log: AuditLog,
  c: Credit,
  to: MemoState,
  actor: Actor,
  action: string,
  evidence: string[],
  update: Partial<Omit<MemoDelivery, "state">> & { to?: string },
): void {
  const from: MemoFrom = c.memoDelivery?.state ?? "none";
  check(MEMO, "Memo", c.id, from, to, actor);
  log.append({ actor, entity: "memo", entityId: c.id, action, from: from === "none" ? null : from, to, evidence });
  const prev = c.memoDelivery ?? { state: to, to: "", attempts: 0, messageId: null, error: null };
  c.memoDelivery = { ...prev, ...update, state: to };
}
