# Fresh set: label format

`bench/fresh/labels/<caseId>.json`, one per case in `bench/fresh/cases/`. **Protected, human-written
only** (the pre-commit hook rejects them unless `CONTRA_HUMAN=1`). `labeledBy` is your name; the run prints
NOT VALID FOR THE DEMO while any label is missing a human `labeledBy`.

The examples below use a made-up case `fh-99` and made-up amounts. They are not labels for fh-01 ... fh-08.
Subcontract IDs are the seed's (`src/seed.ts`): `SC-SUM-0912` Ridgeline Interiors (Summit), `SC-SUM-0820`
Ridgeline Glass & Glazing (Summit), `SC-SUM-0700` Harbor Mechanical (Summit), `SC-LAK-0301` Ridgeline
Interiors (Lakeview).

Amounts are whole cents (`61200` is $612.00). `disputed` is true when the email says the charge is
contested or on hold.

## Two forms

**Single-item form** (the same as `bench/labels/` and `bench/heldout/labels/`, scored exactly as there):
`link`, `disputed`, `amountCents` at the top level. A run is scored only if the extractor accepted exactly
one item; several accepted items count as "review" for both systems. 0 accepted items count as **routed
to a person** (not correct) if validation refused at least one item from the email, since each refused item
is a "not taken in" Inbox row asking a person to read the email; otherwise as **missed** (nobody sees the
charge: not correct, not routed to a person). Only refused items count, not a row saying the email holds no
back-charge.

**Items form**: an `items` list, one entry per back-charge in the email, and no top-level `link`,
`disputed` or `amountCents`. Every accepted item of a run is decided (as ingest would, with all the run's
refs) and paired with a labeled item:

1. an item with a `ref` pairs with the accepted item of that BC number;
2. an item without a `ref` pairs with an accepted item of exactly its amount; if several have that
   amount, the one the system linked to the item's subcontract, else the first in extraction order.

Each pair is scored like a single-item label. A labeled item that pairs with nothing was not extracted. It
counts as **routed to a person** (not correct) if the run refused at least one item from the email (a "not
taken in" row sends a person to the email), and otherwise as **missed**: in the product nobody sees it, so it
is neither correct nor routed to a person. An accepted item that pairs with nothing counts as against
`"none"`: never correct; crediting it is a wrong credit, linking it is a wrong link. The case is
**matching** only if every labeled item matches and nothing is left over. **wrong link**, **wrong
credit**, **routed to human** and **missed** are counted if any item has one.

`npm run bench -- --set fresh` refuses an items label with no items, a `link` of `"none"` inside `items`,
a non-whole or non-positive `amountCents`, a `ref` that is not a BC number, or the same ref twice.

## One charge, linked

```json
{ "id": "fh-99", "labeledBy": "your-name", "link": "SC-SUM-0912", "disputed": false, "amountCents": 61200 }
```

## One charge a careful person would not auto-link: `"review"`

```json
{ "id": "fh-99", "labeledBy": "your-name", "link": "review", "disputed": false, "amountCents": 61200 }
```

`"review"` also works inside `items`, for one charge among several.

## No back-charge in the email: `"none"`

```json
{ "id": "fh-99", "labeledBy": "your-name", "link": "none", "disputed": false, "amountCents": null }
```

Correct only if the extractor accepts no item.

## Several charges, no BC numbers (matched by amount, then subcontract)

```json
{
  "id": "fh-99",
  "labeledBy": "your-name",
  "items": [
    { "link": "SC-SUM-0912", "disputed": false, "amountCents": 24000 },
    { "link": "SC-SUM-0700", "disputed": true, "amountCents": 187500 }
  ]
}
```

## A charge with a BC number (matched by ref)

```json
{
  "id": "fh-99",
  "labeledBy": "your-name",
  "items": [
    { "ref": "BC-9901", "link": "SC-LAK-0301", "disputed": false, "amountCents": 61200 }
  ]
}
```

An items label may mix entries with and without `ref`. A single charge with no BC number can use either
form. The items form also scores runs where the extractor accepted extra items, instead of sending them
all to review.
