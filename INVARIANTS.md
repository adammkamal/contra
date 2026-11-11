# Invariants

Each invariant is enforced in code **and** covered by a named test. If a change would break one, stop
and ask a human. Agents may not edit this file, `test/invariants.test.ts`, `test/demo.test.ts` or
`bench/labels/` (see AGENTS.md).

| # | Invariant | Enforced in | Test |
|---|---|---|---|
| 1 | Money is integer cents (`Cents`, a branded integer). No floats anywhere, and no `parseFloat` on money. | `src/money.ts` | `invariants: I1` |
| 2 | Every extracted amount has a source sentence that appears verbatim (after whitespace normalization only) in the email body, and the amount parsed from that sentence equals the extracted amount. | `src/span.ts` | `invariants: I2` |
| 3 | The LLM never decides eligibility. `evaluateEligibility` is a pure function of records and the clock; it takes no model output except span-verified facts. | `src/eligibility.ts` | `invariants: I3` |
| 4 | Disputed or unresolved items never become credits. | `src/credits.ts` | `invariants: I4` |
| 5 | No credit exists without a recorded human approval, and no notice is sent without one. | `src/workflow.ts` | `invariants: I5` |
| 6 | Every state change is appended to the audit log with the actor, the time and the evidence. The log is append-only. | `src/audit.ts`, `src/state.ts` | `invariants: I6` |
| 7 | A credit is never applied to an imported bill or to a bill with credits turned off, and a credit that isn't synced to the ERP never applies. Bill origin is checked first. | `src/mocks/ramp.ts` | `invariants: I7` |
| 8 | Remit-to, payee and lockbox names are never used for matching. Matching uses only subcontract party names and confirmed aliases. | `src/resolver.ts` | `invariants: I8` |
| 9 | Illegal state transitions throw. There is no way to skip from `extracted` to `credited`. | `src/state.ts` | `invariants: I9` |
| 10 | A bill's payment equals the bill amount minus the credits applied, never below zero; any leftover credit stays available. | `src/mocks/ramp.ts` | `invariants: I10` |
| 11 | Every command is atomic: the command, its audit events and the snapshot commit together, or nothing changes. The event table rejects UPDATE and DELETE. | `src/app.ts`, `src/store/sqlite.ts` | `store: a command that throws…`, `store: append-only…` |
| 12 | "Missed money" never includes disputed, unlinked or unverified items, and a credit counts as a deduction only for the same vendor and an exact ref match. | `src/reconcile.ts` | `reconcile: disputed, unlinked…`, `reconcile: ref matching…` |
| 13 | Money from the model is parsed only from the dollar text it copied (exactly one $ figure, found inside its quoted sentence). The model never supplies a number for money, and off-shape output is rejected, not repaired. | `src/extract/validate.ts` | `extract: validation rejects…`, `extract: amountText with two…` |
| 14 | Screens show only what `buildScreens` derives from stored state, and every button maps to one command run inside `app.run`. | `src/view.ts`, `src/commands.ts` | `view: following nextStep…`, `view: buttons only appear…` |
| 15 | The backend executes only actions it is currently offering on screen (`isOffered`): forged, stale or double-clicked actions are refused and change nothing. A picker's choice must be one of its offered options. | `src/commands.ts` (`runAction`), `src/view.ts` | `api: two-part actions…`, `api: runAction: an offered picker…` |
| 16 | Hand-written sample extractions are never logged or shown as model output; recorded model output is used only when every demo email has a recording. | `src/commands.ts`, `src/actors.ts`, `src/view.ts` | `contract: no recorded model output…`, `contract: recordings missing…` |
