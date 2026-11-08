import type { Alias, Job, Subcontract } from "../types.ts";

/** Stand-in for the GC's ERP: subcontracts, clauses, aliases and credit sync. */
export class MockERP {
  readonly jobs: Job[];
  readonly subcontracts: Subcontract[];
  readonly aliases: Alias[];
  readonly #synced = new Set<string>();

  constructor(seed: { jobs: Job[]; subcontracts: Subcontract[]; aliases: Alias[] }) {
    this.jobs = seed.jobs;
    this.subcontracts = seed.subcontracts;
    this.aliases = seed.aliases;
  }

  subcontract(id: string): Subcontract | null {
    return this.subcontracts.find((s) => s.id === id) ?? null;
  }

  addAlias(a: Alias): void {
    if (!this.aliases.some((x) => x.alias === a.alias && x.partyLegalName === a.partyLegalName)) this.aliases.push(a);
  }

  syncCredit(creditId: string): void {
    this.#synced.add(creditId);
  }

  isSynced(creditId: string): boolean {
    return this.#synced.has(creditId);
  }

  syncedIds(): string[] {
    return [...this.#synced];
  }
}
