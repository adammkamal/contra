# Contra: rules for Claude Code

Read SPEC.md (what to build, the demo script with exact amounts) and INVARIANTS.md (rules with tests)
before changing code. AGENTS.md has the file layout and how the UI calls the core. The rules below are
inline on purpose, so subagents get them even if file imports are not expanded.

## Never
- Edit INVARIANTS.md, test/invariants.test.ts, test/demo.test.ts or bench/labels/. If one looks wrong, stop and say so.
- Do arithmetic on dollars, use floats for money, `parseFloat` or `toFixed` on amounts. Use `Cents` from src/money.ts.
- Call a model anywhere in src/ except src/extract/. Eligibility, matching and money are deterministic code.
- Change state except through `transition*()` (src/state.ts) and, from UI or scripts, `app.run(...)` via src/commands.ts.
- Read the clock with `Date.now()` / `new Date()` in src/. Time comes from the injected Clock.
- Add behavior to MockRamp that Ramp doesn't document (SPEC section 4).
- Add dependencies to src/. UI, extractor scripts and tests may.
- Put real (non-sample) emails or financial data in git. They go in private/ (gitignored).

## UI
- The frontend contract is FRONTEND_CONTRACT.md. Screens render only `buildScreens(app)`, `backChargeDetail(app, ref)`
  and `contra.creditMemo(id)` (or the same data from the JSON API in server/api.ts).
- Every button sends the Action it was given to `runAction` (src/commands.ts), in-process or via POST /api/action.
- When `extractionSource` is "sample", the Inbox says the extractions are hand-written, not model output.
- Every Ramp screen shows a "Simulated Ramp" badge. The opener shows "Sample data".
- The status word carries the meaning; color only decorates.

## Done means
- `npm run check` passes (typecheck + all tests). `npm run bench` runs.
- New rule => a test that fails when the rule is removed. Break it once yourself to confirm.
- AI changes => `npm run extract:live` passes 5/5 before fixtures are re-recorded.
- Report the actual commands you ran and their results. Never claim a check you did not run.

## Models and sessions
- Lead session (src/, merges): Opus 5.5. UI and Playwright worktree: Sonnet 5.5. Monday review: a separate session on Fable 5.1 running the money-reviewer agent.
- Never set CLAUDE_CODE_SUBAGENT_MODEL: it overrides every agent's model silently.
- At most two builder sessions at once; the human reviews every diff in src/.

## Environment
- Windows. Use PowerShell syntax in instructions, never `KEY=... cmd`.
- Contra's API key and model live in `.env.local` as CONTRA_ANTHROPIC_API_KEY and CONTRA_MODEL (see
  .env.example). Never set ANTHROPIC_API_KEY or ANTHROPIC_MODEL in a terminal that runs Claude Code:
  Claude Code reads them too (billing and model would silently change). Never print or commit the key.
- Node 22.13+ (node:sqlite). Tests: node's runner via tsx.
