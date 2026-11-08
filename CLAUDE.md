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
- Screens render only `buildScreens(app)` (src/view.ts) plus `contra.explainEligibility` / `contra.creditMemo`.
- Every button calls exactly one function in src/commands.ts through a server action.
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
- Windows. Use PowerShell syntax in instructions: `$env:ANTHROPIC_API_KEY = "..."`, not `KEY=... cmd`.
- Node 22.13+ (node:sqlite). Tests: node's runner via tsx.
