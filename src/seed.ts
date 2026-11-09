import { addDays } from "./clock.ts";
import { cents } from "./money.ts";
import type { RampBill, RampCredit, RampVendor } from "./mocks/ramp.ts";
import type { Alias, Email, ExtractedBackCharge, ExtractedResponse, Job, Subcontract } from "./types.ts";

/** Demo seed. All dates are relative to `now`, so the seed never goes stale. */
export function demoSeed(now: Date) {
  const jobs: Job[] = [
    { id: "SUM-01", name: "Summit Medical Office", aliases: ["Summit", "Summit MOB"] },
    { id: "LAK-02", name: "Lakeview Library", aliases: ["Lakeview"] },
  ];

  const clause = {
    section: "§14.3 Back-Charges",
    text:
      "Contractor shall give Subcontractor written notice of any back-charge. Subcontractor shall have five (5) working days " +
      "from receipt to dispute in writing. Undisputed back-charges may be deducted from any payment due Subcontractor.",
    deductionAllowed: true,
    noticeRequired: true,
    responseWindow: { amount: 5, unit: "working_days" as const },
  };

  const subcontracts: Subcontract[] = [
    { id: "SC-SUM-0912", jobId: "SUM-01", partyLegalName: "Ridgeline Interiors LLC", scope: "Drywall & framing", valueCents: cents(61_200_000), clause, paymentsVendorId: "V-RIDGE" },
    { id: "SC-SUM-0820", jobId: "SUM-01", partyLegalName: "Ridgeline Glass & Glazing Inc", scope: "Curtain wall", valueCents: cents(38_000_000), clause, paymentsVendorId: "V-RGG" },
    { id: "SC-SUM-0700", jobId: "SUM-01", partyLegalName: "Harbor Mechanical Co", scope: "HVAC", valueCents: cents(91_000_000), clause, paymentsVendorId: "V-HARBOR" },
    { id: "SC-LAK-0301", jobId: "LAK-02", partyLegalName: "Ridgeline Interiors LLC", scope: "Drywall", valueCents: cents(24_000_000), clause, paymentsVendorId: "V-RIDGE" },
  ];

  // "Ridgeline" alone is NOT an alias: it is ambiguous on Summit.
  const aliases: Alias[] = [{ alias: "Ridgeline Drywall", partyLegalName: "Ridgeline Interiors LLC", source: "seed" }];

  const vendors: RampVendor[] = [
    { id: "V-RIDGE", name: "Ridgeline Interiors LLC", remitTo: "Keystone Receivables Lockbox" },
    { id: "V-RGG", name: "Ridgeline Glass & Glazing Inc", remitTo: "Ridgeline Glass & Glazing Inc" },
    { id: "V-HARBOR", name: "Harbor Mechanical Co", remitTo: "Keystone Receivables Lockbox" },
  ];

  const pm = "dana.ortiz@apexbuilders.example";
  const sub = "marco@ridgelinedrywall.example";
  const subNamed = `Ridgeline Drywall <${sub}>`;

  const emails: Email[] = [
    {
      id: "E-1",
      from: pm,
      to: subNamed,
      subject: "Summit - back-charges L2",
      receivedAt: addDays(now, -9),
      body:
        "Marco,\r\n\r\nYour crew's drywall lift damaged the ceiling grid on Level 2 at Summit. BC-4467: replace damaged\r\n" +
        "ceiling grid, L2, $6,800.00 per the Apex Ceilings invoice.\r\n\r\nAfter three written warnings we hauled your debris " +
        "ourselves. BC-4468: debris haul-off, $4,700.00.\r\n\r\nDana Ortiz, PM",
    },
    {
      id: "E-2",
      from: pm,
      to: subNamed,
      subject: "RE: Summit corridor patch",
      receivedAt: addDays(now, -8),
      body:
        "BC-4470: re-patch corridor wall after MEP rework, $2,750.00. Ridgeline disputes this one, holding until we sort " +
        "out who caused it.\n\nDana",
    },
    {
      id: "E-3",
      from: pm,
      to: subNamed,
      subject: "Summit MOB - missed inspection",
      receivedAt: addDays(now, -7),
      body:
        "Ridgeline Drywall - your crew wasn't ready for the drywall inspection, so we paid the framing crew overtime to hold " +
        "the schedule. BC-4471: overtime for missed inspection, $4,000.00. Please acknowledge.\n\nDana",
    },
  ];

  // Recorded extractor output (what the LLM adapter must produce for these emails).
  const ev = (emailId: string, sentence: string) => ({ emailId, sentence });
  const extractions: Record<string, ExtractedBackCharge[]> = {
    "E-1": [
      { ref: "BC-4467", description: "Replace ceiling grid damaged by drywall lift, L2", amountCents: cents(680_000), amountEvidence: ev("E-1", "BC-4467: replace damaged ceiling grid, L2, $6,800.00 per the Apex Ceilings invoice."), vendorNameAsWritten: "Ridgeline Drywall", jobRef: "Summit", disputeNoted: false },
      { ref: "BC-4468", description: "Debris haul-off after 3 warnings", amountCents: cents(470_000), amountEvidence: ev("E-1", "BC-4468: debris haul-off, $4,700.00."), vendorNameAsWritten: "Ridgeline Drywall", jobRef: "Summit", disputeNoted: false },
    ],
    "E-2": [
      { ref: "BC-4470", description: "Re-patch corridor wall after MEP rework", amountCents: cents(275_000), amountEvidence: ev("E-2", "BC-4470: re-patch corridor wall after MEP rework, $2,750.00."), vendorNameAsWritten: "Ridgeline Drywall", jobRef: "Summit", disputeNoted: true, disputeEvidence: ev("E-2", "Ridgeline disputes this one, holding until we sort out who caused it.") },
    ],
    "E-3": [
      { ref: "BC-4471", description: "Overtime for missed inspection", amountCents: cents(400_000), amountEvidence: ev("E-3", "BC-4471: overtime for missed inspection, $4,000.00."), vendorNameAsWritten: "Ridgeline Drywall", jobRef: "Summit MOB", disputeNoted: false },
    ],
  };

  return { jobs, subcontracts, aliases, vendors, emails, extractions, pm, sub };
}

/** The sub's reply, built after the notice exists so it can quote it. */
export function demoReply(noticeId: string, noticeBody: string, sentAt: Date): { email: Email; extraction: ExtractedResponse } {
  const quoted = noticeBody.split("\n").map((l) => `> ${l}`).join("\n");
  const email: Email = {
    id: "E-4",
    from: "marco@ridgelinedrywall.example",
    to: "dana.ortiz@apexbuilders.example",
    subject: `RE: ${noticeId}`,
    receivedAt: addDays(sentAt, 1),
    body: `Fine, except 4471. Our crew was ready, your inspector rescheduled.\n\nMarco\n\nOn ${sentAt.toDateString()}, Contra wrote:\n${quoted}`,
  };
  return {
    email,
    extraction: { noticeId, disputedRefs: ["BC-4471"], acceptedRefs: ["BC-4467", "BC-4468"], evidence: { emailId: "E-4", sentence: "Fine, except 4471." } },
  };
}

/**
 * Email history + Ramp history for the "missed back-charges" opener (shadow mode).
 * Old credits are fully consumed (remaining 0) so they can't apply to the demo's $48,000 bill.
 */
export function historySeed(now: Date) {
  const pm = "dana.ortiz@apexbuilders.example";
  const mk = (id: string, daysAgo: number, to: string, subject: string, body: string): Email => ({ id, from: pm, to, subject, receivedAt: addDays(now, -daysAgo), body });
  const emails: Email[] = [
    mk("H-1", 62, "marco@ridgelinedrywall.example", "Lakeview cleanup", "Ridgeline Drywall left debris in the reading room again. BC-4391: cleanup crew, Lakeview, $3,100.00."),
    mk("H-2", 51, "ap@harbormech.example", "Summit duct damage", "Harbor Mechanical crushed two duct runs with the lift. BC-4402: duct replacement, $1,850.00."),
    mk("H-3", 44, "marco@ridgelinedrywall.example", "Summit stair 2 rework", "Stair 2 drywall failed inspection twice. BC-4410: rework by others at Summit, $5,600.00."),
    mk("H-4", 38, "office@ridgelineglass.example", "Summit glass breakage", "Ridgeline Glass & Glazing broke a storefront lite during install. BC-4415: replacement glass, $2,400.00."),
    mk("H-5", 33, "ap@harbormech.example", "Summit MOB - crane standby", "Harbor Mechanical missed the crane pick window. BC-4420: crane standby charges, $7,250.00."),
  ];
  const ev = (emailId: string, sentence: string) => ({ emailId, sentence });
  const x = (ref: string, emailId: string, description: string, amount: number, sentence: string, vendor: string, job: string): ExtractedBackCharge => ({
    ref, description, amountCents: cents(amount), amountEvidence: ev(emailId, sentence), vendorNameAsWritten: vendor, jobRef: job, disputeNoted: false,
  });
  const extractions: Record<string, ExtractedBackCharge[]> = {
    "H-1": [x("BC-4391", "H-1", "Cleanup crew", 310_000, "BC-4391: cleanup crew, Lakeview, $3,100.00.", "Ridgeline Drywall", "Lakeview")],
    "H-2": [x("BC-4402", "H-2", "Duct replacement", 185_000, "BC-4402: duct replacement, $1,850.00.", "Harbor Mechanical", "Summit")],
    "H-3": [x("BC-4410", "H-3", "Stair 2 rework by others", 560_000, "BC-4410: rework by others at Summit, $5,600.00.", "Ridgeline Drywall", "Summit")],
    "H-4": [x("BC-4415", "H-4", "Replacement storefront glass", 240_000, "BC-4415: replacement glass, $2,400.00.", "Ridgeline Glass & Glazing", "Summit")],
    "H-5": [x("BC-4420", "H-5", "Crane standby", 725_000, "BC-4420: crane standby charges, $7,250.00.", "Harbor Mechanical", "Summit MOB")],
  };
  const rampCredits: RampCredit[] = [
    { id: "VC-OLD-1", vendorId: "V-RIDGE", jobId: "LAK-02", amountCents: cents(310_000), remainingCents: cents(0), accountingDate: addDays(now, -55), erpSynced: true, createdVia: "history", memo: "Backcharge BC-4391 cleanup Lakeview" },
    { id: "VC-OLD-2", vendorId: "V-HARBOR", jobId: "SUM-01", amountCents: cents(185_000), remainingCents: cents(0), accountingDate: addDays(now, -45), erpSynced: true, createdVia: "history", memo: "per PM" },
  ];
  const rampBills: RampBill[] = [
    { id: "B-OLD-1", vendorId: "V-RGG", jobId: "SUM-01", amountCents: cents(2_200_000), accountingDate: addDays(now, -30), origin: "native", applyCredits: false, status: "paid", paidCents: cents(1_960_000), applied: [], memo: "Pay app 3 less BC-4415 glass breakage" },
    { id: "B-OLD-2", vendorId: "V-RIDGE", jobId: "SUM-01", amountCents: cents(3_100_000), accountingDate: addDays(now, -28), origin: "native", applyCredits: false, status: "paid", paidCents: cents(3_100_000), applied: [], memo: "Pay app 4" },
    { id: "B-OLD-3", vendorId: "V-HARBOR", jobId: "SUM-01", amountCents: cents(5_400_000), accountingDate: addDays(now, -20), origin: "native", applyCredits: false, status: "paid", paidCents: cents(5_400_000), applied: [], memo: "Pay app 5" },
  ];
  return { emails, extractions, rampCredits, rampBills };
}
