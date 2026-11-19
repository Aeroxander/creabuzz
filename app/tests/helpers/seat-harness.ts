/**
 * What the seat screens' tests share: the example project run alone by the founder or by a pair of the founder and Anna, the
 * team the screens choose from, and a table of what the chain answers about the seat and any offer for it. Pairs with
 * `pot-chain.ts` (the wallet in the page).
 */
import type { ProjectNumbers } from "../../src/features/money/numbers";
import type { GrantMember } from "../../src/features/pot/GrantSheet";
import { BACKER_EVM, FOUNDER_EVM, numbersFor } from "./pot-harness";

export const ANNA = BACKER_EVM;
export const CARL_EVM = "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc";
/** The address a pair of the founder and Anna has (what the Launcher would say). */
export const PAIR_OF_ANNA = "0x00000000000000000000000000000000000000a1";
/** The pair that already runs the project in `pairNumbers`. */
export const RUNNING_PAIR = "0x00000000000000000000000000000000000000a9";
export const ZERO = "0x0000000000000000000000000000000000000000";

export const aloneNumbers = (): ProjectNumbers => numbersFor();
export const pairNumbers = (): ProjectNumbers => {
  const base = numbersFor();
  return {
    ...base,
    runner: {
      address: RUNNING_PAIR,
      isPair: true,
      signers: [FOUNDER_EVM, ANNA],
    },
    contracts: { ...base.contracts, pair: RUNNING_PAIR },
  };
};

export const MEMBERS: GrantMember[] = [
  { pubkey: "a".repeat(64), name: "Fred", address: FOUNDER_EVM },
  { pubkey: "d".repeat(64), name: "Anna", address: ANNA },
  { pubkey: "c".repeat(64), name: "Carl", address: null },
  { pubkey: "e".repeat(64), name: "Dora", address: CARL_EVM },
];
const NAMES: Record<string, string> = {
  [FOUNDER_EVM]: "Fred",
  [ANNA]: "Anna",
  [CARL_EVM]: "Dora",
};
export const nameOf = (address: string) =>
  NAMES[address.toLowerCase()] ?? `${address.slice(0, 6)}…${address.slice(-4)}`;

export interface SeatChain {
  runner?: string;
  /** Who the seat is offered to (zero or none: no offer). */
  offeredTo?: string;
  /** Seconds before `now` the offer was made. */
  madeAgo?: number;
  leaves?: boolean;
  windDownKind?: number;
  unit?: number;
}

/** What the Treasury and the Launcher answer about the seat, as of `now`. */
export function seatAnswers(
  numbers: ProjectNumbers,
  now: number,
  seat: SeatChain = {},
) {
  return {
    runner: [seat.runner ?? numbers.runner.address],
    founder: [FOUNDER_EVM],
    pendingRunner: [seat.offeredTo ?? ZERO],
    pendingSeatAt: [BigInt(seat.offeredTo ? now - (seat.madeAgo ?? 100) : 0)],
    pendingTrim: [seat.leaves ?? false],
    SEAT_OFFER_MULT: [2n],
    unit: [BigInt(seat.unit ?? 1680)],
    windDownKind: [BigInt(seat.windDownKind ?? 0)],
    // The pair of the runner and Anna is `PAIR_OF_ANNA`; any other pair is its own address.
    pairAddress: (args: readonly unknown[]) => [
      args[2] === ANNA
        ? PAIR_OF_ANNA
        : `0x00000000000000000000000000000000000000${String(args[2]).slice(-2)}`,
    ],
  };
}
