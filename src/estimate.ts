import { normalize } from "./span.ts";

/**
 * Wording that makes an amount an estimate. A first back-charge email often gives one ("approximately
 * $6,000", "~$475", "estimated at $1,200"), and the follow-up gives the final amount. Pure: read from the
 * amount's own source sentence, which validation already limits to exactly one amount, so wording in it is
 * about that amount. Marking is never a hold: the notice and the credit approval show it. A different final
 * amount for the same charge is caught by the conflicting-amounts hold, not here.
 *
 * Each pattern is matched case-insensitively on the normalized sentence:
 * - any form of "estimate" ("estimated", "estimate", "est. $"), "approx" ("approx.", "approximately"),
 *   "ballpark", "preliminary", "rough figure/number/cost", "give or take", "in the neighborhood of";
 * - "about", "around", "roughly", "circa", "ca.", "nearly", "almost", "some" or "~" right before the "$";
 * - "or so" or "-ish" right after the amount.
 */
const ESTIMATE: readonly RegExp[] = [
  /\bestimat\w*/i,
  /\best\.(?=\s*\$)/i,
  /\bapprox(?:imately|imate|\.)?/i,
  /\bballpark\b/i,
  /\bpreliminary\b/i,
  /\brough (?:figure|number|cost|amount)\b/i,
  /\bgive or take\b/i,
  /\bin the neighbou?rhood of\b/i,
  /(?:\b(?:about|around|roughly|circa|nearly|almost|some)|\bca\.|~)(?=\s*\$)/i,
  /(?<=\$[\d,.]+)\s*(?:or so\b|-?ish\b)/i,
];

/** The wording in `sentence` that makes its amount an estimate ("approximately", "~"), or null when there is none. */
export function estimateWording(sentence: string): string | null {
  const s = normalize(sentence);
  let first: { at: number; text: string } | null = null;
  for (const re of ESTIMATE) {
    const m = re.exec(s);
    if (m && (!first || m.index < first.at)) first = { at: m.index, text: m[0].trim() };
  }
  return first?.text ?? null;
}
