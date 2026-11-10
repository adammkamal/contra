import { ManualClock, OffsetClock, SystemClock, type Clock, type WorkspaceClock } from "./clock.ts";
import type { MemoSender } from "./memo.ts";
import { MockERP } from "./mocks/erp.ts";
import { MockRamp, type RampBill, type RampCredit } from "./mocks/ramp.ts";
import { reconcile, scanEmails, type ReconResult } from "./reconcile.ts";
import { demoSeed, historySeed } from "./seed.ts";
import { SqliteStore } from "./store/sqlite.ts";
import type { Alias } from "./types.ts";
import { Contra, type ContraState } from "./workflow.ts";

/**
 * "demo": the scripted demo (its own emails, reply and bill; SPEC section 3). "live": the same ERP,
 * subcontract and Ramp seed, but none of the scripted emails, reply or bill; mail arrives only from the
 * live inbox. Each workspace is its own database; a database opens only as the workspace it was made for.
 * Clocks: demo keeps its simulated clock (stored as clockMs). Live runs on the real clock, injected by the
 * host, plus an offset that starts at 0 and only "advance a week" changes (stored as offsetMs).
 */
export type Workspace = "demo" | "live";

interface AppState {
  /** Absent in snapshots written before workspaces existed: those are demo. */
  workspace?: Workspace;
  seedBaseMs: number;
  /** The workspace clock's reading when saved. Demo resumes from it; for live it is informational. */
  clockMs: number;
  /** Live only: ms added to the real clock (advanceDays). */
  offsetMs?: number;
  contra: ContraState;
  erp: { aliases: Alias[]; synced: string[] };
  ramp: { bills: RampBill[]; credits: RampCredit[] };
}

export interface Ctx {
  clock: WorkspaceClock;
  contra: Contra;
  erp: MockERP;
  ramp: MockRamp;
  seed: ReturnType<typeof demoSeed>;
  /** Delivers credit memos; null when none is configured (then no memo can be sent). Injected like the clock. */
  memoSender: MemoSender | null;
  workspace: Workspace;
}

/**
 * The one entry point for the UI and scripts. Every command goes through run(): the command,
 * its audit events and the new snapshot commit in one transaction. If the command throws,
 * everything rolls back and in-memory state is reloaded from the last good snapshot.
 */
export class App {
  readonly store: SqliteStore;
  #ctx!: Ctx;
  #seedBaseMs!: number;
  readonly #memoSender: MemoSender | null;
  readonly workspace: Workspace;
  readonly #realClock: Clock | null;

  /**
   * `realClock` is required for the live workspace (its time is the real time plus its offset) and unused by
   * the demo. For live, `start` only dates the seed; it never sets the clock.
   */
  constructor(dbPath: string, opts: { start?: Date; memoSender?: MemoSender | null; workspace?: Workspace; realClock?: Clock } = {}) {
    this.#memoSender = opts.memoSender ?? null;
    this.workspace = opts.workspace ?? "demo";
    this.#realClock = this.workspace === "live" ? (opts.realClock ?? null) : null;
    if (this.workspace === "live" && !this.#realClock) throw new Error("the live workspace needs the real clock, injected by the host (realClock)");
    this.store = new SqliteStore(dbPath);
    const existing = this.store.loadSnapshot<AppState>();
    if (existing && (existing.workspace ?? "demo") !== this.workspace) {
      this.store.close();
      throw new Error(`${dbPath} holds the ${existing.workspace ?? "demo"} workspace, not ${this.workspace}`);
    }
    if (!existing) {
      const start = opts.start ?? this.#realClock?.now() ?? new SystemClock().now();
      this.#fresh(start);
      this.store.transaction(() => this.#save());
    } else {
      this.#load();
    }
  }

  /** Read-only access for rendering. Never mutate through this. */
  get ctx(): Readonly<Ctx> {
    return this.#ctx;
  }

  run<T>(command: (ctx: Ctx) => T): T {
    try {
      return this.store.transaction(() => {
        const out = command(this.#ctx);
        this.#save();
        return out;
      });
    } catch (e) {
      this.#load();
      throw e;
    }
  }

  /** Read-only shadow scan of email history against Ramp credits and bills (demo opener). */
  missedBackCharges(): ReconResult {
    const { erp, ramp } = this.#ctx;
    const h = historySeed(new Date(this.#seedBaseMs));
    return reconcile(scanEmails(h.emails, h.extractions, erp), ramp);
  }

  advanceDays(days: number): void {
    this.run((c) => c.clock.advanceDays(days));
  }

  close(): void {
    this.store.close();
  }

  #fresh(start: Date): void {
    this.#seedBaseMs = start.getTime();
    this.#build(null, start.getTime());
  }

  #load(): void {
    const s = this.store.loadSnapshot<AppState>();
    if (!s) throw new Error("no snapshot");
    this.#seedBaseMs = s.seedBaseMs;
    this.#build(s, s.clockMs);
  }

  #build(s: AppState | null, clockMs: number): void {
    const clock: WorkspaceClock = this.#realClock ? new OffsetClock(this.#realClock, s?.offsetMs ?? 0) : new ManualClock(new Date(clockMs));
    const seed = demoSeed(new Date(this.#seedBaseMs));
    const log = this.store.auditLog(clock);
    const erp = new MockERP({ jobs: seed.jobs, subcontracts: seed.subcontracts, aliases: s ? s.erp.aliases : [...seed.aliases] });
    for (const id of s?.erp.synced ?? []) erp.syncCredit(id);
    const ramp = new MockRamp(seed.vendors);
    if (s) {
      ramp.bills.push(...s.ramp.bills);
      ramp.credits.push(...s.ramp.credits);
    } else {
      const h = historySeed(new Date(this.#seedBaseMs));
      ramp.bills.push(...h.rampBills);
      ramp.credits.push(...h.rampCredits);
    }
    const deps = { clock, log, erp, ramp };
    const contra = s ? Contra.restore(deps, s.contra) : new Contra(deps);
    this.#ctx = { clock, contra, erp, ramp, seed, memoSender: this.#memoSender, workspace: this.workspace };
  }

  #save(): void {
    const { clock, contra, erp, ramp } = this.#ctx;
    const state: AppState = {
      workspace: this.workspace,
      seedBaseMs: this.#seedBaseMs,
      clockMs: clock.now().getTime(),
      ...(clock instanceof OffsetClock ? { offsetMs: clock.offsetMs } : {}),
      contra: contra.snapshot(),
      erp: { aliases: erp.aliases, synced: erp.syncedIds() },
      ramp: { bills: ramp.bills, credits: ramp.credits },
    };
    this.store.saveSnapshot(state);
  }
}
