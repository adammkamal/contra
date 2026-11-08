# Benchmark

`npm run bench` compares Contra with a baseline field matcher on the same extractions.
`npm run bench -- --live` uses `fixtures/extractions/<emailId>.json` from the real extractor where present.

- `cases/` — one JSON per case: the email and the extractor output. An agent may draft these from your
  one-line descriptions.
- `labels/` — **protected, human-written only.** One JSON per case: `link` (a subcontract ID, or
  `"review"` if a careful person would not auto-link), `disputed`, `amountCents`, `labeledBy` (your name).
  The 4 example labels are marked `claude-example`. Confirm or rewrite them; the run prints
  **NOT VALID FOR THE DEMO** while any label isn't human-written.

Metrics, per system: correct, wrong links, **wrong credits** (would credit something a careful human
wouldn't), and cases routed to a human. Report wrong credits together with the routed-to-human count:
"0 wrong credits" means nothing if everything was routed to a human.

Aim for 15–20 cases. Cover: aliases and trade names, factoring and lockboxes, ambiguous short names,
the same party with two subcontracts on one job, disputes in source, wrong job references, amounts
inside tables or with several $ figures in one sentence, and forwarded threads.
