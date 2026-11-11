/** Integer cents. The brand stops plain numbers (e.g. dollars) from being passed as money. */
export type Cents = number & { readonly __brand: "Cents" };

export function cents(n: number): Cents {
  if (!Number.isSafeInteger(n)) throw new Error(`Cents must be a safe integer, got ${n}`);
  return n as Cents;
}

export const ZERO = cents(0);

export function add(a: Cents, b: Cents): Cents {
  return cents(a + b);
}

export function sub(a: Cents, b: Cents): Cents {
  return cents(a - b);
}

export function min(a: Cents, b: Cents): Cents {
  return a <= b ? a : b;
}

export function sum(xs: readonly Cents[]): Cents {
  return xs.reduce<Cents>((acc, x) => add(acc, x), ZERO);
}

/**
 * Everything that could be part of the number next to a currency marker: digits, commas and periods, and
 * a space (incl. no-break and thin spaces) followed by 3 digits, as in "1 200", but only straight after a
 * digit: "$1,200, 300 sq ft." is $1,200 followed by punctuation and a new number. It is read whole, so a
 * malformed number is never cut down to a shorter one that looks fine ("$1,200.5" is not "$1,200").
 */
const SP = String.raw`[ \u00A0\u202F\u2009]`;
const TOKEN = String.raw`(\.?\d(?:[\d.,]|(?<=\d)${SP}\d{3}(?!\d))*)`;

/** The only form read as money: "1,200", "1200", "1,200.50". Thousands commas in groups of 3; cents optional, exactly 2 digits. */
const EXACT = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?$/;

/**
 * Each pattern is one currency marker with its number:
 * - "$" or "US$" before it: "$1,200", "$ 1,200.00", "US$1,200" (one amount, not "US" plus "$1,200")
 * - "USD" before it: "USD 1,200", "USD1,200.00"
 * - "USD" after it: "1,200 USD", "1,200.00USD" (not when the number is part of a word like "BC-1200")
 * Every marker counts as its own amount, so a number written with both "$" and "USD" ("$1,200 USD",
 * "USD $1,200") is two amounts: a sentence that mixes them is never read as exactly one.
 */
const AMOUNT_RES: readonly RegExp[] = [
  new RegExp(String.raw`(?:\bUS)?\$\s?${TOKEN}`, "gi"),
  new RegExp(String.raw`\bUSD\s?(?:\$\s?)?${TOKEN}`, "gi"),
  new RegExp(String.raw`(?<![\w.,-]|\d${SP})${TOKEN}\s?USD\b`, "gi"),
];

/**
 * One amount as written next to its marker. `cents` is null when the number can't be read exactly:
 * one or more than two digits after the point ("$1,200.5", "$1,200.505"), a second point
 * ("$1,200.50.5"), a missing whole part ("$.50"), European or other grouping ("$1.200,50", "$1,20,000",
 * "$1 200"). Such an amount is never guessed or truncated; whoever reads it sends the item to a person.
 * A single trailing "." or "," is sentence punctuation ("USD 1,200." is $1,200.00).
 */
export interface UsdAmount {
  text: string;
  cents: Cents | null;
}

function read(token: string): Cents | null {
  const m = EXACT.exec(/[.,]$/.test(token) ? token.slice(0, -1) : token);
  if (!m) return null;
  return cents(Number.parseInt(m[1]!.replaceAll(",", ""), 10) * 100 + Number.parseInt(m[2] ?? "00", 10));
}

/**
 * A number followed by a multiplier the digits don't carry: a letter right after it ("$2k", "$1.5M",
 * "$3mm") or a word ("$2 thousand", "$1 million", "$5 grand"). Read as digits alone it would be a
 * thousandth of the amount meant, so such an amount is unreadable, never guessed.
 */
const MULTIPLIER = /^(?:[A-Za-z]|[    ]?(?:thousand|million|billion|grand)\b)/i;

/** Every amount in the text ("$", "US$" or "USD" with a number; one per marker), in order, readable or not. */
export function scanUsdAmounts(text: string): UsdAmount[] {
  const found: { at: number; amount: UsdAmount }[] = [];
  for (const re of AMOUNT_RES) {
    for (const m of text.matchAll(re)) {
      const after = text.slice(m.index + m[0].length);
      const multiplied = !/USD$/i.test(m[0]) && MULTIPLIER.exec(after);
      found.push({ at: m.index, amount: multiplied ? { text: m[0] + multiplied[0], cents: null } : { text: m[0], cents: read(m[1]!) } });
    }
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.amount);
}

/** The amounts written in the text that can't be read exactly (empty when every amount is readable). */
export function unreadableUsd(text: string): string[] {
  return scanUsdAmounts(text).filter((a) => a.cents === null).map((a) => a.text);
}

/** Parses one USD amount ("$11,500", "$4,700.00", "USD 1,200", "1,200 USD", "US$1,200") using string math only (no floats). */
export function parseUsd(text: string): Cents {
  const all = findUsdAmounts(text);
  if (all.length !== 1) {
    throw new Error(`Expected exactly one USD amount, found ${all.length} in: ${text}`);
  }
  return all[0]!;
}

/**
 * Every USD amount in the text, in order. Throws when any amount can't be read exactly (see UsdAmount):
 * callers that must not throw check `unreadableUsd` first.
 */
export function findUsdAmounts(text: string): Cents[] {
  const all = scanUsdAmounts(text);
  const bad = all.filter((a) => a.cents === null);
  if (bad.length) throw new Error(`Amount can't be read exactly: ${bad.map((a) => `"${a.text}"`).join(", ")}`);
  return all.map((a) => a.cents!);
}

export function formatUsd(c: Cents): string {
  const neg = c < 0;
  const abs = Math.abs(c);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  const frac = String(abs % 100).padStart(2, "0");
  return `${neg ? "-" : ""}$${whole}.${frac}`;
}
