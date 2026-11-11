# Contra

[![CI](https://github.com/adammkamal/contra/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/adammkamal/contra/actions/workflows/ci.yml)

**Back-charges that actually come off the sub's next bill.** A feature concept for Ramp Bill Pay / Ramp for Construction.

On a construction job, a PM emails "BC-4468: Ridgeline left drywall debris on level 2, cleanup $4,700." Then the email gets buried, and the general contractor pays the sub's next bill in full. Contra:
1. reads those emails
2. links each charge to the right subcontract and clause
3. checks eligibility in code
4. drafts the notice to the sub, which a PM approves
5. waits out the sub's response window
6. produces a credit, which a controller approves, so the charge comes off the next bill



## Try it

Contra runs locally (see Quickstart). It isn't deployed.

- **Scripted demo:** four back-charges, one held because the PM's email notes a dispute and one disputed by the sub. Notice **$15,500**, credit **$11,500**, bill $48,000 paid as **$36,500**.
- **Live inbox:** email `…+backcharges@…` from an allowed address, and watch it arrive, get checked and wait for a person.
- **Try any email:** paste any email and see what Contra would do, with the evidence. Nothing is saved.

## What's real and what's simulated

| Real | Simulated (and labeled as such on screen) |
|---|---|
| Model extraction (Claude Opus 5.5), with recorded fixtures for offline runs | Ramp: there's no public create-credit API, so `MockRamp` implements only documented behavior ("Simulated Ramp" badge) |
| Gmail inbox reading and memo sending (OAuth) | The ERP sync |
| Eligibility, linking and money, all in deterministic code | The opener's history ("Sample data" badge) |
| Append-only audit log, approvals, state machines | |

See [INTEGRATION.md](INTEGRATION.md) for how this maps onto Ramp for real.

## Quickstart

Requires Node 22.13+ (it uses `node:sqlite`). CI checks a fresh install on Linux, macOS and Windows on every push.

```bash
git clone https://github.com/adammkamal/contra
cd contra
npm ci
npm run user:add -- presenter ap   # prompts for a password of 12+ characters, typed twice; this account runs the scripted demo
npm run check        # typecheck and all tests, no API key needed
npm run api          # API on http://127.0.0.1:4100, using recorded extractions
# in a second terminal:
npm run dev     # UI on http://localhost:3000 (use localhost, not 127.0.0.1)
```

Then sign in at http://localhost:3000/login. PM, controller and AP accounts made with `--live` are only needed for the live Gmail workspace.

**Optional live features.** Put these in `.env.local` (copy `.env.example`):
- `CONTRA_ANTHROPIC_API_KEY`, for live extraction and the try panel
- `CONTRA_INBOX=gmail` and `CONTRA_INTAKE_ALLOWED_SENDERS`, then run `npm run gmail:auth`, for the live inbox

On Windows, edit `.env.local` in Notepad. A PowerShell redirect saves it as UTF-16, which won't load.

## Useful commands

| Command | What it does |
|---|---|
| `npm run check` | Typecheck and the full test suite |
| `npm run bench` / `npm run bench -- --set heldout` | Score Contra and the baseline on the benchmark |
| `npm run extract:live` | 5 live extraction runs; every one must pass before fixtures are re-recorded |
| `npm run try:live <file>` | Run the try-any-email check on a file |
| `npm run gmail:auth` / `npm run inbox:check` | Connect Gmail / list what would be ingested, without ingesting |
| `npm run contract:samples` | Regenerate the frontend contract samples |

## Results

On our held-out set, measured once before any fixes: **6/8 correct, 1 wrong credit, 1 missed**. The baseline field matcher scored 4/8 with 3 wrong credits.

On 8 emails written by someone outside the team, Contra got **1/8** on its first run: none had a BC number, and Contra skipped every charge without one. A working PM then confirmed that first emails usually have no number, so we changed the design. The full numbers, including that failure, are in [DECISIONS.md §9](DECISIONS.md#9-the-benchmark-reported-honestly).

After the BC-number fix (each set re-recorded, 3 runs per case, every run the same for Contra):

| Set | Contra correct | Contra wrong credits | Contra missed | Baseline correct | Baseline wrong credits |
|---|---|---|---|---|---|
| Main | 19/20 | 0 | 0 | 13/20 | 6 |
| Held-out (no longer held-out) | 8/8 | 0 | 0 | 5/8 | 3 |
| Fresh (**no longer held-out**; its held-out first run stays 1/8) | 5/8 | 0 | 0 | 6–7/8 | 0–1 |

On the fresh set the 3 cases Contra doesn't get right all go to a person, none is credited: a charge stated only in forwarded mail (held), a misspelled sub name (sent to the PM to choose), and an amount written only in words (not taken in). Main and held-out are unchanged by the fix, row for row.

A second independent set (fh-09..16), written to the PM's description and including a follow-up email that cites a BC number for a charge first reported without one, was run once after the fix: Contra 6/8 correct, 0 wrong credits, 0 missed, and it held the duplicate for the PM in all 3 runs. The baseline also scored 6/8 but charged the duplicate twice (1 wrong credit per run). Scored on branch `fresh2` at 740d6d9.

## Status at submission

- **On `main`:** everything above, including roles (the PM approves notices, the controller approves credits, AP turns credits on; nobody approves a credit on a charge they raised or linked).
- **Sign-in:** sign-in, roles and the login page are on `main`. Known limit: sign-in attempts are limited per network address, and sign-ins arrive through the UI server, so a deployed copy would need the UI to pass on the client's address (not done).
- **Merged: the BC-number fix.** Back-charge emails with no BC number, which our independent test showed Contra missed, are taken in with a Contra reference; a later email citing a BC number for the same charge is held as a possible duplicate for the PM; estimates are marked; every email from an allowed sender leaves a visible row (see Results).
- **Not done:** a deployed copy, and the independent money review.

## Docs

- [DECISIONS.md](DECISIONS.md): why it's built this way
- [SPEC.md](SPEC.md): what it does, the demo script, the Ramp facts
- [INVARIANTS.md](INVARIANTS.md): the rules, each with a test
- [INTEGRATION.md](INTEGRATION.md): the real Ramp integration path
- [FRONTEND_CONTRACT.md](FRONTEND_CONTRACT.md): the API the UI uses
- [AGENTS.md](AGENTS.md) and [CLAUDE.md](CLAUDE.md): how the code is laid out and how we built it with agents
