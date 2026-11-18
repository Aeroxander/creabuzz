/**
 * The chain calls behind the money buttons, built as plain data (to, data) for the person's wallet to send. Pure: the
 * calldata is pinned in `calls.test.ts` against `cast calldata`. Built with the shared hand-rolled ABI encoder
 * (`@creaton/core/launchpad/evmAbi.ts`), so no contract library lands in the app.
 */
import {
  encodeFunctionData,
  SIGNATURE_ERC20_APPROVE,
} from "@creaton/core/launchpad/evmAbi.ts";
import { DOLLAR } from "./numbers";

/** One call for the wallet: always carries a zero native value. */
export interface MoneyCall {
  to: string;
  data: string;
  value: "0x0";
}

/** The smallest ask a round takes: 1 dollar (`Rounds.MIN_ASK`). */
const MIN_ASK = DOLLAR;

/**
 * The default price of a backing round, the same for every project and typed by nobody: exactly 3e15 raw Shares a raw
 * dollar (1 dollar buys 3,000 Shares; `Rounds.MAX_SHARES_PER_RAW_DOLLAR`).
 */
export const DEFAULT_SHARES_PER_RAW_DOLLAR = 3_000_000_000_000_000n;

const call = (to: string, data: string): MoneyCall => ({
  to,
  data,
  value: "0x0",
});

/**
 * Back an open round: let the round take `amount` dollars, then ask for it. Two calls, in this order; the wallet waits
 * for the first to land before it sends the second.
 */
export function backCalls(input: {
  quote: string;
  rounds: string;
  round: number;
  amount: bigint;
}): MoneyCall[] {
  return [
    call(
      input.quote,
      encodeFunctionData(
        SIGNATURE_ERC20_APPROVE,
        ["address", "uint256"],
        [input.rounds, input.amount],
      ),
    ),
    call(
      input.rounds,
      encodeFunctionData(
        "ask(uint256,uint256)",
        ["uint256", "uint256"],
        [BigInt(input.round), input.amount],
      ),
    ),
  ];
}

/** Take your unreleased money in `round` back (it cancels the Shares still held for you there). */
export function refundCall(rounds: string, round: number): MoneyCall {
  return call(
    rounds,
    encodeFunctionData("refund(uint256)", ["uint256"], [BigInt(round)]),
  );
}

/** Take out your released Shares of `round` from the hold (ends the refund for them). */
export function claimHeldCall(
  vester: string,
  round: number,
  backer: string,
): MoneyCall {
  return call(
    vester,
    encodeFunctionData(
      "claimHeld(uint256,address)",
      ["uint256", "address"],
      [BigInt(round), backer],
    ),
  );
}

/** The runner's check-in: payments keep running for 14 days. */
export function checkInCall(treasury: string): MoneyCall {
  return call(treasury, encodeFunctionData("checkIn()", [], []));
}

/** Open a 24-hour backing round for the project at `key`, at the default price unless another is given. */
export function openBackingCall(
  launcher: string,
  key: string,
  sharesPerRawDollar: bigint = DEFAULT_SHARES_PER_RAW_DOLLAR,
): MoneyCall {
  return call(
    launcher,
    encodeFunctionData(
      "openRound(bytes32,uint256)",
      ["bytes32", "uint256"],
      [key, sharesPerRawDollar],
    ),
  );
}

/** `positionOf(round, backer)` on a project's Rounds: that backer's ask, held money, Shares bought and settled flag. */
export function positionCallData(round: number, backer: string): string {
  return encodeFunctionData(
    "positionOf(uint256,address)",
    ["uint256", "address"],
    [BigInt(round), backer],
  );
}

/** `quote()` on a project's Rounds: the dollar token it takes. */
export const QUOTE_CALL_DATA = encodeFunctionData("quote()", [], []);

/**
 * Dollars typed by a person as raw units, or why not: digits with at most one dot and at most 6 decimals ("1,000" and
 * a leading "$" are allowed), at least 1 dollar. No upper limit: a round may be asked for more than it holds, and then
 * everyone gets the same part.
 */
export function parseDollars(
  text: string,
):
  | { ok: true; raw: bigint }
  | { ok: false; reason: "empty" | "format" | "small" } {
  const cleaned = text.trim().replace(/^\$/, "").replace(/,/g, "");
  if (cleaned === "") return { ok: false, reason: "empty" };
  const match = /^(\d{1,12})(?:\.(\d{0,6}))?$/.exec(cleaned);
  if (!match) return { ok: false, reason: "format" };
  const raw =
    BigInt(match[1]) * DOLLAR + BigInt((match[2] ?? "").padEnd(6, "0") || "0");
  if (raw < MIN_ASK) return { ok: false, reason: "small" };
  return { ok: true, raw };
}

/** Each 100 dollars backed: 3 to the platform, 15 to the project at once, 82 released over 26 weeks (plan section 4). */
export function backingSplit(amount: bigint): {
  platform: bigint;
  now: bigint;
  later: bigint;
} {
  const platform = (amount * 3n) / 100n;
  const now = (amount * 15n) / 100n;
  return { platform, now, later: amount - platform - now };
}

/**
 * The most of `amount` that can ever come back: the 82 of each 100 held for release, less 5 of each 100 of it, the day
 * the round settles (77.90 of each 100). It falls as the money is released over 26 weeks of check-ins, to nothing. The
 * 3 to the platform and the 15 paid at once never come back (`Rounds.HELD_BPS`, `Rounds.REFUND_FEE_BPS`).
 */
export function mostBack(amount: bigint): bigint {
  const held = (amount * 8_200n) / 10_000n;
  const fee = (held * 500n + 9_999n) / 10_000n; // rounded up, as the contract does
  return held - fee;
}
