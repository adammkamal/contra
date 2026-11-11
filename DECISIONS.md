# Decisions

Why Contra is built the way it is. Each entry gives the choice, the reason, what we rejected, and what enforces it. Where a test enforces a rule, the rule was broken on purpose once to confirm the test fails.

## 1. The model reads; code decides

**Choice.** The model does one job: extract back-charge items (reference, amount, description, vendor and job as written, and the source sentence) from an email. Linking to a subcontract, eligibility, response windows, amounts and credits are deterministic TypeScript.

**Why.** A controller has to be able to answer "why was $4,700 taken off this bill?" with a rule and a sentence, not "the model thought so." Code can be tested exhaustively and gives the same answer twice.

**Rejected.** Asking the model whether an item is eligible or which subcontract it belongs to. It was faster to build and impossible to audit.

**Enforced by.** INVARIANTS.md #3; CLAUDE.md forbids model calls anywhere in `src/` except `src/extract/`.

## 2. Money is integer cents, and an unreadable amount is never guessed

**Choice.** Every amount is a branded integer `Cents`. No floats, `parseFloat` or `toFixed` on money. A malformed amount ("$1,200.5", "$1.200,50", "$1,20,000", "$1 200") is rejected with a reason and goes to a person.

**Why.** An earlier version read "$1,200.5" as $1,200.00, silently dropping 50 cents. A wrong credit costs more than a review. "$1,200.5" is as likely a clipped digit as $1,200.50, so we don't pick one.

**Also.** An unreadable amount still counts as an amount, so "$1,200.5 labor, $40.00 disposal" is never treated as a one-amount sentence.

**Enforced by.** INVARIANTS.md #1 and #13; `test/money.test.ts`.

## 3. Every amount must appear word for word in the email's own text

**Choice.** An extracted amount is accepted only if its source sentence appears verbatim in the email, the amount appears in that sentence, and the sentence is in the sender's own text, not in quoted or forwarded mail.

**Why.** It turns "the model said $6,800" into "the PM wrote '$6,800' in this sentence." It also stops a back-charge that only appears in an old quoted thread from being charged again.

**How quoted text is detected.** "> " lines; "On … wrote:"; "-----Original Message-----"; forwarded-message markers; Outlook From/Sent/To/Subject header blocks.

**Enforced by.** INVARIANTS.md #2; `src/span.ts`; benchmark case bc-15 (quoted-only) was a wrong credit in the first run and is now held.

## 4. When unsure, hold and say why

**Choice.** An item is held for a person, with a reason in plain words, when any of these is true:
- the PM noted a dispute
- the sub disputed it
- the evidence doesn't verify
- the email states conflicting amounts
- the item appears only in quoted text
- the email contains text aimed at an AI or automated system
- a back-charge number in the email wasn't accounted for
- the amount comes only from a photo or scanned page (a person must type it; their amount is used and both readings are recorded)

**Why.** The failure we design against is a wrong credit: money taken from a sub who didn't owe it. A hold costs a reviewer a minute.

**Trade-off we accept.** Contra routes more items to people than a naive matcher: 8 of 20 on the main benchmark, against 2 for the baseline. That is the price of 0 wrong credits there.

## 5. Linking to a subcontract is deterministic, and ambiguity stops it

**Choice.** The resolver goes job → subcontract party → confirmed alias. A learned alias that could match two parties is refused when it's learned and again when it's used. Remit-to addresses are never used for matching. Once the job is known, a PM choosing manually only sees that job's subcontracts.

**Why.** A bug once taught the alias "Ridgeline" to one sub when two parties shared the word. Remit-to details are the classic vendor-fraud vector.

**Enforced by.** INVARIANTS.md #8; resolver tests.

## 6. People approve; Contra never sends or credits on its own

**Choice.**
- The PM approves the notice to the sub before it goes out.
- The controller approves every credit.
- State changes only through `transition*()` functions and atomic `app.run(...)` commands.
- The audit log is append-only, enforced by SQLite triggers.
- Screens offer only the actions that are legal right now, and the API refuses the rest (409).

**Why.** Back-charges are contractual. A sub has a window to respond (the demo clause gives 5 working days, in the style of AIA A401), and a disputed charge is a negotiation, not a deduction.

**Roles.** Contra enforces who may do what: the PM approves notices, the controller approves or rejects credits, and AP turns credits on for a bill. Nobody approves a credit for a charge they raised or linked. (Required sign-in is on the `logins` branch, not yet on `main`.)

**Enforced by.** INVARIANTS.md #4–6, #9, #11, #15; `test/invariants.test.ts`; `test/roles.test.ts`.

## 7. Ramp integration: only what Ramp documents

**What we found in Ramp's public docs** (details and links in SPEC.md section 4):
- The API can read vendor credits but has no endpoint to create one.
- Bills sent to the AP inbox become drafts.
- Bill webhooks exist.
- Vendor credits are supported only for some accounting connections.

**What Ramp told us.** No sandbox and no product answers; use the public docs and mock data, and explain the real integration in the submission.

**Choice.** `MockRamp` implements only documented behavior:
- a per-bill credit toggle
- credits applied oldest-first by accounting date, ties going to the larger remaining balance
- imported bills excluded
- ERP-synced vendors only

Creating a credit exists only in the mock, and every Ramp screen says "Simulated Ramp."

**Rollout we propose** (INTEGRATION.md):
1. **Shadow mode:** Contra flags; people act in Ramp.
2. **Memo to the AP inbox:** Contra emails a credit memo; an AP clerk finishes it in Ramp.
3. **Direct API:** only if Ramp adds a create-credit endpoint.

**Rejected.** Inventing Ramp behavior to make the demo smoother.

## 8. The extraction call

**Choice.**
- Claude Opus 5.5 through the Messages API, with plain `fetch` and no SDK in `src/`.
- `tool_choice: auto`, an effort setting, and no temperature.
- A 180-second timeout.
- Errors surface as a type and a fixed message, never the upstream text.
- The email is wrapped in tags with a random boundary, so text in the email can't close the wrapper.

**Why these settings.** Our first live run returned HTTP 400 on every call. Opus 5.5 rejects forced tool choice and the temperature parameter. We fixed the call rather than switching models.

**Record and replay.** Live extractions are recorded as fixtures, so tests and the demo run without a key. Any AI change must pass `npm run extract:live` (5 runs, every run must pass) before fixtures are re-recorded. Recordings keep the raw model output and are re-validated when scored, so a stricter validator is measured honestly against old runs.

## 9. The benchmark, reported honestly

**Setup.** 20 main cases and 8 held-out cases, each run 3 times. Labels are human-reviewed and protected by a pre-commit hook. The baseline is a field matcher that links on vendor and job fields and credits whatever it links.

**Correct** means the outcome matches the label: right link and credit, right hold, or right "send to a person." **Missed** means a labeled charge produced nothing a person would see. An early version of the scorer counted those as "sent to a person," which flattered us; the numbers below use the corrected scorer, re-run at the original commits.

| Run | Contra correct | Contra wrong credits | Contra missed | Baseline correct | Baseline wrong credits |
|---|---|---|---|---|---|
| Main, first run | 16–17/20 | 2 | 0–1 | 13/20 | 5–6 |
| Main, after fixes | 19/20 | 0 | 0 | 13/20 | 6 |
| **Held-out, first run** | **6/8** | **1** | **1** | 4/8 | 3 |
| Held-out, after fixes (no longer held-out) | 8/8 | 0 | 0 | 5/8 | 3 |
| **Fresh, written outside the team, first run** | **1/8** | **0** | **7** | 1/8 | 0 |

### The independent test, and what it changed

Someone outside the team wrote 8 realistic back-charge emails and a separate answer key, without seeing our code or prompt. None of the 8 contained a BC number, and our extraction prompt told the model to skip charges without one. Contra extracted nothing from 7 of them. The only correct case was the email that wasn't a back-charge. It made no wrong credits, but 7 charges would have vanished, which is the failure Contra exists to prevent. (Scored at commit 1605506; recordings in `fixtures/bench-extractions/fresh/`.)

We then asked a working PM how back-charges are numbered. Their answer: the number is usually assigned later, when accounting enters the charge. The first email typically gives the sub, the job, a description and an *estimated* cost. Follow-ups often cite the number, and small charges sometimes live in spreadsheets first.

So the design changed:
- Charges without a BC number are the main intake case. Contra assigns its own reference until accounting's number exists.
- A later email citing a BC number may describe a charge already reported without one. Contra holds it as a possible duplicate for the PM to confirm, and never merges automatically or charges twice.
- Estimated amounts are marked as estimates on the notice and at credit approval.
- Every email from an allowed sender produces a visible row, including "no back-charge found."

**Status at submission:** the fix is in progress on branch `bc-fix` and is not merged. A second independent set (fh-09..16, written to the PM's description) is ready but has not been run, because it should only be run once, against the finished fix.

**What the first runs taught us.**
- bc-12 was a prompt injection. It's now held by the AI-directed text check.
- bc-15 was a quoted-only back-charge. It's now held.
- ho-08 had a back-charge number written two ways. That now holds as an unaccounted reference.
- ho-04 used a USD form ("1,200 USD"). It's now parsed.

The original outputs are in `bench/results/`, with the commits they were scored at. Re-running at those commits reproduces them line for line.

**What we don't claim.** Zero wrong credits in general. Only first runs measure emails we hadn't tuned on.

## 10. The live inbox and the public "try it" panel

**Gmail.**
- OAuth with only `gmail.readonly` and `gmail.send` scopes.
- No app password, so no 2-step-verification requirement on the demo account.
- The Google app stays in Testing mode, so sign-ins expire after 7 days and `npm run gmail:auth` renews them.

**Live intake. Contra reads only mail that meets all of these:**
- delivered to the `+backcharges` address
- from an allow-listed sender
- passing Gmail's own DKIM or SPF check for that sender's domain

Live model calls have a daily cap. Memos go to a separate `+ramp-ap` address and carry a header, so Contra never reads its own memos back.

**Isolation.** Live mail goes to its own workspace and database. Nothing that arrives by email can change the scripted demo's numbers.

**Clocks.** The live workspace runs on real time plus an offset; "advance a week" adds to the offset. The demo runs on a simulated clock. No code in `src/` reads the clock; it's injected.

**Try any email (`POST /api/try`).**
- It saves nothing. A test breaks if it ever does.
- Limits: an hourly limit per IP and a global daily cap.
- The email text never appears in logs, errors or the database; a test checks this with a marker string.

**API gates.**
- Requests from origins not on the allow-list get 403.
- Every POST must be JSON, so another website can't trigger an action through a simple form or text post.

**Rejected.**
- A temp-mail service: less convincing to judges, and its mailboxes can be purged.
- An app password: it requires 2-step verification.

## 11. One writer, one contract

**Choice.**
- The API server is the only process that opens the databases.
- The UI is a client: it reads `GET /api/screens` (built by `buildScreens`) and sends every button as one `POST /api/action`.
- `runAction` is always async.
- Live updates come over Server-Sent Events, not polling.

**Why.** Two processes writing one SQLite file is a corruption risk. The gates and future logins have to sit in one place. An outside frontend (our teammate's) connects the same way, using `FRONTEND_CONTRACT.md`.

## 12. How we built it

**Sessions.**
- **Lead (`src/`, merges):** Claude Opus 5.5.
- **UI worktree:** Claude Sonnet 5.5.
- **Money review (planned, not done before the deadline):** a separate session that didn't write the code, running the `money-reviewer` agent.
- At most two builder sessions at once.

**Rules for the agents.**
- A human reviews every diff in `src/`.
- Protected files (INVARIANTS.md, the invariant and demo tests, benchmark labels) can't be edited by agents; a pre-commit hook blocks it.
- Done means `npm run check` passes and the bench runs.
- Every new rule comes with a test that was seen to fail when the rule was removed.
- Agents report the commands they actually ran.

**Tools we didn't use.** ECC and Paradev. Paradev has no Windows build, and two disciplined sessions were enough.

## 13. Known limits

- Ramp is simulated. No credit is created in a real Ramp account.
- Rate limits and caps are per process and reset on restart.
- Gmail sign-ins expire weekly while the Google app stays in Testing mode.
- Most benchmark cases were written by the team, and part of the answer key was AI-drafted before human review.
- No controller has used Contra yet. One working PM reviewed the idea and described their real back-charge process (DECISIONS §9).
- Both benchmark systems share the same extraction, so on the fresh set (where extraction failed) the baseline comparison says nothing.
