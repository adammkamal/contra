import type { AuditLog } from "./audit.ts";
import { IllegalTransition, NotPermitted } from "./state.ts";
import { ROLE_WORDS, type Actor, type Human, type Role } from "./types.ts";

/**
 * Who may do what. Pure functions of the actor and the audit log; refusals throw NotPermitted (an
 * IllegalTransition: the API answers 409) with the reason in words, and change nothing.
 *
 * - Approving a notice needs the PM role: the PM owns the sub relationship and the notice (src/state.ts,
 *   the notice table, and Contra.approveNotice).
 * - Approving or rejecting a credit needs the Controller role (src/state.ts, the credit table).
 * - Turning credits on for a bill needs the AP role (Contra.turnOnCredits).
 * - Separation of duties: a person who raised or linked a back-charge can't approve a credit for it
 *   (Contra.approveCredit). "Raised or linked" = a human actor on that back-charge's audit trail.
 *
 * Identity is the actor's `id`, never `presentedBy`: in the scripted demo one presenter clicks every
 * step, while each step keeps its scripted actor.
 */

export { NotPermitted };

const article = (r: Role) => (r === "ap" ? "an" : "a");

export function requireRole(actor: Actor, role: Role, what: string): asserts actor is Human {
  if (actor.kind !== "human") throw new IllegalTransition(`${what} requires a person, got ${actor.kind}`);
  if (actor.role !== role) throw new NotPermitted(`${what} needs the ${ROLE_WORDS[role]} role; ${actor.id} is ${article(actor.role)} ${ROLE_WORDS[actor.role]}`);
}

/** For each back-charge, how `actorId` took part in it ("linked" or "raised"), or nothing. */
export function involvement(log: AuditLog, refs: readonly string[], actorId: string): { ref: string; how: "raised" | "linked" }[] {
  return refs.flatMap((ref) => {
    const mine = log.forEntity("backcharge", ref).filter((e) => e.actor.kind === "human" && e.actor.id === actorId);
    if (!mine.length) return [];
    return [{ ref, how: mine.some((e) => e.to === "linked") ? ("linked" as const) : ("raised" as const) }];
  });
}

/** Throws unless `actor` neither raised nor linked any of `refs`. */
export function requireSeparateFrom(log: AuditLog, refs: readonly string[], actor: Human, what: string): void {
  const mine = involvement(log, refs, actor.id);
  if (!mine.length) return;
  const list = mine.map((m) => `${m.how} ${m.ref}`).join(", ");
  throw new NotPermitted(`separation of duties: ${actor.id} ${list}, so ${actor.id} can't ${what}; another ${ROLE_WORDS.controller.toLowerCase()} must`);
}
