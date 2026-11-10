import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBackCharges } from "../src/extract/validate.ts";
import { findUsdAmounts, parseUsd } from "../src/money.ts";
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
