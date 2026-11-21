/**
 * What a person has parked in a project's pause contract, read from the chain. The pause contract is always the one the
 * Treasury itself names (`Treasury.pauseGate`), never one a record says: where Shares are approved to must not depend on a
 * server's word. The record's address is only a hint that a pause exists, which makes a failed read a stop ("could not be
 * read") instead of "none": a project the record says has a pause never shows a person fewer Shares than they hold.
 */
import {
  pauseGateOf,
  parkedOf,
  type ReadCall,
} from "@creaton/core/pot/pot-reads.ts";
import type { MoneyTarget } from "../pot/target";

/** The project's pause contract and what `account` has parked in it. `gate` is null when the project has no pause. */
export interface ParkedHolding {
  gate: string | null;
  parked: bigint;
}

export async function readParked(
  read: ReadCall,
  target: Pick<MoneyTarget, "treasury" | "pauseHint">,
  account: string,
): Promise<ParkedHolding> {
  let gate: string | null;
  try {
    gate = await pauseGateOf(read, target.treasury);
  } catch (error) {
    // The record says there is a pause: not knowing is a stop. It says nothing: the project has none that matters here
    // (a Treasury from before the pause has no such call at all).
    if (target.pauseHint) throw error;
    return { gate: null, parked: 0n };
  }
  if (!gate) return { gate: null, parked: 0n };
  return { gate, parked: await parkedOf(read, gate, account) };
}

/**
 * What `account` has parked in the project the record `numbers` is about, for the readers that only need "how many Shares does
 * this account hold" (the room's rights, the alerts). A record that says the project has no pause (`contracts.pause` null) asks
 * nothing; an older record that says nothing asks the chain once; a record that names one makes a failed read a failure.
 */
export async function parkedHeld(
  read: ReadCall,
  numbers: {
    contracts: { treasury: string; pause?: string | null };
  },
  account: string,
): Promise<bigint> {
  if (numbers.contracts.pause === null) return 0n;
  return (
    await readParked(
      read,
      {
        treasury: numbers.contracts.treasury,
        pauseHint: numbers.contracts.pause ?? null,
      },
      account,
    )
  ).parked;
}
