# Benchmark

`npm run bench` compares Contra with a baseline field matcher on the same recorded extractions.

```powershell
npm run bench:record              # live extractor, 3 runs per case (uses .env.local)
npm run bench:record -- --runs 5
npm run bench                     # scores the recordings against bench/labels/
npm run bench:record -- --set heldout
npm run bench -- --set heldout    # held-out set; the default set is main
```

Without recordings, `npm run bench` exits with "run npm run bench:record first". With recordings but
without a label for every case, it exits listing the unlabeled cases.

- `cases/` — one JSON per case: `{ id, description, email }`, and `email.id` equals the case id. No
  extractor output and nothing about the expected answer (test/bench-cases.test.ts enforces it).
- `../fixtures/bench-extractions/<caseId>/run-<n>.json` — what the live extractor returned for that
  case: `{ model, effort, recordedAt, items, rejected, rawToolInput }`, plus `error` when the call failed.
  `rawToolInput` is the model's output before validation; `npm run bench` re-runs the current validator
  (`parseBackCharges`) on it, so validator changes are measured without new model calls. `items` and
  `rejected` are what the validator returned at recording time, and are used only for older recordings
  that have no `rawToolInput`. `bench:record` replaces a case's runs on each recording. The demo's
  `fixtures/extractions/` is never read.
- `labels/` — **protected, human-written only.** One JSON per case: `link` (a subcontract ID, or
  `"review"` if a careful person would not auto-link), `disputed`, `amountCents`, `labeledBy` (your name).
  The run prints **NOT VALID FOR THE DEMO** while any label for a current case isn't human-written.

Scoring is per run. A run with exactly one accepted item is scored on that item. A run with 0 accepted
items, or more than 1, counts as "review" for both systems (the item count is shown). A failed call is
reported and not scored. A case is **stable** if each system's outcome is the same in every run; the run
lists the unstable cases.

Both systems get the same extraction. The baseline honors the extraction's `disputeNoted` (no credit when
set), so the comparison isolates matching. Columns, per system and per run:

- **matching** — linked to the labeled subcontract, or not linked when the label says review.
- **dispute** — when the system links, it credits exactly when the label says not disputed. A run that
  doesn't link has no credit decision to get wrong.
- **wrong links**, **wrong credits** (would credit something a careful human wouldn't: wrong party,
  disputed, or wrong amount) and **routed to human**. Report wrong credits together with the
  routed-to-human count: "0 wrong credits" means nothing if everything was routed to a human.

## Held-out set

`bench/heldout/` holds a second set of cases (`cases/`, ho-01 ...) with its own protected, human-written
`labels/`. It is recorded and scored only with `--set heldout`, and its numbers are never merged into the
main benchmark's: recordings go to `fixtures/bench-extractions/heldout/<caseId>/`, results to
`bench/heldout/results.json`.

## Fresh set

`bench/fresh/` holds a third set (`cases/`, fh-01 ...), written by someone outside the team, with its own
protected, human-written `labels/`. Run it with `--set fresh`. Recordings go to
`fixtures/bench-extractions/fresh/<caseId>/` and results to `bench/fresh/results.json`, never merged with
the other sets' numbers. Its labels can also use the items form (several charges per email, charges
without a BC number); see `bench/fresh/LABEL-FORMAT.md`. Labels in the single-item form are scored exactly
as in the other sets.

## Labels: "none"

A label's `link` may also be `"none"` (the email holds no back-charge), with `amountCents: null`. Such a run
is correct only if no item is accepted. An accepted item that would be credited counts as a wrong credit;
any other accepted outcome is routed to a person and is not correct.
