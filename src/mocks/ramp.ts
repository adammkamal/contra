import { cents, min, sub, ZERO, type Cents } from "../money.ts";

/**
 * Simulated Ramp. Implements ONLY documented behavior (SPEC section 4):
 *  - credit application is a per-bill toggle
 *  - credits apply oldest-first by accounting date (ties: larger remaining balance); no choosing credits
 *  - imported bills can't receive credits
 *  - only ERP-synced credits apply (Contra policy; Ramp's older flow requires sync)
 *  - bills created via API arrive approved
 * createCredit exists only because the demo needs it: real Ramp has no documented create-credit endpoint.
 */

export interface RampVendor {
  id: string;
  name: string;
  remitTo: string;
}

export interface RampBill {
  id: string;
  vendorId: string;
  jobId: string;
  amountCents: Cents;
  accountingDate: Date;
  origin: "native" | "imported";
  applyCredits: boolean;
  status: "approved" | "paid";
  paidCents: Cents | null;
  applied: { creditId: string; cents: Cents }[];
  memo?: string;
}

export interface RampCredit {
  id: string;
  vendorId: string;
  jobId: string;
  amountCents: Cents;
  remainingCents: Cents;
  accountingDate: Date;
  erpSynced: boolean;
  createdVia: "mock_only_no_real_api" | "history";
  memo?: string;
}

export interface PlannedApplication {
  creditId: string;
  cents: Cents;
  creditJobId: string;
  jobMismatch: boolean;
}

export interface PaymentsPlatform {
  createBillViaApi(b: Omit<RampBill, "status" | "paidCents" | "applied" | "applyCredits">): RampBill;
  setApplyCredits(billId: string, on: boolean): void;
  createCredit(c: Omit<RampCredit, "remainingCents" | "erpSynced" | "createdVia">): RampCredit;
  markCreditSynced(creditId: string): void;
  previewApplication(billId: string): PlannedApplication[];
  payBill(billId: string): { paidCents: Cents; applied: PlannedApplication[] };
  creditRemaining(creditId: string): Cents;
  /** Read-only, as Ramp's API allows: GET bill, GET vendor credits. */
  getBill(billId: string): RampBill;
  listCredits(vendorId: string): RampCredit[];
}

/**
 * Ramp's documented order (older "Apply vendor credits" flow) as a pure function, so Contra can
 * predict where credits will land from read-only data: same vendor, ERP-synced, remaining > 0,
 * ascending accounting date, ties -> larger remaining balance. Ignores the bill's toggle.
 */
export function planApplication(
  bill: Pick<RampBill, "vendorId" | "jobId" | "amountCents">,
  credits: readonly RampCredit[],
): PlannedApplication[] {
  const usable = credits
    .filter((c) => c.vendorId === bill.vendorId && c.erpSynced && c.remainingCents > 0)
    .sort(
      (a, b) =>
        a.accountingDate.getTime() - b.accountingDate.getTime() || b.remainingCents - a.remainingCents || a.id.localeCompare(b.id),
    );
  const plan: PlannedApplication[] = [];
  let left = bill.amountCents;
  for (const c of usable) {
    if (left <= 0) break;
    const take = min(c.remainingCents, left);
    plan.push({ creditId: c.id, cents: take, creditJobId: c.jobId, jobMismatch: c.jobId !== bill.jobId });
    left = sub(left, take);
  }
  return plan;
}

export class MockRamp implements PaymentsPlatform {
  readonly vendors: RampVendor[];
  readonly bills: RampBill[] = [];
  readonly credits: RampCredit[] = [];

  constructor(vendors: RampVendor[]) {
    this.vendors = vendors;
  }

  createBillViaApi(b: Omit<RampBill, "status" | "paidCents" | "applied" | "applyCredits">): RampBill {
    const bill: RampBill = { ...b, status: "approved", applyCredits: false, paidCents: null, applied: [] };
    this.bills.push(bill);
    return bill;
  }

  setApplyCredits(billId: string, on: boolean): void {
    this.#bill(billId).applyCredits = on;
  }

  createCredit(c: Omit<RampCredit, "remainingCents" | "erpSynced" | "createdVia">): RampCredit {
    if (c.amountCents <= 0) throw new Error("credit amount must be positive");
    const credit: RampCredit = { ...c, remainingCents: c.amountCents, erpSynced: false, createdVia: "mock_only_no_real_api" };
    this.credits.push(credit);
    return credit;
  }

  markCreditSynced(creditId: string): void {
    const c = this.credits.find((x) => x.id === creditId);
    if (!c) throw new Error(`no credit ${creditId}`);
    c.erpSynced = true;
  }

  previewApplication(billId: string): PlannedApplication[] {
    const bill = this.#bill(billId);
    // Origin first (invariant 7), then the toggle.
    if (bill.origin === "imported") return [];
    if (!bill.applyCredits) return [];
    if (bill.status !== "approved") return [];
    return planApplication(bill, this.credits);
  }

  payBill(billId: string): { paidCents: Cents; applied: PlannedApplication[] } {
    const bill = this.#bill(billId);
    if (bill.status !== "approved") throw new Error(`bill ${billId} is ${bill.status}`);
    const plan = this.previewApplication(billId);
    let paid = bill.amountCents;
    for (const p of plan) {
      const c = this.credits.find((x) => x.id === p.creditId)!;
      c.remainingCents = sub(c.remainingCents, p.cents);
      paid = sub(paid, p.cents);
      bill.applied.push({ creditId: p.creditId, cents: p.cents });
    }
    if (paid < ZERO) throw new Error("invariant 10: payment below zero");
    bill.paidCents = cents(paid);
    bill.status = "paid";
    return { paidCents: bill.paidCents, applied: plan };
  }

  creditRemaining(creditId: string): Cents {
    const c = this.credits.find((x) => x.id === creditId);
    if (!c) throw new Error(`no credit ${creditId}`);
    return c.remainingCents;
  }

  getBill(billId: string): RampBill {
    return structuredClone(this.#bill(billId));
  }

  listCredits(vendorId: string): RampCredit[] {
    return structuredClone(this.credits.filter((c) => c.vendorId === vendorId));
  }

  #bill(id: string): RampBill {
    const b = this.bills.find((x) => x.id === id);
    if (!b) throw new Error(`no bill ${id}`);
    return b;
  }
}
