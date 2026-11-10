# Rules for coding agents working on Contra

(Claude Code reads CLAUDE.md, which repeats the hard rules inline. Keep the two in sync.)

Read SPEC.md and INVARIANTS.md before writing code.

## Hard rules
1. **Never edit** `INVARIANTS.md`, `test/invariants.test.ts`, `test/demo.test.ts` or anything under
   `bench/labels/`. If one of them looks wrong, stop and say so. A pre-commit hook rejects such edits
   (`scripts/protect.sh`).
2. **Money:** use `Cents` from `src/money.ts`. Never use `number` arithmetic on dollars, `toFixed` for
   math, or `parseFloat` on amounts.
3. **No model calls inside `src/` except `src/extract/`.** Eligibility, resolving and money code is
   deterministic.
4. **Every state change goes through `transition()`** in `src/state.ts`. Don't write states directly.
5. **Time comes only from the injected `Clock`.** No `Date.now()` and no `new Date()` without
   arguments in `src/`.
6. MockRamp implements **only documented Ramp behavior** (SPEC §4). Don't add conveniences that real
   Ramp lacks.
7. **Don't add dependencies to `src/`.** UI, extractor and storage adapters may add them.

## Done means
- `npm run check` passes (typecheck plus all tests). `npm run bench` runs.
- AI changes: `npm run extract:live` passes 5/5 runs before fixtures are re-recorded.
- The demo test still asserts $11,500.00 credit / $36,500.00 payment.
- New logic comes with tests. A rule in the eligibility engine needs a test that fails without it.

## Layout
```
src/money.ts         Cents type, parse and format
src/types.ts         domain records
src/clock.ts         injectable clock
src/audit.ts         append-only event log
src/state.ts         back-charge and credit state machines
src/span.ts          verbatim source check
src/intake.ts        per-item ingest checks (span, dispute, link); shared with bench/
src/resolver.ts      job -> subcontract party -> alias linkage
src/eligibility.ts   deterministic eligibility rules
src/credits.ts       credit proposal from eligible items
src/workflow.ts      orchestration with human approvals
src/mocks/ramp.ts    MockRamp (documented rules only)
src/mocks/erp.ts     MockERP
src/memo.ts          credit memo for the Ramp AP-inbox route
src/reconcile.ts     read-only "missed back-charges" scan (shadow mode)
src/store/sqlite.ts  append-only event log + snapshots (node:sqlite, built in)
src/app.ts           App: the ONLY entry point for UI and scripts
src/commands.ts      one function per UI button (each inside app.run) + runAction(app, action, input) dispatcher
server/api.ts        JSON API over the same functions (npm run api); node:http, plus ingest/ for .eml
ingest/eml.ts        parseEml / loadPmEmails: .eml files -> Email (mailparser; outside src/ on purpose)
scripts/make-eml.ts  writes fixtures/emails/E-1..E-3.eml from the seed (QP, HTML-only, 7bit)
FRONTEND_CONTRACT.md what the frontend may rely on; contract/samples/ = real JSON per demo step
INTEGRATION.md       how Contra maps onto real Ramp (public docs only)
src/view.ts          buildScreens(app) / nextStep(app): everything the screens show
src/actors.ts        demo identities (PM, controller, AP)
src/extract/         AI extraction: prompt, Anthropic adapter, strict validation, fixtures
scripts/extract-live.ts  live acceptance run for extraction; writes fixtures only if all runs pass
src/seed.ts          demo seed + history seed, dates relative to the clock
bench/               benchmark harness, baseline matcher, cases, labels (protected)
test/                node:test suites
```

## How the UI must call the core
- **Render only `buildScreens(app)`** (and `contra.explainEligibility(ref)` / `contra.creditMemo(id)` for
  detail panels). No status words, amounts or button rules in components.
- **Every button calls one function in `src/commands.ts`**, via a server action. Never call `contra` or
  `ramp` from UI code. Show `nextStep(app)` as the highlighted presenter hint.
- Each bill shows its `check` (actions, warnings, would-pay) and the "Simulated Ramp" badge.
- Create one `App` per server process: `new App("data/demo.db")`. Delete the file to reset the demo.
- Every mutation goes through `app.run((ctx) => ...)`. It runs the command, its audit events and the
  snapshot in one transaction; if the command throws, everything rolls back and state reloads.
- Read for rendering with `app.ctx` (never mutate through it), `app.missedBackCharges()` for the
  opener, `ctx.contra.creditMemo(id)` for the memo, `ctx.contra.previewBill(id)` before paying.
- "Advance 5 days" is `app.advanceDays(5)`.
