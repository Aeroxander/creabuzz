/**
 * What a person types to pay part of the money set aside for a task (plan section 5.5): dollars and cents, from 1 dollar to
 * what is set aside. Pure.
 */
import { parseDollarAmount } from "../../../money/calls";
import { exactPhrase } from "./pay-words";

const DOLLAR = 1_000_000n;
const CENT = 10_000n;

/** The amount to pay, in dollar units, or the one sentence that says what is wrong with what was typed. */
export type PartPay =
  | { ok: true; raw: bigint }
  | { ok: false; sentence: string };

/** What is wrong with a typed part payment, or the amount: whole cents, at least 1 dollar and at most `max` (what is set aside). */
export function partPay(typed: string, max: bigint): PartPay {
  const least = max < DOLLAR ? max : DOLLAR;
  const parsed = parseDollarAmount(typed, 0n);
  if (!parsed.ok)
    return {
      ok: false,
      sentence:
        parsed.reason === "empty"
          ? "Type how much to pay."
          : "Use numbers only, like 12 or 12.50.",
    };
  if (parsed.raw % CENT !== 0n)
    return { ok: false, sentence: "Pay in dollars and cents, like 12.50." };
  if (parsed.raw < least || parsed.raw > max)
    return {
      ok: false,
      sentence: `Pay at least ${exactPhrase(least)} and at most ${exactPhrase(max)}.`,
    };
  return { ok: true, raw: parsed.raw };
}
