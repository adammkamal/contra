import type { Actor } from "./types.ts";
import type { Clock } from "./clock.ts";

export type EntityKind = "backcharge" | "notice" | "credit" | "bill" | "alias" | "email";

export interface AuditEvent {
  readonly seq: number;
  readonly at: Date;
  readonly actor: Actor;
  readonly entity: EntityKind;
  readonly entityId: string;
  readonly action: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly evidence: readonly string[];
}

export interface AuditLog {
  append(e: Omit<AuditEvent, "seq" | "at">): AuditEvent;
  all(): readonly AuditEvent[];
  forEntity(entity: EntityKind, id: string): readonly AuditEvent[];
}

/** Append-only. Events are frozen; there is no update or delete. A SQLite adapter comes Sunday. */
export class InMemoryAuditLog implements AuditLog {
  readonly #events: AuditEvent[] = [];
  constructor(private readonly clock: Clock) {}

  append(e: Omit<AuditEvent, "seq" | "at">): AuditEvent {
    const event: AuditEvent = Object.freeze({
      ...e,
      evidence: Object.freeze([...e.evidence]),
      seq: this.#events.length + 1,
      at: this.clock.now(),
    });
    this.#events.push(event);
    return event;
  }

  all(): readonly AuditEvent[] {
    return Object.freeze([...this.#events]);
  }

  forEntity(entity: EntityKind, id: string): readonly AuditEvent[] {
    return this.#events.filter((e) => e.entity === entity && e.entityId === id);
  }
}
