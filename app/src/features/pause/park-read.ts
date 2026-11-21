/**
 * What the Park sheet reads from the chain when it opens: where Shares are approved to (the Treasury's own answer), what the
 * wallet holds, what is parked already, the line and the warning period, and the two calls made from them. The sheet shows
 * these numbers and sends these calls. A record that did not read, or a pause the chain does not name the way the record
 * does, gives "unreadable": nothing is offered to park.
 */
import { type PotCall, parkCalls } from "@creaton/core/pot/pot-calls.ts";
import {
  balanceOf,
  type PauseNow,
  pauseRules,
  pauseState,
  type ReadCall,
} from "@creaton/core/pot/pot-reads.ts";
import { type Portion, portionOf } from "../pot/takeout-read";
import type { MoneyTarget } from "../pot/target";
import { readParked } from "./parked-read";

export type ParkRead =
  | { ok: false; why: "unreadable" | "none" | "tiny" }
  | {
      ok: true;
      gate: string;
      /** What the wallet holds, and how many of it this press parks. */
      wallet: bigint;
      shares: bigint;
      /** What this account has parked already. */
      parked: bigint;
      state: PauseNow;
      dayLength: number;
      lineDivisor: number;
      /** `approve` then `park`. */
      calls: PotCall[];
    };

export async function readPark(
  read: ReadCall,
  target: MoneyTarget,
  account: string,
  portion: Portion,
  /** The record's own pause key read: false means the record names a pause it could not read, and nothing is offered. */
  recordReadable: boolean,
): Promise<ParkRead> {
  if (!recordReadable) return { ok: false, why: "unreadable" };
  const { gate, parked } = await readParked(read, target, account);
  // The record says there is a pause and the chain does not name the same one: not believed, nothing is offered.
  if (!gate || (target.pauseHint && target.pauseHint !== gate))
    return { ok: false, why: "unreadable" };
  const [state, rules, wallet] = await Promise.all([
    pauseState(read, gate),
    pauseRules(read, gate),
    balanceOf(read, target.shares, account),
  ]);
  if (wallet === 0n) return { ok: false, why: "none" };
  const shares = portionOf(wallet, portion);
  if (shares === 0n) return { ok: false, why: "tiny" };
  return {
    ok: true,
    gate,
    wallet,
    shares,
    parked,
    state,
    dayLength: rules.dayLength,
    lineDivisor: rules.lineDivisor,
    calls: parkCalls({ shares: target.shares, pause: gate, amount: shares }),
  };
}
