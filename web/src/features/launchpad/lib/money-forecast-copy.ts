/** The words of money forecasts (N8). Pure, so `money-forecast-copy.test.mjs` pins it. */

import type { PoolOutcome } from "./forecast-pool.ts";

/** How much is on each side. */
export function poolsLine(
  yes: bigint,
  no: bigint,
  money: (units: bigint) => string,
): string {
  if (yes === 0n && no === 0n) return "No money on it yet.";
  return `${money(yes)} says it will be paid · ${money(no)} says it won't.`;
}

/** How a settled pool ended. */
export function outcomeLine(outcome: PoolOutcome): string | null {
  switch (outcome) {
    case "yes":
      return "It was paid. Those who said so share the other side's money.";
    case "no":
      return "It wasn't paid. Those who said so share the other side's money.";
    case "void":
      return "Nobody was right, so everyone takes back what they put in.";
    case "open":
      return null;
  }
}
