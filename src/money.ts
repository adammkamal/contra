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

/** The number of an amount: "1,200", "1200", "1,200.50". Thousands commas in groups of 3; cents optional, exactly 2 digits. */
const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?(?!\d)`;

/**
 * Each pattern is one currency marker with its number:
 * - "$" or "US$" before it: "$1,200", "$ 1,200.00", "US$1,200" (one amount, not "US" plus "$1,200")
 * - "USD" before it: "USD 1,200", "USD1,200.00"
 * - "USD" after it: "1,200 USD", "1,200.00USD" (not when the number is part of a word like "BC-1200")
 * Every marker counts as its own amount, so a number written with both "$" and "USD" ("$1,200 USD",
 * "USD $1,200") is two amounts: a sentence that mixes them is never read as exactly one.
 */
const AMOUNT_RES: readonly RegExp[] = [
  new RegExp(String.raw`(?:\bUS)?\$\s?${NUM}`, "gi"),
  new RegExp(String.raw`\bUSD\s?(?:\$\s?)?${NUM}`, "gi"),
  new RegExp(String.raw`(?<![\w.,-])${NUM}\s?USD\b`, "gi"),
];

/** Parses one USD amount ("$11,500", "$4,700.00", "USD 1,200", "1,200 USD", "US$1,200") using string math only (no floats). */
export function parseUsd(text: string): Cents {
  const all = findUsdAmounts(text);
  if (all.length !== 1) {
    throw new Error(`Expected exactly one USD amount, found ${all.length} in: ${text}`);
  }
  return all[0]!;
}

/** Every USD amount in the text ("$", "US$" or "USD" with a number; one per marker), in order. */
export function findUsdAmounts(text: string): Cents[] {
  const found: { at: number; amount: Cents }[] = [];
  for (const re of AMOUNT_RES) {
    for (const m of text.matchAll(re)) {
      const whole = m[1]!.replaceAll(",", "");
      const frac = m[2] ?? "00";
      found.push({ at: m.index, amount: cents(Number.parseInt(whole, 10) * 100 + Number.parseInt(frac, 10)) });
    }
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.amount);
}

export function formatUsd(c: Cents): string {
  const neg = c < 0;
  const abs = Math.abs(c);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  const frac = String(abs % 100).padStart(2, "0");
  return `${neg ? "-" : ""}$${whole}.${frac}`;
}
