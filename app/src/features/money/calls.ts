/**
 * The shape of one call for a sender, and the reading of a typed amount. The builders are
 * `@creaton/core/pot/pot-calls.ts` (from the generated ABIs of `contracts/pot`); their calls have this shape.
 */
import { DOLLAR } from "./numbers";

/** One call for the wallet: always carries a zero native value. */
export interface MoneyCall {
  to: string;
  data: string;
  value: "0x0";
}

/**
 * Dollars typed by a person as raw units, or why not: digits with at most one dot and at most 6 decimals ("1,000" with
 * proper thousands marks and a leading "$" are allowed; a comma anywhere else is refused), and at least `min` (the project's smallest Back, `numbers.limits.minJoin`: never typed
 * into a screen). No upper limit here: the chain refuses what it cannot take, and says why in words.
 */
export function parseDollarAmount(
  text: string,
  min: bigint,
):
  | { ok: true; raw: bigint }
  | { ok: false; reason: "empty" | "format" | "small" } {
  const typed = text.trim().replace(/^\$/, "");
  // A comma is only ever a thousands mark ("1,000.50"): "10,5" is not 105 dollars, it is not an amount.
  if (typed.includes(",") && !/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(typed))
    return { ok: false, reason: "format" };
  const cleaned = typed.replace(/,/g, "");
  if (cleaned === "") return { ok: false, reason: "empty" };
  const match = /^(\d{1,12})(?:\.(\d{0,6}))?$/.exec(cleaned);
  if (!match) return { ok: false, reason: "format" };
  const raw =
    BigInt(match[1]) * DOLLAR + BigInt((match[2] ?? "").padEnd(6, "0") || "0");
  if (raw < min) return { ok: false, reason: "small" };
  return { ok: true, raw };
}
