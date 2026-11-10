# Benchmark

`npm run bench` compares Contra with a baseline field matcher on the same recorded extractions.

```powershell
npm run bench:record              # live extractor, 3 runs per case (uses .env.local)
npm run bench:record -- --runs 5
npm run bench                     # scores the recordings against bench/labels/
```

Without recordings, `npm run bench` exits with "run npm run bench:record first". With recordings but
without a label for every case, it exits listing the unlabeled cases.

- `cases/` — one JSON per case: `{ id, description, email }`, and `email.id` equals the case id. No
  extractor output and nothing about the expected answer (test/bench-cases.test.ts enforces it).
- `../fixtures/bench-extractions/<caseId>/run-<n>.json` — what the live extractor returned for that
  case: `{ model, effort, recordedAt, items, rejected }`, plus `error` when the call failed.
  `bench:record` replaces a case's runs on each recording. The demo's `fixtures/extractions/` is never read.
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
