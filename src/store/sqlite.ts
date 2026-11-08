import { DatabaseSync } from "node:sqlite";
import type { AuditEvent, AuditLog, EntityKind } from "../audit.ts";
import type { Clock } from "../clock.ts";

/** JSON that keeps Dates as Dates. */
export function encode(v: unknown): string {
  return JSON.stringify(v, function (this: Record<string, unknown>, k: string, val: unknown) {
    const raw = this[k];
    return raw instanceof Date ? { $date: raw.toISOString() } : val;
  });
}

export function decode<T>(s: string): T {
  return JSON.parse(s, (_k, v) => (v && typeof v === "object" && typeof v.$date === "string" ? new Date(v.$date) : v)) as T;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  evidence TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_entity ON events(entity, entity_id);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  last_event_seq INTEGER NOT NULL,
  state TEXT NOT NULL
);
`;

interface Row {
  seq: number;
  at: string;
  actor: string;
  entity: string;
  entity_id: string;
  action: string;
  from_state: string | null;
  to_state: string | null;
  evidence: string;
}

function toEvent(r: Row): AuditEvent {
  return Object.freeze({
    seq: r.seq,
    at: new Date(r.at),
    actor: JSON.parse(r.actor),
    entity: r.entity as EntityKind,
    entityId: r.entity_id,
    action: r.action,
    from: r.from_state,
    to: r.to_state,
    evidence: Object.freeze(JSON.parse(r.evidence) as string[]),
  });
}

export class SqliteStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  auditLog(clock: Clock): AuditLog {
    const db = this.db;
    const insert = db.prepare(
      "INSERT INTO events (at, actor, entity, entity_id, action, from_state, to_state, evidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
    );
    const all = db.prepare("SELECT * FROM events ORDER BY seq");
    const byEntity = db.prepare("SELECT * FROM events WHERE entity = ? AND entity_id = ? ORDER BY seq");
    return {
      append(e) {
        const row = insert.get(
          clock.now().toISOString(),
          JSON.stringify(e.actor),
          e.entity,
          e.entityId,
          e.action,
          e.from,
          e.to,
          JSON.stringify([...e.evidence]),
        ) as unknown as Row;
        return toEvent(row);
      },
      all() {
        return Object.freeze((all.all() as unknown as Row[]).map(toEvent));
      },
      forEntity(entity, id) {
        return (byEntity.all(entity, id) as unknown as Row[]).map(toEvent);
      },
    };
  }

  lastEventSeq(): number {
    const r = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events").get() as { s: number };
    return r.s;
  }

  saveSnapshot(state: unknown): void {
    this.db.prepare("INSERT INTO snapshots (last_event_seq, state) VALUES (?, ?)").run(this.lastEventSeq(), encode(state));
  }

  loadSnapshot<T>(): T | null {
    const r = this.db.prepare("SELECT state FROM snapshots ORDER BY id DESC LIMIT 1").get() as { state: string } | undefined;
    return r ? decode<T>(r.state) : null;
  }

  /** Runs fn inside one transaction: events and the snapshot commit together or not at all. */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }
}
