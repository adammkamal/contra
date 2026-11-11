# How Contra would integrate with real Ramp

The demo runs on simulated Ramp. The hackathon organizers could not provide sandbox access or product
answers, and asked teams to use public documentation and mock data, and to explain what a real
integration would look like. This is that explanation. Every Ramp behavior below comes from Ramp's
public docs (sources at the end). Simulated Ramp implements only those behaviors.

## 1. What Contra needs from Ramp, step by step

| Contra step | Real integration | Works today? |
|---|---|---|
| Map each subcontract party to a Ramp vendor (`paymentsVendorId`) | Read Ramp's vendor list through the API, including remit-to details. A person confirms each mapping once. Contra never matches on remit-to or lockbox names (invariant 8). | Yes, read-only |
| Find back-charges in PM email | Contra's own email ingestion (Gmail or Outlook in production; `.eml` files in the demo). Ramp isn't involved. | n/a |
| Missed back-charges scan (demo opener) | Read the vendor credits and paid bills (with memos) through the API, and compare them with the back-charges found in email. Nothing is written to Ramp. | **Yes, read-only.** This is the first thing a real customer could run. |
| Bill arrives, then the deduction check | Subscribe to Ramp's bill webhooks (`bills.created`, `bills.approved`, `bills.paid`). On `bills.created` or `bills.approved`, Contra runs `billArrivalCheck` and tells AP what to do before payment starts. | **Yes, read-only** (webhooks plus reads) |
| Create the approved vendor credit | **There is no public API for creating vendor credits**; the API exposes vendor credits for reading only. The real route: Contra produces the credit memo (`creditMemo`), forwards it to the GC's Ramp AP inbox, and Ramp drafts a vendor credit that an AP clerk reviews and finishes. A credit can also be created by hand from the vendor profile. | Partly: a person finishes each draft in Ramp |
| Code the credit to the job | Ramp for Construction already supports project coding, so the memo carries the job, and the clerk (or Ramp's draft) applies Ramp's project code. | Yes (Ramp feature) |
| Apply the credit to the sub's next bill | In Ramp, on a bill showing "Apply available vendor credits." This can't be done once a payment has started or been added to a batch, and imported bills can't receive credits. Contra's `previewApplication` / `billArrivalCheck` predicts where credits will land and warns when a credit belongs to a different job. | Yes (Ramp feature) |
| Credit syncs to the ERP | Through Ramp's accounting sync. Vendor credits are supported only for QuickBooks Online, Xero, NetSuite, Sage Intacct, Dynamics 365 F&O, Universal CSV (beta) and the Dev API connection. | Only for those ERPs |

## 2. What the demo simulates, and why

| Simulated | Real equivalent | Labeled on screen |
|---|---|---|
| `MockRamp.createCredit` | AP-inbox draft plus a clerk finishing it (no create API exists) | "Simulated Ramp" |
| `MockRamp` bills, credit toggle and payment | Ramp Bill Pay | "Simulated Ramp" |
| `MockERP` subcontracts and clauses | The GC's ERP or Procore (clauses usually live in PDF files) | Stated in the spec |
| The missed back-charges history | A real GC's email history plus its Ramp records | "Sample data" |

Simulated Ramp models Ramp's *older* credit flow: credits apply oldest-first by accounting date, with
ties going to the larger remaining balance. Ramp's newer flow allows partial amounts. Whether it lets a
user choose a specific credit is not documented, so it isn't modeled.

## 3. Rollout plan

1. **Shadow mode (read-only).** Connect email and read Ramp's bills, credits and vendors. Contra reports
   back-charges that never got deducted and flags bills as they arrive. It needs no write access and
   carries no money risk, and it measures the problem with the customer's own data.
2. **Assisted credits.** Turn on the approval flow. Each approved credit produces a memo forwarded to
   the AP inbox, and the clerk finishes the draft in Ramp. Contra then reads the credit back and
   reconciles it.
3. **Direct credits, if Ramp adds a create-credit endpoint.** The same approval flow, with the memo
   step replaced by an API call. Nothing upstream changes, because the backend already treats Ramp as an
   adapter (`PaymentsPlatform`).

## 4. Questions to confirm in a Ramp sandbox (not available during the hackathon)

1. Does the newer "Apply available vendor credits" flow let a user pick which credit applies? If so,
   credits landing on the wrong job stops being a risk.
2. Does an AP-inbox credit memo reliably become a draft vendor credit, and does the project coding
   survive?
3. When a bill carries both a credit and retainage, what gets paid?
4. Are vendor credits on the roadmap for construction ERPs such as Sage 300 CRE and Viewpoint Vista?

## Sources

- [Ramp: Vendor credits / credit memos on Bill Pay](https://support.ramp.com/vendor-credits-credit-memos-on-ramp-bill-pay)
- [Ramp: Uploading invoices and bills (AP inbox forwarding)](https://support.ramp.com/hc/en-us/articles/22179276078739-Uploading-invoices-and-bills-on-Ramp-Bill-Pay)
- [Ramp developer docs: Webhooks](https://docs.ramp.com/llms-guides/webhooks.txt)
- [Ramp developer docs: Sandbox](https://docs.ramp.com/llms-guides/sandbox.txt)
- [Ramp: Accessing the Developer API](https://support.ramp.com/hc/en-us/articles/46681939909907-Accessing-the-Developer-API)
- [Ramp for Construction](https://support.ramp.com/ramp-for-construction)
- [Lava API reference for Ramp (vendor credits are read-only)](https://www.lava.so/docs/gateway/providers/ramp.md)
