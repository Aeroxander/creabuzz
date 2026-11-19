/**
 * What the money screens' tests share: the example record as parsed numbers for a project, the build's network named in the
 * environment, a table of what the chain answers for a backer, and the one-dollar helpers. Pairs with `pot-chain.ts` (the
 * wallet in the page) and `money-harness.tsx` (the mocked server and the render wrapper).
 */
import { vi } from "vitest";
import type { ProjectNumbers } from "../../src/features/money/numbers";
import {
  BACKER_EVM,
  FOUNDER_EVM,
  numbersV2Content,
  STRANGER_EVM,
} from "./numbers-v2-fixture";
import { COORDINATE, NOW, numbersV2Of } from "./money-harness";

export { BACKER_EVM, FOUNDER_EVM, STRANGER_EVM };

/** Raw dollar units in one dollar. */
export const D = 1_000_000n;
/** Raw Share units in one Share. */
export const S = 1_000_000_000_000_000_000n;

/** The example record, parsed, for the default project, shifted to `NOW`; `patch` changes the record's content first. */
export function numbersFor(
  patch?: (content: Record<string, unknown>) => void,
): ProjectNumbers {
  return numbersV2Of(
    numbersV2Content({ coordinate: COORDINATE, now: NOW, patch }),
  );
}

/** The build names the test network the example was made on (the chain and the Launcher), as a real build does. */
export function nameTheNetwork(numbers: ProjectNumbers): void {
  vi.stubEnv("VITE_CREATON_CHAIN_ID", String(numbers.chainId));
  vi.stubEnv("VITE_CREATON_LAUNCHER", numbers.launcher);
  vi.stubEnv("VITE_CREATON_DOLLAR", numbers.contracts.dollar);
}

/**
 * What the chain answers for a backer of `numbers`' project at 100 Shares a dollar, a 2% fee and an open door. A test spreads
 * its own entries over it. Shares and dollars are told apart by the contract a `balanceOf` is sent to.
 */
export function backerAnswers(
  numbers: ProjectNumbers,
  held: { dollars?: bigint; shares?: bigint; team?: bigint } = {},
) {
  const { dollar, shares, team } = numbers.contracts;
  return {
    doorOpenNow: [true],
    ratePpm: [1000n],
    feeFor: (args: readonly unknown[]) => [((args[0] as bigint) * 2n) / 100n],
    quoteBack: (args: readonly unknown[]) => {
      const amount = args[0] as bigint;
      // 100 Shares for each dollar; taking them out at once gives what was paid less the fee.
      return [(amount * 100n * S) / D, (amount * 98n) / 100n, 0n, 0n];
    },
    quoteTakeOut: (args: readonly unknown[]) => {
      const n = args[1] as bigint;
      // Each Share is worth 0.0098 dollars, so 100 Shares give 0.98: the rate of the quote above.
      return [(n * 9_800n) / S, 0n, 0n];
    },
    balanceOf: (_args: readonly unknown[], to: string) =>
      to === dollar
        ? [held.dollars ?? 1_000n * D]
        : to === shares
          ? [held.shares ?? 0n]
          : to === team
            ? [held.team ?? 0n]
            : [0n],
    faucetUsed: [false],
    FAUCET_AMOUNT: [1_000n * D],
  };
}

export { NOW };
