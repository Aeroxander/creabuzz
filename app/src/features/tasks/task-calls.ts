/**
 * The chain calls behind paying for a task and setting an agent's limits, as plain data for the person's wallet to send.
 * Pure: the calldata is pinned in `task-calls.test.ts` against `cast calldata`. The money always moves from the runner's
 * own wallet: the server and agents never send it.
 */
import { encodeFunctionData } from "@creaton/core/launchpad/evmAbi.ts";
import type { MoneyCall } from "../money/calls";
import { DOLLAR } from "../money/numbers";

/** At Team one signer may spend this much alone in any 7 days (`Pair.ALONE_CAP`); above it both must agree. */
export const PAIR_ALONE_DOLLARS = 500;
/** The default agent limits a project starts with: 25 dollars a day (`Treasury.defaultAgentUsd`). */
export const DEFAULT_AGENT_DOLLARS = 25;

const call = (to: string, data: string): MoneyCall => ({
  to,
  data,
  value: "0x0",
});

/** Raw dollar units (6 decimals) for whole dollars. */
export function rawDollars(usd: number): bigint {
  return BigInt(Math.trunc(usd)) * DOLLAR;
}

/** Pay `usd` dollars to `to` from the project's spendable money, sent by its runner: `Treasury.spend`. */
export function treasurySpendCall(
  treasury: string,
  to: string,
  usd: number,
): MoneyCall {
  return call(
    treasury,
    encodeFunctionData(
      "spend(address,uint256)",
      ["address", "uint256"],
      [to, rawDollars(usd)],
    ),
  );
}

/** The same payment by one of a Pair's two signers, inside their 500 dollars a week alone: `Pair.spend`. */
export function pairSpendCall(
  pair: string,
  to: string,
  usd: number,
): MoneyCall {
  return call(
    pair,
    encodeFunctionData(
      "spend(address,uint256)",
      ["address", "uint256"],
      [to, rawDollars(usd)],
    ),
  );
}

/**
 * Let `agent` act for the project with daily limits: `usd` whole dollars and `shares` raw Shares (18 decimals) a day.
 * Only the runner: `Treasury.setAgent`. Setting it again changes the limits; what was used still counts.
 */
export function setAgentCall(
  treasury: string,
  agent: string,
  usd: number,
  shares: bigint,
): MoneyCall {
  return call(
    treasury,
    encodeFunctionData(
      "setAgent(address,uint128,uint128)",
      ["address", "uint128", "uint128"],
      [agent, rawDollars(usd), shares],
    ),
  );
}

/** Switch an agent off: `Treasury.revokeAgent`. */
export function revokeAgentCall(treasury: string, agent: string): MoneyCall {
  return call(
    treasury,
    encodeFunctionData("revokeAgent(address)", ["address"], [agent]),
  );
}
