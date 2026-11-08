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

const AMOUNT_RE = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?(?!\d)/g;

/** Parses a USD amount like "$11,500" or "$4,700.00" using string math only (no floats). */
export function parseUsd(text: string): Cents {
  const all = findUsdAmounts(text);
  if (all.length !== 1) {
    throw new Error(`Expected exactly one USD amount, found ${all.length} in: ${text}`);
  }
  return all[0]!;
}

/** Every "$" amount in the text, in order. */
export function findUsdAmounts(text: string): Cents[] {
  const out: Cents[] = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const whole = m[1]!.replaceAll(",", "");
    const frac = m[2] ?? "00";
    out.push(cents(Number.parseInt(whole, 10) * 100 + Number.parseInt(frac, 10)));
  }
  return out;
}

export function formatUsd(c: Cents): string {
  const neg = c < 0;
  const abs = Math.abs(c);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  const frac = String(abs % 100).padStart(2, "0");
  return `${neg ? "-" : ""}$${whole}.${frac}`;
}
