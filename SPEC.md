# Contra — Build Spec

Status: Sunday Nov 8, 2026. Demo video due Tuesday Nov 10.

## 1. What Contra is

Contra is a feature concept for Ramp Bill Pay for general contractors. It reads the back-charges that
project managers already send to subcontractors by email. It links each one to the right subcontract,
job and back-charge clause, and decides in code whether it is eligible to deduct. It then proposes a
vendor credit, which a person approves before it exists.

- The AI only **extracts** fields, and each field comes with the exact source sentence.
- Code **links** extracted fields to records, through a rule-based resolver.
- Code **decides** eligibility.
- A person **approves** every notice and every credit.

## 2. What "done by Tuesday" means

Every step of the demo really runs: email parsing, AI extraction, the span check, resolving, the
eligibility rules, the state machine, the audit log, notice generation, credit creation, ERP sync, bill
payment and the money math.

Two parts are mocks, and the UI must say so on screen:

- **MockRamp** implements only what Ramp documents. Its screens carry a "Simulated Ramp" label.
- **MockERP** holds the subcontracts, the clauses and the credit sync.

The demo must never say "Bill Pay sends $36,500." It says "Simulated Bill Pay pays $36,500."

Production integration (a real GC's inbox, ERP and Ramp account) comes after Tuesday. Each one is an
adapter swap.

## 3. Demo script = acceptance criteria

All amounts are fixed. The Playwright test `e2e/demo.spec.ts` must assert every bold value. The
domain-level version, `test/demo.test.ts`, already passes.

**Seed data**
- **Job:** `SUM-01` "Summit Medical Office". Aliases: "Summit", "Summit MOB".
- **Subcontract:** `SC-SUM-0912`, Summit job, Ridgeline Interiors LLC, drywall and framing, $612,000.
  - Clause §14.3 (Back-Charges): written notice is required, and the subcontractor has **5 working days**
    to respond (mirrors AIA A401-2017 §3.5). Undisputed amounts may be deducted from any payment due.
- **Alias table:** "Ridgeline Drywall" → Ridgeline Interiors LLC (the name on the trailer sign).
  "Ridgeline" alone is **not** an alias, because "Ridgeline Glass & Glazing" is also a sub on Summit.
- **Ramp vendor:** `V-RIDGE` Ridgeline Interiors LLC, remit-to "Keystone Receivables Lockbox"
  (factored).
- **Back-charges in PM emails:**

| ID | What | Amount | Source fact |
|---|---|---|---|
| BC-4467 | Replace ceiling grid damaged by drywall lift, L2 | **$6,800.00** | plain |
| BC-4468 | Debris haul-off after 3 warnings | **$4,700.00** | plain |
| BC-4470 | Re-patch corridor wall after MEP rework | **$2,750.00** | PM wrote "Ridgeline disputes this one, holding" |
| BC-4471 | Overtime for missed inspection | **$4,000.00** | plain |

**Steps**

0. **Opener: missed back-charges (read-only).** Contra scans 5 older PM emails and compares them with
   Ramp's credits and paid bills: **$12,850.00 never deducted** (BC-4410 and BC-4420), $1,850.00
   possible match (amount only, no ref), and $5,500.00 deducted (one credit, one short-paid bill). This
   step works with Ramp's API today, because it only reads.
1. Three PM `.eml` files to "Ridgeline Drywall" are ingested. Contra shows **4** extracted
   back-charges, each amount beside its verbatim source sentence. All 4 resolve to `SC-SUM-0912`
   through the alias "Ridgeline Drywall", and the UI shows why ("alias → party → job"). The PM confirms.
2. Contra quotes §14.3. BC-4470 is **held: dispute noted in source**. Contra drafts one notice for
   BC-4467, 4468 and 4471, **$15,500.00** in total. The controller approves it, and only then is it sent
   (to the in-app outbox).
3. Ridgeline's reply ".eml" says "Fine, except 4471." Contra marks 4467 and 4468 accepted, holds
   **BC-4471: disputed by sub**, and routes it to the PM queue.
4. The clock advances a week (the 5-working-day window from Sat Nov 7 closes Fri Nov 13; five calendar
   days later nothing is eligible yet). The eligible items are 4467 and 4468. Contra proposes one credit of
   **$11,500.00**, coded to `SUM-01`. The controller approves it, and MockERP syncs it. Contra shows the
   **credit memo** that, in production, goes to the GC's Ramp AP inbox.
5. Ridgeline's **$48,000.00** native bill for Summit arrives in MockRamp. Contra's **bill-arrival check**
   (production: Ramp's `bills.created` webhook) says "turn on credits: VC-1 $11,500.00 would apply."
   AP turns credits on, and simulated Bill Pay pays **$36,500.00**.
6. Benchmark slide: the number of cases, **wrong credits = 0**, the share held for review, and the match
   rate against the baseline field matcher. The factoring case: the baseline matches the bill's remit-to
   "Keystone Receivables Lockbox" to a different vendor that uses the same lockbox, and Contra doesn't,
   because it never matches on remit-to.

Audit log: every transition in steps 1–5 appears with the actor, the time and the evidence.

## 4. Documented Ramp behavior that MockRamp models (re-checked against Ramp's support docs, Nov 7)

- **No API endpoint for creating credits.** The API's vendor-credit endpoint is read-only. Credits are
  made in the dashboard (from a paid bill or from the vendor profile) or through AP-inbox forwarding,
  which creates drafts that a person finishes one at a time. MockRamp has `createCredit` only because the
  demo needs it. Say that on screen.
- **There are two ways to apply credits, and MockRamp models only the older one:**
  - **"Apply vendor credits"** (older): credits apply in ascending order by accounting date. On a tie,
    the credit with the larger remaining balance goes first. Sync errors must be fixed first.
  - **"Apply available vendor credits"** (newer): you can enter a partial amount, and it doesn't need
    every credit synced. Whether it lets you pick a specific credit is **unconfirmed**. Check in the
    sandbox, because if it does, the cross-job risk below mostly goes away.
- **Imported bills** can't receive credits. Credits work only on bills that show "Apply available vendor
  credits."
- **Credits can't be applied once a payment has started** or been added to a batch.
- **Credits work only with some accounting systems:** QuickBooks Online, Xero, NetSuite, Sage Intacct,
  Dynamics F&O, Universal CSV (beta) and Dev API. Construction-specific ERPs (e.g. Sage 300 CRE,
  Viewpoint Vista) are not on the list. Ask on every call which ERP they run.
- Bills created through the API arrive already approved.
- Contra policy, stricter than Ramp: never apply a credit that isn't synced to the ERP.

**Credit leakage across jobs** (a real risk, now a feature): because credits apply oldest-first per
vendor, a Summit credit can land on Ridgeline's bill for another job. Contra runs
`previewApplication(bill)` before a bill with credits turned on is paid, and warns when a credit's job
doesn't match the bill's job.

## 5. Build plan (replaces the attachment's plan)

The attachment's architecture is kept, with these changes:

| Change | Reason |
|---|---|
| Build the domain core first, framework-free, with zero runtime dependencies | The judged parts (eligibility, money, state) get tested before any UI exists |
| SQLite (`node:sqlite`) event log instead of Postgres in Docker | No Docker and no network during the demo. Postgres stays an adapter for later |
| Outgoing notices go to an in-app outbox; Mailpit is cut | One less service, and the notice approval is still real |
| Cut: the DCO settlement stub, XState, fast-check, Vercel and the "all jobs" opening | Not enough time; none of them changes the demo |
| Benchmark: 15–20 cases labeled by hand, plus a baseline matcher | A small, honest set beats 40 rushed cases. "0 wrong credits" is reported with the held rate |
| Zod at the I/O boundaries (LLM output, API input) on the dev machine | The core uses hand-written validators so it runs with no installs |

**Saturday — done (by Claude):** spec, invariants, domain core, resolver, eligibility, mocks, demo test,
SQLite store with atomic commands (`App`), credit memo, missed-back-charges scan, benchmark harness
with a baseline matcher and 4 example cases. 40 tests.
**Sunday — done (by Claude):** response windows in hours / calendar days / working days (demo clause
= 5 working days), bill-arrival check, screen-data layer (`buildScreens`, `nextStep`), one command per
button, AI extraction adapter + prompt + strict validation + live acceptance script. 57 tests.
**Sunday — you, on your machine:** run `npm run extract:live` with your API key until it passes 5/5
(#2), `.eml` parsing (#3), the Next.js screens rendering `buildScreens` and calling `commands` (#5),
and 15–20 hand-labeled benchmark cases.
**Monday:** the Playwright demo test, the benchmark run, an independent review of the money paths, and
the calls. Decide the pitch at noon.
**Tuesday:** freeze, record, keep a buffer.

## 6. Open risks (stated, not hidden)

1. **The main premise is unvalidated.** Nobody knows yet whether back-charges really go undeducted. The
   calls decide the pitch.
2. **A missed dispute in extraction.** If the model fails to notice a "disputes this" sentence, the item
   goes on to a notice. The guards are PM confirmation at step 1 and the sub's response window. It is
   not zero risk.
3. **No API for creating credits.** The production path depends on the dashboard, the AP inbox or a
   future endpoint.
4. **A sub with several subcontracts on one job** (base contract plus extra scope) always goes to the
   PM queue, because the resolver won't guess between them. This may be common with real GCs, and the
   calls should check.
5. **Late replies.** A dispute that arrives after the credit exists is flagged in `lateDisputes`, not
   reversed. Undoing a credit is a human process.
6. **The opener's $12,850 is sample data.** Label it "sample data" on screen. A real figure needs a real
   GC's email history, which is exactly what the shadow-mode pilot would produce. The scan also needs
   sub replies passed in (`disputedInReplies`), or a sub-disputed item looks like missed money.
7. **Working days ignore holidays and time zones.** Weekdays are counted in UTC with no holiday
   calendar. Production needs the job's time zone and a holiday list.
8. **The model is the weakest link until `npm run extract:live` passes.** Every extraction so far is
   hand-written or faked in tests.
9. **Clauses in PDFs.** Real subcontract clauses live in PDF files. MockERP stores them as structured
   fields, and that is a demo simplification.
