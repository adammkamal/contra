import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBackCharges } from "../src/extract/validate.ts";
import { cents, findUsdAmounts, parseUsd, scanUsdAmounts, unreadableUsd } from "../src/money.ts";
import { verifyAmountEvidence } from "../src/span.ts";
import type { Email } from "../src/types.ts";

// Amounts and emails here are written for these tests only.

test("money: USD-written amounts parse to exact cents", () => {
  const cases: [string, number][] = [
    ["USD 2,315", 231_500],
    ["USD 2,315.40", 231_540],
    ["USD2,315.40", 231_540],
    ["4,080 USD", 408_000],
    ["4,080.75 USD", 408_075],
    ["US$3,615", 361_500],
    ["US$3,615.25", 361_525],
    ["usd 87", 8_700],
  ];
  for (const [text, want] of cases) {
    assert.deepEqual(findUsdAmounts(text), [want], text);
    assert.equal(parseUsd(`BC-7414: patch and paint, ${text}.`), want, text);
  }
});

test("money: 'US$' is one amount, and a BC number before 'USD' is not an amount", () => {
  assert.equal(findUsdAmounts("BC-7414: stair nosing, US$3,615.").length, 1);
  assert.deepEqual(findUsdAmounts("BC-7414 USD 615"), [61_500]);
  assert.deepEqual(findUsdAmounts("BC 7414: USD 615.00"), [61_500]);
});

test("money: 'USD' plus '$' in one sentence is still two amounts", () => {
  assert.deepEqual(findUsdAmounts("BC-7414: USD 2,315 for labor and $40.00 for disposal."), [231_500, 4_000]);
  assert.deepEqual(findUsdAmounts("BC-7414: $40.00 disposal, 4,080 USD labor."), [4_000, 408_000]);
  // One number with both markers counts once per marker, so it is never read as exactly one amount.
  assert.equal(findUsdAmounts("BC-7414: $2,315 USD.").length, 2);
  assert.equal(findUsdAmounts("BC-7414: USD $2,315.").length, 2);
  assert.throws(() => parseUsd("BC-7414: USD 2,315 for labor and $40.00 for disposal."), /exactly one/);
});

const LARKSPUR: Email = {
  id: "T-M1",
  from: "Gemma Osei <gemma@fenwickbuilders.example>",
  to: "Larkspur Masonry <office@larkspurmasonry.example>",
  subject: "Fenwick Yard - back-charge, chipped coping",
  receivedAt: new Date("2026-10-12T15:00:00Z"),
  body: "Hi,\n\nYour crew chipped the parapet coping on the east wall.\n\nBC-7414: replace coping stones, USD 2,315.40.\n\nGemma",
};

const raw = (amountText: string, amountSentence: string) => ({
  ref: "BC-7414",
  description: "Replace chipped coping stones",
  amountText,
  amountSentence,
  vendorNameAsWritten: "Larkspur Masonry",
  jobRef: "Fenwick Yard",
  disputeNoted: false,
});

test("validator: a USD-written amountText is accepted as exactly one amount, and the span check agrees", () => {
  const sentence = "BC-7414: replace coping stones, USD 2,315.40.";
  const out = parseBackCharges({ items: [raw("USD 2,315.40", sentence)] }, LARKSPUR);
  assert.deepEqual(out.rejected, []);
  assert.equal(out.items[0]!.amountCents, 231_540);
  assert.ok(verifyAmountEvidence(LARKSPUR, out.items[0]!.amountEvidence, out.items[0]!.amountCents).ok);
});

test("validator: USD and $ together are rejected, and amountText must still be inside the sentence", () => {
  const two = { ...LARKSPUR, body: "BC-7414: USD 2,315.40 for stones and $40.00 for disposal." };
  const mixed = parseBackCharges({ items: [raw("USD 2,315.40 for stones and $40.00", two.body)] }, two);
  assert.equal(mixed.items.length, 0);
  assert.match(mixed.rejected[0]!.reason, /not exactly one/);

  const outside = parseBackCharges({ items: [raw("2,315.40 USD", "BC-7414: replace coping stones, USD 2,315.40.")] }, LARKSPUR);
  assert.equal(outside.items.length, 0);
  assert.match(outside.rejected[0]!.reason, /not inside amountSentence/);
});

// Amounts that can't be read exactly are rejected, never truncated or guessed (option (a): the item goes
// to a person). Only two-digit cents are cents; a trailing "." or "," on its own is sentence punctuation.
const UNREADABLE = [
  "$1,200.5", // one digit after the point: tenths or a dropped digit? Not guessed.
  "$1,200.505", // three digits after the point
  "$1,200.50.5", // a trailing ".digit" after the cents
  "$1,200..", // two trailing points
  "$.50", // no whole part
  "$1.200,50", // European separators
  "$1,20,000", // groups that aren't 3 digits
  "$1 200", // space-grouped thousands
  "USD 1,200.5",
  "1,200.5 USD",
  "1 200 USD",
  "US$1,200.5",
];

test("money: '$2k', '$1.5M' or '$2 thousand' is unreadable, never read as $2.00", () => {
  for (const text of ["$2k", "$2K", "$1.5M", "$3mm", "$2 thousand", "$1 million", "$5 grand", "USD 1,200k", "~$2k"]) {
    const sentence = `Cleanup will be roughly ${text} for Ridgeline Drywall.`;
    assert.deepEqual(scanUsdAmounts(sentence).map((a) => a.cents), [null], text);
    assert.throws(() => findUsdAmounts(sentence), /can't be read exactly/, text);
  }
  const email: Email = { id: "K-1", from: "pm@x.example", to: "sub@x.example", subject: "Summit", receivedAt: new Date(0), body: "Cleanup will be roughly $2k for Ridgeline Drywall." };
  const out = parseBackCharges({ items: [{ ref: null, description: "Cleanup", amountText: "$2", amountSentence: "Cleanup will be roughly $2k for Ridgeline Drywall.", vendorNameAsWritten: "Ridgeline Drywall", jobRef: "Summit", disputeNoted: false }] }, email);
  assert.equal(out.items.length, 0);
  assert.match(out.rejected[0]!.reason, /amount can't be read exactly: "\$2k"/);
  // A word after the amount that isn't a multiplier changes nothing.
  for (const [text, c] of [["$300 each", 30_000], ["$500-ish", 50_000], ["$500 or so", 50_000], ["~$475", 47_500], ["$1,200.", 120_000]] as const) {
    assert.deepEqual(findUsdAmounts(text), [c], text);
  }
});

test("money: an amount that can't be read exactly is unreadable, never a shorter amount", () => {
  for (const text of UNREADABLE) {
    const sentence = `BC-7414: patch and paint, ${text} for the east wall.`;
    assert.deepEqual(scanUsdAmounts(sentence).map((a) => a.cents), [null], text);
    assert.deepEqual(unreadableUsd(sentence).length, 1, text);
    assert.throws(() => findUsdAmounts(sentence), /can't be read exactly/, text);
    assert.throws(() => parseUsd(sentence), /can't be read exactly/, text);
  }
});

test("money: a sentence-ending point or comma is punctuation, and the amount is exact", () => {
  assert.equal(parseUsd("BC-7414: patch and paint, $1,200."), 120_000);
  assert.equal(parseUsd("BC-7414: patch and paint, USD 1,200."), 120_000);
  assert.equal(parseUsd("BC-7414: patch and paint, $1,200.50."), 120_050);
  assert.equal(parseUsd("BC-7414: $1,200.50, billed to you."), 120_050);
  assert.equal(parseUsd("BC-7414: $1,200 for 300 sq ft."), 120_000);
});

test("money: punctuation, a space and 3 digits after an amount start a new number, not a digit group", () => {
  assert.equal(parseUsd("BC-7414: $1,200, 300 sq ft."), 120_000);
  assert.equal(parseUsd("BC-7414: $1,200. 300 units were affected."), 120_000);
  // Space grouping straight after a digit is still unreadable, never read as $1.00 or $200.00.
  for (const text of ["BC-7414: $1 200 for the east wall.", "BC-7414: 1 200 USD for the east wall."]) {
    assert.deepEqual(scanUsdAmounts(text).map((a) => a.cents), [null], text);
    assert.throws(() => parseUsd(text), /can't be read exactly/, text);
  }
});

test("money: an unreadable amount next to a readable one is never read as exactly one", () => {
  const s = "BC-7414: $1,200.5 labor, $40.00 disposal.";
  assert.deepEqual(scanUsdAmounts(s).map((a) => a.cents), [null, 4_000]);
  assert.throws(() => parseUsd(s), /can't be read exactly/);
});

test("validator: an unreadable amount is rejected with a reason, in amountText or anywhere in its sentence", () => {
  for (const text of UNREADABLE) {
    const sentence = `BC-7414: replace coping stones, ${text}.`;
    const email = { ...LARKSPUR, body: `Hi,

${sentence}

Gemma` };
    const out = parseBackCharges({ items: [raw(text, sentence)] }, email);
    assert.equal(out.items.length, 0, text);
    assert.match(out.rejected[0]!.reason, /can't be read exactly/, text);
  }
  // The model copies only the readable-looking prefix: "$1,200" is inside "$1,200.5" but must not pass.
  const sentence = "BC-7414: replace coping stones, $1,200.5.";
  const clipped = parseBackCharges({ items: [raw("$1,200", sentence)] }, { ...LARKSPUR, body: sentence });
  assert.equal(clipped.items.length, 0);
  assert.match(clipped.rejected[0]!.reason, /can't be read exactly: "\$1,200\.5\."/);
});

test("span: evidence with an unreadable amount fails the amount check instead of matching a shorter amount", () => {
  const sentence = "BC-7414: replace coping stones, $1,200.5.";
  const r = verifyAmountEvidence({ ...LARKSPUR, body: sentence }, { emailId: LARKSPUR.id, sentence }, cents(120_000));
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /can't be read exactly/);
});
