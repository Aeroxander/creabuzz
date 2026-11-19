/**
 * The chain calls behind paying for a task and setting an agent's limits, as plain data for the person's wallet to send,
 * from the generated ABIs of `contracts/pot` (`@creaton/core/pot/pot-calls.ts`). A task is paid by a draw from the
 * allowance box: the money comes from the box, never straight from the pot. It always moves from the runner's own
 * account: the server and agents never send it.
 */
import {
  drawCall,
  type PotCall,
  revokeAgentCall as revokeCall,
  setAgentCall as setCall,
} from "@creaton/core/pot/pot-calls.ts";
import { DOLLAR } from "../money/numbers";

/** The most dollars a day a limit may name, and the most whole Shares a day: far under what a limit field can hold. */
export const AGENT_DOLLARS_MAX = 1_000_000;
export const AGENT_SHARES_MAX = 1_000_000_000_000n;

/** Raw dollar units (6 decimals) for whole dollars. A fraction, a negative or an unsafe number is refused. */
export function rawDollars(usd: number): bigint {
  if (!Number.isSafeInteger(usd) || usd < 0)
    throw new RangeError("Dollars must be a whole number from 0 up.");
  return BigInt(usd) * DOLLAR;
}

/** Pay `usd` dollars to `to` out of the allowance box, sent by the project's runner: `Treasury.draw`. */
export function drawForTaskCall(
  treasury: string,
  to: string,
  usd: number,
): PotCall {
  return drawCall({ treasury, to, amount: rawDollars(usd) });
}

/**
 * Let `agent` act for the project with daily limits: `usd` whole dollars out of the box and `shares` raw Team Shares
 * (18 decimals) a day. Only the runner: `Treasury.setAgent`. Setting it again changes the limits; what was used still
 * counts.
 */
export function setAgentCall(
  treasury: string,
  agent: string,
  usd: number,
  shares: bigint,
): PotCall {
  return setCall({
    treasury,
    agent,
    usdCap: rawDollars(usd),
    teamCap: shares,
  });
}

/** Switch an agent off: `Treasury.revokeAgent`. */
export function revokeAgentCall(treasury: string, agent: string): PotCall {
  return revokeCall(treasury, agent);
}
