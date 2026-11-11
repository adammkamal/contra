# Attachment cases (not scored yet)

Six PM emails whose back-charge information is in an attachment. They are **not** part of `npm run bench`
and have no scoring yet: the answers in `proposed-labels/` were drafted by Claude and wait for a person to
review them. Once reviewed, they become human-written labels, and the harness can learn to read these cases.

- `cases/<id>.eml`: the email, with its attachments, as Gmail would deliver it. `cases/<id>.json` is
  `{ id, description, eml }`. No answers in either.
- `proposed-labels/<id>.json`: the same shape as `bench/labels/` (`link`, `disputed`, `amountCents`,
  `labeledBy`), plus two proposal-only fields: `expectedHold` (the ingest hold a careful person would want,
  or null) and `why`. A held case's `link` is `"review"`: a hold isn't a link.
- Everything is made up and generated: `npx tsx scripts/make-attachment-cases.ts` rewrites `cases/`
  byte for byte (PDFs with pdf-lib at fixed dates, photos drawn with a pixel font).

| Case | Attachment | What it tests |
|---|---|---|
| ba-01 | PDF read as text | the amount is only on page 2; it verifies against that page and links |
| ba-02 | PDF read as text | the body and the PDF give different amounts: conflicting_amounts |
| ba-03 | PDF read as text | text aimed at an AI inside the PDF: suspicious_instructions |
| ba-04 | photo (PNG) | the amount is only in the photo: amount_only_in_image |
| ba-05 | scanned PDF, no text layer | the amount is only in the scan: amount_only_in_image |
| ba-06 | PDF read as text | the charge is in the body; the PDF records the sub's dispute |
